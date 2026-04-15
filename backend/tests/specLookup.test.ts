// ============================================================
// OTM — Spec Lookup Tests
// CJS module. Run via: npm run test:spec
// Pure function tests need no stubs.
// DB-dependent tests use a minimal { all: mockFn } stub.
// ============================================================

import {
  resolveMachineIdentifier,
  buildSpecLookupResult,
  mapRosterRow,
  mapSpecRow,
  specLookup,
  SpecLookupError,
  RawRosterRow,
  RawSpecRow,
  SpecLookupDbClient,
} from '../src/orchestration/tools/specLookup';
import { MachineRosterEntry } from '../src/orchestration/types';

// ── Fixtures ──────────────────────────────────────────────────

function makeEntry(overrides: Partial<MachineRosterEntry> = {}): MachineRosterEntry {
  return {
    machineId:    'machine-001',
    position:     1,
    fullName:     'Nordco CX Spiker #1',
    machineType:  'consist',
    serialNumber: 'SN12345',
    commonNames:  ['Spiker 1', 'CX Spiker 1'],
    ...overrides,
  };
}

const SPIKER_1 = makeEntry();
const SPIKER_2 = makeEntry({
  machineId:    'machine-002',
  position:     2,
  fullName:     'Nordco CX Spiker #2',
  serialNumber: 'SN67890',
  commonNames:  ['Spiker 2', 'CX Spiker 2'],
});
const TIE_CRANE = makeEntry({
  machineId:    'machine-015',
  position:     null,
  fullName:     'Knox Kershaw 12-12 Tie Crane',
  machineType:  'support',
  serialNumber: '12-1350-22',
  commonNames:  ['Tie Crane', '12-12'],
});

const FULL_ROSTER = [SPIKER_1, SPIKER_2, TIE_CRANE];

function makeSpecRow(overrides: Partial<RawSpecRow> = {}): RawSpecRow {
  return {
    spec_key:     'engine_oil_capacity_qt',
    spec_value:   '6',
    unit:         'qt',
    source:       'OEM manual',
    confirmed_at: '2026-04-14T00:00:00.000Z',
    is_gap:       0,
    ...overrides,
  };
}

function makeRawRosterRow(overrides: Partial<RawRosterRow> = {}): RawRosterRow {
  return {
    machine_id:    'machine-001',
    position:      1,
    full_name:     'Nordco CX Spiker #1',
    machine_type:  'consist',
    serial_number: 'SN12345',
    common_names:  '["Spiker 1","CX Spiker 1"]',
    ...overrides,
  };
}

function makeStub(
  rosterRows: RawRosterRow[],
  specRows:   RawSpecRow[]
): SpecLookupDbClient {
  return {
    all: async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('fleet_master')) return rosterRows as unknown as T[];
      if (sql.includes('machine_specs')) return specRows   as unknown as T[];
      return [];
    },
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

  // ── mapRosterRow ────────────────────────────────────────────

  console.log('\n[specLookup] mapRosterRow');

  await test('maps all fields correctly', () => {
    const raw: RawRosterRow = {
      machine_id:    'abc',
      position:      5,
      full_name:     'KTC 1200 Original',
      machine_type:  'consist',
      serial_number: 'SN999',
      common_names:  '["KTC 1200","KTC"]',
    };
    const result = mapRosterRow(raw);
    assert(result.machineId    === 'abc',              'machineId');
    assert(result.position     === 5,                  'position');
    assert(result.fullName     === 'KTC 1200 Original','fullName');
    assert(result.serialNumber === 'SN999',            'serialNumber');
    assert(result.commonNames.length === 2,            'commonNames length');
    assert(result.commonNames[0]     === 'KTC 1200',   'commonNames[0]');
  });

  await test('null serial_number → undefined', () => {
    const result = mapRosterRow({
      machine_id: 'x', position: 1, full_name: 'Test',
      machine_type: 'consist', serial_number: null, common_names: '[]',
    });
    assert(result.serialNumber === undefined, 'serialNumber must be undefined');
  });

  await test('malformed common_names JSON → empty array', () => {
    const result = mapRosterRow({
      machine_id: 'x', position: 1, full_name: 'Test',
      machine_type: 'consist', serial_number: null, common_names: 'not-json',
    });
    assert(Array.isArray(result.commonNames),  'commonNames is array');
    assert(result.commonNames.length === 0,    'commonNames is empty');
  });

  await test('null position (support equipment) → null', () => {
    const result = mapRosterRow({
      machine_id: 'x', position: null, full_name: 'Tie Crane',
      machine_type: 'support', serial_number: null, common_names: '[]',
    });
    assert(result.position === null, 'position must be null for support equipment');
  });

  // ── mapSpecRow ──────────────────────────────────────────────

  console.log('\n[specLookup] mapSpecRow');

  await test('is_gap=1 → isGap true, value null', () => {
    const result = mapSpecRow({ ...makeSpecRow(), spec_value: null, is_gap: 1 });
    assert(result.isGap === true,  'isGap must be true');
    assert(result.value === null,  'value must be null');
  });

  await test('is_gap=0 → isGap false, value present', () => {
    const result = mapSpecRow(makeSpecRow());
    assert(result.isGap === false, 'isGap must be false');
    assert(result.value === '6',   'value must be present');
  });

  await test('null unit/source/confirmed_at → undefined', () => {
    const result = mapSpecRow({ ...makeSpecRow(), unit: null, source: null, confirmed_at: null });
    assert(result.unit        === undefined, 'unit undefined');
    assert(result.source      === undefined, 'source undefined');
    assert(result.confirmedAt === undefined, 'confirmedAt undefined');
  });

  // ── resolveMachineIdentifier — position ─────────────────────

  console.log('\n[specLookup] resolveMachineIdentifier — position');

  await test('resolves by position number', () => {
    const r = resolveMachineIdentifier('1', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
    if (r.status === 'found') assert(r.machine.fullName === 'Nordco CX Spiker #1', 'wrong machine');
  });

  await test('resolves with "pos " prefix', () => {
    const r = resolveMachineIdentifier('pos 2', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
    if (r.status === 'found') assert(r.machine.position === 2, 'wrong position');
  });

  await test('resolves with "position " prefix', () => {
    const r = resolveMachineIdentifier('position 1', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
  });

  await test('resolves with "#" prefix', () => {
    const r = resolveMachineIdentifier('#2', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
    if (r.status === 'found') assert(r.machine.position === 2, 'wrong position');
  });

  await test('integer with no matching position → not_found', () => {
    const r = resolveMachineIdentifier('99', FULL_ROSTER);
    assert(r.status === 'not_found', 'must be not_found for out-of-range position');
  });

  // ── resolveMachineIdentifier — serial / full name ───────────

  console.log('\n[specLookup] resolveMachineIdentifier — serial / full name');

  await test('resolves by serial number (case-insensitive)', () => {
    const r = resolveMachineIdentifier('sn12345', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
    if (r.status === 'found') assert(r.machine.machineId === 'machine-001', 'wrong machine');
  });

  await test('resolves support equipment by serial', () => {
    const r = resolveMachineIdentifier('12-1350-22', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
    if (r.status === 'found') assert(r.machine.machineType === 'support', 'must be support type');
  });

  await test('resolves by full name (case-insensitive)', () => {
    const r = resolveMachineIdentifier('nordco cx spiker #1', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
  });

  await test('resolves support equipment by full name', () => {
    const r = resolveMachineIdentifier('Knox Kershaw 12-12 Tie Crane', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
    if (r.status === 'found') assert(r.machine.position === null, 'position must be null');
  });

  // ── resolveMachineIdentifier — common name ──────────────────

  console.log('\n[specLookup] resolveMachineIdentifier — common name');

  await test('resolves by exact common name (case-insensitive)', () => {
    const r = resolveMachineIdentifier('spiker 1', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
    if (r.status === 'found') assert(r.machine.machineId === 'machine-001', 'wrong machine');
  });

  await test('"spiker 2" resolves unambiguously', () => {
    const r = resolveMachineIdentifier('spiker 2', FULL_ROSTER);
    assert(r.status === 'found', 'status must be found');
    if (r.status === 'found') assert(r.machine.machineId === 'machine-002', 'wrong machine');
  });

  await test('"spiker" alone → ambiguous via contains', () => {
    const r = resolveMachineIdentifier('spiker', FULL_ROSTER);
    assert(r.status === 'ambiguous', 'must be ambiguous');
    if (r.status === 'ambiguous') {
      assert(r.candidates.length === 2, 'must have 2 candidates');
      const ids = r.candidates.map(c => c.machineId);
      assert(ids.includes('machine-001'), 'must include spiker 1');
      assert(ids.includes('machine-002'), 'must include spiker 2');
    }
  });

  await test('"tie crane" → unambiguous via exact common name', () => {
    const r = resolveMachineIdentifier('tie crane', FULL_ROSTER);
    assert(r.status === 'found', 'must be found');
    if (r.status === 'found') assert(r.machine.machineType === 'support', 'must be support');
  });

  await test('unknown query → not_found', () => {
    const r = resolveMachineIdentifier('some unknown machine xyz', FULL_ROSTER);
    assert(r.status === 'not_found', 'must be not_found');
  });

  await test('empty roster → not_found', () => {
    const r = resolveMachineIdentifier('spiker 1', []);
    assert(r.status === 'not_found', 'must be not_found on empty roster');
  });

  await test('case-insensitive: "SPIKER 1" resolves correctly', () => {
    const r = resolveMachineIdentifier('SPIKER 1', FULL_ROSTER);
    assert(r.status === 'found', 'must be found case-insensitively');
    if (r.status === 'found') assert(r.machine.machineId === 'machine-001', 'wrong machine');
  });

  // ── buildSpecLookupResult ───────────────────────────────────

  console.log('\n[specLookup] buildSpecLookupResult');

  await test('no key filter → all entries, unknownKeys empty', () => {
    const rows = [makeSpecRow(), makeSpecRow({ spec_key: 'hydraulic_fluid_type' })];
    const result = buildSpecLookupResult(SPIKER_1, rows);
    assert(result.found === true,           'must be found');
    assert(result.entries.length === 2,     'must return all entries');
    assert(result.unknownKeys.length === 0, 'unknownKeys must be empty');
  });

  await test('key filter — match returned, no unknownKeys', () => {
    const rows = [makeSpecRow({ spec_key: 'engine_oil_capacity_qt' })];
    const result = buildSpecLookupResult(SPIKER_1, rows, ['engine_oil_capacity_qt']);
    assert(result.found === true,           'must be found');
    assert(result.entries.length === 1,     'one entry returned');
    assert(result.unknownKeys.length === 0, 'no unknownKeys');
  });

  await test('key filter — absent key → in unknownKeys', () => {
    const rows = [makeSpecRow({ spec_key: 'engine_oil_capacity_qt' })];
    const result = buildSpecLookupResult(SPIKER_1, rows, ['engine_oil_capacity_qt', 'missing_key']);
    assert(result.found === true,                          'must be found');
    assert(result.unknownKeys.includes('missing_key'),     'missing_key in unknownKeys');
    assert(result.entries.length === 1,                    'only matched entry returned');
  });

  await test('isGap=true entry surfaced — not hidden', () => {
    const rows = [makeSpecRow({ spec_value: null, is_gap: 1 })];
    const result = buildSpecLookupResult(SPIKER_1, rows);
    assert(result.found === true,              'must be found');
    assert(result.entries[0]!.isGap === true,  'gap entry must be in results');
    assert(result.entries[0]!.value === null,  'value must be null for gap');
  });

  await test('key filter is case-insensitive', () => {
    const rows = [makeSpecRow({ spec_key: 'Engine_Oil_Capacity_Qt' })];
    const result = buildSpecLookupResult(SPIKER_1, rows, ['engine_oil_capacity_qt']);
    assert(result.found === true,           'must be found');
    assert(result.entries.length === 1,     'case-insensitive key match');
    assert(result.unknownKeys.length === 0, 'no unknownKeys');
  });

  await test('all requested keys absent → all in unknownKeys, entries empty', () => {
    const result = buildSpecLookupResult(SPIKER_1, [], ['key_a', 'key_b']);
    assert(result.found === true,           'must be found');
    assert(result.entries.length === 0,     'no entries');
    assert(result.unknownKeys.length === 2, 'both keys unknown');
  });

  // ── specLookup — integration with DB stub ───────────────────

  console.log('\n[specLookup] specLookup — integration with DB stub');

  await test('happy path: found result with entries', async () => {
    const db = makeStub(
      [makeRawRosterRow()],
      [makeSpecRow(), makeSpecRow({ spec_key: 'hydraulic_fluid_type', spec_value: 'ISO 46' })]
    );
    // omit keys — no filter
    const result = await specLookup(
      { identifier: 'Spiker 1', sessionId: 's1', requestId: 'r1' },
      db
    );
    assert(result.found === true,             'must be found');
    if (result.found) {
      assert(result.machine.fullName === 'Nordco CX Spiker #1', 'machine name');
      assert(result.entries.length  === 2,   'two entries');
      assert(result.unknownKeys.length === 0,'no unknownKeys');
    }
  });

  await test('identifier matches nothing → unknown_machine', async () => {
    const db = makeStub([makeRawRosterRow()], []);
    const result = await specLookup(
      { identifier: 'nonexistent machine', sessionId: 's1', requestId: 'r1' },
      db
    );
    assert(result.found === false, 'must be not found');
    if (!result.found) assert(result.reason === 'unknown_machine', 'reason must be unknown_machine');
  });

  await test('ambiguous identifier → ambiguous with candidates', async () => {
    const db = makeStub(
      [
        makeRawRosterRow(),
        makeRawRosterRow({
          machine_id: 'machine-002', position: 2,
          full_name: 'Nordco CX Spiker #2',
          serial_number: 'SN67890',
          common_names: '["Spiker 2","CX Spiker 2"]',
        }),
      ],
      []
    );
    const result = await specLookup(
      { identifier: 'spiker', sessionId: 's1', requestId: 'r1' },
      db
    );
    assert(result.found === false, 'must be not found');
    if (!result.found) {
      assert(result.reason === 'ambiguous', 'reason must be ambiguous');
      if (result.reason === 'ambiguous') {
        assert(result.candidates.length === 2, 'must have 2 candidates');
      }
    }
  });

  await test('keys filter: absent key → in unknownKeys', async () => {
    const db = makeStub(
      [makeRawRosterRow()],
      [makeSpecRow({ spec_key: 'engine_oil_capacity_qt' })]
    );
    const result = await specLookup(
      { identifier: '1', keys: ['engine_oil_capacity_qt', 'missing_key'],
        sessionId: 's1', requestId: 'r1' },
      db
    );
    assert(result.found === true, 'must be found');
    if (result.found) {
      assert(result.unknownKeys.includes('missing_key'), 'missing_key in unknownKeys');
      assert(result.entries.length === 1, 'one entry matched');
    }
  });

  await test('support equipment resolves correctly', async () => {
    const db = makeStub(
      [makeRawRosterRow({
        machine_id: 'machine-015', position: null,
        full_name: 'Knox Kershaw 12-12 Tie Crane',
        machine_type: 'support', serial_number: '12-1350-22',
        common_names: '["Tie Crane","12-12"]',
      })],
      [makeSpecRow({ spec_key: 'hydraulic_filter_pn', spec_value: null, is_gap: 1 })]
    );
    const result = await specLookup(
      { identifier: 'tie crane', sessionId: 's1', requestId: 'r1' },
      db
    );
    assert(result.found === true, 'support equipment must resolve');
    if (result.found) {
      assert(result.machine.position === null,          'position null for support');
      assert(result.machine.machineType === 'support',  'machineType support');
      assert(result.entries[0]!.isGap === true,         'gap entry surfaced');
    }
  });

  await test('roster DB error → throws SpecLookupError with cause=db_error', async () => {
    const db: SpecLookupDbClient = {
      all: async () => { throw new Error('SQLite unavailable'); },
    };
    let threw = false;
    try {
      await specLookup({ identifier: '1', sessionId: 's1', requestId: 'r1' }, db);
    } catch (err) {
      const e = err as SpecLookupError;
      assert(e.name  === 'SpecLookupError', 'must be SpecLookupError');
      assert(e.cause === 'db_error',        'cause must be db_error');
      assert(e.sessionId === 's1',          'carries sessionId');
      threw = true;
    }
    assert(threw, 'must throw on DB error');
  });

  // ── Summary ─────────────────────────────────────────────────

  console.log(`\n[specLookup] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
