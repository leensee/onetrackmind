// ============================================================
// OTM — commsLogWriter Tests (Phase 4.1)
// CJS module. Run via: npm run test:comms-log-writer
// Assembler section exercises the pure half in isolation
// (determinism, stamps, coalesce, F2 forcing, the never-re-derive
// hash proof); inserter sections run against freshly migrated
// :memory: DBs (the real node:sqlite engine enforces the partial
// unique / CHECKs / FKs live), with stub clients only for failure
// injection — same conventions as idempotencyChecker.test.ts.
// Inputs derive from the corpus base + delivery-lifecycle rows
// where direction×channel/delivery coverage matters; synthetic
// identifiers only (@example.com).
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { FixtureEntry, MANIFEST } from './fixtures/manifest';
import { TABLE_SHAPES } from './fixtures/constraints';
import { createSqliteClient, ManagedSqliteClient } from '../src/db/sqliteClient';
import { runMigrations } from '../src/db/migrationRunner';
import { SqliteClient } from '../src/orchestration/types';
import { Logger, LogFields, noopLogger } from '../src/observability/logger';
import {
  CommsChannel,
  CommsProvider,
  DeliveryState,
  FallbackLeg,
  IdempotencyProvenance,
  TimeSensitivity,
  TriageLabel,
} from '../src/db/schemaConstants';
import { commsLogFromDb, CommsLogRow } from '../src/db/mapping/commsLog';
import { computeContentHash } from '../src/comms/contentHash';
import {
  CommsLogWriteInput,
  CommsLogWriterDeps,
  CommsLogWriterDiagnosticEvent,
  InboundCommsLogWrite,
  OutboundCommsLogWrite,
  assembleCommsLogRecord,
  noopCommsLogWriterDiagnosticEmitter,
  storeCommsLog,
} from '../src/comms/commsLogWriter';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const T0 = new Date('2026-06-05T10:00:00.000Z');

// Deliberately NOT the content hash of any test input — the writer
// must persist it verbatim (compute-once contract, never re-derive).
const SENTINEL_HASH = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffee0000';

const WRITER_ID = 'dddddddd-0000-4000-8000-dddddddd0001';

// ── fixture access (same pattern as idempotencyChecker.test.ts) ──

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

const contactRowsById = new Map<string, Row>();
for (const e of MANIFEST) {
  if (e.kind !== 'valid' || e.table !== 'contacts') continue;
  const row = getRow(e);
  contactRowsById.set(String(row['id']), row);
}

async function insertRow(client: ManagedSqliteClient, table: string, row: Row): Promise<void> {
  const shape = TABLE_SHAPES[table as keyof typeof TABLE_SHAPES];
  const columns = shape.columns;
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  await client.run(sql, columns.map((c) => (row[c] === undefined ? null : row[c])));
}

/** Seeds the contacts fixture parent an input's contactId points at (idempotent per db). */
async function seedContactFor(
  client: ManagedSqliteClient,
  contactId: string | null,
  seeded: Set<string>,
): Promise<void> {
  if (contactId === null || seeded.has(contactId)) return;
  const row = contactRowsById.get(contactId);
  if (!row) throw new Error(`no contacts fixture with id ${contactId}`);
  seeded.add(contactId);
  await insertRow(client, 'contacts', row);
}

/** Rebuilds the writer input a corpus comms_log row would have arrived as. */
function inputFromFixtureRow(row: Row): CommsLogWriteInput {
  const base = {
    provider: row['provider'] as CommsProvider,
    providerMessageId: row['provider_message_id'] as string | null,
    channel: row['channel'] as CommsChannel,
    idempotencyProvenance: row['idempotency_provenance'] as IdempotencyProvenance,
    contentHash: row['content_hash'] as string,
    threadKey: row['thread_key'] as string,
    fromIdentifier: row['from_identifier'] as string,
    toIdentifiers: JSON.parse(row['to_identifiers'] as string) as string[],
    subject: row['subject'] as string | null,
    body: row['body'] as string,
    providerTimestamp: row['provider_timestamp'] as string,
    contactId: row['contact_id'] as string | null,
    topicTag: row['topic_tag'] as string | null,
    triageLabel: row['triage_label'] as TriageLabel,
  };
  if (row['direction'] === 'inbound') {
    return {
      ...base,
      direction: 'inbound',
      timeSensitivityFlag: row['time_sensitivity_flag'] as TimeSensitivity,
    };
  }
  return {
    ...base,
    direction: 'outbound',
    deliveryState: row['delivery_state'] as DeliveryState,
    deliveryDetail: row['delivery_detail'] as string | null,
    fallbackLegUsed: row['fallback_leg_used'] as FallbackLeg | null,
  };
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
  emit: (event: CommsLogWriterDiagnosticEvent) => Promise<void>;
  events: CommsLogWriterDiagnosticEvent[];
} {
  const events: CommsLogWriterDiagnosticEvent[] = [];
  return { events, emit: async (event) => void events.push(event) };
}

function depsFor(db: SqliteClient): CommsLogWriterDeps {
  return { db, logger: noopLogger, emitDiagnostic: noopCommsLogWriterDiagnosticEmitter };
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

function makeInbound(overrides: Partial<InboundCommsLogWrite> = {}): InboundCommsLogWrite {
  return {
    direction: 'inbound',
    provider: 'outlook',
    providerMessageId: 'pm-clw-inbound-0001',
    channel: 'email',
    idempotencyProvenance: 'provider_id',
    contentHash: SENTINEL_HASH,
    threadKey: 'tk-clw-inbound',
    fromIdentifier: 'alex.rivera@example.com',
    toIdentifiers: ['otm.owner@example.com'],
    subject: 'Pump 14 service window',
    body: 'Confirming the pump 14 service window for Friday morning.',
    providerTimestamp: '2026-06-05T09:59:30.000Z',
    contactId: null,
    topicTag: 'maintenance',
    triageLabel: 'action_required',
    timeSensitivityFlag: 'hard',
    ...overrides,
  };
}

function makeOutbound(overrides: Partial<OutboundCommsLogWrite> = {}): OutboundCommsLogWrite {
  return {
    direction: 'outbound',
    provider: 'outlook',
    providerMessageId: 'pm-clw-outbound-0001',
    channel: 'email',
    idempotencyProvenance: 'provider_id',
    contentHash: SENTINEL_HASH,
    threadKey: 'tk-clw-outbound',
    fromIdentifier: 'otm.owner@example.com',
    toIdentifiers: ['alex.rivera@example.com'],
    subject: 'Pump 14 service window',
    body: 'Confirming the pump 14 service window for Friday morning.',
    providerTimestamp: '2026-06-05T09:59:30.000Z',
    contactId: null,
    topicTag: null,
    triageLabel: 'data_to_log',
    deliveryState: 'sent',
    deliveryDetail: null,
    fallbackLegUsed: null,
    ...overrides,
  };
}

async function commsLogCount(client: ManagedSqliteClient): Promise<number> {
  const row = await client.get<{ n: number }>('SELECT COUNT(*) AS n FROM comms_log', []);
  return row?.n ?? -1;
}

async function idempotencyKeyCount(client: ManagedSqliteClient): Promise<number> {
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

  console.log('\ncommsLogWriter Tests\n');

  // ══ 1. Assembler (pure) ═══════════════════════════════════════

  await test('assembler — inbound: writer stamps + pass-through fields land exactly', () => {
    const input = makeInbound();
    const domain = assembleCommsLogRecord(input, WRITER_ID, T0);
    assert(domain.id === WRITER_ID, `id ${domain.id}`);
    assert(domain.createdAt === T0.toISOString(), `createdAt ${domain.createdAt}`);
    assert(domain.isSynced === false, 'isSynced not false');
    assert(domain.userAcknowledgedAt === null, 'userAcknowledgedAt not null');
    assert(domain.userActionTaken === null, 'userActionTaken not null');
    assert(
      domain.deliveryState === null && domain.deliveryDetail === null && domain.fallbackLegUsed === null,
      'inbound row carries delivery lifecycle',
    );
    assert(domain.timeSensitivityFlag === 'hard', `timeSensitivityFlag ${domain.timeSensitivityFlag}`);
    assert(domain.providerTimestamp === input.providerTimestamp, 'providerTimestamp not verbatim');
    assert(
      domain.provider === input.provider &&
        domain.channel === input.channel &&
        domain.direction === 'inbound' &&
        domain.providerMessageId === input.providerMessageId &&
        domain.idempotencyProvenance === input.idempotencyProvenance &&
        domain.threadKey === input.threadKey &&
        domain.fromIdentifier === input.fromIdentifier &&
        domain.subject === input.subject &&
        domain.body === input.body &&
        domain.contactId === input.contactId &&
        domain.topicTag === input.topicTag &&
        domain.triageLabel === input.triageLabel,
      'pass-through field diverged',
    );
  });

  await test("assembler — outbound: delivery passes through, timeSensitivityFlag forced 'none' (F2/A)", () => {
    const domain = assembleCommsLogRecord(
      makeOutbound({ deliveryState: 'failed', deliveryDetail: 'SMTP 550', fallbackLegUsed: null }),
      WRITER_ID,
      T0,
    );
    assert(domain.direction === 'outbound', `direction ${domain.direction}`);
    assert(domain.deliveryState === 'failed', `deliveryState ${domain.deliveryState}`);
    assert(domain.deliveryDetail === 'SMTP 550', `deliveryDetail ${domain.deliveryDetail}`);
    assert(domain.fallbackLegUsed === null, `fallbackLegUsed ${domain.fallbackLegUsed}`);
    assert(domain.timeSensitivityFlag === 'none', `timeSensitivityFlag ${domain.timeSensitivityFlag} — F2/A forces none`);
  });

  await test('assembler — providerTimestamp: null coalesces to createdAt, present is verbatim', () => {
    const coalesced = assembleCommsLogRecord(makeInbound({ providerTimestamp: null }), WRITER_ID, T0);
    assert(coalesced.providerTimestamp === coalesced.createdAt, 'null did not coalesce to createdAt');
    const verbatim = assembleCommsLogRecord(makeInbound(), WRITER_ID, T0);
    assert(verbatim.providerTimestamp === '2026-06-05T09:59:30.000Z', 'explicit value not verbatim');
  });

  await test('assembler — deterministic on (input, id, now); Δ-shift of now moves only writer-stamped timestamps', () => {
    const input = makeInbound();
    const a = assembleCommsLogRecord(input, WRITER_ID, T0);
    const b = assembleCommsLogRecord(input, WRITER_ID, T0);
    assert(JSON.stringify(a) === JSON.stringify(b), 'repeated assemblies differ');
    const deltaMs = 12345;
    const shifted = assembleCommsLogRecord(input, WRITER_ID, new Date(T0.getTime() + deltaMs));
    assert(
      Date.parse(shifted.createdAt) - Date.parse(a.createdAt) === deltaMs,
      'createdAt did not shift by Δ',
    );
    assert(shifted.providerTimestamp === a.providerTimestamp, 'explicit providerTimestamp shifted with now');
    const coalescedShifted = assembleCommsLogRecord(
      makeInbound({ providerTimestamp: null }),
      WRITER_ID,
      new Date(T0.getTime() + deltaMs),
    );
    assert(
      coalescedShifted.providerTimestamp === coalescedShifted.createdAt,
      'coalesced providerTimestamp detached from createdAt under Δ-shift',
    );
  });

  await test('assembler — contentHash is the gate value verbatim, never re-derived', () => {
    const input = makeInbound();
    const derived = computeContentHash({
      fromIdentifier: input.fromIdentifier,
      toIdentifiers: input.toIdentifiers,
      body: input.body,
    });
    assert(SENTINEL_HASH !== derived, 'sentinel accidentally equals the derived hash — test is vacuous');
    const domain = assembleCommsLogRecord(input, WRITER_ID, T0);
    assert(domain.contentHash === SENTINEL_HASH, `contentHash ${domain.contentHash} — writer re-derived the hash`);
  });

  await test('assembler — malformed direction discriminant → throws (reserved programmer-error path)', () => {
    const malformed = { ...makeInbound(), direction: 'sideways' } as unknown as CommsLogWriteInput;
    let threw = false;
    try {
      assembleCommsLogRecord(malformed, WRITER_ID, T0);
    } catch {
      threw = true;
    }
    assert(threw, 'malformed direction did not throw');
  });

  // ══ 2. Inserter — stored paths ════════════════════════════════

  await test('stored — inbound email row lands with exact columns', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeInbound();
      const result = await storeCommsLog(input, depsFor(db), T0);
      assert(result.status === 'stored', `status ${result.status}`);
      if (result.status !== 'stored') return;
      const row = await db.get<Row>('SELECT * FROM comms_log WHERE id = ?', [result.id]);
      assert(row !== undefined, 'inserted row not found');
      assert(row!['created_at'] === T0.toISOString(), `created_at ${String(row!['created_at'])}`);
      assert(row!['provider'] === 'outlook' && row!['channel'] === 'email', 'provider/channel mismatch');
      assert(row!['direction'] === 'inbound', `direction ${String(row!['direction'])}`);
      assert(row!['provider_message_id'] === input.providerMessageId, 'provider_message_id mismatch');
      assert(row!['idempotency_provenance'] === 'provider_id', 'provenance mismatch');
      assert(row!['content_hash'] === SENTINEL_HASH, 'content_hash not the gate value');
      assert(row!['thread_key'] === input.threadKey, 'thread_key mismatch');
      assert(row!['from_identifier'] === input.fromIdentifier, 'from_identifier mismatch');
      assert(row!['to_identifiers'] === JSON.stringify(input.toIdentifiers), 'to_identifiers not canonical JSON');
      assert(row!['subject'] === input.subject && row!['body'] === input.body, 'subject/body mismatch');
      assert(row!['provider_timestamp'] === input.providerTimestamp, 'provider_timestamp mismatch');
      assert(row!['contact_id'] === null && row!['topic_tag'] === 'maintenance', 'contact_id/topic_tag mismatch');
      assert(row!['triage_label'] === 'action_required', `triage_label ${String(row!['triage_label'])}`);
      assert(row!['time_sensitivity_flag'] === 'hard', `time_sensitivity_flag ${String(row!['time_sensitivity_flag'])}`);
      assert(
        row!['delivery_state'] === null && row!['delivery_detail'] === null && row!['fallback_leg_used'] === null,
        'inbound delivery columns not NULL',
      );
      assert(row!['is_synced'] === 0, `is_synced ${String(row!['is_synced'])}`);
      assert(
        row!['user_acknowledged_at'] === null && row!['user_action_taken'] === null,
        'device-owned columns not NULL',
      );
    } finally {
      db.close();
    }
  });

  await test('stored — all four direction×channel corpus bases store; idempotency_keys untouched', async () => {
    const db = await freshMigratedDb();
    try {
      const seeded = new Set<string>();
      const bases = [
        'comms_log:inbound-email-base',
        'comms_log:outbound-email-base',
        'comms_log:inbound-sms-base',
        'comms_log:outbound-sms-base',
      ];
      for (const id of bases) {
        const input = inputFromFixtureRow(fixtureRow(id));
        await seedContactFor(db, input.contactId, seeded);
        const result = await storeCommsLog(input, depsFor(db), T0);
        assert(result.status === 'stored', `${id}: status ${result.status}`);
      }
      assert((await commsLogCount(db)) === 4, 'expected four comms_log rows');
      assert((await idempotencyKeyCount(db)) === 0, 'writer touched idempotency_keys');
    } finally {
      db.close();
    }
  });

  await test('stored — outbound delivery lifecycle shapes (queued / failed+detail / fallback_used+leg) pass the table CHECK', async () => {
    const db = await freshMigratedDb();
    try {
      const seeded = new Set<string>();
      const lifecycle = [
        'comms_log:delivery-queued',
        'comms_log:delivery-failed',
        'comms_log:delivery-fallback-fcm',
        'comms_log:delivery-fallback-email',
        'comms_log:delivery-fallback-sms',
      ];
      for (const id of lifecycle) {
        const fixture = fixtureRow(id);
        const input = inputFromFixtureRow(fixture);
        await seedContactFor(db, input.contactId, seeded);
        const result = await storeCommsLog(input, depsFor(db), T0);
        assert(result.status === 'stored', `${id}: status ${result.status}`);
        if (result.status !== 'stored') return;
        const row = await db.get<Row>('SELECT * FROM comms_log WHERE id = ?', [result.id]);
        assert(
          row?.['delivery_state'] === fixture['delivery_state'] &&
            row?.['delivery_detail'] === fixture['delivery_detail'] &&
            row?.['fallback_leg_used'] === fixture['fallback_leg_used'],
          `${id}: delivery columns diverged from corpus shape`,
        );
      }
    } finally {
      db.close();
    }
  });

  await test('stored — null providerTimestamp coalesces to created_at in the persisted row', async () => {
    const db = await freshMigratedDb();
    try {
      const result = await storeCommsLog(makeInbound({ providerTimestamp: null }), depsFor(db), T0);
      assert(result.status === 'stored', `status ${result.status}`);
      if (result.status !== 'stored') return;
      const row = await db.get<Row>('SELECT created_at, provider_timestamp FROM comms_log WHERE id = ?', [result.id]);
      assert(row?.['provider_timestamp'] === row?.['created_at'], 'provider_timestamp did not coalesce');
      assert(row?.['created_at'] === T0.toISOString(), 'created_at not module-format toISOString');
    } finally {
      db.close();
    }
  });

  await test('stored — round-trip: persisted row maps back to exactly the assembled domain', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeOutbound();
      const result = await storeCommsLog(input, depsFor(db), T0);
      assert(result.status === 'stored', `status ${result.status}`);
      if (result.status !== 'stored') return;
      const row = await db.get<CommsLogRow>('SELECT * FROM comms_log WHERE id = ?', [result.id]);
      assert(row !== undefined, 'row not found');
      const mapped = commsLogFromDb(row!);
      assert(mapped.ok, `commsLogFromDb rejected: ${JSON.stringify(mapped)}`);
      if (!mapped.ok) return;
      const expected = assembleCommsLogRecord(input, result.id, T0);
      // Key-order-insensitive: assembler and mapper build the same
      // fields in different insertion orders.
      const sortedKeys = Object.keys(expected).sort();
      assert(
        JSON.stringify(mapped.value, sortedKeys) === JSON.stringify(expected, sortedKeys),
        'round-tripped domain diverges from the assembled domain',
      );
    } finally {
      db.close();
    }
  });

  // ══ 3. Inserter — duplicate path ══════════════════════════════

  await test('duplicate — same provider+providerMessageId twice → duplicate variant, one row total', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeInbound();
      const first = await storeCommsLog(input, depsFor(db), T0);
      const second = await storeCommsLog(input, depsFor(db), new Date(T0.getTime() + 1000));
      assert(first.status === 'stored' && second.status === 'duplicate', `${first.status}/${second.status}`);
      if (second.status !== 'duplicate') return;
      assert(second.provider === 'outlook', `provider ${second.provider}`);
      assert(second.providerMessageId === input.providerMessageId, `providerMessageId ${second.providerMessageId}`);
      assert((await commsLogCount(db)) === 1, 'duplicate stored a second row');
    } finally {
      db.close();
    }
  });

  await test('duplicate — safety net is per-provider message identity, not content', async () => {
    const db = await freshMigratedDb();
    try {
      await storeCommsLog(makeInbound(), depsFor(db), T0);
      const result = await storeCommsLog(
        makeInbound({ body: 'Completely different body text.', threadKey: 'tk-clw-other' }),
        depsFor(db),
        new Date(T0.getTime() + 1000),
      );
      assert(result.status === 'duplicate', `status ${result.status} — same provider+id must dedupe regardless of content`);
    } finally {
      db.close();
    }
  });

  await test('stored — NULL providerMessageId rows are outside the partial unique; two both store', async () => {
    const db = await freshMigratedDb();
    try {
      const input = makeInbound({
        providerMessageId: null,
        idempotencyProvenance: 'content_hash_fallback',
      });
      const first = await storeCommsLog(input, depsFor(db), T0);
      const second = await storeCommsLog(input, depsFor(db), new Date(T0.getTime() + 1000));
      assert(first.status === 'stored' && second.status === 'stored', `${first.status}/${second.status}`);
      assert((await commsLogCount(db)) === 2, 'expected two rows for NULL provider_message_id inserts');
    } finally {
      db.close();
    }
  });

  await test('stored — cross-provider same providerMessageId → both store (unique is per-provider)', async () => {
    const db = await freshMigratedDb();
    try {
      const a = await storeCommsLog(makeInbound({ provider: 'outlook' }), depsFor(db), T0);
      const b = await storeCommsLog(makeInbound({ provider: 'yahoo' }), depsFor(db), T0);
      assert(a.status === 'stored' && b.status === 'stored', `${a.status}/${b.status}`);
      assert((await commsLogCount(db)) === 2, 'expected two rows');
    } finally {
      db.close();
    }
  });

  // ══ 4. Inserter — error paths (DB as last-line guard) ═════════

  await test('error — unknown contact_id (FK) → error variant, one logger.error, one diagnostic event', async () => {
    const db = await freshMigratedDb();
    try {
      const { logger, entries } = capturingLogger();
      const { emit, events } = capturingEmitter();
      const result = await storeCommsLog(
        makeInbound({ contactId: 'cccccccc-0000-4000-8000-cccccccc0001' }),
        { db, logger, emitDiagnostic: emit },
        T0,
      );
      assert(result.status === 'error', `status ${result.status}`);
      if (result.status !== 'error') return;
      assert(result.reason.includes('comms_log_insert'), `reason ${result.reason}`);
      assert(/FOREIGN KEY/i.test(result.reason), `reason lacks FK detail: ${result.reason}`);
      assert(entries.filter((e) => e.level === 'error').length === 1, 'expected exactly one logger.error');
      assert(events.length === 1, `expected one diagnostic event, got ${events.length}`);
      assert(
        events[0]!.module === 'commsLogWriter' &&
          events[0]!.op === 'comms_log_insert' &&
          events[0]!.severity === 'critical' &&
          events[0]!.provider === 'outlook',
        `event ${JSON.stringify(events[0])}`,
      );
      assert((await commsLogCount(db)) === 0, 'failed insert left a row behind');
    } finally {
      db.close();
    }
  });

  await test("error — provenance 'provider_id' with NULL providerMessageId → v1.1-B CHECK rejects", async () => {
    const db = await freshMigratedDb();
    try {
      const result = await storeCommsLog(
        makeInbound({ providerMessageId: null, idempotencyProvenance: 'provider_id' }),
        depsFor(db),
        T0,
      );
      assert(result.status === 'error', `status ${result.status} — DB must be the last-line guard`);
      if (result.status !== 'error') return;
      assert(
        result.reason.includes('provenance requires provider_message_id'),
        `reason ${result.reason}`,
      );
      assert((await commsLogCount(db)) === 0, 'CHECK-rejected insert left a row behind');
    } finally {
      db.close();
    }
  });

  await test('error — client rejection → error variant, one logger.error, one diagnostic event', async () => {
    const { logger, entries } = capturingLogger();
    const { emit, events } = capturingEmitter();
    const result = await storeCommsLog(makeInbound(), { db: stubDb(), logger, emitDiagnostic: emit }, T0);
    assert(result.status === 'error', `status ${result.status}`);
    if (result.status !== 'error') return;
    assert(result.reason.includes('comms_log_insert'), `reason ${result.reason}`);
    assert(entries.filter((e) => e.level === 'error').length === 1, 'expected exactly one logger.error');
    assert(
      events.length === 1 && events[0]!.errorClass === 'FakeDbError',
      `events ${JSON.stringify(events)}`,
    );
  });

  await test('error — rejecting diagnostic emitter never masks the error variant or log line', async () => {
    const { logger, entries } = capturingLogger();
    const result = await storeCommsLog(
      makeInbound(),
      {
        db: stubDb(),
        logger,
        emitDiagnostic: async () => {
          throw new Error('adapter exploded');
        },
      },
      T0,
    );
    assert(result.status === 'error', `status ${result.status}`);
    assert(entries.filter((e) => e.level === 'error').length === 1, 'logger.error line lost');
  });

  await test('error — no row returned for a NULL provider_message_id insert → typed anomaly, no throw', async () => {
    const { emit, events } = capturingEmitter();
    const result = await storeCommsLog(
      makeInbound({ providerMessageId: null, idempotencyProvenance: 'content_hash_fallback' }),
      { db: stubDb({ get: async () => undefined }), logger: noopLogger, emitDiagnostic: emit },
      T0,
    );
    assert(result.status === 'error', `status ${result.status}`);
    if (result.status !== 'error') return;
    assert(result.reason.includes('comms_log_insert'), `reason ${result.reason}`);
    assert(events[0]?.errorClass === 'InsertRowMissing', `errorClass ${events[0]?.errorClass}`);
  });

  // ══ 5. Cross-cutting ══════════════════════════════════════════

  await test('observability hygiene — one info per outcome; fields never carry from/to/body/subject', async () => {
    const db = await freshMigratedDb();
    try {
      const { logger, entries } = capturingLogger();
      const deps: CommsLogWriterDeps = { db, logger, emitDiagnostic: noopCommsLogWriterDiagnosticEmitter };
      const input = makeInbound();
      const stored = await storeCommsLog(input, deps, T0);
      const duplicate = await storeCommsLog(input, deps, new Date(T0.getTime() + 1000));
      assert(stored.status === 'stored' && duplicate.status === 'duplicate', `${stored.status}/${duplicate.status}`);
      const infos = entries.filter((e) => e.level === 'info');
      assert(infos.length === 2, `expected exactly two info lines, got ${infos.length}`);
      for (const info of infos) {
        const keys = Object.keys(info.fields ?? {});
        for (const required of ['decision', 'provider', 'contentHash']) {
          assert(keys.includes(required), `info fields missing ${required}`);
        }
        const values = JSON.stringify(info.fields ?? {});
        assert(
          !keys.some((k) => ['fromIdentifier', 'toIdentifiers', 'body', 'subject'].includes(k)) &&
            !values.includes(input.fromIdentifier) &&
            !values.includes(input.toIdentifiers[0]!) &&
            !values.includes(input.body) &&
            !values.includes(input.subject!),
          'info fields leak message content',
        );
      }
    } finally {
      db.close();
    }
  });

  // ── summary ───────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('commsLogWriter tests crashed:', err);
  process.exit(1);
});
