// ============================================================
// Tests: db/sqliteClient.ts — node:sqlite driver boundary
// Run via: npm run test:sqlite
// Covers the bind-parameter guard (otm#85 sweep): unsupported values
// are rejected at the boundary with the offending index named, and
// every supported value round-trips through run/get/all.
// ============================================================

import { createSqliteClient } from '../src/db/sqliteClient';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

async function runTests(): Promise<void> {
  console.log('\nSqliteClient Tests\n');

  const client = createSqliteClient(':memory:');
  await client.run('CREATE TABLE t (k TEXT PRIMARY KEY, v)', []);

  await test('supported bind values round-trip: null, number, bigint, string, Uint8Array', async () => {
    await client.run('INSERT INTO t (k, v) VALUES (?, ?)', ['nul',   null]);
    await client.run('INSERT INTO t (k, v) VALUES (?, ?)', ['num',   42]);
    await client.run('INSERT INTO t (k, v) VALUES (?, ?)', ['big',   BigInt(7)]);
    await client.run('INSERT INTO t (k, v) VALUES (?, ?)', ['str',   'hello']);
    await client.run('INSERT INTO t (k, v) VALUES (?, ?)', ['bytes', new Uint8Array([1, 2, 3])]);

    const rows = await client.all<{ k: string; v: unknown }>('SELECT k, v FROM t ORDER BY k', []);
    const byKey = new Map(rows.map(r => [r.k, r.v]));
    assert(rows.length === 5, `expected 5 rows, got ${rows.length}`);
    assert(byKey.get('nul') === null, 'null must round-trip');
    assert(byKey.get('num') === 42, 'number must round-trip');
    assert(Number(byKey.get('big')) === 7, 'bigint must round-trip as an INTEGER');
    assert(byKey.get('str') === 'hello', 'string must round-trip');
    const bytes = byKey.get('bytes');
    assert(bytes instanceof Uint8Array && bytes.length === 3 && bytes[2] === 3, 'Uint8Array must round-trip as a BLOB');
  });

  await test('get returns the row when present and undefined when absent', async () => {
    const hit = await client.get<{ v: unknown }>('SELECT v FROM t WHERE k = ?', ['str']);
    assert(hit?.v === 'hello', 'present row must be returned');
    const miss = await client.get<{ v: unknown }>('SELECT v FROM t WHERE k = ?', ['nope']);
    assert(miss === undefined, 'absent row must be undefined');
  });

  await test('boolean bind value rejects with a TypeError naming the parameter index', async () => {
    const err = await rejection(() => client.run('INSERT INTO t (k, v) VALUES (?, ?)', ['bool', true]));
    assert(err instanceof TypeError, `expected TypeError, got ${String(err)}`);
    assert(
      (err as Error).message.includes('parameter 1') && (err as Error).message.includes('boolean'),
      `message must name index 1 and the type; got: ${(err as Error).message}`
    );
  });

  await test('undefined bind value rejects and names undefined explicitly', async () => {
    const err = await rejection(() => client.run('INSERT INTO t (k, v) VALUES (?, ?)', ['undef', undefined]));
    assert(err instanceof TypeError, `expected TypeError, got ${String(err)}`);
    assert((err as Error).message.includes('undefined'), `message must say undefined; got: ${(err as Error).message}`);
  });

  await test('plain-object bind value rejects on get and all as well as run', async () => {
    const onGet = await rejection(() => client.get('SELECT v FROM t WHERE k = ?', [{ k: 'x' }]));
    const onAll = await rejection(() => client.all('SELECT v FROM t WHERE k = ?', [{ k: 'x' }]));
    assert(onGet instanceof TypeError && onAll instanceof TypeError, 'guard must apply to every method');
    assert((onGet as Error).message.includes('parameter 0'), 'index must be reported for get');
  });

  await test('a rejected bind leaves the table untouched', async () => {
    const rows = await client.all<{ k: string }>('SELECT k FROM t', []);
    assert(rows.length === 5, `rejected inserts must not add rows; got ${rows.length}`);
  });

  client.close();

  // ── Results ───────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
