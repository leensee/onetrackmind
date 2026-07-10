-- ============================================================
-- OTM Migration 002 — idempotency_keys index catch-up
-- Source of truth: Notion "OTM Phase 4 Communications Schema"
-- v1.3, which specifies four idempotency_keys indexes; migration
-- 001 shipped only the partial UNIQUE. Spec catch-up, not a
-- schema-version bump (v1.2/v1.3 are clarification-only;
-- SCHEMA_VERSION stays '1.1').
--
-- Repo naming convention (prefix + full table name) — the Notion
-- doc's names map as:
--   ix_idem_content  → ix_idempotency_keys_content
--   ix_idem_expires  → ix_idempotency_keys_expires
--   ix_idem_unsynced → ix_idempotency_keys_unsynced
--
-- ix_idempotency_keys_content backs the idempotencyChecker's
-- windowed content-hash gate (key_value match AND first_seen_at
-- >= now − 10min); ix_idempotency_keys_expires readies the table
-- for the deferred expiry sweep (retention module, Phase 7);
-- ix_idempotency_keys_unsynced serves the Phase 7 sync scan.
-- ============================================================

CREATE INDEX IF NOT EXISTS ix_idempotency_keys_content
  ON idempotency_keys (key_value, first_seen_at)
  WHERE key_type = 'content_hash';

CREATE INDEX IF NOT EXISTS ix_idempotency_keys_expires
  ON idempotency_keys (expires_at);

CREATE INDEX IF NOT EXISTS ix_idempotency_keys_unsynced
  ON idempotency_keys (is_synced)
  WHERE is_synced = 0;
