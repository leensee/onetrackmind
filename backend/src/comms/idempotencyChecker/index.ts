// ============================================================
// OTM Comms — idempotencyChecker (Phase 4.1) — IMPURE SURFACE
// CJS module. Executor + link + re-exports of the pure planner
// (mirrors src/orchestration/approvalGate: pure.ts holds the
// deterministic half, index.ts owns the side effects).
//
// Single-writer-per-table: this module owns ALL idempotency_keys
// writes, including the link() backfill; commsLogWriter never
// touches idempotency_keys (Decisions Log 2026-07-09).
//
// Atomicity lives in the executor SQL: the provider-id gate is a
// single INSERT … ON CONFLICT … DO NOTHING RETURNING id — never
// refactor to read→decide→write (it would reintroduce the race
// the schema designed out). The content-hash fallback gate is a
// windowed SELECT then INSERT; its tiny race is accepted by
// design ("degradation, not data loss" — Schema v1.3 rationale).
//
// Observability split (Decisions Log 2026-07-09):
//   novel/duplicate → injected Logger only (info; hot-path-
//   conscious; fields carry contentHash/provenance/provider/ids,
//   NEVER fromIdentifier/toIdentifiers/body).
//   error → return the typed variant AND best-effort-emit a
//   diagnostic event at source (severity 'critical' — pinned here
//   per the Phase-3 rule that the tool, not the caller, determines
//   severity; the governing text's "severity error" is not in the
//   DiagnosticSeverity enum). Emission is awaited inside its own
//   try/catch so a broken adapter can never mask the Logger.error
//   line or the returned variant. The 4.2 wiring adapts
//   DiagnosticEmitter onto logDiagnosticEntry, adding the
//   session-scoped context IDs this pre-triage path doesn't have.
//
// House error rule: operational failures return typed results —
// never throw; the only throw is the impossible-plan-discriminant
// guard (programmer error). All SQL parameterized.
// ============================================================

import { randomUUID } from 'crypto';
import { SqliteClient, DiagnosticSeverity } from '../../orchestration/types';
import { Logger } from '../../observability/logger';
import { CommsProvider, IdempotencyProvenance } from '../../db/schemaConstants';
import { IdempotencyKeyRow, idempotencyKeysToDb } from '../../db/mapping/idempotencyKeys';
import { IdempotencyInput, IdempotencyPlan, IdempotencyResult, planIdempotencyCheck } from './pure';

export * from './pure';

// ── Diagnostics seam ──────────────────────────────────────────

export type IdempotencyOp =
  | 'provider_id_insert'
  | 'provider_id_conflict_fetch'
  | 'content_hash_select'
  | 'content_hash_insert'
  | 'link_update';

// Severity pinned at source; typed against the enum so a vocab
// change breaks compilation here, not silently downstream.
const IDEMPOTENCY_ERROR_SEVERITY = 'critical' satisfies DiagnosticSeverity;

export interface IdempotencyDiagnosticEvent {
  module: 'idempotencyChecker';
  op: IdempotencyOp;
  severity: typeof IDEMPOTENCY_ERROR_SEVERITY;
  /** null for link failures — no plan (and no provider) in scope. */
  provider: CommsProvider | null;
  /** Sanitized error class name only — never message-embedded content. */
  errorClass: string;
  /** SQLite/driver message (binds are never echoed); never from/to/body. */
  detail: string;
}

/** 4.2 wiring adapts this onto logDiagnosticEntry with session context. */
export type DiagnosticEmitter = (event: IdempotencyDiagnosticEvent) => Promise<void>;

export const noopDiagnosticEmitter: DiagnosticEmitter = async () => {};

export interface IdempotencyCheckerDeps {
  db: SqliteClient;
  logger: Logger;
  emitDiagnostic: DiagnosticEmitter;
}

// ── Link result ───────────────────────────────────────────────

export type LinkResult =
  | { ok: true }
  | { ok: false; reason: 'key_not_found' | 'db_error'; detail: string };

// ── SQL (all parameterized) ───────────────────────────────────

const INSERT_KEY_COLUMNS =
  '(id, key_type, provider, key_value, first_seen_at, expires_at, linked_message_id, is_synced)';

// The SOLE provider-id gate — atomic. The conflict target names the
// partial UNIQUE (uq_idempotency_keys_provider_key_value) so ONLY
// that uniqueness conflict is absorbed; CHECK/FK/NOT-NULL still
// throw (INSERT OR IGNORE would swallow them — never use it here).
const SQL_PROVIDER_ID_GATE = `INSERT INTO idempotency_keys ${INSERT_KEY_COLUMNS}
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (provider, key_value) WHERE key_type = 'provider_id' DO NOTHING
RETURNING id`;

// Partial UNIQUE guarantees ≤1 row; LIMIT 1 is defensive.
const SQL_PROVIDER_ID_DUPLICATE = `SELECT id, linked_message_id FROM idempotency_keys
WHERE key_type = 'provider_id' AND provider = ? AND key_value = ?
LIMIT 1`;

// The SOLE content-hash gate. No provider filter — cross-provider
// identical content dedupes (matches dalConstraints.decideDedup).
// Window inclusive both ends (Δ = exactly 10min ⇒ duplicate,
// mirroring deltaMs <= DEDUP_WINDOW_MS); upper bound <= firstSeenAt
// mirrors decideDedup's Δ >= 0 guard. Lexicographic compare — see
// the single-writer format invariant in pure.ts. If the accepted
// race ever produced two in-window rows, the most recent sighting
// absorbs the duplicate; id tie-break keeps it deterministic.
const SQL_CONTENT_HASH_WINDOW = `SELECT id, linked_message_id FROM idempotency_keys
WHERE key_type = 'content_hash' AND key_value = ?
  AND first_seen_at >= ? AND first_seen_at <= ?
ORDER BY first_seen_at DESC, id
LIMIT 1`;

// Plain INSERT — no unique index covers content_hash keys.
const SQL_CONTENT_HASH_INSERT = `INSERT INTO idempotency_keys ${INSERT_KEY_COLUMNS}
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

// RETURNING id detects key-not-found (run() exposes no changes count).
const SQL_LINK = `UPDATE idempotency_keys SET linked_message_id = ? WHERE id = ? RETURNING id`;

// ── Internal helpers ──────────────────────────────────────────

interface DuplicateRow {
  id: string;
  linked_message_id: string | null;
}

function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** New key row for the plan — randomUUID here is the executor's only nondeterminism. */
function newKeyRow(plan: IdempotencyPlan): IdempotencyKeyRow {
  return idempotencyKeysToDb({
    id: randomUUID(),
    keyType: plan.keyType,
    provider: plan.provider,
    keyValue: plan.keyValue,
    firstSeenAt: plan.firstSeenAt,
    expiresAt: plan.expiresAt,
    linkedMessageId: null,
    isSynced: false,
  });
}

function insertParams(row: IdempotencyKeyRow): unknown[] {
  return [
    row.id,
    row.key_type,
    row.provider,
    row.key_value,
    row.first_seen_at,
    row.expires_at,
    row.linked_message_id,
    row.is_synced,
  ];
}

/**
 * Error-variant funnel: one Logger.error line, then best-effort
 * diagnostic emission (its own try/catch — a rejecting adapter must
 * never mask the log line or replace the returned variant), then
 * the typed result. Never throws.
 */
async function gateFailure(
  deps: IdempotencyCheckerDeps,
  ctx: { provenance: IdempotencyProvenance; provider: CommsProvider; contentHash: string },
  op: IdempotencyOp,
  errorClass: string,
  detail: string,
): Promise<IdempotencyResult> {
  const reason = `${op}: ${detail}`;
  deps.logger.error('idempotency gate error', {
    provenance: ctx.provenance,
    provider: ctx.provider,
    contentHash: ctx.contentHash,
    op,
    errorClass,
    reason,
  });
  try {
    await deps.emitDiagnostic({
      module: 'idempotencyChecker',
      op,
      severity: IDEMPOTENCY_ERROR_SEVERITY,
      provider: ctx.provider,
      errorClass,
      detail,
    });
  } catch {
    // Best-effort by contract — swallowed so emission can never mask the result.
  }
  return { status: 'error', provenance: ctx.provenance, contentHash: ctx.contentHash, reason };
}

// ── Executor ──────────────────────────────────────────────────

/**
 * Runs the gate the plan selected. All operational failures return
 * the 'error' variant; the only throw is the malformed-plan guard.
 */
export async function executeIdempotencyPlan(
  plan: IdempotencyPlan,
  deps: IdempotencyCheckerDeps,
): Promise<IdempotencyResult> {
  switch (plan.provenance) {
    case 'provider_id':
      return executeProviderIdGate(plan, deps);
    case 'content_hash_fallback':
      return executeContentHashGate(plan, deps);
    default: {
      const impossible: never = plan;
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- never-branch diagnostic formatting on the exhaustive switch (otm#85)
      const impossibleProvenance = (impossible as { provenance?: unknown }).provenance;
      throw new Error(
        `executeIdempotencyPlan: malformed plan provenance ${String(impossibleProvenance)}`,
      );
    }
  }
}

/** plan + execute under one injected clock. */
export async function checkIdempotency(
  input: IdempotencyInput,
  deps: IdempotencyCheckerDeps,
  now: Date,
): Promise<IdempotencyResult> {
  return executeIdempotencyPlan(planIdempotencyCheck(input, now), deps);
}

async function executeProviderIdGate(
  plan: Extract<IdempotencyPlan, { provenance: 'provider_id' }>,
  deps: IdempotencyCheckerDeps,
): Promise<IdempotencyResult> {
  const ctx = { provenance: plan.provenance, provider: plan.provider, contentHash: plan.contentHash };
  const row = newKeyRow(plan);

  let inserted: { id: string } | undefined;
  try {
    inserted = await deps.db.get<{ id: string }>(SQL_PROVIDER_ID_GATE, insertParams(row));
  } catch (err) {
    return gateFailure(deps, ctx, 'provider_id_insert', errorClassOf(err), errorMessageOf(err));
  }

  if (inserted !== undefined) {
    deps.logger.info('idempotency decision', {
      decision: 'novel',
      provenance: plan.provenance,
      keyType: plan.keyType,
      provider: plan.provider,
      contentHash: plan.contentHash,
      keyId: inserted.id,
    });
    return { status: 'novel', provenance: plan.provenance, contentHash: plan.contentHash, keyId: inserted.id };
  }

  // Conflict: the key already exists — fetch the duplicate's details.
  let existing: DuplicateRow | undefined;
  try {
    existing = await deps.db.get<DuplicateRow>(SQL_PROVIDER_ID_DUPLICATE, [plan.provider, plan.keyValue]);
  } catch (err) {
    return gateFailure(deps, ctx, 'provider_id_conflict_fetch', errorClassOf(err), errorMessageOf(err));
  }

  if (existing === undefined) {
    // Conflict fired but no row is visible — impossible under the
    // single-writer/no-purge invariants; surfaced as a typed error,
    // not a throw (operational anomaly, not a caller bug).
    return gateFailure(
      deps,
      ctx,
      'provider_id_conflict_fetch',
      'ConflictRowMissing',
      'ON CONFLICT fired but no matching provider_id key row found',
    );
  }

  deps.logger.info('idempotency decision', {
    decision: 'duplicate',
    provenance: plan.provenance,
    keyType: plan.keyType,
    provider: plan.provider,
    contentHash: plan.contentHash,
    matchedKeyId: existing.id,
  });
  return {
    status: 'duplicate',
    provenance: plan.provenance,
    contentHash: plan.contentHash,
    matchedKeyId: existing.id,
    linkedMessageId: existing.linked_message_id,
  };
}

async function executeContentHashGate(
  plan: Extract<IdempotencyPlan, { provenance: 'content_hash_fallback' }>,
  deps: IdempotencyCheckerDeps,
): Promise<IdempotencyResult> {
  const ctx = { provenance: plan.provenance, provider: plan.provider, contentHash: plan.contentHash };

  if (plan.degradation === 'empty_provider_message_id') {
    deps.logger.warn('idempotency fallback: empty providerMessageId treated as absent', {
      provider: plan.provider,
      contentHash: plan.contentHash,
    });
  }

  let match: DuplicateRow | undefined;
  try {
    match = await deps.db.get<DuplicateRow>(SQL_CONTENT_HASH_WINDOW, [
      plan.keyValue,
      plan.windowStartAt,
      plan.firstSeenAt,
    ]);
  } catch (err) {
    return gateFailure(deps, ctx, 'content_hash_select', errorClassOf(err), errorMessageOf(err));
  }

  if (match !== undefined) {
    deps.logger.info('idempotency decision', {
      decision: 'duplicate',
      provenance: plan.provenance,
      keyType: plan.keyType,
      provider: plan.provider,
      contentHash: plan.contentHash,
      matchedKeyId: match.id,
    });
    return {
      status: 'duplicate',
      provenance: plan.provenance,
      contentHash: plan.contentHash,
      matchedKeyId: match.id,
      linkedMessageId: match.linked_message_id,
    };
  }

  const row = newKeyRow(plan);
  try {
    await deps.db.run(SQL_CONTENT_HASH_INSERT, insertParams(row));
  } catch (err) {
    return gateFailure(deps, ctx, 'content_hash_insert', errorClassOf(err), errorMessageOf(err));
  }

  deps.logger.info('idempotency decision', {
    decision: 'novel',
    provenance: plan.provenance,
    keyType: plan.keyType,
    provider: plan.provider,
    contentHash: plan.contentHash,
    keyId: row.id,
  });
  return { status: 'novel', provenance: plan.provenance, contentHash: plan.contentHash, keyId: row.id };
}

// ── Link backfill ─────────────────────────────────────────────

/**
 * Backfills linked_message_id after the novel message's comms_log
 * row is stored (the novel→stored path). Non-fatal by contract:
 * failures are typed results the caller may ignore — a missing
 * backlink degrades traceability, never the gate.
 */
export async function linkIdempotencyKey(
  keyId: string,
  messageId: string,
  deps: IdempotencyCheckerDeps,
): Promise<LinkResult> {
  let updated: { id: string } | undefined;
  try {
    updated = await deps.db.get<{ id: string }>(SQL_LINK, [messageId, keyId]);
  } catch (err) {
    return linkFailure(deps, keyId, messageId, 'db_error', errorClassOf(err), errorMessageOf(err));
  }

  if (updated === undefined) {
    return linkFailure(
      deps,
      keyId,
      messageId,
      'key_not_found',
      'KeyNotFound',
      `link_update matched no idempotency_keys row for keyId=${keyId}`,
    );
  }

  deps.logger.info('idempotency key linked', { keyId, messageId });
  return { ok: true };
}

async function linkFailure(
  deps: IdempotencyCheckerDeps,
  keyId: string,
  messageId: string,
  reason: 'key_not_found' | 'db_error',
  errorClass: string,
  detail: string,
): Promise<LinkResult> {
  deps.logger.error('idempotency link error', { keyId, messageId, op: 'link_update', errorClass, reason: detail });
  try {
    await deps.emitDiagnostic({
      module: 'idempotencyChecker',
      op: 'link_update',
      severity: IDEMPOTENCY_ERROR_SEVERITY,
      provider: null,
      errorClass,
      detail,
    });
  } catch {
    // Best-effort by contract.
  }
  return { ok: false, reason, detail };
}
