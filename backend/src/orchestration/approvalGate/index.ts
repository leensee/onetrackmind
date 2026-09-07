// ============================================================
// OTM Orchestration — Approval Gate (impure surface + re-exports)
// Holds output requiring explicit user action before anything
// proceeds. Manages the hold state, surfaces pending items to
// the user via WebSocket, receives decisions, routes accordingly.
// Also handles regen limit surface and feedback submission.
// WebSocket connection owned by Fastify layer — not here.
// Owns real side effects: fetch, wsSend, and observability via
// the injected Logger (options.logger; console-backed default).
// Paired with ./pure.ts which owns deterministic logic.
// ============================================================

import { FeedbackPayload } from '../types';
import { errorMessage } from '../typeUtils';
import { Logger, createConsoleLogger } from '../../observability/logger';
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

const defaultLogger: Logger = createConsoleLogger('ApprovalGate');

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
      `Failed to send approval request: ${errorMessage(err)}`,
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
      `Failed to send regen limit message: ${errorMessage(err)}`,
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
// options.github: edition-specific GitHub fields (repo, titleFormat, labels).
//   Required when token is present; ignored (and not required) when absent.
//   repo: from AuditConfig.githubRepo; titleFormat: from EditionConfig.feedbackIssueTitleFormat;
//   labels: from EditionConfig.feedbackIssueLabels (OTM v1: DEFAULT_FEEDBACK_ISSUE_LABELS).
// options.fallbackEmailFn: edition-agnostic — caller provides, gate doesn't
// know which email provider is in use. Receives the full FeedbackPayload
// so the caller doesn't have to reconstruct or re-serialize it.
// options.logger: observability sink; tests inject a capturing Logger.
// Callers that only use email fallback (no token, no GitHub) need not
// supply options.github at all.

// The OTM v1 label set. Editions inject their own through
// EditionConfig.feedbackIssueLabels; this constant exists so the v1
// config and its fixtures reference one value instead of re-typing
// literals that downstream triage automation depends on.
export const DEFAULT_FEEDBACK_ISSUE_LABELS: readonly string[] = ['audit-failure', 'regen-limit-reached'];

export interface FeedbackSubmitOptions {
  github?: {
    repo:        string;
    titleFormat: string;
    labels:      readonly string[];
  };
  fallbackEmailFn?: (payload: FeedbackPayload) => Promise<void>;
  logger?: Logger;
}

// Metadata-only view of a payload for failure logs: never the content.
function payloadMetadata(payload: FeedbackPayload): Record<string, unknown> {
  return {
    sessionId:    payload.sessionId,
    timestamp:    payload.timestamp,
    eventType:    payload.eventType,
    userAction:   payload.userAction,
    attempts:     payload.attempts.length,
    manualRegens: payload.manualRegens.length,
  };
}

export async function submitFeedback(
  payload: FeedbackPayload,
  token:   string | undefined,
  options: FeedbackSubmitOptions
): Promise<void> {
  const { github, fallbackEmailFn } = options;
  const logger = options.logger ?? defaultLogger;

  // No token — skip GitHub entirely, route directly to fallback.
  // Orchestrator passes env.githubFeedbackToken here; undefined is valid
  // pre-Phase 4 and the gate owns this path — no orchestrator decision needed.
  if (!token) {
    logger.warn('GITHUB_FEEDBACK_TOKEN not configured — attempting email fallback', {
      sessionId: payload.sessionId,
    });
    if (fallbackEmailFn) {
      try {
        await fallbackEmailFn(payload);
        logger.info('feedback submitted via email fallback (no token)', {
          sessionId: payload.sessionId,
        });
        return;
      } catch (emailErr) {
        logger.error('email fallback failed (no token)', { detail: errorMessage(emailErr) });
      }
    }
    // No token and no fallback, or fallback failed — log metadata only, throw.
    logger.error('no feedback channels available — logging metadata', payloadMetadata(payload));
    throw new ApprovalGateError(
      'Feedback submission failed — GITHUB_FEEDBACK_TOKEN not configured and no fallback available',
      payload.sessionId,
      'feedback_error'
    );
  }

  if (!github) {
    throw new ApprovalGateError(
      'Feedback submission failed — options.github (repo and titleFormat) is required when a token is provided',
      payload.sessionId,
      'feedback_error'
    );
  }

  if (!github.titleFormat.includes('{sessionId}')) {
    throw new ApprovalGateError(
      `Feedback submission failed — titleFormat must contain '{sessionId}' placeholder (got: '${github.titleFormat}')`,
      payload.sessionId,
      'feedback_error'
    );
  }

  // A blank label would fail at GitHub with a 422 after the payload has
  // already left; catch the misconfiguration here with a typed error instead.
  if (github.labels.some(label => label.trim() === '')) {
    throw new ApprovalGateError(
      `Feedback submission failed — labels must be non-blank strings (got: ${JSON.stringify(github.labels)})`,
      payload.sessionId,
      'feedback_error'
    );
  }

  const issueUrl = `https://api.github.com/repos/${github.repo}/issues`;
  const issueBody = {
    title:  github.titleFormat.replaceAll('{sessionId}', payload.sessionId),
    body:   JSON.stringify(payload, null, 2),
    labels: [...github.labels],
  };

  let githubSucceeded = false;

  try {
    const response = await fetch(issueUrl, {
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
    logger.info('feedback submitted to GitHub', { sessionId: payload.sessionId });
  } catch (githubErr) {
    logger.error('GitHub feedback submission failed', { detail: errorMessage(githubErr) });

    if (fallbackEmailFn) {
      try {
        await fallbackEmailFn(payload);
        logger.info('feedback submitted via email fallback', { sessionId: payload.sessionId });
        return;
      } catch (emailErr) {
        logger.error('email fallback also failed', { detail: errorMessage(emailErr) });
      }
    }

    if (!githubSucceeded) {
      // Both paths failed — log metadata only for tracing; full payload not logged
      // to avoid operational content in error logs. Content is unrecoverable at this point.
      logger.error(
        'all feedback channels failed — logging metadata for tracing',
        payloadMetadata(payload)
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
