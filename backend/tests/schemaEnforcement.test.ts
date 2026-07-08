// ============================================================
// OTM — Live Schema Enforcement Tests (Schema v1.1)
// CJS module. Run via: npm run test:schema-live
// The live complement to fixturesMeta.test.ts: where the meta-test
// checks the corpus statically, this test proves migration
// 001_phase4_comms actually ENFORCES it — every valid fixture row
// raw-INSERTs into a freshly migrated :memory: DB; every invalid
// fixture row fails with exactly the constraint it targets.
//
// Skip semantics, derived from constraints.ts (never hardcoded):
//   - device_* fixtures: tables are Drift-native (Phase 4.6),
//     not in the backend DB — skipped.
//   - enforcedBy:'dal' targets on backend tables (e.g. malformed
//     identifiers JSON): the DB cannot express them, so those rows
//     must INSERT SUCCESSFULLY — asserted, proving they belong to
//     the DAL.
// Each fixture gets its own :memory: DB (fixtures may share PKs
// across variants); FK/UNIQUE context is seeded from the valid
// corpus. Fixture access mirrors fixturesMeta.test.ts.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import {
  CONSTRAINTS,
  Constraint,
  DEVICE_MIRRORS,
  TABLE_SHAPES,
} from './fixtures/constraints';
import { FixtureEntry, MANIFEST } from './fixtures/manifest';
import { createSqliteClient, ManagedSqliteClient } from '../src/db/sqliteClient';
import { runMigrations } from '../src/db/migrationRunner';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

type Row = Record<string, unknown>;

// ── fixture access (same access pattern as fixturesMeta.test.ts) ──

function readJson(rel: string): Row {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, rel), 'utf8')) as Row;
}
function getRow(e: FixtureEntry): Row {
  if (e.inline) return e.inline.row;
  if (e.files) return readJson(e.files.row);
  throw new Error(`fixture ${e.id} has neither files nor inline content`);
}

// ── corpus indexes ────────────────────────────────────────────

const constraintById = new Map<string, Constraint>(CONSTRAINTS.map((c) => [c.id, c]));
const isDeviceTable = (table: string): boolean => table in DEVICE_MIRRORS;

// Valid rows by table + id — the pool FK/UNIQUE context is seeded from.
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

// FK columns per table (matches 001_phase4_comms.sql / constraints.ts).
const FK_DEPS: Record<string, { column: string; parent: string }[]> = {
  comms_log: [{ column: 'contact_id', parent: 'contacts' }],
  idempotency_keys: [{ column: 'linked_message_id', parent: 'comms_log' }],
};

// ── DB helpers ────────────────────────────────────────────────

async function freshMigratedDb(): Promise<ManagedSqliteClient> {
  const client = createSqliteClient(':memory:');
  const res = await runMigrations(client, MIGRATIONS_DIR);
  if (!res.ok) {
    client.close();
    throw new Error(`migrations failed: ${JSON.stringify(res)}`);
  }
  return client;
}

async function insertRow(client: ManagedSqliteClient, table: string, row: Row): Promise<void> {
  const shape = TABLE_SHAPES[table as keyof typeof TABLE_SHAPES];
  const columns = shape.columns;
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  const params = columns.map((c) => (row[c] === undefined ? null : row[c]));
  await client.run(sql, params);
}

// Insert the row's FK parents (transitively) from the valid corpus.
// Referenced ids absent from the corpus stay unseeded — exactly the
// FK-negative fixtures' setup.
async function seedParents(
  client: ManagedSqliteClient,
  table: string,
  row: Row,
  inserted: Set<string>
): Promise<void> {
  for (const dep of FK_DEPS[table] ?? []) {
    const value = row[dep.column];
    if (value === null || value === undefined) continue;
    const parentRow = validRowsByTable.get(dep.parent)?.get(String(value));
    if (!parentRow) continue;
    const key = `${dep.parent}:${String(value)}`;
    if (inserted.has(key)) continue;
    inserted.add(key);
    await seedParents(client, dep.parent, parentRow, inserted);
    await insertRow(client, dep.parent, parentRow);
  }
}

// For partial UNIQUE indexes, only rows inside the index can collide.
function inUniqueIndex(constraint: Constraint, row: Row): boolean {
  if (constraint.id === 'CL-UQ-PROVIDER-MSG-ID') return row['provider_message_id'] !== null;
  if (constraint.id === 'IK-UQ-PROVIDER-KEY') return row['key_type'] === 'provider_id';
  return true;
}

// Seed the valid row(s) whose unique-column values collide with the
// fixture under test. Throws if the corpus holds no collision seed —
// the fixture could not violate uniqueness.
async function seedUniqueCollision(
  client: ManagedSqliteClient,
  table: string,
  row: Row,
  constraint: Constraint,
  inserted: Set<string>
): Promise<void> {
  const pool = validRowsByTable.get(table);
  const matches = [...(pool?.values() ?? [])].filter(
    (candidate) =>
      inUniqueIndex(constraint, candidate) &&
      constraint.columns.every((col) => candidate[col] === row[col])
  );
  if (matches.length === 0) {
    throw new Error(`no valid row collides with ${constraint.id} columns of the fixture`);
  }
  const seed = matches[0]!;
  const key = `${table}:${String(seed['id'])}`;
  if (!inserted.has(key)) {
    inserted.add(key);
    await seedParents(client, table, seed, inserted);
    await insertRow(client, table, seed);
  }
}

async function attemptInsert(
  client: ManagedSqliteClient,
  table: string,
  row: Row
): Promise<string | undefined> {
  try {
    await insertRow(client, table, row);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
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

  console.log('\nLive Schema Enforcement Tests (v1.1)\n');

  // Populated by the invalid-fixture pass; checked by the coverage pass.
  const liveRejected = new Set<string>();
  const dalInsertable = new Set<string>();
  const deviceSkipped = new Set<string>();

  await test('001_phase4_comms migrates cleanly with foreign_keys ON', async () => {
    const client = await freshMigratedDb();
    const pragma = await client.get<{ foreign_keys: number }>('PRAGMA foreign_keys', []);
    assert(pragma !== undefined && pragma.foreign_keys === 1,
      'FK enforcement must be active or FK assertions below are vacuous');
    client.close();
  });

  await test('every valid backend fixture row INSERTs successfully', async () => {
    const problems: string[] = [];
    let inserted = 0;
    let skippedDevice = 0;
    for (const e of MANIFEST) {
      if (e.kind !== 'valid') continue;
      if (isDeviceTable(e.table)) { skippedDevice++; continue; }
      const client = await freshMigratedDb();
      try {
        const row = getRow(e);
        await seedParents(client, e.table, row, new Set());
        const msg = await attemptInsert(client, e.table, row);
        if (msg !== undefined) problems.push(`${e.id}: ${msg}`);
        else inserted++;
      } finally {
        client.close();
      }
    }
    assert(inserted > 0, 'corpus must contain valid backend fixtures');
    assert(problems.length === 0,
      `${problems.length} valid fixture(s) rejected:\n    ${problems.join('\n    ')}`);
    console.log(`    (valid pass: ${inserted} rows inserted, ${skippedDevice} device fixtures skipped)`);
  });

  await test('every invalid backend fixture row fails with its targeted constraint', async () => {
    const problems: string[] = [];
    let rejected = 0;
    for (const e of MANIFEST) {
      if (e.kind !== 'invalid') continue;
      const constraint = e.rejects !== undefined ? constraintById.get(e.rejects) : undefined;
      if (!constraint) { problems.push(`${e.id}: rejects '${e.rejects}' not in catalog`); continue; }
      if (isDeviceTable(e.table)) {
        if (constraint.enforcedBy !== 'dal') {
          problems.push(`${e.id}: device fixture targets db-enforced ${constraint.id}`);
        }
        deviceSkipped.add(constraint.id);
        continue;
      }

      const client = await freshMigratedDb();
      try {
        const row = getRow(e);
        const seeded = new Set<string>();
        await seedParents(client, e.table, row, seeded);
        if (constraint.enforcedBy === 'db' && constraint.kind === 'unique') {
          await seedUniqueCollision(client, e.table, row, constraint, seeded);
        }
        const msg = await attemptInsert(client, e.table, row);

        if (constraint.enforcedBy === 'dal') {
          // The DB cannot express this rule — the insert must succeed,
          // proving enforcement belongs to the (future) DAL.
          if (msg !== undefined) {
            problems.push(`${e.id}: dal-targeted row was rejected by the DB: ${msg}`);
          } else {
            dalInsertable.add(constraint.id);
          }
          continue;
        }

        if (msg === undefined) {
          problems.push(`${e.id}: inserted despite targeting ${constraint.id}`);
          continue;
        }
        if (constraint.kind === 'fk') {
          // SQLite reports FKs generically; the manifest string is the
          // generic prefix plus documentation of the specific FK.
          if (!msg.startsWith('FOREIGN KEY constraint failed')
            || e.expectedError === undefined
            || !e.expectedError.startsWith('FOREIGN KEY constraint failed')) {
            problems.push(`${e.id}: expected FK failure, got: ${msg}`);
            continue;
          }
        } else if (msg !== e.expectedError) {
          problems.push(`${e.id}: expected '${e.expectedError}', got '${msg}'`);
          continue;
        }
        liveRejected.add(constraint.id);
        rejected++;
      } finally {
        client.close();
      }
    }
    assert(rejected > 0, 'corpus must contain invalid backend fixtures');
    assert(problems.length === 0,
      `${problems.length} invalid fixture(s) misbehaved:\n    ${problems.join('\n    ')}`);
    console.log(`    (invalid pass: ${rejected} rows rejected with exact constraint match, `
      + `${dalInsertable.size} dal-targeted rows correctly accepted by the DB)`);
  });

  await test('live coverage: every db-enforced constraint in the catalog was exercised', () => {
    const dbConstraints = CONSTRAINTS.filter((c) => c.enforcedBy === 'db');
    const missing = dbConstraints.filter((c) => !liveRejected.has(c.id)).map((c) => c.id);
    assert(missing.length === 0,
      `${missing.length} db constraint(s) never live-rejected: ${missing.join(', ')}`);
    const unexpected = [...liveRejected].filter((id) => constraintById.get(id)?.enforcedBy !== 'db');
    assert(unexpected.length === 0,
      `non-db constraints unexpectedly rejected by the DB: ${unexpected.join(', ')}`);
    console.log(`    (coverage: ${liveRejected.size}/${dbConstraints.length} db constraints live-enforced)`);
  });

  await test('dal-only constraints are exactly the ones the DB accepted or device skipped', () => {
    const dalConstraints = CONSTRAINTS.filter((c) => c.enforcedBy === 'dal');
    // Every dal/device outcome must map back to a dal catalog entry…
    for (const id of [...dalInsertable, ...deviceSkipped]) {
      assert(constraintById.get(id)?.enforcedBy === 'dal',
        `${id} was treated as dal-only but the catalog says otherwise`);
    }
    // …and every fixture-targeted dal constraint must have shown up in
    // one of the two skip buckets (dal rules without fixtures are fine —
    // the meta-test governs fixture existence).
    const targeted = new Set(
      MANIFEST.filter((e) => e.kind === 'invalid' && e.rejects !== undefined).map((e) => e.rejects as string)
    );
    for (const c of dalConstraints) {
      if (!targeted.has(c.id)) continue;
      assert(dalInsertable.has(c.id) || deviceSkipped.has(c.id),
        `dal constraint ${c.id} has a fixture but no live outcome`);
    }
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
