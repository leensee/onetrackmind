// ============================================================
// OTM — polling_state Row/Domain Mapper (Schema v1.1)
// CJS module. Explicit field-by-field mapping — no reflection.
// cursor is the one nullable JSON-in-TEXT column in the schema:
// NULL passes through as null BEFORE any parsing (hydration rule
// 5 ordering); non-null must parse to a JSON object. Mapping
// failures return typed results — never throw. Pure functions,
// no logging.
// ============================================================

import { Bool01, PollingProvider } from '../schemaConstants';
import {
  MapResult,
  boolFromDb,
  boolToDb,
  jsonObjectFromDb,
  jsonToDb,
  timestampFromDb,
  timestampToDb,
} from './serializers';

export interface PollingStateRow {
  id: string;
  provider: PollingProvider;
  account_identifier: string;
  folder: string;
  cursor: string | null; // JSON-in-TEXT: object, nullable
  last_polled_at: string | null;
  is_synced: Bool01;
}

export interface PollingStateDomain {
  id: string;
  provider: PollingProvider;
  accountIdentifier: string;
  folder: string;
  cursor: Record<string, unknown> | null;
  lastPolledAt: string | null;
  isSynced: boolean;
}

export function pollingStateFromDb(row: PollingStateRow): MapResult<PollingStateDomain> {
  let cursor: Record<string, unknown> | null = null;
  if (row.cursor !== null) {
    const parsed = jsonObjectFromDb(row.cursor, 'polling_state.cursor');
    if (!parsed.ok) return parsed;
    cursor = parsed.value;
  }
  return {
    ok: true,
    value: {
      id: row.id,
      provider: row.provider,
      accountIdentifier: row.account_identifier,
      folder: row.folder,
      cursor,
      lastPolledAt: row.last_polled_at === null ? null : timestampFromDb(row.last_polled_at),
      isSynced: boolFromDb(row.is_synced),
    },
  };
}

export function pollingStateToDb(domain: PollingStateDomain): PollingStateRow {
  return {
    id: domain.id,
    provider: domain.provider,
    account_identifier: domain.accountIdentifier,
    folder: domain.folder,
    cursor: domain.cursor === null ? null : jsonToDb(domain.cursor),
    last_polled_at: domain.lastPolledAt === null ? null : timestampToDb(domain.lastPolledAt),
    is_synced: boolToDb(domain.isSynced),
  };
}
