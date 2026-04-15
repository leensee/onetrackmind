// ============================================================
// OTM Orchestration — Session Persistence
// Hybrid log-first architecture:
//   - session_log is the source of truth — always written first
//   - session_states is a fast-load cache — always derived from log
//   - log replay rebuilds state when cache is missing or stale
// SQLite client is injected — never constructed here.
// All queries parameterized — no string interpolation.
// ============================================================

import { randomUUID } from 'crypto';
import {
  SessionState,
  SessionLogEntry,
  SessionLogEntryType,
  SqliteClient,
  ActiveFlag,
  OpenItem,
  Message,
  ConsistContext,
} from './types';

// ── Constants ─────────────────────────────────────────────────

export const CURRENT_SCHEMA_VERSION = 1;
export const MAX_RETENTION_DAYS     = 180;

// ── SerializeResult — discriminated result ────────────────────
// Never throws — returns typed result. Caller decides path.

export type SerializeResult =
  | { ok: true;  payload: string }
  | { ok: false; reason: 'missing_fields' | 'invalid_type'; fields: string[]; message: string };

// ── PurgeResult ───────────────────────────────────────────────

export interface PurgeResult {
  entriesDeleted:  number;
  sessionsDeleted: number;
  purgedBefore:    string;  // ISO 8601 cutoff used
}

// ── SessionPersistenceError ───────────────────────────────────
// Typed cause — orchestrator branches on it, never interprets prose.

export class SessionPersistenceError extends Error {
  public readonly sessionId:  string;
  public readonly operation:  string;
  public readonly cause:      'write_error' | 'read_error' | 'replay_error' | 'invalid_payload';

  constructor(
    message:   string,
    sessionId: string,
    operation: string,
    cause:     'write_error' | 'read_error' | 'replay_error' | 'invalid_payload'
  ) {
    super(message);
    this.name      = 'SessionPersistenceError';
    this.sessionId = sessionId;
    this.operation = operation;
    this.cause     = cause;
  }
}

// ── Payload Schemas ───────────────────────────────────────────
// Required fields per entry type. Validated before every write.
// Adding a field: add to the array and bump CURRENT_SCHEMA_VERSION.

const PAYLOAD_SCHEMAS: Record<SessionLogEntryType, string[]> = {
  session_open:       ['sessionId', 'userId', 'editionId', 'openedAt'],
  user_message:       ['content', 'channel'],
  assistant_response: ['content', 'inputTokens', 'outputTokens', 'model'],
  flag_raised:        ['flagId', 'type', 'content'],
  flag_acknowledged:  ['flagId'],
  approval_decision:  ['requestId', 'decision'],
  route_result:       ['channel', 'success', 'segmentCount'],
  session_close:      ['closedAt', 'turnCount'],
};

// ── serializePayload ──────────────────────────────────────────
// Pure function — exported for testing.
// Validates required fields, returns discriminated result.
// Never throws. Returns { ok: false } on any validation failure.

export function serializePayload(
  entryType: SessionLogEntryType,
  data:      Record<string, unknown>
): SerializeResult {
  const required = PAYLOAD_SCHEMAS[entryType];
  const missing: string[] = [];

  for (const field of required) {
    if (!(field in data) || data[field] === undefined) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return {
      ok:      false,
      reason:  'missing_fields',
      fields:  missing,
      message: `${entryType}: missing required fields: ${missing.join(', ')}`,
    };
  }

  try {
    const payload = JSON.stringify(data);
    return { ok: true, payload };
  } catch (err) {
    return {
      ok:      false,
      reason:  'invalid_type',
      fields:  ['(serialization)'],
      message: `${entryType}: JSON serialization failed: ${(err as Error).message}`,
    };
  }
}

// ── writeLogEntry ─────────────────────────────────────────────
// Returns SessionPersistenceError | null.
// null = success. Error = typed failure. Orchestrator decides path.
// Never throws — all error paths return typed errors.

export async function writeLogEntry(
  entry: Omit<SessionLogEntry, 'entryId' | 'timestamp' | 'schemaVersion'>,
  db:    SqliteClient
): Promise<SessionPersistenceError | null> {
  const serializeResult = serializePayload(
    entry.entryType,
    JSON.parse(entry.payload) as Record<string, unknown>
  );

  if (!serializeResult.ok) {
    return new SessionPersistenceError(
      serializeResult.message,
      entry.sessionId,
      'writeLogEntry',
      'invalid_payload'
    );
  }

  const fullEntry: SessionLogEntry = {
    entryId:       randomUUID(),
    sessionId:     entry.sessionId,
    userId:        entry.userId,
    entryType:     entry.entryType,
    payload:       serializeResult.payload,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    timestamp:     new Date().toISOString(),
  };

  try {
    await db.run(
      `INSERT INTO session_log
         (entry_id, session_id, user_id, entry_type, payload, schema_version, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        fullEntry.entryId,
        fullEntry.sessionId,
        fullEntry.userId,
        fullEntry.entryType,
        fullEntry.payload,
        fullEntry.schemaVersion,
        fullEntry.timestamp,
      ]
    );
    return null;
  } catch (err) {
    return new SessionPersistenceError(
      `SQLite write failed: ${(err as Error).message}`,
      entry.sessionId,
      'writeLogEntry',
      'write_error'
    );
  }
}

// ── updateStateObject ─────────────────────────────────────────
// UPSERT to session_states. Performance cache — not source of truth.
// Returns SessionPersistenceError | null.

export async function updateStateObject(
  state: SessionState,
  db:    SqliteClient
): Promise<SessionPersistenceError | null> {
  try {
    await db.run(
      `INSERT INTO session_states
         (session_id, user_id, edition_id, state_json, last_interaction_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         state_json           = excluded.state_json,
         last_interaction_at  = excluded.last_interaction_at`,
      [
        state.sessionId,
        state.userId,
        state.editionId,
        JSON.stringify(state),
        state.lastInteractionAt,
      ]
    );
    return null;
  } catch (err) {
    return new SessionPersistenceError(
      `State object UPSERT failed: ${(err as Error).message}`,
      state.sessionId,
      'updateStateObject',
      'write_error'
    );
  }
}

// ── replaySessionLog ──────────────────────────────────────────
// Rebuilds SessionState from ordered log entries.
// Skips entries with unrecognized schemaVersion (forward-compat).
// Throws SessionPersistenceError if no entries found.

export async function replaySessionLog(
  sessionId: string,
  userId:    string,
  db:        SqliteClient
): Promise<SessionState> {
  let rows: SessionLogEntry[];

  try {
    rows = await db.all<SessionLogEntry>(
      `SELECT entry_id as entryId, session_id as sessionId, user_id as userId,
              entry_type as entryType, payload, schema_version as schemaVersion, timestamp
       FROM session_log
       WHERE session_id = ?
       ORDER BY timestamp ASC`,
      [sessionId]
    );
  } catch (err) {
    throw new SessionPersistenceError(
      `Log read failed: ${(err as Error).message}`,
      sessionId,
      'replaySessionLog',
      'read_error'
    );
  }

  if (rows.length === 0) {
    throw new SessionPersistenceError(
      `No log entries found for sessionId=${sessionId}`,
      sessionId,
      'replaySessionLog',
      'replay_error'
    );
  }

  // Initialize empty state
  const state: SessionState = {
    sessionId,
    userId,
    editionId:           '',
    openedAt:            '',
    lastInteractionAt:   '',
    conversationHistory: [],
    activeFlags:         [],
    openItems:           [],
    consistContext:      null,
    isFromLogReplay:     true,
  };

  for (const row of rows) {
    if (row.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      console.warn(
        `[SessionPersistence] skipping entry entryId=${row.entryId} ` +
        `schemaVersion=${row.schemaVersion} (current=${CURRENT_SCHEMA_VERSION})`
      );
      continue;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      console.warn(
        `[SessionPersistence] skipping unparseable payload entryId=${row.entryId}`
      );
      continue;
    }

    // Apply typed state mutation — exhaustive switch, no fall-through
    switch (row.entryType) {
      case 'session_open':
        state.editionId  = data['editionId'] as string;
        state.openedAt   = data['openedAt'] as string;
        state.lastInteractionAt = data['openedAt'] as string;
        break;

      case 'user_message':
        state.conversationHistory.push({
          role:      'user',
          content:   data['content'] as string,
          timestamp: row.timestamp,
        } satisfies Message);
        state.lastInteractionAt = row.timestamp;
        break;

      case 'assistant_response':
        state.conversationHistory.push({
          role:      'assistant',
          content:   data['content'] as string,
          timestamp: row.timestamp,
        } satisfies Message);
        state.lastInteractionAt = row.timestamp;
        break;

      case 'flag_raised':
        state.activeFlags.push({
          flagId:       data['flagId'] as string,
          type:         data['type'] as ActiveFlag['type'],
          content:      data['content'] as string,
          raisedAt:     row.timestamp,
          acknowledged: false,
        } satisfies ActiveFlag);
        break;

      case 'flag_acknowledged': {
        const flagId = data['flagId'] as string;
        const flag = state.activeFlags.find(f => f.flagId === flagId);
        if (flag) flag.acknowledged = true;
        break;
      }

      case 'approval_decision':
        // Approval decisions recorded in log but don't mutate SessionState directly
        state.lastInteractionAt = row.timestamp;
        break;

      case 'route_result':
        state.lastInteractionAt = row.timestamp;
        break;

      case 'session_close':
        state.lastInteractionAt = row.timestamp;
        break;

      default: {
        const exhaustiveCheck: never = row.entryType;
        console.warn(
          `[SessionPersistence] unrecognized entryType: ${String(exhaustiveCheck)}`
        );
      }
    }
  }

  return state;
}

// ── openSession ───────────────────────────────────────────────
// Load or initialize session state. Runs retention purge.

export async function openSession(
  sessionId:   string,
  userId:      string,
  editionId:   string,
  retentionDays: number,
  db:          SqliteClient
): Promise<{ state: SessionState; purge: PurgeResult }> {
  // Attempt fast-path load from state object cache
  let state: SessionState | undefined;

  try {
    const row = await db.get<{ state_json: string }>(
      `SELECT state_json FROM session_states WHERE session_id = ?`,
      [sessionId]
    );
    if (row) {
      state = JSON.parse(row.state_json) as SessionState;
      state.isFromLogReplay = false;
    }
  } catch (err) {
    // Cache read failure is non-fatal — fall through to replay
    console.warn(
      `[SessionPersistence] state cache read failed, falling back to replay: ` +
      `${(err as Error).message}`
    );
  }

  if (!state) {
    // Try log replay
    try {
      state = await replaySessionLog(sessionId, userId, db);
    } catch (replayErr) {
      const pe = replayErr as SessionPersistenceError;
      if (pe.cause === 'replay_error') {
        // No log entries — fresh session
        const now = new Date().toISOString();
        state = {
          sessionId,
          userId,
          editionId,
          openedAt:            now,
          lastInteractionAt:   now,
          conversationHistory: [],
          activeFlags:         [],
          openItems:           [],
          consistContext:      null,
          isFromLogReplay:     false,
        };
      } else {
        throw replayErr;
      }
    }
  }

  // Write session_open log entry
  const openPayload = JSON.stringify({
    sessionId,
    userId,
    editionId,
    openedAt: state.openedAt,
  });

  const writeErr = await writeLogEntry(
    {
      sessionId,
      userId,
      entryType: 'session_open',
      payload:   openPayload,
    },
    db
  );

  if (writeErr) {
    throw writeErr;
  }

  // Run retention purge
  const purge = await purgeExpiredLogs(userId, retentionDays, db);

  console.info(
    `[SessionPersistence] openSession sessionId=${sessionId} ` +
    `isFromLogReplay=${state.isFromLogReplay} ` +
    `purgedEntries=${purge.entriesDeleted}`
  );

  return { state, purge };
}

// ── closeSession ──────────────────────────────────────────────
// Writes session_close log entry. Returns error or null.
// Does not trigger style summarization — that signal is carried
// by the log entry and handled by the orchestrator.

export async function closeSession(
  sessionId:  string,
  userId:     string,
  turnCount:  number,
  db:         SqliteClient
): Promise<SessionPersistenceError | null> {
  const payload = JSON.stringify({
    closedAt:  new Date().toISOString(),
    turnCount,
  });

  return writeLogEntry(
    { sessionId, userId, entryType: 'session_close', payload },
    db
  );
}

// ── purgeExpiredLogs ──────────────────────────────────────────
// Deletes session_log entries older than retentionDays.
// Then deletes orphaned session_states rows.
// Returns PurgeResult with counts and cutoff used.

export async function purgeExpiredLogs(
  userId:        string,
  retentionDays: number,
  db:            SqliteClient
): Promise<PurgeResult> {
  // Enforce 180-day maximum regardless of caller-supplied value.
  // Baseline: 90-day default / 180-day max. Never trust caller to cap this.
  const clampedDays = Math.min(retentionDays, MAX_RETENTION_DAYS);
  if (clampedDays !== retentionDays) {
    console.warn(
      `[SessionPersistence] retentionDays=${retentionDays} exceeds MAX_RETENTION_DAYS=${MAX_RETENTION_DAYS} — clamped to ${clampedDays}`
    );
  }

  const cutoff = new Date(
    Date.now() - clampedDays * 24 * 60 * 60 * 1000
  ).toISOString();

  // Count entries to be deleted (for PurgeResult)
  let entriesDeleted = 0;
  let sessionsDeleted = 0;

  try {
    const countRow = await db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM session_log
       WHERE user_id = ? AND timestamp < ?`,
      [userId, cutoff]
    );
    entriesDeleted = countRow?.count ?? 0;

    await db.run(
      `DELETE FROM session_log WHERE user_id = ? AND timestamp < ?`,
      [userId, cutoff]
    );

    // Orphaned state objects: sessions with no remaining log entries
    const orphanCount = await db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM session_states
       WHERE user_id = ?
       AND session_id NOT IN (
         SELECT DISTINCT session_id FROM session_log WHERE user_id = ?
       )`,
      [userId, userId]
    );
    sessionsDeleted = orphanCount?.count ?? 0;

    await db.run(
      `DELETE FROM session_states
       WHERE user_id = ?
       AND session_id NOT IN (
         SELECT DISTINCT session_id FROM session_log WHERE user_id = ?
       )`,
      [userId, userId]
    );
  } catch (err) {
    // Purge failure is logged but non-fatal — session continues
    console.error(
      `[SessionPersistence] purge failed for userId=${userId}: ` +
      `${(err as Error).message}`
    );
  }

  return { entriesDeleted, sessionsDeleted, purgedBefore: cutoff };
}
