import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { ToolResult } from "../types.js";

export const WRITE_INTENT_STATES = [
  "accepted",
  "pending",
  "applying",
  "applied_uncommitted",
  "committed",
  "completed",
  "failed_retryable",
  "failed_terminal",
  "manual_review",
  "cancelled",
  "reconciling",
] as const;

export type WriteIntentState = typeof WRITE_INTENT_STATES[number];

export type WriteIntentEffect = {
  path: string;
  effect_type: string;
  before_hash: string | null;
  after_hash?: string | null;
  expected_base_hash: string | null;
  applied_marker?: string | null;
};

export type WriteIntentRecord = {
  op_id: string;
  idempotency_key: string;
  request_hash: string;
  tool: string;
  canonical_args_json: string;
  caller: string;
  state: WriteIntentState;
  state_version: number;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  accepted_at: string;
  started_at: string | null;
  server_deadline_at: string | null;
  applied_at: string | null;
  committed_at: string | null;
  completed_at: string | null;
  git_before_head: string | null;
  git_commit: string | null;
  response_json: string | null;
  last_error_class: string | null;
  last_error: string | null;
  manual_reason: string | null;
  expires_at: string | null;
  expected_base_head: string | null;
};

export type SubmitIntentInput = {
  idempotencyKey: string;
  tool: string;
  canonicalArgs: Record<string, unknown>;
  caller: string;
  expectedBaseHead: string | null;
  expiresAt: string | null;
  gitBeforeHead: string;
  effects: WriteIntentEffect[];
  preview: Record<string, unknown>;
};

export type LedgerCounts = {
  by_state: Record<string, number>;
  oldest_pending_age_seconds: number | null;
  applying_count: number;
  stale_applying_count: number;
  manual_review_count: number;
};

const SCHEMA_VERSION = 1;
const INTENT_ID_BYTES = 8;

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function fileSha256(filePath: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function rowToRecord(row: unknown): WriteIntentRecord {
  return row as WriteIntentRecord;
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export class WriteIntentLedger {
  readonly ledgerFile: string;
  private readonly db: Database.Database;

  constructor(cacheFile: string) {
    const parsed = path.parse(cacheFile);
    this.ledgerFile = path.join(parsed.dir, `${parsed.name}.operations.sqlite`);
    fs.mkdirSync(path.dirname(this.ledgerFile), { recursive: true });
    this.db = new Database(this.ledgerFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  submit(input: SubmitIntentInput): { record: WriteIntentRecord; duplicate: boolean; conflict: boolean; preview: Record<string, unknown> } {
    const scope = this.scope(input.caller, input.tool, input.idempotencyKey);
    const requestPayload = {
      graph_scope: scope.graph,
      caller: input.caller,
      tool: input.tool,
      arguments: input.canonicalArgs,
      expected_base_head: input.expectedBaseHead,
      expires_at: input.expiresAt,
    };
    const requestHash = sha256(canonicalizeJson(requestPayload));
    const existing = this.getByIdempotency(scope.key);
    if (existing) {
      return {
        record: existing,
        duplicate: existing.request_hash === requestHash,
        conflict: existing.request_hash !== requestHash,
        preview: parseJsonRecord(existing.response_json).preview as Record<string, unknown> ?? {},
      };
    }

    const opId = crypto.randomBytes(INTENT_ID_BYTES).toString("hex");
    const acceptedAt = nowIso();
    const canonicalArgsJson = canonicalizeJson(input.canonicalArgs);
    const responseJson = JSON.stringify({
      intent_id: opId,
      state: "pending",
      request_hash: requestHash,
      tool: input.tool,
      arguments: input.canonicalArgs,
      preview: input.preview,
    });

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO operations (
          op_id, idempotency_key, request_hash, tool, canonical_args_json, caller, state,
          state_version, attempt_count, accepted_at, git_before_head, response_json,
          expires_at, expected_base_head
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, 0, ?, ?, ?, ?, ?)
      `).run(opId, scope.key, requestHash, input.tool, canonicalArgsJson, input.caller, acceptedAt, input.gitBeforeHead, responseJson, input.expiresAt, input.expectedBaseHead);
      this.insertEvent(opId, null, "pending", "submit", input.caller, { preview: input.preview, request_hash: requestHash });
      for (const effect of input.effects) this.insertEffect(opId, effect);
    });
    tx();
    return { record: this.get(opId)!, duplicate: false, conflict: false, preview: input.preview };
  }

  get(id: string): WriteIntentRecord | null {
    const row = this.db.prepare("SELECT * FROM operations WHERE op_id = ?").get(id);
    return row ? rowToRecord(row) : null;
  }

  getByIdempotency(idempotencyKey: string): WriteIntentRecord | null {
    const row = this.db.prepare("SELECT * FROM operations WHERE idempotency_key = ?").get(idempotencyKey);
    return row ? rowToRecord(row) : null;
  }

  list(states: string[], limit: number, offset: number): WriteIntentRecord[] {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const boundedOffset = Math.max(0, offset);
    if (states.length) {
      const placeholders = states.map(() => "?").join(", ");
      return this.db.prepare(`SELECT * FROM operations WHERE state IN (${placeholders}) ORDER BY accepted_at DESC LIMIT ? OFFSET ?`)
        .all(...states, boundedLimit, boundedOffset)
        .map(rowToRecord);
    }
    return this.db.prepare("SELECT * FROM operations ORDER BY accepted_at DESC LIMIT ? OFFSET ?")
      .all(boundedLimit, boundedOffset)
      .map(rowToRecord);
  }

  effects(opId: string): WriteIntentEffect[] {
    return this.db.prepare("SELECT path, effect_type, before_hash, after_hash, expected_base_hash, applied_marker FROM operation_effects WHERE op_id = ? ORDER BY id")
      .all(opId)
      .map((row) => row as WriteIntentEffect);
  }

  counts(): LedgerCounts {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS count FROM operations GROUP BY state").all() as Array<{ state: string; count: number }>;
    const byState: Record<string, number> = {};
    for (const row of rows) byState[row.state] = row.count;
    const oldest = this.db.prepare("SELECT accepted_at FROM operations WHERE state IN ('pending', 'failed_retryable') ORDER BY accepted_at ASC LIMIT 1").get() as { accepted_at?: string } | undefined;
    const applyingRow = this.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE state IN ('applying', 'applied_uncommitted', 'reconciling')").get() as { count?: number } | undefined;
    const applying = Number(applyingRow?.count ?? 0);
    const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const staleRow = this.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE state IN ('applying', 'applied_uncommitted', 'reconciling') AND COALESCE(lease_expires_at, started_at, accepted_at) < ?").get(staleCutoff) as { count?: number } | undefined;
    const stale = Number(staleRow?.count ?? 0);
    const manualRow = this.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE state = 'manual_review'").get() as { count?: number } | undefined;
    const manual = Number(manualRow?.count ?? 0);
    return {
      by_state: byState,
      oldest_pending_age_seconds: oldest?.accepted_at ? Math.max(0, Math.round((Date.now() - Date.parse(oldest.accepted_at)) / 1000)) : null,
      applying_count: applying,
      stale_applying_count: stale,
      manual_review_count: manual,
    };
  }

  cancel(opId: string, actor: string): ToolResult {
    const record = this.get(opId);
    if (!record) return { ok: false, error: `write intent not found: ${opId}` };
    if (!["pending", "failed_retryable", "manual_review"].includes(record.state)) {
      return { ok: false, error: `cannot cancel write intent in state ${record.state}`, intent: publicRecord(record) };
    }
    this.transition(opId, "cancelled", actor, "cancel", {}, { completed_at: nowIso() });
    return { ok: true, intent: publicRecord(this.get(opId)!) };
  }

  start(record: WriteIntentRecord, leaseMs: number): WriteIntentRecord {
    const now = nowIso();
    const lease = new Date(Date.now() + leaseMs).toISOString();
    this.transition(record.op_id, "applying", "server", "flush_start", {}, {
      attempt_count: record.attempt_count + 1,
      started_at: now,
      lease_owner: `${os.hostname()}:${process.pid}`,
      lease_expires_at: lease,
      server_deadline_at: lease,
      last_error_class: null,
      last_error: null,
      manual_reason: null,
    });
    return this.get(record.op_id)!;
  }

  claimForFlush(record: WriteIntentRecord, leaseMs: number): { record: WriteIntentRecord; claimed: boolean } {
    const now = nowIso();
    const lease = new Date(Date.now() + leaseMs).toISOString();
    const nextVersion = record.state_version + 1;
    const tx = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE operations
        SET state = 'applying',
            state_version = ?,
            attempt_count = attempt_count + 1,
            started_at = ?,
            lease_owner = ?,
            lease_expires_at = ?,
            server_deadline_at = ?,
            last_error_class = NULL,
            last_error = NULL,
            manual_reason = NULL
        WHERE op_id = ?
          AND state_version = ?
          AND state IN ('pending', 'failed_retryable')
      `).run(nextVersion, now, `${os.hostname()}:${process.pid}`, lease, lease, record.op_id, record.state_version);
      if (result.changes === 1) {
        this.insertEvent(record.op_id, record.state, "applying", "flush_start", "server", {});
        return true;
      }
      return false;
    });
    const claimed = tx();
    return { record: this.get(record.op_id)!, claimed };
  }

  markRetryable(record: WriteIntentRecord, errorClass: string, error: string): WriteIntentRecord {
    this.transition(record.op_id, "failed_retryable", "server", errorClass, { error }, {
      last_error_class: errorClass,
      last_error: error,
      lease_owner: null,
      lease_expires_at: null,
    });
    return this.get(record.op_id)!;
  }

  markPending(record: WriteIntentRecord, reason: string, evidence: Record<string, unknown> = {}): WriteIntentRecord {
    this.transition(record.op_id, "pending", "server", reason, evidence, {
      lease_owner: null,
      lease_expires_at: null,
      last_error_class: null,
      last_error: null,
      manual_reason: null,
    });
    return this.get(record.op_id)!;
  }

  markReconciling(record: WriteIntentRecord, reason: string, evidence: Record<string, unknown> = {}): WriteIntentRecord {
    this.transition(record.op_id, "reconciling", "server", reason, evidence, {
      last_error_class: "reconciling",
      last_error: reason,
    });
    return this.get(record.op_id)!;
  }

  markTerminal(record: WriteIntentRecord, errorClass: string, error: string): WriteIntentRecord {
    this.transition(record.op_id, "failed_terminal", "server", errorClass, { error }, {
      last_error_class: errorClass,
      last_error: error,
      completed_at: nowIso(),
      lease_owner: null,
      lease_expires_at: null,
    });
    return this.get(record.op_id)!;
  }

  markManual(record: WriteIntentRecord, reason: string, evidence: Record<string, unknown> = {}): WriteIntentRecord {
    this.transition(record.op_id, "manual_review", "server", "manual_review", evidence, {
      manual_reason: reason,
      last_error_class: "manual_review",
      last_error: reason,
      lease_owner: null,
      lease_expires_at: null,
    });
    return this.get(record.op_id)!;
  }

  markAppliedUncommitted(record: WriteIntentRecord, effects: WriteIntentEffect[]): WriteIntentRecord {
    const now = nowIso();
    const tx = this.db.transaction(() => {
      for (const effect of effects) {
        this.db.prepare(`
          UPDATE operation_effects SET after_hash = ?, observed_at = ?
          WHERE op_id = ? AND path = ? AND effect_type = ?
        `).run(effect.after_hash ?? null, now, record.op_id, effect.path, effect.effect_type);
      }
      this.transition(record.op_id, "applied_uncommitted", "server", "applied", { effects }, { applied_at: now });
    });
    tx();
    return this.get(record.op_id)!;
  }

  markCompleted(record: WriteIntentRecord, response: ToolResult, gitCommit: string | null, reconciled = false): WriteIntentRecord {
    const now = nowIso();
    const current = this.get(record.op_id);
    if (!current) throw new Error(`write intent not found: ${record.op_id}`);
    if (!gitCommit) {
      this.transition(record.op_id, "completed", "server", reconciled ? "reconciled" : "complete", { git_commit: null, response }, {
        response_json: JSON.stringify(response),
        completed_at: now,
        lease_owner: null,
        lease_expires_at: null,
        last_error_class: null,
        last_error: null,
      });
      return this.get(record.op_id)!;
    }
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE operations SET state = ?, state_version = ?, git_commit = ?, committed_at = ?,
          response_json = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_class = NULL, last_error = NULL
        WHERE op_id = ?
      `).run("committed", current.state_version + 1, gitCommit, now, JSON.stringify(response), record.op_id);
      this.insertEvent(record.op_id, current.state, "committed", reconciled ? "reconciled" : "commit", "server", { git_commit: gitCommit, response });
      this.db.prepare(`
        UPDATE operations SET state = ?, state_version = ?, completed_at = ?
        WHERE op_id = ?
      `).run("completed", current.state_version + 2, now, record.op_id);
      this.insertEvent(record.op_id, "committed", "completed", "complete", "server", { git_commit: gitCommit });
    });
    tx();
    return this.get(record.op_id)!;
  }

  recoverExpired(): WriteIntentRecord[] {
    const now = nowIso();
    const expired = this.db.prepare(`
      SELECT * FROM operations
      WHERE state IN ('applying', 'applied_uncommitted', 'reconciling')
        AND COALESCE(lease_expires_at, started_at, accepted_at) < ?
    `).all(now).map(rowToRecord);
    const records: WriteIntentRecord[] = [];
    for (const record of expired) {
      records.push(this.markReconciling(record, "expired_lease", { previous_state: record.state }));
    }
    return records;
  }

  private transition(opId: string, toState: WriteIntentState, actor: string, reason: string, evidence: Record<string, unknown>, fields: Record<string, unknown> = {}): void {
    const current = this.get(opId);
    if (!current) throw new Error(`write intent not found: ${opId}`);
    const nextVersion = current.state_version + 1;
    const assignments = ["state = ?", "state_version = ?"];
    const values: unknown[] = [toState, nextVersion];
    for (const [key, value] of Object.entries(fields)) {
      assignments.push(`${key} = ?`);
      values.push(value);
    }
    values.push(opId);
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE operations SET ${assignments.join(", ")} WHERE op_id = ?`).run(...values);
      this.insertEvent(opId, current.state, toState, reason, actor, evidence);
    });
    tx();
  }

  private insertEvent(opId: string, fromState: string | null, toState: string, reason: string, actor: string, evidence: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO operation_events (op_id, from_state, to_state, reason, actor, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(opId, fromState, toState, reason, actor, JSON.stringify(evidence), nowIso());
  }

  private insertEffect(opId: string, effect: WriteIntentEffect): void {
    this.db.prepare(`
      INSERT INTO operation_effects (op_id, path, effect_type, before_hash, after_hash, expected_base_hash, applied_marker, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(opId, effect.path, effect.effect_type, effect.before_hash, effect.after_hash ?? null, effect.expected_base_hash, effect.applied_marker ?? null, nowIso());
  }

  private scope(caller: string, tool: string, key: string): { graph: string; key: string } {
    const graph = sha256(path.resolve(this.ledgerFile)).slice(0, 16);
    return { graph, key: `${graph}:${caller || "unknown"}:${tool}:${key}` };
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA user_version = ${SCHEMA_VERSION};
      CREATE TABLE IF NOT EXISTS operations (
        op_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        tool TEXT NOT NULL,
        canonical_args_json TEXT NOT NULL,
        caller TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        state_version INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        accepted_at TEXT NOT NULL,
        started_at TEXT,
        server_deadline_at TEXT,
        applied_at TEXT,
        committed_at TEXT,
        completed_at TEXT,
        git_before_head TEXT,
        git_commit TEXT,
        response_json TEXT,
        last_error_class TEXT,
        last_error TEXT,
        manual_reason TEXT,
        expires_at TEXT,
        expected_base_head TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_operations_state ON operations(state, accepted_at);
      CREATE INDEX IF NOT EXISTS idx_operations_git_commit ON operations(git_commit);

      CREATE TABLE IF NOT EXISTS operation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id TEXT NOT NULL REFERENCES operations(op_id) ON DELETE CASCADE,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operation_events_op ON operation_events(op_id, id);

      CREATE TABLE IF NOT EXISTS operation_effects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_id TEXT NOT NULL REFERENCES operations(op_id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        effect_type TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        expected_base_hash TEXT,
        applied_marker TEXT,
        observed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_operation_effects_op ON operation_effects(op_id);
    `);
  }
}

export function publicRecord(record: WriteIntentRecord): Record<string, unknown> {
  return {
    intent_id: record.op_id,
    idempotency_key: record.idempotency_key,
    request_hash: record.request_hash,
    tool: record.tool,
    arguments: JSON.parse(record.canonical_args_json),
    caller: record.caller,
    state: record.state,
    attempt_count: record.attempt_count,
    accepted_at: record.accepted_at,
    started_at: record.started_at,
    applied_at: record.applied_at,
    committed_at: record.committed_at,
    completed_at: record.completed_at,
    git_before_head: record.git_before_head,
    git_commit: record.git_commit,
    last_error_class: record.last_error_class,
    last_error: record.last_error,
    manual_reason: record.manual_reason,
    expires_at: record.expires_at,
    expected_base_head: record.expected_base_head,
  };
}
