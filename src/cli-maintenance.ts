import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const CONFIG_EXIT = 78;

export type MaintenanceOptions = {
  command: "doctor" | "update";
  apply: boolean;
  check: boolean;
  dryRun: boolean;
  help: boolean;
  json: boolean;
  channel: string;
  root?: string;
};

type PackageInfo = {
  name: string;
  version: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
};

type InstallMode = {
  mode: "source" | "npx" | "npm" | "package";
  mutable: boolean;
  description: string;
};

export function parseMaintenanceArgs(argv: string[]): MaintenanceOptions {
  const command = argv[0] as "doctor" | "update";
  const options: MaintenanceOptions = {
    command,
    apply: false,
    check: false,
    dryRun: false,
    help: false,
    json: false,
    channel: "latest",
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--channel") {
      options.channel = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--channel=")) {
      options.channel = arg.slice("--channel=".length) || "latest";
    } else if (arg === "--root") {
      options.root = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else {
      throw new Error(`Unknown ${command} option: ${arg}`);
    }
  }

  return options;
}

export function maintenanceUsage(packageName: string): string {
  return `Maintenance commands:
  ${packageName} doctor [--root /path/to/logseq] [--json]
  ${packageName} update [--check|--dry-run|--apply] [--channel latest] [--json]

Update checks use npm metadata. Set LOGSEQ_UPDATE_SKIP_NETWORK=1 to force offline checks.
Mutation requires --apply and LOGSEQ_UPDATE_ALLOW_APPLY=1.
`;
}

export function runDoctor({
  packageRoot,
  modulePath,
  root,
  json,
  env = process.env,
  stdout = process.stdout,
}: {
  packageRoot: string;
  modulePath: string;
  root?: string;
  json: boolean;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WriteStream;
}): number {
  const packageJson = readPackageJson(packageRoot);
  const install = detectInstallMode({ packageName: packageJson.name, packageRoot, modulePath, env });
  const checks = [
    checkNodeVersion(packageJson.engines?.node || ""),
    checkPackageMetadata(packageJson),
    checkGraphRoot(root || env.LOGSEQ_ROOT || ""),
    checkBuild(packageRoot),
    { name: "install mode", ok: true, detail: `${install.mode}: ${install.description}` },
  ];
  const report = {
    ok: checks.every((check) => check.ok),
    package: packageJson.name,
    version: packageJson.version,
    command: packageJson.name,
    install,
    checks,
  };
  writeReport(report, json, stdout, formatDoctorReport);
  return report.ok ? 0 : 1;
}

export function runUpdate({
  packageRoot,
  modulePath,
  options,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  packageRoot: string;
  modulePath: string;
  options: MaintenanceOptions;
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}): number {
  const packageJson = readPackageJson(packageRoot);
  const install = detectInstallMode({ packageName: packageJson.name, packageRoot, modulePath, env });
  const latest = resolveLatestVersion(packageJson.name, options.channel, env);
  const status = latest.version ? compareVersions(latest.version, packageJson.version) : 0;
  const report: Record<string, unknown> = {
    ok: true,
    package: packageJson.name,
    version: packageJson.version,
    latest: latest.version || null,
    latestSource: latest.source,
    channel: options.channel,
    outdated: Boolean(latest.version && status > 0),
    command: packageJson.name,
    install,
    action: options.dryRun ? "dry-run" : "check",
    next: updateInstructions(packageJson.name, install, options.channel),
  };

  if (options.apply) {
    report.action = "apply";
    const apply = applyUpdate({ packageName: packageJson.name, channel: options.channel, install, env });
    report.ok = apply.ok;
    report.applied = apply.applied;
    report.detail = apply.detail;
    writeReport(report, options.json, apply.ok ? stdout : stderr, formatUpdateReport);
    return apply.ok ? 0 : CONFIG_EXIT;
  }

  writeReport(report, options.json, stdout, formatUpdateReport);
  return 0;
}

export function detectInstallMode({
  packageName,
  packageRoot,
  modulePath,
  env = process.env,
}: {
  packageName: string;
  packageRoot: string;
  modulePath: string;
  env?: NodeJS.ProcessEnv;
}): InstallMode {
  const realModulePath = safeRealpath(modulePath);
  const realPackageRoot = safeRealpath(packageRoot);
  const marker = `${path.sep}node_modules${path.sep}${packageName}${path.sep}`;
  if (realModulePath.includes(`${path.sep}_npx${path.sep}`) || String(env.npm_execpath || "").includes(`${path.sep}_npx${path.sep}`)) {
    return { mode: "npx", mutable: false, description: "ephemeral npx execution" };
  }
  if (realModulePath.includes(marker)) {
    return { mode: "npm", mutable: true, description: "npm package install" };
  }
  if (fs.existsSync(path.join(realPackageRoot, ".git"))) {
    return { mode: "source", mutable: false, description: "source checkout" };
  }
  return { mode: "package", mutable: true, description: "packaged local install" };
}

function readPackageJson(packageRoot: string): PackageInfo {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as PackageInfo;
}

function resolveLatestVersion(packageName: string, channel: string, env: NodeJS.ProcessEnv): { version: string | null; source: string } {
  const override = env.LOGSEQ_UPDATE_LATEST_VERSION || env.LOGSEQ_GRAPH_MCP_UPDATE_LATEST_VERSION;
  if (override) return { version: override, source: "env" };
  if (env.LOGSEQ_UPDATE_SKIP_NETWORK === "1") return { version: null, source: "skipped" };
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const output = execFileSync(npm, ["view", `${packageName}@${channel}`, "version", "--json"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    }).trim();
    const parsed = JSON.parse(output) as string | string[];
    return { version: Array.isArray(parsed) ? parsed.at(-1) || null : String(parsed), source: "npm" };
  } catch {
    return { version: null, source: "unavailable" };
  }
}

function applyUpdate({
  packageName,
  channel,
  install,
  env,
}: {
  packageName: string;
  channel: string;
  install: InstallMode;
  env: NodeJS.ProcessEnv;
}): { ok: boolean; applied: boolean; detail: string } {
  const target = `${packageName}@${channel}`;
  if (install.mode === "source") {
    return { ok: false, applied: false, detail: "Source checkout detected. Run: git pull && npm install && npm run check" };
  }
  if (install.mode === "npx") {
    return { ok: false, applied: false, detail: `npx runs are ephemeral. Run: npx ${target}` };
  }
  if (env.LOGSEQ_UPDATE_ALLOW_APPLY !== "1") {
    return {
      ok: false,
      applied: false,
      detail: `Set LOGSEQ_UPDATE_ALLOW_APPLY=1 to let this CLI run npm install -g ${target}. Dry-run guidance is printed by default.`,
    };
  }
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npm, ["install", "-g", target], { env, stdio: "inherit", timeout: 120000 });
    return { ok: true, applied: true, detail: `Updated ${target} with npm install -g.` };
  } catch (error) {
    return { ok: false, applied: false, detail: `npm install -g failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function updateInstructions(packageName: string, install: InstallMode, channel: string): string {
  const target = `${packageName}@${channel}`;
  if (install.mode === "source") return "git pull && npm install && npm run check";
  if (install.mode === "npx") return `npx ${target}`;
  return `npm install -g ${target}`;
}

function checkNodeVersion(range: string): { name: string; ok: boolean; detail: string } {
  const minimum = range.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  if (!minimum) return { name: "node", ok: true, detail: process.version };
  const current = process.versions.node.split(".").map((part) => Number(part));
  const expected = minimum.slice(1).map((part) => Number(part));
  const ok = compareParts(current, expected) >= 0;
  return { name: "node", ok, detail: `${process.version} required ${range}` };
}

function checkPackageMetadata(packageJson: PackageInfo): { name: string; ok: boolean; detail: string } {
  const ok = packageJson.name === "logseq-graph-mcp" && Boolean(packageJson.bin?.["logseq-graph-mcp"]);
  return { name: "package metadata", ok, detail: `${packageJson.name}@${packageJson.version}` };
}

function checkGraphRoot(root: string): { name: string; ok: boolean; detail: string } {
  if (!root) return { name: "graph root", ok: true, detail: "not configured; pass --root for graph validation" };
  const resolved = path.resolve(root);
  const ok = fs.existsSync(path.join(resolved, "pages"));
  return { name: "graph root", ok, detail: ok ? "pages/ found" : `missing pages/: ${resolved}` };
}

function checkBuild(packageRoot: string): { name: string; ok: boolean; detail: string } {
  const ok = fs.existsSync(path.join(packageRoot, "dist", "cli.js"));
  return { name: "build", ok, detail: ok ? "dist/cli.js found" : "dist/cli.js missing; run npm run build before using the packaged CLI" };
}

function writeReport(report: Record<string, unknown>, json: boolean, stream: NodeJS.WriteStream, formatter: (report: Record<string, unknown>) => string): void {
  if (json) stream.write(`${JSON.stringify(report, null, 2)}\n`);
  else stream.write(formatter(report));
}

function formatDoctorReport(report: Record<string, unknown>): string {
  const checks = report.checks as Array<{ name: string; ok: boolean; detail: string }>;
  return [
    `${report.package} doctor ${report.ok ? "ok" : "failed"}`,
    `version: ${report.version}`,
    `command: ${report.command}`,
    ...checks.map((check) => `${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`),
    "",
  ].join("\n");
}

function formatUpdateReport(report: Record<string, unknown>): string {
  const install = report.install as InstallMode;
  const latest = report.latest || `unknown (${report.latestSource})`;
  const lines = [
    `${report.package} update ${report.ok ? "ok" : "failed"}`,
    `current: ${report.version}`,
    `latest: ${latest}`,
    `channel: ${report.channel}`,
    `install: ${install.mode}`,
    `outdated: ${report.outdated ? "yes" : "no"}`,
    `next: ${report.next}`,
  ];
  if (report.detail) lines.push(`detail: ${report.detail}`);
  lines.push("");
  return lines.join("\n");
}

function compareVersions(a: string, b: string): number {
  return compareParts(parseVersion(a), parseVersion(b));
}

function parseVersion(version: string): number[] {
  return String(version).split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
}

function compareParts(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function safeRealpath(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}.`);
  return value;
}
