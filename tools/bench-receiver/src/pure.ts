// ============================================================
// Bench receiver — pure (deterministic) half.
// Validation, path derivation, and secret comparison. No I/O.
// Side effects live in index.ts (house pure/impure split).
// ============================================================

import { createHash, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';

// ── Contract types ────────────────────────────────────────────
// Mirrors the CommsResult shape (backend/src/comms/contracts.ts):
// discriminated, non-throwing. The receiver never imports from
// backend/ — the vocabulary is mirrored, not shared (§10 ruling:
// structural isolation).

export type BenchFailureReason =
  | 'auth_failed'
  | 'invalid_input'
  | 'storage_error';

export type BenchResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BenchFailureReason; detail: string; retryable: boolean };

export const SUBMISSION_SCHEMA = 'otm-bench-capture.v1';

/** Entry as submitted — the device's queue bookkeeping fields
 * (is_synced, attempt_count, ...) are deliberately absent. */
export interface SubmittedEntry {
  id: string;
  payload_kind: 'audio' | 'text';
  trigger_source: string;
  origin_timestamp: string;
  device_provenance: Record<string, unknown>;
  session_id: string;
  arm_label: string;
  utterance_id: string | null;
  audio_format: Record<string, unknown> | null;
  capture_metadata: Record<string, unknown>;
}

export type SubmittedPayload =
  | { kind: 'audio'; audioBase64: string; format: Record<string, unknown> | null }
  | { kind: 'text'; text: string };

export interface ParsedSubmission {
  entry: SubmittedEntry;
  payload: SubmittedPayload;
}

// ── Validation ────────────────────────────────────────────────
// All of this is untrusted input (authed LAN client, but still a
// network payload): identifiers used in filesystem paths must
// pass the safe-segment check — no separators, no dot-dot.

const SAFE_SEGMENT = /^[A-Za-z0-9._+-]{1,64}$/;

export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== '.' && value !== '..';
}

function invalid(detail: string): BenchResult<never> {
  return { ok: false, reason: 'invalid_input', detail, retryable: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(
  source: Record<string, unknown>,
  field: string,
): string | null {
  const value = source[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Validates a request body into a ParsedSubmission. Details name the
 * offending field but never echo submitted values (log-sanitization
 * discipline extends to response bodies). */
export function validateSubmission(body: unknown): BenchResult<ParsedSubmission> {
  const root = asRecord(body);
  if (!root) return invalid('body must be a JSON object');
  if (root['schema'] !== SUBMISSION_SCHEMA) {
    return invalid(`schema must be '${SUBMISSION_SCHEMA}'`);
  }

  const entryRaw = asRecord(root['entry']);
  if (!entryRaw) return invalid('entry must be an object');

  const id = requiredString(entryRaw, 'id');
  const payloadKind = requiredString(entryRaw, 'payload_kind');
  const triggerSource = requiredString(entryRaw, 'trigger_source');
  const originTimestamp = requiredString(entryRaw, 'origin_timestamp');
  const sessionId = requiredString(entryRaw, 'session_id');
  const armLabel = requiredString(entryRaw, 'arm_label');
  if (!id) return invalid('entry.id missing or empty');
  if (payloadKind !== 'audio' && payloadKind !== 'text') {
    return invalid("entry.payload_kind must be 'audio' or 'text'");
  }
  if (!triggerSource) return invalid('entry.trigger_source missing or empty');
  if (!originTimestamp) return invalid('entry.origin_timestamp missing or empty');
  if (!sessionId) return invalid('entry.session_id missing or empty');
  if (!armLabel) return invalid('entry.arm_label missing or empty');
  // Path-traversal defense: these three become filesystem path segments.
  if (!isSafeSegment(id)) return invalid('entry.id failed safe-segment check');
  if (!isSafeSegment(sessionId)) {
    return invalid('entry.session_id failed safe-segment check');
  }
  if (!isSafeSegment(armLabel)) {
    return invalid('entry.arm_label failed safe-segment check');
  }

  const captureMetadata = asRecord(entryRaw['capture_metadata']);
  if (!captureMetadata) return invalid('entry.capture_metadata must be an object');
  const deviceProvenance = asRecord(entryRaw['device_provenance']) ?? {};
  const utteranceId = entryRaw['utterance_id'];
  if (utteranceId !== null && utteranceId !== undefined && typeof utteranceId !== 'string') {
    return invalid('entry.utterance_id must be a string or null');
  }
  const audioFormat = asRecord(entryRaw['audio_format']);

  const payloadRaw = asRecord(root['payload']);
  if (!payloadRaw) return invalid('payload must be an object');
  // The submission contract is discriminated on the same axis as the
  // queue payload — the two discriminators must agree.
  if (payloadRaw['kind'] !== payloadKind) {
    return invalid('payload.kind must match entry.payload_kind');
  }

  let payload: SubmittedPayload;
  if (payloadKind === 'audio') {
    const audioBase64 = requiredString(payloadRaw, 'audioBase64');
    if (!audioBase64) return invalid('payload.audioBase64 missing or empty');
    payload = {
      kind: 'audio',
      audioBase64,
      format: asRecord(payloadRaw['format']),
    };
  } else {
    const text = payloadRaw['text'];
    if (typeof text !== 'string') return invalid('payload.text must be a string');
    payload = { kind: 'text', text };
  }

  return {
    ok: true,
    value: {
      entry: {
        id,
        payload_kind: payloadKind,
        trigger_source: triggerSource,
        origin_timestamp: originTimestamp,
        device_provenance: deviceProvenance,
        session_id: sessionId,
        arm_label: armLabel,
        utterance_id: typeof utteranceId === 'string' ? utteranceId : null,
        audio_format: audioFormat,
        capture_metadata: captureMetadata,
      },
      payload,
    },
  };
}

// ── Corpus layout ─────────────────────────────────────────────

export interface CorpusPaths {
  dir: string;
  dataPath: string; // <id>.wav for audio, <id>.txt for text
  jsonPath: string;
}

export function corpusPathsFor(corpusDir: string, entry: SubmittedEntry): CorpusPaths {
  const dir = path.join(corpusDir, entry.session_id, entry.arm_label);
  const extension = entry.payload_kind === 'audio' ? 'wav' : 'txt';
  return {
    dir,
    dataPath: path.join(dir, `${entry.id}.${extension}`),
    jsonPath: path.join(dir, `${entry.id}.json`),
  };
}

// ── Cloud-sync-root detection (§10 ruling condition) ──────────
// The corpus must never sit inside a synced tree. Verify, don't
// assume — the local tree was reorganized recently.

export function syncRootsFor(home: string): { name: string; root: string }[] {
  return [
    { name: 'iCloud Drive', root: path.join(home, 'Library', 'Mobile Documents') },
    { name: 'CloudStorage (Dropbox/OneDrive/Google Drive)', root: path.join(home, 'Library', 'CloudStorage') },
    { name: 'Dropbox (legacy location)', root: path.join(home, 'Dropbox') },
    { name: 'OneDrive (legacy location)', root: path.join(home, 'OneDrive') },
    { name: 'Google Drive (legacy location)', root: path.join(home, 'Google Drive') },
  ];
}

/** Returns the offending sync-root name, or null when the path is clean.
 * Boundary-aware: `~/Dropboxx` is not inside `~/Dropbox`. */
export function insideSyncRoot(resolvedPath: string, home: string): string | null {
  for (const { name, root } of syncRootsFor(home)) {
    if (resolvedPath === root || resolvedPath.startsWith(root + path.sep)) {
      return name;
    }
  }
  return null;
}

// ── Secret comparison ─────────────────────────────────────────
// Constant-time (policy §5.5 discipline applied to the bench
// secret): hash both sides to equal length, then timingSafeEqual.

export function secretMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
