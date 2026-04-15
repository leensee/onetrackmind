// ============================================================
// OTM — Session Persistence Tests
// CJS module. Run via: npm run test:persistence
// Uses mock SqliteClient — no real SQLite dependency.
// ============================================================

import {
  serializePayload,
  writeLogEntry,
  updateStateObject,
  replaySessionLog,
  closeSession,
  purgeExpiredLogs,
  openSession,
  SessionPersistenceError,
  CURRENT_SCHEMA_VERSION,
} from '../src/orchestration/sessionPersistence';
import { SessionState, SessionLogEntry, SqliteClient } from '../src/orchestration/types';

// ── Mock SqliteClient ─────────────────────────────────────────

interface MockDb {
  rows:   Record<string, unknown[]>;
  log:    string[];
  errors: Record<string, Error>;
}

function makeMockDb(opts: Partial<MockDb> = {}): SqliteClient {
  const rows   = opts.rows   ?? {};
  const log    = opts.log    ?? [];
  const errors = opts.errors ?? {};

  return {
    async run(sql: string, params: unknown[]): Promise<void> {
      if (errors['run']) throw errors['run'];
      log.push(`run:${sql.trim().split('\n')[0]}:${JSON.stringify(params)}`);
    },
    async get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
      if (errors['get']) throw errors['get'];
      const key = sql.trim().split(' ')[0] + '_' + JSON.stringify(params);
      const stored = rows[key];
      return (stored?.[0] as T | undefined);
    },
    async all<T>(sql: string, params: unknown[]): Promise<T[]> {
      if (errors['all']) throw errors['all'];
      const key = sql.trim().split(' ')[0] + '_' + JSON.stringify(params);
      return (rows[key] ?? []) as T[];
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────

const SESSION_ID = 'session-001';
const USER_ID    = 'user-001';
const EDITION_ID = 'otm-v1-mechanic';

const BASE_STATE: SessionState = {
  sessionId:           SESSION_ID,
  userId:              USER_ID,
  editionId:           EDITION_ID,
  openedAt:            '2026-04-11T08:00:00.000Z',
  lastInteractionAt:   '2026-04-11T08:01:00.000Z',
  conversationHistory: [],
  activeFlags:         [],
  openItems:           [],
  consistContext:      null,
  isFromLogReplay:     false,
};

function makeLogEntry(
  entryType: SessionLogEntry['entryType'],
  payload:   Record<string, unknown>,
  overrides: Partial<SessionLogEntry> = {}
): SessionLogEntry {
  return {
    entryId:       'entry-001',
    sessionId:     SESSION_ID,
    userId:        USER_ID,
    entryType,
    payload:       JSON.stringify(payload),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    timestamp:     new Date().toISOString(),
    ...overrides,
  };
}

// ── Test Runner ───────────────────────────────────────────────

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${(err as Error).message}`);
      failed++;
    }
  }

  function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
  }

  async function assertThrows(
    fn:           () => Promise<unknown>,
    expectedName: string,
    label:        string
  ): Promise<SessionPersistenceError> {
    try {
      await fn();
      throw new Error(`Expected ${expectedName} but nothing was thrown`);
    } catch (err) {
      if ((err as Error).name !== expectedName) {
        throw new Error(`${label} — got '${(err as Error).name}' instead of '${expectedName}'`);
      }
      return err as SessionPersistenceError;
    }
  }

  console.log('\nSession Persistence Tests\n');

  // ── serializePayload ──────────────────────────────────────

  test('serializePayload: valid payload returns ok=true with JSON string', () => {
    const result = serializePayload('user_message', { content: 'test', channel: 'app' });
    assert(result.ok === true, 'must return ok=true');
    if (result.ok) {
      const parsed = JSON.parse(result.payload) as { content: string };
      assert(parsed.content === 'test', 'payload must serialize correctly');
    }
  });

  test('serializePayload: missing required field returns ok=false with missing_fields', () => {
    const result = serializePayload('user_message', { content: 'test' }); // missing channel
    assert(result.ok === false, 'must return ok=false');
    if (!result.ok) {
      assert(result.reason === 'missing_fields', 'reason must be missing_fields');
      assert(result.fields.includes('channel'), 'fields must list missing field');
    }
  });

  test('serializePayload: multiple missing fields lists all of them', () => {
    const result = serializePayload('session_open', {}); // missing all 4 fields
    assert(result.ok === false, 'must return ok=false');
    if (!result.ok) {
      assert(result.fields.length === 4, `must list all 4 missing fields, got ${result.fields.length}`);
    }
  });

  test('serializePayload: all entry types validate correctly (assistant_response)', () => {
    const result = serializePayload('assistant_response', {
      content: 'PM interval is 250 hours.',
      inputTokens: 150,
      outputTokens: 30,
      model: 'claude-sonnet-4-6',
    });
    assert(result.ok === true, 'valid assistant_response must pass');
  });

  test('serializePayload: flag_acknowledged requires only flagId', () => {
    const result = serializePayload('flag_acknowledged', { flagId: 'flag-001' });
    assert(result.ok === true, 'flag_acknowledged with flagId must pass');
  });

  test('serializePayload: session_close validates closedAt and turnCount', () => {
    const valid = serializePayload('session_close', {
      closedAt: new Date().toISOString(), turnCount: 5,
    });
    assert(valid.ok === true, 'valid session_close must pass');

    const invalid = serializePayload('session_close', { closedAt: new Date().toISOString() });
    assert(invalid.ok === false, 'missing turnCount must fail');
  });

  // ── writeLogEntry ─────────────────────────────────────────

  await test('writeLogEntry: valid entry returns null (success)', async () => {
    const db = makeMockDb();
    const result = await writeLogEntry(
      {
        sessionId: SESSION_ID,
        userId:    USER_ID,
        entryType: 'user_message',
        payload:   JSON.stringify({ content: 'test', channel: 'app' }),
      },
      db
    );
    assert(result === null, 'must return null on success');
  });

  await test('writeLogEntry: invalid payload returns SessionPersistenceError with cause=invalid_payload', async () => {
    const db = makeMockDb();
    const result = await writeLogEntry(
      {
        sessionId: SESSION_ID,
        userId:    USER_ID,
        entryType: 'user_message',
        payload:   JSON.stringify({ content: 'test' }), // missing channel
      },
      db
    );
    assert(result !== null, 'must return error on invalid payload');
    assert(result!.name === 'SessionPersistenceError', 'must be SessionPersistenceError');
    assert(result!.cause === 'invalid_payload', `cause must be invalid_payload, got ${result!.cause}`);
  });

  await test('writeLogEntry: SQLite error returns SessionPersistenceError with cause=write_error', async () => {
    const db = makeMockDb({ errors: { run: new Error('disk full') } });
    const result = await writeLogEntry(
      {
        sessionId: SESSION_ID,
        userId:    USER_ID,
        entryType: 'user_message',
        payload:   JSON.stringify({ content: 'test', channel: 'app' }),
      },
      db
    );
    assert(result !== null, 'must return error on SQLite failure');
    assert(result!.cause === 'write_error', `cause must be write_error, got ${result!.cause}`);
  });

  // ── replaySessionLog ──────────────────────────────────────

  await test('replaySessionLog: empty log throws SessionPersistenceError with cause=replay_error', async () => {
    const db = makeMockDb(); // no rows configured — all returns []
    const err = await assertThrows(
      () => replaySessionLog(SESSION_ID, USER_ID, db),
      'SessionPersistenceError',
      'must throw on empty log'
    );
    assert(err.cause === 'replay_error', `cause must be replay_error, got ${err.cause}`);
  });

  await test('replaySessionLog: sequence of entries produces correct SessionState', async () => {
    const entries: SessionLogEntry[] = [
      makeLogEntry('session_open', {
        sessionId: SESSION_ID, userId: USER_ID,
        editionId: EDITION_ID, openedAt: '2026-04-11T08:00:00.000Z',
      }, { entryId: 'e1', timestamp: '2026-04-11T08:00:00.000Z' }),
      makeLogEntry('user_message', { content: 'What is the PM interval?', channel: 'app' },
        { entryId: 'e2', timestamp: '2026-04-11T08:01:00.000Z' }),
      makeLogEntry('assistant_response', {
        content: '250 hours.', inputTokens: 100, outputTokens: 10, model: 'claude-sonnet-4-6',
      }, { entryId: 'e3', timestamp: '2026-04-11T08:01:05.000Z' }),
      makeLogEntry('flag_raised', {
        flagId: 'flag-001', type: 'safety', content: 'Hydraulic leak on pos 13',
      }, { entryId: 'e4', timestamp: '2026-04-11T08:01:10.000Z' }),
      makeLogEntry('flag_acknowledged', { flagId: 'flag-001' },
        { entryId: 'e5', timestamp: '2026-04-11T08:01:15.000Z' }),
    ];

    // Mock db.all to return entries for our session
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>() { return undefined as T; },
      async all<T>() { return entries as unknown as T[]; },
    };

    const state = await replaySessionLog(SESSION_ID, USER_ID, db);

    assert(state.isFromLogReplay === true, 'isFromLogReplay must be true');
    assert(state.editionId === EDITION_ID, 'editionId must be replayed');
    assert(state.conversationHistory.length === 2, 'must have 2 conversation turns');
    assert(state.conversationHistory[0]!.role === 'user', 'first turn must be user');
    assert(state.conversationHistory[1]!.role === 'assistant', 'second turn must be assistant');
    assert(state.activeFlags.length === 1, 'must have 1 active flag');
    assert(state.activeFlags[0]!.acknowledged === true, 'flag must be acknowledged');
  });

  await test('replaySessionLog: unknown schemaVersion entry is skipped', async () => {
    const validEntry   = makeLogEntry('session_open', {
      sessionId: SESSION_ID, userId: USER_ID,
      editionId: EDITION_ID, openedAt: '2026-04-11T08:00:00.000Z',
    }, { entryId: 'e1', timestamp: '2026-04-11T08:00:00.000Z' });

    const unknownVersionEntry = makeLogEntry('user_message',
      { content: 'future format', channel: 'app' },
      { entryId: 'e2', schemaVersion: 99, timestamp: '2026-04-11T08:01:00.000Z' }
    );

    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>() { return undefined as T; },
      async all<T>() { return [validEntry, unknownVersionEntry] as unknown as T[]; },
    };

    const state = await replaySessionLog(SESSION_ID, USER_ID, db);
    // Unknown version entry skipped — conversation history empty
    assert(state.conversationHistory.length === 0, 'unknown version entry must be skipped');
    assert(state.editionId === EDITION_ID, 'valid entry must still be applied');
  });

  // ── closeSession ──────────────────────────────────────────

  await test('closeSession: success returns null', async () => {
    const db = makeMockDb();
    const result = await closeSession(SESSION_ID, USER_ID, 5, db);
    assert(result === null, 'must return null on success');
  });

  await test('closeSession: write failure returns SessionPersistenceError', async () => {
    const db = makeMockDb({ errors: { run: new Error('disk full') } });
    const result = await closeSession(SESSION_ID, USER_ID, 5, db);
    assert(result !== null, 'must return error on failure');
    assert(result!.name === 'SessionPersistenceError', 'must be SessionPersistenceError');
  });

  // ── purgeExpiredLogs ──────────────────────────────────────

  await test('purgeExpiredLogs: returns PurgeResult with entry and session counts', async () => {
    let getCallCount = 0;
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>(): Promise<T | undefined> {
        getCallCount++;
        // First call: entry count, second call: orphan count
        return ({ count: getCallCount === 1 ? 3 : 1 }) as unknown as T;
      },
      async all<T>(): Promise<T[]> { return [] as T[]; },
    };

    const result = await purgeExpiredLogs(USER_ID, 90, db);
    assert(result.entriesDeleted === 3, `entriesDeleted must be 3, got ${result.entriesDeleted}`);
    assert(result.sessionsDeleted === 1, `sessionsDeleted must be 1, got ${result.sessionsDeleted}`);
    assert(typeof result.purgedBefore === 'string', 'purgedBefore must be a string');
  });

  await test('purgeExpiredLogs: cutoff date is correctly computed from retentionDays', async () => {
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>(): Promise<T | undefined> { return ({ count: 0 }) as unknown as T; },
      async all<T>(): Promise<T[]> { return [] as T[]; },
    };

    const before = Date.now();
    const result = await purgeExpiredLogs(USER_ID, 90, db);
    const after  = Date.now();

    const cutoff    = new Date(result.purgedBefore).getTime();
    const expected  = before - 90 * 24 * 60 * 60 * 1000;
    const tolerance = 2000; // 2 second tolerance

    assert(
      Math.abs(cutoff - expected) < tolerance,
      `cutoff must be ~90 days ago, delta=${Math.abs(cutoff - expected)}ms`
    );
    assert(cutoff < after, 'cutoff must be in the past');
  });

  // ── openSession ───────────────────────────────────────────

  await test('openSession: fresh session (no log) initializes clean state', async () => {
    // No rows, no errors — simulates a brand new session
    const db = makeMockDb();
    const { state, purge } = await openSession(
      SESSION_ID, USER_ID, EDITION_ID, 90, db
    );
    assert(state.sessionId === SESSION_ID, 'sessionId must match');
    assert(state.userId === USER_ID, 'userId must match');
    assert(state.conversationHistory.length === 0, 'fresh session must have empty history');
    assert(typeof purge.purgedBefore === 'string', 'purge result must be returned');
  });

  await test('openSession: missing state object triggers replay path', async () => {
    const entries: SessionLogEntry[] = [
      makeLogEntry('session_open', {
        sessionId: SESSION_ID, userId: USER_ID,
        editionId: EDITION_ID, openedAt: '2026-04-11T08:00:00.000Z',
      }, { entryId: 'e1', timestamp: '2026-04-11T08:00:00.000Z' }),
    ];

    // get returns undefined (no state cache), all returns entries (replay succeeds)
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>(): Promise<T | undefined> { return undefined; },
      async all<T>(): Promise<T[]> { return entries as unknown as T[]; },
    };

    const { state } = await openSession(SESSION_ID, USER_ID, EDITION_ID, 90, db);
    assert(state.isFromLogReplay === true, 'must be replayed when cache missing');
    assert(state.editionId === EDITION_ID, 'replayed state must have correct editionId');
  });

  // ── updateStateObject ─────────────────────────────────────

  await test('updateStateObject: success returns null', async () => {
    const db = makeMockDb();
    const result = await updateStateObject(BASE_STATE, db);
    assert(result === null, 'must return null on success');
  });

  await test('updateStateObject: write error returns SessionPersistenceError', async () => {
    const db = makeMockDb({ errors: { run: new Error('constraint violation') } });
    const result = await updateStateObject(BASE_STATE, db);
    assert(result !== null, 'must return error on failure');
    assert(result!.cause === 'write_error', `cause must be write_error, got ${result!.cause}`);
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
