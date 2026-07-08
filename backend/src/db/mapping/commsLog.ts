// ============================================================
// OTM — comms_log Row/Domain Mapper (Schema v1.1)
// CJS module. Explicit field-by-field mapping — no reflection
// (explicit-typed-contract). Row = exact DB shape per
// migrations/001_phase4_comms.sql (snake_case, 0/1 ints, JSON
// TEXT); Domain = app shape (camelCase, booleans, parsed JSON).
// DB-nullable columns are `T | null` in both shapes — never
// optional-omit. Callers cast reads (client.get<CommsLogRow>);
// runtime validation covers only what SQLite cannot enforce
// (JSON-TEXT parse + shape). Mapping failures return typed
// results — never throw. Pure functions, no logging.
// ============================================================

import {
  Bool01,
  CommsChannel,
  CommsDirection,
  CommsProvider,
  DeliveryState,
  FallbackLeg,
  IdempotencyProvenance,
  TimeSensitivity,
  TriageLabel,
  UserAction,
} from '../schemaConstants';
import {
  MapResult,
  boolFromDb,
  boolToDb,
  jsonToDb,
  stringArrayFromDb,
  timestampFromDb,
  timestampToDb,
} from './serializers';

export interface CommsLogRow {
  id: string;
  created_at: string;
  provider: CommsProvider;
  channel: CommsChannel;
  direction: CommsDirection;
  provider_message_id: string | null;
  idempotency_provenance: IdempotencyProvenance;
  content_hash: string;
  thread_key: string;
  from_identifier: string;
  to_identifiers: string; // JSON-in-TEXT: string[]
  subject: string | null;
  body: string;
  provider_timestamp: string;
  contact_id: string | null;
  topic_tag: string | null;
  triage_label: TriageLabel;
  time_sensitivity_flag: TimeSensitivity;
  delivery_state: DeliveryState | null;
  delivery_detail: string | null;
  fallback_leg_used: FallbackLeg | null;
  is_synced: Bool01;
  user_acknowledged_at: string | null;
  user_action_taken: UserAction | null;
}

export interface CommsLogDomain {
  id: string;
  createdAt: string;
  provider: CommsProvider;
  channel: CommsChannel;
  direction: CommsDirection;
  providerMessageId: string | null;
  idempotencyProvenance: IdempotencyProvenance;
  contentHash: string;
  threadKey: string;
  fromIdentifier: string;
  toIdentifiers: string[];
  subject: string | null;
  body: string;
  providerTimestamp: string;
  contactId: string | null;
  topicTag: string | null;
  triageLabel: TriageLabel;
  timeSensitivityFlag: TimeSensitivity;
  deliveryState: DeliveryState | null;
  deliveryDetail: string | null;
  fallbackLegUsed: FallbackLeg | null;
  isSynced: boolean;
  userAcknowledgedAt: string | null;
  userActionTaken: UserAction | null;
}

export function commsLogFromDb(row: CommsLogRow): MapResult<CommsLogDomain> {
  const toIdentifiers = stringArrayFromDb(row.to_identifiers, 'comms_log.to_identifiers');
  if (!toIdentifiers.ok) return toIdentifiers;
  return {
    ok: true,
    value: {
      id: row.id,
      createdAt: timestampFromDb(row.created_at),
      provider: row.provider,
      channel: row.channel,
      direction: row.direction,
      providerMessageId: row.provider_message_id,
      idempotencyProvenance: row.idempotency_provenance,
      contentHash: row.content_hash,
      threadKey: row.thread_key,
      fromIdentifier: row.from_identifier,
      toIdentifiers: toIdentifiers.value,
      subject: row.subject,
      body: row.body,
      providerTimestamp: timestampFromDb(row.provider_timestamp),
      contactId: row.contact_id,
      topicTag: row.topic_tag,
      triageLabel: row.triage_label,
      timeSensitivityFlag: row.time_sensitivity_flag,
      deliveryState: row.delivery_state,
      deliveryDetail: row.delivery_detail,
      fallbackLegUsed: row.fallback_leg_used,
      isSynced: boolFromDb(row.is_synced),
      userAcknowledgedAt:
        row.user_acknowledged_at === null ? null : timestampFromDb(row.user_acknowledged_at),
      userActionTaken: row.user_action_taken,
    },
  };
}

export function commsLogToDb(domain: CommsLogDomain): CommsLogRow {
  return {
    id: domain.id,
    created_at: timestampToDb(domain.createdAt),
    provider: domain.provider,
    channel: domain.channel,
    direction: domain.direction,
    provider_message_id: domain.providerMessageId,
    idempotency_provenance: domain.idempotencyProvenance,
    content_hash: domain.contentHash,
    thread_key: domain.threadKey,
    from_identifier: domain.fromIdentifier,
    to_identifiers: jsonToDb(domain.toIdentifiers),
    subject: domain.subject,
    body: domain.body,
    provider_timestamp: timestampToDb(domain.providerTimestamp),
    contact_id: domain.contactId,
    topic_tag: domain.topicTag,
    triage_label: domain.triageLabel,
    time_sensitivity_flag: domain.timeSensitivityFlag,
    delivery_state: domain.deliveryState,
    delivery_detail: domain.deliveryDetail,
    fallback_leg_used: domain.fallbackLegUsed,
    is_synced: boolToDb(domain.isSynced),
    user_acknowledged_at:
      domain.userAcknowledgedAt === null ? null : timestampToDb(domain.userAcknowledgedAt),
    user_action_taken: domain.userActionTaken,
  };
}
