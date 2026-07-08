// ============================================================
// OTM — Retention/Sync Fixture Factory (Schema v1.1)
// CJS module. Pure factory over a base comms_log row producing
// retention/sync variants; manifest.ts registers the output via
// variantOf. No I/O.
//
// All timestamps are ABSOLUTE (nothing is relative to "now" at
// test time). Reference date for the age arithmetic below:
//   RETENTION_REFERENCE_DATE = 2026-07-03T00:00:00Z
// Retention policy under test (DAL-enforced, documented here):
//   purge-eligible ⇔ (age > 90d AND is_synced = 1),
//   OR age > 180d (absolute ceiling, regardless of sync state).
// Ages at the reference date:
//   fresh   = 2026-06-20 (13d)   old = 2026-03-01 (124d)
//   ceiling = 2025-12-01 (214d, past the 180-day ceiling)
// ============================================================

export const RETENTION_REFERENCE_DATE = '2026-07-03T00:00:00Z';

// Canonical Row/Domain types were promoted to src (Phase 4.1 DAL);
// re-exported here so existing importers keep their surface.
import { CommsLogRow, CommsLogDomain } from '../../src/db/mapping/commsLog';

export type { CommsLogRow, CommsLogDomain };

export interface RetentionVariant {
  /** Manifest id suffix, e.g. 'retention-old-synced'. */
  slug: string;
  mechanism: string;
  purgeEligible: boolean;
  row: CommsLogRow;
  domain: CommsLogDomain;
}

/** Base row the variants derive from (inbound outlook email, already triaged). */
export const RETENTION_BASE_ROW: CommsLogRow = {
  id: 'fa0700fa-0700-4700-8700-fa0700fa0700',
  created_at: '2026-06-20T09:00:00Z',
  provider: 'outlook',
  channel: 'email',
  direction: 'inbound',
  provider_message_id: 'pm-outlook-retention-base',
  idempotency_provenance: 'provider_id',
  content_hash: 'a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7d8c9b0a1f2',
  thread_key: 'tk-retention-base',
  from_identifier: 'vendor.retention@example.com',
  to_identifiers: '["otm.owner@example.com"]',
  subject: 'Monthly service summary',
  body: 'Attached is the monthly service summary for the yard equipment.',
  provider_timestamp: '2026-06-20T09:00:00Z',
  contact_id: null,
  topic_tag: null,
  triage_label: 'data_to_log',
  time_sensitivity_flag: 'none',
  delivery_state: null,
  delivery_detail: null,
  fallback_leg_used: null,
  is_synced: 1,
  user_acknowledged_at: null,
  user_action_taken: null,
};

/**
 * Explicit field-by-field domain construction per the handoff §3
 * hydration rules (snake_case→camelCase, 0/1→boolean, JSON-in-TEXT
 * parsed, timestamps/null pass through). Deliberately spelled out —
 * the meta-test verifies pairs with its own independent generic
 * implementation of the same rules.
 */
function toDomain(row: CommsLogRow): CommsLogDomain {
  return {
    id: row.id,
    createdAt: row.created_at,
    provider: row.provider,
    channel: row.channel,
    direction: row.direction,
    providerMessageId: row.provider_message_id,
    idempotencyProvenance: row.idempotency_provenance,
    contentHash: row.content_hash,
    threadKey: row.thread_key,
    fromIdentifier: row.from_identifier,
    toIdentifiers: JSON.parse(row.to_identifiers) as string[],
    subject: row.subject,
    body: row.body,
    providerTimestamp: row.provider_timestamp,
    contactId: row.contact_id,
    topicTag: row.topic_tag,
    triageLabel: row.triage_label,
    timeSensitivityFlag: row.time_sensitivity_flag,
    deliveryState: row.delivery_state,
    deliveryDetail: row.delivery_detail,
    fallbackLegUsed: row.fallback_leg_used,
    isSynced: row.is_synced === 1,
    userAcknowledgedAt: row.user_acknowledged_at,
    userActionTaken: row.user_action_taken,
  };
}

interface VariantSpec {
  slug: string;
  uuid: string;
  createdAt: string;
  isSynced: 0 | 1;
  purgeEligible: boolean;
  mechanism: string;
}

const VARIANT_SPECS: readonly VariantSpec[] = [
  {
    slug: 'retention-fresh-unsynced',
    uuid: 'fa0701fa-0701-4701-8701-fa0701fa0701',
    createdAt: '2026-06-20T09:00:00Z',
    isSynced: 0,
    purgeEligible: false,
    mechanism: 'Retention: age 13d (< 90d), is_synced=0 → retained.',
  },
  {
    slug: 'retention-fresh-synced',
    uuid: 'fa0702fa-0702-4702-8702-fa0702fa0702',
    createdAt: '2026-06-20T09:00:00Z',
    isSynced: 1,
    purgeEligible: false,
    mechanism: 'Retention: age 13d (< 90d), is_synced=1 → retained (too fresh despite sync).',
  },
  {
    slug: 'retention-old-unsynced',
    uuid: 'fa0703fa-0703-4703-8703-fa0703fa0703',
    createdAt: '2026-03-01T09:00:00Z',
    isSynced: 0,
    purgeEligible: false,
    mechanism: 'Retention: age 124d (> 90d) but is_synced=0 → retained (never purge unsynced inside the 180d ceiling).',
  },
  {
    slug: 'retention-old-synced',
    uuid: 'fa0704fa-0704-4704-8704-fa0704fa0704',
    createdAt: '2026-03-01T09:00:00Z',
    isSynced: 1,
    purgeEligible: true,
    mechanism: 'Retention: age 124d (> 90d) AND is_synced=1 → purge-eligible (the only >90d combo that purges).',
  },
  {
    slug: 'retention-ceiling-180d',
    uuid: 'fa0705fa-0705-4705-8705-fa0705fa0705',
    createdAt: '2025-12-01T09:00:00Z',
    isSynced: 0,
    purgeEligible: true,
    mechanism: 'Retention: age 214d exceeds the 180-day absolute ceiling → purge-eligible even though is_synced=0.',
  },
];

/** The base row packaged as a registrable fixture (variants point at it via variantOf). */
export function makeRetentionBase(): RetentionVariant {
  return {
    slug: 'retention-base',
    mechanism:
      'Retention factory base row (inline, no files): age 13d, is_synced=1 → retained. Variants derive from this row.',
    purgeEligible: false,
    row: RETENTION_BASE_ROW,
    domain: toDomain(RETENTION_BASE_ROW),
  };
}

/**
 * Produce the retention/sync variant set from a base comms_log row.
 * Each variant gets its own UUID and provider_message_id (the partial
 * UNIQUE on (provider, provider_message_id) spans the whole corpus).
 */
export function makeRetentionVariants(base: CommsLogRow = RETENTION_BASE_ROW): RetentionVariant[] {
  return VARIANT_SPECS.map((spec) => {
    const row: CommsLogRow = {
      ...base,
      id: spec.uuid,
      created_at: spec.createdAt,
      provider_timestamp: spec.createdAt,
      provider_message_id: `pm-outlook-${spec.slug}`,
      is_synced: spec.isSynced,
    };
    return {
      slug: spec.slug,
      mechanism: spec.mechanism,
      purgeEligible: spec.purgeEligible,
      row,
      domain: toDomain(row),
    };
  });
}
