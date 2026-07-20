// ============================================================
// OTM Comms — commsLogWriter assembler (Phase 4.1) — PURE HALF
// CJS module. No I/O, no logging, no UUIDs, no clock reads —
// deterministic logic only, exported for isolated fixture tests
// (Standing Principle #3). The impure inserter lives in index.ts,
// which re-exports everything here.
//
// Persist-only sink (CLW-1, Decisions Log 2026-07-09): every
// domain value arrives fully assembled — including content_hash,
// which is the idempotency gate's value under the compute-once
// contract (src/comms/contentHash.ts). This module NEVER re-derives
// it (no computeContentHash import — dedup and stored hashes must
// not be able to diverge). No triage, no thread resolution, no
// validation: the six dalConstraints do not apply to this path;
// the comms_log CHECKs are the single enforcement site (CLW-3).
//
// Direction-discriminated input (CLW-2): delivery fields exist
// only on the outbound variant, so the "direction/delivery_state
// pairing" table CHECK is unconstructable-by-type — the DB CHECK
// stays as last-line guard. time_sensitivity_flag exists only on
// the inbound variant; the assembler stamps 'none' on every
// outbound row (F2 ruling 2026-07-13; Schema: outbound defaults
// 'none' — the flag is a triage output and outbound is never
// triaged).
//
// Timestamp format invariant: created_at (and the coalesced
// provider_timestamp fallback) is Date.prototype.toISOString()
// (ms-precision, 'Z') — the same uniform-ISO invariant documented
// in idempotencyChecker/pure.ts. Caller-supplied
// provider_timestamp passes through verbatim.
//
// Governing: Code Gen & Audit Doc v2.4; Phase 4 Comms Schema v1.5;
// Field-Ownership Matrix v1.0 §04; Standing Principles #3/#4/#5.
// ============================================================

import {
  CommsChannel,
  CommsProvider,
  DeliveryState,
  FallbackLeg,
  IdempotencyProvenance,
  TimeSensitivity,
  TriageLabel,
} from '../../db/schemaConstants';
import { CommsLogDomain } from '../../db/mapping/commsLog';

// ── Contract types ────────────────────────────────────────────

/**
 * Fields common to both directions. Everything here is assembled
 * upstream (gate/triage/thread resolution — 4.2's composition);
 * DB-nullable columns are explicit T | null, never optional-omit.
 */
export interface CommsLogWriteBase {
  provider: CommsProvider;
  providerMessageId: string | null;
  channel: CommsChannel;
  idempotencyProvenance: IdempotencyProvenance;
  /** The gate's hash, reused verbatim (compute-once contract). */
  contentHash: string;
  threadKey: string;
  fromIdentifier: string;
  toIdentifiers: string[];
  subject: string | null;
  body: string;
  /** null → assembler coalesces to created_at (corpus provider-timestamp-fallback). */
  providerTimestamp: string | null;
  contactId: string | null;
  topicTag: string | null;
  triageLabel: TriageLabel;
}

/** Inbound rows carry no delivery lifecycle (table CHECK, by type). */
export interface InboundCommsLogWrite extends CommsLogWriteBase {
  direction: 'inbound';
  timeSensitivityFlag: TimeSensitivity;
}

/** Outbound rows always carry a delivery lifecycle (table CHECK, by type). */
export interface OutboundCommsLogWrite extends CommsLogWriteBase {
  direction: 'outbound';
  deliveryState: DeliveryState;
  deliveryDetail: string | null;
  fallbackLegUsed: FallbackLeg | null;
}

export type CommsLogWriteInput = InboundCommsLogWrite | OutboundCommsLogWrite;

// ── Assembler ─────────────────────────────────────────────────

/**
 * Deterministic on (input, id, now): stamps the three writer-owned
 * fields (id, created_at, is_synced = false), coalesces
 * provider_timestamp ?? created_at, forces the direction-dependent
 * columns, and never writes user_acknowledged_at /
 * user_action_taken (device-owned; NULL until the device syncs
 * back). The row UUID and the clock are deliberately NOT read
 * here — both live at the impure boundary in index.ts.
 */
export function assembleCommsLogRecord(
  input: CommsLogWriteInput,
  id: string,
  now: Date,
): CommsLogDomain {
  const createdAt = now.toISOString();
  const base = {
    id,
    createdAt,
    provider: input.provider,
    channel: input.channel,
    providerMessageId: input.providerMessageId,
    idempotencyProvenance: input.idempotencyProvenance,
    contentHash: input.contentHash,
    threadKey: input.threadKey,
    fromIdentifier: input.fromIdentifier,
    toIdentifiers: input.toIdentifiers,
    subject: input.subject,
    body: input.body,
    providerTimestamp: input.providerTimestamp ?? createdAt,
    contactId: input.contactId,
    topicTag: input.topicTag,
    triageLabel: input.triageLabel,
    isSynced: false,
    userAcknowledgedAt: null,
    userActionTaken: null,
  };

  switch (input.direction) {
    case 'inbound':
      return {
        ...base,
        direction: 'inbound',
        timeSensitivityFlag: input.timeSensitivityFlag,
        deliveryState: null,
        deliveryDetail: null,
        fallbackLegUsed: null,
      };
    case 'outbound':
      return {
        ...base,
        direction: 'outbound',
        timeSensitivityFlag: 'none',
        deliveryState: input.deliveryState,
        deliveryDetail: input.deliveryDetail,
        fallbackLegUsed: input.fallbackLegUsed,
      };
    default: {
      const impossible: never = input;
      throw new Error(
        `assembleCommsLogRecord: malformed input direction ${String(
          (impossible as { direction?: unknown }).direction,
        )}`,
      );
    }
  }
}
