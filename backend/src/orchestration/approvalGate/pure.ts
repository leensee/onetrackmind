// ============================================================
// OTM Orchestration — Approval Gate (no external I/O)
// Building blocks: constants, types, the ApprovalGateError
// class, outbound-message builders, and the decision waiter.
// No fetch, no console, no wsSend; internal EventEmitter and
// timer wiring is used by waitForDecision.
// Paired with ./index.ts which owns real I/O.

import EventEmitter from 'events';

// ── Constants ─────────────────────────────────────────────────

export const APPROVAL_TIMEOUT_MS = 300_000;  // 5 minutes

// ── Types ─────────────────────────────────────────────────────

export type ApprovalDecision =
  | 'approve'
  | 'reject'
  | 'edit'
  | 'try_again'
  | 'use_as_is'
  | 'drop'
  | 'send_feedback';

// WsSend — injected WebSocket send function.
// Caller owns the connection; gate only sends.
export type WsSend = (payload: Record<string, unknown>) => void;

// DecisionEmitter — Node.js EventEmitter the Fastify WebSocket
// handler fires with inbound client messages. Gate listens for
// 'decision' events, matches on requestId, cleans up listener.
export type DecisionEmitter = EventEmitter;

export interface InboundDecisionEvent {
  type:       'approval_response';
  requestId:  string;
  decision:   ApprovalDecision;
}

// ── Approval Gate Error ───────────────────────────────────────

export class ApprovalGateError extends Error {
  public readonly requestId: string;
  public readonly cause: 'timeout' | 'send_error' | 'feedback_error';

  constructor(
    message:   string,
    requestId: string,
    cause:     'timeout' | 'send_error' | 'feedback_error'
  ) {
    super(message);
    this.name      = 'ApprovalGateError';
    this.requestId = requestId;
    this.cause     = cause;
  }
}

// ── Outbound Message Builders ─────────────────────────────────

export function buildApprovalMessage(
  requestId: string,
  content:   string
): Record<string, unknown> {
  return {
    type:      'approval_required',
    requestId,
    content,
    options:   ['approve', 'reject', 'edit'],
  };
}

export function buildRegenLimitMessage(
  requestId: string,
  draft:     string,
  auditFlag: string
): Record<string, unknown> {
  return {
    type:      'regen_limit',
    requestId,
    draft,
    auditFlag,
    options:   ['try_again', 'use_as_is', 'drop', 'send_feedback'],
  };
}

// ── Decision Waiter ───────────────────────────────────────────
// The decision emitter is injected; standard timer APIs are used
// internally. The function cleans up its own listener + timer on
// both resolve and timeout paths.
// timeoutMs is configurable for testing.

export function waitForDecision(
  requestId:       string,
  decisionEmitter: DecisionEmitter,
  timeoutMs:       number = APPROVAL_TIMEOUT_MS
): Promise<ApprovalDecision> {
  return new Promise((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | null = null;

    function onDecision(event: InboundDecisionEvent): void {
      // Ignore events for other requests
      if (event.requestId !== requestId) return;

      cleanup();
      resolve(event.decision);
    }

    function cleanup(): void {
      decisionEmitter.off('decision', onDecision);
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    }

    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new ApprovalGateError(
        `Approval gate timed out after ${timeoutMs}ms — item queued for next session open`,
        requestId,
        'timeout'
      ));
    }, timeoutMs);

    decisionEmitter.on('decision', onDecision);
  });
}
