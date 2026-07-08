-- ============================================================
-- OTM Migration 001 — Phase 4 communications schema, v1.1
-- (v1.0 + v1.1-A: CHECK (col IN (0,1)) on every INTEGER 0/1
--  column; v1.1-B: comms_log provenance ⇒ provider_message_id).
-- Source of truth: Notion "OTM Phase 4 Communications Schema" +
-- backend/tests/fixtures/constraints.ts (the machine-readable
-- checklist this file is verified against by
-- tests/schemaEnforcement.test.ts).
--
-- CHECK constraint names deliberately equal the fixture
-- manifest's expectedError suffixes ("CHECK constraint failed:
-- <name>"), so live SQLite errors match the corpus verbatim.
-- Do not rename them without regenerating the manifest.
--
-- Tables in FK-safe order:
--   contacts → comms_log → idempotency_keys
--   → thread_mappings → polling_state
-- Conventions: UUIDv4 TEXT PKs; ISO 8601 UTC TEXT timestamps;
-- JSON-in-TEXT columns; INTEGER 0/1 booleans.
-- Device mirror tables are Drift-native (Phase 4.6) — not here.
-- ============================================================

CREATE TABLE IF NOT EXISTS contacts (
  id                   TEXT PRIMARY KEY NOT NULL,
  created_at           TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  channels             TEXT NOT NULL,               -- JSON array
  identifiers          TEXT NOT NULL,               -- JSON array of {channel,value}; shape DAL-enforced
  tone_level           INTEGER NOT NULL
    CONSTRAINT "contacts.tone_level BETWEEN 0 AND 10"
    CHECK (tone_level BETWEEN 0 AND 10),
  status               TEXT NOT NULL
    CONSTRAINT "contacts.status"
    CHECK (status IN ('active', 'dismissed', 'archived')),
  is_internal_channel  INTEGER NOT NULL
    CONSTRAINT "contacts.is_internal_channel IN (0,1)"
    CHECK (is_internal_channel IN (0, 1)),
  recognition_metadata TEXT NOT NULL DEFAULT '{}',  -- JSON object
  is_synced            INTEGER NOT NULL
    CONSTRAINT "contacts.is_synced IN (0,1)"
    CHECK (is_synced IN (0, 1))
);

CREATE TABLE IF NOT EXISTS comms_log (
  id                     TEXT PRIMARY KEY NOT NULL,
  created_at             TEXT NOT NULL,
  provider               TEXT NOT NULL
    CONSTRAINT "comms_log.provider"
    CHECK (provider IN ('outlook', 'yahoo', 'twilio')),
  channel                TEXT NOT NULL
    CONSTRAINT "comms_log.channel"
    CHECK (channel IN ('email', 'sms')),
  direction              TEXT NOT NULL
    CONSTRAINT "comms_log.direction"
    CHECK (direction IN ('inbound', 'outbound')),
  provider_message_id    TEXT,
  idempotency_provenance TEXT NOT NULL
    CONSTRAINT "comms_log.idempotency_provenance"
    CHECK (idempotency_provenance IN ('provider_id', 'content_hash_fallback')),
  content_hash           TEXT NOT NULL,
  thread_key             TEXT NOT NULL,
  from_identifier        TEXT NOT NULL,
  to_identifiers         TEXT NOT NULL,             -- JSON array
  subject                TEXT,
  body                   TEXT NOT NULL,
  provider_timestamp     TEXT NOT NULL,
  contact_id             TEXT REFERENCES contacts(id),
  topic_tag              TEXT,
  triage_label           TEXT NOT NULL
    CONSTRAINT "comms_log.triage_label"
    CHECK (triage_label IN ('action_required', 'data_to_log', 'awareness_only', 'unknown_sender', 'unclear_review')),
  time_sensitivity_flag  TEXT NOT NULL DEFAULT 'none'
    CONSTRAINT "comms_log.time_sensitivity_flag"
    CHECK (time_sensitivity_flag IN ('hard', 'soft', 'none')),
  delivery_state         TEXT
    CONSTRAINT "comms_log.delivery_state"
    CHECK (delivery_state IN ('queued', 'sent', 'delivered', 'failed', 'fallback_used')),
  delivery_detail        TEXT,
  fallback_leg_used      TEXT
    CONSTRAINT "comms_log.fallback_leg_used"
    CHECK (fallback_leg_used IN ('sms', 'fcm', 'email')),
  is_synced              INTEGER NOT NULL
    CONSTRAINT "comms_log.is_synced IN (0,1)"
    CHECK (is_synced IN (0, 1)),
  user_acknowledged_at   TEXT,
  user_action_taken      TEXT
    CONSTRAINT "comms_log.user_action_taken"
    CHECK (user_action_taken IN ('requested_draft_reply', 'marked_informational', 'dismissed', 'none')),
  -- v1.0 table CHECK: inbound rows carry no delivery lifecycle;
  -- outbound rows always do.
  CONSTRAINT "comms_log direction/delivery_state pairing"
    CHECK ((direction = 'inbound' AND delivery_state IS NULL)
        OR (direction = 'outbound' AND delivery_state IS NOT NULL)),
  -- v1.1-B table CHECK: provider_id provenance requires the
  -- provider message id that provenance claims to be keyed on.
  CONSTRAINT "comms_log provenance requires provider_message_id"
    CHECK (idempotency_provenance = 'content_hash_fallback'
        OR provider_message_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_comms_log_provider_message_id
  ON comms_log (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id                TEXT PRIMARY KEY NOT NULL,
  key_type          TEXT NOT NULL
    CONSTRAINT "idempotency_keys.key_type"
    CHECK (key_type IN ('provider_id', 'content_hash')),
  provider          TEXT NOT NULL
    CONSTRAINT "idempotency_keys.provider"
    CHECK (provider IN ('outlook', 'yahoo', 'twilio')),
  key_value         TEXT NOT NULL,
  first_seen_at     TEXT NOT NULL,
  expires_at        TEXT NOT NULL,                  -- arithmetic (90d/24h) DAL-enforced
  linked_message_id TEXT REFERENCES comms_log(id),
  is_synced         INTEGER NOT NULL
    CONSTRAINT "idempotency_keys.is_synced IN (0,1)"
    CHECK (is_synced IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_keys_provider_key_value
  ON idempotency_keys (provider, key_value)
  WHERE key_type = 'provider_id';

CREATE TABLE IF NOT EXISTS thread_mappings (
  id               TEXT PRIMARY KEY NOT NULL,
  identifier_type  TEXT NOT NULL
    CONSTRAINT "thread_mappings.identifier_type"
    CHECK (identifier_type IN ('rfc5322_message_id', 'provider_conversation_id', 'phone_pair')),
  identifier_value TEXT NOT NULL,
  provider         TEXT NOT NULL
    CONSTRAINT "thread_mappings.provider"
    CHECK (provider IN ('outlook', 'yahoo', 'twilio')),
  thread_key       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  is_synced        INTEGER NOT NULL
    CONSTRAINT "thread_mappings.is_synced IN (0,1)"
    CHECK (is_synced IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_thread_mappings_identifier
  ON thread_mappings (identifier_type, identifier_value);

CREATE TABLE IF NOT EXISTS polling_state (
  id                 TEXT PRIMARY KEY NOT NULL,
  provider           TEXT NOT NULL
    CONSTRAINT "polling_state.provider"
    CHECK (provider IN ('yahoo')),                  -- polling table; push providers rejected
  account_identifier TEXT NOT NULL,
  folder             TEXT NOT NULL,
  cursor             TEXT,                          -- JSON object, nullable
  last_polled_at     TEXT,
  is_synced          INTEGER NOT NULL
    CONSTRAINT "polling_state.is_synced IN (0,1)"
    CHECK (is_synced IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_polling_state_provider_account_folder
  ON polling_state (provider, account_identifier, folder);
