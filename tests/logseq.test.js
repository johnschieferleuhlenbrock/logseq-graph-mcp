import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isCaseInsensitiveDir, makeGraph, repo, run, server, status, writePage } from "./helpers/logseq-fixtures.js";
import { GitTxn } from "../dist/graph/git-guard.js";
import { LogseqServer } from "../dist/logseq.js";

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

function installFakeDate(iso) {
  const RealDate = globalThis.Date;
  const fixedMs = RealDate.parse(iso);
  class FakeDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedMs]));
    }
    static now() {
      return fixedMs;
    }
  }
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  globalThis.Date = FakeDate;
  return () => {
    globalThis.Date = RealDate;
  };
}

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

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

test("default write mode exposes safe-write tools and hides raw mutating tools", () => {
  const root = makeGraph();
  const s = new LogseqServer({
    root,
    env: {
      ...process.env,
      LOGSEQ_ROOT: root,
      LOGSEQ_GIT_GUARD: "strict",
      LOGSEQ_VALIDATE_SCHEMA: "block",
      LOGSEQ_MAX_RESPONSE_BYTES: "500000",
      LOGSEQ_WATCH: "0",
    },
  });
  const toolNames = Object.keys(s.tools()).sort();
  assert.ok(toolNames.includes("submit_write_intent"));
  assert.ok(toolNames.includes("flush_write_intents"));
  assert.ok(toolNames.includes("graph_status"));
  for (const [name] of mutatingToolCalls) assert.equal(toolNames.includes(name), false, name);
  assert.deepEqual(s.toolDefinitions().map((d) => d.name).sort(), toolNames);
  assert.match(s.callTool("update_property", { name: "Alice", key: "status", value: "blocked" }).error, /unknown tool/);
  const statusResult = s.graph_status();
  assert.equal(statusResult.write_mode, "intent");
  assert.ok(statusResult.write_intents);
  fs.rmSync(root, { recursive: true, force: true });
});

test("admin_raw write mode exposes raw mutating tools", () => {
  const root = makeGraph();
  const toolNames = Object.keys(server(root).tools()).sort();
  for (const [name] of mutatingToolCalls) assert.equal(toolNames.includes(name), true, name);
  assert.deepEqual(server(root).toolDefinitions().map((d) => d.name).sort(), toolNames);
  fs.rmSync(root, { recursive: true, force: true });
});

test("invalid write mode fails closed to readonly tools", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WRITE_MODE: "readony", LOGSEQ_WATCH: "0" } });
  const toolNames = Object.keys(s.tools());
  assert.equal(s.graph_status().write_mode, "readonly");
  assert.equal(toolNames.includes("submit_write_intent"), false);
  assert.equal(toolNames.includes("create_stub"), false);
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
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_READONLY: "1", LOGSEQ_WRITE_MODE: "admin_raw", LOGSEQ_WATCH: "0" } });
  for (const [name, args] of mutatingToolCalls) {
    const res = s.callTool(name, args);
    assert.equal(res.ok, false, name);
    assert.match(res.error, /unknown tool/, name);
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

test("safe write intents are idempotent and flush through git guard", () => {
  const root = makeGraph();
  const s = new LogseqServer({
    root,
    env: {
      ...process.env,
      LOGSEQ_ROOT: root,
      LOGSEQ_GIT_GUARD: "strict",
      LOGSEQ_VALIDATE_SCHEMA: "block",
      LOGSEQ_MAX_RESPONSE_BYTES: "500000",
      LOGSEQ_WATCH: "0",
    },
  });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:update-alice-status",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "warm" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const intentId = submit.intent.intent_id;
  assert.equal(submit.intent.state, "pending");
  assert.equal(submit.intent.idempotency_key, "test:update-alice-status");

  const duplicate = s.callTool("submit_write_intent", {
    idempotency_key: "test:update-alice-status",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "warm" },
    caller: "test",
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.intent.intent_id, intentId);
  assert.equal(duplicate.intent.idempotency_key, "test:update-alice-status");

  const conflict = s.callTool("submit_write_intent", {
    idempotency_key: "test:update-alice-status",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "cold" },
    caller: "test",
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error_class, "idempotency_conflict");

  const flush = s.callTool("flush_write_intents", { intent_ids: [intentId] });
  assert.equal(flush.ok, true);
  assert.equal(flush.success_count, 1);
  assert.equal(flush.results[0].ok, true);
  assert.equal(server(root).read_page("Alice").properties.status, "warm");
  assert.equal(status(root), "");
  assert.match(run("git", ["log", "-1", "--format=%B"], root), /op_id:/);
  assert.match(run("git", ["log", "-1", "--format=%B"], root), /idempotency_key:/);
  const completedIntent = s.callTool("get_write_intent", { intent_id: intentId }).intent;
  assert.equal(completedIntent.state, "completed");
  assert.ok(completedIntent.git_commit);
  assert.ok(completedIntent.completed_at);
  const committedRows = s.writeLedger.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE state = 'committed'").get();
  assert.equal(committedRows.count, 0);

  const secondFlush = s.callTool("flush_write_intents", { intent_ids: [intentId] });
  assert.equal(secondFlush.ok, true);
  assert.equal(secondFlush.results[0].duplicate, true);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe append intent retry does not duplicate content", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:journal-append",
    tool: "append_journal_bullet",
    arguments: { date: "2026-06-01", content: "safe retry [[Alice]]" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const intentId = submit.intent.intent_id;
  let flush = s.callTool("flush_write_intents", { intent_ids: [intentId] });
  assert.equal(flush.results[0].ok, true);
  flush = s.callTool("flush_write_intents", { intent_ids: [intentId] });
  assert.equal(flush.results[0].ok, true);
  const journal = fs.readFileSync(path.join(root, "journals", "2026_06_01.md"), "utf8");
  assert.equal((journal.match(/safe retry \[\[Alice\]\]/g) || []).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe append journal intent rejects symlinked journal before recording ledger row", () => {
  const root = makeGraph();
  fs.writeFileSync(path.join(root, "journals", "2026_06_04_target.md"), "- existing\n", "utf8");
  fs.symlinkSync(path.join(root, "journals", "2026_06_04_target.md"), path.join(root, "journals", "2026_06_04.md"));
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:journal-symlink",
    tool: "append_journal_bullet",
    arguments: { date: "2026-06-04", content: "should not record" },
    caller: "test",
  });
  assert.equal(submit.ok, false);
  assert.match(submit.error, /symlink/);
  const list = s.callTool("list_write_intents", {});
  assert.equal(list.ok, true);
  assert.equal(list.intents.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe contact log idempotency is scoped to the contact log section", () => {
  const root = makeGraph();
  writePage(root, "Alice", "type:: person\nstatus:: active\nlast-contacted:: 2026-05-01\n\n- Prior note mentions 2026-05-20 - email - caught up outside the log\n");
  run("git", ["add", "pages/Alice.md"], root);
  run("git", ["commit", "-q", "-m", "mention contact marker outside log"], root);
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:contact-log-section-idempotency",
    tool: "append_contact_log",
    arguments: { name: "Alice", medium: "email", summary: "caught up", date: "2026-05-20" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, true);
  const page = s.read_page("Alice");
  assert.equal(page.properties["last-contacted"], "2026-05-20");
  assert.match(page.body, /- \*\*Contact log\*\* \(newest first\)\n\t- 2026-05-20 - email - caught up/);

  const prefixSubmit = s.callTool("submit_write_intent", {
    idempotency_key: "test:contact-log-prefix-is-not-applied",
    tool: "append_contact_log",
    arguments: { name: "Alice", medium: "email", summary: "caught", date: "2026-05-20" },
    caller: "test",
  });
  assert.equal(prefixSubmit.ok, true);
  const prefixFlush = s.callTool("flush_write_intents", { intent_ids: [prefixSubmit.intent.intent_id] });
  assert.equal(prefixFlush.results[0].ok, true);
  const updated = s.read_page("Alice");
  assert.match(updated.body, /- \*\*Contact log\*\* \(newest first\)\n\t- 2026-05-20 - email - caught\n\t- 2026-05-20 - email - caught up/);
  assert.equal(status(root), "");
  s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe append idempotency is scoped to body anchors and journal sections", () => {
  const root = makeGraph();
  writePage(root, "Scoped Body", "type:: note\n\n- Other\n\t- duplicate line\n- Target\n\t- existing\n\t- callback\n");
  fs.writeFileSync(path.join(root, "journals", "2026_06_03.md"), "- ## Other\n\t- duplicate bullet\n- ## duplicate top bullet\n- ## Target\n\t- existing\n\t- callback\n", "utf8");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "add scoped idempotency fixtures"], root);
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });

  let submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:body-marker-in-other-block",
    tool: "update_body_section",
    arguments: { name: "Scoped Body", anchor: "Target", mode: "append_to_section", new_content: "\t- duplicate line" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  let flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, true);
  let page = s.read_page("Scoped Body", true);
  assert.match(page.raw, /- Target\n\t- existing\n\t- callback\n\t- duplicate line/);

  submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:body-prefix-is-not-applied",
    tool: "update_body_section",
    arguments: { name: "Scoped Body", anchor: "Target", mode: "append_to_section", new_content: "\t- call" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, true);
  page = s.read_page("Scoped Body", true);
  assert.match(page.raw, /- Target\n\t- existing\n\t- callback\n\t- duplicate line\n\t- call/);

  submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:journal-marker-in-other-section",
    tool: "append_journal_bullet",
    arguments: { date: "2026-06-03", section: "Target", content: "duplicate bullet" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, true);
  let journal = s.read_journal("2026-06-03");
  assert.match(journal.raw, /- ## Target\n\t- duplicate bullet\n\t- existing/);

  submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:journal-marker-in-heading",
    tool: "append_journal_bullet",
    arguments: { date: "2026-06-03", content: "duplicate top bullet" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, true);
  journal = s.read_journal("2026-06-03");
  assert.match(journal.raw, /\n- duplicate top bullet\n?$/);

  submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:journal-section-prefix-is-not-applied",
    tool: "append_journal_bullet",
    arguments: { date: "2026-06-03", section: "Target", content: "call" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, true);
  journal = s.read_journal("2026-06-03");
  assert.match(journal.raw, /- ## Target\n\t- call\n\t- duplicate bullet\n\t- existing\n\t- callback/);
  assert.equal(status(root), "");
  s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe write intents classify dirty graph as retryable without mutating", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:dirty-graph",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "warm" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: active\nlast-contacted:: 2026-05-01\n\n- dirty\n", "utf8");
  const flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.ok, true);
  assert.equal(flush.results[0].ok, false);
  assert.equal(flush.results[0].state, "manual_review");
  assert.match(flush.results[0].error, /target changed|clean Logseq graph/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe write intents require explicit flush ids and keep ledger out of git", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const emptyFlush = s.callTool("flush_write_intents", {});
  assert.equal(emptyFlush.ok, false);
  assert.match(emptyFlush.error, /intent_ids/);

  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:ledger-outside",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "queued" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const statusResult = s.graph_status();
  assert.equal(statusResult.ok, true);
  assert.equal(path.resolve(statusResult.write_intents.ledger_file).startsWith(path.resolve(root)), false);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe already-applied flush claims intent before completing", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:already-applied-claims-first",
    tool: "append_journal_bullet",
    arguments: { date: "2026-06-01", content: "externally applied [[Alice]]" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const journalPath = path.join(root, "journals", "2026_06_01.md");
  fs.writeFileSync(journalPath, "- externally applied [[Alice]]\n", "utf8");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "external journal append"], root);

  const flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, true);
  assert.equal(flush.results[0].reconciled, true);
  const intent = s.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "completed");
  assert.equal(intent.attempt_count, 1);
  const journal = fs.readFileSync(journalPath, "utf8");
  assert.equal((journal.match(/externally applied/g) ?? []).length, 1);
  assert.equal(status(root), "");
  s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe write intent claims are atomic across repeated flush attempts", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:atomic-claim",
    tool: "append_journal_bullet",
    arguments: { date: "2026-06-01", content: "atomic claim [[Alice]]" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const record = s.writeLedger.get(submit.intent.intent_id);
  const first = s.writeLedger.claimForFlush(record, 60_000);
  assert.equal(first.claimed, true);
  const second = s.writeLedger.claimForFlush(record, 60_000);
  assert.equal(second.claimed, false);
  assert.equal(second.record.state, "applying");
  assert.equal(second.record.attempt_count, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe write intents reject schema and dangling links before ledger mutation", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_VALIDATE_SCHEMA: "block", LOGSEQ_WATCH: "0" } });
  let res = s.callTool("submit_write_intent", {
    idempotency_key: "test:bad-schema",
    tool: "update_property",
    arguments: { name: "Alice", key: "unknown-key", value: "x" },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /not in schema/);

  res = s.callTool("submit_write_intent", {
    idempotency_key: "test:dangling",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "[[Ghost Town]]" },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /dangling wikilink/);

  res = s.callTool("submit_write_intent", {
    idempotency_key: "test:create-stub-bad-property",
    tool: "create_stub",
    arguments: { name: "New Stub", properties: { "unknown-key": "x" } },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /not in schema/);

  res = s.callTool("submit_write_intent", {
    idempotency_key: "test:create-stub-dangling",
    tool: "create_stub",
    arguments: { name: "Linked Stub", notes: ["see [[Ghost Town]]"] },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /dangling wikilink/);

  res = s.callTool("submit_write_intent", {
    idempotency_key: "test:body-invalid-mode",
    tool: "update_body_section",
    arguments: { name: "Alice", anchor: "hello", mode: "bad_mode", new_content: "- replacement" },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /mode must be one of/);

  res = s.callTool("submit_write_intent", {
    idempotency_key: "test:body-missing-content",
    tool: "update_body_section",
    arguments: { name: "Alice", anchor: "hello", mode: "replace_block" },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /new_content is required/);

  res = s.callTool("submit_write_intent", {
    idempotency_key: "test:body-dangling-link",
    tool: "update_body_section",
    arguments: { name: "Alice", anchor: "hello", new_content: "- [[Ghost Town]]" },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /dangling wikilink/);

  res = s.callTool("submit_write_intent", {
    idempotency_key: "test:batch-duplicate-target",
    tool: "batch_update_property",
    arguments: {
      updates: [
        { name: "Alice", key: "status", value: "warm" },
        { name: "Alice", key: "status", value: "hot" },
      ],
    },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /duplicate batch update target/);

  res = s.callTool("submit_write_intent", {
    idempotency_key: "test:delete-schema",
    tool: "delete_page",
    arguments: { name: "schema___properties" },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /schema/);

  writePage(root, "Bob", "type:: person\n\n- knows [[Alice]]\n");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "add backlink page"], root);
  const s2 = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_VALIDATE_SCHEMA: "block", LOGSEQ_WATCH: "0" } });
  res = s2.callTool("submit_write_intent", {
    idempotency_key: "test:rename-existing-destination",
    tool: "rename_page",
    arguments: { old_name: "Alice", new_name: "Bob" },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Destination exists/);

  res = s2.callTool("submit_write_intent", {
    idempotency_key: "test:delete-linked-page",
    tool: "delete_page",
    arguments: { name: "Alice" },
    caller: "test",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /backlinks/);

  const list = s2.callTool("list_write_intents", {});
  assert.equal(list.count, 0);
  assert.equal(status(root), "");
  s.close();
  s2.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe delete_page intent flushes through planned suffixed archive path", () => {
  const root = makeGraph();
  const now = new Date();
  const archiveDir = path.join(root, "archive", String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"));
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, "Bad Date.md"), "existing archive collision\n", "utf8");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "add archive collision"], root);
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:delete-page-suffixed-archive",
    tool: "delete_page",
    arguments: { name: "Bad Date" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const archiveEffect = s.writeLedger.effects(submit.intent.intent_id).find((effect) => effect.effect_type === "delete_page_archive");
  assert.ok(archiveEffect.path.startsWith("archive/"));
  assert.notEqual(archiveEffect.path, path.join("archive", String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"), "Bad Date.md"));
  const flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, true);
  assert.equal(flush.results[0].result.archived_path, archiveEffect.path);
  assert.equal(fs.existsSync(path.join(root, archiveEffect.path)), true);
  assert.equal(status(root), "");
  const duplicate = s.callTool("submit_write_intent", {
    idempotency_key: "test:delete-page-suffixed-archive",
    tool: "delete_page",
    arguments: { name: "Bad Date" },
    caller: "test",
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.intent.intent_id, submit.intent.intent_id);
  assert.equal(duplicate.intent.state, "completed");
  s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe write audit uses the submitted ledger audit path across midnight", () => {
  const root = makeGraph();
  let restoreDate = installFakeDate("2026-06-01T23:59:00.000Z");
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:audit-path-frozen",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "after-midnight" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  restoreDate();
  restoreDate = installFakeDate("2026-06-02T00:01:00.000Z");
  try {
    const flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
    assert.equal(flush.results[0].ok, true);
  } finally {
    restoreDate();
  }
  assert.equal(fs.existsSync(path.join(root, "journals", "2026_06_01.md")), true);
  assert.equal(fs.existsSync(path.join(root, "journals", "2026_06_02.md")), false);
  assert.equal(status(root), "");

  restoreDate = installFakeDate("2026-06-01T23:59:00.000Z");
  const journalSubmit = s.callTool("submit_write_intent", {
    idempotency_key: "test:audit-path-frozen-journal-target",
    tool: "append_journal_bullet",
    arguments: { content: "journal audit path frozen" },
    caller: "test",
  });
  assert.equal(journalSubmit.ok, true);
  const effects = s.writeLedger.effects(journalSubmit.intent.intent_id);
  assert.equal(effects.some((effect) => effect.effect_type === "audit_journal" && effect.path === "journals/2026_06_01.md"), true);
  restoreDate();
  restoreDate = installFakeDate("2026-06-02T00:01:00.000Z");
  try {
    const journalFlush = s.callTool("flush_write_intents", { intent_ids: [journalSubmit.intent.intent_id] });
    assert.equal(journalFlush.results[0].ok, true);
  } finally {
    restoreDate();
  }
  assert.match(fs.readFileSync(path.join(root, "journals", "2026_06_01.md"), "utf8"), /journal audit path frozen/);
  assert.equal(fs.existsSync(path.join(root, "journals", "2026_06_02.md")), false);
  assert.equal(status(root), "");
  s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe create_stub intent does not complete from a partial external stub", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_VALIDATE_SCHEMA: "block", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:create-stub-partial-external",
    tool: "create_stub",
    arguments: { name: "Partial Stub", properties: { status: "active" }, notes: ["requested note"], source: "safe-intent-test" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  writePage(root, "Partial Stub", "type:: person\nconfidence:: low\n\n- different content\n");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "external partial stub"], root);
  const flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, false);
  assert.equal(flush.results[0].state, "manual_review");
  assert.match(JSON.stringify(flush.results[0]), /target changed/);
  assert.equal(status(root), "");
  s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe write intents move stale base conflicts to manual review and reject invalid anchors", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const before = run("git", ["rev-parse", "HEAD"], root);
  const stale = s.callTool("submit_write_intent", {
    idempotency_key: "test:stale-head",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "later" },
    expected_base_head: before,
    caller: "test",
  });
  assert.equal(stale.ok, true);
  run("git", ["commit", "--allow-empty", "-q", "-m", "advance head"], root);
  let flush = s.callTool("flush_write_intents", { intent_ids: [stale.intent.intent_id] });
  assert.equal(flush.results[0].ok, false);
  assert.equal(flush.results[0].state, "manual_review");
  assert.match(flush.results[0].error, /expected_base_head/);

  const missingAnchor = s.callTool("submit_write_intent", {
    idempotency_key: "test:missing-anchor",
    tool: "update_body_section",
    arguments: { name: "Alice", anchor: "not in file", new_content: "- replacement" },
    caller: "test",
  });
  assert.equal(missingAnchor.ok, false);
  assert.match(missingAnchor.error, /anchor/);

  const missingDeleteAnchor = s.callTool("submit_write_intent", {
    idempotency_key: "test:missing-delete-anchor",
    tool: "update_body_section",
    arguments: { name: "Alice", anchor: "not in file", mode: "delete_block" },
    caller: "test",
  });
  assert.equal(missingDeleteAnchor.ok, false);
  assert.match(missingDeleteAnchor.error, /anchor/);

  writePage(root, "Ambiguous Body", "type:: note\n\n- target\n- target\n");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "add ambiguous body"], root);
  const ambiguousAnchor = s.callTool("submit_write_intent", {
    idempotency_key: "test:ambiguous-anchor",
    tool: "update_body_section",
    arguments: { name: "Ambiguous Body", anchor: "target", new_content: "- replacement" },
    caller: "test",
  });
  assert.equal(ambiguousAnchor.ok, false);
  assert.match(ambiguousAnchor.error, /anchor/);

  const staleDelete = s.callTool("submit_write_intent", {
    idempotency_key: "test:stale-delete-property",
    tool: "delete_property",
    arguments: { name: "Alice", key: "status" },
    caller: "test",
  });
  assert.equal(staleDelete.ok, true);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: archived\nlast-contacted:: 2026-05-01\n\n- hello\n", "utf8");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "change status after intent"], root);
  flush = s.callTool("flush_write_intents", { intent_ids: [staleDelete.intent.intent_id] });
  assert.equal(flush.results[0].ok, false);
  assert.equal(flush.results[0].state, "manual_review");
  assert.match(JSON.stringify(flush.results[0]), /target changed/);
  assert.equal(server(root).read_page("Alice").properties.status, "archived");

  fs.rmSync(root, { recursive: true, force: true });
});

test("safe update_body_section delete intent deletes instead of matching empty marker", () => {
  const root = makeGraph();
  writePage(root, "Body Delete", "type:: note\n\n- keep\n- delete me\n\t- child\n- after\n");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "add body delete page"], root);
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:delete-body-block",
    tool: "update_body_section",
    arguments: { name: "Body Delete", anchor: "delete me", mode: "delete_block" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, true);
  const page = s.read_page("Body Delete");
  assert.doesNotMatch(page.body, /delete me/);
  assert.doesNotMatch(page.body, /child/);
  assert.match(page.body, /after/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe update_body_section replace rejects missing anchor even when content exists elsewhere", () => {
  const root = makeGraph();
  writePage(root, "Body Replace", "type:: note\n\n- existing replacement text\n- keep original\n");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "add body replace page"], root);
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:replace-body-missing-anchor",
    tool: "update_body_section",
    arguments: { name: "Body Replace", anchor: "missing anchor", mode: "replace_block", new_content: "- existing replacement text" },
    caller: "test",
  });
  assert.equal(submit.ok, false);
  assert.match(submit.error, /anchor/);
  const page = s.read_page("Body Replace");
  assert.match(page.body, /keep original/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe write intents classify blast radius failures and preserve clean graph", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_GIT_MAX_CHANGED_FILES: "1", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:blast-radius",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "too-wide" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, false);
  assert.equal(flush.results[0].state, "manual_review");
  assert.match(JSON.stringify(flush.results[0]), /blast-radius|files changed/);
  assert.equal(server(root).read_page("Alice").properties.status, "active");
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe batch partial commits complete the intent instead of retrying", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_LOCK_TIMEOUT_MS: "25", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:batch-partial-commit",
    tool: "batch_update_property",
    arguments: {
      updates: [
        { name: "Alice", key: "status", value: "warm" },
        { name: "Bad Date", key: "status", value: "warm" },
      ],
    },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const locked = path.join(root, "pages", "Bad Date.md.lock");
  fs.writeFileSync(locked, "held", "utf8");
  const flush = s.callTool("flush_write_intents", { intent_ids: [submit.intent.intent_id] });
  assert.equal(flush.results[0].ok, false);
  assert.equal(flush.results[0].state, "completed");
  assert.equal(flush.results[0].committed, true);
  assert.ok(flush.results[0].intent.git_commit);
  assert.equal(s.read_page("Alice").properties.status, "warm");
  assert.equal(s.read_page("Bad Date").properties.status, "active");
  assert.equal(s.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent.state, "completed");
  fs.rmSync(locked, { force: true });
  assert.equal(status(root), "");
  s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("graph status reports stale metadata lockfiles without breaking them", () => {
  const root = makeGraph();
  const lockPath = path.join(root, "pages", "Alice.md.lock");
  const metadata = {
    op_id: "stale-op",
    pid: 99999999,
    process_start_time: "unknown",
    host: "test-host",
    target: "pages/Alice.md",
    created_at: "2026-06-01T00:00:00.000Z",
    expires_at: "2026-06-01T00:00:01.000Z",
  };
  fs.writeFileSync(lockPath, JSON.stringify(metadata), "utf8");
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const statusResult = s.graph_status();
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.locks.file_lock_count_sampled, 1);
  assert.equal(statusResult.locks.file_locks[0].stale, true);
  assert.equal(statusResult.locks.file_locks[0].metadata.op_id, "stale-op");
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation returns applying-before-write intents to pending", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-before-write",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "recovered" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const started = s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), -1000);
  assert.equal(started.state, "applying");
  s.close();

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "pending");
  assert.equal(status(root), "");
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation ignores audit-only drift before target writes", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-before-write-audit-drift",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "recovered" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const started = s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), -1000);
  assert.equal(started.state, "applying");
  const auditEffect = s.writeLedger.effects(submit.intent.intent_id).find((effect) => effect.effect_type === "audit_journal");
  assert.ok(auditEffect);
  fs.mkdirSync(path.dirname(path.join(root, auditEffect.path)), { recursive: true });
  fs.writeFileSync(path.join(root, auditEffect.path), "- unrelated committed audit entry\n", "utf8");
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-q", "-m", "unrelated audit write"], root);
  s.close();

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "pending");
  assert.equal(recovered.read_page("Alice").properties.status, "active");
  assert.equal(status(root), "");
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("write intent polling recovers leases that expire after startup", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-after-startup",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "recovered" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const started = s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), 60_000);
  assert.equal(started.state, "applying");
  s.close();

  const restarted = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  assert.equal(restarted.writeLedger.get(submit.intent.intent_id).state, "applying");
  restarted.writeLedger.db.prepare("UPDATE operations SET lease_expires_at = ? WHERE op_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), submit.intent.intent_id);
  const intent = restarted.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "pending");
  assert.equal(status(root), "");
  restarted.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation commits expected file effects after crash before commit", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-file-effect",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "recovered" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), -1000);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: recovered\nlast-contacted:: 2026-05-01\n\n- hello\n", "utf8");
  const effectsAfter = s.writeLedger.effects(submit.intent.intent_id).map((effect) => ({
    ...effect,
    after_hash: hashFile(path.join(root, effect.path)),
  }));
  const applying = s.writeLedger.get(submit.intent.intent_id);
  s.writeLedger.markAppliedUncommitted(applying, effectsAfter);
  s.close();

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "completed");
  assert.ok(intent.git_commit);
  assert.equal(recovered.read_page("Alice").properties.status, "recovered");
  assert.equal(status(root), "");
  const body = run("git", ["log", "-1", "--format=%B"], root);
  assert.match(body, /reconciled: true/);
  assert.match(body, /op_id:/);
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation refuses unproven same-file dirty recovery", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-file-effect-with-extra-drift",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "recovered" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), -1000);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: recovered\nlast-contacted:: 2026-05-01\npriority:: high\n\n- hello\n- unrelated dirty edit\n", "utf8");
  s.close();

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "manual_review");
  assert.equal(recovered.read_page("Alice").properties.status, "recovered");
  assert.match(status(root), /pages\/Alice\.md/);
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation commits recovered delete_property effects", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-delete-property",
    tool: "delete_property",
    arguments: { name: "Alice", key: "status" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), -1000);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nlast-contacted:: 2026-05-01\n\n- hello\n", "utf8");
  const effectsAfter = s.writeLedger.effects(submit.intent.intent_id).map((effect) => ({
    ...effect,
    after_hash: hashFile(path.join(root, effect.path)),
  }));
  s.writeLedger.markAppliedUncommitted(s.writeLedger.get(submit.intent.intent_id), effectsAfter);
  s.close();

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "completed");
  assert.ok(intent.git_commit);
  assert.equal(recovered.read_page("Alice").properties.status, undefined);
  assert.equal(status(root), "");
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation rejects unrelated dirty delete_property marker matches", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-delete-property-marker-mismatch",
    tool: "delete_property",
    arguments: { name: "Alice", key: "status" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), -1000);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: archived\nlast-contacted:: 2026-05-01\n\n- hello\n", "utf8");
  s.close();

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "manual_review");
  assert.equal(recovered.read_page("Alice").properties.status, "archived");
  assert.match(status(root), /pages\/Alice\.md/);
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation commits recovered source-delete effects", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  let submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-delete-page",
    tool: "delete_page",
    arguments: { name: "Bad Date" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), -1000);
  let effects = s.writeLedger.effects(submit.intent.intent_id);
  let source = path.join(root, effects.find((effect) => effect.effect_type === "delete_page").path);
  let archive = path.join(root, effects.find((effect) => effect.effect_type === "delete_page_archive").path);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.renameSync(source, archive);
  s.close();

  let recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  let intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "completed");
  assert.ok(intent.git_commit);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(archive), true);
  assert.equal(status(root), "");
  recovered.close();

  const renameServer = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  submit = renameServer.callTool("submit_write_intent", {
    idempotency_key: "test:recover-rename-no-redirect",
    tool: "rename_page",
    arguments: { old_name: "Alice", new_name: "Alice Gone", leave_redirect: false },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  renameServer.writeLedger.start(renameServer.writeLedger.get(submit.intent.intent_id), -1000);
  effects = renameServer.writeLedger.effects(submit.intent.intent_id);
  source = path.join(root, effects.find((effect) => effect.effect_type === "rename_page_source").path);
  const destination = path.join(root, effects.find((effect) => effect.effect_type === "rename_page_destination").path);
  fs.copyFileSync(source, destination);
  fs.unlinkSync(source);
  renameServer.close();

  recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "completed");
  assert.ok(intent.git_commit);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(destination), true);
  assert.equal(status(root), "");
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation commits recovered rename redirect effects", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-rename-redirect",
    tool: "rename_page",
    arguments: { old_name: "Alice", new_name: "Alice Redirected" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), -1000);
  const effects = s.writeLedger.effects(submit.intent.intent_id);
  const source = path.join(root, effects.find((effect) => effect.effect_type === "rename_page_source").path);
  const destination = path.join(root, effects.find((effect) => effect.effect_type === "rename_page_destination").path);
  const audit = path.join(root, effects.find((effect) => effect.effect_type === "audit_journal").path);
  fs.copyFileSync(source, destination);
  fs.writeFileSync(source, "type:: redirect\nredirects-to:: [[Alice Redirected]]\n\n- Redirected to [[Alice Redirected]].\n", "utf8");
  fs.writeFileSync(audit, "- rename_page :: \"Alice\" -> \"Alice Redirected\" (redirect=true)\n", "utf8");
  s.close();

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "completed");
  assert.ok(intent.git_commit);
  assert.match(fs.readFileSync(source, "utf8"), /type:: redirect/);
  assert.match(fs.readFileSync(destination, "utf8"), /status:: active/);
  assert.equal(status(root), "");
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation sends unexpected same-path effects to manual review", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-same-path-mismatch",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "intended" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  s.writeLedger.start(s.writeLedger.get(submit.intent.intent_id), -1000);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: wrong-value\nlast-contacted:: 2026-05-01\n\n- hello\n", "utf8");
  s.close();

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: submit.intent.intent_id }).intent;
  assert.equal(intent.state, "manual_review");
  assert.equal(recovered.read_page("Alice").properties.status, "wrong-value");
  assert.match(status(root), /pages\/Alice\.md/);
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation completes from existing intent commit metadata", () => {
  const root = makeGraph();
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-existing-commit",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "committed" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const opId = submit.intent.intent_id;
  const record = s.writeLedger.start(s.writeLedger.get(opId), -1000);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: committed\nlast-contacted:: 2026-05-01\n\n- hello\n", "utf8");
  run("git", ["add", "-A"], root);
  run("git", [
    "commit",
    "-q",
    "-m",
    "manual recovered commit",
    "-m",
    `op_id: ${record.op_id}`,
    "-m",
    `idempotency_key: ${record.idempotency_key}`,
    "-m",
    `request_hash: ${record.request_hash}`,
  ], root);
  const commit = run("git", ["rev-parse", "HEAD"], root);
  s.close();

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: opId }).intent;
  assert.equal(intent.state, "completed");
  assert.equal(intent.git_commit, commit);
  assert.equal(status(root), "");
  recovered.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("startup reconciliation ignores intent commits unreachable from current HEAD", () => {
  const root = makeGraph();
  const branch = run("git", ["branch", "--show-current"], root);
  const s = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const submit = s.callTool("submit_write_intent", {
    idempotency_key: "test:recover-other-branch-commit",
    tool: "update_property",
    arguments: { name: "Alice", key: "status", value: "branch-only" },
    caller: "test",
  });
  assert.equal(submit.ok, true);
  const opId = submit.intent.intent_id;
  const record = s.writeLedger.start(s.writeLedger.get(opId), -1000);
  s.close();

  run("git", ["switch", "-q", "-c", "side-intent-commit"], root);
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: branch-only\nlast-contacted:: 2026-05-01\n\n- hello\n", "utf8");
  run("git", ["add", "-A"], root);
  run("git", [
    "commit",
    "-q",
    "-m",
    "side branch intent commit",
    "-m",
    `op_id: ${record.op_id}`,
    "-m",
    `idempotency_key: ${record.idempotency_key}`,
    "-m",
    `request_hash: ${record.request_hash}`,
  ], root);
  const sideCommit = run("git", ["rev-parse", "HEAD"], root);
  run("git", ["switch", "-q", branch], root);

  const recovered = new LogseqServer({ root, env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" } });
  const intent = recovered.callTool("get_write_intent", { intent_id: opId }).intent;
  assert.equal(intent.state, "pending");
  assert.equal(intent.git_commit, null);
  assert.notEqual(run("git", ["rev-parse", "HEAD"], root), sideCommit);
  assert.equal(recovered.read_page("Alice").properties.status, "active");
  assert.equal(status(root), "");
  recovered.close();
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

test("strict git guard rolls back unexpected intent paths from failed transaction", () => {
  const root = makeGraph();
  const s = server(root, { LOGSEQ_GIT_GUARD: "strict" });
  const txn = new GitTxn(s, "test_guard", 10, 10, () => "txn-test", {}, new Set(["pages/Alice.md"]));
  txn.begin();
  fs.writeFileSync(path.join(root, "pages", "Alice.md"), "type:: person\nstatus:: changed\nlast-contacted:: 2026-05-01\n\n- hello\n", "utf8");
  fs.writeFileSync(path.join(root, "pages", "Unexpected.md"), "type:: note\n\n- outside intent\n", "utf8");
  assert.throws(() => txn.finish(), /unexpected dirty path/);
  assert.match(fs.readFileSync(path.join(root, "pages", "Alice.md"), "utf8"), /status:: active/);
  assert.equal(fs.existsSync(path.join(root, "pages", "Unexpected.md")), false);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("warn git guard does not stage whole repo when no expected paths changed", () => {
  const root = makeGraph();
  const before = run("git", ["rev-parse", "HEAD"], root);
  const s = server(root, { LOGSEQ_GIT_GUARD: "warn" });
  const txn = new GitTxn(s, "test_guard", 10, 10, () => "txn-test", {}, new Set(["pages/Alice.md"]));
  txn.begin();
  fs.writeFileSync(path.join(root, "pages", "Unrelated.md"), "type:: note\n\n- outside intent\n", "utf8");
  txn.finish();
  assert.equal(txn.commit, null);
  assert.match(txn.violation, /unexpected dirty path/);
  assert.equal(run("git", ["rev-parse", "HEAD"], root), before);
  assert.match(status(root), /\?\? pages\/Unrelated\.md/);
  s.close();
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

test("stdio MCP initialize, tools/list, safe write intent call", () => {
  const root = makeGraph();
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const payload = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.1" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "submit_write_intent",
        arguments: {
          idempotency_key: "stdio:update-alice",
          tool: "update_property",
          arguments: { name: "Alice", key: "status", value: "warm" },
          caller: "stdio-test",
        },
      },
    }),
    "",
  ].join("\n");
  const res = spawnSync(process.execPath, [path.join(repo, pkg.bin["logseq-graph-mcp"]), "--root", root], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_GIT_GUARD: "strict", LOGSEQ_WATCH: "0" },
    timeout: 20000,
  });
  assert.equal(res.status, 0, res.stderr);
  const responses = res.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(responses.find((entry) => entry.id === 1).result.serverInfo, {
    name: "logseq-graph-mcp",
    version: pkg.version,
  });
  assert.match(JSON.stringify(responses), /graph_status/);
  assert.match(JSON.stringify(responses), /submit_write_intent/);
  const toolNames = responses.find((entry) => entry.id === 2).result.tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("submit_write_intent"), true);
  assert.equal(toolNames.includes("create_stub"), false);
  assert.match(res.stderr, /write mode = intent/);
  assert.match(JSON.stringify(responses), /structuredContent/);
  assert.match(JSON.stringify(responses), /stdio:update-alice/);
  assert.equal(status(root), "");
  fs.rmSync(root, { recursive: true, force: true });
});

test("stdio MCP legacy protocol omits structured content", () => {
  const root = makeGraph();
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const payload = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "legacy-test", version: "0.1" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_status", arguments: {} } }),
    "",
  ].join("\n");
  const res = spawnSync(process.execPath, [path.join(repo, pkg.bin["logseq-graph-mcp"]), "--root", root, "--readonly"], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, LOGSEQ_ROOT: root, LOGSEQ_WATCH: "0" },
    timeout: 20000,
  });
  assert.equal(res.status, 0, res.stderr);
  const responses = res.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses.find((entry) => entry.id === 1).result.protocolVersion, "2024-11-05");
  const call = responses.find((entry) => entry.id === 2).result;
  assert.equal("structuredContent" in call, false);
  assert.equal(call.isError, false);
  fs.rmSync(root, { recursive: true, force: true });
});
