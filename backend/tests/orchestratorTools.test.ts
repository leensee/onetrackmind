// ============================================================
// OTM — Orchestrator Tool Integration Tests
// CJS module. Run via: npm run test:orchestrator-tools
// Uses minimal stubs for DB, approval gate, and tool clients.
// ============================================================

import EventEmitter from 'events';
import {
  dispatchToolCall, resetPoSequence,
  ToolDeps, ToolWriteDbClient,
} from '../src/orchestration/orchestratorTools';
import { WsSend, InboundDecisionEvent } from '../src/orchestration/approvalGate';
import { ImageExtractorClient } from '../src/orchestration/tools/expenseParser';
import {
  TodoCreateInput, TodoUpdateInput, CommsDraftInput,
  PoGenerateInput, SpecLookupInput, ExpenseParseInput,
  SheetTable, DiagnosticLogInput,
} from '../src/orchestration/types';

// ── Stub Factories ────────────────────────────────────────────

function makeDb(opts: { failOn?: 'run' | 'get' | 'all'; exists?: boolean } = {}): ToolWriteDbClient {
  return {
    run: async () => { if (opts.failOn === 'run') throw new Error('DB error'); },
    get: async <T>(): Promise<T | undefined> => {
      if (opts.failOn === 'get') throw new Error('DB error');
      return opts.exists !== false ? ({ todo_id: 'todo-001' }) as unknown as T : undefined;
    },
    all: async <T>(sql: string): Promise<T[]> => {
      if (opts.failOn === 'all') throw new Error('DB error');
      // fleet_master stub for spec_lookup
      if (sql.includes('fleet_master')) return [{
        machine_id: 'machine-001', position: 1,
        full_name: 'Nordco CX Spiker #1', machine_type: 'consist',
        serial_number: 'SN12345', common_names: '["Spiker 1"]',
      }] as unknown as T[];
      // machine_specs stub
      if (sql.includes('machine_specs')) return [{
        spec_key: 'engine_oil_qt', spec_value: '6',
        unit: 'qt', source: 'OEM', confirmed_at: '2026-04-15', is_gap: 0,
      }] as unknown as T[];
      return [] as T[];
    },
  };
}

function makeApproveEmitter(requestId: string, decision: InboundDecisionEvent['decision'] = 'approve') {
  const emitter = new EventEmitter();
  setTimeout(() => emitter.emit('decision', {
    type: 'approval_response', requestId, decision,
  } satisfies InboundDecisionEvent), 5);
  return emitter;
}

function makeDeps(opts: {
  failDb?: 'run' | 'get' | 'all';
  dbExists?: boolean;
  decision?: InboundDecisionEvent['decision'];
  requestId?: string;
  extractor?: ImageExtractorClient;
} = {}): ToolDeps {
  const reqId = opts.requestId ?? 'r1';
  const dbOpts: { failOn?: 'run' | 'get' | 'all'; exists?: boolean } = {};
  if (opts.failDb  !== undefined) dbOpts.failOn = opts.failDb;
  if (opts.dbExists !== undefined) dbOpts.exists = opts.dbExists;
  const deps: ToolDeps = {
    db:        makeDb(dbOpts),
    wsSend:    (() => { /* no-op */ }) as WsSend,
    emitter:   makeApproveEmitter(reqId, opts.decision ?? 'approve'),
    timeoutMs: 500,
  };
  if (opts.extractor !== undefined) deps.extractor = opts.extractor;
  return deps;
}

// ── Input Fixtures ────────────────────────────────────────────

const TODO_CREATE: TodoCreateInput = {
  userId: 'u1', sessionId: 's1', requestId: 'r1',
  description: 'Check hydraulic fluid', category: 'equipment_specific',
  timeSensitivity: 'standard', equipmentId: 'machine-001', linkedContactId: null,
};
const TODO_UPDATE: TodoUpdateInput = {
  todoId: 'todo-001', status: 'done',
  userId: 'u1', sessionId: 's1', requestId: 'r1',
};
const COMMS_INPUT: CommsDraftInput = {
  channel: 'sms', recipients: ['+15550001111'],
  body: 'Shift complete.', toneLevel: 5, sessionId: 's1', requestId: 'r1',
};
const PO_INPUT: PoGenerateInput = {
  userId: 'u1', sessionId: 's1', requestId: 'r1',
  vendorName: 'NAPA', lineItems: [{ description: 'Filter', quantity: 1, unitPrice: 12.50 }],
  equipmentId: null, equipmentPosition: null, issuedDate: '2026-04-15',
};
const SPEC_INPUT: SpecLookupInput = { identifier: 'Spiker 1', sessionId: 's1', requestId: 'r1' };
const EXPENSE_INPUT: ExpenseParseInput = {
  inputType: 'text', text: 'NAPA\n04/15/2026\nTotal $23.21\nCard 4892',
  sessionId: 's1', requestId: 'r1',
};
const SHEET_INPUT: SheetTable = {
  headers: ['Date', 'Amount'],
  rows: [{ Date: '2026-04-15', Amount: 23.21 }],
};
const DIAGNOSTIC_INPUT: DiagnosticLogInput = {
  userId: 'u1', sessionId: 's1', requestId: 'r1',
  category: 'equipment_fault', severity: 'warning',
  machineId: 'machine-001', message: 'Hydraulic pressure low',
};

async function runTests(): Promise<void> {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
  }
  function assert(c: boolean, m: string): void { if (!c) throw new Error(m); }

  beforeEach: resetPoSequence();

  // ── todo_create ────────────────────────────────────────────
  console.log('\n[orchestratorTools] todo_create');

  await test('approve → status:approved', async () => {
    resetPoSequence();
    const r = await dispatchToolCall({ tool: 'todo_create', input: TODO_CREATE }, makeDeps());
    assert(r.status === 'approved' && r.tool === 'todo_create', `got ${r.status}`);
  });
  await test('reject → status:rejected', async () => {
    const r = await dispatchToolCall(
      { tool: 'todo_create', input: TODO_CREATE },
      makeDeps({ decision: 'reject' })
    );
    assert(r.status === 'rejected', `got ${r.status}`);
  });
  await test('invalid input → status:error', async () => {
    const r = await dispatchToolCall(
      { tool: 'todo_create', input: { ...TODO_CREATE, description: '' } },
      makeDeps()
    );
    assert(r.status === 'error', `got ${r.status}`);
  });
  await test('write failure → status:error', async () => {
    const r = await dispatchToolCall(
      { tool: 'todo_create', input: TODO_CREATE },
      makeDeps({ failDb: 'run' })
    );
    assert(r.status === 'error', `got ${r.status}`);
  });

  // ── todo_update ────────────────────────────────────────────
  console.log('\n[orchestratorTools] todo_update');

  await test('direct write → status:direct_write', async () => {
    const r = await dispatchToolCall({ tool: 'todo_update', input: TODO_UPDATE }, makeDeps());
    assert(r.status === 'direct_write' && r.tool === 'todo_update', `got ${r.status}`);
  });
  await test('not found → status:error', async () => {
    const r = await dispatchToolCall(
      { tool: 'todo_update', input: TODO_UPDATE },
      makeDeps({ dbExists: false })
    );
    assert(r.status === 'error', `got ${r.status}`);
  });

  // ── comms_draft ────────────────────────────────────────────
  console.log('\n[orchestratorTools] comms_draft');

  await test('approve → status:approved with draft', async () => {
    const r = await dispatchToolCall({ tool: 'comms_draft', input: COMMS_INPUT }, makeDeps());
    assert(r.status === 'approved', `got ${r.status}`);
    if (r.status === 'approved') assert((r.result as { channel: string }).channel === 'sms', 'sms draft');
  });
  await test('invalid input → status:error', async () => {
    const r = await dispatchToolCall(
      { tool: 'comms_draft', input: { ...COMMS_INPUT, body: '' } },
      makeDeps()
    );
    assert(r.status === 'error', `got ${r.status}`);
  });

  // ── po_generate ────────────────────────────────────────────
  console.log('\n[orchestratorTools] po_generate');

  await test('approve → status:approved with order + document', async () => {
    resetPoSequence();
    const r = await dispatchToolCall({ tool: 'po_generate', input: PO_INPUT }, makeDeps());
    assert(r.status === 'approved', `got ${r.status}`);
    if (r.status === 'approved') {
      const res = r.result as { order: { poNumber: string } };
      assert(res.order.poNumber.startsWith('PO-'), 'poNumber format');
    }
  });
  await test('reject → status:rejected', async () => {
    resetPoSequence();
    const r = await dispatchToolCall(
      { tool: 'po_generate', input: PO_INPUT },
      makeDeps({ decision: 'reject' })
    );
    assert(r.status === 'rejected', `got ${r.status}`);
  });

  // ── spec_lookup ────────────────────────────────────────────
  console.log('\n[orchestratorTools] spec_lookup');

  await test('found → status:read_result', async () => {
    const r = await dispatchToolCall({ tool: 'spec_lookup', input: SPEC_INPUT }, makeDeps());
    assert(r.status === 'read_result', `got ${r.status}`);
    if (r.status === 'read_result') {
      const res = r.result as { status: string };
      assert(res.status === 'found', 'found result');
    }
  });
  await test('DB error → status:error', async () => {
    const r = await dispatchToolCall(
      { tool: 'spec_lookup', input: SPEC_INPUT },
      makeDeps({ failDb: 'all' })
    );
    assert(r.status === 'error', `got ${r.status}`);
  });

  // ── expense_parse ──────────────────────────────────────────
  console.log('\n[orchestratorTools] expense_parse');

  await test('text path → status:read_result with record', async () => {
    const r = await dispatchToolCall({ tool: 'expense_parse', input: EXPENSE_INPUT }, makeDeps());
    assert(r.status === 'read_result', `got ${r.status}`);
  });
  await test('invalid input → status:error', async () => {
    const r = await dispatchToolCall(
      { tool: 'expense_parse', input: { ...EXPENSE_INPUT, text: '' } },
      makeDeps()
    );
    assert(r.status === 'error', `got ${r.status}`);
  });

  // ── sheet_output ───────────────────────────────────────────
  console.log('\n[orchestratorTools] sheet_output');

  await test('valid table → status:read_result with csv', async () => {
    const r = await dispatchToolCall({ tool: 'sheet_output', input: SHEET_INPUT }, makeDeps());
    assert(r.status === 'read_result', `got ${r.status}`);
    if (r.status === 'read_result') {
      const res = r.result as { csv: string };
      assert(res.csv.includes('Date'), 'csv contains header');
    }
  });

  // ── log_diagnostic ─────────────────────────────────────────
  console.log('\n[orchestratorTools] log_diagnostic');

  await test('write → status:direct_write', async () => {
    const r = await dispatchToolCall({ tool: 'log_diagnostic', input: DIAGNOSTIC_INPUT }, makeDeps());
    assert(r.status === 'direct_write' && r.tool === 'log_diagnostic', `got ${r.status}`);
  });
  await test('write failure → status:error', async () => {
    const r = await dispatchToolCall(
      { tool: 'log_diagnostic', input: DIAGNOSTIC_INPUT },
      makeDeps({ failDb: 'run' })
    );
    assert(r.status === 'error', `got ${r.status}`);
  });

  // ── Summary ───────────────────────────────────────────────
  console.log(`\n[orchestratorTools] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err); process.exit(1); });
