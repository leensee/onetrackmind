// ============================================================
// OTM — DAL-Enforced Constraints (Schema v1.1)
// CJS module. Pure decision/validation functions for the six
// constraints the corpus catalog marks enforcedBy 'dal' (the DB
// cannot express them):
//   CL-DAL-DEDUP-WINDOW, CT-DAL-IDENTIFIERS-JSON,
//   CT-DAL-IDENTIFIERS-SHAPE, IK-DAL-EXPIRY-ARITHMETIC,
//   DV-OWN-COMMS-BACKEND-FIELD, DV-OWN-CONTACTS-READONLY.
// Rejection detail strings are pinned to the fixture manifest's
// expectedError values — tests assert exact equality.
// House error rule: operational failures return typed results —
// never throw; throws only on precondition violations (caller
// bugs). Pure functions, no logging, no I/O — repositories call
// these from the read/write paths in Phase 4.2+.
// ============================================================

import { DeviceTable, DEVICE_WRITABLE_COLUMNS, IdempotencyKeyType } from '../schemaConstants';
import { MapResult } from './serializers';

// ── CL-DAL-DEDUP-WINDOW ─────────────────────────────────────────

export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

export interface DedupCandidate {
  contentHash: string;
  /** ISO-8601 UTC. */
  createdAt: string;
}

export type DedupDecision =
  | { action: 'store' }
  | { action: 'suppress'; duplicateOf: DedupCandidate };

/**
 * Identical content_hash within 10 minutes → the incoming occurrence
 * is suppressed (no second comms_log row). Cross-provider identical
 * content dedupes too — hence no provider field in the signature.
 * Boundary pinned INCLUSIVE: Δ = exactly DEDUP_WINDOW_MS suppresses
 * ("within 10 minutes"; the corpus constrains 4min → suppress and
 * 11min → store, leaving the boundary to this contract).
 * Throws on unparseable timestamps (precondition violation: inputs
 * arrive through the typed fromDb boundary).
 */
export function decideDedup(
  incoming: DedupCandidate,
  existing: readonly DedupCandidate[],
): DedupDecision {
  const incomingMs = parseTimestampMsOrThrow(incoming.createdAt, 'incoming.createdAt');
  for (const candidate of existing) {
    if (candidate.contentHash !== incoming.contentHash) continue;
    const deltaMs = incomingMs - parseTimestampMsOrThrow(candidate.createdAt, 'existing.createdAt');
    if (deltaMs >= 0 && deltaMs <= DEDUP_WINDOW_MS) {
      return { action: 'suppress', duplicateOf: candidate };
    }
  }
  return { action: 'store' };
}

function parseTimestampMsOrThrow(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`decideDedup precondition: ${label} is not a parseable timestamp: ${value}`);
  }
  return ms;
}

// ── CT-DAL-IDENTIFIERS-JSON / CT-DAL-IDENTIFIERS-SHAPE ─────────

export interface ContactIdentifier {
  channel: string;
  value: string;
}

export const CT_IDENTIFIERS_JSON_MSG = 'DAL rejection: contacts.identifiers is not valid JSON';
export const CT_IDENTIFIERS_SHAPE_MSG =
  'DAL rejection: contacts.identifiers must be an array of {channel,value}';

/**
 * contacts.identifiers must be parseable JSON holding an array of
 * {channel, value} objects (extra keys tolerated, matching the
 * meta-test's checker). Returns the ORIGINAL parsed items so extra
 * keys and key order survive the round-trip back to canonical JSON.
 */
export function parseContactIdentifiers(text: string): MapResult<ContactIdentifier[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed_json', detail: CT_IDENTIFIERS_JSON_MSG };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'wrong_shape', detail: CT_IDENTIFIERS_SHAPE_MSG };
  }
  for (const item of parsed) {
    if (
      typeof item !== 'object' || item === null || Array.isArray(item) ||
      typeof (item as Record<string, unknown>).channel !== 'string' ||
      typeof (item as Record<string, unknown>).value !== 'string'
    ) {
      return { ok: false, reason: 'wrong_shape', detail: CT_IDENTIFIERS_SHAPE_MSG };
    }
  }
  return { ok: true, value: parsed as ContactIdentifier[] };
}

// ── IK-DAL-EXPIRY-ARITHMETIC ────────────────────────────────────

export const PROVIDER_ID_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const CONTENT_HASH_KEY_TTL_MS = 24 * 60 * 60 * 1000;

export type ExpiryCheckResult =
  | { ok: true }
  | { ok: false; reason: 'expiry_mismatch' | 'unparseable_timestamp'; detail: string };

/**
 * expires_at = first_seen_at + 90d (key_type='provider_id') / + 24h
 * (key_type='content_hash'), exact millisecond equality.
 */
export function checkIdempotencyExpiry(key: {
  keyType: IdempotencyKeyType;
  firstSeenAt: string;
  expiresAt: string;
}): ExpiryCheckResult {
  const firstSeenMs = Date.parse(key.firstSeenAt);
  const expiresMs = Date.parse(key.expiresAt);
  if (Number.isNaN(firstSeenMs) || Number.isNaN(expiresMs)) {
    return {
      ok: false,
      reason: 'unparseable_timestamp',
      detail: `idempotency_keys: unparseable timestamp (first_seen_at=${key.firstSeenAt}, expires_at=${key.expiresAt})`,
    };
  }
  const ttlMs = key.keyType === 'provider_id' ? PROVIDER_ID_KEY_TTL_MS : CONTENT_HASH_KEY_TTL_MS;
  const ttlLabel = key.keyType === 'provider_id' ? '90d' : '24h';
  const expectedMs = firstSeenMs + ttlMs;
  if (expiresMs !== expectedMs) {
    return {
      ok: false,
      reason: 'expiry_mismatch',
      detail: `idempotency_keys: expires_at must be first_seen_at + ${ttlLabel} exactly (expected ${new Date(expectedMs).toISOString()}, got ${key.expiresAt})`,
    };
  }
  return { ok: true };
}

// ── DV-OWN-COMMS-BACKEND-FIELD / DV-OWN-CONTACTS-READONLY ──────

export const DV_COMMS_OWNERSHIP_MSG =
  'DAL ownership rejection: device may write only user_acknowledged_at / user_action_taken on comms_log';
export const DV_CONTACTS_READONLY_MSG =
  'DAL ownership rejection: device_contacts is a read-only cache';

export type DeviceWriteResult =
  | { ok: true }
  | { ok: false; reason: 'ownership_violation'; detail: string };

/**
 * Validate a device write payload — snake_case column keys, partial
 * (not a full row; a different input class from the typed mappers).
 * device_contacts is a read-only cache: every payload is rejected,
 * even {id} alone ("device may write nothing"). device_comms_log
 * payloads may touch only the row id plus DEVICE_WRITABLE_COLUMNS.
 */
export function validateDeviceWrite(
  table: DeviceTable,
  payload: Record<string, unknown>,
): DeviceWriteResult {
  if (table === 'device_contacts') {
    return { ok: false, reason: 'ownership_violation', detail: DV_CONTACTS_READONLY_MSG };
  }
  const writable = DEVICE_WRITABLE_COLUMNS[table];
  for (const key of Object.keys(payload)) {
    if (key !== 'id' && !writable.includes(key)) {
      return { ok: false, reason: 'ownership_violation', detail: DV_COMMS_OWNERSHIP_MSG };
    }
  }
  return { ok: true };
}
