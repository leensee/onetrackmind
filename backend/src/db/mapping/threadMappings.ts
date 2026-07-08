// ============================================================
// OTM — thread_mappings Row/Domain Mapper (Schema v1.1)
// CJS module. Explicit field-by-field mapping — no reflection.
// No JSON-in-TEXT columns, so fromDb cannot fail; it still
// returns MapResult for a uniform signature across tables.
// identifier_value stays an opaque string (pipe-joined phone
// pairs, angle-form RFC-5322 ids). Pure functions, no logging.
// ============================================================

import { Bool01, CommsProvider, ThreadIdentifierType } from '../schemaConstants';
import {
  MapResult,
  boolFromDb,
  boolToDb,
  timestampFromDb,
  timestampToDb,
} from './serializers';

export interface ThreadMappingRow {
  id: string;
  identifier_type: ThreadIdentifierType;
  identifier_value: string;
  provider: CommsProvider;
  thread_key: string;
  created_at: string;
  is_synced: Bool01;
}

export interface ThreadMappingDomain {
  id: string;
  identifierType: ThreadIdentifierType;
  identifierValue: string;
  provider: CommsProvider;
  threadKey: string;
  createdAt: string;
  isSynced: boolean;
}

export function threadMappingsFromDb(row: ThreadMappingRow): MapResult<ThreadMappingDomain> {
  return {
    ok: true,
    value: {
      id: row.id,
      identifierType: row.identifier_type,
      identifierValue: row.identifier_value,
      provider: row.provider,
      threadKey: row.thread_key,
      createdAt: timestampFromDb(row.created_at),
      isSynced: boolFromDb(row.is_synced),
    },
  };
}

export function threadMappingsToDb(domain: ThreadMappingDomain): ThreadMappingRow {
  return {
    id: domain.id,
    identifier_type: domain.identifierType,
    identifier_value: domain.identifierValue,
    provider: domain.provider,
    thread_key: domain.threadKey,
    created_at: timestampToDb(domain.createdAt),
    is_synced: boolToDb(domain.isSynced),
  };
}
