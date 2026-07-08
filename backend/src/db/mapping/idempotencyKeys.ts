// ============================================================
// OTM — idempotency_keys Row/Domain Mapper (Schema v1.1)
// CJS module. Explicit field-by-field mapping — no reflection.
// No JSON-in-TEXT columns, so fromDb cannot fail; it still
// returns MapResult for a uniform signature across tables.
// The expiry arithmetic (IK-DAL-EXPIRY-ARITHMETIC) is validated
// separately by dalConstraints.checkIdempotencyExpiry — a write-
// path rule, not a mapping rule. Pure functions, no logging.
// ============================================================

import { Bool01, CommsProvider, IdempotencyKeyType } from '../schemaConstants';
import {
  MapResult,
  boolFromDb,
  boolToDb,
  timestampFromDb,
  timestampToDb,
} from './serializers';

export interface IdempotencyKeyRow {
  id: string;
  key_type: IdempotencyKeyType;
  provider: CommsProvider;
  key_value: string;
  first_seen_at: string;
  expires_at: string;
  linked_message_id: string | null;
  is_synced: Bool01;
}

export interface IdempotencyKeyDomain {
  id: string;
  keyType: IdempotencyKeyType;
  provider: CommsProvider;
  keyValue: string;
  firstSeenAt: string;
  expiresAt: string;
  linkedMessageId: string | null;
  isSynced: boolean;
}

export function idempotencyKeysFromDb(row: IdempotencyKeyRow): MapResult<IdempotencyKeyDomain> {
  return {
    ok: true,
    value: {
      id: row.id,
      keyType: row.key_type,
      provider: row.provider,
      keyValue: row.key_value,
      firstSeenAt: timestampFromDb(row.first_seen_at),
      expiresAt: timestampFromDb(row.expires_at),
      linkedMessageId: row.linked_message_id,
      isSynced: boolFromDb(row.is_synced),
    },
  };
}

export function idempotencyKeysToDb(domain: IdempotencyKeyDomain): IdempotencyKeyRow {
  return {
    id: domain.id,
    key_type: domain.keyType,
    provider: domain.provider,
    key_value: domain.keyValue,
    first_seen_at: timestampToDb(domain.firstSeenAt),
    expires_at: timestampToDb(domain.expiresAt),
    linked_message_id: domain.linkedMessageId,
    is_synced: boolToDb(domain.isSynced),
  };
}
