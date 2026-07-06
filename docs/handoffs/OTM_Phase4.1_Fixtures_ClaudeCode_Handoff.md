# OTM Phase 4.1 — Claude Code Handoff
## Synthetic fixtures corpus: `backend/tests/fixtures/` + manifest + self-verifying meta-test

**Date:** 2026-07-03 · **Prepared by:** Cowork session (repo + Notion state verified same day)
**Governing doc:** OTM Code Generation and Audit Doc **v2.2** (3-section response format + full self-audit checklist apply to every unit of work in this handoff).
**Approved scope:** fixtures corpus only. Do NOT write the migration DDL, the DAL, serializers, or any pure functions. Do NOT edit any existing source file except `backend/package.json` (test script wiring).

---

## 0. Verified repo facts (do not re-litigate)

- Test layout is **`backend/tests/`** (plural). The fixtures location is **`backend/tests/fixtures/`** — settled 2026-07-03; an earlier draft said `test/`, that is superseded.
- Test runner is **hand-rolled ts-node scripts** (see `backend/tests/*.test.ts` for the house pattern: local `test(name, fn)` helper, `✓/✗` output, non-zero exit on failure, run via `ts-node --project tsconfig.test.json`). **No jest/vitest. Do not introduce a test framework.**
- **No DAL, no `toDb`/`fromDb` serializer, no Row types, no migration DDL exist yet.** Therefore:
  - The meta-test carries **no round-trip assertions** (gated on the DAL; next handoff).
  - Domain-side fixture shape is defined by the hydration rules in §3, not by TS types.
- CJS module system (`"type": "commonjs"`), TS via ts-node. Follow existing file header/comment conventions.

## 1. Deliverables

| # | Path | Content |
|---|------|---------|
| 1 | `backend/tests/fixtures/<table>/…` | Valid fixtures: paired `<slug>.row.json` + `<slug>.domain.json` |
| 2 | `backend/tests/fixtures/<table>/invalid/…` | Negative fixtures: `<slug>.row.json` only |
| 3 | `backend/tests/fixtures/constraints.ts` | Machine-readable constraint catalog (§4) — the coverage ledger the meta-test checks against |
| 4 | `backend/tests/fixtures/manifest.ts` | Typed registry of every fixture (§5) |
| 5 | `backend/tests/fixtures/retentionFactory.ts` | Factory producing retention/sync variants from base rows (§6) |
| 6 | `backend/tests/fixturesMeta.test.ts` | Self-verifying meta-test (§7) |
| 7 | `backend/package.json` | Add `"test:fixtures"` script; append it to the `test` chain |

Table directories: `comms_log/`, `contacts/`, `idempotency_keys/`, `thread_mappings/`, `polling_state/`, `device_comms_log/`, `device_contacts/`.

## 2. Binding schema facts — target is Schema **v1.1**

Source of truth: Notion "OTM Phase 4 Communications Schema" page. The Notion page still reads v1.0 at time of writing; the corpus targets **v1.1 = v1.0 plus two additive CHECK families** (approved, Notion bump pending):

- **v1.1-A:** `CHECK (col IN (0,1))` on every INTEGER 0/1 column — `is_synced` (all five backend tables) and `contacts.is_internal_channel` (and both device mirrors).
- **v1.1-B:** `comms_log` table-level CHECK: `(idempotency_provenance = 'content_hash_fallback' OR provider_message_id IS NOT NULL)` — backend and device mirror.

Key v1.0 facts that bind fixture content:

- `time_sensitivity_flag` — enum `hard/soft/none`, NOT NULL, DEFAULT `none`.
- `content_hash` — always NOT NULL (computed on every message, both provenance paths).
- `comms_log` table CHECK: `(direction='inbound' AND delivery_state IS NULL) OR (direction='outbound' AND delivery_state IS NOT NULL)`.
- `idempotency_keys.key_type = 'content_hash'` vs `comms_log.idempotency_provenance = 'content_hash_fallback'` — different enums, do not conflate.
- `polling_state.provider` CHECK allows **`yahoo` only**.
- Timestamps: ISO 8601 UTC TEXT (`2026-06-07T14:30:00Z`). PKs: UUIDv4 TEXT. JSON-in-TEXT columns per table below.
- Device mirrors: `comms_log` all 24 columns + both table CHECKs; `contacts` all 10 columns; both with identical column CHECKs. Device-writable fields on `comms_log`: **only** `user_acknowledged_at`, `user_action_taken`. Device `contacts` is a read-only cache.

### Full constraint inventory (encode this as `constraints.ts`)

**comms_log** (24 cols)
- NOT NULL: `id, created_at, provider, channel, direction, idempotency_provenance, content_hash, thread_key, from_identifier, to_identifiers, subject→nullable, body, provider_timestamp, triage_label, time_sensitivity_flag, is_synced` (nullable: `provider_message_id, subject, contact_id, topic_tag, delivery_state, delivery_detail, fallback_leg_used, user_acknowledged_at, user_action_taken`)
- Enum CHECKs: `provider ∈ (outlook,yahoo,twilio)`; `channel ∈ (email,sms)`; `direction ∈ (inbound,outbound)`; `idempotency_provenance ∈ (provider_id,content_hash_fallback)`; `triage_label ∈ (action_required,data_to_log,awareness_only,unknown_sender,unclear_review)`; `time_sensitivity_flag ∈ (hard,soft,none)`; `delivery_state ∈ (queued,sent,delivered,failed,fallback_used)` nullable; `fallback_leg_used ∈ (sms,fcm,email)` nullable; `user_action_taken ∈ (requested_draft_reply,marked_informational,dismissed,none)` nullable
- Table CHECKs: direction⇄delivery_state (v1.0); provenance⇒provider_message_id (v1.1-B); `is_synced ∈ (0,1)` (v1.1-A)
- UNIQUE (partial): `(provider, provider_message_id) WHERE provider_message_id IS NOT NULL`
- FK: `contact_id → contacts.id`
- JSON cols: `to_identifiers` (array)

**contacts** (10 cols)
- NOT NULL: all except none (every column NOT NULL; `recognition_metadata` DEFAULT `'{}'`)
- CHECKs: `tone_level BETWEEN 0 AND 10`; `status ∈ (active,dismissed,archived)`; `is_internal_channel ∈ (0,1)` (v1.1-A); `is_synced ∈ (0,1)` (v1.1-A)
- JSON cols: `channels` (array), `identifiers` (array of `{channel,value}`), `recognition_metadata` (object)

**idempotency_keys** (8 cols)
- NOT NULL: all except `linked_message_id`
- CHECKs: `key_type ∈ (provider_id,content_hash)`; `provider ∈ (outlook,yahoo,twilio)`; `is_synced ∈ (0,1)` (v1.1-A)
- UNIQUE (partial): `(provider, key_value) WHERE key_type='provider_id'`
- FK: `linked_message_id → comms_log.id`
- Expiry semantics: `expires_at = first_seen_at + 90d` (provider_id) / `+ 24h` (content_hash) — fixtures must embody the correct arithmetic.

**thread_mappings** (7 cols)
- NOT NULL: all
- CHECKs: `identifier_type ∈ (rfc5322_message_id,provider_conversation_id,phone_pair)`; `provider ∈ (outlook,yahoo,twilio)`; `is_synced ∈ (0,1)` (v1.1-A)
- UNIQUE: `(identifier_type, identifier_value)`

**polling_state** (7 cols)
- NOT NULL: all except `cursor`, `last_polled_at`
- CHECKs: `provider ∈ (yahoo)`; `is_synced ∈ (0,1)` (v1.1-A)
- UNIQUE: `(provider, account_identifier, folder)`
- JSON col: `cursor` (object, e.g. `{"uidValidity":…,"lastSeenUid":…}`) — nullable

**device_comms_log / device_contacts** — same column constraints as backend counterparts. Additional **ownership rules** (policy-class, enforced by the future DAL, not the DB): device may write only `user_acknowledged_at`/`user_action_taken` on `comms_log`; device may write nothing on `contacts`.

## 3. Paired row/domain hydration rules (deterministic, no serializer yet)

For every **valid** fixture: `<slug>.row.json` (DB shape) + `<slug>.domain.json` (app shape), related by exactly these rules — the future `toDb`/`fromDb` serializer must reproduce them:

1. Keys: `snake_case` → `camelCase` (per Code Gen v2.2 naming rule).
2. INTEGER 0/1 booleans (`is_synced`, `is_internal_channel`) → JSON `true`/`false`.
3. JSON-in-TEXT columns → parsed JSON values (arrays/objects), byte-for-byte equivalent content.
4. ISO 8601 timestamp strings pass through unchanged (remain strings).
5. `NULL` → `null`. All other scalars pass through unchanged (`tone_level` stays a number).

**Negative** fixtures are `row`-only (they never hydrate — they're rejected at the boundary).

## 4. `constraints.ts` — coverage ledger

Export a typed catalog: every constraint above gets a stable ID (`CL-CHK-DIRECTION-DELIVERY`, `CL-CHK-PROVENANCE-PROVIDER-MSG-ID` (v1.1-B), `CT-CHK-IS-INTERNAL-01` (v1.1-A), `IK-UQ-PROVIDER-KEY`, `CL-FK-CONTACT`, `TM-NN-THREAD-KEY`, `DV-OWN-COMMS-BACKEND-FIELD`, `DV-OWN-CONTACTS-READONLY`, …), with fields: `id`, `table`, `kind` (`check-enum | check-range | check-table | check-bool01 | unique | fk | not-null | ownership | dedup-window`), `column(s)`, and for enums the full value list. Also flag `enforcedBy: 'db' | 'dal'` — ownership rules and the content-hash 10-minute dedup window are `dal` (documented expectation; DB can't express them).

## 5. `manifest.ts` — fixture registry

One entry per fixture (factory variants registered programmatically):
`{ id, table, kind: 'valid' | 'invalid', mechanism, files: { row, domain? }, coversEnumValues?: [{constraintId, value}], rejects?: constraintId, expectedError?: string, variantOf?: id }`

Standing principle (goes in the file header): **mechanism-comprehensive, not combinatorial** — one fixture per distinct failure/behavior mechanism, no cross-products of field values.

## 6. `retentionFactory.ts`

Pure factory over base `comms_log` rows producing retention/sync variants: age > 90d × `is_synced ∈ {0,1}` (4 combos: purge-eligible only when both old AND synced), plus a 180-day-ceiling row. Variants are registered in the manifest via `variantOf`. No I/O, no dates relative to "now" at test time — bake absolute ISO timestamps and document the reference date in the factory header.

## 7. `fixturesMeta.test.ts` — self-verifying meta-test

House test pattern (§0). Assertions:

1. **Manifest ↔ filesystem sync** — every manifest entry's files exist; every `*.json` under `fixtures/` is claimed by exactly one entry (no orphans, either direction).
2. **Pairing** — every valid fixture has both `row` and `domain`; every invalid fixture has `row` only.
3. **Hydration conformance** — for every valid pair, applying §3 rules to `row` yields exactly `domain` (deep-equal). This is a rules check, not a serializer round-trip.
4. **Enum coverage** — every value of every enum CHECK in `constraints.ts` appears in ≥ 1 valid fixture (assert via `coversEnumValues` AND by scanning actual fixture content — the manifest must not be trusted on its own word).
5. **Negative coverage** — every constraint with `enforcedBy: 'db'` (all CHECKs incl. both v1.1 families, all UNIQUEs, all FKs, all NOT-NULLs) plus each `ownership` rule is targeted by ≥ 1 invalid fixture (`rejects` populated and the row actually violates it where statically checkable).
6. **PII guard** — scan every fixture: all emails end `@example.com`; all phone numbers match `+1555 01xx` / `555-01xx` patterns; no identifier fields contain anything outside the synthetic allowlist. Hard-fail otherwise.
7. **Schema-version tag** — fixtures dir carries a `SCHEMA_VERSION = '1.1'` constant asserted by the test (future migration work bumps consciously).

Exit non-zero on any failure; per-assertion `✓/✗` output like sibling tests.

## 8. Required coverage — valid fixtures (one per mechanism)

**comms_log:** 4 direction×channel base rows; triage `data_to_log` / `unknown_sender` (`contact_id` null) / `unclear_review`; time-sensitivity `hard`/`soft`/`none` + 2 label-orthogonality pairs (same triage_label, different time_sensitivity, and vice versa); `content_hash_fallback` with null `provider_message_id`; null `subject` email; verbatim/encoding set — quoted-chain+signature+forward, injection-looking body (e.g. "ignore previous instructions…" stored verbatim), unicode/emoji/RTL/zero-width/control chars, empty-string body, whitespace-only body, HTML+plaintext-alternative and quoted-printable/base64-decoded forms; multi-recipient `to_identifiers`; delivery lifecycle `queued`/`delivered`/`failed`+`delivery_detail`/`fallback_used` with `fallback_leg_used` `fcm` and `email`; provider-timestamp fallback (provider_timestamp == created_at); identity resolution set — cross-channel same-human (email + SMS rows, same `contact_id`), archived-contact-returns, recycled-number mis-match, changed-identifier→`contact_id` null; dedup-window pair — identical body 11 min apart → both stored (outside 10-min window); cross-provider identical content → one row (documented in mechanism note); retention/sync factory variants (§6); device-field states — `user_acknowledged_at`/`user_action_taken` null vs post-ack populated.

**contacts:** internal two-identifier; internal email-only; external vendor; external active→archived + returned; external role mailbox (e.g. `dispatch@example.com`); external lookalike (near-duplicate of another contact's identifier); external→internal promotion (`is_internal_channel` 0→1 story, single row end-state); near-name pair (two contacts, similar `display_name`); `tone_level` 0 / 5 / 10; `status` active/dismissed/archived; alias-rich `recognition_metadata`; identifier-normalization set — phone as E.164 / national / with extension / punctuation-variant; email case-variant / plus-addressing / whitespace-wrapped.

**idempotency_keys:** `provider_id` key with +90d expiry; `content_hash` key with +24h expiry; 10-minute-window pair (second-seen inside window → suppressed [no second comms_log row; documented], outside window → stored); `linked_message_id` null vs populated (FK to an existing comms_log fixture id).

**thread_mappings:** one each of `rfc5322_message_id` / `provider_conversation_id` / `phone_pair`; multi-row chain → one `thread_key`; same-subject-different-conversation → two `thread_key`s; broken chain (reply without References → new thread_key); subject-changed-mid-thread (same thread_key); group-SMS 3+ participants phone_pair handling; orphan mapping (thread_key with no comms_log rows — purge-eligible).

**polling_state:** cold start (null `cursor`/`last_polled_at`); mid-stream (`{"uidValidity":…,"lastSeenUid":…}`); uidValidity-changed (cursor reset story, documented in mechanism note).

**device (DV):** pushed row `is_synced=1`, device fields null; local ack → `is_synced=0`; post-push → `is_synced=1`; `device_contacts` read-only cache row (`is_synced=1`).

## 9. Required coverage — negative fixtures (rejection expected)

**comms_log:** inbound WITH `delivery_state`; outbound WITHOUT `delivery_state`; bad enum value for each of `triage_label`, `time_sensitivity_flag`, `provider`, `channel`, `direction`, `fallback_leg_used`, `user_action_taken`; duplicate `(provider, provider_message_id)`; `contact_id` → nonexistent contact (FK); NOT-NULL violations for `content_hash`, `body`, `thread_key`; **v1.1-B:** `idempotency_provenance='provider_id'` with null `provider_message_id`; **v1.1-A:** `is_synced=2`.

**contacts:** bad `status`; `tone_level` 11 and −1; malformed JSON in `identifiers`; wrong-shaped `identifiers` (valid JSON, wrong structure — `dal`-class); NOT-NULL violation; **v1.1-A:** `is_internal_channel=2`.

**idempotency_keys:** bad `key_type`; bad `provider`; duplicate `(provider, key_value)` with `key_type='provider_id'`; `linked_message_id` → nonexistent comms_log id (FK); NOT-NULL violation.

**thread_mappings:** bad `identifier_type`; bad `provider`; duplicate `(identifier_type, identifier_value)`; NOT-NULL violation.

**polling_state:** `provider='outlook'` (push provider — polling table rejects); duplicate `(provider, account_identifier, folder)`.

**device (ownership, `enforcedBy:'dal'`):** device write targeting a backend-only `comms_log` field; device write targeting `contacts`.

## 10. Load-bearing constraints (non-negotiable)

1. **Synthetic identifiers only** — `@example.com` emails, `555-01xx` phones, fake names. No real PII in the repo, ever. The meta-test enforces this (§7.6).
2. **Paired row/domain** for all valids, per §3 rules exactly.
3. **Mechanism-comprehensive, not combinatorial** (standing principle, Decisions Log).
4. Retention/sync variants come from the factory, not hand-copied files.
5. Cross-fixture referential integrity: FK-bearing valid fixtures point at ids that exist in the corpus.
6. No new dependencies. No test framework. No edits outside `backend/tests/fixtures/`, `backend/tests/fixturesMeta.test.ts`, `backend/package.json`.

## 11. Acceptance criteria

- `npm run test:fixtures` green.
- Full `npm test` chain still green (nothing existing broken).
- Code Gen v2.2 self-audit run on all new TS files; 3-section format used in session responses.
- Diff surface exactly: new files under `backend/tests/fixtures/`, `backend/tests/fixturesMeta.test.ts`, `backend/package.json` script lines, and this handoff untouched.

## 12. Out of scope (next handoff)

Migration DDL (must carry both v1.1 CHECK families — recorded as a requirement on that task), the DAL, `toDb`/`fromDb` serializers + Row types, foundation pure functions, and all Notion updates (handled by the Cowork session, pending approval).
