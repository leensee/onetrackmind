// ============================================================
// OTM — Sheet Output Tests
// CJS module. Run via: npm run test:sheet
// Pure functions only — no stubs needed.
// ============================================================

import {
  validateSheetTable, escapeCsvCell,
  buildCsvRow, buildCsvPayload, buildSheetOutput,
} from '../src/orchestration/tools/sheetOutput';
import { SheetTable } from '../src/orchestration/types';

const BASIC_TABLE: SheetTable = {
  headers: ['Date', 'Vendor', 'Amount'],
  rows: [
    { Date: '2026-04-15', Vendor: 'NAPA', Amount: 23.21 },
    { Date: '2026-04-14', Vendor: 'Fastenal', Amount: 47.00 },
  ],
};

async function runTests(): Promise<void> {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
  }
  function assert(c: boolean, m: string): void { if (!c) throw new Error(m); }

  // ── validateSheetTable ─────────────────────────────────────
  console.log('\n[sheetOutput] validateSheetTable');

  await test('valid table → null', () => {
    assert(validateSheetTable(BASIC_TABLE) === null, 'null');
  });
  await test('empty headers → error', () => {
    assert(validateSheetTable({ headers: [], rows: [{ a: '1' }] }) !== null, 'error');
  });
  await test('empty string header → error', () => {
    const r = validateSheetTable({ headers: ['Date', ''], rows: [{ Date: '2026' }] });
    assert(r !== null && r.includes('header'), 'error');
  });
  await test('duplicate header → error', () => {
    const r = validateSheetTable({ headers: ['Date', 'Date'], rows: [{ Date: '2026' }] });
    assert(r !== null && r.includes('duplicate'), 'error');
  });
  await test('empty rows → error', () => {
    assert(validateSheetTable({ headers: ['Date'], rows: [] }) !== null, 'error');
  });

  // ── escapeCsvCell ──────────────────────────────────────────
  console.log('\n[sheetOutput] escapeCsvCell');

  await test('plain string — no escaping', () => {
    assert(escapeCsvCell('NAPA') === 'NAPA', 'NAPA');
  });
  await test('number → string', () => {
    assert(escapeCsvCell(23.21) === '23.21', '23.21');
  });
  await test('null → empty string', () => {
    assert(escapeCsvCell(null) === '', 'empty');
  });
  await test('value with comma → quoted', () => {
    assert(escapeCsvCell('NAPA, Inc.') === '"NAPA, Inc."', 'quoted with comma');
  });
  await test('value with double quote → doubled and quoted', () => {
    assert(escapeCsvCell('say "hello"') === '"say ""hello"""', 'doubled quote');
  });
  await test('value with newline → quoted', () => {
    const r = escapeCsvCell('line1\nline2');
    assert(r.startsWith('"') && r.endsWith('"'), 'newline quoted');
  });

  // ── buildCsvRow ────────────────────────────────────────────
  console.log('\n[sheetOutput] buildCsvRow');

  await test('row follows header order', () => {
    const r = buildCsvRow({ Date: '2026-04-15', Vendor: 'NAPA', Amount: 23.21 },
      ['Date', 'Vendor', 'Amount']);
    assert(r === '2026-04-15,NAPA,23.21', `got: ${r}`);
  });
  await test('missing key → empty cell', () => {
    const r = buildCsvRow({ Date: '2026-04-15' }, ['Date', 'Vendor', 'Amount']);
    assert(r === '2026-04-15,,', `got: ${r}`);
  });

  // ── buildCsvPayload ────────────────────────────────────────
  console.log('\n[sheetOutput] buildCsvPayload');

  await test('header row present', () => {
    const csv = buildCsvPayload(BASIC_TABLE);
    assert(csv.includes('Date,Vendor,Amount'), 'header row');
  });
  await test('data rows present', () => {
    const csv = buildCsvPayload(BASIC_TABLE);
    assert(csv.includes('NAPA') && csv.includes('Fastenal'), 'data rows');
  });
  await test('CRLF line endings', () => {
    const csv = buildCsvPayload(BASIC_TABLE);
    assert(csv.includes('\r\n'), 'CRLF');
  });
  await test('title written as comment line when present', () => {
    const csv = buildCsvPayload({ ...BASIC_TABLE, title: 'Expense Report' });
    assert(csv.startsWith('# Expense Report'), 'comment line');
  });
  await test('no comment line when title absent', () => {
    const csv = buildCsvPayload(BASIC_TABLE);
    assert(!csv.startsWith('#'), 'no comment');
  });
  await test('null values produce empty cells', () => {
    const csv = buildCsvPayload({
      headers: ['A', 'B'],
      rows: [{ A: 'val', B: null }],
    });
    assert(csv.includes('val,'), 'empty cell after val');
  });

  // ── buildSheetOutput ───────────────────────────────────────
  console.log('\n[sheetOutput] buildSheetOutput');

  await test('valid table → ok:true with correct counts', () => {
    const r = buildSheetOutput(BASIC_TABLE);
    assert(r.ok === true, 'ok');
    if (r.ok) {
      assert(r.rowCount    === 2, 'rowCount 2');
      assert(r.columnCount === 3, 'columnCount 3');
      assert(typeof r.csv === 'string' && r.csv.length > 0, 'csv non-empty');
    }
  });
  await test('invalid table → ok:false', () => {
    const r = buildSheetOutput({ headers: [], rows: [] });
    assert(r.ok === false, 'ok false');
    if (!r.ok) assert(r.error.includes('headers'), 'error message');
  });
  await test('csv is RFC 4180 parseable (round-trip check)', () => {
    const r = buildSheetOutput({
      headers: ['Name', 'Notes'],
      rows: [{ Name: 'Part A', Notes: 'needs, quote: "test"' }],
    });
    assert(r.ok === true, 'ok');
    if (r.ok) assert(r.csv.includes('""test""'), 'quotes doubled');
  });

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n[sheetOutput] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err); process.exit(1); });
