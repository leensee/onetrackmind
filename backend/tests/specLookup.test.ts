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
  machineId: 'machine-002', position: 2,
  fullName: 'Nordco CX Spiker #2', serialNumber: 'SN67890',
  commonNames: ['Spiker 2', 'CX Spiker 2'],
});
const TIE_CRANE = makeEntry({
  machineId: 'machine-015', position: null,
  fullName: 'Knox Kershaw 12-12 Tie Crane', machineType: 'support',
  serialNumber: '12-1350-22', commonNames: ['Tie Crane', '12-12'],
});
const FULL_ROSTER = [SPIKER_1, SPIKER_2, TIE_CRANE];

function makeSpecRow(overrides: Partial<RawSpecRow> = {}): RawSpecRow {
  return {
    spec_key: 'engine_oil_capacity_qt', spec_value: '6', unit: 'qt',
    source: 'OEM manual', confirmed_at: '2026-04-14T00:00:00.000Z', is_gap: 0,
    ...overrides,
  };
}
function makeRawRosterRow(overrides: Partial<RawRosterRow> = {}): RawRosterRow {
  return {
    machine_id: 'machine-001', position: 1, full_name: 'Nordco CX Spiker #1',
    machine_type: 'consist', serial_number: 'SN12345',
    common_names: '["Spiker 1","CX Spiker 1"]',
    ...overrides,
  };
}
function makeStub(rosterRows: RawRosterRow[], specRows: RawSpecRow[]): SpecLookupDbClient {
  return {
    all: async <T>(sql: string): Promise<T[]> => {
      if (sql.includes('fleet_master')) return rosterRows as unknown as T[];
      if (sql.includes('machine_specs')) return specRows   as unknown as T[];
      return [];
    },
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

  // ── mapRosterRow ──────────────────────────────────────────────
  console.log('\n[specLookup] mapRosterRow');

  await test('maps all fields correctly', () => {
    const r = mapRosterRow({ machine_id: 'abc', position: 5, full_name: 'KTC 1200 Original',
      machine_type: 'consist', serial_number: 'SN999', common_names: '["KTC 1200","KTC"]' });
    assert(r.machineId === 'abc' && r.position === 5 && r.fullName === 'KTC 1200 Original', 'fields');
    assert(r.commonNames.length === 2 && r.commonNames[0] === 'KTC 1200', 'commonNames');
  });
  await test('null serial_number → undefined', () => {
    const r = mapRosterRow({ machine_id: 'x', position: 1, full_name: 'T',
      machine_type: 'consist', serial_number: null, common_names: '[]' });
    assert(r.serialNumber === undefined, 'serialNumber undefined');
  });
  await test('malformed common_names JSON → empty array', () => {
    const r = mapRosterRow({ machine_id: 'x', position: 1, full_name: 'T',
      machine_type: 'consist', serial_number: null, common_names: 'not-json' });
    assert(r.commonNames.length === 0, 'empty array');
  });
  await test('null position (support) → null', () => {
    const r = mapRosterRow({ machine_id: 'x', position: null, full_name: 'Tie Crane',
      machine_type: 'support', serial_number: null, common_names: '[]' });
    assert(r.position === null, 'position null');
  });

  // ── mapSpecRow ────────────────────────────────────────────────
  console.log('\n[specLookup] mapSpecRow');

  await test('is_gap=1 → isGap true, value null', () => {
    const r = mapSpecRow({ ...makeSpecRow(), spec_value: null, is_gap: 1 });
    assert(r.isGap === true && r.value === null, 'gap');
  });
  await test('is_gap=0 → isGap false, value present', () => {
    const r = mapSpecRow(makeSpecRow());
    assert(r.isGap === false && r.value === '6', 'not gap');
  });
  await test('null unit/source/confirmed_at → undefined', () => {
    const r = mapSpecRow({ ...makeSpecRow(), unit: null, source: null, confirmed_at: null });
    assert(r.unit === undefined && r.source === undefined && r.confirmedAt === undefined, 'undefineds');
  });

  // ── resolveMachineIdentifier — position ───────────────────────
  console.log('\n[specLookup] resolveMachineIdentifier — position');

  await test('resolves by position number', () => {
    const r = resolveMachineIdentifier('1', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.fullName === 'Nordco CX Spiker #1', 'name');
  });
  await test('resolves with "pos " prefix', () => {
    const r = resolveMachineIdentifier('pos 2', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.position === 2, 'position');
  });
  await test('resolves with "position " prefix', () => {
    assert(resolveMachineIdentifier('position 1', FULL_ROSTER).status === 'found', 'found');
  });
  await test('resolves with "#" prefix', () => {
    const r = resolveMachineIdentifier('#2', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.position === 2, 'position');
  });
  await test('integer with no matching position → not_found', () => {
    assert(resolveMachineIdentifier('99', FULL_ROSTER).status === 'not_found', 'not_found');
  });

  // ── resolveMachineIdentifier — serial / full name ─────────────
  console.log('\n[specLookup] resolveMachineIdentifier — serial / full name');

  await test('resolves by serial (case-insensitive)', () => {
    const r = resolveMachineIdentifier('sn12345', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.machineId === 'machine-001', 'id');
  });
  await test('resolves support equipment by serial', () => {
    const r = resolveMachineIdentifier('12-1350-22', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.machineType === 'support', 'support');
  });
  await test('resolves by full name (case-insensitive)', () => {
    assert(resolveMachineIdentifier('nordco cx spiker #1', FULL_ROSTER).status === 'found', 'found');
  });
  await test('resolves support equipment by full name', () => {
    const r = resolveMachineIdentifier('Knox Kershaw 12-12 Tie Crane', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.position === null, 'null position');
  });

  // ── resolveMachineIdentifier — common name ────────────────────
  console.log('\n[specLookup] resolveMachineIdentifier — common name');

  await test('resolves by exact common name', () => {
    const r = resolveMachineIdentifier('spiker 1', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.machineId === 'machine-001', 'id');
  });
  await test('"spiker 2" resolves unambiguously', () => {
    const r = resolveMachineIdentifier('spiker 2', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.machineId === 'machine-002', 'id');
  });
  await test('"spiker" alone → ambiguous', () => {
    const r = resolveMachineIdentifier('spiker', FULL_ROSTER);
    assert(r.status === 'ambiguous', 'ambiguous');
    if (r.status === 'ambiguous') {
      assert(r.candidates.length === 2, 'two candidates');
      const ids = r.candidates.map(c => c.machineId);
      assert(ids.includes('machine-001') && ids.includes('machine-002'), 'both spikers');
    }
  });
  await test('"tie crane" → unambiguous', () => {
    const r = resolveMachineIdentifier('tie crane', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.machineType === 'support', 'support');
  });
  await test('unknown query → not_found', () => {
    assert(resolveMachineIdentifier('something unknown xyz', FULL_ROSTER).status === 'not_found', 'not_found');
  });
  await test('empty roster → not_found', () => {
    assert(resolveMachineIdentifier('spiker 1', []).status === 'not_found', 'not_found');
  });
  await test('case-insensitive: "SPIKER 1"', () => {
    const r = resolveMachineIdentifier('SPIKER 1', FULL_ROSTER);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') assert(r.machine.machineId === 'machine-001', 'id');
  });

  // ── buildSpecLookupResult ─────────────────────────────────────
  console.log('\n[specLookup] buildSpecLookupResult');

  await test('no key filter → all entries, unknownKeys empty', () => {
    const r = buildSpecLookupResult(SPIKER_1,
      [makeSpecRow(), makeSpecRow({ spec_key: 'hydraulic_fluid_type' })]);
    assert(r.status === 'found', 'status found');
    assert(r.entries.length === 2 && r.unknownKeys.length === 0, 'entries/unknownKeys');
  });
  await test('key filter — match returned', () => {
    const r = buildSpecLookupResult(SPIKER_1,
      [makeSpecRow({ spec_key: 'engine_oil_capacity_qt' })],
      ['engine_oil_capacity_qt']);
    assert(r.status === 'found' && r.entries.length === 1 && r.unknownKeys.length === 0, 'match');
  });
  await test('key filter — absent key in unknownKeys', () => {
    const r = buildSpecLookupResult(SPIKER_1,
      [makeSpecRow({ spec_key: 'engine_oil_capacity_qt' })],
      ['engine_oil_capacity_qt', 'missing_key']);
    assert(r.status === 'found', 'status found');
    assert(r.unknownKeys.includes('missing_key') && r.entries.length === 1, 'unknownKey present');
  });
  await test('isGap=true entry surfaced — not hidden', () => {
    const r = buildSpecLookupResult(SPIKER_1, [makeSpecRow({ spec_value: null, is_gap: 1 })]);
    assert(r.status === 'found', 'status found');
    assert(r.entries[0]!.isGap === true && r.entries[0]!.value === null, 'gap surfaced');
  });
  await test('key filter is case-insensitive', () => {
    const r = buildSpecLookupResult(SPIKER_1,
      [makeSpecRow({ spec_key: 'Engine_Oil_Capacity_Qt' })],
      ['engine_oil_capacity_qt']);
    assert(r.status === 'found' && r.entries.length === 1 && r.unknownKeys.length === 0, 'case-insensitive');
  });
  await test('all keys absent → all unknownKeys, entries empty', () => {
    const r = buildSpecLookupResult(SPIKER_1, [], ['key_a', 'key_b']);
    assert(r.status === 'found' && r.entries.length === 0 && r.unknownKeys.length === 2, 'all unknown');
  });

  // ── specLookup — integration ──────────────────────────────────
  console.log('\n[specLookup] specLookup — integration');

  await test('happy path: status found with entries', async () => {
    const db = makeStub([makeRawRosterRow()],
      [makeSpecRow(), makeSpecRow({ spec_key: 'hydraulic_fluid_type', spec_value: 'ISO 46' })]);
    const r = await specLookup({ identifier: 'Spiker 1', sessionId: 's1', requestId: 'r1' }, db);
    assert(r.status === 'found', 'status found');
    if (r.status === 'found') {
      assert(r.machine.fullName === 'Nordco CX Spiker #1', 'name');
      assert(r.entries.length === 2 && r.unknownKeys.length === 0, 'entries');
    }
  });

  await test('identifier matches nothing → status not_found / unknown_machine', async () => {
    const r = await specLookup(
      { identifier: 'nonexistent', sessionId: 's1', requestId: 'r1' },
      makeStub([makeRawRosterRow()], [])
    );
    assert(r.status === 'not_found', 'not_found');
    if (r.status === 'not_found') assert(r.reason === 'unknown_machine', 'reason');
  });

  await test('ambiguous → status not_found / ambiguous with candidates', async () => {
    const db = makeStub([
      makeRawRosterRow(),
      makeRawRosterRow({ machine_id: 'machine-002', position: 2,
        full_name: 'Nordco CX Spiker #2', serial_number: 'SN67890',
        common_names: '["Spiker 2","CX Spiker 2"]' }),
    ], []);
    const r = await specLookup({ identifier: 'spiker', sessionId: 's1', requestId: 'r1' }, db);
    assert(r.status === 'not_found', 'not_found');
    if (r.status === 'not_found') {
      assert(r.reason === 'ambiguous', 'ambiguous');
      if (r.reason === 'ambiguous') assert(r.candidates.length === 2, 'two candidates');
    }
  });

  await test('keys filter: absent key in unknownKeys', async () => {
    const r = await specLookup(
      { identifier: '1', keys: ['engine_oil_capacity_qt', 'missing_key'],
        sessionId: 's1', requestId: 'r1' },
      makeStub([makeRawRosterRow()], [makeSpecRow({ spec_key: 'engine_oil_capacity_qt' })])
    );
    assert(r.status === 'found', 'found');
    if (r.status === 'found') {
      assert(r.unknownKeys.includes('missing_key') && r.entries.length === 1, 'unknownKey');
    }
  });

  await test('support equipment resolves correctly', async () => {
    const db = makeStub(
      [makeRawRosterRow({ machine_id: 'machine-015', position: null,
        full_name: 'Knox Kershaw 12-12 Tie Crane', machine_type: 'support',
        serial_number: '12-1350-22', common_names: '["Tie Crane","12-12"]' })],
      [makeSpecRow({ spec_key: 'hydraulic_filter_pn', spec_value: null, is_gap: 1 })]
    );
    const r = await specLookup({ identifier: 'tie crane', sessionId: 's1', requestId: 'r1' }, db);
    assert(r.status === 'found', 'found');
    if (r.status === 'found') {
      assert(r.machine.position === null && r.machine.machineType === 'support', 'support');
      assert(r.entries[0]!.isGap === true, 'gap surfaced');
    }
  });

  await test('roster DB error → status error / db_error', async () => {
    const db: SpecLookupDbClient = { all: async () => { throw new Error('SQLite unavailable'); } };
    const r = await specLookup({ identifier: '1', sessionId: 's1', requestId: 'r1' }, db);
    assert(r.status === 'error', 'status error');
    if (r.status === 'error') {
      assert(r.cause === 'db_error', 'cause db_error');
      assert(r.message.includes('s1'), 'sessionId in message');
    }
  });

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n[specLookup] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err); process.exit(1); });
