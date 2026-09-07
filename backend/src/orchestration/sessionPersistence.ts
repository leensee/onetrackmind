// ============================================================
// OTM Orchestration — Session Persistence
// Hybrid log-first architecture:
//   - session_log is the source of truth — always written first
//   - session_states is a fast-load cache — always derived from log
//   - log replay rebuilds state when cache is missing or stale
// SQLite client is injected — never constructed here.
// Logger is injected (trailing parameter) — console-backed default.
// All queries parameterized — no string interpolation.
// ============================================================

import { randomUUID } from 'crypto';
import {
  SessionState,
  SessionLogEntry,
  SessionLogEntryType,
  ActiveFlag,
  OpenItem,
  Message,
  ConsistContext,
  MachineRef,
} from './types';
import { SqliteClient } from '../db/types';
import {
  extractString,
  extractNumber,
  extractBoolean,
  extractArray,
  extractOneOf,
  toRecord,
  errorMessage,
} from './typeUtils';
import { Logger, createConsoleLogger } from '../observability/logger';

// ── Constants ─────────────────────────────────────────────────

export const CURRENT_SCHEMA_VERSION = 1;
export const MAX_RETENTION_DAYS     = 180;

const FLAG_TYPES      = ['safety', 'push', 'pull', 'audit'] as const;
const ITEM_CATEGORIES = ['safety', 'machine', 'parts', 'compliance', 'contact'] as const;
const MESSAGE_ROLES   = ['user', 'assistant'] as const;

const defaultLogger: Logger = createConsoleLogger('SessionPersistence');

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
      message: `${entryType}: JSON serialization failed: ${errorMessage(err)}`,
    };
  }
}

// ── Cache Validation ──────────────────────────────────────────
// session_states.state_json is written by updateStateObject as
// JSON.stringify(state), so a valid row always has exactly the
// SessionState shape. Anything else — a hand edit, a future schema,
// disk corruption — is treated as a cache miss and the caller falls
// back to log replay, the source of truth. Validated field-by-field
// through typeUtils; no cast. Pure — exported for testing.

function parseAll<T>(
  values: unknown[] | undefined,
  parse:  (value: unknown) => T | undefined
): T[] | undefined {
  if (values === undefined) return undefined;
  const out: T[] = [];
  for (const value of values) {
    const parsed = parse(value);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

function parseMessage(value: unknown): Message | undefined {
  const record = toRecord(value);
  if (!record) return undefined;
  const role    = extractOneOf(record, 'role', MESSAGE_ROLES);
  const content = extractString(record, 'content');
  if (role === undefined || content === undefined) return undefined;
  const message: Message = { role, content };
  const timestamp = extractString(record, 'timestamp');
  if (timestamp !== undefined) message.timestamp = timestamp;
  return message;
}

function parseActiveFlag(value: unknown): ActiveFlag | undefined {
  const record = toRecord(value);
  if (!record) return undefined;
  const flagId       = extractString(record, 'flagId');
  const type         = extractOneOf(record, 'type', FLAG_TYPES);
  const content      = extractString(record, 'content');
  const raisedAt     = extractString(record, 'raisedAt');
  const acknowledged = extractBoolean(record, 'acknowledged');
  if (
    flagId === undefined || type === undefined || content === undefined ||
    raisedAt === undefined || acknowledged === undefined
  ) return undefined;
  return { flagId, type, content, raisedAt, acknowledged };
}

function parseOpenItem(value: unknown): OpenItem | undefined {
  const record = toRecord(value);
  if (!record) return undefined;
  const itemId   = extractString(record, 'itemId');
  const category = extractOneOf(record, 'category', ITEM_CATEGORIES);
  const content  = extractString(record, 'content');
  const priority = extractNumber(record, 'priority');
  const isPush   = extractBoolean(record, 'isPush');
  if (
    itemId === undefined || category === undefined || content === undefined ||
    priority === undefined || isPush === undefined
  ) return undefined;
  return { itemId, category, content, priority, isPush };
}

function parseMachineRef(value: unknown): MachineRef | undefined {
  const record = toRecord(value);
  if (!record) return undefined;
  const position = extractNumber(record, 'position');
  const name     = extractString(record, 'name');
  if (position === undefined || name === undefined) return undefined;
  const machine: MachineRef = { position, name };
  const serialNumber = extractString(record, 'serialNumber');
  if (serialNumber !== undefined) machine.serialNumber = serialNumber;
  return machine;
}

// null is a valid (and common) consistContext; undefined means invalid.
function parseConsistContext(value: unknown): ConsistContext | null | undefined {
  if (value === null) return null;
  const record = toRecord(value);
  if (!record) return undefined;
  const consistId        = extractString(record, 'consistId');
  const relevantMachines = parseAll(extractArray(record, 'relevantMachines'), parseMachineRef);
  if (consistId === undefined || relevantMachines === undefined) return undefined;
  return { consistId, relevantMachines };
}

export function parseCachedState(stateJson: string): SessionState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson);
  } catch {
    return undefined;
  }
  const record = toRecord(parsed);
  if (!record) return undefined;

  const sessionId           = extractString(record, 'sessionId');
  const userId              = extractString(record, 'userId');
  const editionId           = extractString(record, 'editionId');
  const openedAt            = extractString(record, 'openedAt');
  const lastInteractionAt   = extractString(record, 'lastInteractionAt');
  const conversationHistory = parseAll(extractArray(record, 'conversationHistory'), parseMessage);
  const activeFlags         = parseAll(extractArray(record, 'activeFlags'), parseActiveFlag);
  const openItems           = parseAll(extractArray(record, 'openItems'), parseOpenItem);
  const consistContext      = 'consistContext' in record
    ? parseConsistContext(record['consistContext'])
    : undefined;
  const isFromLogReplay     = extractBoolean(record, 'isFromLogReplay');

  if (
    sessionId === undefined || userId === undefined || editionId === undefined ||
    openedAt === undefined || lastInteractionAt === undefined ||
    conversationHistory === undefined || activeFlags === undefined ||
    openItems === undefined || consistContext === undefined ||
    isFromLogReplay === undefined
  ) return undefined;

  return {
    sessionId,
    userId,
    editionId,
    openedAt,
    lastInteractionAt,
    conversationHistory,
    activeFlags,
    openItems,
    consistContext,
    isFromLogReplay,
  };
}

// ── writeLogEntry ─────────────────────────────────────────────
// Returns SessionPersistenceError | null.
// null = success. Error = typed failure. Orchestrator decides path.
// Never throws — all error paths return typed errors.

export async function writeLogEntry(
  entry: Omit<SessionLogEntry, 'entryId' | 'timestamp' | 'schemaVersion'>,
  db:    SqliteClient
): Promise<SessionPersistenceError | null> {
  // The caller hands us JSON text; a payload that is not a JSON object
  // is an invalid_payload result, never an exception.
  let payloadRecord: Record<string, unknown> | undefined;
  try {
    payloadRecord = toRecord(JSON.parse(entry.payload));
  } catch (err) {
    return new SessionPersistenceError(
      `${entry.entryType}: unparseable payload: ${errorMessage(err)}`,
      entry.sessionId,
      'writeLogEntry',
      'invalid_payload'
    );
  }
  if (payloadRecord === undefined) {
    return new SessionPersistenceError(
      `${entry.entryType}: payload must be a JSON object`,
      entry.sessionId,
      'writeLogEntry',
      'invalid_payload'
    );
  }

  const serializeResult = serializePayload(entry.entryType, payloadRecord);

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
      `SQLite write failed: ${errorMessage(err)}`,
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
      `State object UPSERT failed: ${errorMessage(err)}`,
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
  db:        SqliteClient,
  logger:    Logger = defaultLogger
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
      `Log read failed: ${errorMessage(err)}`,
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

  // Typed accessors — throw invalid_payload on missing or wrong-type fields
  // instead of casting blindly. Resolves 2026-04-16-SP-6.
  const requireString = (
    data: Record<string, unknown>, field: string, entryId: string
  ): string => {
    const v = extractString(data, field);
    if (v === undefined) {
      throw new SessionPersistenceError(
        `Missing or non-string field '${field}' in entryId=${entryId}`,
        sessionId, 'replaySessionLog', 'invalid_payload'
      );
    }
    return v;
  };

  const requireFlagType = (
    data: Record<string, unknown>, entryId: string
  ): ActiveFlag['type'] => {
    const v = extractOneOf(data, 'type', FLAG_TYPES);
    if (v === undefined) {
      throw new SessionPersistenceError(
        `Missing or invalid 'type' field in entryId=${entryId}`,
        sessionId, 'replaySessionLog', 'invalid_payload'
      );
    }
    return v;
  };

  for (const row of rows) {
    if (row.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      logger.warn('skipping entry with unrecognized schemaVersion', {
        entryId:       row.entryId,
        schemaVersion: row.schemaVersion,
        current:       CURRENT_SCHEMA_VERSION,
      });
      continue;
    }

    // Unparseable payload is corruption, not forward-compat — surface it.
    // Resolves 2026-04-16-SP-7.
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch (err) {
      throw new SessionPersistenceError(
        `Unparseable payload entryId=${row.entryId}: ${errorMessage(err)}`,
        sessionId, 'replaySessionLog', 'invalid_payload'
      );
    }

    // Shape check: payload must be a plain non-null, non-array object.
    const data = toRecord(parsed);
    if (data === undefined) {
      const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
      throw new SessionPersistenceError(
        `Non-object payload entryId=${row.entryId}: got ${shape}`,
        sessionId, 'replaySessionLog', 'invalid_payload'
      );
    }

    // Apply typed state mutation — exhaustive switch, no fall-through
    switch (row.entryType) {
      case 'session_open': {
        const openedAt = requireString(data, 'openedAt', row.entryId);
        state.editionId         = requireString(data, 'editionId', row.entryId);
        state.openedAt          = openedAt;
        state.lastInteractionAt = openedAt;
        break;
      }

      case 'user_message':
        state.conversationHistory.push({
          role:      'user',
          content:   requireString(data, 'content', row.entryId),
          timestamp: row.timestamp,
        } satisfies Message);
        state.lastInteractionAt = row.timestamp;
        break;

      case 'assistant_response':
        state.conversationHistory.push({
          role:      'assistant',
          content:   requireString(data, 'content', row.entryId),
          timestamp: row.timestamp,
        } satisfies Message);
        state.lastInteractionAt = row.timestamp;
        break;

      case 'flag_raised':
        state.activeFlags.push({
          flagId:       requireString(data, 'flagId', row.entryId),
          type:         requireFlagType(data, row.entryId),
          content:      requireString(data, 'content', row.entryId),
          raisedAt:     row.timestamp,
          acknowledged: false,
        } satisfies ActiveFlag);
        break;

      case 'flag_acknowledged': {
        const flagId = requireString(data, 'flagId', row.entryId);
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
        logger.warn('unrecognized entryType', { entryType: String(exhaustiveCheck) });
      }
    }
  }

  return state;
}

// ── openSession ───────────────────────────────────────────────
// Load or initialize session state. Runs retention purge.

export async function openSession(
  sessionId:     string,
  userId:        string,
  editionId:     string,
  retentionDays: number,
  db:            SqliteClient,
  logger:        Logger = defaultLogger
): Promise<{ state: SessionState; purge: PurgeResult }> {
  // Attempt fast-path load from state object cache
  let state: SessionState | undefined;

  try {
    const row = await db.get<{ state_json: string }>(
      `SELECT state_json FROM session_states WHERE session_id = ?`,
      [sessionId]
    );
    if (row) {
      const cached = parseCachedState(row.state_json);
      if (cached) {
        cached.isFromLogReplay = false;
        state = cached;
      } else {
        // Cache is derived data — a row that fails validation is a miss, not an error.
        logger.warn('state cache row failed validation, falling back to replay', { sessionId });
      }
    }
  } catch (err) {
    // Cache read failure is non-fatal — fall through to replay
    logger.warn('state cache read failed, falling back to replay', {
      sessionId,
      detail: errorMessage(err),
    });
  }

  if (!state) {
    // Try log replay
    try {
      state = await replaySessionLog(sessionId, userId, db, logger);
    } catch (replayErr) {
      if (replayErr instanceof SessionPersistenceError && replayErr.cause === 'replay_error') {
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
  const purge = await purgeExpiredLogs(userId, retentionDays, db, logger);

  logger.info('openSession', {
    sessionId,
    isFromLogReplay: state.isFromLogReplay,
    purgedEntries:   purge.entriesDeleted,
  });

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
  db:            SqliteClient,
  logger:        Logger = defaultLogger
): Promise<PurgeResult> {
  // Enforce 180-day maximum regardless of caller-supplied value.
  // Baseline: 90-day default / 180-day max. Never trust caller to cap this.
  const clampedDays = Math.min(retentionDays, MAX_RETENTION_DAYS);
  if (clampedDays !== retentionDays) {
    logger.warn('retentionDays exceeds MAX_RETENTION_DAYS — clamped', {
      retentionDays,
      max:         MAX_RETENTION_DAYS,
      clampedDays,
    });
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
    logger.error('purge failed', { userId, detail: errorMessage(err) });
  }

  return { entriesDeleted, sessionsDeleted, purgedBefore: cutoff };
}
