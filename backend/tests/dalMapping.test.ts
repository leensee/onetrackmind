// ============================================================
// OTM — DAL Mapping Round-Trip Test (Schema v1.1)
// CJS module. Run via: npm run test:dal-mapping
// Proves round-trip fidelity of the src/db/mapping layer against
// the ENTIRE fixtures corpus (manifest-driven — no hardcoded
// fixture paths): fromDb(row) deep-equals the paired domain
// fixture, toDb(domain) deep-equals the row byte-for-byte, and
// toDb(fromDb(row)) is the identity. Valid device-mirror fixtures
// dispatch through mirrorBase() to the backend mappers (identical
// declared shape; Drift mappers stay deferred to Phase 4.6).
// Also exercises the serializer primitives and the two
// contacts.identifiers DAL rejections (pinned expectedError).
// Governing doc: docs/handoffs/OTM_Phase4.1_Fixtures_ClaudeCode_Handoff.md §3
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { BackendTable, mirrorBase } from './fixtures/constraints';
import { FixtureEntry, MANIFEST } from './fixtures/manifest';
import {
  MapResult,
  boolFromDb,
  boolToDb,
  jsonFromDb,
  jsonObjectFromDb,
  jsonToDb,
  stringArrayFromDb,
  timestampFromDb,
  timestampToDb,
} from '../src/db/mapping/serializers';
import { CommsLogDomain, CommsLogRow, commsLogFromDb, commsLogToDb } from '../src/db/mapping/commsLog';
import { ContactDomain, ContactRow, contactsFromDb, contactsToDb } from '../src/db/mapping/contacts';
import {
  IdempotencyKeyDomain,
  IdempotencyKeyRow,
  idempotencyKeysFromDb,
  idempotencyKeysToDb,
} from '../src/db/mapping/idempotencyKeys';
import {
  ThreadMappingDomain,
  ThreadMappingRow,
  threadMappingsFromDb,
  threadMappingsToDb,
} from '../src/db/mapping/threadMappings';
import {
  PollingStateDomain,
  PollingStateRow,
  pollingStateFromDb,
  pollingStateToDb,
} from '../src/db/mapping/pollingState';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

type Row = Record<string, unknown>;

// ── fixture access (same helpers as fixturesMeta.test.ts) ───────
function readJson(rel: string): Row {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, rel), 'utf8')) as Row;
}
function getRow(e: FixtureEntry): Row {
  if (e.inline) return e.inline.row;
  if (e.files) return readJson(e.files.row);
  throw new Error(`fixture ${e.id} has neither files nor inline content`);
}
function getDomain(e: FixtureEntry): Row | null {
  if (e.inline) return e.inline.domain ?? null;
  if (e.files && e.files.domain) return readJson(e.files.domain);
  return null;
}
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as Row).sort();
    const kb = Object.keys(b as Row).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((k) => deepEqual((a as Row)[k], (b as Row)[k]));
  }
  return false;
}

// ── per-table dispatch ───────────────────────────────────────────
// Fixture JSON arrives untyped; the casts below are the read-boundary
// contract (callers cast client.get<Row>() the same way).
interface TableMapper {
  fromDb(row: Row): MapResult<unknown>;
  toDb(domain: Row): unknown;
}
const MAPPERS: Record<BackendTable, TableMapper> = {
  comms_log: {
    fromDb: (row) => commsLogFromDb(row as unknown as CommsLogRow),
    toDb: (domain) => commsLogToDb(domain as unknown as CommsLogDomain),
  },
  contacts: {
    fromDb: (row) => contactsFromDb(row as unknown as ContactRow),
    toDb: (domain) => contactsToDb(domain as unknown as ContactDomain),
  },
  idempotency_keys: {
    fromDb: (row) => idempotencyKeysFromDb(row as unknown as IdempotencyKeyRow),
    toDb: (domain) => idempotencyKeysToDb(domain as unknown as IdempotencyKeyDomain),
  },
  thread_mappings: {
    fromDb: (row) => threadMappingsFromDb(row as unknown as ThreadMappingRow),
    toDb: (domain) => threadMappingsToDb(domain as unknown as ThreadMappingDomain),
  },
  polling_state: {
    fromDb: (row) => pollingStateFromDb(row as unknown as PollingStateRow),
    toDb: (domain) => pollingStateToDb(domain as unknown as PollingStateDomain),
  },
};

async function runTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void): void {
    try {
      fn();
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

  console.log('\ndalMapping Tests\n');

  const valids = MANIFEST.filter((e) => e.kind === 'valid');

  // ── 1. Serializer primitives ──────────────────────────────────
  test('serializers — bool 0/1 ↔ boolean inverse pairs', () => {
    assert(boolFromDb(1) === true, 'boolFromDb(1) must be true');
    assert(boolFromDb(0) === false, 'boolFromDb(0) must be false');
    assert(boolToDb(true) === 1, 'boolToDb(true) must be 1');
    assert(boolToDb(false) === 0, 'boolToDb(false) must be 0');
  });

  test('serializers — timestamps pass through as strings (identity)', () => {
    const ts = '2026-06-07T14:30:00Z';
    assert(timestampFromDb(ts) === ts, 'timestampFromDb must be identity');
    assert(timestampToDb(ts) === ts, 'timestampToDb must be identity');
  });

  test('serializers — jsonToDb emits canonical compact JSON', () => {
    assert(jsonToDb({ a: 1, b: ['x'] }) === '{"a":1,"b":["x"]}', 'no whitespace, insertion key order');
    assert(jsonToDb([]) === '[]', 'empty array');
    assert(jsonToDb({}) === '{}', 'empty object');
  });

  test('serializers — jsonFromDb: happy path + malformed_json', () => {
    const okRes = jsonFromDb('{"k":1}', 'col');
    assert(okRes.ok && deepEqual(okRes.value, { k: 1 }), 'valid JSON parses');
    const bad = jsonFromDb('{oops', 'my_col');
    assert(!bad.ok && bad.reason === 'malformed_json', 'malformed JSON → malformed_json');
    assert(!bad.ok && bad.detail.startsWith('my_col:'), 'detail names the column');
  });

  test('serializers — stringArrayFromDb: happy + malformed + wrong shapes', () => {
    const okRes = stringArrayFromDb('["a","b"]', 'col');
    assert(okRes.ok && deepEqual(okRes.value, ['a', 'b']), 'string array parses');
    const malformed = stringArrayFromDb('{oops', 'col');
    assert(!malformed.ok && malformed.reason === 'malformed_json', 'malformed → malformed_json');
    const notArray = stringArrayFromDb('{"a":1}', 'col');
    assert(!notArray.ok && notArray.reason === 'wrong_shape', 'object → wrong_shape');
    const wrongItems = stringArrayFromDb('[1]', 'col');
    assert(!wrongItems.ok && wrongItems.reason === 'wrong_shape', 'non-string item → wrong_shape');
  });

  test('serializers — jsonObjectFromDb: happy + malformed + wrong shapes', () => {
    const okRes = jsonObjectFromDb('{"k":1}', 'col');
    assert(okRes.ok && deepEqual(okRes.value, { k: 1 }), 'object parses');
    const malformed = jsonObjectFromDb('{oops', 'col');
    assert(!malformed.ok && malformed.reason === 'malformed_json', 'malformed → malformed_json');
    const arr = jsonObjectFromDb('[]', 'col');
    assert(!arr.ok && arr.reason === 'wrong_shape', 'array → wrong_shape');
    const nul = jsonObjectFromDb('null', 'col');
    assert(!nul.ok && nul.reason === 'wrong_shape', 'JSON null → wrong_shape');
  });

  // ── 2. fromDb hydration, corpus-wide ──────────────────────────
  test('fromDb — every valid fixture hydrates to its paired domain (deep-equal)', () => {
    const problems: string[] = [];
    let exercised = 0;
    for (const e of valids) {
      const mapper = MAPPERS[mirrorBase(e.table)];
      const domain = getDomain(e);
      if (domain === null) {
        problems.push(`${e.id}: valid fixture without a domain side`);
        continue;
      }
      const res = mapper.fromDb(getRow(e));
      if (!res.ok) {
        problems.push(`${e.id}: fromDb failed — ${res.reason}: ${res.detail}`);
        continue;
      }
      if (!deepEqual(res.value, domain)) {
        problems.push(`${e.id}: fromDb output does not deep-equal the domain fixture`);
        continue;
      }
      exercised++;
    }
    assert(problems.length === 0, `hydration mismatches:\n    ${problems.join('\n    ')}`);
    assert(exercised >= 87, `expected ≥ 87 valid fixtures exercised (81 file pairs + 6 inline), got ${exercised}`);
  });

  // ── 3. toDb, byte-for-byte ────────────────────────────────────
  // JSON-TEXT columns compare as strings here, so equality with the
  // row fixture is the byte-for-byte proof. That holds because every
  // JSON-TEXT value in the corpus is canonical compact JSON
  // (JSON.stringify form) — a CORPUS property, not a mapper
  // guarantee. If this test fails on a new fixture whose JSON is
  // pretty-printed or key-reordered, fix the fixture's canonicality,
  // not the mapper.
  test('toDb — every valid domain fixture serializes to its row byte-for-byte', () => {
    const problems: string[] = [];
    let exercised = 0;
    for (const e of valids) {
      const mapper = MAPPERS[mirrorBase(e.table)];
      const domain = getDomain(e);
      if (domain === null) continue; // pairing enforced by test 2 / meta-test
      const row = mapper.toDb(domain);
      if (!deepEqual(row, getRow(e))) {
        problems.push(`${e.id}: toDb output does not deep-equal the row fixture`);
        continue;
      }
      exercised++;
    }
    assert(problems.length === 0, `serialization mismatches:\n    ${problems.join('\n    ')}`);
    assert(exercised >= 87, `expected ≥ 87 valid fixtures exercised, got ${exercised}`);
  });

  // ── 4. Round-trip identity ────────────────────────────────────
  test('round-trip — toDb(fromDb(row)) is the identity, corpus-wide', () => {
    const problems: string[] = [];
    let exercised = 0;
    for (const e of valids) {
      const mapper = MAPPERS[mirrorBase(e.table)];
      const row = getRow(e);
      const res = mapper.fromDb(row);
      if (!res.ok) {
        problems.push(`${e.id}: fromDb failed — ${res.reason}: ${res.detail}`);
        continue;
      }
      if (!deepEqual(mapper.toDb(res.value as Row), row)) {
        problems.push(`${e.id}: toDb(fromDb(row)) is not the original row`);
        continue;
      }
      exercised++;
    }
    assert(problems.length === 0, `round-trip failures:\n    ${problems.join('\n    ')}`);
    assert(exercised >= 87, `expected ≥ 87 valid fixtures exercised, got ${exercised}`);
  });

  // ── 5. contacts.identifiers DAL rejections (pinned messages) ──
  test('fromDb — identifiers DAL rejections match the manifest expectedError exactly', () => {
    const expectations: Record<string, 'malformed_json' | 'wrong_shape'> = {
      'CT-DAL-IDENTIFIERS-JSON': 'malformed_json',
      'CT-DAL-IDENTIFIERS-SHAPE': 'wrong_shape',
    };
    const entries = MANIFEST.filter(
      (e) => e.kind === 'invalid' && e.rejects !== undefined && e.rejects in expectations,
    );
    assert(entries.length === 2, `expected the 2 identifiers DAL fixtures, found ${entries.length}`);
    for (const e of entries) {
      const res = contactsFromDb(getRow(e) as unknown as ContactRow);
      assert(!res.ok, `${e.id}: contactsFromDb must reject`);
      if (!res.ok) {
        const wantReason = expectations[e.rejects as string];
        assert(res.reason === wantReason, `${e.id}: reason ${res.reason}, expected ${wantReason}`);
        assert(
          res.detail === e.expectedError,
          `${e.id}: detail "${res.detail}" must equal manifest expectedError "${e.expectedError}"`,
        );
      }
    }
  });

  // ── Summary ──────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
