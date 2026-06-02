import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PersistentGraphCache, fingerprintKey, pageFingerprint } from "./graph/cache.js";
import { isFile, isPathUnder, isSymlink, listMarkdown, mtimeMs, pathExists, readText, relativeGraphPath as rel, stem } from "./graph/files.js";
import { GitGuardError, GitTxn } from "./graph/git-guard.js";
import { FENCE_RE, INLINE_CODE_RE, WIKILINK_RE, extractWikilinkTargets } from "./graph/links.js";
import { SAFE_DATE_RE, fromJournalDate, normalizeNamespaceName, parseIsoDate as parseDate, safePageName, slugifyPageName, toJournalDate } from "./graph/names.js";
import { PROP_RE, joinFrontmatter, propsDelete, propsDict, propsSet, splitFrontmatter } from "./graph/properties.js";
import { GraphWatcher } from "./graph/watch.js";
import { LockHandle, atomicWriteFileSync, lockMetadata, sleepMs, withFileLock } from "./graph/write-guards.js";
import { RAW_MUTATING_TOOL_NAMES, READ_TOOL_NAMES, SAFE_WRITE_TOOL_NAMES, toolDefinitionsForMode } from "./tool-schemas.js";
import { compileSearchRegex, regexEngineName } from "./tools/search.js";
import { packageVersion } from "./package-info.js";
import {
  WriteIntentLedger,
  canonicalizeJson,
  fileSha256,
  nowIso,
  publicRecord,
  sha256,
  type WriteIntentEffect,
  type WriteIntentRecord,
} from "./graph/write-intents.js";
import type { Frontmatter, GraphNode, StatusEntry, ToolDefinition, ToolResult } from "./types.js";

const META_TYPES = new Set(["schema", "query", "runbook", "glossary"]);
const SERVER_WRITE_DEADLINE_MS = 45000;
const RAW_INTENT_TOOLS = new Set(Array.from(RAW_MUTATING_TOOL_NAMES));

function boolEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
}

function uniqueId(): string {
  return Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}

function nowIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function localTimeHHMM(): string {
  return new Date().toTimeString().slice(0, 5);
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start += 1;
  while (end > start && value[end - 1] === "/") end -= 1;
  return value.slice(start, end);
}

function firstWikilinkTarget(value: string): string | null {
  const start = value.indexOf("[[");
  if (start < 0) return null;
  const end = value.indexOf("]]", start + 2);
  if (end < 0) return null;
  return value.slice(start + 2, end).trim();
}

export type LogseqServerOptions = {
  root?: string;
  env?: NodeJS.ProcessEnv;
};

export class LogseqServer {
  readonly root: string;
  readonly pages: string;
  readonly journals: string;
  readonly regen: string;
  readonly schemaFile: string;
  readonly schemaMode: string;
  readonly disallowForce: boolean;
  readonly linkMode: string;
  readonly readonlyMode: boolean;
  readonly writeMode: string;
  readonly maxRegexLen: number;
  readonly regexTimeoutMs: number;
  readonly maxSearchLine: number;
  readonly maxResponseBytes: number;
  readonly gitGuardMode: string;
  readonly gitMaxChangedFiles: number;
  readonly gitMaxDeletedFiles: number;
  readonly gitCommitAuthor: string;
  readonly gitGuardIgnoreDirs: string[];
  readonly lockTimeoutMs: number;
  readonly allowExternalRegen: boolean;
  private slugCache = new Map<string, string>();
  private slugCacheMtime = -2;
  private schemaKeys = new Set<string>();
  private schemaMtime = -2;
  private adjacency: Map<string, GraphNode> | null = null;
  private adjacencyFingerprint = "";
  private readonly persistentCache: PersistentGraphCache;
  private readonly writeLedger: WriteIntentLedger;
  private readonly watcher: GraphWatcher | null;
  private activeWriteIntent: { op_id: string; idempotency_key: string; request_hash: string; expected_paths: Set<string>; effects: WriteIntentEffect[] } | null = null;

  constructor(options: LogseqServerOptions = {}) {
    const env = options.env ?? process.env;
    const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    this.root = path.resolve(options.root ?? env.LOGSEQ_ROOT ?? defaultRoot);
    this.pages = path.join(this.root, "pages");
    this.journals = path.join(this.root, "journals");
    this.regen = path.join(this.root, "scripts", "regenerate_graph_index.py");
    this.schemaFile = path.join(this.pages, "schema___properties.md");
    this.schemaMode = (env.LOGSEQ_VALIDATE_SCHEMA ?? "block").toLowerCase();
    this.disallowForce = boolEnv(env.LOGSEQ_DISALLOW_FORCE);
    this.linkMode = (env.LOGSEQ_VALIDATE_LINKS ?? "block").toLowerCase();
    this.readonlyMode = boolEnv(env.LOGSEQ_READONLY);
    const requestedWriteMode = (env.LOGSEQ_WRITE_MODE ?? "intent").toLowerCase();
    this.writeMode = this.readonlyMode
      ? "readonly"
      : ["readonly", "intent", "admin_raw"].includes(requestedWriteMode)
        ? requestedWriteMode
        : "readonly";
    this.maxRegexLen = Number.parseInt(env.LOGSEQ_MAX_REGEX_LEN ?? "500", 10);
    this.regexTimeoutMs = Math.round(Number.parseFloat(env.LOGSEQ_REGEX_TIMEOUT_S ?? "2") * 1000);
    this.maxSearchLine = Number.parseInt(env.LOGSEQ_MAX_SEARCH_LINE ?? "10000", 10);
    this.maxResponseBytes = Number.parseInt(env.LOGSEQ_MAX_RESPONSE_BYTES ?? "500000", 10);
    this.gitGuardMode = (env.LOGSEQ_GIT_GUARD ?? "strict").toLowerCase();
    this.gitMaxChangedFiles = Number.parseInt(env.LOGSEQ_GIT_MAX_CHANGED_FILES ?? "25", 10);
    this.gitMaxDeletedFiles = Number.parseInt(env.LOGSEQ_GIT_MAX_DELETED_FILES ?? "0", 10);
    this.gitCommitAuthor = env.LOGSEQ_GIT_COMMIT_AUTHOR ?? "Logseq MCP Guard <logseq-mcp@localhost>";
    this.lockTimeoutMs = Number.parseInt(env.LOGSEQ_LOCK_TIMEOUT_MS ?? "5000", 10);
    this.allowExternalRegen = boolEnv(env.LOGSEQ_ALLOW_EXTERNAL_REGEN);
    this.gitGuardIgnoreDirs = (env.LOGSEQ_GIT_GUARD_IGNORE_DIRS ?? "")
      .split(",")
      .map((d) => trimSlashes(d.trim()))
      .filter(Boolean);
    this.persistentCache = new PersistentGraphCache(this.root, env.LOGSEQ_CACHE_DIR);
    this.writeLedger = new WriteIntentLedger(this.persistentCache.cacheFile);
    this.watcher = (env.LOGSEQ_WATCH ?? "1") === "0"
      ? null
      : new GraphWatcher([this.pages, this.journals], () => this.invalidate());
    if (!this.readonlyMode && this.writeMode !== "readonly") this.reconcileWriteIntents();
  }

  toolDefinitions(): ToolDefinition[] {
    return toolDefinitionsForMode(this.writeMode, this.readonlyMode);
  }

  tools(): Record<string, (args: Record<string, unknown>) => ToolResult> {
    const readTools: Record<string, (args: Record<string, unknown>) => ToolResult> = {
      list_pages: (a) => this.list_pages(a),
      read_page: (a) => this.read_page(String(a.name ?? ""), Boolean(a.include_raw)),
      read_pages: (a) => this.read_pages(a),
      read_journal: (a) => this.read_journal(a.date == null ? undefined : String(a.date)),
      search: (a) => this.search(a),
      backlinks: (a) => this.backlinks(a),
      query_pages: (a) => this.query_pages(a),
      graph_status: (a) => this.graph_status(a),
      find_orphans: (a) => this.find_orphans(a),
      find_low_degree: (a) => this.find_low_degree(a),
      find_hubs: (a) => this.find_hubs(a),
      node_degree: (a) => this.node_degree(String(a.name ?? "")),
      graph_stats: (a) => this.graph_stats(a),
      find_components: (a) => this.find_components(a),
      find_dangling_links: (a) => this.find_dangling_links(a),
    };
    if (this.readonlyMode || this.writeMode === "readonly") return readTools;
    const safeTools: Record<string, (args: Record<string, unknown>) => ToolResult> = {
      submit_write_intent: (a) => this.submit_write_intent(a),
      flush_write_intents: (a) => this.flush_write_intents(a),
      get_write_intent: (a) => this.get_write_intent(a),
      list_write_intents: (a) => this.list_write_intents(a),
      cancel_write_intent: (a) => this.cancel_write_intent(a),
    };
    if (this.writeMode !== "admin_raw") return { ...readTools, ...safeTools };
    return {
      ...readTools,
      ...safeTools,
      update_property: (a) => this.update_property(a),
      batch_update_property: (a) => this.batch_update_property(a),
      delete_property: (a) => this.delete_property(String(a.name ?? ""), String(a.key ?? "")),
      append_contact_log: (a) => this.append_contact_log(a),
      append_journal_bullet: (a) => this.append_journal_bullet(a),
      create_stub: (a) => this.create_stub(a),
      rename_page: (a) => this.rename_page(String(a.old_name ?? ""), String(a.new_name ?? ""), a.leave_redirect !== false),
      delete_page: (a) => this.delete_page(String(a.name ?? ""), Boolean(a.force_if_backlinks)),
      update_body_section: (a) => this.update_body_section(a),
      regenerate_index: () => this.regenerate_index(),
    };
  }

  callTool(name: string, args: Record<string, unknown> = {}): ToolResult {
    const tool = this.tools()[name];
    if (!tool) return this.err(`unknown tool: ${name}`);
    try {
      return tool(args);
    } catch (err) {
      return this.err((err as Error).message);
    }
  }

  startupDiagnostics(): string[] {
    const pages = pathExists(this.pages) ? listMarkdown(this.pages).length : 0;
    return [
      `[logseq-mcp] root = ${this.root}`,
      `[logseq-mcp] pages = ${this.pages} (${pages} pages)`,
      `[logseq-mcp] journals = ${this.journals}`,
      `[logseq-mcp] readonly = ${this.readonlyMode ? "True" : "False"}`,
      `[logseq-mcp] write mode = ${this.writeMode}`,
      `[logseq-mcp] schema mode = ${this.schemaMode}`,
      `[logseq-mcp] git guard mode = ${this.gitGuardMode}`,
      `[logseq-mcp] schema keys loaded = ${this.knownSchemaKeys().size}`,
    ];
  }

  private ok(fields: Record<string, unknown> = {}): ToolResult {
    return { ok: true, ...fields };
  }

  private err(message: string, fields: Record<string, unknown> = {}): ToolResult {
    return { ok: false, error: message, ...fields };
  }

  private readonlyErr(tool: string): ToolResult {
    return this.err(`${tool} is disabled because LOGSEQ_READONLY is enabled`, { readonly: true });
  }

  private cap(payload: ToolResult): ToolResult {
    const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (size <= this.maxResponseBytes) return payload;
    return this.err("response too large; narrow the query, lower limits, or disable raw/body fields", {
      response_bytes: size,
      max_response_bytes: this.maxResponseBytes,
    });
  }

  private slugify(name: string): string {
    return slugifyPageName(name);
  }

  private normalizePageName(name: string): string {
    return normalizeNamespaceName(name);
  }

  private safeName(name: string, kind = "page"): string | null {
    return safePageName(name, kind);
  }

  private safeReadName(name: string, kind = "page"): [string | null, string] {
    if (/[\\/]/.test(name) && name.split(/[\\/]+/).some((part) => part === "" || part === "." || part === "..")) {
      return [`${kind} name contains path separator`, ""];
    }
    const normalized = this.normalizePageName(name);
    return [this.safeName(normalized, kind), normalized];
  }

  private safeDate(date: string): string | null {
    if (!SAFE_DATE_RE.test(date)) return `date must be YYYY-MM-DD, got ${JSON.stringify(date)}`;
    if (!parseDate(fromJournalDate(date))) return "invalid date";
    return null;
  }

  private under(p: string, parent: string): boolean {
    return isPathUnder(p, parent);
  }

  private safeGraphFile(p: string, parent: string): boolean {
    try {
      return isFile(p) && this.under(p, parent);
    } catch {
      return false;
    }
  }

  private rejectSymlink(p: string): ToolResult | null {
    return isSymlink(p) ? this.err("symlinks are not editable", { path: p }) : null;
  }

  private withLock<T>(targetPath: string, fn: () => T, timeoutMs = 5000): T {
    return withFileLock(targetPath, timeoutMs === 5000 ? this.lockTimeoutMs : timeoutMs, fn, this.activeWriteIntent?.op_id);
  }

  private atomicWrite(p: string, content: string): void {
    atomicWriteFileSync(p, content, `${process.pid}.${uniqueId()}`);
  }

  private invalidate(): void {
    this.slugCacheMtime = -2;
    this.adjacency = null;
    this.adjacencyFingerprint = "";
    this.persistentCache.invalidate();
    this.persistentCache.flush();
  }

  close(): void {
    this.watcher?.close();
    this.persistentCache.flush();
    this.writeLedger.close();
  }

  private allPagePaths(): string[] {
    const current = mtimeMs(this.pages);
    if (current !== this.slugCacheMtime) {
      const map = new Map<string, string>();
      for (const p of listMarkdown(this.pages)) {
        if (this.safeGraphFile(p, this.pages)) map.set(this.slugify(stem(p)), p);
      }
      this.slugCache = map;
      this.slugCacheMtime = current;
    }
    return Array.from(this.slugCache.values());
  }

  private findPagePath(name: string): string | null {
    this.allPagePaths();
    const found = this.slugCache.get(this.slugify(name));
    if (found && this.safeGraphFile(found, this.pages)) return found;
    this.slugCacheMtime = -2;
    this.allPagePaths();
    return this.slugCache.get(this.slugify(name)) ?? null;
  }

  private splitFrontmatter(text: string): [Frontmatter, string] {
    return splitFrontmatter(text);
  }

  private propsDict(props: Frontmatter): Record<string, string> {
    return propsDict(props);
  }

  private joinFrontmatter(props: Frontmatter, body: string): string {
    return joinFrontmatter(props, body);
  }

  private propsSet(props: Frontmatter, key: string, value: string): Frontmatter {
    return propsSet(props, key, value);
  }

  private propsDelete(props: Frontmatter, key: string): [Frontmatter, string | undefined] {
    return propsDelete(props, key);
  }

  private readFrontmatterOnly(p: string): Record<string, string> {
    if (!this.safeGraphFile(p, this.pages)) return {};
    const fp = pageFingerprint(p);
    if (fp) {
      const cached = this.persistentCache.getFrontmatter(p, fp);
      if (cached) return cached;
    }
    const props: Record<string, string> = {};
    for (const line of readText(p).split(/\r?\n/)) {
      if (line.trim() === "") break;
      const m = PROP_RE.exec(line);
      if (!m) break;
      props[m[1]!] = m[2]!;
    }
    if (fp) {
      this.persistentCache.setFrontmatter(p, fp, props);
      this.persistentCache.flush();
    }
    return props;
  }

  private knownSchemaKeys(): Set<string> {
    const mt = mtimeMs(this.schemaFile);
    if (mt === this.schemaMtime) return this.schemaKeys;
    if (!pathExists(this.schemaFile)) {
      this.schemaKeys = new Set();
      this.schemaMtime = mt;
      return this.schemaKeys;
    }
    const text = readText(this.schemaFile);
    const keys = new Set<string>();
    for (const m of text.matchAll(/`([a-zA-Z][\w-]*)::/g)) keys.add(m[1]!);
    for (const m of text.matchAll(/^\s*-\s+\*\*([a-zA-Z][\w-]*)::\*\*/gm)) keys.add(m[1]!);
    this.schemaKeys = keys;
    this.schemaMtime = mt;
    return keys;
  }

  private checkSchema(key: string, force: boolean): [boolean, string | null, boolean] {
    if (this.schemaMode === "off") return [true, null, false];
    const keys = this.knownSchemaKeys();
    if (keys.size === 0 || keys.has(key)) return [true, null, false];
    const msg = `property key ${JSON.stringify(key)} not in schema (pages/schema___properties.md). Known keys near this one: ${Array.from(keys).sort().slice(0, 6).join(", ")}`;
    if (this.schemaMode === "block" && !force) return [false, msg, false];
    if (this.schemaMode === "block" && force) {
      if (this.disallowForce) return [false, `${msg} (force is disabled by LOGSEQ_DISALLOW_FORCE)`, false];
      return [true, msg, true];
    }
    return [true, msg, false];
  }

  private extractWikilinkTargets(text: string): string[] {
    return extractWikilinkTargets(text, (name) => this.slugify(name));
  }

  private wikilinkTargetExists(slug: string): boolean {
    this.allPagePaths();
    if (this.slugCache.has(slug)) return true;
    if (slug.includes("/") && this.slugCache.has(slug.replaceAll("/", "___"))) return true;
    if (SAFE_DATE_RE.test(slug)) {
      const jpath = path.join(this.journals, `${slug.replaceAll("-", "_")}.md`);
      return pathExists(jpath) && this.safeGraphFile(jpath, this.journals);
    }
    return false;
  }

  private checkLinksResolve(text: string, allowDangling: boolean): [boolean, string | null, string[]] {
    if (this.linkMode === "off" || !text) return [true, null, []];
    const dangling = this.extractWikilinkTargets(text).filter((target) => !this.wikilinkTargetExists(target));
    if (dangling.length === 0) return [true, null, []];
    const msg = `introduces ${dangling.length} dangling wikilink(s); create stubs first or pass allow_dangling=True. Targets: ${JSON.stringify(dangling.slice(0, 5))}${dangling.length > 5 ? ` (+${dangling.length - 5} more)` : ""}`;
    if (this.linkMode === "block" && !allowDangling) return [false, msg, dangling];
    return [true, msg, dangling];
  }

  private audit(line: string): void {
    const safeLine = line.replace(/[\r\n\t\x00-\x1f]/g, " ").slice(0, 500);
    const plannedAuditRel = this.activeWriteIntent?.effects.find((effect) => effect.effect_type === "audit_journal")?.path ?? null;
    const jpath = plannedAuditRel ? path.join(this.root, plannedAuditRel) : path.join(this.journals, `${toJournalDate(nowIsoDate())}.md`);
    const stamp = `\t- ${localTimeHHMM()} · ${safeLine}\n`;
    try {
      fs.mkdirSync(path.dirname(jpath), { recursive: true });
      this.withLock(jpath, () => {
        if (pathExists(jpath)) {
          let text = readText(jpath);
          if (text.includes("## Agent activity")) text = text.replace(/(## Agent activity\n)/, `$1${stamp}`);
          else text = `${text}${text.endsWith("\n") ? "" : "\n"}- ## Agent activity\n${stamp}`;
          this.atomicWrite(jpath, text);
        } else {
          this.atomicWrite(jpath, `- ## Agent activity\n${stamp}`);
        }
      });
    } catch (err) {
      console.error(`[logseq-mcp] audit warning: ${(err as Error).message}`);
    }
  }

  private git(args: string[], timeoutMs = 30000): { status: number | null; stdout: string; stderr: string } {
    const command = args[0];
    const allowed = new Set(["rev-parse", "log", "status", "add", "commit", "reset", "restore", "clean"]);
    if (!command || !allowed.has(command)) {
      throw new GitGuardError(`git subcommand is not allowed: ${command ?? ""}`);
    }
    if (args.some((arg) => arg.includes("\0"))) {
      throw new GitGuardError("git argument contains NUL byte");
    }
    const r = spawnSync("git", args, { cwd: this.root, encoding: "utf8", timeout: timeoutMs, shell: false });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  gitOk(args: string[], timeoutMs = 30000): string {
    const r = this.git(args, timeoutMs);
    if (r.status !== 0) {
      throw new GitGuardError(`git ${args.join(" ")} failed`, {
        returncode: r.status,
        stdout: r.stdout.trim(),
        stderr: r.stderr.trim(),
      });
    }
    return r.stdout.trim();
  }

  gitInsideWorktree(): boolean {
    const r = this.git(["rev-parse", "--is-inside-work-tree"], 10000);
    return r.status === 0 && r.stdout.trim() === "true";
  }

  gitHead(): string {
    const r = this.git(["rev-parse", "HEAD"], 10000);
    return r.status === 0 ? r.stdout.trim() : "";
  }

  private gitRecentCommits(limit = 5): Array<Record<string, string>> {
    const r = this.git(["log", `-${Math.max(1, Math.min(limit, 20))}`, "--date=iso-strict", "--format=%H%x1f%ad%x1f%s"], 20000);
    if (r.status !== 0) return [];
    return r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [commit, date, subject] = line.split("\x1f");
      return { commit: commit ?? "", date: date ?? "", subject: subject ?? "" };
    });
  }

  private gitGuardIgnoredPath(p: string): boolean {
    const norm = p.replaceAll("\\", "/").replace(/^\/+/, "");
    if (this.gitGuardIgnoreDirs.some((d) => norm === d || norm.startsWith(`${d}/`))) return true;
    return p === ".mcp-git-guard.lock"
      || p.endsWith(".md.lock")
      || `/${p}`.includes("/__pycache__/")
      || [".pyc", ".pyo", ".pyd"].some((s) => p.endsWith(s));
  }

  private lockHealth(limit = 20): Record<string, unknown> {
    const gitLock = path.join(this.root, ".mcp-git-guard.lock");
    const pageLocks: Array<Record<string, unknown>> = [];
    for (const base of [this.pages, this.journals]) {
      if (!pathExists(base)) continue;
      for (const p of this.findLockFiles(base, limit - pageLocks.length)) {
        pageLocks.push(this.describeLock(p));
        if (pageLocks.length >= limit) break;
      }
      if (pageLocks.length >= limit) break;
    }
    return {
      git_guard: pathExists(gitLock) ? this.describeLock(gitLock) : { exists: false, path: rel(this.root, gitLock) },
      file_locks: pageLocks,
      file_lock_count_sampled: pageLocks.length,
    };
  }

  private findLockFiles(dir: string, limit: number): string[] {
    if (limit <= 0) return [];
    const found: string[] = [];
    const walk = (current: string) => {
      if (found.length >= limit) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".lock")) found.push(full);
        if (found.length >= limit) return;
      }
    };
    walk(dir);
    return found;
  }

  private describeLock(lockPath: string): Record<string, unknown> {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(lockPath);
    } catch {
      return { exists: false, path: rel(this.root, lockPath) };
    }
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readText(lockPath));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    const pid = Number(metadata.pid ?? 0);
    const processAlive = pid > 0 ? this.processAlive(pid) : null;
    const expiresAt = typeof metadata.expires_at === "string" ? metadata.expires_at : null;
    const stale = expiresAt ? Date.parse(expiresAt) < Date.now() && processAlive === false : false;
    return {
      exists: true,
      path: rel(this.root, lockPath),
      mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
      age_seconds: stat ? Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)) : null,
      metadata,
      process_alive: processAlive,
      stale,
    };
  }

  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  gitStatusEntries(): StatusEntry[] {
    const r = this.git(["status", "--porcelain=v1", "--untracked-files=all", "-z"], 20000);
    if (r.status !== 0) {
      throw new GitGuardError("git status failed", {
        returncode: r.status,
        stdout: r.stdout.trim(),
        stderr: r.stderr.trim(),
      });
    }
    if (!r.stdout) return [];
    const parts = r.stdout.split("\0");
    const entries: StatusEntry[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const item = parts[i];
      if (!item) continue;
      const status = item.slice(0, 2);
      let filePath = item.slice(3);
      let oldPath = "";
      if (status.includes("R") || status.includes("C")) {
        i += 1;
        oldPath = filePath;
        filePath = parts[i] ?? "";
      }
      if (!this.gitGuardIgnoredPath(filePath)) entries.push({ status, path: filePath, old_path: oldPath });
    }
    return entries;
  }

  statusSummary(entries: StatusEntry[], limit = 12): string[] {
    return entries.slice(0, limit).map((e) => `${e.status} ${e.path}`);
  }

  private beginTxn(tool: string, maxChangedFiles = this.gitMaxChangedFiles, maxDeletedFiles = this.gitMaxDeletedFiles): GitTxn {
    const metadata: Record<string, string> = this.activeWriteIntent
      ? {
        op_id: this.activeWriteIntent.op_id,
        idempotency_key: this.activeWriteIntent.idempotency_key,
        request_hash: this.activeWriteIntent.request_hash,
      }
      : {};
    const txn = new GitTxn(this, tool, maxChangedFiles, maxDeletedFiles, uniqueId, metadata, this.activeWriteIntent?.expected_paths ?? null);
    txn.begin();
    return txn;
  }

  private attachGit(response: ToolResult, txn: GitTxn): ToolResult {
    if (txn.commit) response.git_guard = txn.payload();
    return response;
  }

  submit_write_intent(args: Record<string, unknown>): ToolResult {
    const idempotencyKey = String(args.idempotency_key ?? "").trim();
    const tool = String(args.tool ?? "").trim();
    const caller = String(args.caller ?? "unknown").trim() || "unknown";
    const expectedBaseHead = args.expected_base_head == null ? null : String(args.expected_base_head);
    const expiresAt = args.expires_at == null ? null : String(args.expires_at);
    const rawArguments = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? args.arguments as Record<string, unknown>
      : null;
    if (!idempotencyKey) return this.err("idempotency_key is required");
    if (!RAW_INTENT_TOOLS.has(tool)) return this.err(`tool must be one of ${JSON.stringify(Array.from(RAW_INTENT_TOOLS).sort())}`);
    if (!rawArguments) return this.err("arguments must be an object");
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) return this.err("expires_at must be an ISO timestamp");
    const normalized = this.normalizeWriteIntentArgs(tool, rawArguments);
    if (!normalized.ok) return normalized;
    const canonicalArgs = normalized.arguments as Record<string, unknown>;
    const validation = this.validateWriteIntent(tool, canonicalArgs);
    if (!validation.ok) return validation;
    const preview = validation.preview as Record<string, unknown>;
    const effects = validation.effects as WriteIntentEffect[];
    const submitted = this.writeLedger.submit({
      idempotencyKey,
      tool,
      canonicalArgs,
      caller,
      expectedBaseHead,
      expiresAt,
      gitBeforeHead: this.gitInsideWorktree() ? this.gitHead() : "",
      effects,
      preview,
    });
    if (submitted.conflict) {
      return this.err("idempotency_conflict: same idempotency_key was used with different arguments", {
        error_class: "idempotency_conflict",
        intent: publicRecord(submitted.record),
      });
    }
    return this.ok({ intent: publicRecord(submitted.record), duplicate: submitted.duplicate, preview: submitted.preview });
  }

  get_write_intent(args: Record<string, unknown>): ToolResult {
    this.reconcileWriteIntents();
    const intentId = String(args.intent_id ?? "");
    if (!intentId) return this.err("intent_id is required");
    const record = this.writeLedger.get(intentId);
    if (!record) return this.err(`write intent not found: ${intentId}`);
    return this.ok({ intent: publicRecord(record), effects: this.writeLedger.effects(intentId) });
  }

  list_write_intents(args: Record<string, unknown>): ToolResult {
    this.reconcileWriteIntents();
    const states = Array.isArray(args.states) ? args.states.map(String).filter(Boolean) : [];
    const limit = Number(args.limit ?? 50);
    const offset = Number(args.offset ?? 0);
    const records = this.writeLedger.list(states, limit, offset);
    return this.ok({ intents: records.map(publicRecord), count: records.length, ledger: { file: this.writeLedger.ledgerFile, counts: this.writeLedger.counts() } });
  }

  cancel_write_intent(args: Record<string, unknown>): ToolResult {
    this.reconcileWriteIntents();
    const intentId = String(args.intent_id ?? "");
    if (!intentId) return this.err("intent_id is required");
    return this.writeLedger.cancel(intentId, String(args.caller ?? "unknown"));
  }

  flush_write_intents(args: Record<string, unknown>): ToolResult {
    this.reconcileWriteIntents();
    const intentIds = Array.isArray(args.intent_ids) ? args.intent_ids.map(String).filter(Boolean) : [];
    const maxItems = Math.max(1, Math.min(Number(args.max_items ?? (intentIds.length || 1)), 100));
    if (!intentIds.length) return this.err("intent_ids is required and must not be empty");
    const selected = intentIds.slice(0, maxItems);
    const results: Array<Record<string, unknown>> = [];
    let success = 0;
    for (const intentId of selected) {
      const record = this.writeLedger.get(intentId);
      if (!record) {
        results.push({ intent_id: intentId, ok: false, state: "missing", error: "write intent not found" });
        continue;
      }
      const result = this.flushOneWriteIntent(record);
      results.push(result);
      if (result.ok) success += 1;
    }
    return this.ok({ results, success_count: success, failure_count: results.length - success, total: results.length });
  }

  private normalizeWriteIntentArgs(tool: string, args: Record<string, unknown>): ToolResult {
    const out: Record<string, unknown> = { ...args };
    if (tool === "append_contact_log" && out.date == null) out.date = nowIsoDate();
    if (tool === "append_journal_bullet" && out.date == null) out.date = nowIsoDate();
    if (tool === "update_body_section" && out.mode == null) out.mode = "replace_block";
    if (tool === "create_stub") {
      if (out.page_type == null) out.page_type = "person";
      if (out.confidence == null) out.confidence = "low";
    }
    if (tool === "rename_page" && out.leave_redirect == null) out.leave_redirect = true;
    return this.ok({ arguments: JSON.parse(canonicalizeJson(out)) });
  }

  private validateWriteIntent(tool: string, args: Record<string, unknown>): ToolResult {
    const effects: WriteIntentEffect[] = [];
    const targetPaths: string[] = [];
    const target = (filePath: string, effectType: string, marker?: string | null) => {
      targetPaths.push(filePath);
      effects.push({
        path: rel(this.root, filePath),
        effect_type: effectType,
        before_hash: fileSha256(filePath),
        expected_base_hash: fileSha256(filePath),
        applied_marker: marker ?? null,
      });
    };
    const targetAudit = () => {
      const p = path.join(this.journals, `${toJournalDate(nowIsoDate())}.md`);
      target(p, "audit_journal");
    };
    if (tool === "regenerate_index") {
      target(path.join(this.root, "generated", "graph_index.json"), "regenerate_index");
      return this.ok({ preview: { tool, target_paths: targetPaths.map((p) => rel(this.root, p)) }, effects });
    }
    if (tool === "update_property") {
      const name = String(args.name ?? "");
      const key = String(args.key ?? "");
      const value = String(args.value ?? "");
      const [pageErr, p] = this.readWritePage(name);
      if (pageErr) return pageErr;
      if (!key) return this.err("key is required");
      const [allowed, schemaMsg] = this.checkSchema(key, Boolean(args.force));
      if (!allowed) return this.err(schemaMsg!);
      const [linkOk, linkMsg, dangling] = this.checkLinksResolve(value, Boolean(args.allow_dangling));
      if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
      target(p, "update_property", `${key}:: ${value}`);
      targetAudit();
      return this.ok({ preview: { tool, name: stem(p), key, to: value, target_paths: [rel(this.root, p)] }, effects });
    }
    if (tool === "batch_update_property") {
      const updates = Array.isArray(args.updates) ? args.updates as Array<Record<string, unknown>> : [];
      if (!updates.length) return this.err("updates must not be empty");
      const seenTargets = new Set<string>();
      for (const update of updates) {
        const name = String(update.name ?? "");
        const key = String(update.key ?? "");
        const value = String(update.value ?? "");
        const [pageErr, p] = this.readWritePage(name);
        if (pageErr) return pageErr;
        if (!key) return this.err("key is required");
        const duplicateKey = `${rel(this.root, p)}\0${key}`;
        if (seenTargets.has(duplicateKey)) return this.err(`duplicate batch update target: ${stem(p)} ${key}`);
        seenTargets.add(duplicateKey);
        const [allowed, schemaMsg] = this.checkSchema(key, Boolean(args.force));
        if (!allowed) return this.err(schemaMsg!);
        const [linkOk, linkMsg, dangling] = this.checkLinksResolve(value, Boolean(update.allow_dangling ?? args.allow_dangling));
        if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
        target(p, "batch_update_property", `${key}:: ${value}`);
      }
      targetAudit();
      return this.ok({ preview: { tool, update_count: updates.length, target_paths: targetPaths.map((p) => rel(this.root, p)) }, effects });
    }
    if (tool === "delete_property") {
      const [pageErr, p] = this.readWritePage(String(args.name ?? ""));
      if (pageErr) return pageErr;
      const key = String(args.key ?? "");
      if (!key) return this.err("key is required");
      target(p, "delete_property", key);
      targetAudit();
      return this.ok({ preview: { tool, name: stem(p), key, target_paths: [rel(this.root, p)] }, effects });
    }
    if (tool === "append_contact_log") {
      const name = String(args.name ?? "");
      const medium = String(args.medium ?? "");
      const summary = String(args.summary ?? "");
      if (!medium || !summary) return this.err("medium and summary are required");
      if (!parseDate(String(args.date))) return this.err(`invalid date ${JSON.stringify(args.date)}, expected YYYY-MM-DD`);
      const [linkOk, linkMsg, dangling] = this.checkLinksResolve(summary, Boolean(args.allow_dangling));
      if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
      const [pageErr, p] = this.readWritePage(name);
      if (pageErr) return pageErr;
      target(p, "append_contact_log", this.expectedAppendMarker(tool, args));
      targetAudit();
      return this.ok({ preview: { tool, name: stem(p), bullet: this.expectedAppendMarker(tool, args), target_paths: [rel(this.root, p)] }, effects });
    }
    if (tool === "append_journal_bullet") {
      const content = String(args.content ?? "");
      if (!content) return this.err("content is required");
      if (args.date != null) {
        const err = this.safeDate(String(args.date));
        if (err) return this.err(err);
      }
      const [linkOk, linkMsg, dangling] = this.checkLinksResolve(content, Boolean(args.allow_dangling));
      if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
      const date = toJournalDate(String(args.date));
      const p = path.join(this.journals, `${date}.md`);
      if (!this.under(p, this.journals)) return this.err("journal path escapes JOURNALS dir");
      const sl = this.rejectSymlink(p);
      if (sl) return sl;
      target(p, "append_journal_bullet", this.expectedAppendMarker(tool, args));
      targetAudit();
      return this.ok({ preview: { tool, date: fromJournalDate(date), bullet: this.expectedAppendMarker(tool, args), target_paths: [rel(this.root, p)] }, effects });
    }
    if (tool === "create_stub") {
      const name = String(args.name ?? "");
      const safe = this.safeName(name);
      if (safe) return this.err(safe);
      if (this.findPagePath(name)) return this.err(`Page already exists: ${name}`);
      const pageType = String(args.page_type ?? "person");
      let props: Frontmatter = [["type", pageType], ["confidence", String(args.confidence ?? "low")]];
      if (args.source != null) props.push(["source", String(args.source)]);
      if (args.properties && typeof args.properties === "object" && !Array.isArray(args.properties)) {
        for (const [k, v] of Object.entries(args.properties as Record<string, unknown>)) props = this.propsSet(props, k, String(v));
      }
      for (const [k] of props) {
        const [ok, msg] = this.checkSchema(k, Boolean(args.force));
        if (!ok) return this.err(msg!);
      }
      const notes = Array.isArray(args.notes) ? args.notes.map(String) : [];
      if (pageType !== "redirect") {
        const bundle = [args.source == null ? "" : String(args.source), ...Object.values((args.properties ?? {}) as Record<string, unknown>).map(String), ...notes].join("\n");
        const [linkOk, linkMsg, dangling] = this.checkLinksResolve(bundle, Boolean(args.allow_dangling));
        if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
      }
      const p = path.join(this.pages, `${name}.md`);
      target(p, "create_stub", `type:: ${String(args.page_type ?? "person")}`);
      targetAudit();
      return this.ok({ preview: { tool, name, target_paths: [rel(this.root, p)] }, effects });
    }
    if (tool === "rename_page") {
      const [pageErr, p] = this.readWritePage(String(args.old_name ?? ""));
      if (pageErr) return pageErr;
      const newName = String(args.new_name ?? "");
      const safe = this.safeName(newName, "new_name");
      if (safe) return this.err(safe);
      const dst = path.join(this.pages, `${newName}.md`);
      if (!this.under(dst, this.pages)) return this.err("destination path escapes PAGES dir");
      if (pathExists(dst) && fs.realpathSync.native(dst) !== fs.realpathSync.native(p)) return this.err(`Destination exists: ${newName}`);
      if (this.isUnsafeCaseOnlyRename(p, dst)) {
        return this.err("case-only rename on case-insensitive filesystem is unsafe; rename to a different intermediate first, then to the desired case");
      }
      target(p, "rename_page_source", String(args.new_name ?? ""));
      target(dst, "rename_page_destination", readText(p).slice(0, 200));
      targetAudit();
      return this.ok({ preview: { tool, old_name: stem(p), new_name: newName, target_paths: targetPaths.map((x) => rel(this.root, x)) }, effects });
    }
    if (tool === "delete_page") {
      const [pageErr, p] = this.readWritePage(String(args.name ?? ""));
      if (pageErr) return pageErr;
      if (fs.realpathSync.native(p) === fs.realpathSync.native(this.schemaFile)) return this.err("cannot delete schema page");
      const bl = this.backlinks({ name: stem(p), include_aliases: false, mode: "summary", limit: 1000 });
      const backlinkCount = bl.ok ? Number(bl.count ?? 0) : 0;
      if (backlinkCount > 0 && !args.force_if_backlinks) {
        return this.err(`page has ${backlinkCount} backlinks; pass force_if_backlinks=True to delete anyway or rename_page with a redirect instead`, { backlink_count: backlinkCount });
      }
      const now = new Date();
      const archiveDir = path.join(this.root, "archive", String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"));
      let archivePath = path.join(archiveDir, path.basename(p));
      while (pathExists(archivePath)) archivePath = path.join(archiveDir, `${stem(p)}.${uniqueId().slice(0, 8)}.md`);
      if (!this.under(archivePath, path.join(this.root, "archive"))) return this.err("archive path escapes archive dir");
      target(p, "delete_page", stem(p));
      target(archivePath, "delete_page_archive", readText(p).slice(0, 200));
      targetAudit();
      return this.ok({ preview: { tool, name: stem(p), target_paths: targetPaths.map((x) => rel(this.root, x)) }, effects });
    }
    if (tool === "update_body_section") {
      const [pageErr, p] = this.readWritePage(String(args.name ?? ""));
      if (pageErr) return pageErr;
      const anchor = String(args.anchor ?? "");
      const mode = String(args.mode ?? "replace_block");
      const valid = new Set(["replace_block", "append_to_section", "prepend_to_section", "delete_block"]);
      if (!anchor) return this.err("anchor is required");
      if (!valid.has(mode)) return this.err(`mode must be one of ${JSON.stringify(Array.from(valid).sort())}, got ${JSON.stringify(mode)}`);
      let newContent = args.new_content == null ? undefined : String(args.new_content);
      if (mode === "delete_block") {
        if (newContent != null && newContent !== "") return this.err("new_content must be omitted or empty for mode='delete_block'");
        newContent = "";
      } else {
        if (newContent == null) return this.err(`new_content is required for mode=${JSON.stringify(mode)}`);
        const [linkOk, linkMsg, dangling] = this.checkLinksResolve(newContent, Boolean(args.allow_dangling));
        if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
      }
      target(p, "update_body_section", newContent);
      targetAudit();
      return this.ok({ preview: { tool, name: stem(p), mode, anchor, target_paths: [rel(this.root, p)] }, effects });
    }
    return this.err(`unsupported write intent tool: ${tool}`);
  }

  private flushOneWriteIntent(record: WriteIntentRecord): Record<string, unknown> {
    if (record.state === "completed") return { ok: true, intent_id: record.op_id, state: record.state, intent: publicRecord(record), duplicate: true };
    if (!["pending", "failed_retryable"].includes(record.state)) {
      return { ok: false, intent_id: record.op_id, state: record.state, error: `cannot flush write intent in state ${record.state}` };
    }
    if (record.expires_at && Date.parse(record.expires_at) < Date.now()) {
      const next = this.writeLedger.markTerminal(record, "expired", "write intent expired before flush");
      return { ok: false, intent_id: record.op_id, state: next.state, error: next.last_error };
    }
    const args = JSON.parse(record.canonical_args_json) as Record<string, unknown>;
    const already = this.intentAlreadyApplied(record.tool, args);
    if (already.ok) {
      const next = this.writeLedger.markCompleted(record, this.ok({ reconciled: true, already_applied: true, result: already }), null, true);
      return { ok: true, intent_id: record.op_id, state: next.state, reconciled: true, intent: publicRecord(next) };
    }
    if (record.expected_base_head && this.gitInsideWorktree() && this.gitHead() !== record.expected_base_head) {
      const next = this.writeLedger.markManual(record, "expected_base_head no longer matches graph HEAD", { current_head: this.gitHead() });
      return { ok: false, intent_id: record.op_id, state: next.state, error: next.manual_reason };
    }
    const precondition = this.checkIntentPreconditions(record);
    if (!precondition.ok) {
      const next = this.writeLedger.markManual(record, String(precondition.error), precondition);
      return { ok: false, intent_id: record.op_id, state: next.state, error: next.manual_reason };
    }
    const claim = this.writeLedger.claimForFlush(record, SERVER_WRITE_DEADLINE_MS);
    if (!claim.claimed) {
      const latest = claim.record;
      if (latest.state === "completed") return { ok: true, intent_id: latest.op_id, state: latest.state, intent: publicRecord(latest), duplicate: true };
      return { ok: false, intent_id: latest.op_id, state: latest.state, error: `write intent is already ${latest.state}` };
    }
    let applying = claim.record;
    const effectsBefore = this.writeLedger.effects(record.op_id);
    this.activeWriteIntent = { op_id: record.op_id, idempotency_key: record.idempotency_key, request_hash: record.request_hash, expected_paths: this.intentExpectedPaths(record, effectsBefore), effects: effectsBefore };
    let result: ToolResult;
    try {
      result = this.executeRawWriteTool(record.tool, args);
    } finally {
      this.activeWriteIntent = null;
    }
    const commit = this.gitGuardCommit(result);
    if (!result.ok) {
      if (commit) {
        const effectsAfter = effectsBefore.map((effect) => ({ ...effect, after_hash: fileSha256(path.join(this.root, effect.path)) }));
        applying = this.writeLedger.markAppliedUncommitted(applying, effectsAfter);
        const completed = this.writeLedger.markCompleted(applying, result, commit);
        return {
          ok: false,
          intent_id: record.op_id,
          state: completed.state,
          intent: publicRecord(completed),
          committed: true,
          error: String(result.error ?? "write completed with partial failures"),
          result,
        };
      }
      const errorClass = this.classifyWriteError(String(result.error ?? ""));
      const next = errorClass.retryable
        ? this.writeLedger.markRetryable(applying, errorClass.name, String(result.error ?? "write failed"))
        : this.writeLedger.markManual(applying, String(result.error ?? "write failed"), result);
      return { ok: false, intent_id: record.op_id, state: next.state, error_class: next.last_error_class, error: next.last_error ?? next.manual_reason, result };
    }
    const effectsAfter = effectsBefore.map((effect) => ({ ...effect, after_hash: fileSha256(path.join(this.root, effect.path)) }));
    applying = this.writeLedger.markAppliedUncommitted(applying, effectsAfter);
    const completed = this.writeLedger.markCompleted(applying, result, commit || null);
    return { ok: true, intent_id: record.op_id, state: completed.state, intent: publicRecord(completed), result };
  }

  private gitGuardCommit(result: ToolResult): string | null {
    if (typeof result.git_guard !== "object" || !result.git_guard || !("commit" in result.git_guard)) return null;
    const commit = String((result.git_guard as Record<string, unknown>).commit ?? "");
    return commit || null;
  }

  private reconcileWriteIntents(): void {
    const expired = this.writeLedger.recoverExpired();
    const reconciling = [
      ...expired,
      ...this.writeLedger.list(["reconciling"], 200, 0).filter((record) => !expired.some((e) => e.op_id === record.op_id)),
    ];
    for (const record of reconciling) {
      try {
        this.reconcileOneWriteIntent(record);
      } catch (err) {
        const latest = this.writeLedger.get(record.op_id) ?? record;
        this.writeLedger.markManual(latest, `reconciliation failed: ${(err as Error).message}`, {});
      }
    }
  }

  private reconcileOneWriteIntent(record: WriteIntentRecord): void {
    const latest = this.writeLedger.get(record.op_id) ?? record;
    const commit = this.findIntentCommit(latest);
    if (commit) {
      this.writeLedger.markCompleted(latest, this.ok({ reconciled: true, git_commit: commit }), commit, true);
      return;
    }

    const args = JSON.parse(latest.canonical_args_json) as Record<string, unknown>;
    const already = this.intentAlreadyApplied(latest.tool, args);
    const effects = this.writeLedger.effects(latest.op_id);
    const allAtBase = effects.every((effect) => fileSha256(path.join(this.root, effect.path)) === effect.expected_base_hash);
    if (allAtBase && latest.state === "reconciling") {
      this.writeLedger.markPending(latest, "reconciled_no_file_effects", {});
      return;
    }

    const dirty = this.gitInsideWorktree() ? this.gitStatusEntries() : [];
    const expectedPaths = new Set(effects.map((effect) => effect.path));
    const dirtyPaths = Array.from(new Set(dirty.flatMap((entry) => [entry.path, entry.old_path]).filter(Boolean)));
    const unexpectedDirty = dirtyPaths.filter((p) => !expectedPaths.has(p));
    if (unexpectedDirty.length) {
      this.writeLedger.markManual(latest, "unexpected dirty paths during reconciliation", { unexpected_dirty_paths: unexpectedDirty.slice(0, 20) });
      return;
    }

    if (dirtyPaths.length && this.recoveryEffectsMatch(latest, args, effects, already)) {
      const commitHash = this.commitRecoveredIntent(latest, dirtyPaths);
      this.writeLedger.markCompleted(latest, this.ok({ reconciled: true, git_commit: commitHash, committed_paths: dirtyPaths }), commitHash, true);
      return;
    }

    if (already.ok) {
      this.writeLedger.markCompleted(latest, this.ok({ reconciled: true, already_applied: true, result: already }), null, true);
      return;
    }

    this.writeLedger.markManual(latest, "unable to reconcile expired write intent", { dirty_paths: dirtyPaths, effects });
  }

  private recoveryEffectsMatch(record: WriteIntentRecord, args: Record<string, unknown>, effects: WriteIntentEffect[], already: ToolResult): boolean {
    if (record.tool === "regenerate_index") return effects.every((effect) => effect.path === "generated/graph_index.json" && fileSha256(path.join(this.root, effect.path)) !== effect.expected_base_hash);
    if (already.ok) return true;
    if (record.tool === "delete_page") {
      const source = effects.find((effect) => effect.effect_type === "delete_page");
      const archive = effects.find((effect) => effect.effect_type === "delete_page_archive");
      return Boolean(source && archive && fileSha256(path.join(this.root, source.path)) === null && fileSha256(path.join(this.root, archive.path)) === source.expected_base_hash);
    }
    if (record.tool === "rename_page" && args.leave_redirect === false) {
      const source = effects.find((effect) => effect.effect_type === "rename_page_source");
      const destination = effects.find((effect) => effect.effect_type === "rename_page_destination");
      return Boolean(source && destination && fileSha256(path.join(this.root, source.path)) === null && fileSha256(path.join(this.root, destination.path)) === source.expected_base_hash);
    }
    const markerEffects = effects.filter((effect) => effect.applied_marker);
    return markerEffects.length > 0 && markerEffects.every((effect) => this.effectMarkerExists(effect));
  }

  private findIntentCommit(record: WriteIntentRecord): string | null {
    if (!this.gitInsideWorktree()) return null;
    let log = "";
    try {
      log = this.gitOk(["log", "HEAD", "-n", "200", "--format=%H%x1f%B%x1e"], 60000);
    } catch {
      return null;
    }
    for (const entry of log.split("\x1e")) {
      if (!entry.trim()) continue;
      const sep = entry.indexOf("\x1f");
      const commit = sep >= 0 ? entry.slice(0, sep).trim() : "";
      const body = sep >= 0 ? entry.slice(sep + 1) : entry;
      if (
        commit
        && body.includes(`op_id: ${record.op_id}`)
        && body.includes(`idempotency_key: ${record.idempotency_key}`)
        && body.includes(`request_hash: ${record.request_hash}`)
      ) {
        return commit;
      }
    }
    return null;
  }

  private commitRecoveredIntent(record: WriteIntentRecord, paths: string[]): string {
    if (!this.gitInsideWorktree()) throw new Error("cannot reconcile commit outside a Git worktree");
    const lock = this.acquireGitGuardLock(record.op_id);
    try {
      const dirty = this.gitStatusEntries();
      const expected = new Set(paths);
      const currentPaths = Array.from(new Set(dirty.flatMap((entry) => [entry.path, entry.old_path]).filter(Boolean))).sort();
      const unexpected = currentPaths.filter((p) => !expected.has(p));
      if (unexpected.length) throw new Error(`unexpected dirty paths during recovery commit: ${unexpected.join(", ")}`);
      this.gitOk(["add", "-A", "--", ...currentPaths], 60000);
      const subject = `mcp-logseq: recover ${record.tool} ${record.op_id.slice(0, 12)}`;
      this.gitOk([
        "commit",
        "--author",
        this.gitCommitAuthor,
        "-m",
        subject,
        "-m",
        `tool: ${record.tool}`,
        "-m",
        `op_id: ${record.op_id}`,
        "-m",
        `idempotency_key: ${record.idempotency_key}`,
        "-m",
        `request_hash: ${record.request_hash}`,
        "-m",
        `before_head: ${record.git_before_head ?? ""}`,
        "-m",
        `reconciled: true`,
        "--",
        ...currentPaths,
      ], 60000);
      return this.gitHead();
    } finally {
      lock.release();
    }
  }

  private acquireGitGuardLock(opId: string): LockHandle {
    const lockPath = path.join(this.root, ".mcp-git-guard.lock");
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const fd = fs.openSync(lockPath, "wx", 0o644);
        fs.writeFileSync(fd, `${JSON.stringify(lockMetadata(this.root, this.lockTimeoutMs, opId), null, 2)}\n`, "utf8");
        return new LockHandle(lockPath, fd);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > deadline) throw err;
        sleepMs(50);
      }
    }
  }

  private executeRawWriteTool(tool: string, args: Record<string, unknown>): ToolResult {
    switch (tool) {
      case "update_property": return this.update_property(args);
      case "batch_update_property": return this.batch_update_property(args);
      case "delete_property": return this.delete_property(String(args.name ?? ""), String(args.key ?? ""));
      case "append_contact_log": return this.append_contact_log(args);
      case "append_journal_bullet": return this.append_journal_bullet(args);
      case "create_stub": return this.create_stub(args);
      case "rename_page": return this.rename_page(String(args.old_name ?? ""), String(args.new_name ?? ""), args.leave_redirect !== false);
      case "delete_page": return this.delete_page(String(args.name ?? ""), Boolean(args.force_if_backlinks));
      case "update_body_section": return this.update_body_section(args);
      case "regenerate_index": return this.regenerate_index();
      default: return this.err(`unsupported write intent tool: ${tool}`);
    }
  }

  private intentExpectedPaths(record: WriteIntentRecord, effects: WriteIntentEffect[]): Set<string> {
    return new Set(effects.map((effect) => effect.path));
  }

  private checkIntentPreconditions(record: WriteIntentRecord): ToolResult {
    for (const effect of this.writeLedger.effects(record.op_id)) {
      if (effect.effect_type === "audit_journal") continue;
      const fullPath = path.join(this.root, effect.path);
      const currentHash = fileSha256(fullPath);
      if (currentHash !== effect.expected_base_hash) {
        return this.err(`target changed since intent submission: ${effect.path}`, {
          error_class: "precondition_conflict",
          path: effect.path,
          expected_base_hash: effect.expected_base_hash,
          current_hash: currentHash,
        });
      }
    }
    return this.ok();
  }

  private effectMarkerExists(effect: WriteIntentEffect): boolean {
    if (!effect.applied_marker) return false;
    const fullPath = path.join(this.root, effect.path);
    try {
      return readText(fullPath).includes(effect.applied_marker);
    } catch {
      return false;
    }
  }

  private intentAlreadyApplied(tool: string, args: Record<string, unknown>): ToolResult {
    if (tool === "update_property") {
      const p = this.findPagePath(String(args.name ?? ""));
      if (!p) return this.err("not applied");
      const props = this.propsDict(this.splitFrontmatter(readText(p))[0]);
      return props[String(args.key ?? "")] === String(args.value ?? "") ? this.ok({ name: stem(p), key: String(args.key ?? "") }) : this.err("not applied");
    }
    if (tool === "delete_property") {
      const p = this.findPagePath(String(args.name ?? ""));
      const key = String(args.key ?? "");
      if (!p || !key) return this.err("not applied");
      const props = this.propsDict(this.splitFrontmatter(readText(p))[0]);
      return props[key] == null ? this.ok({ name: stem(p), key, property_absent: true }) : this.err("not applied");
    }
    if (tool === "update_body_section") {
      const p = this.findPagePath(String(args.name ?? ""));
      if (!p) return this.err("not applied");
      if (String(args.mode ?? "replace_block") === "delete_block") return this.err("not applied");
      if (this.bodySectionAlreadyApplied(p, args)) return this.ok({ marker: this.expectedAppendMarker(tool, args) });
    }
    if (tool === "append_contact_log") {
      const p = this.findPagePath(String(args.name ?? ""));
      if (p && pathExists(p) && this.contactLogAlreadyApplied(p, args)) return this.ok({ marker: this.expectedAppendMarker(tool, args) });
    }
    if (tool === "append_journal_bullet" && this.journalBulletAlreadyApplied(args)) return this.ok({ marker: this.expectedAppendMarker(tool, args) });
    if (tool === "create_stub") {
      const p = this.findPagePath(String(args.name ?? ""));
      if (p && this.createStubAlreadyApplied(p, args)) return this.ok({ name: String(args.name ?? "") });
    }
    return this.err("not applied");
  }

  private bodySectionAlreadyApplied(p: string, args: Record<string, unknown>): boolean {
    const marker = this.expectedAppendMarker("update_body_section", args);
    if (!marker) return false;
    const mode = String(args.mode ?? "replace_block");
    const anchor = String(args.anchor ?? "");
    const [, body] = this.splitFrontmatter(readText(p));
    const block = this.bodyBlockForAnchor(body, anchor);
    if (!block) return false;
    return block.includes(marker);
  }

  private bodyBlockForAnchor(body: string, anchor: string): string | null {
    if (!anchor) return null;
    const lines = body.split("\n");
    const matches = lines.map((line, i) => line.includes(anchor) ? i : -1).filter((i) => i >= 0);
    if (matches.length !== 1) return null;
    const anchorIdx = matches[0]!;
    const anchorLine = lines[anchorIdx]!;
    const anchorIndent = anchorLine.length - anchorLine.replace(/^\t+/, "").length;
    let blockEnd = anchorIdx + 1;
    while (blockEnd < lines.length) {
      const line = lines[blockEnd]!;
      if (!line.trimEnd()) {
        blockEnd += 1;
        continue;
      }
      const indent = line.length - line.replace(/^\t+/, "").length;
      if (indent <= anchorIndent) break;
      blockEnd += 1;
    }
    return lines.slice(anchorIdx, blockEnd).join("\n");
  }

  private journalBulletAlreadyApplied(args: Record<string, unknown>): boolean {
    const marker = this.expectedAppendMarker("append_journal_bullet", args);
    if (!marker) return false;
    const p = path.join(this.journals, `${toJournalDate(String(args.date))}.md`);
    if (!pathExists(p)) return false;
    const text = readText(p);
    const section = args.section == null ? null : String(args.section);
    if (!section) {
      const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^- ${escapedMarker}\\s*$`, "m").test(text);
    }
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^- ## ${escaped}\\s*$`, "m");
    const m = re.exec(text);
    if (!m) return false;
    const after = text.slice(m.index + m[0].length);
    const nextSection = after.search(/\n- ## /);
    const sectionText = nextSection >= 0 ? after.slice(0, nextSection) : after;
    return sectionText.includes(`\t- ${marker}`);
  }

  private contactLogAlreadyApplied(p: string, args: Record<string, unknown>): boolean {
    const marker = this.expectedAppendMarker("append_contact_log", args);
    if (!marker) return false;
    const [props, body] = this.splitFrontmatter(readText(p));
    const m = /^- \*\*Contact log\*\*[^\n]*\n/m.exec(body);
    if (!m) return false;
    const after = body.slice(m.index + m[0].length);
    const nextBlock = after.search(/\n- /);
    const sectionText = nextBlock >= 0 ? after.slice(0, nextBlock) : after;
    if (!sectionText.includes(`\t- ${marker}`)) return false;
    const intentDate = parseDate(String(args.date ?? nowIsoDate()));
    const lastContacted = parseDate(this.propsDict(props)["last-contacted"]);
    return !intentDate || Boolean(lastContacted && lastContacted >= intentDate);
  }

  private createStubAlreadyApplied(p: string, args: Record<string, unknown>): boolean {
    const [props, body] = this.splitFrontmatter(readText(p));
    const dict = this.propsDict(props);
    if (dict.type !== String(args.page_type ?? "person")) return false;
    if (dict.confidence !== String(args.confidence ?? "low")) return false;
    if (args.source != null && dict.source !== String(args.source)) return false;
    if (args.properties && typeof args.properties === "object" && !Array.isArray(args.properties)) {
      for (const [key, value] of Object.entries(args.properties as Record<string, unknown>)) {
        if (dict[key] !== String(value)) return false;
      }
    }
    const notes = Array.isArray(args.notes) ? args.notes.map(String) : [];
    return notes.every((note) => body.includes(note));
  }

  private expectedAppendMarker(tool: string, args: Record<string, unknown>): string {
    if (tool === "append_contact_log") {
      const bits = [
        String(args.date ?? nowIsoDate()),
        String(args.medium ?? ""),
        args.direction ? String(args.direction) : "",
        String(args.summary ?? ""),
        args.duration ? String(args.duration) : "",
      ].filter(Boolean);
      return bits.join(" - ");
    }
    if (tool === "append_journal_bullet") return String(args.content ?? "");
    if (tool === "update_body_section") return String(args.new_content ?? "");
    return "";
  }

  private classifyWriteError(error: string): { name: string; retryable: boolean } {
    if (/lock|timeout|timed out|EAGAIN|EBUSY/i.test(error)) return { name: "lock_timeout", retryable: true };
    if (/requires a clean Logseq graph|dirty/i.test(error)) return { name: "guard_blocked_dirty_graph", retryable: true };
    if (/not in schema|dangling wikilink|anchor not found|anchor matched|Page not found|invalid date|force is disabled/i.test(error)) return { name: "validation_failed", retryable: false };
    if (/blast-radius|delete violation/i.test(error)) return { name: "blast_radius_violation", retryable: false };
    return { name: "write_failed", retryable: false };
  }

  list_pages(args: Record<string, unknown> = {}): ToolResult {
    const includeProperties = Array.isArray(args.include_properties) ? args.include_properties.map(String) : [];
    const typeFilter = args.type_filter == null ? "" : String(args.type_filter);
    const tag = args.tag == null ? "" : String(args.tag).toLowerCase();
    const includeMtime = args.include_mtime !== false;
    const pages: Array<Record<string, unknown>> = [];
    for (const p of this.allPagePaths().sort()) {
      const props = this.readFrontmatterOnly(p);
      if (typeFilter && props.type !== typeFilter) continue;
      if (tag && !(props.tags ?? "").toLowerCase().includes(tag)) continue;
      const entry: Record<string, unknown> = {
        slug: this.slugify(stem(p)),
        name: stem(p),
        type: props.type ?? "",
        last_contacted: props["last-contacted"] ?? "",
        status: props.status ?? "",
      };
      for (const k of includeProperties) {
        if (!["type", "status", "last-contacted"].includes(k) && props[k] != null) entry[k] = props[k];
      }
      if (includeMtime) entry.mtime = new Date(fs.statSync(p).mtimeMs).toISOString();
      pages.push(entry);
    }
    return this.cap(this.ok({ pages, count: pages.length }));
  }

  read_page(name: string, includeRaw = false): ToolResult {
    const [err, normalized] = this.safeReadName(name);
    if (err) return this.err(err);
    const p = this.findPagePath(normalized);
    if (!p) return this.err(`Page not found: ${name}`);
    const text = readText(p);
    const [props, body] = this.splitFrontmatter(text);
    const payload: Record<string, unknown> = {
      name: stem(p),
      slug: this.slugify(stem(p)),
      properties: this.propsDict(props),
      body,
      path: rel(this.root, p),
    };
    if (includeRaw) payload.raw = text;
    return this.cap(this.ok(payload));
  }

  read_pages(args: Record<string, unknown>): ToolResult {
    const names = Array.isArray(args.names) ? args.names.map(String) : [];
    const includeBody = args.include_body !== false;
    const includeRaw = Boolean(args.include_raw);
    const bodyChars = typeof args.body_chars === "number" ? args.body_chars : null;
    const pages: Record<string, Record<string, unknown>> = {};
    for (const name of names) {
      const [err, normalized] = this.safeReadName(name);
      if (err) {
        pages[name] = { error: err };
        continue;
      }
      const p = this.findPagePath(normalized);
      if (!p) {
        pages[name] = { error: `Page not found: ${name}` };
        continue;
      }
      const text = readText(p);
      const [props, body] = this.splitFrontmatter(text);
      const entry: Record<string, unknown> = { name: stem(p), slug: this.slugify(stem(p)), properties: this.propsDict(props), path: rel(this.root, p) };
      if (includeBody) {
        entry.body = bodyChars == null ? body : body.slice(0, bodyChars);
        if (bodyChars != null && body.length > bodyChars) entry.body_truncated = true;
      }
      if (includeRaw) entry.raw = text;
      pages[name] = entry;
    }
    return this.cap(this.ok({ pages }));
  }

  read_journal(date?: string): ToolResult {
    const dateIso = date == null ? nowIsoDate() : fromJournalDate(date);
    if (date != null) {
      const err = this.safeDate(date);
      if (err) return this.err(err);
    }
    const p = path.join(this.journals, `${toJournalDate(dateIso)}.md`);
    if (!this.under(p, this.journals)) return this.err("journal path escapes JOURNALS dir");
    if (!pathExists(p)) return this.ok({ date: dateIso, exists: false });
    return this.cap(this.ok({ date: dateIso, exists: true, raw: readText(p), path: rel(this.root, p) }));
  }

  search(args: Record<string, unknown>): ToolResult {
    const query = String(args.query ?? "");
    if (!query) return this.err("query is required");
    if (Boolean(args.regex) && query.length > this.maxRegexLen) return this.err(`regex too long (max ${this.maxRegexLen} chars)`);
    let re: ReturnType<typeof compileSearchRegex>;
    try {
      const flags = args.case_sensitive ? "u" : "iu";
      re = compileSearchRegex(args.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch (err) {
      return this.err(`bad regex: ${(err as Error).message}`);
    }
    const maxResults = Math.max(0, Number(args.max_results ?? 50));
    const offset = Math.max(0, Number(args.offset ?? 0));
    const contextChars = Math.max(0, Number(args.context_chars ?? 80));
    const preserveNewlines = Boolean(args.preserve_newlines);
    const includeJournals = Boolean(args.include_journals);
    const targets = this.allPagePaths().sort();
    if (includeJournals && pathExists(this.journals)) targets.push(...listMarkdown(this.journals).filter((p) => this.safeGraphFile(p, this.journals)).sort());
    const results: Array<Record<string, unknown>> = [];
    let skipped = 0;
    let truncated = false;
    const deadline = Date.now() + this.regexTimeoutMs;
    for (const p of targets) {
      if (results.length >= maxResults) {
        truncated = true;
        break;
      }
      const lines = readText(p).split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (Date.now() > deadline) return this.err("regex search exceeded time budget", { results, truncated: true });
        const line = lines[i]!.slice(0, this.maxSearchLine);
        const m = re.search(line);
        if (!m) continue;
        if (skipped < offset) {
          skipped += 1;
          continue;
        }
        if (results.length >= maxResults) {
          truncated = true;
          break;
        }
        const start = Math.max(0, m.index - contextChars);
        const end = Math.min(line.length, m.index + m.text.length + contextChars);
        let snippet = line.slice(start, end);
        if (!preserveNewlines) snippet = snippet.replaceAll("\n", " ");
        results.push({ file: rel(this.root, p), name: stem(p), slug: this.slugify(stem(p)), line: i + 1, match: m.text, snippet });
      }
    }
    return this.cap(this.ok({ results, count: results.length, truncated, regex_engine: regexEngineName() }));
  }

  query_pages(args: Record<string, unknown>): ToolResult {
    const filters = Array.isArray(args.filters) ? args.filters as Array<Record<string, unknown>> : [];
    const ops = new Set(["eq", "ne", "lt", "le", "gt", "ge", "contains", "regex", "exists", "missing"]);
    for (const f of filters) if (!ops.has(String(f.op))) return this.err(`unknown op ${JSON.stringify(f.op)}; valid: ${JSON.stringify(Array.from(ops).sort())}`);
    const compiled = new Map<number, ReturnType<typeof compileSearchRegex>>();
    for (let i = 0; i < filters.length; i += 1) {
      if (filters[i]!.op === "regex") {
        const value = String(filters[i]!.value ?? "");
        if (value.length > this.maxRegexLen) return this.err(`filter[${i}] regex too long (max ${this.maxRegexLen} chars)`);
        try {
          compiled.set(i, compileSearchRegex(value, "iu"));
        } catch (err) {
          return this.err(`filter[${i}] bad regex: ${(err as Error).message}`);
        }
      }
    }
    const invalidValues: Array<Record<string, string>> = [];
    const matched: Array<Record<string, unknown>> = [];
    const typeFilter = args.type_filter == null ? "" : String(args.type_filter);
    const tag = args.tag == null ? "" : String(args.tag).toLowerCase();
    const regexDeadline = Date.now() + this.regexTimeoutMs;
    let regexTimedOut = false;
    const compare = (propVal: string | undefined, op: string, value: string, idx: number, pageName: string, key: string): boolean => {
      if (op === "exists") return propVal != null && propVal !== "";
      if (op === "missing") return propVal == null || propVal === "";
      if (propVal == null) return false;
      if (op === "eq") return propVal === value;
      if (op === "ne") return propVal !== value;
      if (op === "contains") return propVal.toLowerCase().includes(value.toLowerCase());
      if (op === "regex") {
        if (Date.now() > regexDeadline) {
          regexTimedOut = true;
          return false;
        }
        return compiled.get(idx)!.search(propVal.slice(0, this.maxSearchLine)) !== null;
      }
      const d1 = parseDate(propVal);
      const d2 = parseDate(value);
      if (d1 && d2) {
        if (op === "lt") return d1 < d2;
        if (op === "le") return d1 <= d2;
        if (op === "gt") return d1 > d2;
        if (op === "ge") return d1 >= d2;
      }
      if (key.endsWith("date") || key === "last-contacted" || d1 || d2) {
        invalidValues.push({ name: pageName, key, value: propVal, compare_to: value });
        return false;
      }
      if (op === "lt") return propVal < value;
      if (op === "le") return propVal <= value;
      if (op === "gt") return propVal > value;
      if (op === "ge") return propVal >= value;
      return false;
    };
    for (const p of this.allPagePaths().sort()) {
      const props = this.readFrontmatterOnly(p);
      if (typeFilter && props.type !== typeFilter) continue;
      if (tag && !(props.tags ?? "").toLowerCase().includes(tag)) continue;
      let ok = true;
      for (let i = 0; i < filters.length; i += 1) {
        const f = filters[i]!;
        const key = String(f.key ?? "");
        if (!compare(props[key], String(f.op), String(f.value ?? ""), i, stem(p), key)) {
          ok = false;
          break;
        }
      }
      if (regexTimedOut) return this.err("regex query exceeded time budget", { regex_engine: regexEngineName() });
      if (ok) matched.push({ slug: this.slugify(stem(p)), name: stem(p), type: props.type ?? "", properties: props });
    }
    const sortBy = args.sort_by == null ? "" : String(args.sort_by);
    if (sortBy) matched.sort((a, b) => String((a.properties as Record<string, string>)[sortBy] ?? "").localeCompare(String((b.properties as Record<string, string>)[sortBy] ?? "")) * (args.descending ? -1 : 1));
    const limit = Math.max(0, Number(args.limit ?? 200));
    const offset = Math.max(0, Number(args.offset ?? 0));
    const payload = this.ok({ pages: matched.slice(offset, offset + limit), count: matched.slice(offset, offset + limit).length, total: matched.length, truncated: matched.length > offset + limit });
    if (invalidValues.length) {
      payload.invalid_values = invalidValues.slice(0, 50);
      payload.invalid_values_truncated = invalidValues.length > 50;
    }
    if (compiled.size) payload.regex_engine = regexEngineName();
    return this.cap(payload);
  }

  graph_status(args: Record<string, unknown> = {}): ToolResult {
    const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 100));
    const pagePaths = this.allPagePaths().filter((p) => this.safeGraphFile(p, this.pages));
    const journalPaths = pathExists(this.journals) ? listMarkdown(this.journals).filter((p) => this.safeGraphFile(p, this.journals)) : [];
    const indexPath = path.join(this.root, "generated", "graph_index.json");
    const indexExists = pathExists(indexPath);
    const indexMtime = indexExists ? mtimeMs(indexPath) : null;
    const stale: Array<Record<string, string>> = [];
    if (indexMtime != null) {
      for (const p of [...pagePaths, ...journalPaths].sort((a, b) => mtimeMs(b) - mtimeMs(a))) {
        if (mtimeMs(p) > indexMtime) stale.push({ path: rel(this.root, p), mtime: new Date(mtimeMs(p)).toISOString() });
        if (stale.length >= limit) break;
      }
    }
    let dirty: StatusEntry[] = [];
    let gitError: string | null = null;
    if (this.gitInsideWorktree()) {
      try {
        dirty = this.gitStatusEntries();
      } catch (err) {
        gitError = (err as Error).message;
      }
    } else {
      gitError = `${this.root} is not a Git worktree`;
    }
    return this.cap(this.ok({
      root: this.root,
      readonly: this.readonlyMode,
      write_mode: this.writeMode,
      package_version: packageVersion,
      schema_mode: this.schemaMode,
      link_mode: this.linkMode,
      disallow_force: this.disallowForce,
      git_guard_mode: this.gitGuardMode,
      git_guard_limits: {
        max_changed_files: this.gitMaxChangedFiles,
        max_deleted_files: this.gitMaxDeletedFiles,
        ignore_dirs: this.gitGuardIgnoreDirs,
      },
      pages: pagePaths.length,
      journals: journalPaths.length,
      generated_index: {
        exists: indexExists,
        path: rel(this.root, indexPath),
        mtime: indexMtime == null ? null : new Date(indexMtime).toISOString(),
        stale_files_newer_than_index: stale,
        stale_count_sampled: stale.length,
      },
      git: {
        head: this.gitInsideWorktree() ? this.gitHead() : "",
        dirty: dirty.length > 0,
        dirty_count: dirty.length,
        dirty_sample: this.statusSummary(dirty, limit),
        error: gitError,
        recent_commits: this.gitRecentCommits(5),
      },
      schema: { known_keys: this.knownSchemaKeys().size },
      cache: {
        file: this.persistentCache.cacheFile,
        watcher_enabled: this.watcher !== null,
      },
      locks: this.lockHealth(limit),
      write_intents: {
        ledger_file: this.writeLedger.ledgerFile,
        counts: this.writeLedger.counts(),
      },
    }));
  }

  private graphNodes(): Map<string, GraphNode> {
    const pagePaths = this.allPagePaths().sort();
    const fingerprints = pagePaths.map((p) => pageFingerprint(p)).filter((fp): fp is NonNullable<typeof fp> => fp !== null);
    const current = fingerprintKey(fingerprints);
    if (this.adjacency && this.adjacencyFingerprint === current) return this.adjacency;
    const persisted = this.persistentCache.getAdjacency(current);
    if (persisted) {
      this.adjacency = persisted;
      this.adjacencyFingerprint = current;
      return persisted;
    }
    const nodes = new Map<string, GraphNode>();
    const redirects = new Map<string, string>();
    for (const p of pagePaths) {
      const slug = this.slugify(stem(p));
      const props = this.readFrontmatterOnly(p);
      const ptype = (props.type ?? "").trim().toLowerCase() || null;
      const isRedirect = ptype === "redirect" || ptype === "alias";
      let redirectsTo: string | null = null;
      if (isRedirect) {
        const rt = props["redirects-to"] ?? "";
        redirectsTo = this.slugify(firstWikilinkTarget(rt) ?? rt.trim());
        if (redirectsTo) redirects.set(slug, redirectsTo);
      }
      nodes.set(slug, { name: stem(p), path: p, type: ptype, is_redirect: isRedirect, redirects_to: redirectsTo, in_edges: new Set(), out_edges: new Set() });
    }
    const canonical = (s: string): string => {
      const seen = new Set<string>();
      let cur = s;
      while (redirects.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = redirects.get(cur)!;
      }
      return cur;
    };
    for (const [slug, node] of nodes.entries()) {
      const text = readText(node.path).replace(FENCE_RE, "").replace(INLINE_CODE_RE, "");
      const seenTargets = new Set<string>();
      for (const m of text.matchAll(WIKILINK_RE)) {
        let raw = m[1]!.trim();
        if (raw.includes("|")) raw = raw.split("|", 1)[0]!.trim();
        let target = this.slugify(raw);
        if (target.includes("/") && nodes.has(target.replaceAll("/", "___"))) target = target.replaceAll("/", "___");
        if (!target || target === slug) continue;
        const targetCanon = canonical(target);
        if (seenTargets.has(targetCanon)) continue;
        seenTargets.add(targetCanon);
        node.out_edges.add(targetCanon);
        const targetNode = nodes.get(targetCanon);
        if (targetNode) {
          const srcCanon = canonical(slug);
          if (srcCanon !== targetCanon) targetNode.in_edges.add(srcCanon);
        }
      }
    }
    this.adjacency = nodes;
    this.adjacencyFingerprint = current;
    this.persistentCache.setAdjacency(current, nodes);
    this.persistentCache.flush();
    return nodes;
  }

  private degreeFilter(node: GraphNode, includeMeta: boolean, includeRedirects: boolean): boolean {
    if (!includeRedirects && node.is_redirect) return false;
    if (!includeMeta && node.type && META_TYPES.has(node.type)) return false;
    return true;
  }

  find_orphans(args: Record<string, unknown> = {}): ToolResult {
    const includeMeta = Boolean(args.include_meta);
    const includeRedirects = Boolean(args.include_redirects);
    const limit = Math.max(0, Number(args.limit ?? 200));
    const out = Array.from(this.graphNodes().entries())
      .filter(([, n]) => this.degreeFilter(n, includeMeta, includeRedirects) && n.in_edges.size === 0 && n.out_edges.size === 0)
      .map(([slug, n]) => ({ slug, name: n.name, type: n.type }))
      .sort((a, b) => String(a.type ?? "").localeCompare(String(b.type ?? "")) || a.name.localeCompare(b.name));
    return this.cap(this.ok({ count: out.length, orphans: out.slice(0, limit), truncated: out.length > limit }));
  }

  find_low_degree(args: Record<string, unknown> = {}): ToolResult {
    const direction = String(args.direction ?? "total");
    if (!["in", "out", "total"].includes(direction)) return this.err(`direction must be 'in' | 'out' | 'total', got ${JSON.stringify(direction)}`);
    const maxDegree = Number(args.max_degree ?? 1);
    const includeMeta = Boolean(args.include_meta);
    const includeRedirects = Boolean(args.include_redirects);
    const limit = Math.max(0, Number(args.limit ?? 200));
    const degree = (n: GraphNode) => direction === "in" ? n.in_edges.size : direction === "out" ? n.out_edges.size : n.in_edges.size + n.out_edges.size;
    const rows = Array.from(this.graphNodes().entries())
      .filter(([, n]) => this.degreeFilter(n, includeMeta, includeRedirects) && degree(n) <= maxDegree)
      .map(([slug, n]) => ({ slug, name: n.name, type: n.type, in: n.in_edges.size, out: n.out_edges.size, total: n.in_edges.size + n.out_edges.size, in_neighbors: Array.from(n.in_edges).sort(), out_neighbors: Array.from(n.out_edges).sort() }))
      .sort((a, b) => (direction === "total" ? a.total - b.total : Number(a[direction as "in" | "out"]) - Number(b[direction as "in" | "out"])) || a.name.localeCompare(b.name));
    return this.cap(this.ok({ count: rows.length, max_degree: maxDegree, direction, pages: rows.slice(0, limit), truncated: rows.length > limit }));
  }

  find_hubs(args: Record<string, unknown> = {}): ToolResult {
    const direction = String(args.direction ?? "total");
    if (!["in", "out", "total"].includes(direction)) return this.err(`direction must be 'in' | 'out' | 'total', got ${JSON.stringify(direction)}`);
    const limit = Math.max(1, Number(args.limit ?? 20));
    const rows = Array.from(this.graphNodes().entries())
      .filter(([, n]) => this.degreeFilter(n, Boolean(args.include_meta), Boolean(args.include_redirects)))
      .map(([slug, n]) => ({ slug, name: n.name, type: n.type, in: n.in_edges.size, out: n.out_edges.size, total: n.in_edges.size + n.out_edges.size }))
      .sort((a, b) => -(direction === "total" ? a.total - b.total : Number(a[direction as "in" | "out"]) - Number(b[direction as "in" | "out"])) || a.name.localeCompare(b.name));
    return this.cap(this.ok({ direction, hubs: rows.slice(0, limit) }));
  }

  node_degree(name: string): ToolResult {
    const [err, normalized] = this.safeReadName(name);
    if (err) return this.err(err);
    const slug = this.slugify(normalized);
    const node = this.graphNodes().get(slug);
    if (!node) return this.err(`page not found: ${JSON.stringify(name)}`);
    return this.cap(this.ok({ name: node.name, slug, type: node.type, is_redirect: node.is_redirect, redirects_to: node.redirects_to, in: node.in_edges.size, out: node.out_edges.size, total: node.in_edges.size + node.out_edges.size, in_neighbors: Array.from(node.in_edges).sort(), out_neighbors: Array.from(node.out_edges).sort() }));
  }

  graph_stats(args: Record<string, unknown> = {}): ToolResult {
    const nodes = Array.from(this.graphNodes().values());
    const entity = nodes.filter((n) => !n.is_redirect && !(n.type && META_TYPES.has(n.type)));
    const degrees = entity.map((n) => n.in_edges.size + n.out_edges.size).sort((a, b) => a - b);
    const types: Record<string, number> = {};
    let edges = 0;
    let orphans = 0;
    for (const n of entity) {
      const total = n.in_edges.size + n.out_edges.size;
      edges += n.out_edges.size;
      if (total === 0) orphans += 1;
      types[n.type ?? "(missing)"] = (types[n.type ?? "(missing)"] ?? 0) + 1;
    }
    const top = this.find_hubs({ limit: Math.max(1, Number(args.top_hubs ?? 10)), direction: "total" });
    return this.cap(this.ok({
      totals: { pages_total: nodes.length, entity_pages: entity.length, redirect_pages: nodes.filter((n) => n.is_redirect).length, meta_pages: nodes.filter((n) => n.type && META_TYPES.has(n.type)).length, edges_directed: edges, orphans },
      degree: { mean: degrees.length ? Math.round((degrees.reduce((a, b) => a + b, 0) / degrees.length) * 100) / 100 : 0, median: degrees.length ? degrees[Math.floor(degrees.length / 2)] : 0, max: degrees.at(-1) ?? 0, min: degrees[0] ?? 0 },
      types: Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
      top_hubs: top.ok ? top.hubs : [],
    }));
  }

  find_components(args: Record<string, unknown> = {}): ToolResult {
    const includeMeta = Boolean(args.include_meta);
    const includeRedirects = args.include_redirects !== false;
    const minSize = Number(args.min_size ?? 1);
    const excludeMain = args.exclude_main !== false;
    const limit = Math.max(0, Number(args.limit ?? 50));
    const nodes = this.graphNodes();
    const eligible = new Map(Array.from(nodes.entries()).filter(([, n]) => this.degreeFilter(n, includeMeta, includeRedirects)));
    const adj = new Map<string, Set<string>>();
    for (const s of eligible.keys()) adj.set(s, new Set());
    for (const [slug, node] of eligible.entries()) {
      for (const nb of new Set([...node.in_edges, ...node.out_edges])) {
        if (eligible.has(nb)) {
          adj.get(slug)!.add(nb);
          adj.get(nb)!.add(slug);
        }
      }
    }
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const start of eligible.keys()) {
      if (visited.has(start)) continue;
      const stack = [start];
      const comp: string[] = [];
      while (stack.length) {
        const cur = stack.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        comp.push(cur);
        for (const nb of adj.get(cur)!) if (!visited.has(nb)) stack.push(nb);
      }
      components.push(comp.sort());
    }
    components.sort((a, b) => b.length - a.length);
    const rows = [];
    for (let i = 0; i < components.length; i += 1) {
      const comp = components[i]!;
      if (excludeMain && i === 0) continue;
      if (comp.length < minSize) continue;
      const members = comp.map((s) => ({ slug: s, name: eligible.get(s)!.name, type: eligible.get(s)!.type }));
      const typeHist: Record<string, number> = {};
      for (const m of members) typeHist[m.type ?? "(none)"] = (typeHist[m.type ?? "(none)"] ?? 0) + 1;
      rows.push({ size: comp.length, members, types: Object.fromEntries(Object.entries(typeHist).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) });
      if (rows.length >= limit) break;
    }
    return this.cap(this.ok({ total_components: components.length, main_component_size: components[0]?.length ?? 0, floating_components: Math.max(0, components.length - 1), components: rows }));
  }

  find_dangling_links(args: Record<string, unknown> = {}): ToolResult {
    const minRefs = Number(args.min_refs ?? 1);
    const excludeNamespaces = args.exclude_namespaces !== false;
    const limit = Math.max(0, Number(args.limit ?? 500));
    const nodes = this.graphNodes();
    const existing = new Set(nodes.keys());
    const nsSlugs = new Set(Array.from(existing).filter((s) => s.includes("___")).map((s) => s.replaceAll("___", "/")));
    const dangling = new Map<string, Set<string>>();
    for (const node of nodes.values()) {
      for (const target of node.out_edges) {
        if (!target || existing.has(target)) continue;
        if (target.includes("/")) {
          if (excludeNamespaces) continue;
          if (existing.has(target.replaceAll("/", "___"))) continue;
        }
        if (SAFE_DATE_RE.test(target) && pathExists(path.join(this.journals, `${target.replaceAll("-", "_")}.md`))) continue;
        if (nsSlugs.has(target)) continue;
        if (!dangling.has(target)) dangling.set(target, new Set());
        dangling.get(target)!.add(node.name);
      }
    }
    const rows = Array.from(dangling.entries())
      .filter(([, srcs]) => srcs.size >= minRefs)
      .map(([target, srcs]) => ({ target, refs: srcs.size, sources: Array.from(srcs).sort() }))
      .sort((a, b) => b.refs - a.refs || a.target.localeCompare(b.target));
    return this.cap(this.ok({ count: rows.length, dangling: rows.slice(0, limit), truncated: rows.length > limit }));
  }

  backlinks(args: Record<string, unknown>): ToolResult {
    const name = String(args.name ?? "");
    const [err, normalized] = this.safeReadName(name);
    if (err) return this.err(err);
    const targetPath = this.findPagePath(normalized);
    const canonical = targetPath ? stem(targetPath) : name.trim();
    const canonicalSlug = this.slugify(canonical);
    const nodes = this.graphNodes();
    const aliases = new Set<string>([canonicalSlug]);
    if (args.include_aliases !== false) {
      for (const [s, node] of nodes) if (node.is_redirect && node.redirects_to === canonicalSlug) aliases.add(s);
    }
    const candidates = Array.from(nodes.entries()).filter(([s, n]) => !aliases.has(s) && Array.from(n.out_edges).some((e) => aliases.has(e))).map(([, n]) => n.path).sort();
    const limit = Math.max(0, Number(args.limit ?? 200));
    if (String(args.mode ?? "detail") === "summary") {
      const byFile: Record<string, number> = {};
      let total = 0;
      for (const p of candidates) {
        const text = readText(p).replace(FENCE_RE, "").replace(INLINE_CODE_RE, "");
        let n = 0;
        for (const m of text.matchAll(WIKILINK_RE)) {
          let raw = m[1]!.trim();
          if (raw.includes("|")) raw = raw.split("|", 1)[0]!.trim();
          if (aliases.has(this.slugify(raw))) n += 1;
        }
        if (n) {
          byFile[rel(this.root, p)] = n;
          total += n;
        }
      }
      return this.cap(this.ok({ mode: "summary", count: total, files: Object.keys(byFile).length, by_file: Object.entries(byFile).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([file, n]) => ({ file, name: stem(file), n })) }));
    }
    const offset = Math.max(0, Number(args.offset ?? 0));
    const contextChars = Math.max(0, Number(args.context_chars ?? 60));
    const results: Array<Record<string, unknown>> = [];
    let skipped = 0;
    let truncated = false;
    for (const p of candidates) {
      if (results.length >= limit) {
        truncated = true;
        break;
      }
      let inFence = false;
      const lines = readText(p).split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (line.trimStart().startsWith("```")) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        const scanLine = line.replace(INLINE_CODE_RE, "");
        for (const m of scanLine.matchAll(WIKILINK_RE)) {
          let raw = m[1]!.trim();
          if (raw.includes("|")) raw = raw.split("|", 1)[0]!.trim();
          if (!aliases.has(this.slugify(raw))) continue;
          if (skipped < offset) {
            skipped += 1;
            continue;
          }
          if (results.length >= limit) {
            truncated = true;
            break;
          }
          const start = Math.max(0, (m.index ?? 0) - contextChars);
          const end = Math.min(scanLine.length, (m.index ?? 0) + m[0].length + contextChars);
          results.push({ file: rel(this.root, p), name: stem(p), slug: this.slugify(stem(p)), line: i + 1, snippet: scanLine.slice(start, end).trim(), link_text: m[0] });
        }
      }
    }
    return this.cap(this.ok({ mode: "detail", results, count: results.length, truncated }));
  }

  private readWritePage(name: string): [ToolResult | null, string] {
    const err = this.safeName(name);
    if (err) return [this.err(err), ""];
    const p = this.findPagePath(name);
    if (!p) return [this.err(`Page not found: ${name}`), ""];
    const sl = this.rejectSymlink(p);
    if (sl) return [sl, ""];
    return [null, p];
  }

  update_property(args: Record<string, unknown>): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("update_property");
    const name = String(args.name ?? "");
    const key = String(args.key ?? "");
    const value = String(args.value ?? "");
    const [pageErr, p] = this.readWritePage(name);
    if (pageErr) return pageErr;
    if (!key) return this.err("key is required");
    const [allowed, schemaMsg, forced] = this.checkSchema(key, Boolean(args.force));
    if (!allowed) return this.err(schemaMsg!);
    const [linkOk, linkMsg, dangling] = this.checkLinksResolve(value, Boolean(args.allow_dangling));
    if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
    let txn: GitTxn;
    try {
      txn = this.beginTxn("update_property");
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    let old: string | undefined;
    try {
      this.withLock(p, () => {
        const [props, body] = this.splitFrontmatter(readText(p));
        old = this.propsDict(props)[key];
        this.atomicWrite(p, this.joinFrontmatter(this.propsSet(props, key, value), body));
      });
    } catch (err) {
      txn.release();
      return this.err((err as Error).message);
    }
    this.invalidate();
    this.audit(`update_property :: ${stem(p)} - ${key} :: ${JSON.stringify(old)} -> ${JSON.stringify(value)}`);
    if (forced) this.audit(`FORCE_SCHEMA_BYPASS :: update_property - ${key}`);
    try {
      txn.finish();
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    const payload: Record<string, unknown> = { name: stem(p), key, from: old, to: value };
    if (schemaMsg) payload.schema_warning = schemaMsg;
    if (linkMsg) payload.link_warning = linkMsg;
    return this.attachGit(this.ok(payload), txn);
  }

  batch_update_property(args: Record<string, unknown>): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("batch_update_property");
    let txn: GitTxn;
    try {
      txn = this.beginTxn("batch_update_property");
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    const updates = Array.isArray(args.updates) ? args.updates as Array<Record<string, unknown>> : [];
    const results: Array<Record<string, unknown>> = [];
    const forcedKeys: string[] = [];
    let success = 0;
    for (const upd of updates) {
      const name = String(upd.name ?? "");
      const key = String(upd.key ?? "");
      const value = String(upd.value ?? "");
      if (!name || !key) {
        results.push({ name, key, ok: false, error: "name and key are required" });
        continue;
      }
      const safe = this.safeName(name);
      if (safe) {
        results.push({ name, key, ok: false, error: safe });
        continue;
      }
      const [allowed, schemaMsg, forced] = this.checkSchema(key, Boolean(args.force));
      if (!allowed) {
        results.push({ name, key, ok: false, error: schemaMsg });
        continue;
      }
      const [linkOk, linkMsg, dangling] = this.checkLinksResolve(value, Boolean(upd.allow_dangling ?? args.allow_dangling));
      if (!linkOk) {
        results.push({ name, key, ok: false, error: linkMsg, dangling_targets: dangling });
        continue;
      }
      const p = this.findPagePath(name);
      if (!p) {
        results.push({ name, key, ok: false, error: `Page not found: ${name}` });
        continue;
      }
      if (isSymlink(p)) {
        results.push({ name, key, ok: false, error: "symlinks are not editable" });
        continue;
      }
      let old: string | undefined;
      try {
        this.withLock(p, () => {
          const [props, body] = this.splitFrontmatter(readText(p));
          old = this.propsDict(props)[key];
          this.atomicWrite(p, this.joinFrontmatter(this.propsSet(props, key, value), body));
        });
      } catch (err) {
        results.push({ name, key, ok: false, error: (err as Error).message });
        continue;
      }
      const entry: Record<string, unknown> = { name: stem(p), key, ok: true, from: old, to: value };
      if (schemaMsg) entry.schema_warning = schemaMsg;
      if (linkMsg) entry.link_warning = linkMsg;
      results.push(entry);
      if (forced) forcedKeys.push(`${name}:${key}`);
      success += 1;
    }
    if (!success) {
      txn.release();
      return { ok: false, results, success, total: results.length, success_count: 0, failure_count: results.length };
    }
    this.invalidate();
    this.audit(`batch_update_property :: ${success}/${results.length} ok`);
    if (forcedKeys.length) this.audit(`FORCE_SCHEMA_BYPASS :: batch_update_property - ${forcedKeys.join(", ")}`);
    try {
      txn.finish();
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    return this.attachGit({ ok: success === results.length, results, success, total: results.length, success_count: success, failure_count: results.length - success }, txn);
  }

  delete_property(name: string, key: string): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("delete_property");
    const [pageErr, p] = this.readWritePage(name);
    if (pageErr) return pageErr;
    let txn: GitTxn;
    try {
      txn = this.beginTxn("delete_property");
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    let removed: string | undefined;
    try {
      this.withLock(p, () => {
        const [props, body] = this.splitFrontmatter(readText(p));
        const [newProps, old] = this.propsDelete(props, key);
        removed = old;
        if (old != null) this.atomicWrite(p, this.joinFrontmatter(newProps, body));
      });
    } catch (err) {
      txn.release();
      return this.err((err as Error).message);
    }
    if (removed == null) {
      txn.release();
      return this.ok({ name: stem(p), key, removed_value: null, note: "key was not present" });
    }
    this.invalidate();
    this.audit(`delete_property :: ${stem(p)} - ${key} :: was ${JSON.stringify(removed)}`);
    try {
      txn.finish();
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    return this.attachGit(this.ok({ name: stem(p), key, removed_value: removed }), txn);
  }

  append_contact_log(args: Record<string, unknown>): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("append_contact_log");
    const name = String(args.name ?? "");
    const medium = String(args.medium ?? "");
    const summary = String(args.summary ?? "");
    const iso = args.date == null ? nowIsoDate() : String(args.date);
    if (!parseDate(iso)) return this.err(`invalid date ${JSON.stringify(iso)}, expected YYYY-MM-DD`);
    const [linkOk, linkMsg, dangling] = this.checkLinksResolve(summary, Boolean(args.allow_dangling));
    if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
    const [pageErr, p] = this.readWritePage(name);
    if (pageErr) return pageErr;
    let txn: GitTxn;
    try {
      txn = this.beginTxn("append_contact_log");
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    const bits = [iso, medium, args.direction ? String(args.direction) : "", summary, args.duration ? String(args.duration) : ""].filter(Boolean);
    const bullet = `\t- ${bits.join(" - ")}\n`;
    try {
      this.withLock(p, () => {
        let [props, body] = this.splitFrontmatter(readText(p));
        const existing = parseDate(this.propsDict(props)["last-contacted"]);
        const next = parseDate(iso);
        if (next && (!existing || next > existing)) props = this.propsSet(props, "last-contacted", iso);
        const m = /^- \*\*Contact log\*\*[^\n]*\n/m.exec(body);
        if (m) body = body.slice(0, m.index + m[0].length) + bullet + body.slice(m.index + m[0].length);
        else body = `${body}${body && !body.endsWith("\n") ? "\n" : ""}- **Contact log** (newest first)\n${bullet}`;
        this.atomicWrite(p, this.joinFrontmatter(props, body));
      });
    } catch (err) {
      txn.release();
      return this.err((err as Error).message);
    }
    this.invalidate();
    this.audit(`append_contact_log :: ${stem(p)} - ${iso} - ${medium} - ${summary.slice(0, 60)}`);
    try {
      txn.finish();
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    const payload: Record<string, unknown> = { name: stem(p), bullet: bullet.trim() };
    if (linkMsg) payload.link_warning = linkMsg;
    return this.attachGit(this.ok(payload), txn);
  }

  append_journal_bullet(args: Record<string, unknown>): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("append_journal_bullet");
    const content = String(args.content ?? "");
    if (!content) return this.err("content is required");
    const [linkOk, linkMsg, dangling] = this.checkLinksResolve(content, Boolean(args.allow_dangling));
    if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
    const date = args.date == null ? toJournalDate(nowIsoDate()) : toJournalDate(String(args.date));
    if (args.date != null) {
      const err = this.safeDate(String(args.date));
      if (err) return this.err(err);
    }
    const p = path.join(this.journals, `${date}.md`);
    if (!this.under(p, this.journals)) return this.err("journal path escapes JOURNALS dir");
    const sl = this.rejectSymlink(p);
    if (sl) return sl;
    let txn: GitTxn;
    try {
      txn = this.beginTxn("append_journal_bullet");
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    const section = args.section == null ? null : String(args.section);
    const bullet = section ? `\t- ${content}\n` : `- ${content}\n`;
    try {
      fs.mkdirSync(this.journals, { recursive: true });
      this.withLock(p, () => {
        let text = pathExists(p) ? readText(p) : "";
        if (section) {
          const re = new RegExp(`^- ## ${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
          const m = re.exec(text);
          if (m) text = text.slice(0, m.index + m[0].length + 1) + bullet + text.slice(m.index + m[0].length + 1);
          else text = `${text}${text && !text.endsWith("\n") ? "\n" : ""}- ## ${section}\n${bullet}`;
        } else {
          text = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${bullet}`;
        }
        this.atomicWrite(p, text);
      });
    } catch (err) {
      txn.release();
      return this.err((err as Error).message);
    }
    this.invalidate();
    this.audit(`append_journal_bullet :: ${fromJournalDate(date)} - section=${JSON.stringify(section)} - ${content.slice(0, 60)}`);
    try {
      txn.finish();
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    const payload: Record<string, unknown> = { date: fromJournalDate(date), section, bullet: bullet.trim() };
    if (linkMsg) payload.link_warning = linkMsg;
    return this.attachGit(this.ok(payload), txn);
  }

  create_stub(args: Record<string, unknown>): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("create_stub");
    const name = String(args.name ?? "");
    const safe = this.safeName(name);
    if (safe) return this.err(safe);
    const existing = this.findPagePath(name);
    if (existing) return this.err(`Page already exists: ${stem(existing)}. Use update_property or append_contact_log.`, { path: rel(this.root, existing) });
    const newPath = path.join(this.pages, `${name}.md`);
    if (!this.under(newPath, this.pages)) return this.err("path escapes PAGES dir");
    if (pathExists(newPath)) return this.err(`File exists: ${rel(this.root, newPath)}`);
    const pageType = String(args.page_type ?? "person");
    let props: Frontmatter = [["type", pageType], ["confidence", String(args.confidence ?? "low")]];
    if (args.source != null) props.push(["source", String(args.source)]);
    if (args.properties && typeof args.properties === "object" && !Array.isArray(args.properties)) {
      for (const [k, v] of Object.entries(args.properties as Record<string, unknown>)) props = this.propsSet(props, k, String(v));
    }
    const warnings: string[] = [];
    const forcedKeys: string[] = [];
    for (const [k] of props) {
      const [ok, msg, forced] = this.checkSchema(k, Boolean(args.force));
      if (!ok) return this.err(msg!);
      if (msg) warnings.push(msg);
      if (forced) forcedKeys.push(k);
    }
    const notes = Array.isArray(args.notes) ? args.notes.map(String) : [];
    const linkWarnings: string[] = [];
    if (pageType !== "redirect") {
      const bundle = [args.source == null ? "" : String(args.source), ...Object.values((args.properties ?? {}) as Record<string, unknown>).map(String), ...notes].join("\n");
      const [linkOk, linkMsg, dangling] = this.checkLinksResolve(bundle, Boolean(args.allow_dangling));
      if (!linkOk) return this.err(linkMsg!, { dangling_targets: dangling });
      if (linkMsg) linkWarnings.push(linkMsg);
    }
    const body = notes.length ? `${notes.map((n) => `- ${n}`).join("\n")}\n` : "";
    let txn: GitTxn;
    try {
      txn = this.beginTxn("create_stub");
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    try {
      fs.mkdirSync(this.pages, { recursive: true });
      this.withLock(newPath, () => this.atomicWrite(newPath, this.joinFrontmatter(props, body)));
    } catch (err) {
      txn.release();
      return this.err((err as Error).message);
    }
    this.invalidate();
    this.audit(`create_stub :: ${name} (${pageType}) - confidence=${String(args.confidence ?? "low")} - source=${JSON.stringify(args.source ?? null)}`);
    if (forcedKeys.length) this.audit(`FORCE_SCHEMA_BYPASS :: create_stub - ${forcedKeys.join(", ")}`);
    try {
      txn.finish();
    } catch (err) {
      return this.err((err as Error).message, { git_guard: (err as GitGuardError).payload });
    }
    const payload: Record<string, unknown> = { name, path: rel(this.root, newPath) };
    if (warnings.length) payload.schema_warnings = warnings;
    if (linkWarnings.length) payload.link_warning = linkWarnings[0];
    return this.attachGit(this.ok(payload), txn);
  }

  rename_page(oldName: string, newName: string, leaveRedirect = true): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("rename_page");
    let err = this.safeName(oldName, "old_name");
    if (err) return this.err(err);
    err = this.safeName(newName, "new_name");
    if (err) return this.err(err);
    const src = this.findPagePath(oldName);
    if (!src) return this.err(`Page not found: ${oldName}`);
    const sl = this.rejectSymlink(src);
    if (sl) return sl;
    const dst = path.join(this.pages, `${newName}.md`);
    if (!this.under(dst, this.pages)) return this.err("destination path escapes PAGES dir");
    if (pathExists(dst) && fs.realpathSync.native(dst) !== fs.realpathSync.native(src)) return this.err(`Destination exists: ${newName}`);
    if (this.isUnsafeCaseOnlyRename(src, dst)) {
      return this.err("case-only rename on case-insensitive filesystem is unsafe; rename to a different intermediate first, then to the desired case");
    }
    let txn: GitTxn;
    try {
      txn = this.beginTxn("rename_page", 3, 1);
    } catch (e) {
      return this.err((e as Error).message, { git_guard: (e as GitGuardError).payload });
    }
    try {
      this.withLock(src, () => {
        const content = readText(src);
        const same = pathExists(dst) && fs.realpathSync.native(src) === fs.realpathSync.native(dst);
        try {
          this.atomicWrite(dst, content);
          if (!same) {
            if (leaveRedirect) {
              const stub = `type:: redirect\nredirects-to:: [[${newName}]]\n\n- **Redirect:** This page was renamed to [[${newName}]] on ${nowIsoDate()}. Append new content there, not here.\n`;
              this.atomicWrite(src, stub);
            } else {
              fs.unlinkSync(src);
            }
          }
        } catch (renameErr) {
          if (!same) {
            try {
              fs.unlinkSync(dst);
            } catch {
              // best effort
            }
          }
          throw renameErr;
        }
      });
    } catch (e) {
      txn.release();
      return this.err((e as Error).message);
    }
    this.invalidate();
    this.audit(`rename_page :: ${JSON.stringify(oldName)} -> ${JSON.stringify(newName)} (redirect=${leaveRedirect})`);
    try {
      txn.finish();
    } catch (e) {
      return this.err((e as Error).message, { git_guard: (e as GitGuardError).payload });
    }
    return this.attachGit(this.ok({ old_name: oldName, new_name: newName, leave_redirect: leaveRedirect, path: rel(this.root, dst) }), txn);
  }

  private isUnsafeCaseOnlyRename(src: string, dst: string): boolean {
    if (path.basename(src) === path.basename(dst)) return false;
    if (path.basename(src).toLowerCase() !== path.basename(dst).toLowerCase()) return false;
    if (!pathExists(dst)) return false;
    try {
      return fs.realpathSync.native(src) === fs.realpathSync.native(dst);
    } catch {
      return false;
    }
  }

  delete_page(name: string, forceIfBacklinks = false): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("delete_page");
    const [pageErr, p] = this.readWritePage(name);
    if (pageErr) return pageErr;
    if (fs.realpathSync.native(p) === fs.realpathSync.native(this.schemaFile)) return this.err("cannot delete schema page");
    const bl = this.backlinks({ name, include_aliases: false, mode: "summary", limit: 1000 });
    const backlinkCount = bl.ok ? Number(bl.count ?? 0) : 0;
    if (backlinkCount > 0 && !forceIfBacklinks) return this.err(`page has ${backlinkCount} backlinks; pass force_if_backlinks=True to delete anyway or rename_page with a redirect instead`, { backlink_count: backlinkCount });
    const now = new Date();
    const archiveDir = path.join(this.root, "archive", String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"));
    const plannedArchiveRel = this.activeWriteIntent?.effects.find((effect) => effect.effect_type === "delete_page_archive")?.path ?? null;
    let archivePath = plannedArchiveRel ? path.join(this.root, plannedArchiveRel) : path.join(archiveDir, path.basename(p));
    if (!this.under(archivePath, path.join(this.root, "archive"))) return this.err("archive path escapes archive dir");
    let txn: GitTxn;
    try {
      txn = this.beginTxn("delete_page", 3, 1);
    } catch (e) {
      return this.err((e as Error).message, { git_guard: (e as GitGuardError).payload });
    }
    try {
      this.withLock(p, () => {
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        if (pathExists(archivePath)) {
          if (plannedArchiveRel) throw new Error(`planned archive target already exists: ${rel(this.root, archivePath)}`);
          archivePath = path.join(archiveDir, `${stem(p)}.${uniqueId().slice(0, 8)}.md`);
        }
        fs.renameSync(p, archivePath);
      });
    } catch (e) {
      txn.release();
      return this.err((e as Error).message);
    }
    this.invalidate();
    this.audit(`delete_page :: ${stem(p)} -> ${rel(this.root, archivePath)} (had ${backlinkCount} backlinks)`);
    try {
      txn.finish();
    } catch (e) {
      return this.err((e as Error).message, { git_guard: (e as GitGuardError).payload });
    }
    return this.attachGit(this.ok({ deleted_path: rel(this.root, p), archived_path: rel(this.root, archivePath), backlink_count: backlinkCount }), txn);
  }

  update_body_section(args: Record<string, unknown>): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("update_body_section");
    const name = String(args.name ?? "");
    const anchor = String(args.anchor ?? "");
    const mode = String(args.mode ?? "replace_block");
    if (!anchor) return this.err("anchor is required");
    const safe = this.safeName(name);
    if (safe) return this.err(safe);
    const valid = new Set(["replace_block", "append_to_section", "prepend_to_section", "delete_block"]);
    if (!valid.has(mode)) return this.err(`mode must be one of ${JSON.stringify(Array.from(valid).sort())}, got ${JSON.stringify(mode)}`);
    let newContent = args.new_content == null ? undefined : String(args.new_content);
    let linkMsg: string | null = null;
    if (mode === "delete_block") {
      if (newContent != null && newContent !== "") return this.err("new_content must be omitted or empty for mode='delete_block'");
      newContent = "";
    } else {
      if (newContent == null) return this.err(`new_content is required for mode=${JSON.stringify(mode)}`);
      const [linkOk, lm, dangling] = this.checkLinksResolve(newContent, Boolean(args.allow_dangling));
      if (!linkOk) return this.err(lm!, { dangling_targets: dangling });
      linkMsg = lm;
    }
    const [pageErr, p] = this.readWritePage(name);
    if (pageErr) return pageErr;
    let txn: GitTxn;
    try {
      txn = this.beginTxn("update_body_section");
    } catch (e) {
      return this.err((e as Error).message, { git_guard: (e as GitGuardError).payload });
    }
    let blockLinesRemoved = 0;
    let linesAdded = 0;
    let anchorLineText = "";
    let early: ToolResult | null = null;
    try {
      this.withLock(p, () => {
        const [props, body] = this.splitFrontmatter(readText(p));
        const bodyLines = body.split("\n");
        const matches = bodyLines.map((line, i) => line.includes(anchor) ? i : -1).filter((i) => i >= 0);
        if (!matches.length) {
          early = this.err(`anchor not found in body: ${JSON.stringify(anchor)}`);
          return;
        }
        if (matches.length > 1) {
          early = this.err(`anchor matched ${matches.length} lines; pass a more specific substring`, { match_count: matches.length, candidates: matches.slice(0, 10).map((i) => ({ line_no: i + 1, snippet: bodyLines[i]!.trim().slice(0, 120) })) });
          return;
        }
        const anchorIdx = matches[0]!;
        const anchorLine = bodyLines[anchorIdx]!;
        anchorLineText = anchorLine;
        const anchorIndent = anchorLine.length - anchorLine.replace(/^\t+/, "").length;
        let blockEnd = anchorIdx + 1;
        while (blockEnd < bodyLines.length) {
          const line = bodyLines[blockEnd]!;
          if (!line.trimEnd()) {
            blockEnd += 1;
            continue;
          }
          const indent = line.length - line.replace(/^\t+/, "").length;
          if (indent <= anchorIndent) break;
          blockEnd += 1;
        }
        while (blockEnd > anchorIdx + 1 && !bodyLines[blockEnd - 1]!.trimEnd()) blockEnd -= 1;
        let newLines = newContent ? newContent.split("\n") : [];
        if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
        if (mode === "replace_block") {
          blockLinesRemoved = blockEnd - anchorIdx;
          bodyLines.splice(anchorIdx, blockLinesRemoved, ...newLines);
          linesAdded = newLines.length;
        } else if (mode === "append_to_section") {
          bodyLines.splice(blockEnd, 0, ...newLines);
          linesAdded = newLines.length;
        } else if (mode === "prepend_to_section") {
          bodyLines.splice(anchorIdx + 1, 0, ...newLines);
          linesAdded = newLines.length;
        } else {
          blockLinesRemoved = blockEnd - anchorIdx;
          bodyLines.splice(anchorIdx, blockLinesRemoved);
        }
        this.atomicWrite(p, this.joinFrontmatter(props, bodyLines.join("\n")));
      });
    } catch (e) {
      txn.release();
      return this.err((e as Error).message);
    }
    if (early) {
      txn.release();
      return early;
    }
    this.invalidate();
    this.audit(`update_body_section :: ${stem(p)} - ${mode} - anchor=${JSON.stringify(anchor.replace(/[\r\n\t]+/g, " ").slice(0, 80))} - -${blockLinesRemoved} +${linesAdded}`);
    try {
      txn.finish();
    } catch (e) {
      return this.err((e as Error).message, { git_guard: (e as GitGuardError).payload });
    }
    const payload: Record<string, unknown> = { name: stem(p), mode, anchor_line: anchorLineText.trim().slice(0, 200), block_lines_removed: blockLinesRemoved, lines_added: linesAdded };
    if (linkMsg) payload.link_warning = linkMsg;
    return this.attachGit(this.ok(payload), txn);
  }

  private regenerateIndexNative(): { returncode: number; stdout: string; stderr: string } {
    const generatedDir = path.join(this.root, "generated");
    const indexPath = path.join(generatedDir, "graph_index.json");
    const pages: Record<string, Record<string, unknown>> = {};
    for (const pagePath of this.allPagePaths().sort()) {
      const name = stem(pagePath);
      const slug = this.slugify(name);
      const text = readText(pagePath);
      const [propsList, body] = this.splitFrontmatter(text);
      const properties = this.propsDict(propsList);
      pages[slug] = {
        name,
        path: rel(this.root, pagePath),
        type: properties.type ?? "",
        status: properties.status ?? "",
        last_contacted: properties["last-contacted"] ?? "",
        properties,
        out_edges: this.extractWikilinkTargets(`${propsList.map(([k, v]) => `${k}:: ${v}`).join("\n")}\n${body}`),
        mtime: new Date(mtimeMs(pagePath)).toISOString(),
      };
    }
    const journals = pathExists(this.journals)
      ? listMarkdown(this.journals).filter((p) => this.safeGraphFile(p, this.journals)).map((p) => ({
        date: fromJournalDate(stem(p)),
        path: rel(this.root, p),
        mtime: new Date(mtimeMs(p)).toISOString(),
      }))
      : [];
    const index = {
      schema_version: 1,
      generated_by: "logseq-graph-mcp",
      generated_at: new Date().toISOString(),
      root_name: path.basename(this.root),
      totals: {
        pages: Object.keys(pages).length,
        journals: journals.length,
      },
      pages,
      journals,
    };
    fs.mkdirSync(generatedDir, { recursive: true });
    this.atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    return {
      returncode: 0,
      stdout: `wrote ${rel(this.root, indexPath)} (${Object.keys(pages).length} pages, ${journals.length} journals)`,
      stderr: "",
    };
  }

  regenerate_index(): ToolResult {
    if (this.readonlyMode) return this.readonlyErr("regenerate_index");
    let txn: GitTxn;
    try {
      txn = this.beginTxn("regenerate_index", 5, 0);
    } catch (e) {
      return this.err((e as Error).message, { git_guard: (e as GitGuardError).payload });
    }
    let result: { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer } | { returncode: number; stdout: string; stderr: string };
    if (pathExists(this.regen) && this.allowExternalRegen) {
      const python = process.env.LOGSEQ_PYTHON ?? "python3";
      result = spawnSync(python, [this.regen], { cwd: this.root, encoding: "utf8", timeout: 60000 });
    } else {
      try {
        result = this.regenerateIndexNative();
      } catch (err) {
        txn.release();
        if (txn.beforeHead) {
          this.git(["reset", "--hard", txn.beforeHead], 60000);
          this.git(["clean", "-fd", "--", "generated", "data"], 60000);
        }
        return this.err(`native regenerator failed: ${(err as Error).message}`);
      }
    }
    const status = "returncode" in result ? result.returncode : result.status;
    const stdoutText = String(result.stdout ?? "").trim();
    const stderrText = String(result.stderr ?? "").trim();
    if (status !== 0) {
      txn.release();
      if (txn.beforeHead) {
        this.git(["reset", "--hard", txn.beforeHead], 60000);
        this.git(["clean", "-fd", "--", "generated", "data"], 60000);
      }
      return this.err(`regenerator exited ${status}`, { returncode: status, stdout: stdoutText, stderr: stderrText });
    }
    try {
      txn.finish();
    } catch (e) {
      return this.err((e as Error).message, { git_guard: (e as GitGuardError).payload });
    }
    return this.attachGit(this.ok({
      returncode: status,
      stdout: stdoutText,
      stderr: stderrText,
      mode: pathExists(this.regen) && this.allowExternalRegen ? "external_python" : "native",
      external_regenerator_present: pathExists(this.regen),
      external_regenerator_allowed: this.allowExternalRegen,
    }), txn);
  }
}
