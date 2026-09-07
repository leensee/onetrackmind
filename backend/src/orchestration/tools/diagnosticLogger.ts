// ============================================================
// OTM Tools — Diagnostic Logger
// Writes diagnostic events to diagnostic_log — a dedicated table
// separate from session_log. Self-contained, write-only.
// DB client is injected — never constructed here.
// Logger is injected (trailing parameter) — console-backed
// default. Orthogonal to the rows this module writes: the
// Logger carries this module's own field observability.
// All queries parameterized — no string interpolation.
//
// Categories are plain strings — new categories addable as data,
// no code or schema migration required.
//
// is_synced defaults to 0 on every write. Phase 7 sync layer sets
// it to 1 after Supabase confirmation. Purge only deletes rows
// where is_synced = 1 — pending-sync rows are never purged locally.
//
// Never throws on operational failures — all error states returned.
// ============================================================

import { randomUUID } from 'crypto';
import {
  DiagnosticLogInput,
  DiagnosticPurgeResult,
} from '../types';
import { DiagnosticSeverity, DIAGNOSTIC_SEVERITIES } from '../../db/types';
import { errorMessage } from '../typeUtils';
import { Logger, createConsoleLogger } from '../../observability/logger';

// ── Constants ─────────────────────────────────────────────────

export const DIAGNOSTIC_MAX_RETENTION_DAYS = 180;

// is_synced is always 0 on write — Phase 7 sync layer sets it to 1
// after Supabase confirmation. Hardcoded in SQL, not a parameter,
// so no caller can accidentally create a pre-synced record.
const IS_NOT_SYNCED = 0;

// Valid severity values — used by validateInput. Derived from the
// canonical vocabulary in db/types.ts, so it cannot drift from the type.
const VALID_SEVERITIES: readonly DiagnosticSeverity[] = DIAGNOSTIC_SEVERITIES;

const defaultLogger: Logger = createConsoleLogger('DiagnosticLogger');

// ── Narrow DB Interface ───────────────────────────────────────
// run: writes. get: count queries for purge.
// No all() — this is a write-only tool layer module.

export interface DiagnosticLogDbClient {
  run(sql: string, params: unknown[]): Promise<void>;
  get<T>(sql: string, params: unknown[]): Promise<T | undefined>;
}

// ── Error and Result Types ────────────────────────────────────

export class DiagnosticLogError extends Error {
  public readonly sessionId:  string;
  public readonly requestId:  string;
  public readonly cause:      'write_error' | 'invalid_input';

  constructor(
    message:   string,
    sessionId: string,
    requestId: string,
    cause:     'write_error' | 'invalid_input'
  ) {
    super(message);
    this.name      = 'DiagnosticLogError';
    this.sessionId = sessionId;
    this.requestId = requestId;
    this.cause     = cause;
  }
}

// null = success. DiagnosticLogError = typed failure. Never throws.
export type DiagnosticLogResult = DiagnosticLogError | null;

// ── Pure Functions ────────────────────────────────────────────
// No DB access. Exported for isolated testing.

// Validates DiagnosticLogInput fields.
// Returns null on valid input; returns error message string on failure.
// Severity checked against explicit valid values — not just non-empty.
export function validateInput(input: DiagnosticLogInput): string | null {
  if (!input.message || input.message.trim() === '') {
    return 'message must not be empty';
  }
  if (!input.category || input.category.trim() === '') {
    return 'category must not be empty';
  }
  if (!VALID_SEVERITIES.some(v => v === input.severity)) {
    return `severity must be one of: ${VALID_SEVERITIES.join(', ')}; got: ${input.severity}`;
  }
  return null;
}

// Serializes optional metadata to JSON string.
// Returns null if metadata is absent or empty object.
// Catches JSON.stringify failure — logs warn and returns null.
// Never throws.
export function serializeMetadata(
  metadata: Record<string, unknown> | undefined,
  logger:   Logger = defaultLogger
): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  try {
    return JSON.stringify(metadata);
  } catch (err) {
    logger.warn('metadata serialization failed — omitting', { detail: errorMessage(err) });
    return null;
  }
}

// ── DB Functions ──────────────────────────────────────────────

// Validates input, generates entry ID + timestamp, writes to
// diagnostic_log. is_synced defaults to 0 — Phase 7 sync sets it.
// Returns null on success; DiagnosticLogError on any failure.
// Never throws.
export async function logDiagnosticEntry(
  input:  DiagnosticLogInput,
  db:     DiagnosticLogDbClient,
  logger: Logger = defaultLogger
): Promise<DiagnosticLogResult> {
  const validationError = validateInput(input);
  if (validationError) {
    return new DiagnosticLogError(
      `Invalid diagnostic input: ${validationError}`,
      input.sessionId,
      input.requestId,
      'invalid_input'
    );
  }

  const entryId      = randomUUID();
  const timestamp    = new Date().toISOString();
  const metadataJson = serializeMetadata(input.metadata, logger);

  try {
    await db.run(
      `INSERT INTO diagnostic_log
         (entry_id, session_id, user_id, category, severity,
          machine_id, message, metadata_json, timestamp, is_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        input.sessionId,
        input.userId,
        input.category.trim(),
        input.severity,
        input.machineId,
        input.message.trim(),
        metadataJson,
        timestamp,
        IS_NOT_SYNCED,
      ]
    );

    logger.info('entry written', {
      entryId,
      category:  input.category,
      severity:  input.severity,
      machineId: input.machineId,
      sessionId: input.sessionId,
    });

    return null;
  } catch (err) {
    return new DiagnosticLogError(
      `Write failed: ${errorMessage(err)}`,
      input.sessionId,
      input.requestId,
      'write_error'
    );
  }
}

// Deletes diagnostic_log rows where is_synced = 1 AND timestamp < cutoff.
// Pending-sync rows (is_synced = 0) are never deleted regardless of age.
// Clamps retentionDays to DIAGNOSTIC_MAX_RETENTION_DAYS (180).
// Returns DiagnosticPurgeResult with count and cutoff used.
// Non-fatal on DB failure — logs error, returns zero counts. Never throws.
export async function purgeOldDiagnostics(
  userId:        string,
  retentionDays: number,
  db:            DiagnosticLogDbClient,
  logger:        Logger = defaultLogger
): Promise<DiagnosticPurgeResult> {
  const clampedDays = Math.min(retentionDays, DIAGNOSTIC_MAX_RETENTION_DAYS);
  if (clampedDays !== retentionDays) {
    logger.warn('retentionDays exceeds max — clamped', {
      retentionDays,
      max: DIAGNOSTIC_MAX_RETENTION_DAYS,
    });
  }

  const cutoff = new Date(
    Date.now() - clampedDays * 24 * 60 * 60 * 1000
  ).toISOString();

  try {
    const countRow = await db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM diagnostic_log
       WHERE user_id = ? AND is_synced = 1 AND timestamp < ?`,
      [userId, cutoff]
    );
    const entriesDeleted = countRow?.count ?? 0;

    await db.run(
      `DELETE FROM diagnostic_log
       WHERE user_id = ? AND is_synced = 1 AND timestamp < ?`,
      [userId, cutoff]
    );

    logger.info('purge complete', { userId, entriesDeleted, purgedBefore: cutoff });

    return { entriesDeleted, purgedBefore: cutoff };
  } catch (err) {
    logger.error('purge failed', { userId, detail: errorMessage(err) });
    return { entriesDeleted: 0, purgedBefore: cutoff };
  }
}
