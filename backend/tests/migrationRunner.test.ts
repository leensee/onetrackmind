// ============================================================
// OTM — Migration Runner Tests
// CJS module. Run via: npm run test:migrations
// Uses the real node:sqlite client (:memory:) — the runner's
// transaction/rollback semantics can't be proven against mocks.
// Synthetic migration dirs are created under os.tmpdir() and
// removed at the end of the run.
// ============================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSqliteClient } from '../src/db/sqliteClient';
import {
  loadMigrationsFromDir,
  parseMigrationFilename,
  runMigrations,
  splitSqlStatements,
} from '../src/db/migrationRunner';
import { SqliteClient } from '../src/orchestration/types';

const REAL_MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// ── temp-dir helpers ──────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otm-migrations-'));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs(): void {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
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

  console.log('\nMigration Runner Tests\n');

  // ── parseMigrationFilename ────────────────────────────────

  await test('parseMigrationFilename: accepts NNN_name.sql', () => {
    const a = parseMigrationFilename('001_phase4_comms.sql');
    assert(a !== undefined && a.version === 1 && a.name === 'phase4_comms',
      `unexpected parse result: ${JSON.stringify(a)}`);
    const b = parseMigrationFilename('042_add_thing.sql');
    assert(b !== undefined && b.version === 42 && b.name === 'add_thing',
      `unexpected parse result: ${JSON.stringify(b)}`);
  });

  await test('parseMigrationFilename: rejects malformed names', () => {
    const bad = [
      '1_foo.sql',        // not three digits
      '0001_foo.sql',     // four digits
      '001-foo.sql',      // wrong separator
      '001_foo.txt',      // wrong extension
      '001_.sql',         // empty name
      '001_foo bar.sql',  // whitespace in name
      'foo.sql',          // no version
    ];
    for (const name of bad) {
      assert(parseMigrationFilename(name) === undefined, `${name} must be rejected`);
    }
  });

  // ── splitSqlStatements ────────────────────────────────────

  await test('splitSqlStatements: splits plain multi-statement SQL', () => {
    const out = splitSqlStatements('CREATE TABLE a (x TEXT);\nCREATE TABLE b (y TEXT);\n');
    assert(out.length === 2, `expected 2 statements, got ${out.length}`);
    assert(out[0] === 'CREATE TABLE a (x TEXT)', `unexpected first statement: ${out[0]}`);
  });

  await test('splitSqlStatements: ignores ; inside string literals', () => {
    const out = splitSqlStatements("INSERT INTO a VALUES ('x;y');INSERT INTO a VALUES ('z');");
    assert(out.length === 2, `expected 2 statements, got ${out.length}`);
    assert(out[0]!.includes("'x;y'"), `literal must survive intact: ${out[0]}`);
  });

  await test('splitSqlStatements: ignores ; inside quoted identifiers', () => {
    const out = splitSqlStatements('CREATE INDEX "weird; name" ON a (x);');
    assert(out.length === 1, `expected 1 statement, got ${out.length}`);
    assert(out[0]!.includes('"weird; name"'), `identifier must survive intact: ${out[0]}`);
  });

  await test('splitSqlStatements: ignores ; inside -- comments', () => {
    const out = splitSqlStatements('CREATE TABLE a (\n  x TEXT -- note; not a separator\n);');
    assert(out.length === 1, `expected 1 statement, got ${out.length}`);
  });

  await test('splitSqlStatements: drops comment-only and empty segments', () => {
    assert(splitSqlStatements('').length === 0, 'empty input must yield no statements');
    assert(splitSqlStatements('  \n\t ').length === 0, 'whitespace must yield no statements');
    const out = splitSqlStatements('CREATE TABLE a (x TEXT);\n-- trailing header comment\n');
    assert(out.length === 1, `comment-only tail must be dropped, got ${out.length}`);
  });

  // ── loadMigrationsFromDir ─────────────────────────────────

  await test('loadMigrationsFromDir: missing dir → dir_not_found', () => {
    const res = loadMigrationsFromDir(path.join(os.tmpdir(), 'otm-definitely-missing-xyz'));
    assert(!res.ok && res.cause === 'dir_not_found', `unexpected: ${JSON.stringify(res)}`);
  });

  await test('loadMigrationsFromDir: bad filename → invalid_filename', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'bad-name.sql'), 'SELECT 1;');
    const res = loadMigrationsFromDir(dir);
    assert(!res.ok && res.cause === 'invalid_filename', `unexpected: ${JSON.stringify(res)}`);
  });

  await test('loadMigrationsFromDir: duplicate version → duplicate_version', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, '001_b.sql'), 'SELECT 1;');
    const res = loadMigrationsFromDir(dir);
    assert(!res.ok && res.cause === 'duplicate_version', `unexpected: ${JSON.stringify(res)}`);
  });

  await test('loadMigrationsFromDir: ignores non-.sql files, sorts by version, allows gaps', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '005_later.sql'), 'SELECT 5;');
    fs.writeFileSync(path.join(dir, '001_first.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a migration');
    const res = loadMigrationsFromDir(dir);
    assert(res.ok, `expected ok, got ${JSON.stringify(res)}`);
    if (res.ok) {
      assert(res.migrations.length === 2, `expected 2 migrations, got ${res.migrations.length}`);
      assert(res.migrations[0]!.version === 1 && res.migrations[1]!.version === 5,
        'must be sorted ascending by version');
    }
  });

  await test('loadMigrationsFromDir: blank dir is a precondition violation (throws)', () => {
    let threw = false;
    try { loadMigrationsFromDir('  '); } catch { threw = true; }
    assert(threw, 'blank dir must throw, not return a result');
  });

  // ── runMigrations ─────────────────────────────────────────

  await test('runMigrations: applies pending migrations in version order', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '002_data.sql'), "INSERT INTO t1 VALUES ('seeded');");
    fs.writeFileSync(path.join(dir, '001_table.sql'), 'CREATE TABLE t1 (x TEXT NOT NULL);');
    const client = createSqliteClient(':memory:');
    const res = await runMigrations(client, dir);
    assert(res.ok, `expected ok, got ${JSON.stringify(res)}`);
    if (res.ok) {
      assert(res.applied.length === 2 && res.skippedCount === 0,
        `expected 2 applied / 0 skipped, got ${JSON.stringify(res)}`);
      assert(res.applied[0]!.version === 1 && res.applied[1]!.version === 2,
        'applied order must be ascending — 002 depends on 001');
    }
    const rows = await client.all<{ x: string }>('SELECT x FROM t1', []);
    assert(rows.length === 1 && rows[0]!.x === 'seeded', 'migration data must be committed');
    client.close();
  });

  await test('runMigrations: records versions in schema_migrations', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '001_table.sql'), 'CREATE TABLE t1 (x TEXT);');
    const client = createSqliteClient(':memory:');
    await runMigrations(client, dir);
    const rows = await client.all<{ version: number; name: string; applied_at: string }>(
      'SELECT version, name, applied_at FROM schema_migrations', []);
    assert(rows.length === 1, `expected 1 tracker row, got ${rows.length}`);
    assert(rows[0]!.version === 1 && rows[0]!.name === 'table', 'tracker must record version + name');
    assert(rows[0]!.applied_at.length > 0, 'tracker must record applied_at');
    client.close();
  });

  await test('runMigrations: re-run skips applied and is a no-op', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '001_table.sql'), 'CREATE TABLE t1 (x TEXT);');
    fs.writeFileSync(path.join(dir, '002_more.sql'), 'CREATE TABLE t2 (y TEXT);');
    const client = createSqliteClient(':memory:');
    const first = await runMigrations(client, dir);
    assert(first.ok && first.applied.length === 2, 'first run must apply both');
    const second = await runMigrations(client, dir);
    assert(second.ok && second.applied.length === 0 && second.skippedCount === 2,
      `re-run must be a no-op, got ${JSON.stringify(second)}`);
    client.close();
  });

  await test('runMigrations: applies only newly added migrations on later runs', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '001_table.sql'), 'CREATE TABLE t1 (x TEXT);');
    const client = createSqliteClient(':memory:');
    await runMigrations(client, dir);
    fs.writeFileSync(path.join(dir, '002_more.sql'), 'CREATE TABLE t2 (y TEXT);');
    const res = await runMigrations(client, dir);
    assert(res.ok && res.applied.length === 1 && res.applied[0]!.version === 2
      && res.skippedCount === 1, `expected only 002 applied, got ${JSON.stringify(res)}`);
    client.close();
  });

  await test('runMigrations: bad migration → typed apply_error, full rollback, no version record', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '001_good.sql'), 'CREATE TABLE t1 (x TEXT);');
    fs.writeFileSync(path.join(dir, '002_bad.sql'),
      'CREATE TABLE t2 (y TEXT);\nTHIS IS NOT SQL;');
    const client = createSqliteClient(':memory:');
    const res = await runMigrations(client, dir);
    assert(!res.ok, 'bad migration must fail the run');
    if (!res.ok) {
      assert(res.cause === 'apply_error' && res.version === 2 && res.migrationName === 'bad',
        `failure must identify the migration, got ${JSON.stringify(res)}`);
      assert(res.detail.includes('statement 2/2'), `detail must locate the statement: ${res.detail}`);
    }
    const t2 = await client.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name = 't2'", []);
    assert(t2.length === 0, 'partial work of the failed migration must be rolled back');
    const tracker = await client.all<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version', []);
    assert(tracker.length === 1 && tracker[0]!.version === 1,
      'failed migration must not be recorded; prior success must remain');
    client.close();
  });

  await test('runMigrations: missing dir → typed load_error', async () => {
    const client = createSqliteClient(':memory:');
    const res = await runMigrations(client, path.join(os.tmpdir(), 'otm-definitely-missing-xyz'));
    assert(!res.ok && res.cause === 'load_error', `unexpected: ${JSON.stringify(res)}`);
    client.close();
  });

  await test('runMigrations: null client is a precondition violation (throws)', async () => {
    let threw = false;
    try {
      await runMigrations(null as unknown as SqliteClient, makeTempDir());
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes('client'), 'error must name the precondition');
    }
    assert(threw, 'null client must throw, not return a result');
  });

  // ── client connection state ───────────────────────────────

  await test('client: PRAGMA foreign_keys is ON and enforced', async () => {
    const client = createSqliteClient(':memory:');
    const pragma = await client.get<{ foreign_keys: number }>('PRAGMA foreign_keys', []);
    assert(pragma !== undefined && pragma.foreign_keys === 1, 'foreign_keys must be ON');
    await client.run('CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL)', []);
    await client.run(
      'CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT REFERENCES parent(id))', []);
    let msg = '';
    try {
      await client.run('INSERT INTO child VALUES (?, ?)', ['c1', 'missing']);
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(msg.startsWith('FOREIGN KEY constraint failed'),
      `orphan insert must be rejected, got: ${msg || '(no error)'}`);
    client.close();
  });

  await test('client: blank path is a precondition violation (throws)', () => {
    let threw = false;
    try { createSqliteClient(' '); } catch { threw = true; }
    assert(threw, 'blank path must throw');
  });

  // ── the real migrations dir ───────────────────────────────

  await test('real migrations dir applies cleanly to :memory:', async () => {
    const client = createSqliteClient(':memory:');
    const res = await runMigrations(client, REAL_MIGRATIONS_DIR);
    assert(res.ok, `real migrations must apply, got ${JSON.stringify(res)}`);
    if (res.ok) {
      assert(res.applied.some((m) => m.version === 1 && m.name === 'phase4_comms'),
        '001_phase4_comms must be among the applied migrations');
    }
    const tables = await client.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", []);
    const names = tables.map((t) => t.name);
    for (const expected of ['contacts', 'comms_log', 'idempotency_keys',
      'thread_mappings', 'polling_state', 'schema_migrations']) {
      assert(names.includes(expected), `table ${expected} must exist, have: ${names.join(', ')}`);
    }

    // Exact-set index inventory, reconciled to Notion Schema v1.4
    // (the design source of truth). A missing name means a designed
    // index never shipped; an extra name means an index shipped
    // undocumented — both must fail loudly.
    const EXPECTED_INDEXES = [
      // 001_phase4_comms
      'uq_comms_log_provider_message_id',
      'uq_idempotency_keys_provider_key_value',
      'uq_polling_state_provider_account_folder',
      'uq_thread_mappings_identifier',
      // 002_idempotency_keys_indexes
      'ix_idempotency_keys_content',
      'ix_idempotency_keys_expires',
      'ix_idempotency_keys_unsynced',
      // 003_comms_log_thread_mappings_indexes
      'ix_comms_log_contact',
      'ix_comms_log_created',
      'ix_comms_log_thread',
      'ix_comms_log_unsynced',
      'ix_thread_mappings_key',
      'ix_thread_mappings_unsynced',
    ].sort();
    const indexes = await client.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name", []);
    const indexNames = indexes.map((i) => i.name);
    assert(JSON.stringify(indexNames) === JSON.stringify(EXPECTED_INDEXES),
      `index inventory must match the schema doc exactly.\n`
      + `    expected: ${EXPECTED_INDEXES.join(', ')}\n`
      + `    actual:   ${indexNames.join(', ')}`);
    client.close();
  });

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests()
  .catch((err) => {
    console.error('Test runner error:', err);
    process.exit(1);
  })
  .finally(cleanupTempDirs);
