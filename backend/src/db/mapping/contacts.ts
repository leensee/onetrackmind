// ============================================================
// OTM — contacts Row/Domain Mapper (Schema v1.1)
// CJS module. Explicit field-by-field mapping — no reflection.
// All 10 columns are NOT NULL. Three JSON-in-TEXT columns;
// identifiers carries the two DAL-enforced constraints
// (CT-DAL-IDENTIFIERS-JSON / CT-DAL-IDENTIFIERS-SHAPE) whose
// pinned rejection messages propagate from parseContactIdentifiers.
// Mapping failures return typed results — never throw. Pure
// functions, no logging.
// ============================================================

import { Bool01, ContactStatus } from '../schemaConstants';
import { ContactIdentifier, parseContactIdentifiers } from './dalConstraints';
import {
  MapResult,
  boolFromDb,
  boolToDb,
  jsonObjectFromDb,
  jsonToDb,
  stringArrayFromDb,
  timestampFromDb,
  timestampToDb,
} from './serializers';

export interface ContactRow {
  id: string;
  created_at: string;
  display_name: string;
  channels: string; // JSON-in-TEXT: string[]
  identifiers: string; // JSON-in-TEXT: ContactIdentifier[]
  tone_level: number;
  status: ContactStatus;
  is_internal_channel: Bool01;
  recognition_metadata: string; // JSON-in-TEXT: object
  is_synced: Bool01;
}

export interface ContactDomain {
  id: string;
  createdAt: string;
  displayName: string;
  channels: string[];
  identifiers: ContactIdentifier[];
  toneLevel: number;
  status: ContactStatus;
  isInternalChannel: boolean;
  recognitionMetadata: Record<string, unknown>;
  isSynced: boolean;
}

export function contactsFromDb(row: ContactRow): MapResult<ContactDomain> {
  const channels = stringArrayFromDb(row.channels, 'contacts.channels');
  if (!channels.ok) return channels;
  const identifiers = parseContactIdentifiers(row.identifiers);
  if (!identifiers.ok) return identifiers;
  const recognitionMetadata = jsonObjectFromDb(row.recognition_metadata, 'contacts.recognition_metadata');
  if (!recognitionMetadata.ok) return recognitionMetadata;
  return {
    ok: true,
    value: {
      id: row.id,
      createdAt: timestampFromDb(row.created_at),
      displayName: row.display_name,
      channels: channels.value,
      identifiers: identifiers.value,
      toneLevel: row.tone_level,
      status: row.status,
      isInternalChannel: boolFromDb(row.is_internal_channel),
      recognitionMetadata: recognitionMetadata.value,
      isSynced: boolFromDb(row.is_synced),
    },
  };
}

export function contactsToDb(domain: ContactDomain): ContactRow {
  return {
    id: domain.id,
    created_at: timestampToDb(domain.createdAt),
    display_name: domain.displayName,
    channels: jsonToDb(domain.channels),
    identifiers: jsonToDb(domain.identifiers),
    tone_level: domain.toneLevel,
    status: domain.status,
    is_internal_channel: boolToDb(domain.isInternalChannel),
    recognition_metadata: jsonToDb(domain.recognitionMetadata),
    is_synced: boolToDb(domain.isSynced),
  };
}
