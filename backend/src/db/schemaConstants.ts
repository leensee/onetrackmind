// ============================================================
// OTM — Phase 4 Comms Schema Vocabulary (Schema v1.1)
// CJS module. Canonical vocabulary for the Phase 4 communications
// schema: table names, enum value lists, and device ownership maps,
// plus the derived union aliases the DAL Row/Domain types use.
//
// Promoted from tests/fixtures/constraints.ts (which now re-exports
// from here): src cannot import from tests (tsconfig rootDir ./src),
// so the shared vocabulary lives in src and the tests-side coverage
// ledger builds on top of it. Values are verbatim from the corpus.
//
// Source of truth: Notion "OTM Phase 4 Communications Schema" +
// migrations/001_phase4_comms.sql +
// docs/handoffs/OTM_Phase4.1_Fixtures_ClaudeCode_Handoff.md.
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

// ── Enum value lists (shared with the fixtures ledger/meta-test) ──
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

// ── Derived union aliases (the DAL Row/Domain types' vocabulary) ──
export type CommsProvider = (typeof CL_PROVIDERS)[number];
export type CommsChannel = (typeof CL_CHANNELS)[number];
export type CommsDirection = (typeof CL_DIRECTIONS)[number];
export type IdempotencyProvenance = (typeof CL_PROVENANCE)[number];
export type TriageLabel = (typeof CL_TRIAGE)[number];
export type TimeSensitivity = (typeof CL_TIME_SENSITIVITY)[number];
export type DeliveryState = (typeof CL_DELIVERY_STATES)[number];
export type FallbackLeg = (typeof CL_FALLBACK_LEGS)[number];
export type UserAction = (typeof CL_USER_ACTIONS)[number];
export type ContactStatus = (typeof CT_STATUSES)[number];
export type IdempotencyKeyType = (typeof IK_KEY_TYPES)[number];
export type ThreadIdentifierType = (typeof TM_IDENTIFIER_TYPES)[number];
export type PollingProvider = (typeof PS_PROVIDERS)[number];
export type Bool01 = (typeof BOOL01)[number];

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

/** Resolve a device mirror to the backend table whose shape/constraints it inherits. */
export function mirrorBase(table: TableName): BackendTable {
  return (DEVICE_MIRRORS as Record<string, BackendTable>)[table] ?? (table as BackendTable);
}
