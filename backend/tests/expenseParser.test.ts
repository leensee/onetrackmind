// ============================================================
// OTM — Expense Parser Tests
// CJS module. Run via: npm run test:expense
// Pure function tests need no stubs.
// Image path tests use a minimal extractor stub.
// ============================================================

import {
  validateParseInput, parseVendor, parseDate, parseAmount,
  parsePurchaseMethod, parseLineItems, computeConfidence,
  buildExpenseRecord, parseExpense,
  ImageExtractorClient, DEFAULT_CURRENCY,
} from '../src/orchestration/tools/expenseParser';
import { ExpenseParseInput } from '../src/orchestration/types';

const SAMPLE_RECEIPT = `
NAPA Auto Parts
04/15/2026
Hydraulic fluid 1qt    8.99
Filter HF6553         12.50
Subtotal              21.49
Tax                    1.72
Total                 23.21
Card ending 4892
`.trim();

function makeTextInput(o: Partial<ExpenseParseInput> = {}): ExpenseParseInput {
  return { inputType: 'text', text: SAMPLE_RECEIPT,
    sessionId: 's1', requestId: 'r1', ...o };
}

async function runTests(): Promise<void> {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
  }
  function assert(c: boolean, m: string): void { if (!c) throw new Error(m); }

  // ── validateParseInput ─────────────────────────────────────
  console.log('\n[expenseParser] validateParseInput');

  await test('valid text input → null', () => {
    assert(validateParseInput(makeTextInput()) === null, 'null');
  });
  await test('text input with empty text → error', () => {
    const r = validateParseInput(makeTextInput({ text: '' }));
    assert(r !== null && r.includes('text'), 'error');
  });
  await test('invalid inputType → error', () => {
    const r = validateParseInput(makeTextInput({ inputType: 'voice' as never }));
    assert(r !== null && r.includes('inputType'), 'error');
  });
  await test('image input missing imageBytes → error', () => {
    const r = validateParseInput({
      inputType: 'image', imageMimeType: 'image/jpeg',
      sessionId: 's1', requestId: 'r1',
    });
    assert(r !== null && r.includes('imageBytes'), 'error');
  });
  await test('image input missing imageMimeType → error', () => {
    const r = validateParseInput({
      inputType: 'image', imageBytes: new Uint8Array([1, 2, 3]),
      sessionId: 's1', requestId: 'r1',
    });
    assert(r !== null && r.includes('imageMimeType'), 'error');
  });
  await test('valid image input → null', () => {
    const r = validateParseInput({
      inputType: 'image', imageBytes: new Uint8Array([1, 2, 3]),
      imageMimeType: 'image/jpeg', sessionId: 's1', requestId: 'r1',
    });
    assert(r === null, 'null');
  });

  // ── parseVendor ────────────────────────────────────────────
  console.log('\n[expenseParser] parseVendor');

  await test('extracts vendor from first line', () => {
    assert(parseVendor(SAMPLE_RECEIPT) === 'NAPA Auto Parts', 'NAPA');
  });
  await test('returns null when no identifiable vendor', () => {
    assert(parseVendor('04/15/2026\nTotal $23.21') === null, 'null');
  });
  await test('skips date-like first line', () => {
    const text = '04/15/2026\nACME Supply\nTotal $10.00';
    assert(parseVendor(text) === 'ACME Supply', 'skips date line');
  });

  // ── parseDate ──────────────────────────────────────────────
  console.log('\n[expenseParser] parseDate');

  await test('parses MM/DD/YYYY format', () => {
    const d = parseDate('Receipt Date: 04/15/2026');
    assert(d === '2026-04-15', `got ${d}`);
  });
  await test('parses YYYY-MM-DD format', () => {
    const d = parseDate('Date: 2026-04-15');
    assert(d === '2026-04-15', `got ${d}`);
  });
  await test('parses month name format', () => {
    const d = parseDate('April 15, 2026');
    assert(d !== null && d.startsWith('2026'), `got ${d}`);
  });
  await test('returns null when no date found', () => {
    assert(parseDate('NAPA Auto Parts\nHydraulic fluid $8.99') === null, 'null');
  });

  // ── parseAmount ────────────────────────────────────────────
  console.log('\n[expenseParser] parseAmount');

  await test('extracts total from labelled line', () => {
    assert(parseAmount(SAMPLE_RECEIPT) === 23.21, 'total 23.21');
  });
  await test('returns null when no amount found', () => {
    assert(parseAmount('NAPA Auto Parts\n04/15/2026') === null, 'null');
  });
  await test('ignores subtotal, picks total', () => {
    const text = 'Subtotal $20.00\nTax $1.50\nTotal $21.50';
    assert(parseAmount(text) === 21.50, '21.50');
  });

  // ── parsePurchaseMethod ────────────────────────────────────
  console.log('\n[expenseParser] parsePurchaseMethod');

  await test('detects card with last four', () => {
    const m = parsePurchaseMethod('Card ending 4892');
    assert(m.type === 'card', 'card');
    if (m.type === 'card') assert(m.lastFour === '4892', 'lastFour');
  });
  await test('detects account charge', () => {
    const m = parsePurchaseMethod('Charged to account ACCT-001');
    assert(m.type === 'account', 'account');
  });
  await test('detects cash', () => {
    assert(parsePurchaseMethod('Paid with cash').type === 'cash', 'cash');
  });
  await test('returns unknown when no method found', () => {
    assert(parsePurchaseMethod('NAPA Auto Parts').type === 'unknown', 'unknown');
  });

  // ── parseLineItems ─────────────────────────────────────────
  console.log('\n[expenseParser] parseLineItems');

  await test('extracts line items with prices', () => {
    const items = parseLineItems(SAMPLE_RECEIPT);
    assert(items.length >= 2, `expected >=2 items, got ${items.length}`);
    assert(items.some(i => i.description.includes('Hydraulic')), 'hydraulic fluid item');
  });
  await test('returns empty array when no line items', () => {
    assert(parseLineItems('NAPA\nTotal $23.21').length === 0, 'empty');
  });

  // ── computeConfidence ──────────────────────────────────────
  console.log('\n[expenseParser] computeConfidence');

  await test('all three present → high', () => {
    assert(computeConfidence('NAPA', '2026-04-15', 23.21) === 'high', 'high');
  });
  await test('two present → medium', () => {
    assert(computeConfidence('NAPA', null, 23.21) === 'medium', 'medium');
    assert(computeConfidence(null, '2026-04-15', 23.21) === 'medium', 'medium');
  });
  await test('one or none → low', () => {
    assert(computeConfidence('NAPA', null, null) === 'low', 'low');
    assert(computeConfidence(null, null, null) === 'low', 'low');
  });

  // ── buildExpenseRecord ─────────────────────────────────────
  console.log('\n[expenseParser] buildExpenseRecord');

  await test('full pipeline on sample receipt', () => {
    const r = buildExpenseRecord(SAMPLE_RECEIPT);
    assert(r.vendor === 'NAPA Auto Parts', 'vendor');
    assert(r.date === '2026-04-15', 'date');
    assert(r.amount === 23.21, 'amount');
    assert(r.currency === DEFAULT_CURRENCY, 'currency USD');
    assert(r.purchaseMethod?.type === 'card', 'card method');
    assert(r.lineItems.length >= 2, 'line items');
    assert(r.confidence === 'high', 'high confidence');
    assert(r.parseWarnings.length === 0, 'no warnings');
    assert(r.rawText === SAMPLE_RECEIPT, 'rawText preserved');
  });
  await test('missing fields produce warnings', () => {
    const r = buildExpenseRecord('Some random text with no structure');
    assert(r.parseWarnings.length > 0, 'has warnings');
    assert(r.confidence === 'low', 'low confidence');
  });
  await test('currency defaults to USD', () => {
    assert(buildExpenseRecord(SAMPLE_RECEIPT).currency === 'USD', 'USD');
  });

  // ── parseExpense — integration ─────────────────────────────
  console.log('\n[expenseParser] parseExpense — integration');

  await test('text path: ok:true with record', async () => {
    const r = await parseExpense(makeTextInput());
    assert(r.ok === true, 'ok');
    if (r.ok) assert(r.record.vendor === 'NAPA Auto Parts', 'vendor');
  });
  await test('invalid input → ok:false', async () => {
    const r = await parseExpense(makeTextInput({ text: '' }));
    assert(r.ok === false, 'ok false');
    if (!r.ok) assert(r.error.includes('text'), 'error message');
  });
  await test('image path: extractor called, record built', async () => {
    const extractor: ImageExtractorClient = {
      extractText: async () => SAMPLE_RECEIPT,
    };
    const r = await parseExpense({
      inputType: 'image', imageBytes: new Uint8Array([1, 2, 3]),
      imageMimeType: 'image/jpeg', sessionId: 's1', requestId: 'r1',
    }, extractor);
    assert(r.ok === true, 'ok');
    if (r.ok) assert(r.record.amount === 23.21, 'amount');
  });
  await test('image path: extractor throws → ok:false', async () => {
    const extractor: ImageExtractorClient = {
      extractText: async () => { throw new Error('API unavailable'); },
    };
    const r = await parseExpense({
      inputType: 'image', imageBytes: new Uint8Array([1, 2, 3]),
      imageMimeType: 'image/jpeg', sessionId: 's1', requestId: 'r1',
    }, extractor);
    assert(r.ok === false, 'ok false');
    if (!r.ok) assert(r.error.includes('extraction failed'), 'error message');
  });
  await test('image path: no extractor provided → ok:false', async () => {
    const r = await parseExpense({
      inputType: 'image', imageBytes: new Uint8Array([1, 2, 3]),
      imageMimeType: 'image/jpeg', sessionId: 's1', requestId: 'r1',
    });
    assert(r.ok === false, 'ok false');
    if (!r.ok) assert(r.error.includes('imageExtractor'), 'error message');
  });
  await test('extractor returns empty string → ok:false', async () => {
    const extractor: ImageExtractorClient = { extractText: async () => '' };
    const r = await parseExpense({
      inputType: 'image', imageBytes: new Uint8Array([1, 2, 3]),
      imageMimeType: 'image/jpeg', sessionId: 's1', requestId: 'r1',
    }, extractor);
    assert(r.ok === false && !r.ok && r.error.includes('empty'), 'empty error');
  });

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n[expenseParser] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err); process.exit(1); });
