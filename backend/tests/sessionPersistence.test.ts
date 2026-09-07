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
  parseCachedState,
  SessionPersistenceError,
  CURRENT_SCHEMA_VERSION,
} from '../src/orchestration/sessionPersistence';
import { SessionState, SessionLogEntry, SqliteClient } from '../src/orchestration/types';
import { Logger, LogFields, noopLogger } from '../src/observability/logger';

// ── Capturing Logger ──────────────────────────────────────────
// Injected through the Logger seam — no console monkey-patching.

type Captured = { level: 'info' | 'warn' | 'error'; message: string; fields: LogFields | undefined };

function capturingLogger(): { logger: Logger; lines: Captured[] } {
  const lines: Captured[] = [];
  const logger: Logger = {
    info:  (message, fields) => { lines.push({ level: 'info',  message, fields }); },
    warn:  (message, fields) => { lines.push({ level: 'warn',  message, fields }); },
    error: (message, fields) => { lines.push({ level: 'error', message, fields }); },
  };
  return { logger, lines };
}

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

  // ── replaySessionLog: corruption surfacing (2026-04-16-SP-6, SP-7) ───

  await test('replaySessionLog: unparseable JSON payload throws invalid_payload (SP-7)', async () => {
    const corruptEntry: SessionLogEntry = {
      entryId:       'e-bad',
      sessionId:     SESSION_ID,
      userId:        USER_ID,
      entryType:     'user_message',
      payload:       '{not json',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      timestamp:     '2026-04-11T08:00:00.000Z',
    };
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>() { return undefined as T; },
      async all<T>() { return [corruptEntry] as unknown as T[]; },
    };
    const err = await assertThrows(
      () => replaySessionLog(SESSION_ID, USER_ID, db),
      'SessionPersistenceError',
      'must throw on unparseable payload'
    );
    assert(err.cause === 'invalid_payload', `cause must be invalid_payload, got ${err.cause}`);
    assert(err.message.includes('e-bad'), 'message must include entryId');
  });

  await test('replaySessionLog: null JSON payload throws invalid_payload', async () => {
    const entry: SessionLogEntry = {
      entryId:       'e-null',
      sessionId:     SESSION_ID,
      userId:        USER_ID,
      entryType:     'user_message',
      payload:       'null',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      timestamp:     '2026-04-11T08:00:00.000Z',
    };
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>() { return undefined as T; },
      async all<T>() { return [entry] as unknown as T[]; },
    };
    const err = await assertThrows(
      () => replaySessionLog(SESSION_ID, USER_ID, db),
      'SessionPersistenceError',
      'must throw on null payload'
    );
    assert(err.cause === 'invalid_payload', `cause must be invalid_payload, got ${err.cause}`);
    assert(err.message.includes('e-null'), 'message must include entryId');
    assert(err.message.includes('null'), 'message must mention null');
  });

  await test('replaySessionLog: array JSON payload throws invalid_payload', async () => {
    const entry: SessionLogEntry = {
      entryId:       'e-array',
      sessionId:     SESSION_ID,
      userId:        USER_ID,
      entryType:     'user_message',
      payload:       '["a","b"]',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      timestamp:     '2026-04-11T08:00:00.000Z',
    };
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>() { return undefined as T; },
      async all<T>() { return [entry] as unknown as T[]; },
    };
    const err = await assertThrows(
      () => replaySessionLog(SESSION_ID, USER_ID, db),
      'SessionPersistenceError',
      'must throw on array payload'
    );
    assert(err.cause === 'invalid_payload', `cause must be invalid_payload, got ${err.cause}`);
    assert(err.message.includes('e-array'), 'message must include entryId');
    assert(err.message.includes('array'), 'message must mention array');
  });

  await test('replaySessionLog: primitive JSON payload throws invalid_payload', async () => {
    const entry: SessionLogEntry = {
      entryId:       'e-prim',
      sessionId:     SESSION_ID,
      userId:        USER_ID,
      entryType:     'user_message',
      payload:       '42',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      timestamp:     '2026-04-11T08:00:00.000Z',
    };
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>() { return undefined as T; },
      async all<T>() { return [entry] as unknown as T[]; },
    };
    const err = await assertThrows(
      () => replaySessionLog(SESSION_ID, USER_ID, db),
      'SessionPersistenceError',
      'must throw on primitive payload'
    );
    assert(err.cause === 'invalid_payload', `cause must be invalid_payload, got ${err.cause}`);
    assert(err.message.includes('e-prim'), 'message must include entryId');
    assert(err.message.includes('number'), 'message must mention number');
  });

  await test('replaySessionLog: missing required string field throws invalid_payload (SP-6)', async () => {
    // session_open payload missing editionId
    const entry = makeLogEntry('session_open', {
      sessionId: SESSION_ID, userId: USER_ID,
      openedAt: '2026-04-11T08:00:00.000Z',
    }, { entryId: 'e-miss', timestamp: '2026-04-11T08:00:00.000Z' });
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>() { return undefined as T; },
      async all<T>() { return [entry] as unknown as T[]; },
    };
    const err = await assertThrows(
      () => replaySessionLog(SESSION_ID, USER_ID, db),
      'SessionPersistenceError',
      'must throw on missing required field'
    );
    assert(err.cause === 'invalid_payload', `cause must be invalid_payload, got ${err.cause}`);
    assert(err.message.includes('editionId'), 'message must name the missing field');
    assert(err.message.includes('e-miss'), 'message must include entryId');
  });

  await test('replaySessionLog: wrong-type field throws invalid_payload (SP-6)', async () => {
    // content is a number, not a string
    const entry = makeLogEntry('user_message',
      { content: 42, channel: 'app' } as unknown as Record<string, unknown>,
      { entryId: 'e-wrongtype', timestamp: '2026-04-11T08:00:00.000Z' }
    );
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>() { return undefined as T; },
      async all<T>() { return [entry] as unknown as T[]; },
    };
    const err = await assertThrows(
      () => replaySessionLog(SESSION_ID, USER_ID, db),
      'SessionPersistenceError',
      'must throw when field is present but wrong type'
    );
    assert(err.cause === 'invalid_payload', `cause must be invalid_payload, got ${err.cause}`);
    assert(err.message.includes('content'), 'message must name the field');
  });

  await test('replaySessionLog: invalid flag type value throws invalid_payload (SP-6)', async () => {
    const entry = makeLogEntry('flag_raised',
      { flagId: 'flag-99', type: 'bogus', content: 'corrupt' },
      { entryId: 'e-badflag', timestamp: '2026-04-11T08:00:00.000Z' }
    );
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>() { return undefined as T; },
      async all<T>() { return [entry] as unknown as T[]; },
    };
    const err = await assertThrows(
      () => replaySessionLog(SESSION_ID, USER_ID, db),
      'SessionPersistenceError',
      'must throw on out-of-union flag type'
    );
    assert(err.cause === 'invalid_payload', `cause must be invalid_payload, got ${err.cause}`);
    assert(err.message.includes('type'), 'message must name the type field');
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

  // ── parseCachedState — validated cache, no cast (otm#85) ──

  const RICH_STATE: SessionState = {
    ...BASE_STATE,
    conversationHistory: [
      { role: 'user',      content: 'pos 13 filter?', timestamp: '2026-04-11T08:00:30.000Z' },
      { role: 'assistant', content: 'Donaldson P551313.' },
    ],
    activeFlags: [
      { flagId: 'f1', type: 'safety', content: 'leak on pos 13', raisedAt: '2026-04-11T08:00:40.000Z', acknowledged: false },
    ],
    openItems: [
      { itemId: 'i1', category: 'machine', content: 'pos 13 filter swap', priority: 2, isPush: true },
    ],
    consistContext: {
      consistId: 'c1',
      relevantMachines: [
        { position: 13, name: 'Tamper', serialNumber: 'SN-13' },
        { position: 2,  name: 'Regulator' },
      ],
    },
  };

  test('parseCachedState: round-trips a full SessionState written by updateStateObject', () => {
    const parsed = parseCachedState(JSON.stringify(RICH_STATE));
    assert(parsed !== undefined, 'must parse a state this module wrote');
    assert(JSON.stringify(parsed) === JSON.stringify(RICH_STATE), 'must round-trip structurally');
  });

  test('parseCachedState: rejects non-JSON, arrays, and primitives', () => {
    for (const text of ['{', '[]', '"x"', '42', 'null', 'true']) {
      assert(parseCachedState(text) === undefined, `${text} must be rejected`);
    }
  });

  test('parseCachedState: rejects a missing top-level field', () => {
    const { userId: _dropped, ...withoutUserId } = RICH_STATE;
    assert(parseCachedState(JSON.stringify(withoutUserId)) === undefined, 'missing userId must reject');
    const { consistContext: _dropped2, ...withoutConsist } = RICH_STATE;
    assert(parseCachedState(JSON.stringify(withoutConsist)) === undefined, 'missing consistContext must reject');
  });

  test('parseCachedState: accepts null consistContext', () => {
    const parsed = parseCachedState(JSON.stringify({ ...RICH_STATE, consistContext: null }));
    assert(parsed !== undefined && parsed.consistContext === null, 'null consistContext is valid');
  });

  test('parseCachedState: rejects nested items of the wrong shape', () => {
    const badFlag = { ...RICH_STATE, activeFlags: [{ ...RICH_STATE.activeFlags[0], type: 'bogus' }] };
    assert(parseCachedState(JSON.stringify(badFlag)) === undefined, 'invalid flag type must reject');
    const badMachine = {
      ...RICH_STATE,
      consistContext: { consistId: 'c1', relevantMachines: [{ position: 'thirteen', name: 'Tamper' }] },
    };
    assert(parseCachedState(JSON.stringify(badMachine)) === undefined, 'non-numeric position must reject');
    const badMessage = { ...RICH_STATE, conversationHistory: [{ role: 'system', content: 'x' }] };
    assert(parseCachedState(JSON.stringify(badMessage)) === undefined, 'unknown message role must reject');
  });

  // ── openSession — cache validation drives the replay decision ─

  await test('openSession: valid cache row is used without replay', async () => {
    let allCalls = 0;
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>(): Promise<T | undefined> {
        return { state_json: JSON.stringify({ ...RICH_STATE, isFromLogReplay: true }) } as unknown as T;
      },
      async all<T>(): Promise<T[]> { allCalls++; return [] as T[]; },
    };
    const { state } = await openSession(SESSION_ID, USER_ID, EDITION_ID, 90, db, noopLogger);
    assert(state.isFromLogReplay === false, 'cache hit must clear isFromLogReplay');
    assert(state.activeFlags.length === 1 && state.activeFlags[0]?.flagId === 'f1', 'cached flags must survive');
    assert(allCalls === 0, 'replay must not run on a valid cache hit');
  });

  await test('openSession: cache row failing validation falls back to replay and warns', async () => {
    const entries: SessionLogEntry[] = [
      makeLogEntry('session_open', {
        sessionId: SESSION_ID, userId: USER_ID,
        editionId: EDITION_ID, openedAt: '2026-04-11T08:00:00.000Z',
      }, { entryId: 'e1', timestamp: '2026-04-11T08:00:00.000Z' }),
    ];
    const { logger, lines } = capturingLogger();
    const db: SqliteClient = {
      async run() { /* no-op */ },
      async get<T>(): Promise<T | undefined> {
        // Well-formed JSON, wrong shape: a hand-edited or future-schema row.
        return { state_json: '{"sessionId":"session-001","userId":"user-001"}' } as unknown as T;
      },
      async all<T>(): Promise<T[]> { return entries as unknown as T[]; },
    };
    const { state } = await openSession(SESSION_ID, USER_ID, EDITION_ID, 90, db, logger);
    assert(state.isFromLogReplay === true, 'must replay when the cache row fails validation');
    assert(state.editionId === EDITION_ID, 'replayed state must come from the log');
    assert(
      lines.some(l => l.level === 'warn' && l.message.includes('failed validation')),
      'must warn about the rejected cache row through the injected logger'
    );
  });

  // ── writeLogEntry — payload shape is validated, never cast ──

  await test('writeLogEntry: non-object JSON payload returns invalid_payload', async () => {
    const db = makeMockDb();
    const result = await writeLogEntry(
      { sessionId: SESSION_ID, userId: USER_ID, entryType: 'flag_acknowledged', payload: '42' },
      db
    );
    assert(result !== null && result.cause === 'invalid_payload', 'primitive payload must be invalid_payload');
    assert(result!.message.includes('must be a JSON object'), 'message must name the shape problem');
  });

  await test('writeLogEntry: malformed JSON payload returns invalid_payload instead of throwing', async () => {
    const db = makeMockDb();
    const result = await writeLogEntry(
      { sessionId: SESSION_ID, userId: USER_ID, entryType: 'flag_acknowledged', payload: '{' },
      db
    );
    assert(result !== null && result.cause === 'invalid_payload', 'unparseable payload must be invalid_payload');
    assert(result!.message.includes('unparseable payload'), 'message must say the payload was unparseable');
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
