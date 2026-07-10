// ============================================================
// OTM — idempotencyChecker Tests (Phase 4.1)
// CJS module. Run via: npm run test:idempotency
// Planner section exercises the pure half against the corpus
// (provider-id +90d pair) and synthetic boundary inputs; executor
// sections run against freshly migrated :memory: DBs (the real
// node:sqlite engine enforces ON CONFLICT / partial indexes / FKs
// live), with stub clients only for failure injection.
//
// TIMESTAMP LANDMINE (pinned): the executor's windowed SELECT
// compares first_seen_at lexicographically under the single-writer
// invariant (module-format Date.toISOString(), ms precision).
// Corpus second-precision '…:00Z' sorts AFTER '…:00.000Z' for the
// same instant — so window tests seed ONLY module-format
// timestamps (via the module itself or ms-precision literals).
// Corpus rows are used where no window comparison occurs
// (provider-id path, link).
// Synthetic identifiers only (@example.com).
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { FixtureEntry, MANIFEST } from './fixtures/manifest';
import { TABLE_SHAPES } from './fixtures/constraints';
import { createSqliteClient, ManagedSqliteClient } from '../src/db/sqliteClient';
import { runMigrations } from '../src/db/migrationRunner';
import { SqliteClient } from '../src/orchestration/types';
import { Logger, LogFields } from '../src/observability/logger';
import {
  DEDUP_WINDOW_MS,
  PROVIDER_ID_KEY_TTL_MS,
  checkIdempotencyExpiry,
} from '../src/db/mapping/dalConstraints';
import { computeContentHash } from '../src/comms/contentHash';
import {
  IdempotencyCheckerDeps,
  IdempotencyDiagnosticEvent,
  IdempotencyInput,
  IdempotencyPlan,
  IdempotencyResult,
  checkIdempotency,
  executeIdempotencyPlan,
  linkIdempotencyKey,
  noopDiagnosticEmitter,
  planIdempotencyCheck,
} from '../src/comms/idempotencyChecker';
import { noopLogger } from '../src/observability/logger';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const T0 = new Date('2026-06-05T10:00:00.000Z');

// ── fixture access (same pattern as schemaEnforcement.test.ts) ──

type Row = Record<string, unknown>;

function readJson(rel: string): Row {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, rel), 'utf8')) as Row;
}
function getRow(e: FixtureEntry): Row {
  if (e.inline) return e.inline.row;
  if (e.files) return readJson(e.files.row);
  throw new Error(`fixture ${e.id} has neither files nor inline content`);
}
function fixtureRow(id: string): Row {
  const e = MANIFEST.find((x) => x.id === id);
  if (!e) throw new Error(`manifest entry not found: ${id}`);
  return getRow(e);
}

const validRowsByTable = new Map<string, Map<string, Row>>();
for (const e of MANIFEST) {
  if (e.kind !== 'valid') continue;
  const row = getRow(e);
  let byId = validRowsByTable.get(e.table);
  if (!byId) {
    byId = new Map<string, Row>();
    validRowsByTable.set(e.table, byId);
  }
  byId.set(String(row['id']), row);
}

const FK_DEPS: Record<string, { column: string; parent: string }[]> = {
  comms_log: [{ column: 'contact_id', parent: 'contacts' }],
  idempotency_keys: [{ column: 'linked_message_id', parent: 'comms_log' }],
};

async function insertRow(client: ManagedSqliteClient, table: string, row: Row): Promise<void> {
  const shape = TABLE_SHAPES[table as keyof typeof TABLE_SHAPES];
  const columns = shape.columns;
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  await client.run(sql, columns.map((c) => (row[c] === undefined ? null : row[c])));
}

async function seedWithParents(
  client: ManagedSqliteClient,
  table: string,
  row: Row,
  inserted: Set<string>,
): Promise<void> {
  for (const dep of FK_DEPS[table] ?? []) {
    const value = row[dep.column];
    if (value === null || value === undefined) continue;
    const parentRow = validRowsByTable.get(dep.parent)?.get(String(value));
    if (!parentRow) continue;
    const key = `${dep.parent}:${String(value)}`;
    if (inserted.has(key)) continue;
    inserted.add(key);
    // The recursive call inserts parentRow itself (last line) — unlike
    // schemaEnforcement's seedParents, this variant is row-inclusive.
    await seedWithParents(client, dep.parent, parentRow, inserted);
  }
  await insertRow(client, table, row);
}

// ── DB / deps helpers ─────────────────────────────────────────

async function freshMigratedDb(): Promise<ManagedSqliteClient> {
  const client = createSqliteClient(':memory:');
  const res = await runMigrations(client, MIGRATIONS_DIR);
  if (!res.ok) {
    client.close();
    throw new Error(`migrations failed: ${JSON.stringify(res)}`);
  }
  return client;
}

interface CapturedLog {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields | undefined;
}

function capturingLogger(): { logger: Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  return {
    entries,
    logger: {
      info: (message, fields) => entries.push({ level: 'info', message, fields }),
      warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
      error: (message, fields) => entries.push({ level: 'error', message, fields }),
    },
  };
}

function capturingEmitter(): {
  emit: (event: IdempotencyDiagnosticEvent) => Promise<void>;
  events: IdempotencyDiagnosticEvent[];
} {
  const events: IdempotencyDiagnosticEvent[] = [];
  return { events, emit: async (event) => void events.push(event) };
}

function depsFor(db: SqliteClient): IdempotencyCheckerDeps {
  return { db, logger: noopLogger, emitDiagnostic: noopDiagnosticEmitter };
}

class FakeDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeDbError';
  }
}

/** Stub client: every op rejects unless overridden. */
function stubDb(overrides: Partial<SqliteClient> = {}): SqliteClient {
  return {
    run: async () => {
      throw new FakeDbError('run rejected');
    },
    get: async () => {
      throw new FakeDbError('get rejected');
    },
    all: async () => {
      throw new FakeDbError('all rejected');
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<IdempotencyInput> = {}): IdempotencyInput {
  return {
    provider: 'outlook',
    providerMessageId: 'pm-test-0001',
    fromIdentifier: 'alex.rivera@example.com',
    toIdentifiers: ['otm.owner@example.com'],
    body: 'Confirming the pump 14 service window for Friday morning.',
    ...overrides,
  };
}

async function keyCount(client: ManagedSqliteClient): Promise<number> {
  const row = await client.get<{ n: number }>('SELECT COUNT(*) AS n FROM idempotency_keys', []);
  return row?.n ?? -1;
}

// ── harness ───────────────────────────────────────────────────

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

  console.log('\nidempotencyChecker Tests\n');

  // ══ 1. Planner (pure) ═════════════════════════════════════════

  await test('planner — providerMessageId present → provider_id arm, corpus +90d expiry', () => {
    const plan = planIdempotencyCheck(makeInput(), T0);
    assert(plan.provenance === 'provider_id', `provenance ${plan.provenance}`);
    assert(plan.keyType === 'provider_id', `keyType ${plan.keyType}`);
    assert(plan.keyValue === 'pm-test-0001', `keyValue ${plan.keyValue}`);
    assert(plan.firstSeenAt === T0.toISOString(), `firstSeenAt ${plan.firstSeenAt}`);
    const expiry = checkIdempotencyExpiry({
      keyType: plan.keyType,
      firstSeenAt: plan.firstSeenAt,
      expiresAt: plan.expiresAt,
    });
    assert(expiry.ok, `expiry arithmetic rejected: ${JSON.stringify(expiry)}`);
    // Corpus pair (provider-id-key: 2026-06-05T10:00:00Z → 2026-09-03T10:00:00Z)
    // is second-precision — compare by Date.parse ms, never by string.
    const fixture = fixtureRow('idempotency_keys:provider-id-key');
    assert(
      Date.parse(plan.firstSeenAt) === Date.parse(fixture['first_seen_at'] as string) &&
        Date.parse(plan.expiresAt) === Date.parse(fixture['expires_at'] as string),
      'planner +90d pair diverges from corpus provider-id-key pair',
    );
    assert(
      Date.parse(plan.expiresAt) - Date.parse(plan.firstSeenAt) === PROVIDER_ID_KEY_TTL_MS,
      'expiry delta is not exactly +90d',
    );
  });

  await test('planner — null providerMessageId → content_hash_fallback arm (+24h, window, degradation)', () => {
    const input = makeInput({ providerMessageId: null });
    const plan = planIdempotencyCheck(input, T0);
    assert(plan.provenance === 'content_hash_fallback', `provenance ${plan.provenance}`);
    if (plan.provenance !== 'content_hash_fallback') return;
    assert(plan.keyType === 'content_hash', `keyType ${plan.keyType}`);
    assert(plan.keyValue === plan.contentHash, 'keyValue is not the contentHash');
    assert(plan.contentHash === computeContentHash(input), 'contentHash diverges from computeContentHash');
    const expiry = checkIdempotencyExpiry({
      keyType: plan.keyType,
      firstSeenAt: plan.firstSeenAt,
      expiresAt: plan.expiresAt,
    });
    assert(expiry.ok, `expiry arithmetic rejected: ${JSON.stringify(expiry)}`);
    assert(
      Date.parse(plan.firstSeenAt) - Date.parse(plan.windowStartAt) === DEDUP_WINDOW_MS,
      'windowStartAt is not exactly firstSeenAt − DEDUP_WINDOW_MS',
    );
    assert(plan.degradation === 'no_provider_message_id', `degradation ${plan.degradation}`);
  });

  await test("planner — '' providerMessageId → fallback arm with empty_provider_message_id degradation", () => {
    const plan = planIdempotencyCheck(makeInput({ providerMessageId: '' }), T0);
    assert(plan.provenance === 'content_hash_fallback', `provenance ${plan.provenance}`);
    if (plan.provenance !== 'content_hash_fallback') return;
    assert(plan.degradation === 'empty_provider_message_id', `degradation ${plan.degradation}`);
  });

  await test('planner — contentHash is computed identically on BOTH arms for the same content', () => {
    const withId = planIdempotencyCheck(makeInput(), T0);
    const withoutId = planIdempotencyCheck(makeInput({ providerMessageId: null }), T0);
    assert(withId.contentHash === withoutId.contentHash, 'compute-once hash diverges across arms');
  });

  await test('planner — deterministic; shifting now by Δ shifts every timestamp by exactly Δ', () => {
    const input = makeInput({ providerMessageId: null });
    const a = planIdempotencyCheck(input, T0);
    const b = planIdempotencyCheck(input, T0);
    assert(JSON.stringify(a) === JSON.stringify(b), 'repeated plans differ');
    const deltaMs = 12345;
    const shifted = planIdempotencyCheck(input, new Date(T0.getTime() + deltaMs));
    assert(
      Date.parse(shifted.firstSeenAt) - Date.parse(a.firstSeenAt) === deltaMs &&
        Date.parse(shifted.expiresAt) - Date.parse(a.expiresAt) === deltaMs,
      'firstSeenAt/expiresAt did not shift by Δ',
    );
    if (a.provenance === 'content_hash_fallback' && shifted.provenance === 'content_hash_fallback') {
      assert(
        Date.parse(shifted.windowStartAt) - Date.parse(a.windowStartAt) === deltaMs,
        'windowStartAt did not shift by Δ',
      );
    }
  });

  await test('planner — each provider passes through verbatim', () => {
    for (const provider of ['outlook', 'yahoo', 'twilio'] as const) {
      const plan = planIdempotencyCheck(makeInput({ provider }), T0);
      assert(plan.provider === provider, `provider ${provider} did not pass through`);
    }
  });

  // ══ 2. Executor — provider-id path ════════════════════════════

  await test('provider-id — novel on empty DB; row lands with exact columns', async () => {
    const db = await freshMigratedDb();
    try {
      const result = await checkIdempotency(makeInput(), depsFor(db), T0);
      assert(result.status === 'novel', `status ${result.status}`);
      if (result.status !== 'novel') return;
      const row = await db.get<Row>('SELECT * FROM idempotency_keys WHERE id = ?', [result.keyId]);
      assert(row !== undefined, 'inserted row not found');
      assert(row!['key_type'] === 'provider_id', `key_type ${String(row!['key_type'])}`);
      assert(row!['key_value'] === 'pm-test-0001', `key_value ${String(row!['key_value'])}`);
      assert(row!['first_seen_at'] === T0.toISOString(), `first_seen_at ${String(row!['first_seen_at'])}`);
      assert(row!['linked_message_id'] === null, 'linked_message_id not null');
      assert(row!['is_synced'] === 0, `is_synced ${String(row!['is_synced'])}`);
    } finally {
      db.close();
    }
  });

  await test('provider-id — same message twice → duplicate, matchedKeyId = first keyId, one row total', async () => {
    const db = await freshMigratedDb();
    try {
      const first = await checkIdempotency(makeInput(), depsFor(db), T0);
      const second = await checkIdempotency(makeInput(), depsFor(db), new Date(T0.getTime() + 1000));
      assert(first.status === 'novel' && second.status === 'duplicate', `${first.status}/${second.status}`);
      if (first.status !== 'novel' || second.status !== 'duplicate') return;
      assert(second.matchedKeyId === first.keyId, 'matchedKeyId is not the first keyId');
      assert(second.linkedMessageId === null, 'linkedMessageId not null for unlinked key');
      assert((await keyCount(db)) === 1, 'more than one key row stored');
    } finally {
      db.close();
    }
  });

  await test('provider-id — SOLE gate: same provider+id, different body → still duplicate', async () => {
    const db = await freshMigratedDb();
    try {
      await checkIdempotency(makeInput(), depsFor(db), T0);
      const result = await checkIdempotency(
        makeInput({ body: 'Completely different body text.' }),
        depsFor(db),
        new Date(T0.getTime() + 1000),
      );
      assert(result.status === 'duplicate', `status ${result.status} — content hash must not gate this path`);
    } finally {
      db.close();
    }
  });

  await test('provider-id — cross-provider same providerMessageId → both novel (index is per-provider)', async () => {
    const db = await freshMigratedDb();
    try {
      const a = await checkIdempotency(makeInput({ provider: 'outlook' }), depsFor(db), T0);
      const b = await checkIdempotency(makeInput({ provider: 'yahoo' }), depsFor(db), T0);
      assert(a.status === 'novel' && b.status === 'novel', `${a.status}/${b.status}`);
      assert((await keyCount(db)) === 2, 'expected two key rows');
    } finally {
      db.close();
    }
  });

  await test('provider-id — partial-index scoping: content_hash row with same key_value does not conflict', async () => {
    const db = await freshMigratedDb();
    try {
      // A content_hash-type key whose key_value happens to equal the
      // incoming provider message id must not trip the provider_id gate.
      await db.run(
        `INSERT INTO idempotency_keys (id, key_type, provider, key_value, first_seen_at, expires_at, linked_message_id, is_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'aaaaaaaa-0000-4000-8000-aaaaaaaa0001',
          'content_hash',
          'outlook',
          'pm-test-0001',
          T0.toISOString(),
          new Date(T0.getTime() + 24 * 60 * 60 * 1000).toISOString(),
          null,
          0,
        ],
      );
      const result = await checkIdempotency(makeInput(), depsFor(db), T0);
      assert(result.status === 'novel', `status ${result.status} — partial-index WHERE not respected`);
    } finally {
      db.close();
    }
  });

  await test('provider-id — duplicate against corpus key carries its linkedMessageId', async () => {
    const db = await freshMigratedDb();
    try {
      const keyRow = fixtureRow('idempotency_keys:provider-id-key');
      await seedWithParents(db, 'idempotency_keys', keyRow, new Set());
      const result = await checkIdempotency(
        makeInput({ provider: 'outlook', providerMessageId: 'pm-outlook-inbound-email-base' }),
        depsFor(db),
        T0,
      );
      assert(result.status === 'duplicate', `status ${result.status}`);
      if (result.status !== 'duplicate') return;
      assert(result.matchedKeyId === keyRow['id'], `matchedKeyId ${result.matchedKeyId}`);
      assert(result.linkedMessageId === keyRow['linked_message_id'], `linkedMessageId ${result.linkedMessageId}`);
    } finally {
      db.close();
    }
  });

  await test('provider-id — insert failure → error variant, one logger.error, one diagnostic event', async () => {
    const { logger, entries } = capturingLogger();
    const { emit, events } = capturingEmitter();
    const result = await executeIdempotencyPlan(planIdempotencyCheck(makeInput(), T0), {
      db: stubDb(),
      logger,
      emitDiagnostic: emit,
    });
    assert(result.status === 'error', `status ${result.status}`);
    if (result.status !== 'error') return;
    assert(result.reason.includes('provider_id_insert'), `reason ${result.reason}`);
    assert(result.provenance === 'provider_id' && result.contentHash.length === 64, 'error variant lost context');
    assert(entries.filter((e) => e.level === 'error').length === 1, 'expected exactly one logger.error');
    assert(events.length === 1, `expected one diagnostic event, got ${events.length}`);
    assert(
      events[0]!.op === 'provider_id_insert' &&
        events[0]!.errorClass === 'FakeDbError' &&
        events[0]!.severity === 'critical' &&
        events[0]!.provider === 'outlook',
      `event ${JSON.stringify(events[0])}`,
    );
  });

  await test('provider-id — rejecting diagnostic emitter never masks the error variant or log line', async () => {
    const { logger, entries } = capturingLogger();
    const result = await executeIdempotencyPlan(planIdempotencyCheck(makeInput(), T0), {
      db: stubDb(),
      logger,
      emitDiagnostic: async () => {
        throw new Error('adapter exploded');
      },
    });
    assert(result.status === 'error', `status ${result.status}`);
    if (result.status !== 'error') return;
    assert(result.reason.includes('provider_id_insert'), `reason ${result.reason}`);
    assert(entries.filter((e) => e.level === 'error').length === 1, 'logger.error line lost');
  });

  await test('provider-id — conflict with no visible row → typed error (anomaly), no throw', async () => {
    const { emit, events } = capturingEmitter();
    // get() resolves undefined for both the gate INSERT and the duplicate fetch.
    const db = stubDb({ get: async () => undefined });
    const result = await executeIdempotencyPlan(planIdempotencyCheck(makeInput(), T0), {
      db,
      logger: noopLogger,
      emitDiagnostic: emit,
    });
    assert(result.status === 'error', `status ${result.status}`);
    if (result.status !== 'error') return;
    assert(result.reason.includes('provider_id_conflict_fetch'), `reason ${result.reason}`);
    assert(events[0]?.errorClass === 'ConflictRowMissing', `errorClass ${events[0]?.errorClass}`);
  });

  // ══ 3. Executor — content-hash path ═══════════════════════════
  // Window seeds are module-written only (ms-precision toISOString) —
  // see the timestamp landmine note in the header.

  await test('content-hash — novel on empty DB; key_value is the content hash', async () => {
    const db = await freshMigratedDb();
    try {
      const result = await checkIdempotency(makeInput({ providerMessageId: null }), depsFor(db), T0);
      assert(result.status === 'novel', `status ${result.status}`);
      if (result.status !== 'novel') return;
      const row = await db.get<Row>('SELECT * FROM idempotency_keys WHERE id = ?', [result.keyId]);
      assert(row?.['key_type'] === 'content_hash', `key_type ${String(row?.['key_type'])}`);
      assert(row?.['key_value'] === result.contentHash, 'key_value is not the content hash');
    } finally {
      db.close();
    }
  });

  await test('content-hash — Δ = 4min → duplicate, no second row', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeInput({ providerMessageId: null });
      const first = await checkIdempotency(input, depsFor(db), T0);
      const second = await checkIdempotency(input, depsFor(db), new Date(T0.getTime() + 4 * 60 * 1000));
      assert(first.status === 'novel' && second.status === 'duplicate', `${first.status}/${second.status}`);
      if (first.status !== 'novel' || second.status !== 'duplicate') return;
      assert(second.matchedKeyId === first.keyId, 'matchedKeyId mismatch');
      assert((await keyCount(db)) === 1, 'suppressed occurrence stored a second row');
    } finally {
      db.close();
    }
  });

  await test('content-hash — Δ = exactly 10min → duplicate (window INCLUSIVE)', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeInput({ providerMessageId: null });
      await checkIdempotency(input, depsFor(db), T0);
      const result = await checkIdempotency(input, depsFor(db), new Date(T0.getTime() + DEDUP_WINDOW_MS));
      assert(result.status === 'duplicate', `status ${result.status} — boundary must be inclusive`);
    } finally {
      db.close();
    }
  });

  await test('content-hash — Δ = 10min + 1ms → novel, second row stored', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeInput({ providerMessageId: null });
      await checkIdempotency(input, depsFor(db), T0);
      const result = await checkIdempotency(input, depsFor(db), new Date(T0.getTime() + DEDUP_WINDOW_MS + 1));
      assert(result.status === 'novel', `status ${result.status} — outside window must store`);
      assert((await keyCount(db)) === 2, 'second occurrence outside window not stored');
    } finally {
      db.close();
    }
  });

  await test('content-hash — cross-provider identical content dedupes (no provider filter)', async () => {
    const db = await freshMigratedDb();
    try {
      const first = await checkIdempotency(
        makeInput({ providerMessageId: null, provider: 'yahoo' }),
        depsFor(db),
        T0,
      );
      const second = await checkIdempotency(
        makeInput({ providerMessageId: null, provider: 'twilio' }),
        depsFor(db),
        new Date(T0.getTime() + 60 * 1000),
      );
      assert(first.status === 'novel' && second.status === 'duplicate', `${first.status}/${second.status}`);
    } finally {
      db.close();
    }
  });

  await test('content-hash — future-seeded key (Δ < 0) does not suppress (upper bound <= firstSeenAt)', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeInput({ providerMessageId: null });
      const future = await checkIdempotency(input, depsFor(db), new Date(T0.getTime() + 60 * 1000));
      const result = await checkIdempotency(input, depsFor(db), T0);
      assert(future.status === 'novel' && result.status === 'novel', `${future.status}/${result.status}`);
      assert((await keyCount(db)) === 2, 'future key suppressed an earlier arrival');
    } finally {
      db.close();
    }
  });

  await test('content-hash — two in-window rows (race artifact) → most recent absorbs, deterministically', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeInput({ providerMessageId: null });
      const hash = computeContentHash(input);
      const olderAt = new Date(T0.getTime() - 2 * 60 * 1000).toISOString();
      const newerAt = new Date(T0.getTime() - 1 * 60 * 1000).toISOString();
      const insert = `INSERT INTO idempotency_keys (id, key_type, provider, key_value, first_seen_at, expires_at, linked_message_id, is_synced)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
      await db.run(insert, [
        'aaaaaaaa-0000-4000-8000-aaaaaaaa0011',
        'content_hash',
        'yahoo',
        hash,
        olderAt,
        new Date(Date.parse(olderAt) + 24 * 60 * 60 * 1000).toISOString(),
        null,
        0,
      ]);
      await db.run(insert, [
        'aaaaaaaa-0000-4000-8000-aaaaaaaa0012',
        'content_hash',
        'yahoo',
        hash,
        newerAt,
        new Date(Date.parse(newerAt) + 24 * 60 * 60 * 1000).toISOString(),
        null,
        0,
      ]);
      const result = await checkIdempotency(input, depsFor(db), T0);
      assert(result.status === 'duplicate', `status ${result.status}`);
      if (result.status !== 'duplicate') return;
      assert(
        result.matchedKeyId === 'aaaaaaaa-0000-4000-8000-aaaaaaaa0012',
        `matched ${result.matchedKeyId}, expected the most recent sighting`,
      );
    } finally {
      db.close();
    }
  });

  await test("content-hash — '' providerMessageId end-to-end → fallback result + exactly one warn", async () => {
    const db = await freshMigratedDb();
    try {
      const { logger, entries } = capturingLogger();
      const result = await checkIdempotency(makeInput({ providerMessageId: '' }), {
        db,
        logger,
        emitDiagnostic: noopDiagnosticEmitter,
      }, T0);
      assert(result.status === 'novel' && result.provenance === 'content_hash_fallback', `${result.status}/${result.provenance}`);
      assert(entries.filter((e) => e.level === 'warn').length === 1, 'expected exactly one warn');
    } finally {
      db.close();
    }
  });

  await test('content-hash — SELECT failure and INSERT failure each map to the right op', async () => {
    const plan = planIdempotencyCheck(makeInput({ providerMessageId: null }), T0);

    const selectFail = capturingEmitter();
    const selectResult = await executeIdempotencyPlan(plan, {
      db: stubDb(),
      logger: noopLogger,
      emitDiagnostic: selectFail.emit,
    });
    assert(
      selectResult.status === 'error' && selectFail.events[0]?.op === 'content_hash_select',
      `select failure mapped to ${selectFail.events[0]?.op}`,
    );

    const insertFail = capturingEmitter();
    const insertResult = await executeIdempotencyPlan(plan, {
      db: stubDb({ get: async () => undefined }),
      logger: noopLogger,
      emitDiagnostic: insertFail.emit,
    });
    assert(
      insertResult.status === 'error' && insertFail.events[0]?.op === 'content_hash_insert',
      `insert failure mapped to ${insertFail.events[0]?.op}`,
    );
  });

  // ══ 4. linkIdempotencyKey ═════════════════════════════════════

  await test('link — success backfills linked_message_id (verified by re-read)', async () => {
    const db = await freshMigratedDb();
    try {
      // Seed a real comms_log row (with its contacts parent) as the FK target.
      const message = fixtureRow('comms_log:inbound-email-base');
      await seedWithParents(db, 'comms_log', message, new Set());
      const novel = await checkIdempotency(makeInput(), depsFor(db), T0);
      assert(novel.status === 'novel', `setup: ${novel.status}`);
      if (novel.status !== 'novel') return;
      const link = await linkIdempotencyKey(novel.keyId, String(message['id']), depsFor(db));
      assert(link.ok, `link failed: ${JSON.stringify(link)}`);
      const row = await db.get<Row>('SELECT linked_message_id FROM idempotency_keys WHERE id = ?', [novel.keyId]);
      assert(row?.['linked_message_id'] === message['id'], 'linked_message_id not backfilled');
    } finally {
      db.close();
    }
  });

  await test('link — unknown keyId → key_not_found (typed, non-fatal)', async () => {
    const db = await freshMigratedDb();
    try {
      const link = await linkIdempotencyKey(
        'bbbbbbbb-0000-4000-8000-bbbbbbbb0001',
        'bbbbbbbb-0000-4000-8000-bbbbbbbb0002',
        depsFor(db),
      );
      assert(!link.ok && link.reason === 'key_not_found', `got ${JSON.stringify(link)}`);
    } finally {
      db.close();
    }
  });

  await test('link — FK violation (messageId not in comms_log) → db_error + logger.error + diagnostic', async () => {
    const db = await freshMigratedDb();
    try {
      const novel = await checkIdempotency(makeInput(), depsFor(db), T0);
      assert(novel.status === 'novel', `setup: ${novel.status}`);
      if (novel.status !== 'novel') return;
      const { logger, entries } = capturingLogger();
      const { emit, events } = capturingEmitter();
      const link = await linkIdempotencyKey(novel.keyId, 'cccccccc-0000-4000-8000-cccccccc0001', {
        db,
        logger,
        emitDiagnostic: emit,
      });
      assert(!link.ok && link.reason === 'db_error', `got ${JSON.stringify(link)}`);
      assert(entries.filter((e) => e.level === 'error').length === 1, 'expected one logger.error');
      assert(events[0]?.op === 'link_update' && events[0]?.provider === null, `event ${JSON.stringify(events[0])}`);
      const row = await db.get<Row>('SELECT linked_message_id FROM idempotency_keys WHERE id = ?', [novel.keyId]);
      assert(row?.['linked_message_id'] === null, 'failed link must leave the key unlinked');
    } finally {
      db.close();
    }
  });

  await test('link — client rejection → db_error (stub variant)', async () => {
    const link = await linkIdempotencyKey(
      'bbbbbbbb-0000-4000-8000-bbbbbbbb0003',
      'bbbbbbbb-0000-4000-8000-bbbbbbbb0004',
      { db: stubDb(), logger: noopLogger, emitDiagnostic: noopDiagnosticEmitter },
    );
    assert(!link.ok && link.reason === 'db_error', `got ${JSON.stringify(link)}`);
  });

  // ══ 5. Cross-cutting ══════════════════════════════════════════

  await test('malformed plan discriminant → throws (reserved programmer-error path)', async () => {
    const malformed = { provenance: 'bogus' } as unknown as IdempotencyPlan;
    let threw = false;
    try {
      await executeIdempotencyPlan(malformed, depsFor(stubDb()));
    } catch {
      threw = true;
    }
    assert(threw, 'malformed plan did not throw');
  });

  await test('observability hygiene — one info per decision; fields never carry from/to/body', async () => {
    const db = await freshMigratedDb();
    try {
      const { logger, entries } = capturingLogger();
      const deps: IdempotencyCheckerDeps = { db, logger, emitDiagnostic: noopDiagnosticEmitter };
      const input = makeInput();
      const novel = await checkIdempotency(input, deps, T0);
      const duplicate = await checkIdempotency(input, deps, new Date(T0.getTime() + 1000));
      assert(novel.status === 'novel' && duplicate.status === 'duplicate', `${novel.status}/${duplicate.status}`);
      const infos = entries.filter((e) => e.level === 'info');
      assert(infos.length === 2, `expected exactly two info lines, got ${infos.length}`);
      for (const info of infos) {
        const keys = Object.keys(info.fields ?? {});
        for (const required of ['provenance', 'provider', 'contentHash', 'decision']) {
          assert(keys.includes(required), `info fields missing ${required}`);
        }
        const values = JSON.stringify(info.fields ?? {});
        assert(
          !keys.some((k) => ['fromIdentifier', 'toIdentifiers', 'body'].includes(k)) &&
            !values.includes(input.fromIdentifier) &&
            !values.includes(input.body),
          'info fields leak message content',
        );
      }
    } finally {
      db.close();
    }
  });

  await test('checkIdempotency — plan+execute composition, novel → duplicate under one clock', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeInput({ providerMessageId: null });
      const results: IdempotencyResult[] = [];
      for (let i = 0; i < 2; i++) {
        results.push(await checkIdempotency(input, depsFor(db), T0));
      }
      assert(
        results[0]?.status === 'novel' && results[1]?.status === 'duplicate',
        `${results[0]?.status}/${results[1]?.status} — Δ=0 (same now) must dedupe`,
      );
    } finally {
      db.close();
    }
  });

  // ── summary ───────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('idempotencyChecker tests crashed:', err);
  process.exit(1);
});
