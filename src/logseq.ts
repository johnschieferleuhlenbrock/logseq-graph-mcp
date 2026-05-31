import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PersistentGraphCache, fingerprintKey, pageFingerprint } from "./graph/cache.js";
import { isFile, isPathUnder, isSymlink, listMarkdown, mtimeMs, pathExists, readText, relativeGraphPath as rel, stem } from "./graph/files.js";
import { GitGuardError, GitTxn } from "./graph/git-guard.js";
import { FENCE_RE, INLINE_CODE_RE, WIKILINK_RE, extractWikilinkTargets } from "./graph/links.js";
import { SAFE_DATE_RE, fromJournalDate, normalizeNamespaceName, parseIsoDate as parseDate, safePageName, slugifyPageName, toJournalDate } from "./graph/names.js";
import { PROP_RE, joinFrontmatter, propsDelete, propsDict, propsSet, splitFrontmatter } from "./graph/properties.js";
import { GraphWatcher } from "./graph/watch.js";
import { atomicWriteFileSync, withFileLock } from "./graph/write-guards.js";
import { TOOL_DEFINITIONS } from "./tool-schemas.js";
import { compileSearchRegex, regexEngineName } from "./tools/search.js";
import type { Frontmatter, GraphNode, StatusEntry, ToolDefinition, ToolResult } from "./types.js";

const META_TYPES = new Set(["schema", "query", "runbook", "glossary"]);

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
  private readonly watcher: GraphWatcher | null;

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
    this.watcher = (env.LOGSEQ_WATCH ?? "1") === "0"
      ? null
      : new GraphWatcher([this.pages, this.journals], () => this.invalidate());
  }

  toolDefinitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  tools(): Record<string, (args: Record<string, unknown>) => ToolResult> {
    return {
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
    return withFileLock(targetPath, timeoutMs === 5000 ? this.lockTimeoutMs : timeoutMs, fn);
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
    const jpath = path.join(this.journals, `${toJournalDate(nowIsoDate())}.md`);
    const stamp = `\t- ${localTimeHHMM()} · ${safeLine}\n`;
    try {
      fs.mkdirSync(this.journals, { recursive: true });
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
    const allowed = new Set(["rev-parse", "log", "status", "add", "commit", "reset", "clean"]);
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

  gitStatusEntries(): StatusEntry[] {
    const r = this.git(["status", "--porcelain=v1", "-z"], 20000);
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
    const txn = new GitTxn(this, tool, maxChangedFiles, maxDeletedFiles, uniqueId);
    txn.begin();
    return txn;
  }

  private attachGit(response: ToolResult, txn: GitTxn): ToolResult {
    if (txn.commit) response.git_guard = txn.payload();
    return response;
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
      schema_mode: this.schemaMode,
      git_guard_mode: this.gitGuardMode,
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
    let archivePath = path.join(archiveDir, path.basename(p));
    if (!this.under(archivePath, path.join(this.root, "archive"))) return this.err("archive path escapes archive dir");
    let txn: GitTxn;
    try {
      txn = this.beginTxn("delete_page", 2, 1);
    } catch (e) {
      return this.err((e as Error).message, { git_guard: (e as GitGuardError).payload });
    }
    try {
      this.withLock(p, () => {
        fs.mkdirSync(archiveDir, { recursive: true });
        if (pathExists(archivePath)) archivePath = path.join(archiveDir, `${stem(p)}.${uniqueId().slice(0, 8)}.md`);
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
