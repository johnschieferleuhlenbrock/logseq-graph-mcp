import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeGraph, repo, status } from "./helpers/logseq-fixtures.js";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedPackageVersion = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
const localLeakPatterns = [
  ["absolute user home path", new RegExp("/" + "Users" + "/[^/\\s\"'`)]+")],
  ["cloud-storage local path", new RegExp("Library/" + "CloudStorage|" + "One" + "Drive-Personal")],
  ["workspace-local project path", new RegExp("Claude/" + "projects")],
  ["private key material", /BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY/],
  ["likely OpenAI API key", /sk-[A-Za-z0-9_-]{20,}/],
  ["likely Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["likely GitHub token", /gh[pousr]_[A-Za-z0-9_]{20,}/],
  ["likely AWS access key", /AKIA[0-9A-Z]{16}/],
];

function runOk(command, args, options = {}) {
  const res = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });
  assert.equal(res.status, 0, `${command} ${args.join(" ")}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return res;
}

function npmPack(args) {
  const res = runOk(npm, ["pack", "--json", "--ignore-scripts", ...args]);
  const pack = JSON.parse(res.stdout);
  assert.equal(pack.length, 1);
  return pack[0];
}

function parseJsonLines(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("packed release contents are allowlisted and leak-free", () => {
  const pack = npmPack(["--dry-run"]);
  const files = pack.files.map((entry) => entry.path).sort();
  const required = [
    ".env.example",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "dist/cli.js",
    "dist/index.js",
    "dist/logseq.js",
    "dist/server.js",
    "install.sh",
    "package.json",
  ];
  const missing = required.filter((file) => !files.includes(file));
  const forbidden = files.filter((file) => /^(src|tests|\.github|node_modules)(\/|$)|(^|\/)\.DS_Store$/.test(file));
  assert.deepEqual({ missing, forbidden }, { missing: [], forbidden: [] });

  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.publishConfig?.access, "public");
  assert.equal(pkg.name, "logseq-graph-mcp");
  assert.equal(pkg.bin?.["logseq-graph-mcp"], "dist/cli.js");
  assert.equal(pkg.bin?.["logseq-mcp-server"], "dist/cli.js");
  assert.equal(files.includes(pkg.bin["logseq-graph-mcp"]), true);

  for (const file of files) {
    const text = fs.readFileSync(path.join(repo, file), "utf8");
    for (const [label, pattern] of localLeakPatterns) {
      assert.doesNotMatch(text, pattern, `${file}: ${label}`);
    }
  }
});

test("package tarball installs, imports, and exposes the CLI bin", () => {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-pack-"));
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-install-"));
  try {
    const pack = npmPack(["--pack-destination", packDir]);
    const tarball = path.join(packDir, pack.filename);
    assert.equal(fs.existsSync(tarball), true);

    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
    runOk(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: installDir, timeout: 120000 });

    const bin = path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? "logseq-graph-mcp.cmd" : "logseq-graph-mcp");
    assert.equal(fs.existsSync(bin), true);
    const version = runOk(bin, ["--version"], { cwd: installDir });
    assert.equal(version.stdout.trim(), expectedPackageVersion);
    const help = runOk(bin, ["--help"], { cwd: installDir });
    assert.match(help.stdout, /Usage: logseq-graph-mcp --root/);
    assert.match(help.stdout, /logseq-graph-mcp doctor/);
    const doctor = runOk(bin, ["doctor", "--json"], {
      cwd: installDir,
      env: { ...process.env, LOGSEQ_UPDATE_SKIP_NETWORK: "1" },
    });
    const doctorReport = JSON.parse(doctor.stdout);
    assert.equal(doctorReport.package, "logseq-graph-mcp");
    assert.equal(doctorReport.command, "logseq-graph-mcp");
    const update = runOk(bin, ["update", "--check", "--channel", "beta", "--json"], {
      cwd: installDir,
      env: { ...process.env, LOGSEQ_UPDATE_LATEST_VERSION: "99.0.0" },
    });
    const updateReport = JSON.parse(update.stdout);
    assert.equal(updateReport.package, "logseq-graph-mcp");
    assert.equal(updateReport.channel, "beta");
    assert.equal(updateReport.outdated, true);
    assert.equal(updateReport.next, "npm install -g logseq-graph-mcp@beta");

    const importCheck = runOk(process.execPath, ["--input-type=module", "-e", `
      import { LogseqServer, version } from "logseq-graph-mcp";
      const s = new LogseqServer({ root: process.cwd(), env: { LOGSEQ_ROOT: process.cwd(), LOGSEQ_WATCH: "0" } });
      console.log(JSON.stringify({ version, hasTools: Object.keys(s.tools()).includes("graph_status") }));
      s.close();
    `], { cwd: installDir });
    assert.deepEqual(JSON.parse(importCheck.stdout), { version: expectedPackageVersion, hasTools: true });
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test("installed stdio server initializes, lists tools, and blocks readonly writes", () => {
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-pack-"));
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-install-"));
  const root = makeGraph();
  try {
    const pack = npmPack(["--pack-destination", packDir]);
    const tarball = path.join(packDir, pack.filename);
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
    runOk(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: installDir, timeout: 120000 });

    const cli = path.join(installDir, "node_modules", "logseq-graph-mcp", "dist", "cli.js");
    const payload = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "release-smoke", version: "0.1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_stub", arguments: { name: "Should Not Write" } } }),
      "",
    ].join("\n");
    const res = runOk(process.execPath, [cli, "--root", root, "--readonly", "--no-watch"], {
      cwd: installDir,
      input: payload,
      env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict" },
      timeout: 20000,
    });
    const responses = parseJsonLines(res.stdout);
    const initialize = responses.find((entry) => entry.id === 1).result;
    assert.deepEqual(initialize.serverInfo, { name: "logseq-graph-mcp", version: expectedPackageVersion });
    const tools = responses.find((entry) => entry.id === 2).result.tools.map((tool) => tool.name);
    assert.equal(tools.includes("graph_status"), true);
    assert.equal(tools.includes("create_stub"), true);
    const write = responses.find((entry) => entry.id === 3).result;
    assert.equal(write.isError, true);
    assert.match(write.content[0].text, /LOGSEQ_READONLY/);
    assert.doesNotMatch(res.stdout, new RegExp("/" + "Users/" + "jo" + "hnsu|Claude/" + "projects"));
    assert.equal(status(root), "");
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CI workflow keeps public release gates wired", () => {
  const workflow = fs.readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /Public-safety scan/);
  assert.match(workflow, /npm run build/);
  assert.doesNotMatch(workflow, /ignoredDirs = new Set\(\[[^\]]*"dist"/);
  assert.match(workflow, /Validate packed release contents/);
  assert.match(workflow, /Validate package executable/);
});
