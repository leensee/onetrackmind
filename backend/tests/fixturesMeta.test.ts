// ============================================================
// OTM — Fixtures Corpus Meta-Test (Schema v1.1)
// CJS module. Run via: npm run test:fixtures
// Self-verifies backend/tests/fixtures/: manifest↔filesystem sync,
// row/domain pairing, hydration-rule conformance, enum + negative
// constraint coverage, PII guard, invisible-character (Trojan
// Source) guard, referential integrity, expiry arithmetic, and the
// schema-version tag.
// Governing doc: docs/handoffs/OTM_Phase4.1_Fixtures_ClaudeCode_Handoff.md
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import {
  CONSTRAINTS,
  Constraint,
  DEVICE_WRITABLE_COLUMNS,
  DeviceTable,
  SCHEMA_VERSION,
  TABLE_SHAPES,
  TableName,
  mirrorBase,
} from './fixtures/constraints';
import { FixtureEntry, MANIFEST } from './fixtures/manifest';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

type Row = Record<string, unknown>;

// ── fixture access ──────────────────────────────────────────────
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

// ── §3 hydration rules (independent generic implementation) ────
function camel(k: string): string {
  return k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
function hydrate(table: TableName, row: Row): Row {
  const shape = TABLE_SHAPES[table];
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const key = camel(k);
    if (v === null) out[key] = null;
    else if (shape.jsonColumns.includes(k)) out[key] = JSON.parse(v as string);
    else if (shape.boolColumns.includes(k)) out[key] = v === 1;
    else out[key] = v;
  }
  return out;
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

// ── static constraint-violation checker ─────────────────────────
// Returns true (violates), false (satisfies), or null (not statically
// checkable per-row, e.g. the dedup window).
function checkViolation(c: Constraint, row: Row, entry: FixtureEntry, validRowsByTable: Map<TableName, { entry: FixtureEntry; row: Row }[]>): boolean | null {
  const col0 = c.columns[0] ?? '';
  const v = row[col0];
  switch (c.kind) {
    case 'not-null':
      return v === null || v === undefined;
    case 'check-enum':
      return v !== null && v !== undefined && !(c.values ?? []).includes(v as string | number);
    case 'check-bool01':
      return v !== null && v !== undefined && v !== 0 && v !== 1;
    case 'check-range': {
      if (v === null || v === undefined) return false;
      if (typeof v !== 'number') return true;
      const r = c.range ?? { min: -Infinity, max: Infinity };
      return v < r.min || v > r.max;
    }
    case 'fk': {
      if (v === null || v === undefined) return false;
      const refTable = c.references?.table;
      if (!refTable) return null;
      const ids = new Set(
        (validRowsByTable.get(refTable) ?? []).map((x) => x.row['id']),
      );
      return !ids.has(v);
    }
    case 'unique': {
      // Compare against the VALID corpus of the same physical table.
      const partialOk = (r: Row): boolean => {
        if (c.id === 'CL-UQ-PROVIDER-MSG-ID') return r['provider_message_id'] !== null;
        if (c.id === 'IK-UQ-PROVIDER-KEY') return r['key_type'] === 'provider_id';
        return true;
      };
      if (!partialOk(row)) return false;
      const peers = (validRowsByTable.get(entry.table) ?? []).filter(
        (x) => x.entry.id !== entry.id && partialOk(x.row),
      );
      return peers.some((x) => c.columns.every((col) => deepEqual(x.row[col], row[col])));
    }
    case 'ownership': {
      const allowed = DEVICE_WRITABLE_COLUMNS[entry.table as DeviceTable] ?? [];
      return Object.keys(row).some((k) => k !== 'id' && !allowed.includes(k));
    }
    case 'check-table':
      switch (c.id) {
        case 'CL-CHK-DIRECTION-DELIVERY': {
          const dir = row['direction'];
          const ds = row['delivery_state'];
          if (dir !== 'inbound' && dir !== 'outbound') return null; // direction itself broken; not this check's story
          return dir === 'inbound' ? ds !== null && ds !== undefined : ds === null || ds === undefined;
        }
        case 'CL-CHK-PROVENANCE-PROVIDER-MSG-ID':
          return (
            row['idempotency_provenance'] !== 'content_hash_fallback' &&
            (row['provider_message_id'] === null || row['provider_message_id'] === undefined)
          );
        case 'CT-DAL-IDENTIFIERS-JSON': {
          const raw = row['identifiers'];
          if (typeof raw !== 'string') return raw !== null && raw !== undefined;
          try {
            JSON.parse(raw);
            return false;
          } catch {
            return true;
          }
        }
        case 'CT-DAL-IDENTIFIERS-SHAPE': {
          const raw = row['identifiers'];
          if (typeof raw !== 'string') return false;
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return false; // malformed JSON is the JSON constraint's story
          }
          if (!Array.isArray(parsed)) return true;
          return !parsed.every(
            (it) =>
              it !== null &&
              typeof it === 'object' &&
              typeof (it as Row)['channel'] === 'string' &&
              typeof (it as Row)['value'] === 'string',
          );
        }
        case 'IK-DAL-EXPIRY-ARITHMETIC': {
          const first = Date.parse(String(row['first_seen_at']));
          const expires = Date.parse(String(row['expires_at']));
          if (Number.isNaN(first) || Number.isNaN(expires)) return true;
          const delta =
            row['key_type'] === 'provider_id' ? 90 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
          return expires !== first + delta;
        }
        default:
          return null;
      }
    case 'dedup-window':
      return null;
  }
}

// ── PII guard ───────────────────────────────────────────────────
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const PHONE_OK = /^(\+1)?555[\s.\-]?01\d{2}( ?x\d{1,4})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const RFC5322_RE = /^<[A-Za-z0-9._+\-]+@example\.com>$/i;
const SYNTH_EMAIL_RE = /^[A-Za-z0-9._+\-]+@example\.com$/i;
const OPAQUE_RE = /^[A-Za-z0-9._:\-]{1,64}$/;

function piiScanString(label: string, s: string, problems: string[]): void {
  if (UUID_RE.test(s) || ISO_RE.test(s) || HEX64_RE.test(s)) return;
  for (const m of s.match(EMAIL_RE) ?? []) {
    if (!/@example\.com$/i.test(m)) problems.push(`${label}: non-synthetic email "${m}"`);
  }
  for (const m of s.match(/\d{7,}/g) ?? []) {
    if (!/^1?55501\d{2}$/.test(m)) problems.push(`${label}: non-synthetic digit run "${m}"`);
  }
}
function piiScanValue(label: string, v: unknown, problems: string[]): void {
  if (typeof v === 'string') piiScanString(label, v, problems);
  else if (Array.isArray(v)) v.forEach((x, i) => piiScanValue(`${label}[${i}]`, x, problems));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Row)) piiScanValue(`${label}.${k}`, x, problems);
  }
}
/** Identifier-field allowlist: synthetic email, synthetic phone, rfc5322 angle form, pipe-joined phones, or short opaque token. */
function identifierAllowed(value: string): boolean {
  const t = value.trim();
  if (SYNTH_EMAIL_RE.test(t) || PHONE_OK.test(t) || RFC5322_RE.test(t)) return true;
  if (t.includes('|')) return t.split('|').every((p) => PHONE_OK.test(p.trim()));
  return OPAQUE_RE.test(t) && !/\d{7,}/.test(t.replace(/55501\d{2}/g, ''));
}
function identifierValuesOf(table: TableName, row: Row): string[] {
  const out: string[] = [];
  const base = mirrorBase(table);
  for (const col of TABLE_SHAPES[base].identifierColumns) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') continue;
    if (TABLE_SHAPES[base].jsonColumns.includes(col)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        continue; // malformed-JSON negative fixture; generic scan still applies
      }
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') out.push(item);
          else if (item !== null && typeof item === 'object' && typeof (item as Row)['value'] === 'string') {
            out.push((item as Row)['value'] as string);
          }
        }
      }
    } else {
      out.push(v);
    }
  }
  return out;
}

// ── walk fixtures dir ───────────────────────────────────────────
function walkFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) out.push(...walkFiles(abs, r));
    else out.push(r);
  }
  return out;
}
const walkJson = (dir: string): string[] => walkFiles(dir).filter((f) => f.endsWith('.json'));

function fail(problems: string[], label: string): void {
  if (problems.length > 0) {
    const shown = problems.slice(0, 15);
    const more = problems.length > shown.length ? `\n      …and ${problems.length - shown.length} more` : '';
    throw new Error(`${label} (${problems.length}):\n      ${shown.join('\n      ')}${more}`);
  }
}

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

  console.log('\nfixturesMeta Tests\n');

  const valids = MANIFEST.filter((e) => e.kind === 'valid');
  const invalids = MANIFEST.filter((e) => e.kind === 'invalid');
  const validRowsByTable = new Map<TableName, { entry: FixtureEntry; row: Row }[]>();
  for (const e of valids) {
    const list = validRowsByTable.get(e.table) ?? [];
    list.push({ entry: e, row: getRow(e) });
    validRowsByTable.set(e.table, list);
  }
  const constraintById = new Map(CONSTRAINTS.map((c) => [c.id, c]));

  // ── 1. Manifest ↔ filesystem sync ─────────────────────────────
  test('manifest ↔ filesystem sync — every file claimed exactly once, every claim exists', () => {
    const problems: string[] = [];
    const claimed = new Map<string, string>(); // file → entry id
    const seenIds = new Set<string>();
    for (const e of MANIFEST) {
      if (seenIds.has(e.id)) problems.push(`duplicate manifest id ${e.id}`);
      seenIds.add(e.id);
      if (!e.files) continue;
      for (const f of [e.files.row, e.files.domain]) {
        if (!f) continue;
        const prev = claimed.get(f);
        if (prev) problems.push(`${f} claimed by both ${prev} and ${e.id}`);
        claimed.set(f, e.id);
        if (!fs.existsSync(path.join(FIXTURES_DIR, f))) problems.push(`${e.id}: missing file ${f}`);
      }
    }
    for (const f of walkJson(FIXTURES_DIR)) {
      if (!claimed.has(f)) problems.push(`orphan file not in manifest: ${f}`);
    }
    fail(problems, 'manifest/filesystem drift');
  });

  // ── 2. Pairing ────────────────────────────────────────────────
  test('pairing — valid fixtures have row+domain; invalid fixtures are row-only', () => {
    const problems: string[] = [];
    for (const e of MANIFEST) {
      if (e.kind === 'valid') {
        const hasPair = e.inline
          ? e.inline.domain !== undefined
          : e.files !== undefined && e.files.domain !== undefined;
        if (!hasPair) problems.push(`${e.id}: valid fixture missing domain pair`);
        if (e.files && !/\.row\.json$/.test(e.files.row)) problems.push(`${e.id}: row file not *.row.json`);
        if (e.files?.domain && !/\.domain\.json$/.test(e.files.domain)) problems.push(`${e.id}: domain file not *.domain.json`);
      } else {
        if (e.inline) problems.push(`${e.id}: invalid fixtures must be file-backed rows`);
        if (!e.files || e.files.domain) problems.push(`${e.id}: invalid fixture must have exactly a row file`);
        if (e.files && !e.files.row.includes('/invalid/')) problems.push(`${e.id}: invalid fixture outside invalid/`);
      }
    }
    fail(problems, 'pairing violations');
  });

  // ── 3. Hydration conformance ─────────────────────────────────
  test('hydration — §3 rules applied to every valid row reproduce its domain exactly', () => {
    const problems: string[] = [];
    for (const e of valids) {
      const row = getRow(e);
      const domain = getDomain(e);
      if (!domain) continue; // pairing test reports this
      const derived = hydrate(e.table, row);
      if (!deepEqual(derived, domain)) {
        const keys = new Set([...Object.keys(derived), ...Object.keys(domain)]);
        const diffs = [...keys].filter((k) => !deepEqual(derived[k], domain[k]));
        problems.push(`${e.id}: domain drift at [${diffs.join(', ')}]`);
      }
    }
    fail(problems, 'hydration drift');
  });

  // ── 4. Enum coverage ─────────────────────────────────────────
  test('enum coverage — every enum/bool01 value appears in ≥1 valid fixture (claims verified + content scanned)', () => {
    const problems: string[] = [];
    // (a) every manifest claim is truthful
    for (const e of valids) {
      for (const cov of e.coversEnumValues ?? []) {
        const c = constraintById.get(cov.constraintId);
        if (!c) {
          problems.push(`${e.id}: claims unknown constraint ${cov.constraintId}`);
          continue;
        }
        const col = c.columns[0] ?? '';
        if (getRow(e)[col] !== cov.value) {
          problems.push(`${e.id}: claims ${cov.constraintId}=${String(cov.value)} but row has ${String(getRow(e)[col])}`);
        }
      }
    }
    // (b) claimed union and (c) scanned union both cover every value
    for (const c of CONSTRAINTS) {
      if (c.kind !== 'check-enum' && c.kind !== 'check-bool01') continue;
      const col = c.columns[0] ?? '';
      const claimed = new Set(
        valids.flatMap((e) => (e.coversEnumValues ?? []).filter((x) => x.constraintId === c.id).map((x) => x.value)),
      );
      const scanned = new Set(
        (validRowsByTable.get(c.table) ?? []).map((x) => x.row[col]).filter((v) => v !== null && v !== undefined),
      );
      for (const v of c.values ?? []) {
        if (!claimed.has(v)) problems.push(`${c.id}: value ${String(v)} not claimed via coversEnumValues`);
        if (!scanned.has(v)) problems.push(`${c.id}: value ${String(v)} absent from valid fixture content`);
      }
    }
    fail(problems, 'enum coverage gaps');
  });

  // ── 5. Negative coverage ─────────────────────────────────────
  test('negative coverage — every db constraint + ownership rule targeted; rows actually violate', () => {
    const problems: string[] = [];
    const targeted = new Set<string>();
    for (const e of invalids) {
      if (!e.rejects) {
        problems.push(`${e.id}: rejects not populated`);
        continue;
      }
      targeted.add(e.rejects);
      const c = constraintById.get(e.rejects);
      if (!c) {
        problems.push(`${e.id}: rejects unknown constraint ${e.rejects}`);
        continue;
      }
      if (!e.expectedError) problems.push(`${e.id}: expectedError not populated`);
      const violates = checkViolation(c, getRow(e), e, validRowsByTable);
      if (violates === false) problems.push(`${e.id}: row does NOT violate ${e.rejects}`);
    }
    for (const c of CONSTRAINTS) {
      const required = c.enforcedBy === 'db' || c.kind === 'ownership';
      if (required && !targeted.has(c.id)) problems.push(`constraint ${c.id} has no invalid fixture targeting it`);
    }
    fail(problems, 'negative coverage gaps');
  });

  // ── 6. Valid corpus quality (blanket static check) ───────────
  test('valid fixtures — satisfy every statically-checkable constraint of their (mirror) table', () => {
    const problems: string[] = [];
    for (const e of valids) {
      const base = mirrorBase(e.table);
      for (const c of CONSTRAINTS) {
        if (c.table !== base && c.table !== e.table) continue;
        if (c.kind === 'ownership' || c.kind === 'dedup-window') continue;
        const violates = checkViolation(c, getRow(e), e, validRowsByTable);
        if (violates === true) problems.push(`${e.id}: violates ${c.id}`);
      }
    }
    fail(problems, 'valid-fixture constraint violations');
  });

  // ── 7. PII guard ─────────────────────────────────────────────
  test('PII guard — synthetic identifiers only (@example.com emails, 555-01xx phones)', () => {
    const problems: string[] = [];
    for (const e of MANIFEST) {
      const row = getRow(e);
      piiScanValue(`${e.id}:row`, row, problems);
      const domain = getDomain(e);
      if (domain) piiScanValue(`${e.id}:domain`, domain, problems);
      for (const idv of identifierValuesOf(e.table, row)) {
        if (!identifierAllowed(idv)) problems.push(`${e.id}: identifier outside synthetic allowlist: "${idv}"`);
      }
    }
    fail(problems, 'PII guard violations');
  });

  // ── 8. Invisible-character guard (Trojan Source) ─────────────
  // Bidi controls, zero-width chars, BOM, and C0 controls (other
  // than \t \n \r) must appear in fixture sources only as explicit
  // \u escapes — raw occurrences are invisible in editors and diffs.
  test('invisible-char guard — no raw bidi/zero-width/control characters in fixture sources', () => {
    const problems: string[] = [];
    const RAW_INVISIBLE =
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
    for (const rel of walkFiles(FIXTURES_DIR)) {
      const text = fs.readFileSync(path.join(FIXTURES_DIR, rel), 'utf8');
      for (const m of text.match(RAW_INVISIBLE) ?? []) {
        const cp = (m.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
        problems.push(`${rel}: raw U+${cp} — represent it as an explicit \\u escape`);
      }
    }
    fail(problems, 'raw invisible characters');
  });

  // ── 9. Cross-fixture referential integrity ───────────────────
  test('referential integrity — FK-bearing valid fixtures point at ids that exist in the corpus', () => {
    const problems: string[] = [];
    for (const e of valids) {
      const base = mirrorBase(e.table);
      for (const c of CONSTRAINTS) {
        if (c.kind !== 'fk' || c.table !== base) continue;
        if (checkViolation(c, getRow(e), e, validRowsByTable) === true) {
          problems.push(`${e.id}: ${c.columns[0] ?? ''} dangles (no ${c.references?.table ?? '?'} fixture with that id)`);
        }
      }
    }
    // variantOf links must resolve within the manifest
    const ids = new Set(MANIFEST.map((e) => e.id));
    for (const e of MANIFEST) {
      if (e.variantOf && !ids.has(e.variantOf)) problems.push(`${e.id}: variantOf ${e.variantOf} not in manifest`);
    }
    fail(problems, 'referential integrity violations');
  });

  // ── 10. Schema version tag ───────────────────────────────────
  test("schema version — corpus is tagged SCHEMA_VERSION '1.1'", () => {
    assert(SCHEMA_VERSION === '1.1', `SCHEMA_VERSION is ${SCHEMA_VERSION}; migration work must bump consciously`);
  });

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
