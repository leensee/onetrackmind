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
// Kept as runtime defense-in-depth at the JSON boundary even though the
// discriminated-union type encodes most of these invariants for TS callers —
// model-originated tool input is typed but never runtime-checked upstream.
export function validateCommsDraftInput(input: CommsDraftInput): string | null {
  // Runtime shape guard: input must be a non-null object. Without this check a
  // bare null/primitive value from malformed JSON would throw on property access.
  if (typeof (input as unknown) !== 'object' || (input as unknown) === null) {
    return 'input must be a non-null object';
  }

  // Widened to string: the union narrows `channel` to 'sms' | 'email', so a
  // literal comparison below would otherwise trip TS2367 at runtime-guard sites.
  const channel: string = input.channel;
  if (channel !== 'sms' && channel !== 'email') {
    return `channel must be 'sms' or 'email'; got: ${channel}`;
  }
  const recipientsError = validateRecipients(input.recipients);
  if (recipientsError) return recipientsError;

  // Widen to unknown before typeof: the fields are typed `string` by the union
  // but can arrive as any JSON value at the model/API boundary. Calling .trim()
  // on a non-string would throw, violating the "Never throws" contract.
  const body: unknown = input.body;
  if (typeof body !== 'string' || body.trim() === '') {
    return 'body must be a non-empty string';
  }
  const toneError = validateToneLevel(input.toneLevel);
  if (toneError) return toneError;

  if (input.channel === 'email') {
    const subject: unknown = input.subject;
    if (typeof subject !== 'string' || subject.trim() === '') {
      return 'subject must be a non-empty string for email channel';
    }
    const replyTo: unknown = input.replyTo;
    if (replyTo !== undefined && (typeof replyTo !== 'string' || replyTo.trim() === '')) {
      return 'replyTo must not be empty string when provided';
    }
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

  // email — `input` is narrowed to EmailDraftInput here, so `subject` is a
  // guaranteed string (no `!` assertion needed).
  const draft: EmailDraft = {
    channel:    'email',
    recipients: input.recipients.map(r => r.trim()),
    subject:    input.subject.trim(),
    body:       input.body.trim(),
    toneLevel:  input.toneLevel,
  };
  if (input.replyTo !== undefined) draft.replyTo = input.replyTo.trim();
  return { ok: true, draft };
}
