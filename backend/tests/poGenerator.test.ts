// ============================================================
// OTM — PO Generator Tests
// CJS module. Run via: npm run test:po
// Pure function tests need no stubs.
// DB tests use minimal { run } stub.
// ============================================================

import {
  validatePoInput, generatePoNumber, computeSubtotal,
  buildPurchaseOrder, buildPoDocument, buildPoGenerateResult,
  writePurchaseOrder, PoWriteError, PoWriteDbClient,
} from '../src/orchestration/tools/poGenerator';
import { PoGenerateInput, PoLineItem } from '../src/orchestration/types';

const ITEM_A: PoLineItem = { description: 'Filter HF6553', quantity: 2, unitPrice: 12.50, partNumber: 'HF6553' };
const ITEM_B: PoLineItem = { description: 'Hydraulic fluid 1qt', quantity: 1, unitPrice: 8.99 };

function makeInput(o: Partial<PoGenerateInput> = {}): PoGenerateInput {
  return {
    userId: 'user-001', sessionId: 's1', requestId: 'r1',
    sequenceNumber: 1, vendorName: 'NAPA Auto Parts',
    lineItems: [ITEM_A, ITEM_B],
    equipmentId: 'machine-001', equipmentPosition: 1,
    issuedDate: '2026-04-15', ...o,
  };
}

async function runTests(): Promise<void> {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
  }
  function assert(c: boolean, m: string): void { if (!c) throw new Error(m); }

  // ── validatePoInput ────────────────────────────────────────
  console.log('\n[poGenerator] validatePoInput');

  await test('valid input → null', () => {
    assert(validatePoInput(makeInput()) === null, 'null');
  });
  await test('empty vendorName → error', () => {
    const r = validatePoInput(makeInput({ vendorName: '' }));
    assert(r !== null && r.includes('vendorName'), 'error');
  });
  await test('empty lineItems → error', () => {
    const r = validatePoInput(makeInput({ lineItems: [] }));
    assert(r !== null && r.includes('lineItems'), 'error');
  });
  await test('line item empty description → error', () => {
    const r = validatePoInput(makeInput({ lineItems: [{ ...ITEM_A, description: '' }] }));
    assert(r !== null && r.includes('description'), 'error');
  });
  await test('line item zero quantity → error', () => {
    const r = validatePoInput(makeInput({ lineItems: [{ ...ITEM_A, quantity: 0 }] }));
    assert(r !== null && r.includes('quantity'), 'error');
  });
  await test('line item negative unitPrice → error', () => {
    const r = validatePoInput(makeInput({ lineItems: [{ ...ITEM_A, unitPrice: -1 }] }));
    assert(r !== null && r.includes('unitPrice'), 'error');
  });
  await test('zero sequenceNumber → error', () => {
    const r = validatePoInput(makeInput({ sequenceNumber: 0 }));
    assert(r !== null && r.includes('sequenceNumber'), 'error');
  });
  await test('invalid issuedDate → error', () => {
    const r = validatePoInput(makeInput({ issuedDate: 'not-a-date' }));
    assert(r !== null && r.includes('issuedDate'), 'error');
  });
  await test('absent issuedDate is valid', () => {
    const { issuedDate: _, ...rest } = makeInput();
    assert(validatePoInput(rest) === null, 'null');
  });

  // ── generatePoNumber ───────────────────────────────────────
  console.log('\n[poGenerator] generatePoNumber');

  await test('correct format PO-YYYYMMDD-NNNN', () => {
    assert(generatePoNumber('2026-04-15', 1) === 'PO-20260415-0001', 'format');
  });
  await test('sequence zero-padded to 4 digits', () => {
    assert(generatePoNumber('2026-04-15', 42) === 'PO-20260415-0042', 'padding');
  });
  await test('sequence 1000+ not truncated', () => {
    assert(generatePoNumber('2026-04-15', 1000) === 'PO-20260415-1000', 'no truncation');
  });

  // ── computeSubtotal ────────────────────────────────────────
  console.log('\n[poGenerator] computeSubtotal');

  await test('computes correct subtotal', () => {
    // ITEM_A: 2 * 12.50 = 25.00, ITEM_B: 1 * 8.99 = 8.99, total = 33.99
    assert(computeSubtotal([ITEM_A, ITEM_B]) === 33.99, '33.99');
  });
  await test('single item subtotal', () => {
    assert(computeSubtotal([ITEM_A]) === 25.00, '25.00');
  });
  await test('floating point precision handled', () => {
    const items: PoLineItem[] = [{ description: 'x', quantity: 3, unitPrice: 0.1 }];
    assert(computeSubtotal(items) === 0.30, '0.30 not 0.30000000000000004');
  });

  // ── buildPoGenerateResult ──────────────────────────────────
  console.log('\n[poGenerator] buildPoGenerateResult');

  await test('valid input → ok:true with order and document', () => {
    const r = buildPoGenerateResult(makeInput());
    assert(r.ok === true, 'ok');
    if (r.ok) {
      assert(r.order.poNumber === 'PO-20260415-0001', 'poNumber');
      assert(r.order.status   === 'draft',            'status draft');
      assert(r.order.subtotal === 33.99,              'subtotal');
      assert(r.document.subtotalFormatted === '$33.99', 'subtotalFormatted');
    }
  });
  await test('invalid input → ok:false', () => {
    const r = buildPoGenerateResult(makeInput({ vendorName: '' }));
    assert(r.ok === false, 'ok false');
    if (!r.ok) assert(r.error.includes('vendorName'), 'error message');
  });
  await test('issuedDate defaults to today when absent', () => {
    const { issuedDate: _, ...rest } = makeInput();
    const r = buildPoGenerateResult(rest);
    assert(r.ok === true, 'ok');
    if (r.ok) {
      const today = new Date().toISOString().split('T')[0]!;
      assert(r.order.issuedDate === today, 'defaults to today');
    }
  });
  await test('notes trimmed when present', () => {
    const r = buildPoGenerateResult(makeInput({ notes: '  rush order  ' }));
    assert(r.ok === true, 'ok');
    if (r.ok) assert(r.order.notes === 'rush order', 'notes trimmed');
  });
  await test('null equipment fields preserved', () => {
    const r = buildPoGenerateResult(makeInput({ equipmentId: null, equipmentPosition: null }));
    assert(r.ok === true, 'ok');
    if (r.ok) {
      assert(r.order.equipmentId === null,       'equipmentId null');
      assert(r.document.equipmentLabel === null, 'equipmentLabel null');
    }
  });
  await test('lineItemsFormatted includes part number when present', () => {
    const r = buildPoGenerateResult(makeInput());
    assert(r.ok === true, 'ok');
    if (r.ok) assert(r.document.lineItemsFormatted[0]!.includes('HF6553'), 'partNumber in format');
  });

  // ── writePurchaseOrder ─────────────────────────────────────
  console.log('\n[poGenerator] writePurchaseOrder');

  function makeOrder() {
    const r = buildPoGenerateResult(makeInput());
    if (!r.ok) throw new Error('fixture failed');
    return r.order;
  }

  await test('happy path → null, INSERT called', async () => {
    let sql = ''; let params: unknown[] = [];
    const db: PoWriteDbClient = { run: async (s, p) => { sql = s; params = p; } };
    const result = await writePurchaseOrder(makeOrder(), 'r1', db);
    assert(result === null, 'null');
    assert(sql.includes('orders_log'), 'INSERT into orders_log');
    assert((params as unknown[]).includes('NAPA Auto Parts'), 'vendor in params');
    assert((params as unknown[]).includes('draft'), 'status draft in params');
    assert((params as unknown[])[params.length - 1] === 0, 'is_synced is 0');
  });
  await test('write failure → PoWriteError(write_error)', async () => {
    const db: PoWriteDbClient = { run: async () => { throw new Error('disk full'); } };
    const result = await writePurchaseOrder(makeOrder(), 'r1', db);
    assert(result instanceof PoWriteError, 'PoWriteError');
    assert(result!.cause === 'write_error', 'write_error');
    assert(result!.sessionId === 's1', 'carries sessionId');
  });
  await test('line items serialized as JSON in params', async () => {
    let params: unknown[] = [];
    const db: PoWriteDbClient = { run: async (_, p) => { params = p; } };
    await writePurchaseOrder(makeOrder(), 'r1', db);
    const lineItemsParam = params.find(p => typeof p === 'string' && p.includes('HF6553'));
    assert(lineItemsParam !== undefined, 'line items JSON in params');
  });

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n[poGenerator] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err); process.exit(1); });
