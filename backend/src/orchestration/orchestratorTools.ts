// ============================================================
// OTM Orchestration — Tool Integration Layer
// Connects Phase 2 orchestration to Phase 3 tools.
// Owns the draft → approval gate → write flow.
// All tool clients injected via ToolDeps — never constructed here.
// Exhaustive switch — no fall-through, no arbitrary decisions.
// ============================================================

import {
  ToolCallInput,
  ToolCallStatus,
  DiagnosticLogInput,
} from './types';

// Tool layer imports
import { buildTodoDraft, writeTodo, updateTodoStatus, TodoWriteDbClient } from './tools/todoTool';
import { buildCommsDraft } from './tools/commsDrafter';
import { buildPoGenerateResult, writePurchaseOrder, PoWriteDbClient } from './tools/poGenerator';
import { PoSequenceDbClient } from './tools/poSequence';
import { specLookup, SpecLookupDbClient } from './tools/specLookup';
import { parseExpense, ImageExtractorClient } from './tools/expenseParser';
import { buildSheetOutput } from './tools/sheetOutput';
import { logDiagnosticEntry, DiagnosticLogDbClient } from './tools/diagnosticLogger';

// Phase 2 approval gate imports
import {
  runApprovalGate,
  WsSend,
  DecisionEmitter,
  ApprovalGateError,
} from './approvalGate';

// Shared formatters — human-readable rendering for approval gate (OT-9).
import { formatDraftForApproval } from './formatters';

// ── ToolDeps ──────────────────────────────────────────────────
// All injected dependencies — never constructed here.
// db covers all write operations across tool layer modules.

export interface ToolWriteDbClient
  extends TodoWriteDbClient, PoWriteDbClient, DiagnosticLogDbClient,
          SpecLookupDbClient, PoSequenceDbClient {
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
}

export interface ToolDeps {
  db:          ToolWriteDbClient;
  wsSend:      WsSend;
  emitter:     DecisionEmitter;
  extractor?:  ImageExtractorClient;
  timeoutMs?:  number;
}

// ── Approval Gate Helper ──────────────────────────────────────
// Runs the approval gate and maps ApprovalGateError to ToolCallStatus.
async function runGate(
  requestId: string,
  content:   string,
  tool:      string,
  deps:      ToolDeps
): Promise<'approved' | 'rejected' | 'timeout'> {
  try {
    const decision = await runApprovalGate(
      requestId, content, deps.wsSend, deps.emitter, deps.timeoutMs
    );
    if (decision === 'approve') return 'approved';
    return 'rejected';
  } catch (err) {
    if (err instanceof ApprovalGateError && err.cause === 'timeout') return 'timeout';
    throw err; // send_error propagates — orchestrator handles at call site
  }
}

// ── Main Dispatch ─────────────────────────────────────────────
export async function dispatchToolCall(
  call: ToolCallInput,
  deps: ToolDeps
): Promise<ToolCallStatus> {
  const tool = call.tool;

  switch (tool) {
    // ── todo_create: draft → gate → write ──────────────────
    case 'todo_create': {
      const draftResult = buildTodoDraft(call.input);
      if (!draftResult.ok) {
        return { status: 'error', tool, error: draftResult.error };
      }
      const { draft } = draftResult;
      const gate = await runGate(
        draft.requestId, formatDraftForApproval(draft), tool, deps
      ).catch(err => ({ gateErr: (err as Error).message }));

      if (typeof gate === 'object') return { status: 'error', tool, error: gate.gateErr };
      if (gate === 'rejected') return { status: 'rejected', tool };
      if (gate === 'timeout')  return { status: 'timeout',  tool };

      const writeResult = await writeTodo(draft, deps.db);
      if (writeResult) return { status: 'error', tool, error: writeResult.message };
      return { status: 'approved', tool, result: draft };
    }

    // ── todo_update: direct write, no gate (user-directed) ─
    case 'todo_update': {
      const writeResult = await updateTodoStatus(call.input, deps.db);
      if (writeResult) return { status: 'error', tool, error: writeResult.message };
      return { status: 'direct_write', tool, result: call.input };
    }

    // ── comms_draft: draft → gate (send is Phase 4) ────────
    case 'comms_draft': {
      const draftResult = buildCommsDraft(call.input);
      if (!draftResult.ok) return { status: 'error', tool, error: draftResult.error };
      const { draft } = draftResult;
      const gate = await runGate(
        call.input.requestId, formatDraftForApproval(draft), tool, deps
      ).catch(err => ({ gateErr: (err as Error).message }));

      if (typeof gate === 'object') return { status: 'error', tool, error: gate.gateErr };
      if (gate === 'rejected') return { status: 'rejected', tool };
      if (gate === 'timeout')  return { status: 'timeout',  tool };
      // Draft returned to orchestrator — Phase 4 handles send
      return { status: 'approved', tool, result: draft };
    }

    // ── po_generate: allocate → draft → gate → write ───────
    // Sequence is allocated once, up front, and is consumed
    // regardless of gate outcome. Gaps in PO numbers are fine —
    // see poSequence.ts and audit finding 2026-04-16-OT-5.
    case 'po_generate': {
      let sequence: number;
      try {
        sequence = await deps.db.allocateNext(call.input.userId);
      } catch (err) {
        const detail =
          err instanceof Error && err.message.trim().length > 0
            ? err.message
            : 'unknown database error';
        return { status: 'error', tool, error: `PO sequence allocation failed: ${detail}` };
      }
      const genResult = buildPoGenerateResult(call.input, sequence);
      if (!genResult.ok) return { status: 'error', tool, error: genResult.error };
      const { order, document } = genResult;
      const gate = await runGate(
        call.input.requestId, formatDraftForApproval(document), tool, deps
      ).catch(err => ({ gateErr: (err as Error).message }));

      if (typeof gate === 'object') return { status: 'error', tool, error: gate.gateErr };
      if (gate === 'rejected') return { status: 'rejected', tool };
      if (gate === 'timeout')  return { status: 'timeout',  tool };

      const writeResult = await writePurchaseOrder(order, call.input.requestId, deps.db);
      if (writeResult) return { status: 'error', tool, error: writeResult.message };
      return { status: 'approved', tool, result: { order, document } };
    }

    // ── spec_lookup: read-only, no gate ────────────────────
    case 'spec_lookup': {
      const result = await specLookup(call.input, deps.db);
      if (result.status === 'error') return { status: 'error', tool, error: result.message };
      return { status: 'read_result', tool, result };
    }

    // ── expense_parse: read-only, no gate ──────────────────
    case 'expense_parse': {
      const result = await parseExpense(call.input, deps.extractor);
      if (!result.ok) return { status: 'error', tool, error: result.error };
      return { status: 'read_result', tool, result: result.record };
    }

    // ── sheet_output: read-only, no gate ───────────────────
    case 'sheet_output': {
      const result = buildSheetOutput(call.input);
      if (!result.ok) return { status: 'error', tool, error: result.error };
      return { status: 'read_result', tool, result };
    }

    // ── log_diagnostic: system-initiated direct write ──────
    case 'log_diagnostic': {
      const writeResult = await logDiagnosticEntry(
        call.input as DiagnosticLogInput, deps.db
      );
      if (writeResult) return { status: 'error', tool, error: writeResult.message };
      return { status: 'direct_write', tool, result: null };
    }

    default: {
      const exhaustiveCheck: never = call;
      return {
        status: 'error',
        tool:   String((exhaustiveCheck as { tool: string }).tool),
        error:  `Unrecognized tool: ${String((exhaustiveCheck as { tool: string }).tool)}`,
      };
    }
  }
}
