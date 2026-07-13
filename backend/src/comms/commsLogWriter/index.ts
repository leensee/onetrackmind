// ============================================================
// OTM Comms — commsLogWriter (Phase 4.1) — IMPURE SURFACE
// CJS module. Inserter + re-exports of the pure assembler
// (mirrors comms/idempotencyChecker: pure.ts holds the
// deterministic half, index.ts owns the side effects).
//
// Single-writer-per-table: this module owns the comms_log INSERT
// and NOTHING else — it never touches idempotency_keys
// (idempotencyChecker owns all writes there, including link()).
// The store() → link() sequencing, with no cross-module
// transaction and link() non-fatal, is the 4.2 orchestrator's
// (Decisions Log 2026-07-09).
//
// Duplicate detection lives in the INSERT itself: a single
// parameterized INSERT … ON CONFLICT targeting the partial unique
// uq_comms_log_provider_message_id, read through db.get() because
// run() returns void and exposes no rowcount. The conflict target
// absorbs ONLY that uniqueness conflict; CHECK/FK/NOT-NULL still
// throw and funnel to the 'error' variant (INSERT OR IGNORE would
// swallow them — never use it here). Rows with NULL
// provider_message_id are outside the partial index and always
// insert (the safety net is per-provider message identity, not
// content — content dedup already happened at the gate).
//
// Observability split (mirrors idempotencyChecker):
//   stored/duplicate → injected Logger only (info; fields carry
//   ids/enums/contentHash, NEVER from_identifier/to_identifiers/
//   body/subject).
//   error → return the typed variant AND best-effort-emit a
//   diagnostic event at source (severity 'critical' — pinned here
//   per the Phase-3 rule that the tool, not the caller, determines
//   severity; there is no 'error' in the DiagnosticSeverity enum).
//   Emission is awaited inside its own try/catch so a broken
//   adapter can never mask the Logger.error line or the returned
//   variant. The 4.2 wiring adapts the emitter onto
//   logDiagnosticEntry with session-scoped context IDs.
//
// House error rule: operational failures return typed results —
// never throw; the only throw is the pure assembler's
// impossible-direction guard (programmer error). All SQL
// parameterized.
// ============================================================

import { randomUUID } from 'crypto';
import { SqliteClient, DiagnosticSeverity } from '../../orchestration/types';
import { Logger } from '../../observability/logger';
import { CommsProvider } from '../../db/schemaConstants';
import { CommsLogRow, commsLogToDb } from '../../db/mapping/commsLog';
import { CommsLogWriteInput, assembleCommsLogRecord } from './pure';

export * from './pure';

// ── Diagnostics seam ──────────────────────────────────────────

export type CommsLogWriterOp = 'comms_log_insert';

// Severity pinned at source; typed against the enum so a vocab
// change breaks compilation here, not silently downstream.
const COMMS_LOG_WRITER_ERROR_SEVERITY = 'critical' satisfies DiagnosticSeverity;

export interface CommsLogWriterDiagnosticEvent {
  module: 'commsLogWriter';
  op: CommsLogWriterOp;
  severity: typeof COMMS_LOG_WRITER_ERROR_SEVERITY;
  provider: CommsProvider;
  /** Sanitized error class name only — never message-embedded content. */
  errorClass: string;
  /** SQLite/driver message (binds are never echoed); never from/to/body. */
  detail: string;
}

/** 4.2 wiring adapts this onto logDiagnosticEntry with session context. */
export type CommsLogWriterDiagnosticEmitter = (
  event: CommsLogWriterDiagnosticEvent,
) => Promise<void>;

export const noopCommsLogWriterDiagnosticEmitter: CommsLogWriterDiagnosticEmitter = async () => {};

export interface CommsLogWriterDeps {
  db: SqliteClient;
  logger: Logger;
  emitDiagnostic: CommsLogWriterDiagnosticEmitter;
}

// ── Result contract ───────────────────────────────────────────

export type CommsLogWriteResult =
  | { status: 'stored'; id: string }
  | { status: 'duplicate'; provider: CommsProvider; providerMessageId: string }
  | { status: 'error'; reason: string };

// ── SQL (parameterized) ───────────────────────────────────────

// Column order matches migrations/001_phase4_comms.sql. The
// conflict target names the partial UNIQUE
// (uq_comms_log_provider_message_id) so ONLY that uniqueness
// conflict is absorbed as 'duplicate'.
const SQL_INSERT_COMMS_LOG = `INSERT INTO comms_log (id, created_at, provider, channel, direction,
  provider_message_id, idempotency_provenance, content_hash, thread_key, from_identifier,
  to_identifiers, subject, body, provider_timestamp, contact_id, topic_tag, triage_label,
  time_sensitivity_flag, delivery_state, delivery_detail, fallback_leg_used, is_synced,
  user_acknowledged_at, user_action_taken)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (provider, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
RETURNING id`;

// ── Internal helpers ──────────────────────────────────────────

function errorClassOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function insertParams(row: CommsLogRow): unknown[] {
  return [
    row.id,
    row.created_at,
    row.provider,
    row.channel,
    row.direction,
    row.provider_message_id,
    row.idempotency_provenance,
    row.content_hash,
    row.thread_key,
    row.from_identifier,
    row.to_identifiers,
    row.subject,
    row.body,
    row.provider_timestamp,
    row.contact_id,
    row.topic_tag,
    row.triage_label,
    row.time_sensitivity_flag,
    row.delivery_state,
    row.delivery_detail,
    row.fallback_leg_used,
    row.is_synced,
    row.user_acknowledged_at,
    row.user_action_taken,
  ];
}

/**
 * Error-variant funnel: one Logger.error line, then best-effort
 * diagnostic emission (its own try/catch — a rejecting adapter must
 * never mask the log line or replace the returned variant), then
 * the typed result. Never throws.
 */
async function insertFailure(
  deps: CommsLogWriterDeps,
  ctx: { provider: CommsProvider; contentHash: string },
  errorClass: string,
  detail: string,
): Promise<CommsLogWriteResult> {
  const op: CommsLogWriterOp = 'comms_log_insert';
  const reason = `${op}: ${detail}`;
  deps.logger.error('comms_log write error', {
    provider: ctx.provider,
    contentHash: ctx.contentHash,
    op,
    errorClass,
    reason,
  });
  try {
    await deps.emitDiagnostic({
      module: 'commsLogWriter',
      op,
      severity: COMMS_LOG_WRITER_ERROR_SEVERITY,
      provider: ctx.provider,
      errorClass,
      detail,
    });
  } catch {
    // Best-effort by contract — swallowed so emission can never mask the result.
  }
  return { status: 'error', reason };
}

// ── Inserter ──────────────────────────────────────────────────

/**
 * Assembles and persists one comms_log row under the injected
 * clock. randomUUID here is this module's only nondeterminism.
 * Row returned → stored; absorbed conflict → duplicate; every
 * thrown INSERT failure (CHECK, FK, IO/busy) → the 'error'
 * variant. Never throws on operational failure.
 */
export async function storeCommsLog(
  input: CommsLogWriteInput,
  deps: CommsLogWriterDeps,
  now: Date,
): Promise<CommsLogWriteResult> {
  const ctx = { provider: input.provider, contentHash: input.contentHash };
  const row = commsLogToDb(assembleCommsLogRecord(input, randomUUID(), now));

  let inserted: { id: string } | undefined;
  try {
    inserted = await deps.db.get<{ id: string }>(SQL_INSERT_COMMS_LOG, insertParams(row));
  } catch (err) {
    return insertFailure(deps, ctx, errorClassOf(err), errorMessageOf(err));
  }

  if (inserted !== undefined) {
    deps.logger.info('comms_log write', {
      decision: 'stored',
      id: inserted.id,
      provider: row.provider,
      channel: row.channel,
      direction: row.direction,
      provenance: row.idempotency_provenance,
      contentHash: row.content_hash,
    });
    return { status: 'stored', id: inserted.id };
  }

  if (input.providerMessageId === null) {
    // Insert returned no row, yet a NULL provider_message_id row is
    // outside the partial unique and cannot conflict — impossible
    // under the schema; surfaced as a typed error, not a throw
    // (operational anomaly, not a caller bug).
    return insertFailure(
      deps,
      ctx,
      'InsertRowMissing',
      'INSERT returned no row for a NULL provider_message_id insert',
    );
  }

  deps.logger.info('comms_log write', {
    decision: 'duplicate',
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    contentHash: input.contentHash,
  });
  return {
    status: 'duplicate',
    provider: input.provider,
    providerMessageId: input.providerMessageId,
  };
}
