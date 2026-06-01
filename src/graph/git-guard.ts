import fs from "node:fs";
import path from "node:path";
import type { StatusEntry } from "../types.js";
import { LockHandle, sleepMs } from "./write-guards.js";

export class GitGuardError extends Error {
  payload: Record<string, unknown>;

  constructor(message: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.payload = payload;
  }
}

export type GitGuardHost = {
  readonly root: string;
  readonly gitGuardMode: string;
  readonly gitCommitAuthor: string;
  gitInsideWorktree(): boolean;
  gitHead(): string;
  gitStatusEntries(): StatusEntry[];
  gitOk(args: string[], timeoutMs?: number): string;
  statusSummary(entries: StatusEntry[], limit?: number): string[];
};

export class GitTxn {
  readonly txnId: string;
  beforeHead = "";
  commit: string | null = null;
  changed: StatusEntry[] = [];
  violation: string | null = null;
  private lock: LockHandle | null = null;

  constructor(
    private readonly server: GitGuardHost,
    private readonly tool: string,
    private readonly maxChangedFiles: number,
    private readonly maxDeletedFiles: number,
    makeTxnId: () => string,
  ) {
    this.txnId = makeTxnId();
  }

  begin(): void {
    if (this.server.gitGuardMode === "off") return;
    if (!this.server.gitInsideWorktree()) {
      const msg = `Git guard is enabled but ${this.server.root} is not a Git worktree`;
      if (this.server.gitGuardMode === "warn") {
        console.error(`[logseq-mcp] git guard warning: ${msg}`);
        return;
      }
      throw new GitGuardError(msg);
    }
    const lockPath = path.join(this.server.root, ".mcp-git-guard.lock");
    const deadline = Date.now() + 60000;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lockPath, "wx", 0o644);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > deadline) throw err;
        sleepMs(50);
      }
    }
    this.lock = new LockHandle(lockPath, fd);
    try {
      this.beforeHead = this.server.gitHead();
      const dirty = this.server.gitStatusEntries();
      if (dirty.length) {
        const msg = "Git guard requires a clean Logseq graph before MCP writes. Commit or stash current graph changes first.";
        const payload = {
          mode: this.server.gitGuardMode,
          txn_id: this.txnId,
          before_head: this.beforeHead,
          dirty_count: dirty.length,
          dirty_sample: this.server.statusSummary(dirty),
        };
        if (this.server.gitGuardMode === "warn") console.error(`[logseq-mcp] git guard warning: ${msg} ${JSON.stringify(payload)}`);
        else {
          this.release();
          throw new GitGuardError(msg, payload);
        }
      }
    } catch (err) {
      this.release();
      throw err;
    }
  }

  finish(): void {
    if (this.server.gitGuardMode === "off") return;
    try {
      if (!this.server.gitInsideWorktree()) return;
      this.changed = this.server.gitStatusEntries();
      if (!this.changed.length) return;
      const deleted = this.changed.filter((e) => e.status.includes("D"));
      const violations: string[] = [];
      if (this.changed.length > this.maxChangedFiles) violations.push(`Git guard blast-radius violation: ${this.changed.length} files changed (limit ${this.maxChangedFiles})`);
      if (deleted.length > this.maxDeletedFiles) violations.push(`Git guard delete violation: ${deleted.length} files deleted (limit ${this.maxDeletedFiles})`);
      const pathspecs = Array.from(new Set(this.changed.flatMap((e) => [e.path, e.old_path]).filter(Boolean))).sort();
      if (violations.length) {
        this.violation = violations.join("; ");
        if (this.server.gitGuardMode !== "warn") {
          this.rollbackChanged(this.changed);
          throw new GitGuardError(this.violation, this.payload());
        }
        console.error(`[logseq-mcp] git guard warning: ${this.violation} ${JSON.stringify(this.payload())}`);
      }
      this.server.gitOk(["add", "-A", "--", ...pathspecs], 60000);
      const subject = `mcp-logseq: ${this.tool} ${this.txnId}`;
      const messageArgs = [
        "commit",
        "--author",
        this.server.gitCommitAuthor,
        "-m",
        subject,
        "-m",
        `tool: ${this.tool}`,
        "-m",
        `txn_id: ${this.txnId}`,
        "-m",
        `before_head: ${this.beforeHead}`,
        "-m",
        `changed_files: ${this.changed.length}`,
      ];
      if (this.violation) messageArgs.push("-m", `guard_violation: ${this.violation}`);
      messageArgs.push("--", ...pathspecs);
      this.server.gitOk(messageArgs, 60000);
      this.commit = this.server.gitHead();
    } finally {
      this.release();
    }
  }

  release(): void {
    if (this.lock) {
      this.lock.release();
      this.lock = null;
    }
  }

  private rollbackChanged(entries: StatusEntry[]): void {
    const tracked = Array.from(new Set(entries
      .filter((entry) => entry.status !== "??")
      .flatMap((entry) => [entry.path, entry.old_path])
      .filter(Boolean))).sort();
    const untracked = Array.from(new Set(entries
      .filter((entry) => entry.status === "??")
      .map((entry) => entry.path)
      .filter(Boolean))).sort();
    if (tracked.length) this.server.gitOk(["restore", "--source", this.beforeHead || "HEAD", "--", ...tracked], 60000);
    if (untracked.length) this.server.gitOk(["clean", "-f", "--", ...untracked], 60000);
  }

  payload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      mode: this.server.gitGuardMode,
      txn_id: this.txnId,
      before_head: this.beforeHead,
      commit: this.commit,
      changed_files: this.changed.length,
      changed_sample: this.server.statusSummary(this.changed),
    };
    if (this.violation) {
      payload.violation = this.violation;
      payload.rollback_hint = this.beforeHead ? `git -C ${this.server.root} reset --hard ${this.beforeHead}` : "repository had no HEAD before this transaction";
    }
    return payload;
  }
}
