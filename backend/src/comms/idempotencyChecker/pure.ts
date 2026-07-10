// ============================================================
// OTM Comms — idempotencyChecker planner (Phase 4.1) — PURE HALF
// CJS module. No I/O, no logging, no UUIDs, no clock reads —
// deterministic logic only, exported for isolated fixture tests
// (Standing Principle #3). The impure executor lives in index.ts,
// which re-exports everything here.
//
// Provenance-branched dedup (Decisions Log 2026-07-09):
//   providerMessageId present → atomic provider-id INSERT…ON
//   CONFLICT is the SOLE gate (provenance 'provider_id', TTL +90d).
//   Absent → windowed content-hash SELECT (first_seen_at >=
//   now − 10min, INCLUSIVE) is the SOLE gate (provenance
//   'content_hash_fallback', TTL +24h). No content-hash rejection
//   on the provider-id path; content_hash is ALWAYS computed and
//   surfaced for downstream reuse (compute-once contract).
//
// Timestamp format invariant: every timestamp this module writes
// is Date.prototype.toISOString() (ms-precision, 'Z'). The
// executor's windowed SQL compares first_seen_at LEXICOGRAPHICALLY,
// which is correct only while formats are uniform — and they are,
// because this module is the single writer of idempotency_keys
// (Decisions Log 2026-07-09). Corpus-style second-precision
// '…:00Z' sorts AFTER '…:00.000Z' for the same instant — never
// hand-write timestamps into this table.
//
// Governing: Code Gen & Audit Doc v2.4; Phase 4 Comms Schema v1.3;
// Architectural Standing Principles #3/#4/#5.
// ============================================================

import { CommsProvider, IdempotencyKeyType, IdempotencyProvenance } from '../../db/schemaConstants';
import {
  CONTENT_HASH_KEY_TTL_MS,
  DEDUP_WINDOW_MS,
  PROVIDER_ID_KEY_TTL_MS,
} from '../../db/mapping/dalConstraints';
import { computeContentHash } from '../contentHash';

// ── Contract types ────────────────────────────────────────────

/** Narrow dedup-only input — a projection of InboundEmail | InboundSms. */
export interface IdempotencyInput {
  provider: CommsProvider;
  /** Explicit T | null (DB-nullable), never optional-omit. */
  providerMessageId: string | null;
  fromIdentifier: string;
  toIdentifiers: string[];
  body: string;
}

/**
 * Why the fallback path was taken. 'empty_provider_message_id'
 * marks a provider that supplied '' — treated as absent (an empty
 * string is not a trustworthy uniqueness key; degradation, not
 * data loss). The executor owns the corresponding logger.warn.
 */
export type FallbackDegradation = 'no_provider_message_id' | 'empty_provider_message_id';

interface PlanBase {
  provider: CommsProvider;
  /** Always computed, both arms — surfaced for downstream reuse. */
  contentHash: string;
  /** now.toISOString() — ms-precision ISO-8601 UTC. */
  firstSeenAt: string;
  /** firstSeenAt + 90d (provider_id) / + 24h (content_hash). */
  expiresAt: string;
  keyType: IdempotencyKeyType;
  keyValue: string;
}

export type IdempotencyPlan =
  | (PlanBase & {
      provenance: 'provider_id';
    })
  | (PlanBase & {
      provenance: 'content_hash_fallback';
      /** firstSeenAt − DEDUP_WINDOW_MS; inclusive lower window bound. */
      windowStartAt: string;
      degradation: FallbackDegradation;
    });

export type IdempotencyResult =
  | { status: 'novel'; provenance: IdempotencyProvenance; contentHash: string; keyId: string }
  | {
      status: 'duplicate';
      provenance: IdempotencyProvenance;
      contentHash: string;
      matchedKeyId: string;
      linkedMessageId: string | null;
    }
  | { status: 'error'; provenance: IdempotencyProvenance; contentHash: string; reason: string };

// ── Planner ───────────────────────────────────────────────────

/**
 * Pure gate plan: computes the canonical content hash once, derives
 * provenance/key_type from providerMessageId presence, and sets
 * firstSeenAt/expiresAt (and the fallback arm's window start) from
 * the injected now. The row UUID is deliberately NOT planned here —
 * randomUUID() is the executor's only nondeterminism, kept with the
 * write.
 */
export function planIdempotencyCheck(input: IdempotencyInput, now: Date): IdempotencyPlan {
  const contentHash = computeContentHash(input);
  const firstSeenAt = now.toISOString();

  if (input.providerMessageId !== null && input.providerMessageId !== '') {
    return {
      provenance: 'provider_id',
      provider: input.provider,
      contentHash,
      firstSeenAt,
      expiresAt: new Date(now.getTime() + PROVIDER_ID_KEY_TTL_MS).toISOString(),
      keyType: 'provider_id',
      keyValue: input.providerMessageId,
    };
  }

  return {
    provenance: 'content_hash_fallback',
    provider: input.provider,
    contentHash,
    firstSeenAt,
    expiresAt: new Date(now.getTime() + CONTENT_HASH_KEY_TTL_MS).toISOString(),
    keyType: 'content_hash',
    keyValue: contentHash,
    windowStartAt: new Date(now.getTime() - DEDUP_WINDOW_MS).toISOString(),
    degradation:
      input.providerMessageId === '' ? 'empty_provider_message_id' : 'no_provider_message_id',
  };
}
