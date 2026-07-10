// ============================================================
// OTM Comms — Canonical Content Hash (Phase 4.1)
// CJS module. THE single definition of comms_log.content_hash /
// idempotency_keys content-hash key_value (compute-once contract:
// idempotencyChecker computes it at the gate; commsLogWriter (4.2)
// must REUSE the gate's value or this function — never re-derive
// with different rules, or dedup and stored hashes diverge).
//
// Canonicalization (pinned 2026-07-09, Section 2):
//   SHA-256 lowercase hex (64 chars) over the JSON serialization
//   of [fromIdentifier, sortedToIdentifiers, body].
//   - Recipients copy-then-sorted by code unit: hash is invariant
//     to recipient ORDER (a provider redelivery that reorders
//     recipients still dedupes) but not to MULTIPLICITY
//     (['a','a'] ≠ ['a']).
//   - Values verbatim — no trim, no case-fold (identifiers are
//     stored verbatim per schema; folding could merge distinct
//     identifiers).
//   - JSON escaping makes the serialization injective — no
//     delimiter-collision class ('a,b'+[] vs 'a'+['b']).
// Subject, provider, and channel are deliberately excluded:
// the hash is from+to+body per Schema v1.3, and cross-provider
// identical content must dedupe (CL-DAL-DEDUP-WINDOW).
// Pure function, no logging, no I/O beyond node:crypto.
// ============================================================

import { createHash } from 'crypto';

export interface ContentHashInput {
  fromIdentifier: string;
  toIdentifiers: readonly string[];
  body: string;
}

/** SHA-256 lowercase hex of JSON.stringify([from, [...to].sort(), body]). */
export function computeContentHash(input: ContentHashInput): string {
  const canonical = JSON.stringify([
    input.fromIdentifier,
    [...input.toIdentifiers].sort(),
    input.body,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
