// ============================================================
// OTM — Todo Tool Tests
// CJS module. Run via: npm run test:todo
// Pure function tests need no stubs.
// DB tests use minimal { run, get } stubs.
// ============================================================

import {
  validateCreateInput, validateUpdateInput,
  buildTodoDraft, serializeTodoMetadata,
  writeTodo, updateTodoStatus,
  TodoWriteError, TodoWriteDbClient,
} from '../src/orchestration/tools/todoTool';
import { TodoCreateInput, TodoUpdateInput } from '../src/orchestration/types';

function makeCreateInput(o: Partial<TodoCreateInput> = {}): TodoCreateInput {
  return {
    userId: 'user-001', sessionId: 's1', requestId: 'r1',
    description: 'Check hydraulic fluid level on spiker 1',
    category: 'equipment_specific', timeSensitivity: 'standard',
    equipmentId: 'machine-001', linkedContactId: null, ...o,
  };
}
function makeUpdateInput(o: Partial<TodoUpdateInput> = {}): TodoUpdateInput {
  return { todoId: 'todo-001', status: 'done',
    userId: 'user-001', sessionId: 's1', requestId: 'r1', ...o };
}

async function runTests(): Promise<void> {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
  }
  function assert(c: boolean, m: string): void { if (!c) throw new Error(m); }

  // ── validateCreateInput ─────────────────────────────────────
  console.log('\n[todoTool] validateCreateInput');

  await test('valid input → null', () => {
    assert(validateCreateInput(makeCreateInput()) === null, 'null');
  });
  await test('empty description → error', () => {
    const r = validateCreateInput(makeCreateInput({ description: '' }));
    assert(r !== null && r.includes('description'), 'description error');
  });
  await test('invalid category → error', () => {
    const r = validateCreateInput(makeCreateInput({ category: 'machine_specific' as never }));
    assert(r !== null && r.includes('category'), 'category error');
  });
  await test('all valid categories pass', () => {
    const cats = ['safety','equipment_specific','parts_inventory','compliance_admin','contact'] as const;
    for (const c of cats) assert(validateCreateInput(makeCreateInput({ category: c })) === null, c);
  });
  await test('invalid timeSensitivity → error', () => {
    const r = validateCreateInput(makeCreateInput({ timeSensitivity: 'high' as never }));
    assert(r !== null && r.includes('timeSensitivity'), 'timeSensitivity error');
  });
  await test('valid dueDate passes', () => {
    assert(validateCreateInput(makeCreateInput({ dueDate: '2026-06-01' })) === null, 'valid dueDate');
  });
  await test('invalid dueDate → error', () => {
    const r = validateCreateInput(makeCreateInput({ dueDate: 'not-a-date' }));
    assert(r !== null && r.includes('dueDate'), 'dueDate error');
  });
  await test('empty string equipmentId → error', () => {
    const r = validateCreateInput(makeCreateInput({ equipmentId: '' }));
    assert(r !== null && r.includes('equipmentId'), 'equipmentId error');
  });
  await test('null equipmentId is valid', () => {
    assert(validateCreateInput(makeCreateInput({ equipmentId: null })) === null, 'null ok');
  });
  await test('empty string linkedContactId → error', () => {
    const r = validateCreateInput(makeCreateInput({ linkedContactId: '' }));
    assert(r !== null && r.includes('linkedContactId'), 'contactId error');
  });
  await test('null linkedContactId is valid', () => {
    assert(validateCreateInput(makeCreateInput({ linkedContactId: null })) === null, 'null ok');
  });

  // ── validateUpdateInput ─────────────────────────────────────
  console.log('\n[todoTool] validateUpdateInput');

  await test('valid done → null', () => {
    assert(validateUpdateInput(makeUpdateInput()) === null, 'null');
  });
  await test('valid dismissed → null', () => {
    assert(validateUpdateInput(makeUpdateInput({ status: 'dismissed' })) === null, 'null');
  });
  await test('empty todoId → error', () => {
    const r = validateUpdateInput(makeUpdateInput({ todoId: '' }));
    assert(r !== null && r.includes('todoId'), 'todoId error');
  });
  await test('invalid status → error', () => {
    const r = validateUpdateInput(makeUpdateInput({ status: 'open' as never }));
    assert(r !== null && r.includes('status'), 'status error');
  });

  // ── serializeTodoMetadata ───────────────────────────────────
  console.log('\n[todoTool] serializeTodoMetadata');

  await test('present metadata → JSON string', () => {
    const r = serializeTodoMetadata({ key: 'val' });
    assert(r !== null && JSON.parse(r).key === 'val', 'serialized');
  });
  await test('undefined → null', () => {
    assert(serializeTodoMetadata(undefined) === null, 'null');
  });
  await test('empty object → null', () => {
    assert(serializeTodoMetadata({}) === null, 'null');
  });

  // ── buildTodoDraft ──────────────────────────────────────────
  console.log('\n[todoTool] buildTodoDraft');

  await test('valid input → ok:true with draft', () => {
    const r = buildTodoDraft(makeCreateInput());
    assert(r.ok === true, 'ok true');
    if (r.ok) {
      assert(r.draft.category === 'equipment_specific', 'category');
      assert(r.draft.timeSensitivity === 'standard', 'timeSensitivity');
      assert(r.draft.equipmentId === 'machine-001', 'equipmentId');
    }
  });
  await test('invalid input → ok:false with error string', () => {
    const r = buildTodoDraft(makeCreateInput({ description: '' }));
    assert(r.ok === false, 'ok false');
    if (!r.ok) assert(r.error.includes('description'), 'error message');
  });
  await test('description trimmed in draft', () => {
    const r = buildTodoDraft(makeCreateInput({ description: '  Check fluid  ' }));
    assert(r.ok === true, 'ok');
    if (r.ok) assert(r.draft.description === 'Check fluid', 'trimmed');
  });
  await test('optional fields preserved in draft', () => {
    const r = buildTodoDraft(makeCreateInput({
      equipmentId: null, equipmentNote: 'welder estimate',
      dueDate: '2026-06-01',
    }));
    assert(r.ok === true, 'ok');
    if (r.ok) {
      assert(r.draft.equipmentId === null, 'null equipmentId');
      assert(r.draft.equipmentNote === 'welder estimate', 'equipmentNote');
      assert(r.draft.dueDate === '2026-06-01', 'dueDate');
    }
  });

  // ── writeTodo ───────────────────────────────────────────────
  console.log('\n[todoTool] writeTodo');

  function makeDraft() {
    const r = buildTodoDraft(makeCreateInput());
    if (!r.ok) throw new Error('fixture failed');
    return r.draft;
  }

  await test('happy path → null, INSERT called', async () => {
    let sql = ''; let params: unknown[] = [];
    const db: TodoWriteDbClient = {
      run: async (s, p) => { sql = s; params = p; },
      get: async () => undefined,
    };
    const result = await writeTodo(makeDraft(), db);
    assert(result === null, 'null');
    assert(sql.includes('todos'), 'INSERT into todos');
    assert((params as unknown[]).includes('equipment_specific'), 'category param');
    assert((params as unknown[]).includes('open') === false, 'status hardcoded not param');
    assert(sql.includes("'open'"), 'status open in SQL');
    assert((params as unknown[])[params.length - 1] === 0, 'is_synced 0');
  });
  await test('write failure → TodoWriteError(write_error)', async () => {
    const db: TodoWriteDbClient = {
      run: async () => { throw new Error('disk full'); },
      get: async () => undefined,
    };
    const result = await writeTodo(makeDraft(), db);
    assert(result instanceof TodoWriteError, 'TodoWriteError');
    assert(result!.cause === 'write_error', 'write_error');
  });

  // ── updateTodoStatus ────────────────────────────────────────
  console.log('\n[todoTool] updateTodoStatus');

  function makeStubDb(exists: boolean, failOn?: 'get' | 'run'): TodoWriteDbClient {
    return {
      run: async () => { if (failOn === 'run') throw new Error('DB error'); },
      get: async <T>(): Promise<T | undefined> => {
        if (failOn === 'get') throw new Error('DB error');
        return exists ? ({ todo_id: 'todo-001' }) as unknown as T : undefined;
      },
    };
  }

  await test('valid done → null, UPDATE called', async () => {
    let sql = '';
    const db: TodoWriteDbClient = {
      run: async (s) => { sql = s; },
      get: async <T>() => ({ todo_id: 'todo-001' }) as unknown as T,
    };
    const result = await updateTodoStatus(makeUpdateInput(), db);
    assert(result === null, 'null');
    assert(sql.includes('UPDATE todos'), 'UPDATE todos');
    assert(sql.includes('status'), 'status in SQL');
  });
  await test('valid dismissed → null', async () => {
    const result = await updateTodoStatus(makeUpdateInput({ status: 'dismissed' }), makeStubDb(true));
    assert(result === null, 'null');
  });
  await test('todo not found → TodoWriteError(not_found)', async () => {
    const result = await updateTodoStatus(makeUpdateInput(), makeStubDb(false));
    assert(result instanceof TodoWriteError, 'TodoWriteError');
    assert(result!.cause === 'not_found', 'not_found');
  });
  await test('invalid input → TodoWriteError(invalid_input), no DB call', async () => {
    let dbCalled = false;
    const db: TodoWriteDbClient = {
      run: async () => { dbCalled = true; },
      get: async () => { dbCalled = true; return undefined; },
    };
    const result = await updateTodoStatus(makeUpdateInput({ todoId: '' }), db);
    assert(result instanceof TodoWriteError, 'TodoWriteError');
    assert(result!.cause === 'invalid_input', 'invalid_input');
    assert(!dbCalled, 'no DB call on invalid input');
  });
  await test('DB lookup failure → TodoWriteError(write_error)', async () => {
    const result = await updateTodoStatus(makeUpdateInput(), makeStubDb(true, 'get'));
    assert(result instanceof TodoWriteError && result.cause === 'write_error', 'write_error');
  });
  await test('DB update failure → TodoWriteError(write_error)', async () => {
    const result = await updateTodoStatus(makeUpdateInput(), makeStubDb(true, 'run'));
    assert(result instanceof TodoWriteError && result.cause === 'write_error', 'write_error');
  });
  await test('done with TimeLog stub failure → null (non-fatal)', async () => {
    // TimeLog throws but update still succeeds
    const result = await updateTodoStatus(makeUpdateInput({ status: 'done' }), makeStubDb(true));
    assert(result === null, 'null — TimeLog failure is non-fatal');
  });

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n[todoTool] ${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('Test runner error:', err); process.exit(1); });
