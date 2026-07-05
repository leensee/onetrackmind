// ============================================================
// OTM — Fixture Constraint Catalog (Schema v1.1)
// CJS module. Consumed by manifest.ts and fixturesMeta.test.ts.
//
// Machine-readable coverage ledger for the Phase 4 communications
// schema (v1.1 = v1.0 + two additive CHECK families:
//   v1.1-A: CHECK (col IN (0,1)) on every INTEGER 0/1 column
//   v1.1-B: comms_log CHECK (idempotency_provenance =
//           'content_hash_fallback' OR provider_message_id IS NOT NULL)
// ).
// Source of truth: Notion "OTM Phase 4 Communications Schema" +
// docs/handoffs/OTM_Phase4.1_Fixtures_ClaudeCode_Handoff.md.
//
// Device mirror tables (device_comms_log, device_contacts) carry
// identical column/table CHECKs to their backend counterparts; the
// catalog records that via DEVICE_MIRRORS rather than duplicating
// entries. Ownership rules and the 10-minute content-hash dedup
// window are enforcedBy 'dal' (the DB cannot express them).
// ============================================================

export const SCHEMA_VERSION = '1.1';

export type BackendTable =
  | 'comms_log'
  | 'contacts'
  | 'idempotency_keys'
  | 'thread_mappings'
  | 'polling_state';

export type DeviceTable = 'device_comms_log' | 'device_contacts';

export type TableName = BackendTable | DeviceTable;

export type ConstraintKind =
  | 'check-enum'
  | 'check-range'
  | 'check-table'
  | 'check-bool01'
  | 'unique'
  | 'fk'
  | 'not-null'
  | 'ownership'
  | 'dedup-window';

export interface Constraint {
  id: string;
  table: TableName;
  kind: ConstraintKind;
  /** Column(s) the constraint binds. Empty for whole-row rules. */
  columns: string[];
  /** 'db' = expressible as SQLite DDL; 'dal' = documented expectation the future DAL enforces. */
  enforcedBy: 'db' | 'dal';
  /** Full value list for check-enum / check-bool01. */
  values?: readonly (string | number)[];
  /** Bounds for check-range (inclusive). */
  range?: { min: number; max: number };
  /** Target for fk constraints. */
  references?: { table: TableName; column: string };
  /** Partial-index condition for partial UNIQUEs (documentation). */
  partialWhere?: string;
  note?: string;
}

// ── Enum value lists (shared with manifest/meta-test) ──────────
export const CL_PROVIDERS = ['outlook', 'yahoo', 'twilio'] as const;
export const CL_CHANNELS = ['email', 'sms'] as const;
export const CL_DIRECTIONS = ['inbound', 'outbound'] as const;
export const CL_PROVENANCE = ['provider_id', 'content_hash_fallback'] as const;
export const CL_TRIAGE = [
  'action_required',
  'data_to_log',
  'awareness_only',
  'unknown_sender',
  'unclear_review',
] as const;
export const CL_TIME_SENSITIVITY = ['hard', 'soft', 'none'] as const;
export const CL_DELIVERY_STATES = ['queued', 'sent', 'delivered', 'failed', 'fallback_used'] as const;
export const CL_FALLBACK_LEGS = ['sms', 'fcm', 'email'] as const;
export const CL_USER_ACTIONS = [
  'requested_draft_reply',
  'marked_informational',
  'dismissed',
  'none',
] as const;
export const CT_STATUSES = ['active', 'dismissed', 'archived'] as const;
export const IK_KEY_TYPES = ['provider_id', 'content_hash'] as const;
export const TM_IDENTIFIER_TYPES = [
  'rfc5322_message_id',
  'provider_conversation_id',
  'phone_pair',
] as const;
export const PS_PROVIDERS = ['yahoo'] as const;
export const BOOL01 = [0, 1] as const;

// ── Helpers to keep NOT-NULL entries uniform ───────────────────
function nn(prefix: string, table: BackendTable, column: string): Constraint {
  return {
    id: `${prefix}-NN-${column.toUpperCase().replace(/_/g, '-')}`,
    table,
    kind: 'not-null',
    columns: [column],
    enforcedBy: 'db',
  };
}

export const CONSTRAINTS: readonly Constraint[] = [
  // ── comms_log ─────────────────────────────────────────────────
  { id: 'CL-CHK-PROVIDER', table: 'comms_log', kind: 'check-enum', columns: ['provider'], enforcedBy: 'db', values: CL_PROVIDERS },
  { id: 'CL-CHK-CHANNEL', table: 'comms_log', kind: 'check-enum', columns: ['channel'], enforcedBy: 'db', values: CL_CHANNELS },
  { id: 'CL-CHK-DIRECTION', table: 'comms_log', kind: 'check-enum', columns: ['direction'], enforcedBy: 'db', values: CL_DIRECTIONS },
  { id: 'CL-CHK-IDEMPOTENCY-PROVENANCE', table: 'comms_log', kind: 'check-enum', columns: ['idempotency_provenance'], enforcedBy: 'db', values: CL_PROVENANCE },
  { id: 'CL-CHK-TRIAGE-LABEL', table: 'comms_log', kind: 'check-enum', columns: ['triage_label'], enforcedBy: 'db', values: CL_TRIAGE },
  { id: 'CL-CHK-TIME-SENSITIVITY', table: 'comms_log', kind: 'check-enum', columns: ['time_sensitivity_flag'], enforcedBy: 'db', values: CL_TIME_SENSITIVITY },
  { id: 'CL-CHK-DELIVERY-STATE', table: 'comms_log', kind: 'check-enum', columns: ['delivery_state'], enforcedBy: 'db', values: CL_DELIVERY_STATES, note: 'Nullable; enum applies to non-null values.' },
  { id: 'CL-CHK-FALLBACK-LEG', table: 'comms_log', kind: 'check-enum', columns: ['fallback_leg_used'], enforcedBy: 'db', values: CL_FALLBACK_LEGS, note: 'Nullable; enum applies to non-null values.' },
  { id: 'CL-CHK-USER-ACTION', table: 'comms_log', kind: 'check-enum', columns: ['user_action_taken'], enforcedBy: 'db', values: CL_USER_ACTIONS, note: 'Nullable; enum applies to non-null values.' },
  {
    id: 'CL-CHK-DIRECTION-DELIVERY', table: 'comms_log', kind: 'check-table',
    columns: ['direction', 'delivery_state'], enforcedBy: 'db',
    note: "v1.0 table CHECK: (direction='inbound' AND delivery_state IS NULL) OR (direction='outbound' AND delivery_state IS NOT NULL).",
  },
  {
    id: 'CL-CHK-PROVENANCE-PROVIDER-MSG-ID', table: 'comms_log', kind: 'check-table',
    columns: ['idempotency_provenance', 'provider_message_id'], enforcedBy: 'db',
    note: "v1.1-B table CHECK: (idempotency_provenance='content_hash_fallback' OR provider_message_id IS NOT NULL).",
  },
  { id: 'CL-CHK-IS-SYNCED-01', table: 'comms_log', kind: 'check-bool01', columns: ['is_synced'], enforcedBy: 'db', values: BOOL01, note: 'v1.1-A.' },
  {
    id: 'CL-UQ-PROVIDER-MSG-ID', table: 'comms_log', kind: 'unique',
    columns: ['provider', 'provider_message_id'], enforcedBy: 'db',
    partialWhere: 'provider_message_id IS NOT NULL',
  },
  { id: 'CL-FK-CONTACT', table: 'comms_log', kind: 'fk', columns: ['contact_id'], enforcedBy: 'db', references: { table: 'contacts', column: 'id' } },
  nn('CL', 'comms_log', 'id'),
  nn('CL', 'comms_log', 'created_at'),
  nn('CL', 'comms_log', 'provider'),
  nn('CL', 'comms_log', 'channel'),
  nn('CL', 'comms_log', 'direction'),
  nn('CL', 'comms_log', 'idempotency_provenance'),
  nn('CL', 'comms_log', 'content_hash'),
  nn('CL', 'comms_log', 'thread_key'),
  nn('CL', 'comms_log', 'from_identifier'),
  nn('CL', 'comms_log', 'to_identifiers'),
  nn('CL', 'comms_log', 'body'),
  nn('CL', 'comms_log', 'provider_timestamp'),
  nn('CL', 'comms_log', 'triage_label'),
  nn('CL', 'comms_log', 'time_sensitivity_flag'),
  nn('CL', 'comms_log', 'is_synced'),
  {
    id: 'CL-DAL-DEDUP-WINDOW', table: 'comms_log', kind: 'dedup-window',
    columns: ['content_hash', 'created_at'], enforcedBy: 'dal',
    note: 'Identical content_hash within 10 minutes → second occurrence suppressed (no second comms_log row). Cross-provider identical content also dedupes to one row. DB cannot express this.',
  },

  // ── contacts ──────────────────────────────────────────────────
  { id: 'CT-CHK-STATUS', table: 'contacts', kind: 'check-enum', columns: ['status'], enforcedBy: 'db', values: CT_STATUSES },
  { id: 'CT-CHK-TONE-RANGE', table: 'contacts', kind: 'check-range', columns: ['tone_level'], enforcedBy: 'db', range: { min: 0, max: 10 } },
  { id: 'CT-CHK-IS-INTERNAL-01', table: 'contacts', kind: 'check-bool01', columns: ['is_internal_channel'], enforcedBy: 'db', values: BOOL01, note: 'v1.1-A.' },
  { id: 'CT-CHK-IS-SYNCED-01', table: 'contacts', kind: 'check-bool01', columns: ['is_synced'], enforcedBy: 'db', values: BOOL01, note: 'v1.1-A.' },
  nn('CT', 'contacts', 'id'),
  nn('CT', 'contacts', 'created_at'),
  nn('CT', 'contacts', 'display_name'),
  nn('CT', 'contacts', 'channels'),
  nn('CT', 'contacts', 'identifiers'),
  nn('CT', 'contacts', 'tone_level'),
  nn('CT', 'contacts', 'status'),
  nn('CT', 'contacts', 'is_internal_channel'),
  nn('CT', 'contacts', 'recognition_metadata'),
  nn('CT', 'contacts', 'is_synced'),
  {
    id: 'CT-DAL-IDENTIFIERS-JSON', table: 'contacts', kind: 'check-table',
    columns: ['identifiers'], enforcedBy: 'dal',
    note: 'identifiers must be parseable JSON. DB stores TEXT; the DAL rejects malformed JSON at the boundary.',
  },
  {
    id: 'CT-DAL-IDENTIFIERS-SHAPE', table: 'contacts', kind: 'check-table',
    columns: ['identifiers'], enforcedBy: 'dal',
    note: 'identifiers must be a JSON array of {channel, value} objects. Valid-JSON-wrong-shape is rejected by the DAL.',
  },

  // ── idempotency_keys ─────────────────────────────────────────
  { id: 'IK-CHK-KEY-TYPE', table: 'idempotency_keys', kind: 'check-enum', columns: ['key_type'], enforcedBy: 'db', values: IK_KEY_TYPES },
  { id: 'IK-CHK-PROVIDER', table: 'idempotency_keys', kind: 'check-enum', columns: ['provider'], enforcedBy: 'db', values: CL_PROVIDERS },
  { id: 'IK-CHK-IS-SYNCED-01', table: 'idempotency_keys', kind: 'check-bool01', columns: ['is_synced'], enforcedBy: 'db', values: BOOL01, note: 'v1.1-A.' },
  {
    id: 'IK-UQ-PROVIDER-KEY', table: 'idempotency_keys', kind: 'unique',
    columns: ['provider', 'key_value'], enforcedBy: 'db',
    partialWhere: "key_type='provider_id'",
  },
  { id: 'IK-FK-LINKED-MESSAGE', table: 'idempotency_keys', kind: 'fk', columns: ['linked_message_id'], enforcedBy: 'db', references: { table: 'comms_log', column: 'id' } },
  nn('IK', 'idempotency_keys', 'id'),
  nn('IK', 'idempotency_keys', 'key_type'),
  nn('IK', 'idempotency_keys', 'provider'),
  nn('IK', 'idempotency_keys', 'key_value'),
  nn('IK', 'idempotency_keys', 'first_seen_at'),
  nn('IK', 'idempotency_keys', 'expires_at'),
  nn('IK', 'idempotency_keys', 'is_synced'),
  {
    id: 'IK-DAL-EXPIRY-ARITHMETIC', table: 'idempotency_keys', kind: 'check-table',
    columns: ['key_type', 'first_seen_at', 'expires_at'], enforcedBy: 'dal',
    note: "expires_at = first_seen_at + 90d (key_type='provider_id') / + 24h (key_type='content_hash'). Valid fixtures must embody the exact arithmetic; the meta-test verifies it.",
  },

  // ── thread_mappings ──────────────────────────────────────────
  { id: 'TM-CHK-IDENTIFIER-TYPE', table: 'thread_mappings', kind: 'check-enum', columns: ['identifier_type'], enforcedBy: 'db', values: TM_IDENTIFIER_TYPES },
  { id: 'TM-CHK-PROVIDER', table: 'thread_mappings', kind: 'check-enum', columns: ['provider'], enforcedBy: 'db', values: CL_PROVIDERS },
  { id: 'TM-CHK-IS-SYNCED-01', table: 'thread_mappings', kind: 'check-bool01', columns: ['is_synced'], enforcedBy: 'db', values: BOOL01, note: 'v1.1-A.' },
  { id: 'TM-UQ-IDENTIFIER', table: 'thread_mappings', kind: 'unique', columns: ['identifier_type', 'identifier_value'], enforcedBy: 'db' },
  nn('TM', 'thread_mappings', 'id'),
  nn('TM', 'thread_mappings', 'identifier_type'),
  nn('TM', 'thread_mappings', 'identifier_value'),
  nn('TM', 'thread_mappings', 'provider'),
  nn('TM', 'thread_mappings', 'thread_key'),
  nn('TM', 'thread_mappings', 'created_at'),
  nn('TM', 'thread_mappings', 'is_synced'),

  // ── polling_state ────────────────────────────────────────────
  { id: 'PS-CHK-PROVIDER', table: 'polling_state', kind: 'check-enum', columns: ['provider'], enforcedBy: 'db', values: PS_PROVIDERS, note: 'yahoo only — polling table; push providers are rejected.' },
  { id: 'PS-CHK-IS-SYNCED-01', table: 'polling_state', kind: 'check-bool01', columns: ['is_synced'], enforcedBy: 'db', values: BOOL01, note: 'v1.1-A.' },
  { id: 'PS-UQ-PROVIDER-ACCOUNT-FOLDER', table: 'polling_state', kind: 'unique', columns: ['provider', 'account_identifier', 'folder'], enforcedBy: 'db' },
  nn('PS', 'polling_state', 'id'),
  nn('PS', 'polling_state', 'provider'),
  nn('PS', 'polling_state', 'account_identifier'),
  nn('PS', 'polling_state', 'folder'),
  nn('PS', 'polling_state', 'is_synced'),

  // ── device ownership (policy-class; future DAL enforces) ─────
  {
    id: 'DV-OWN-COMMS-BACKEND-FIELD', table: 'device_comms_log', kind: 'ownership',
    columns: ['user_acknowledged_at', 'user_action_taken'], enforcedBy: 'dal',
    note: 'Device may write ONLY user_acknowledged_at / user_action_taken on comms_log. Any other field in a device write payload is rejected.',
  },
  {
    id: 'DV-OWN-CONTACTS-READONLY', table: 'device_contacts', kind: 'ownership',
    columns: [], enforcedBy: 'dal',
    note: 'Device contacts is a read-only cache; the device may write nothing.',
  },
];

// ── Device mirrors: identical column/table CHECKs, not duplicated ──
export const DEVICE_MIRRORS: Record<DeviceTable, BackendTable> = {
  device_comms_log: 'comms_log',
  device_contacts: 'contacts',
};

/** Columns a device write payload may touch (besides the row id). */
export const DEVICE_WRITABLE_COLUMNS: Record<DeviceTable, string[]> = {
  device_comms_log: ['user_acknowledged_at', 'user_action_taken'],
  device_contacts: [],
};

// ── Table shapes (drive hydration + content scans in the meta-test) ──
export interface TableShape {
  columns: string[];
  /** JSON-in-TEXT columns: row holds a JSON string, domain holds the parsed value. */
  jsonColumns: string[];
  /** INTEGER 0/1 columns: row holds 0/1, domain holds true/false. */
  boolColumns: string[];
  notNullColumns: string[];
  /** Columns holding synthetic identifiers, subject to the PII allowlist. */
  identifierColumns: string[];
}

const COMMS_LOG_SHAPE: TableShape = {
  columns: [
    'id', 'created_at', 'provider', 'channel', 'direction',
    'provider_message_id', 'idempotency_provenance', 'content_hash',
    'thread_key', 'from_identifier', 'to_identifiers', 'subject', 'body',
    'provider_timestamp', 'contact_id', 'topic_tag', 'triage_label',
    'time_sensitivity_flag', 'delivery_state', 'delivery_detail',
    'fallback_leg_used', 'is_synced', 'user_acknowledged_at', 'user_action_taken',
  ],
  jsonColumns: ['to_identifiers'],
  boolColumns: ['is_synced'],
  notNullColumns: [
    'id', 'created_at', 'provider', 'channel', 'direction',
    'idempotency_provenance', 'content_hash', 'thread_key',
    'from_identifier', 'to_identifiers', 'body', 'provider_timestamp',
    'triage_label', 'time_sensitivity_flag', 'is_synced',
  ],
  identifierColumns: ['from_identifier', 'to_identifiers'],
};

const CONTACTS_SHAPE: TableShape = {
  columns: [
    'id', 'created_at', 'display_name', 'channels', 'identifiers',
    'tone_level', 'status', 'is_internal_channel', 'recognition_metadata', 'is_synced',
  ],
  jsonColumns: ['channels', 'identifiers', 'recognition_metadata'],
  boolColumns: ['is_internal_channel', 'is_synced'],
  notNullColumns: [
    'id', 'created_at', 'display_name', 'channels', 'identifiers',
    'tone_level', 'status', 'is_internal_channel', 'recognition_metadata', 'is_synced',
  ],
  identifierColumns: ['identifiers'],
};

export const TABLE_SHAPES: Record<TableName, TableShape> = {
  comms_log: COMMS_LOG_SHAPE,
  contacts: CONTACTS_SHAPE,
  idempotency_keys: {
    columns: ['id', 'key_type', 'provider', 'key_value', 'first_seen_at', 'expires_at', 'linked_message_id', 'is_synced'],
    jsonColumns: [],
    boolColumns: ['is_synced'],
    notNullColumns: ['id', 'key_type', 'provider', 'key_value', 'first_seen_at', 'expires_at', 'is_synced'],
    identifierColumns: [],
  },
  thread_mappings: {
    columns: ['id', 'identifier_type', 'identifier_value', 'provider', 'thread_key', 'created_at', 'is_synced'],
    jsonColumns: [],
    boolColumns: ['is_synced'],
    notNullColumns: ['id', 'identifier_type', 'identifier_value', 'provider', 'thread_key', 'created_at', 'is_synced'],
    identifierColumns: ['identifier_value'],
  },
  polling_state: {
    columns: ['id', 'provider', 'account_identifier', 'folder', 'cursor', 'last_polled_at', 'is_synced'],
    jsonColumns: ['cursor'],
    boolColumns: ['is_synced'],
    notNullColumns: ['id', 'provider', 'account_identifier', 'folder', 'is_synced'],
    identifierColumns: ['account_identifier'],
  },
  device_comms_log: COMMS_LOG_SHAPE,
  device_contacts: CONTACTS_SHAPE,
};

/** Resolve a device mirror to the backend table whose shape/constraints it inherits. */
export function mirrorBase(table: TableName): BackendTable {
  return (DEVICE_MIRRORS as Record<string, BackendTable>)[table] ?? (table as BackendTable);
}
