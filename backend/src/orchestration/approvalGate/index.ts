// ============================================================
// OTM Orchestration — Approval Gate (impure surface + re-exports)
// Holds output requiring explicit user action before anything
// proceeds. Manages the hold state, surfaces pending items to
// the user via WebSocket, receives decisions, routes accordingly.
// Also handles regen limit surface and feedback submission.
// WebSocket connection owned by Fastify layer — not here.
// Owns real side effects: fetch, wsSend, console.*.
// Paired with ./pure.ts which owns deterministic logic.
// ============================================================

import { FeedbackPayload } from '../types';
import {
  APPROVAL_TIMEOUT_MS,
  ApprovalDecision,
  ApprovalGateError,
  WsSend,
  DecisionEmitter,
  buildApprovalMessage,
  buildRegenLimitMessage,
  waitForDecision,
} from './pure';

// Public surface preserved for consumers importing from './approvalGate'.
export * from './pure';

// ── Constants (internal) ──────────────────────────────────────

const FEEDBACK_GITHUB_REPO = 'leensee/onetrackmind';
const FEEDBACK_GITHUB_URL  =
  `https://api.github.com/repos/${FEEDBACK_GITHUB_REPO}/issues`;

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

// ── Feedback Submitter ────────────────────────────────────────
// Posts to GitHub Issues API. Falls back to fallbackEmailFn
// if provided. Logs locally if both fail.
// Uses fetch (Node 18+ built-in) — no new HTTP dependency.
// token: GITHUB_FEEDBACK_TOKEN from environment (injected by caller).
// fallbackEmailFn: edition-agnostic — caller provides, gate doesn't
// know which email provider is in use. Receives the full FeedbackPayload
// so the caller doesn't have to reconstruct or re-serialize it.

export async function submitFeedback(
  payload:          FeedbackPayload,
  token:            string | undefined,
  fallbackEmailFn?: (payload: FeedbackPayload) => Promise<void>
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
        await fallbackEmailFn(payload);
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
        await fallbackEmailFn(payload);
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
