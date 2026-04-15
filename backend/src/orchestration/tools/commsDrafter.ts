// ============================================================
// OTM Tools — Comms Drafter
// Produces structured outbound communication drafts for SMS
// and email. Provider-agnostic — no Twilio, Gmail, or any
// other provider-specific logic.
// Pure functions only — no DB access, no external calls.
// Orchestrator owns approval gate routing and send dispatch.
// ============================================================

import {
  CommsDraftInput,
  CommsDraftResult,
  SmsDraft,
  EmailDraft,
} from '../types';

// ── Constants ─────────────────────────────────────────────────

export const TONE_LEVEL_MIN = 0;
export const TONE_LEVEL_MAX = 10;

// Reference anchors — documentation only, not enforced as enum.
// 0 = neutral, 5 = peer, 10 = formal
export const TONE_ANCHOR_NEUTRAL    = 0;
export const TONE_ANCHOR_PEER       = 5;
export const TONE_ANCHOR_FORMAL     = 10;

// ── Pure Functions ────────────────────────────────────────────

// Validates toneLevel: must be an integer in range 0–10.
export function validateToneLevel(toneLevel: number): string | null {
  if (!Number.isInteger(toneLevel)) {
    return `toneLevel must be an integer; got: ${toneLevel}`;
  }
  if (toneLevel < TONE_LEVEL_MIN || toneLevel > TONE_LEVEL_MAX) {
    return `toneLevel must be between ${TONE_LEVEL_MIN} and ${TONE_LEVEL_MAX}; got: ${toneLevel}`;
  }
  return null;
}

// Validates all recipients in the array are non-empty strings.
export function validateRecipients(recipients: string[]): string | null {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return 'recipients must be a non-empty array';
  }
  for (const r of recipients) {
    if (typeof r !== 'string' || r.trim() === '') {
      return 'each recipient must be a non-empty string';
    }
  }
  return null;
}

// Validates CommsDraftInput. Returns null on valid; error string on failure.
export function validateCommsDraftInput(input: CommsDraftInput): string | null {
  if (input.channel !== 'sms' && input.channel !== 'email') {
    return `channel must be 'sms' or 'email'; got: ${input.channel}`;
  }
  const recipientsError = validateRecipients(input.recipients);
  if (recipientsError) return recipientsError;

  if (!input.body || input.body.trim() === '') {
    return 'body must not be empty';
  }
  const toneError = validateToneLevel(input.toneLevel);
  if (toneError) return toneError;

  if (input.channel === 'email') {
    if (!input.subject || input.subject.trim() === '') {
      return 'subject must not be empty for email channel';
    }
  }
  if (input.replyTo !== undefined && input.replyTo.trim() === '') {
    return 'replyTo must not be empty string when provided';
  }
  return null;
}

// Builds a validated CommsDraft for orchestrator to route through approval gate.
// Returns discriminated result — orchestrator checks ok before routing.
// Never throws.
export function buildCommsDraft(input: CommsDraftInput): CommsDraftResult {
  const validationError = validateCommsDraftInput(input);
  if (validationError) return { ok: false, error: validationError };

  if (input.channel === 'sms') {
    const draft: SmsDraft = {
      channel:    'sms',
      recipients: input.recipients.map(r => r.trim()),
      body:       input.body.trim(),
      toneLevel:  input.toneLevel,
    };
    return { ok: true, draft };
  }

  // email
  const draft: EmailDraft = {
    channel:    'email',
    recipients: input.recipients.map(r => r.trim()),
    subject:    input.subject!.trim(),
    body:       input.body.trim(),
    toneLevel:  input.toneLevel,
  };
  if (input.replyTo !== undefined) draft.replyTo = input.replyTo.trim();
  return { ok: true, draft };
}
