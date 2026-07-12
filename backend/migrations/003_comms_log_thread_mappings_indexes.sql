-- ============================================================
-- OTM Migration 003 — comms_log / thread_mappings index catch-up
-- Source of truth: Notion "OTM Phase 4 Communications Schema"
-- v1.4, which flags six designed non-unique indexes as not yet
-- in any migration. Spec catch-up, not a schema-version bump
-- (v1.2–v1.4 are clarification-only; SCHEMA_VERSION stays '1.1').
--
-- ix_comms_log_thread backs thread-scoped message reads (the
-- thread_key resolved via thread_mappings); ix_comms_log_contact
-- indexes the FK child column for contact joins and parent-side
-- deletes (SQLite does not auto-index FK children — issue #64);
-- ix_comms_log_created backs time-ordered scans and retention
-- sweeps; ix_comms_log_unsynced and ix_thread_mappings_unsynced
-- serve the Phase 7 sync scan (partial, dirty rows only);
-- ix_thread_mappings_key backs thread_key → identifier-row
-- lookups (the reverse of the unique find-or-create path).
-- ============================================================

CREATE INDEX IF NOT EXISTS ix_comms_log_thread
  ON comms_log (thread_key);

CREATE INDEX IF NOT EXISTS ix_comms_log_contact
  ON comms_log (contact_id);

CREATE INDEX IF NOT EXISTS ix_comms_log_created
  ON comms_log (created_at);

CREATE INDEX IF NOT EXISTS ix_comms_log_unsynced
  ON comms_log (is_synced)
  WHERE is_synced = 0;

CREATE INDEX IF NOT EXISTS ix_thread_mappings_key
  ON thread_mappings (thread_key);

CREATE INDEX IF NOT EXISTS ix_thread_mappings_unsynced
  ON thread_mappings (is_synced)
  WHERE is_synced = 0;
