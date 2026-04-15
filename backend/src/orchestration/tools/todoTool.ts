// ============================================================
// OTM Tools — Todo Tool
// Owns all todo-related actions: create, status update,
// and TimeLog write stub (pending Phase 7 schema design).
// DB client is injected — never constructed here.
// All queries parameterized — no string interpolation.
// Tool is pure — orchestrator owns all approval gate routing.
// ============================================================

import { randomUUID } from 'crypto';
import {
  TodoCategory,
  TodoTimeSensitivity,
  TodoCreateInput,
  TodoUpdateInput,
  TodoDraft,
} from '../types';

// ── Constants ─────────────────────────────────────────────────

export const TODO_MAX_RETENTION_DAYS = 180;

// is_synced always 0 on write — Phase 7 sync layer sets to 1
// after Supabase confirmation. Not a parameter — no caller can
// accidentally create a pre-synced record.
const IS_NOT_SYNCED = 0;

const VALID_CATEGORIES: TodoCategory[] = [
  'safety', 'equipment_specific', 'parts_inventory',
  'compliance_admin', 'contact',
];

const VALID_TIME_SENSITIVITIES: TodoTimeSensitivity[] = [
  'urgent', 'standard', 'low',
];

const VALID_TERMINAL_STATUSES = ['done', 'dismissed'] as const;

// ── Narrow DB Interface ───────────────────────────────────────

export interface TodoWriteDbClient {
  run(sql: string, params: unknown[]): Promise<void>;
  get<T>(sql: string, params: unknown[]): Promise<T | undefined>;
}

// ── Error and Result Types ────────────────────────────────────

export class TodoWriteError extends Error {
  public readonly sessionId: string;
  public readonly requestId: string;
  public readonly cause:     'write_error' | 'invalid_input' | 'not_found';

  constructor(
    message:   string,
    sessionId: string,
    requestId: string,
    cause:     'write_error' | 'invalid_input' | 'not_found'
  ) {
    super(message);
    this.name      = 'TodoWriteError';
    this.sessionId = sessionId;
    this.requestId = requestId;
    this.cause     = cause;
  }
}

export type TodoWriteResult = TodoWriteError | null;

// ── Pure Functions ────────────────────────────────────────────

// Validates TodoCreateInput. Returns null on valid; error string on failure.
export function validateCreateInput(input: TodoCreateInput): string | null {
  if (!input.description || input.description.trim() === '') {
    return 'description must not be empty';
  }
  if (!(VALID_CATEGORIES as string[]).includes(input.category)) {
    return `category must be one of: ${VALID_CATEGORIES.join(', ')}`;
  }
  if (!(VALID_TIME_SENSITIVITIES as string[]).includes(input.timeSensitivity)) {
    return `timeSensitivity must be one of: ${VALID_TIME_SENSITIVITIES.join(', ')}`;
  }
  if (input.dueDate !== undefined) {
    const d = new Date(input.dueDate);
    if (isNaN(d.getTime())) return `dueDate must be a valid ISO 8601 date; got: ${input.dueDate}`;
  }
  if (input.equipmentId !== null && input.equipmentId !== undefined) {
    if (input.equipmentId.trim() === '') return 'equipmentId must not be empty string when provided';
  }
  if (input.linkedContactId !== null && input.linkedContactId !== undefined) {
    if (input.linkedContactId.trim() === '') return 'linkedContactId must not be empty string when provided';
  }
  return null;
}

// Validates TodoUpdateInput. Returns null on valid; error string on failure.
export function validateUpdateInput(input: TodoUpdateInput): string | null {
  if (!input.todoId || input.todoId.trim() === '') {
    return 'todoId must not be empty';
  }
  if (!(VALID_TERMINAL_STATUSES as readonly string[]).includes(input.status)) {
    return `status must be one of: ${VALID_TERMINAL_STATUSES.join(', ')}`;
  }
  return null;
}

// Serializes optional metadata to JSON or null.
// Never throws — catches serialization failure.
export function serializeTodoMetadata(
  metadata: Record<string, unknown> | undefined
): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  try {
    return JSON.stringify(metadata);
  } catch (err) {
    console.warn(
      `[TodoTool] metadata serialization failed — omitting: ${(err as Error).message}`
    );
    return null;
  }
}

// Builds a validated TodoDraft for orchestrator to route through approval gate.
// Returns discriminated result — orchestrator checks ok before routing.
// Never throws.
export function buildTodoDraft(
  input: TodoCreateInput
): { ok: true; draft: TodoDraft } | { ok: false; error: string } {
  const validationError = validateCreateInput(input);
  if (validationError) return { ok: false, error: validationError };

  const draft: TodoDraft = {
      userId:          input.userId,
      sessionId:       input.sessionId,
      requestId:       input.requestId,
      description:     input.description.trim(),
      category:        input.category,
      timeSensitivity: input.timeSensitivity,
      equipmentId:     input.equipmentId,
      linkedContactId: input.linkedContactId,
      metadataJson:    serializeTodoMetadata(input.metadata),
    };
    if (input.dueDate           !== undefined) draft.dueDate           = input.dueDate;
    if (input.equipmentNote     !== undefined) draft.equipmentNote     = input.equipmentNote;
    if (input.linkedContactNote !== undefined) draft.linkedContactNote = input.linkedContactNote;

    return { ok: true, draft };
}

// ── DB Functions ──────────────────────────────────────────────

// Writes approved TodoDraft to todos table with status=open.
// Called by orchestrator after approval gate resolves 'approve'.
export async function writeTodo(
  draft: TodoDraft,
  db:    TodoWriteDbClient
): Promise<TodoWriteResult> {
  const todoId    = randomUUID();
  const timestamp = new Date().toISOString();

  try {
    await db.run(
      `INSERT INTO todos
         (todo_id, user_id, session_id, description, category, time_sensitivity,
          due_date, equipment_id, equipment_note, linked_contact_id,
          linked_contact_note, metadata_json, status, created_at, is_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [
        todoId, draft.userId, draft.sessionId, draft.description,
        draft.category, draft.timeSensitivity,
        draft.dueDate ?? null, draft.equipmentId, draft.equipmentNote ?? null,
        draft.linkedContactId, draft.linkedContactNote ?? null,
        draft.metadataJson, timestamp, IS_NOT_SYNCED,
      ]
    );
    console.info(
      `[TodoTool] todo written todoId=${todoId} category=${draft.category} ` +
      `timeSensitivity=${draft.timeSensitivity} sessionId=${draft.sessionId}`
    );
    return null;
  } catch (err) {
    return new TodoWriteError(
      `Write failed: ${(err as Error).message}`,
      draft.sessionId, draft.requestId, 'write_error'
    );
  }
}

// ── TimeLog Stub ──────────────────────────────────────────────
// TODO: Implement when TimeLog schema is designed in Phase 7.
// Called by updateTodoStatus on status=done.
// Stub throws — failure is non-fatal in updateTodoStatus (logged, not propagated).
export async function writeTimeLogEntry(
  _todoId: string,
  _userId: string,
  _db:     TodoWriteDbClient
): Promise<void> {
  throw new Error(
    'TimeLog not yet implemented — pending TimeLog schema design in Phase 7'
  );
}

// Updates todo status to done or dismissed.
// On done: attempts TimeLog write — failure is non-fatal (logged as warn).
// On any DB failure: returns TodoWriteError. Never throws.
export async function updateTodoStatus(
  input: TodoUpdateInput,
  db:    TodoWriteDbClient
): Promise<TodoWriteResult> {
  const validationError = validateUpdateInput(input);
  if (validationError) {
    return new TodoWriteError(
      `Invalid update input: ${validationError}`,
      input.sessionId, input.requestId, 'invalid_input'
    );
  }

  // Verify todo exists before updating
  let row: { todo_id: string } | undefined;
  try {
    row = await db.get<{ todo_id: string }>(
      `SELECT todo_id FROM todos WHERE todo_id = ? AND user_id = ?`,
      [input.todoId, input.userId]
    );
  } catch (err) {
    return new TodoWriteError(
      `Todo lookup failed: ${(err as Error).message}`,
      input.sessionId, input.requestId, 'write_error'
    );
  }

  if (!row) {
    return new TodoWriteError(
      `Todo not found: todoId=${input.todoId}`,
      input.sessionId, input.requestId, 'not_found'
    );
  }

  try {
    await db.run(
      `UPDATE todos SET status = ?, updated_at = ? WHERE todo_id = ? AND user_id = ?`,
      [input.status, new Date().toISOString(), input.todoId, input.userId]
    );
  } catch (err) {
    return new TodoWriteError(
      `Status update failed: ${(err as Error).message}`,
      input.sessionId, input.requestId, 'write_error'
    );
  }

  if (input.status === 'done') {
    try {
      await writeTimeLogEntry(input.todoId, input.userId, db);
    } catch (err) {
      // TimeLog write failure is non-fatal — todo is already marked done.
      // Will be re-attempted when TimeLog is implemented in Phase 7.
      console.warn(
        `[TodoTool] TimeLog write skipped todoId=${input.todoId}: ` +
        `${(err as Error).message}`
      );
    }
  }

  console.info(
    `[TodoTool] todo updated todoId=${input.todoId} ` +
    `status=${input.status} sessionId=${input.sessionId}`
  );
  return null;
}
