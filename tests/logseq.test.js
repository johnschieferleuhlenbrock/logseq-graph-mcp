import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isCaseInsensitiveDir, makeGraph, repo, run, server, status, writePage } from "./helpers/logseq-fixtures.js";

const mutatingToolCalls = [
  ["update_property", { name: "Alice", key: "status", value: "blocked" }],
  ["batch_update_property", { updates: [{ name: "Alice", key: "status", value: "blocked" }] }],
  ["delete_property", { name: "Alice", key: "status" }],
  ["append_contact_log", { name: "Alice", medium: "email", summary: "blocked" }],
  ["append_journal_bullet", { content: "blocked" }],
  ["create_stub", { name: "Blocked Stub" }],
  ["rename_page", { old_name: "Alice", new_name: "Blocked Rename" }],
  ["delete_page", { name: "Alice" }],
  ["update_body_section", { name: "Alice", anchor: "hello", new_content: "- blocked" }],
  ["regenerate_index", {}],
];

function assertStrictObjectSchemas(schema, label) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object" && "properties" in schema) {
    assert.equal(schema.additionalProperties, false, label);
  }
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    assertStrictObjectSchemas(value, `${label}.${key}`);
  }
  if (schema.items) assertStrictObjectSchemas(schema.items, `${label}[]`);
}

function publicSafetyDenyPatterns() {
  return [
    ["absolute user home path", new RegExp("/" + "Users" + "/[^/\\s]+")],
    ["cloud-storage local path", new RegExp("Library/" + "CloudStorage|" + "One" + "Drive-Personal")],
    ["workspace-local project path", new RegExp("Claude/" + "projects")],
    ["personal username", new RegExp("jo" + "hnsu", "i")],
    ["private key material", new RegExp("BEGIN " + "(RSA |OPENSSH |EC |DSA )?PRIVATE KEY")],
    ["likely OpenAI API key", new RegExp("sk-" + "[A-Za-z0-9_-]{20,}")],
  ];
}

test("read namespace normalization and query date validation", () => {
  const root = makeGraph();
  const s = server(root);
  const page = s.read_page("schema/properties");
  assert.equal(page.ok, true);
  assert.equal(page.name, "schema___properties");

  const result = s.query_pages({
    filters: [
      { key: "status", op: "eq", value: "active" },
      { key: "last-contacted", op: "lt", value: "2026-05-20" },
    ],
    sort_by: "last-contacted",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(new Set(result.pages.map((p) => p.name)), new Set(["Alice"]));
  assert.equal(result.invalid_values[0].name, "Bad Date");
  fs.rmSync(root, { recursive: true, force: true });
});

test("tool definitions are strict and cover every callable tool", () => {
  const root = makeGraph();
  const s = server(root);
  const toolNames = Object.keys(s.tools()).sort();
  const definitions = s.toolDefinitions();
  assert.deepEqual(definitions.map((d) => d.name).sort(), toolNames);
  for (const def of definitions) {
    assert.equal(def.inputSchema.type, "object");
    assert.equal(def.inputSchema.additionalProperties, false, def.name);
    assert.ok(def.description.length > 10, def.name);
    assertStrictObjectSchemas(def.inputSchema, def.name);
  }
  const update = definitions.find((d) => d.name === "update_property");
  assert.deepEqual(update.inputSchema.required, ["name", "key", "value"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("public release metadata avoids local-only leakage", () => {
  const files = [
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "BACKLOG.md",
    "PARITY.md",
    "PUBLIC_READINESS.md",
    ".env.example",
    "install.sh",
    ".github/workflows/ci.yml",
    "tests/logseq.test.js",
  ];
  const findings = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(repo, file), "utf8");
    for (const [label, pattern] of publicSafetyDenyPatterns()) {
      if (pattern.test(text)) findings.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(findings, []);
});

test("public package and tool surface avoid local-only leakage", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  for (const file of ["dist", "README.md", "LICENSE", "SECURITY.md"]) {
    assert.ok(pkg.files.includes(file), file);
  }
  assert.ok(!pkg.files.some((file) => /^(src|tests|\.github|node_modules)(\/|$)/.test(file)));
  assert.match(pkg.bin["logseq-graph-mcp"], /^dist\/(index|cli)\.js$/);
  assert.equal(pkg.bin["logseq-mcp-server"], pkg.bin["logseq-graph-mcp"]);
  assert.equal(fs.existsSync(path.join(repo, pkg.bin["logseq-graph-mcp"])), true);
  assert.equal(pkg.main, "dist/index.js");

  const root = makeGraph();
  const definitions = server(root).toolDefinitions();
  const localLeakPattern = new RegExp(publicSafetyDenyPatterns().map(([, pattern]) => pattern.source).join("|"), "i");
  for (const def of definitions) {
    assert.doesNotMatch(def.description, localLeakPattern, def.name);
    assert.doesNotMatch(JSON.stringify(def.inputSchema), localLeakPattern, def.name);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("readonly mode gates every mutating tool before graph changes", () => {
  const root = makeGraph();
  const s = server(root, { LOGSEQ_READONLY: "1" });
  for (const [name, args] of mutatingToolCalls) {
    const res = s.callTool(name, args);
    assert.equal(res.ok, false, name);
    assert.equal(res.readonly, true, name);
    assert.match(res.error, /LOGSEQ_READONLY/, name);
  }
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("read_pages isolates invalid names and truncates body previews", () => {
  const root = makeGraph();
  writePage(root, "Long Body", "type:: person\nstatus:: active\n\n- abcdefghijklmnopqrstuvwxyz\n");
  run("git", ["add", "pages/Long Body.md"], root);
  run("git", ["commit", "-q", "-m", "seed long body"], root);

  const res = server(root).read_pages({ names: ["Alice", "Long Body", "../Escape", "Missing"], body_chars: 8 });
  assert.equal(res.ok, true);
  assert.equal(res.pages.Alice.name, "Alice");
  assert.equal(res.pages["Long Body"].body, "- abcdef");
  assert.equal(res.pages["Long Body"].body_truncated, true);
  assert.match(res.pages["../Escape"].error, /\.\.|path separator/);
  assert.match(res.pages.Missing.error, /Page not found/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("response cap blocks large raw page", () => {
  const root = makeGraph();
  writePage(root, "Alice", `type:: person\nstatus:: active\nlast-contacted:: 2026-05-01\n\n- ${"x".repeat(1000)}\n`);
  const res = server(root, { LOGSEQ_MAX_RESPONSE_BYTES: "250" }).read_page("Alice", true);
  assert.equal(res.ok, false);
  assert.match(res.error, /response too large/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readonly blocks writes without dirtying graph", () => {
  const root = makeGraph();
  const res = server(root, { LOGSEQ_READONLY: "1" }).create_stub({ name: "Read Only Stub" });
  assert.equal(res.ok, false);
  assert.equal(res.readonly, true);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("schema block, force bypass audit, and disallow force", () => {
  const root = makeGraph();
  let res = server(root).update_property({ name: "Alice", key: "unknown-key", value: "value" });
  assert.equal(res.ok, false);
  assert.match(res.error, /not in schema/);
  assert.equal(status(root), "");

  res = server(root).update_property({ name: "Alice", key: "novel-key", value: "v", force: true });
  assert.equal(res.ok, true);
  assert.match(res.schema_warning, /not in schema/);
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "_");
  const journal = fs.readFileSync(path.join(root, "journals", `${today}.md`), "utf8");
  assert.match(journal, /FORCE_SCHEMA_BYPASS/);
  assert.match(journal, /novel-key/);

  res = server(root, { LOGSEQ_DISALLOW_FORCE: "1" }).update_property({ name: "Alice", key: "another-key", value: "v", force: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /force is disabled/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("git guard blocks dirty graph before write and commits clean writes", () => {
  const root = makeGraph();
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: active\nlast-contacted:: 2026-05-02\n\n- dirty\n", "utf8");
  let res = server(root).update_property({ name: "Alice", key: "status", value: "dormant" });
  assert.equal(res.ok, false);
  assert.match(res.error, /requires a clean/);
  assert.ok(res.git_guard.dirty_count > 0);

  run("git", ["checkout", "--", "pages/Alice.md"], root);
  res = server(root).update_property({ name: "Alice", key: "status", value: "dormant" });
  assert.equal(res.ok, true);
  assert.ok(res.git_guard);
  assert.equal(status(root), "");
  assert.match(run("git", ["log", "-1", "--format=%s"], root), /mcp-logseq: update_property/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("strict git guard refuses oversized writes before checkpoint commit", () => {
  const root = makeGraph();
  const before = run("git", ["rev-parse", "HEAD"], root);
  const res = server(root, { LOGSEQ_GIT_MAX_CHANGED_FILES: "1" }).update_property({ name: "Alice", key: "status", value: "dormant" });
  assert.equal(res.ok, false);
  assert.match(res.error, /blast-radius|files changed/);
  assert.match(res.git_guard.violation, /blast-radius|files changed/);
  assert.equal(res.git_guard.commit, null);
  assert.equal(run("git", ["rev-parse", "HEAD"], root), before);
  assert.match(run("git", ["log", "-1", "--format=%s"], root), /^baseline$/);
  assert.equal(status(root), "");
  assert.match(fs.readFileSync(path.join(root, "pages", "Alice.md"), "utf8"), /status:: active/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("warn git guard reports oversized writes after checkpoint", () => {
  const root = makeGraph();
  const res = server(root, { LOGSEQ_GIT_GUARD: "warn", LOGSEQ_GIT_MAX_CHANGED_FILES: "1" }).update_property({ name: "Alice", key: "status", value: "dormant" });
  assert.equal(res.ok, true);
  assert.match(res.git_guard.violation, /blast-radius|files changed/);
  assert.ok(res.git_guard.commit);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("batch update records partial failures and leaves a clean checkpoint", () => {
  const root = makeGraph();
  const res = server(root).batch_update_property({
    updates: [
      { name: "Alice", key: "status", value: "warm" },
      { name: "Missing Person", key: "status", value: "warm" },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.success_count, 1);
  assert.equal(res.failure_count, 1);
  assert.equal(res.results[0].ok, true);
  assert.match(res.results[1].error, /Page not found/);
  assert.equal(server(root).read_page("Alice").properties.status, "warm");
  assert.equal(status(root), "");
  assert.match(run("git", ["log", "-1", "--format=%s"], root), /mcp-logseq: batch_update_property/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("regenerate index failure resets partial output", () => {
  const root = makeGraph();
  fs.writeFileSync(path.join(root, "scripts", "regenerate_graph_index.py"), "from pathlib import Path\nroot = Path(__file__).resolve().parent.parent\n(root / 'generated' / 'graph_index.json').write_text('bad')\nraise SystemExit(2)\n", "utf8");
  run("git", ["add", "scripts/regenerate_graph_index.py"], root);
  run("git", ["commit", "-q", "-m", "add failing regen"], root);
  const defaultRes = server(root).regenerate_index();
  assert.equal(defaultRes.ok, true);
  assert.equal(defaultRes.mode, "native");
  assert.equal(defaultRes.external_regenerator_present, true);
  assert.equal(defaultRes.external_regenerator_allowed, false);
  assert.equal(status(root), "");

  const res = server(root, { LOGSEQ_ALLOW_EXTERNAL_REGEN: "1" }).regenerate_index();
  assert.equal(res.ok, false);
  assert.notEqual(fs.readFileSync(path.join(root, "generated", "graph_index.json"), "utf8"), "bad");
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("regenerate index has native generic fallback when no Python indexer exists", () => {
  const root = makeGraph();
  const res = server(root).regenerate_index();
  assert.equal(res.ok, true);
  assert.equal(res.mode, "native");
  const indexPath = path.join(root, "generated", "graph_index.json");
  assert.equal(fs.existsSync(indexPath), true);
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(index.generated_by, "logseq-graph-mcp");
  assert.equal(index.totals.pages >= 3, true);
  assert.equal(index.pages.alice.name, "Alice");
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("graph status reports dirty graph and stale generated index", () => {
  const root = makeGraph();
  fs.writeFileSync(path.join(root, "generated", "graph_index.json"), "{}", "utf8");
  run("git", ["add", "generated/graph_index.json"], root);
  run("git", ["commit", "-q", "-m", "add index"], root);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: active\nlast-contacted:: 2026-05-03\n\n- dirty\n", "utf8");
  const res = server(root).graph_status();
  assert.equal(res.ok, true);
  assert.equal(res.git.dirty, true);
  assert.ok(res.generated_index.stale_count_sampled >= 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("persistent cache records frontmatter and adjacency and survives server instances", () => {
  const root = makeGraph();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-cache-"));
  writePage(root, "Bob", "type:: person\nstatus:: active\n\n- see [[Alice]]\n");
  run("git", ["add", "pages/Bob.md"], root);
  run("git", ["commit", "-q", "-m", "seed bob"], root);

  let s = server(root, { LOGSEQ_CACHE_DIR: cacheDir, LOGSEQ_WATCH: "0" });
  let res = s.graph_stats();
  assert.equal(res.ok, true);
  let statusRes = s.graph_status();
  assert.equal(statusRes.cache.watcher_enabled, false);
  const cacheFile = statusRes.cache.file;
  assert.equal(fs.existsSync(cacheFile), true);
  let cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.ok(cache.frontmatter[path.join(root, "pages", "Alice.md")]);
  assert.ok(cache.adjacency.nodes.some((n) => n.slug === "bob" && n.out_edges.includes("alice")));
  s.close();

  s = server(root, { LOGSEQ_CACHE_DIR: cacheDir, LOGSEQ_WATCH: "0" });
  res = s.node_degree("Alice");
  assert.equal(res.ok, true);
  assert.equal(res.in, 1);

  fs.writeFileSync(path.join(root, "pages", "Bob.md"), "type:: person\nstatus:: active\n\n- no edge now\n", "utf8");
  run("git", ["add", "pages/Bob.md"], root);
  run("git", ["commit", "-q", "-m", "remove edge"], root);
  res = s.node_degree("Alice");
  assert.equal(res.ok, true);
  assert.equal(res.in, 0);
  cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.ok(cache.adjacency.nodes.some((n) => n.slug === "bob" && n.out_edges.length === 0));
  s.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("file watcher invalidates in-process adjacency after external page edit", async () => {
  const root = makeGraph();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-cache-"));
  writePage(root, "Bob", "type:: person\nstatus:: active\n\n- see [[Alice]]\n");
  run("git", ["add", "pages/Bob.md"], root);
  run("git", ["commit", "-q", "-m", "seed bob"], root);
  const s = server(root, { LOGSEQ_CACHE_DIR: cacheDir });
  assert.equal(s.node_degree("Alice").in, 1);
  fs.writeFileSync(path.join(root, "pages", "Bob.md"), "type:: person\nstatus:: active\n\n- no edge now\n", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(s.node_degree("Alice").in, 0);
  assert.equal(s.graph_status().cache.watcher_enabled, true);
  s.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("update body section supports replace append prepend delete and errors cleanly", () => {
  const root = makeGraph();
  const body = "type:: project\nstatus:: active\n\n- ## YOU OWE (act this week)\n\t- ### Today\n\t\t- Alice deck owed\n\t\t- Bob meeting owed\n\t- ### This week\n\t\t- Cara intro owed\n- ## DONE\n\t- shipped\n";
  writePage(root, "Project", body);
  run("git", ["add", "pages/Project.md"], root);
  run("git", ["commit", "-q", "-m", "seed project"], root);
  let s = server(root);
  let res = s.update_body_section({ name: "Project", anchor: "### Today", new_content: "\t- ### Today refreshed\n\t\t- Alice deck shipped\n\t\t- Bob meeting still owed", mode: "replace_block" });
  assert.equal(res.ok, true);
  assert.equal(res.block_lines_removed, 3);
  assert.equal(res.lines_added, 3);
  let text = fs.readFileSync(path.join(root, "pages", "Project.md"), "utf8");
  assert.match(text, /Today refreshed/);
  assert.doesNotMatch(text, /Alice deck owed/);
  assert.match(text, /Cara intro/);

  res = s.update_body_section({ name: "Project", anchor: "### Today", new_content: "\t\t- first thing", mode: "prepend_to_section" });
  assert.equal(res.ok, true);
  text = fs.readFileSync(path.join(root, "pages", "Project.md"), "utf8");
  assert.ok(text.indexOf("first thing") < text.indexOf("Alice deck shipped"));

  res = s.update_body_section({ name: "Project", anchor: "### Today", new_content: "\t\t- last thing", mode: "append_to_section" });
  assert.equal(res.ok, true);
  text = fs.readFileSync(path.join(root, "pages", "Project.md"), "utf8");
  assert.ok(text.indexOf("last thing") < text.indexOf("### This week"));

  res = s.update_body_section({ name: "Project", anchor: "### This week", mode: "delete_block" });
  assert.equal(res.ok, true);
  assert.equal(res.block_lines_removed, 2);
  text = fs.readFileSync(path.join(root, "pages", "Project.md"), "utf8");
  assert.doesNotMatch(text, /Cara intro/);

  s = server(root);
  res = s.update_body_section({ name: "Project", anchor: "### Missing", new_content: "\t- x" });
  assert.equal(res.ok, false);
  assert.match(res.error, /anchor not found/);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("dangling link validation applies to body edits and stub creation", () => {
  const root = makeGraph();
  writePage(root, "Project", "type:: project\nstatus:: active\n\n- ### Today\n\t- ok\n");
  run("git", ["add", "pages/Project.md"], root);
  run("git", ["commit", "-q", "-m", "seed project"], root);
  const s = server(root);
  let res = s.update_body_section({ name: "Project", anchor: "### Today", new_content: "\t- [[Ghost]]" });
  assert.equal(res.ok, false);
  assert.match(res.error, /dangling/);

  res = s.update_body_section({ name: "Project", anchor: "### Today", new_content: "\t- [[Ghost]]", allow_dangling: true });
  assert.equal(res.ok, true);
  assert.match(res.link_warning, /dangling/);

  res = server(root).create_stub({ name: "Linker Person", notes: ["see [[Ghost Town]]"] });
  assert.equal(res.ok, false);
  assert.match(res.error, /dangling/);
  res = server(root).create_stub({ name: "Bridge Person", notes: ["see [[Ghost Town]]"], allow_dangling: true });
  assert.equal(res.ok, true);
  assert.match(res.link_warning, /dangling/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("append contact log and journal bullet preserve expected shapes", () => {
  const root = makeGraph();
  const s = server(root);
  let res = s.append_contact_log({ name: "Alice", medium: "email", summary: "caught up", date: "2026-05-20" });
  assert.equal(res.ok, true);
  let page = s.read_page("Alice");
  assert.equal(page.properties["last-contacted"], "2026-05-20");
  assert.match(page.body, /Contact log/);
  assert.match(page.body, /caught up/);

  res = s.append_contact_log({ name: "Alice", medium: "email", summary: "old note", date: "2026-04-01" });
  assert.equal(res.ok, true);
  page = s.read_page("Alice");
  assert.equal(page.properties["last-contacted"], "2026-05-20");

  res = s.append_journal_bullet({ content: "a section note", section: "Notes", date: "2026-05-28" });
  assert.equal(res.ok, true);
  const journal = s.read_journal("2026-05-28");
  assert.match(journal.raw, /## Notes/);
  assert.match(journal.raw, /a section note/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("create, rename, and delete page safety behavior", () => {
  const root = makeGraph();
  let s = server(root);
  let res = s.create_stub({ name: "New Person", page_type: "person", properties: { status: "active" }, notes: ["first note"], source: "test" });
  assert.equal(res.ok, true);
  assert.equal(s.read_page("New Person").properties.status, "active");

  res = s.create_stub({ name: "Alice" });
  assert.equal(res.ok, false);
  assert.match(res.error, /already exists/);

  s = server(root);
  res = s.rename_page("Alice", "Alice Cooper");
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(root, "pages", "Alice Cooper.md")));
  assert.match(fs.readFileSync(path.join(root, "pages", "Alice.md"), "utf8"), /redirect/);

  s = server(root);
  res = s.delete_page("schema___properties");
  assert.equal(res.ok, false);
  assert.match(res.error, /schema/);

  res = s.delete_page("Bad Date");
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(path.join(root, "pages", "Bad Date.md")), false);
  assert.ok(res.archived_path.startsWith("archive/"));
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("write lock timeout returns a structured error and preserves graph", () => {
  const root = makeGraph();
  fs.writeFileSync(path.join(root, "pages", "Alice.md.lock"), "held", "utf8");
  const res = server(root, { LOGSEQ_LOCK_TIMEOUT_MS: "25" }).update_property({ name: "Alice", key: "status", value: "blocked" });
  assert.equal(res.ok, false);
  assert.match(res.error, /could not acquire lock/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "pages", "Alice.md"), "utf8"), /blocked/);
  fs.rmSync(path.join(root, "pages", "Alice.md.lock"), { force: true });
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("case-only rename is refused on case-insensitive filesystems", (t) => {
  const root = makeGraph();
  if (!isCaseInsensitiveDir(path.join(root, "pages"))) {
    fs.rmSync(root, { recursive: true, force: true });
    t.skip("filesystem is case-sensitive");
    return;
  }
  const res = server(root).rename_page("Alice", "alice");
  assert.equal(res.ok, false);
  assert.match(res.error, /case-only rename/);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("graph analysis, backlinks, search cap, and symlink guard", () => {
  const root = makeGraph();
  writePage(root, "Bob", "type:: person\nstatus:: active\n\n- hi\n");
  writePage(root, "Linker", "type:: person\n\n- see [[Bob]] and [[Nowhere Land]]\n- inline `[[Ghost Inline]]`\n- ```\n- [[Ghost Fenced]]\n- ```\n");
  run("git", ["add", "pages/Bob.md", "pages/Linker.md"], root);
  run("git", ["commit", "-q", "-m", "seed links"], root);

  const s = server(root, { LOGSEQ_MAX_SEARCH_LINE: "40" });
  let res = s.find_orphans();
  assert.equal(res.ok, true);
  assert.ok(res.orphans.some((o) => o.name === "Alice"));
  res = s.find_low_degree({ max_degree: 0 });
  assert.equal(res.ok, true);
  res = s.find_hubs({ limit: 5 });
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.hubs));
  res = s.node_degree("Bob");
  assert.equal(res.ok, true);
  assert.equal(res.in, 1);
  res = s.graph_stats();
  assert.equal(res.ok, true);
  assert.ok(res.totals.entity_pages >= 3);
  res = s.find_components();
  assert.equal(res.ok, true);
  assert.ok("total_components" in res);
  res = s.find_dangling_links();
  assert.equal(res.ok, true);
  assert.ok(res.dangling.some((d) => d.target === "nowhere land"));
  assert.ok(!res.dangling.some((d) => d.target === "ghost inline" || d.target === "ghost fenced"));
  res = s.backlinks({ name: "Bob", mode: "detail" });
  assert.equal(res.ok, true);
  assert.deepEqual(new Set(res.results.map((r) => r.name)), new Set(["Linker"]));

  writePage(root, "Long", "type:: person\n\n- " + "x".repeat(100) + "NEEDLE\n");
  res = s.search({ query: "NEEDLE" });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.ok(["native", "re2"].includes(res.regex_engine));

  fs.symlinkSync(path.join(root, "pages", "Alice.md"), path.join(root, "pages", "Linked.md"));
  res = s.update_property({ name: "Linked", key: "status", value: "hacked" });
  assert.equal(res.ok, false);
  assert.match(res.error, /symlink/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "pages", "Alice.md"), "utf8"), /hacked/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("optional RE2 search path is used when re2 is installed", () => {
  const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "logseq-mcp-re2-"));
  const re2Dir = path.join(moduleRoot, "node_modules", "re2");
  fs.mkdirSync(re2Dir, { recursive: true });
  fs.writeFileSync(path.join(re2Dir, "package.json"), JSON.stringify({ name: "re2", main: "index.js" }), "utf8");
  fs.writeFileSync(path.join(re2Dir, "index.js"), `
class FakeRE2 {
  constructor(pattern, flags) { this.re = new RegExp(pattern, flags); }
  exec(input) { return this.re.exec(input); }
}
module.exports = FakeRE2;
`, "utf8");
  const searchModule = path.join(moduleRoot, "search.mjs");
  fs.copyFileSync(path.join(repo, "dist", "tools", "search.js"), searchModule);
  const script = `
const mod = await import(${JSON.stringify(searchModule)});
const compiled = mod.compileSearchRegex("needle", "i");
console.log(JSON.stringify({ engine: mod.regexEngineName(), match: compiled.search("hay NEEDLE stack") }));
`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.engine, "re2");
  assert.equal(payload.match.text, "NEEDLE");
  fs.rmSync(moduleRoot, { recursive: true, force: true });
});

test("stdio MCP initialize, tools/list, readonly write call", () => {
  const root = makeGraph();
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const payload = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.1" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_stub", arguments: { name: "Blocked Stub" } } }),
    "",
  ].join("\n");
  const res = spawnSync(process.execPath, [path.join(repo, pkg.bin["logseq-graph-mcp"]), "--root", root], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_READONLY: "1", LOGSEQ_GIT_GUARD: "strict" },
    timeout: 20000,
  });
  assert.equal(res.status, 0, res.stderr);
  const responses = res.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(responses.find((entry) => entry.id === 1).result.serverInfo, {
    name: "logseq-graph-mcp",
    version: pkg.version,
  });
  assert.match(JSON.stringify(responses), /graph_status/);
  assert.match(JSON.stringify(responses), /create_stub/);
  assert.match(res.stderr, /readonly = True/);
  assert.match(JSON.stringify(responses), /LOGSEQ_READONLY/);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});
