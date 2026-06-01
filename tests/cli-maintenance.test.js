import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repo } from "./helpers/logseq-fixtures.js";

const packageJson = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const cli = path.join(repo, "dist", "cli.js");

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function captureStream() {
  let text = "";
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
        return true;
      },
    },
    text: () => text,
  };
}

function makePackageRoot(mode = "package") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-maint-"));
  const packageRoot = mode === "npm"
    ? path.join(base, "node_modules", packageJson.name)
    : mode === "npx"
      ? path.join(base, "_npx", "abc123", "node_modules", packageJson.name)
      : path.join(base, packageJson.name);
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    engines: packageJson.engines,
    bin: packageJson.bin,
  }), "utf8");
  return {
    base,
    packageRoot,
    modulePath: path.join(packageRoot, "dist", "cli.js"),
  };
}

async function runUpdateDirect({ mode = "package", channel = "latest", apply = false, dryRun = false, env = {} } = {}) {
  const { runUpdate } = await import("../dist/cli-maintenance.js");
  const fixture = makePackageRoot(mode);
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const status = runUpdate({
      packageRoot: fixture.packageRoot,
      modulePath: fixture.modulePath,
      options: {
        command: "update",
        apply,
        check: !apply && !dryRun,
        dryRun,
        help: false,
        json: true,
        channel,
      },
      env: {
        ...process.env,
        LOGSEQ_UPDATE_LATEST_VERSION: "99.0.0",
        ...env,
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    return { status, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
}

test("logseq-graph-mcp exposes doctor and update maintenance commands", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /logseq-graph-mcp doctor/);
  assert.match(help.stdout, /logseq-graph-mcp update/);

  const doctor = run(["doctor", "--json"], { LOGSEQ_UPDATE_SKIP_NETWORK: "1" });
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorReport = JSON.parse(doctor.stdout);
  assert.equal(doctorReport.package, "logseq-graph-mcp");
  assert.equal(doctorReport.command, "logseq-graph-mcp");
  assert.equal(doctorReport.version, packageJson.version);
  assert.equal(doctorReport.install.mode, "source");
  assert.equal(doctorReport.checks.some((check) => check.name === "package metadata" && check.ok), true);

  const update = run(["update", "--check", "--json"], { LOGSEQ_UPDATE_LATEST_VERSION: "99.0.0" });
  assert.equal(update.status, 0, update.stderr);
  const updateReport = JSON.parse(update.stdout);
  assert.equal(updateReport.package, "logseq-graph-mcp");
  assert.equal(updateReport.latest, "99.0.0");
  assert.equal(updateReport.outdated, true);
  assert.equal(updateReport.next, "git pull && npm install && npm run check");

  const apply = run(["update", "--apply"], { LOGSEQ_UPDATE_LATEST_VERSION: "99.0.0" });
  assert.equal(apply.status, 78);
  assert.match(apply.stderr, /Source checkout detected/);
});

test("update --channel is reflected in install guidance for mutable installs and npx runs", async () => {
  const npmDryRun = await runUpdateDirect({ mode: "npm", channel: "beta", dryRun: true });
  assert.equal(npmDryRun.status, 0, npmDryRun.stderr);
  const npmReport = JSON.parse(npmDryRun.stdout);
  assert.equal(npmReport.channel, "beta");
  assert.equal(npmReport.next, "npm install -g logseq-graph-mcp@beta");

  const npxApply = await runUpdateDirect({ mode: "npx", channel: "next", apply: true });
  assert.equal(npxApply.status, 78);
  const npxReport = JSON.parse(npxApply.stderr);
  assert.equal(npxReport.channel, "next");
  assert.equal(npxReport.detail, "npx runs are ephemeral. Run: npx logseq-graph-mcp@next");
});

test("maintenance parser rejects ambiguous update modes and empty root values", async () => {
  const { parseMaintenanceArgs } = await import("../dist/cli-maintenance.js");
  assert.equal(parseMaintenanceArgs(["update", "--channel=beta"]).check, true);
  assert.throws(() => parseMaintenanceArgs(["update", "--apply", "--dry-run"]), /only one/);
  assert.throws(() => parseMaintenanceArgs(["doctor", "--root="]), /Missing value/);
});

test("update --apply installs the selected channel when mutation is allowed", async () => {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-fake-npm-"));
  const argsFile = path.join(fakeBin, "npm-args.json");
  const npmShim = path.join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm");
  const shimSource = process.platform === "win32"
    ? `@echo off\r\necho npm progress should not pollute json\r\nnode -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))" "${argsFile}" %*\r\n`
    : `#!/usr/bin/env sh\nprintf 'npm progress should not pollute json\\n'\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' '${argsFile}' "$@"\n`;
  fs.writeFileSync(npmShim, shimSource, "utf8");
  fs.chmodSync(npmShim, 0o755);
  try {
    const apply = await runUpdateDirect({
      mode: "npm",
      channel: "beta",
      apply: true,
      env: {
        LOGSEQ_UPDATE_ALLOW_APPLY: "1",
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    assert.equal(apply.status, 0, apply.stderr);
    const report = JSON.parse(apply.stdout);
    assert.equal(report.detail, "Updated logseq-graph-mcp@beta with npm install -g.");
    assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), ["install", "-g", "logseq-graph-mcp@beta"]);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("doctor fails when the packaged CLI build is missing", async () => {
  const { runDoctor } = await import("../dist/cli-maintenance.js");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-doctor-"));
  const packageRoot = path.join(base, packageJson.name);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    engines: packageJson.engines,
    bin: packageJson.bin,
  }), "utf8");
  const stdout = captureStream();
  try {
    const status = runDoctor({
      packageRoot,
      modulePath: path.join(packageRoot, "dist", "cli.js"),
      json: true,
      env: { ...process.env, LOGSEQ_UPDATE_SKIP_NETWORK: "1" },
      stdout: stdout.stream,
    });
    assert.equal(status, 1);
    const report = JSON.parse(stdout.text());
    assert.equal(report.ok, false);
    assert.equal(report.checks.some((check) => check.name === "build" && check.ok === false), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
