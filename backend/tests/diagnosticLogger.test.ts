// ============================================================
// OTM — Diagnostic Logger Tests
// CJS module. Run via: npm run test:diagnostic
// Pure function tests need no stubs.
// DB tests use minimal { run, get } stubs.
// ============================================================

import {
  validateInput,
  serializeMetadata,
  logDiagnosticEntry,
  purgeOldDiagnostics,
  DiagnosticLogError,
  DiagnosticLogDbClient,
  DIAGNOSTIC_MAX_RETENTION_DAYS,
} from '../src/orchestration/tools/diagnosticLogger';
import { DiagnosticLogInput } from '../src/orchestration/types';

function makeInput(overrides: Partial<DiagnosticLogInput> = {}): DiagnosticLogInput {
  return {
    userId:    'user-001',
    sessionId: 's1',
    requestId: 'r1',
    category:  'equipment_fault',
    severity:  'warning',
    machineId: 'machine-001',
    message:   'Hydraulic pressure low on pos 1',
    ...overrides,
  };
}

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
  }
  function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(message);
  }

  // ── validateInput ─────────────────────────────────────────

  console.log('\n[diagnosticLogger] validateInput');

  await test('valid input → null', () => {
    assert(validateInput(makeInput()) === null, 'must return null');
  });
  await test('empty message → error string', () => {
    const r = validateInput(makeInput({ message: '' }));
    assert(r !== null && r.includes('message'), 'message error');
  });
  await test('whitespace-only message → error string', () => {
    const r = validateInput(makeInput({ message: '   ' }));
    assert(r !== null && r.includes('message'), 'whitespace message error');
  });
  await test('empty category → error string', () => {
    const r = validateInput(makeInput({ category: '' }));
    assert(r !== null && r.includes('category'), 'category error');
  });
  await test('invalid severity → error string naming valid values', () => {
    const r = validateInput(makeInput({ severity: 'urgent' as never }));
    assert(r !== null && r.includes('severity'), 'severity error');
    assert(r !== null && r.includes('info'), 'lists valid values');
  });
  await test('all three severity values pass validation', () => {
    for (const s of ['info', 'warning', 'critical'] as const) {
      assert(validateInput(makeInput({ severity: s })) === null, `${s} must pass`);
    }
  });
  await test('null machineId is valid (system-level event)', () => {
    assert(validateInput(makeInput({ machineId: null })) === null, 'null machineId valid');
  });

  // ── serializeMetadata ─────────────────────────────────────

  console.log('\n[diagnosticLogger] serializeMetadata');

  await test('present metadata → JSON string', () => {
    const r = serializeMetadata({ specKey: 'engine_oil', overdueDays: 3 });
    assert(r !== null, 'must return string');
    const parsed = JSON.parse(r!);
    assert(parsed.specKey === 'engine_oil', 'specKey preserved');
    assert(parsed.overdueDays === 3, 'overdueDays preserved');
  });
  await test('undefined metadata → null', () => {
    assert(serializeMetadata(undefined) === null, 'undefined → null');
  });
  await test('empty object → null', () => {
    assert(serializeMetadata({}) === null, 'empty object → null');
  });
  await test('unserializable value → null (no throw)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const r = serializeMetadata(circular);
    assert(r === null, 'circular ref → null, no throw');
  });

  // ── logDiagnosticEntry ────────────────────────────────────

  console.log('\n[diagnosticLogger] logDiagnosticEntry');

  await test('happy path → null, INSERT called with correct params', async () => {
    let sql = '';
    let params: unknown[] = [];
    const db: DiagnosticLogDbClient = {
      run: async (s, p) => { sql = s; params = p; },
      get: async () => undefined,
    };
    const result = await logDiagnosticEntry(makeInput(), db);
    assert(result === null, 'must return null on success');
    assert(sql.includes('diagnostic_log'), 'must INSERT into diagnostic_log');
    assert((params as unknown[]).includes('equipment_fault'), 'category in params');
    assert((params as unknown[]).includes('warning'),         'severity in params');
    assert((params as unknown[]).includes('machine-001'),     'machineId in params');
    assert((params as unknown[])[params.length - 1] === 0,   'is_synced param is 0');
  });
  await test('invalid input → DiagnosticLogError(invalid_input), no DB call', async () => {
    let dbCalled = false;
    const db: DiagnosticLogDbClient = {
      run: async () => { dbCalled = true; },
      get: async () => undefined,
    };
    const result = await logDiagnosticEntry(makeInput({ message: '' }), db);
    assert(result instanceof DiagnosticLogError, 'must be DiagnosticLogError');
    assert(result!.cause === 'invalid_input', 'cause invalid_input');
    assert(!dbCalled, 'DB must not be called on invalid input');
  });

  await test('write failure → DiagnosticLogError(write_error)', async () => {
    const db: DiagnosticLogDbClient = {
      run: async () => { throw new Error('disk full'); },
      get: async () => undefined,
    };
    const result = await logDiagnosticEntry(makeInput(), db);
    assert(result instanceof DiagnosticLogError, 'must be DiagnosticLogError');
    assert(result!.cause === 'write_error', 'cause write_error');
    assert(result!.sessionId === 's1', 'carries sessionId');
    assert(result!.requestId === 'r1', 'carries requestId');
  });
  await test('null machineId written as null in params', async () => {
    let params: unknown[] = [];
    const db: DiagnosticLogDbClient = {
      run: async (_, p) => { params = p; },
      get: async () => undefined,
    };
    await logDiagnosticEntry(makeInput({ machineId: null }), db);
    assert(params.includes(null), 'null machineId in params');
  });
  await test('metadata serialized into params', async () => {
    let params: unknown[] = [];
    const db: DiagnosticLogDbClient = {
      run: async (_, p) => { params = p; },
      get: async () => undefined,
    };
    await logDiagnosticEntry(makeInput({ metadata: { key: 'val' } }), db);
    const metaParam = params.find(p => typeof p === 'string' && p.includes('key'));
    assert(metaParam !== undefined, 'metadata serialized in params');
  });

  // ── purgeOldDiagnostics ───────────────────────────────────

  console.log('\n[diagnosticLogger] purgeOldDiagnostics');

  await test('returns DiagnosticPurgeResult with count and cutoff', async () => {
    let getCount = 0;
    const db: DiagnosticLogDbClient = {
      run: async () => { /* no-op */ },
      get: async <T>(): Promise<T | undefined> => {
        getCount++;
        return ({ count: 5 }) as unknown as T;
      },
    };
    const result = await purgeOldDiagnostics('user-001', 90, db);
    assert(result.entriesDeleted === 5, 'entriesDeleted = 5');
    assert(typeof result.purgedBefore === 'string', 'purgedBefore is string');
  });
  await test('only deletes is_synced=1 rows (SQL check)', async () => {
    let capturedSql = '';
    const db: DiagnosticLogDbClient = {
      run: async (s) => { capturedSql = s; },
      get: async <T>(): Promise<T | undefined> => ({ count: 0 }) as unknown as T,
    };
    await purgeOldDiagnostics('user-001', 90, db);
    assert(capturedSql.includes('is_synced = 1'), 'DELETE must filter is_synced = 1');
  });

  await test('clamps retentionDays to 180-day max', async () => {
    const capturedSqls: string[] = [];
    const db: DiagnosticLogDbClient = {
      run: async (s) => { capturedSqls.push(s); },
      get: async <T>(): Promise<T | undefined> => ({ count: 0 }) as unknown as T,
    };
    const before = Date.now();
    const result  = await purgeOldDiagnostics('user-001', 999, db);
    const cutoff  = new Date(result.purgedBefore).getTime();
    const maxCutoff = before - DIAGNOSTIC_MAX_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    // cutoff must not be older than 180-day max
    assert(cutoff >= maxCutoff - 2000, 'cutoff must be clamped to 180-day max');
  });
  await test('DB failure → non-fatal, returns zero counts', async () => {
    const db: DiagnosticLogDbClient = {
      run: async () => { throw new Error('DB unavailable'); },
      get: async () => { throw new Error('DB unavailable'); },
    };
    const result = await purgeOldDiagnostics('user-001', 90, db);
    assert(result.entriesDeleted === 0, 'entriesDeleted = 0 on failure');
    assert(typeof result.purgedBefore === 'string', 'purgedBefore still returned');
  });
  await test('cutoff is ~retentionDays ago', async () => {
    const db: DiagnosticLogDbClient = {
      run: async () => { /* no-op */ },
      get: async <T>(): Promise<T | undefined> => ({ count: 0 }) as unknown as T,
    };
    const before = Date.now();
    const result  = await purgeOldDiagnostics('user-001', 90, db);
    const cutoff  = new Date(result.purgedBefore).getTime();
    const expected = before - 90 * 24 * 60 * 60 * 1000;
    assert(Math.abs(cutoff - expected) < 2000, 'cutoff ~90 days ago');
  });

  // ── Summary ───────────────────────────────────────────────

  console.log(`\n[diagnosticLogger] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err); process.exit(1); });
