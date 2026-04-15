// ============================================================
// OTM Tools — Diagnostic Logger
// Writes diagnostic events to diagnostic_log — a dedicated table
// separate from session_log. Self-contained, write-only.
// DB client is injected — never constructed here.
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
  DiagnosticSeverity,
  DiagnosticLogInput,
  DiagnosticPurgeResult,
} from '../types';

// ── Constants ─────────────────────────────────────────────────

export const DIAGNOSTIC_MAX_RETENTION_DAYS = 180;

// Valid severity values — used by validateInput.
// Must stay in sync with DiagnosticSeverity type in types.ts.
const VALID_SEVERITIES: DiagnosticSeverity[] = ['info', 'warning', 'critical'];

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
  if (!(VALID_SEVERITIES as string[]).includes(input.severity)) {
    return `severity must be one of: ${VALID_SEVERITIES.join(', ')}; got: ${input.severity}`;
  }
  return null;
}

// Serializes optional metadata to JSON string.
// Returns null if metadata is absent or empty object.
// Catches JSON.stringify failure — logs warn and returns null.
// Never throws.
export function serializeMetadata(
  metadata: Record<string, unknown> | undefined
): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  try {
    return JSON.stringify(metadata);
  } catch (err) {
    console.warn(
      `[DiagnosticLogger] metadata serialization failed — omitting: ` +
      `${(err as Error).message}`
    );
    return null;
  }
}

// ── DB Functions ──────────────────────────────────────────────

// Validates input, generates entry ID + timestamp, writes to
// diagnostic_log. is_synced defaults to 0 — Phase 7 sync sets it.
// Returns null on success; DiagnosticLogError on any failure.
// Never throws.
export async function logDiagnosticEntry(
  input: DiagnosticLogInput,
  db:    DiagnosticLogDbClient
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
  const metadataJson = serializeMetadata(input.metadata);

  try {
    await db.run(
      `INSERT INTO diagnostic_log
         (entry_id, session_id, user_id, category, severity,
          machine_id, message, metadata_json, timestamp, is_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
      ]
    );

    console.info(
      `[DiagnosticLogger] entry written entryId=${entryId} ` +
      `category=${input.category} severity=${input.severity} ` +
      `machineId=${input.machineId ?? 'null'} sessionId=${input.sessionId}`
    );

    return null;
  } catch (err) {
    return new DiagnosticLogError(
      `Write failed: ${(err as Error).message}`,
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
  db:            DiagnosticLogDbClient
): Promise<DiagnosticPurgeResult> {
  const clampedDays = Math.min(retentionDays, DIAGNOSTIC_MAX_RETENTION_DAYS);
  if (clampedDays !== retentionDays) {
    console.warn(
      `[DiagnosticLogger] retentionDays=${retentionDays} exceeds max ` +
      `${DIAGNOSTIC_MAX_RETENTION_DAYS} — clamped`
    );
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

    console.info(
      `[DiagnosticLogger] purge complete userId=${userId} ` +
      `entriesDeleted=${entriesDeleted} purgedBefore=${cutoff}`
    );

    return { entriesDeleted, purgedBefore: cutoff };
  } catch (err) {
    console.error(
      `[DiagnosticLogger] purge failed userId=${userId}: ` +
      `${(err as Error).message}`
    );
    return { entriesDeleted: 0, purgedBefore: cutoff };
  }
}
