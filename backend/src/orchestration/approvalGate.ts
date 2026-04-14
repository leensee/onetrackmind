// ============================================================
// OTM Orchestration — Approval Gate
// Holds output requiring explicit user action before anything
// proceeds. Manages the hold state, surfaces pending items to
// the user via WebSocket, receives decisions, routes accordingly.
// Also handles regen limit surface and feedback submission.
// WebSocket connection owned by Fastify layer — not here.
// ============================================================

import EventEmitter from 'events';
import { FeedbackPayload } from './types';

// ── Constants ─────────────────────────────────────────────────

export const APPROVAL_TIMEOUT_MS   = 300_000;  // 5 minutes
export const FEEDBACK_GITHUB_REPO  = 'leensee/onetrackmind';
export const FEEDBACK_GITHUB_URL   =
  `https://api.github.com/repos/${FEEDBACK_GITHUB_REPO}/issues`;

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
// Pure functions — exported for testing.

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

// ── Send Helpers ──────────────────────────────────────────────

export function sendApprovalRequest(
  requestId: string,
  content:   string,
  wsSend:    WsSend
): void {
  try {
    wsSend(buildApprovalMessage(requestId, content));
  } catch (err) {
    throw new ApprovalGateError(
      `Failed to send approval request: ${(err as Error).message}`,
      requestId,
      'send_error'
    );
  }
}

export function sendRegenLimitMessage(
  requestId: string,
  draft:     string,
  auditFlag: string,
  wsSend:    WsSend
): void {
  try {
    wsSend(buildRegenLimitMessage(requestId, draft, auditFlag));
  } catch (err) {
    throw new ApprovalGateError(
      `Failed to send regen limit message: ${(err as Error).message}`,
      requestId,
      'send_error'
    );
  }
}

// ── Decision Waiter ───────────────────────────────────────────
// Listens on the DecisionEmitter for a matching inbound response.
// Cleans up listener on resolution or timeout — no memory leaks.
// timeoutMs injectable for testing.

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

// ── Feedback Submitter ────────────────────────────────────────
// Posts to GitHub Issues API. Falls back to fallbackEmailFn
// if provided. Logs locally if both fail.
// Uses fetch (Node 18+ built-in) — no new HTTP dependency.
// token: GITHUB_FEEDBACK_TOKEN from environment (injected by caller).
// fallbackEmailFn: edition-agnostic — caller provides, gate doesn't
// know which email provider is in use.

export async function submitFeedback(
  payload:          FeedbackPayload,
  token:            string | undefined,
  fallbackEmailFn?: () => Promise<void>
): Promise<void> {
  // No token — skip GitHub entirely, route directly to fallback.
  // Orchestrator passes env.githubFeedbackToken here; undefined is valid
  // pre-Phase 4 and the gate owns this path — no orchestrator decision needed.
  if (!token) {
    console.warn(
      `[ApprovalGate] GITHUB_FEEDBACK_TOKEN not configured — attempting email fallback ` +
      `sessionId=${payload.sessionId}`
    );
    if (fallbackEmailFn) {
      try {
        await fallbackEmailFn();
        console.info(
          `[ApprovalGate] feedback submitted via email fallback (no token) ` +
          `sessionId=${payload.sessionId}`
        );
        return;
      } catch (emailErr) {
        console.error(
          `[ApprovalGate] email fallback failed (no token): ${(emailErr as Error).message}`
        );
      }
    }
    // No token and no fallback, or fallback failed — log metadata only, throw.
    console.error(
      `[ApprovalGate] no feedback channels available — logging metadata: ` +
      `sessionId=${payload.sessionId} timestamp=${payload.timestamp} ` +
      `eventType=${payload.eventType} userAction=${payload.userAction} ` +
      `attempts=${payload.attempts.length} manualRegens=${payload.manualRegens.length}`
    );
    throw new ApprovalGateError(
      'Feedback submission failed — GITHUB_FEEDBACK_TOKEN not configured and no fallback available',
      payload.sessionId,
      'feedback_error'
    );
  }

  const issueBody = {
    title:  `[audit-failure] ${payload.sessionId}`,
    body:   JSON.stringify(payload, null, 2),
    labels: ['audit-failure', 'regen-limit-reached'],
  };

  let githubSucceeded = false;

  try {
    const response = await fetch(FEEDBACK_GITHUB_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Accept':        'application/vnd.github+json',
      },
      body: JSON.stringify(issueBody),
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
    }

    githubSucceeded = true;
    console.info(
      `[ApprovalGate] feedback submitted to GitHub sessionId=${payload.sessionId}`
    );
  } catch (githubErr) {
    console.error(
      `[ApprovalGate] GitHub feedback submission failed: ${(githubErr as Error).message}`
    );

    if (fallbackEmailFn) {
      try {
        await fallbackEmailFn();
        console.info(
          `[ApprovalGate] feedback submitted via email fallback sessionId=${payload.sessionId}`
        );
        return;
      } catch (emailErr) {
        console.error(
          `[ApprovalGate] email fallback also failed: ${(emailErr as Error).message}`
        );
      }
    }

    if (!githubSucceeded) {
      // Both paths failed — log metadata only for tracing; full payload not logged
      // to avoid operational content in error logs. Content is unrecoverable at this point.
      console.error(
        `[ApprovalGate] all feedback channels failed — logging metadata for tracing: ` +
        `sessionId=${payload.sessionId} timestamp=${payload.timestamp} ` +
        `eventType=${payload.eventType} userAction=${payload.userAction} ` +
        `attempts=${payload.attempts.length} manualRegens=${payload.manualRegens.length}`
      );

      throw new ApprovalGateError(
        'Feedback submission failed on all channels',
        payload.sessionId,
        'feedback_error'
      );
    }
  }
}

// ── Main Gate ─────────────────────────────────────────────────
// Sends approval request, waits for decision, returns it.
// Caller routes on the returned ApprovalDecision.
// timeoutMs injectable for testing.

export async function runApprovalGate(
  requestId:       string,
  content:         string,
  wsSend:          WsSend,
  decisionEmitter: DecisionEmitter,
  timeoutMs:       number = APPROVAL_TIMEOUT_MS
): Promise<ApprovalDecision> {
  sendApprovalRequest(requestId, content, wsSend);
  return waitForDecision(requestId, decisionEmitter, timeoutMs);
}
