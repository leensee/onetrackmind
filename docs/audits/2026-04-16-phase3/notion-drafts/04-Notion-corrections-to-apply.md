# Notion Corrections to Apply — Phase 3 Audit 2026-04-16

Each correction below is scoped to unique context strings for low-friction execution. Recommend applying in order listed.

Format of each entry:
- **Target:** Notion page name + UUID
- **Action:** Edit type (add section / update text / new checkbox)
- **Find:** Existing text to locate (or null if adding new section)
- **Replace with / Add:** New text

---

## 1. Roadmap (ID: 334b4318-e88b-81e8-bf56-cb8de89ec606)

### 1a. Update Phase 2 test count line

**Find:**
```
**Total: 175 tests, 0 failures**
```

**Replace with:**
```
**Total: 175 active + 1 designed-skip integration (Primary Call, requires live API key), 0 failures**
```

### 1b. Update Phase 3 status line

**Find:**
```
## Phase 3 — Tool layer
**Status:** Complete — 2026-04-15.
```

**Replace with:**
```
## Phase 3 — Tool layer
**Status:** Complete — 2026-04-15. Re-validated 2026-04-16 following Phase 3 architecture + code audit. One regression found and fixed: outputRouter.ts type annotation + stale test alignment to AES-256-GCM contract (committed 2026-04-16). See Audit Log > Phase 3 Architecture + Code Audit — 2026-04-16 for full audit record.
```

### 1c. Phase 3 — test count reconciliation

**Find:**
```
- Carryover: `.env.example` + env config modules — 26 tests
```

**Replace with:**
```
- Carryover: `.env.example` + env config modules — 39 tests (prior count 26 reconciled post-audit)
```

**Find:**
```
- `sheetOutput.ts` — RFC 4180 CSV; Sheets/Excel/download compatible; 20 tests
```

**Replace with:**
```
- `sheetOutput.ts` — RFC 4180 CSV; Sheets/Excel/download compatible; 22 tests (prior count 20 reconciled post-audit)
```

**Note on Event Classifier:** The Event Classifier line on Phase 2 references `21/21 tests` in its entry. Reconciled to 20. Apply same pattern if you want test counts updated on Phase 2 for consistency.

### 1d. Phase 3 — add readiness subsection

**Add at end of Phase 3 section (before the `---` divider separating it from Phase 4):**

```
### Phase 3 → Phase 4 readiness

Four Tier 0 items must be resolved before Phase 4 build begins:
- 2026-04-16-OT-4 (RED) — persist PO sequence to DB
- 2026-04-16-AG-3 — fallbackEmailFn signature takes FeedbackPayload
- 2026-04-16-CD-1 — discriminated CommsDraftInput eliminates `!`
- 2026-04-16-OT-9 — approval content must be human-readable (adds userFacingContent to drafts)

Tier 1 items (7 additional) fix during Phase 4 build, before Phase 4 closure.
Full tracker: Audit Log > Phase 3 Architecture + Code Audit — 2026-04-16 > Section 6.
```


### 1e. Phase 4 — add architecture decisions pending

**Find:**
```
Architecture decisions pending design:
- The system is the authoritative surface for work comms — native SMS notifications for monitored channels should be suppressible
```

**Replace with:**
```
Architecture decisions pending design:
- Twilio webhook → classifier-input normalization handler
- Gmail webhook → classifier-input normalization handler
- Email fallback for approval gate feedback submission — signature takes `FeedbackPayload` (resolves 2026-04-16-AG-3)
- The system is the authoritative surface for work comms — native SMS notifications for monitored channels should be suppressible
```

### 1f. Phase 5 — add push/pull scheduler to deliverables

**Find:**
```
Deliverables: Data layer scan, push trigger logic, pull item surface at session open, SMS push delivery, digest scheduling.
```

**Replace with:**
```
Deliverables: Data layer scan, push trigger logic, pull item surface at session open, SMS push delivery, digest scheduling, push/pull scheduler (deferred from Phase 2 when session open notification algorithm required data layer).
```

### 1g. Phase 6 — add onboarding guide

**Find:**
```
Deliverables: User-facing interface, input handling, output rendering by channel, mobile-first.
```

**Replace with:**
```
Deliverables: User-facing interface, input handling, output rendering by channel, mobile-first, onboarding guide (per Decisions Log 'Onboarding guide').
```

### 1h. Phase 7 — expand schema list

**Find:**
```
Deliverables: Live Supabase connection, session context loading, historical log structure. Google Sheets as output/reporting surface — not source of truth. *`user_settings (Supabase)` — stores all user-configurable settings with current values. Loaded at session open alongside style profile. Fields: setting_key, setting_value, default_value, last_modified.
```

**Replace with:**
```
Deliverables: Live Supabase connection, session context loading, historical log structure. Google Sheets as output/reporting surface — not source of truth.

**Supabase schema — 11 tables required (introduced across Phases 1-3, schematized here):**
- `user_settings` — user-configurable settings with current values; loaded at session open alongside style profile; fields: setting_key, setting_value, default_value, last_modified
- `session_log` — append-only log of session events (source of truth per hybrid persistence model)
- `session_states` — periodic state-object snapshots for performance
- `style_observations` — autonomous style-profile writes from assistant
- `style_exclusions` — user-set categorical style rules
- `diagnostic_log` — dedicated diagnostic events (separate from session_log)
- `todos` — todo items with category, timeSensitivity, equipmentId, linkedContactId
- `orders_log` — PurchaseOrder records with line items JSON
- `machine_specs` — EAV model for machine specifications
- `fleet_master` — consist + support equipment roster
- `expenses` — expense records with line items

All tables enforce RLS per Security & Compliance Policy v1.0.
All tables participate in `is_synced` local-first sync gate per standing decision.
```

### 1i. Phase 9 — add pre-flight calibration

**Find:**
```
Deliverables: Representative field scenarios, evidence standard enforcement, safety redline behavior, comms gate, push/pull accuracy, HOS escalation calibration, push judgment calibration.
```

**Replace with:**
```
Deliverables: Representative field scenarios, evidence standard enforcement, safety redline behavior, comms gate, push/pull accuracy, HOS escalation calibration, push judgment calibration, pre-flight audit rule calibration (autonomous action detection, gate marker detection, safety flag surfacing threshold, serial false-positive sweep, cost figure estimation markers — per Phase 3 audit Pattern 3), magic-number calibration (CHARS_PER_TOKEN, message-overhead constant, system prompt token count, preflight phone-window constants, model audit response cap — per Phase 3 audit Pattern 10).
```


---

## 2. Task Backlog (ID: 334b4318-e88b-81fe-a82c-c987901c45e1)

### 2a. Mark Phase 3 audit checkboxes as done

**Find:**
```
**Phase 3 audit — next before Phase 4 build:**
- [ ] Run full `npm test` suite — confirm all Phase 2 + Phase 3 tests pass clean
- [ ] Architecture audit: verify no arbitrary decisions, all error paths typed, all tool contracts consistent with orchestrator decision contract standard
- [ ] Cross-component validation: confirm tool outputs match orchestrator expectations end-to-end
- [ ] Code Gen doc v2.0 compliance sweep across all Phase 3 code
```

**Replace with:**
```
**Phase 3 audit — complete 2026-04-16:**
- [x] Run full `npm test` suite — 422 passed + 1 designed-skip + 1 in-audit regression fix (outputRouter)
- [x] Architecture audit — verified no arbitrary decisions, all error paths typed, all tool contracts consistent
- [x] Cross-component validation — tool outputs match orchestrator expectations end-to-end
- [x] Code Gen doc v2.0 compliance sweep — all Phase 3 code reviewed
See Audit Log > Phase 3 Architecture + Code Audit — 2026-04-16 for full audit record.
```

### 2b. Add Tier 0+1 remediation section

**Add immediately after the "Phase 3 audit — complete 2026-04-16" block, before the next `---` divider:**

```
**Phase 3 audit findings — Tier 0+1 remediation (approved 2026-04-16):**

Each item follows Code Gen v2.0 Section 1→2→3 approval cycle.

Tier 0 (must-fix before Phase 4 build begins):
- [ ] typeUtils extensions: extractString/extractNumber/extractArray/extractBoolean + extractOneOf<T> (resolves 2026-04-16-TYU-4, 2026-04-16-TYU-5) — prerequisite for item 3
- [ ] Persist PO sequence to DB (resolves RED finding 2026-04-16-OT-4, 2026-04-16-OT-5)
- [ ] Discriminated CommsDraftInput eliminates `!` (resolves 2026-04-16-CD-1, 2026-04-16-T-5)
- [ ] Human-readable draft content + shared formatters.ts (resolves 2026-04-16-OT-9, 2026-04-16-PA-8, 2026-04-16-MA-5, 2026-04-16-PF-15)
- [ ] fallbackEmailFn(payload) + module side-effect split (resolves 2026-04-16-AG-3, 2026-04-16-AG-10)

Tier 1 (fix during Phase 4 build, before Phase 4 closure):
- [ ] Replace `as string` casts with typed accessors; tighten coerceSetting (resolves 2026-04-16-SP-6, SP-7, CL-5, CL-6, CL-7, CL-8) — depends on typeUtils extensions
- [ ] Edition-injection for repo/title/product name (resolves 2026-04-16-AG-2, 2026-04-16-AG-4, 2026-04-16-S1-E2)
- [ ] Edition-inject model audit system prompt (resolves 2026-04-16-MA-4, 2026-04-16-MA-5)
- [ ] Fix sheet-output title handling (resolves 2026-04-16-SO-3)
- [ ] Rework pre-flight rules to check orchestrator state (resolves 2026-04-16-PF-6, 2026-04-16-PF-7) — largest design work, last in sequence

Tier 2 deferred: tracked in .docx audit report Section 7.
Tier 3 deferred: ~180 standards-drift items tracked in .docx audit report Section 4.
Tier 4 deferred to OTM v2 intake: MachineType genericization, locale/currency abstraction, ApprovalDecision split.
```

### 2c. Phase 3 — update status line

**Find:**
```
## Phase 3 — Tool layer
**Status:** Complete — 2026-04-15. 256 tests, 0 failures.
```

**Replace with:**
```
## Phase 3 — Tool layer
**Status:** Complete — 2026-04-15. 422 tests passed (175 Phase 2 + 247 Phase 3) + 1 designed-skip integration. Re-validated 2026-04-16 via architecture + code audit; one regression found and fixed in-audit (outputRouter type annotation + test alignment, committed 2026-04-16).
```


---

## 3. Decisions Log (ID: 334b4318-e88b-811d-ace4-d189fd5a57aa)

### 3a. Add new entry at end (immediately before the final closing `</content>` tag)

**Add:**

```
---
## Phase 3 architecture + code audit
**Decision:** Full architecture and code audit of Phase 3 completion performed 2026-04-16 against Code Gen doc v2.0, the orchestrator decision contract standard, and user-defined criteria (code structure/style/naming, assumption traceability, genericization, hard-coded decision trees, phase-to-user-deliverable mapping, component self-containment) plus auditor-added criteria approved at audit start (type-safety escape hatches, exhaustive-switch enforcement, import graph discipline, error telemetry consistency, cross-module constant duplication, contract symmetry, test quality, dead code, doc-code drift, TODO/FIXME sweep). 22 source files + 18 test files reviewed across 11 audit chunks.

**Findings summary:** 1 RED (2026-04-16-OT-4, module-level PO counter), 14 RED-adjacent YELLOW, ~190 YELLOW (dominated by standards drift and test-quality, not correctness defects), ~65 GREEN confirmations. 11 recurring codebase-level patterns identified.

**In-audit fix committed:** outputRouter.ts type annotation + test alignment to AES-256-GCM contract (one regression found during Stage 0 prerequisite validation, pre-existing in working tree, committed during audit).

**Remediation approved:** Tier 0 + Tier 1 combined scope, 10 commits in dependency-aware order. Tier 2 fold-ins where same file is touched. Tier 3 (~180 standards-drift items) tracked in .docx audit report Section 4 only, not in Task Backlog. Tier 4 items deferred to OTM v2 intake (MachineType genericization, locale/currency abstraction, ApprovalDecision split).

**Artifacts produced (per OTM Audit Standards v1.0):**
- In-conversation detail (working record)
- Notion audit page: Audit Log > Phase 3 Architecture + Code Audit — 2026-04-16 (with 7 standard sections)
- Downloadable report: `OTM-Phase3-Audit-2026-04-16.docx` (complete findings, conformant to Standards v1.0 Artifact C)

**Process output:** OTM Audit Standards v1.0 codified from this audit's execution pattern — establishes triggers (mandatory gates + drift triggers + 12-month backstop), 4-stage methodology, finding taxonomy (RED/RED-adj YELLOW/YELLOW/GREEN), reporting format, handoff protocol. Applies retroactively to all future audits.

**Finding ID scheme:** Date-prefixed format `YYYY-MM-DD-<ModulePrefix>-<Number>` established (e.g., `2026-04-16-OT-4`). Guarantees global uniqueness across all future audits.

**Affects:** Phase 3 (closure), Phase 4 (readiness — 4 Tier 0 items must-fix-before-build), Phase 5 (push/pull scheduler scope addition), Phase 6 (onboarding guide scope confirmation), Phase 7 (schema list expansion — 10 tables), Phase 9 (pre-flight audit rule calibration + magic-number calibration scope additions), All phases (OTM Audit Standards v1.0 as cross-cutting policy)

**Status:** Settled — 2026-04-16
```

---

## 4. Execution order recommendation

Apply in this order to minimize conflict risk:

1. **Create new pages first** (no conflict risk):
   - `OTM Audit Standards v1.0` under Documents > Policy (paste from `01-OTM-Audit-Standards-v1.0.md`)
   - `Audit Log` as new top-level page alongside Documents (paste from `02-Audit-Log-index.md`)
   - `Phase 3 Architecture + Code Audit — 2026-04-16` as child of Audit Log (paste from `03-Phase-3-Audit-2026-04-16.md`)

2. **Apply existing-page edits** (sections 1, 2, 3 above):
   - Roadmap edits (1a through 1i) — 9 edits
   - Task Backlog edits (2a through 2c) — 3 edits
   - Decisions Log entry (3a) — 1 addition

3. **Update Audit Log index table** with link to the newly-created Phase 3 audit child page.

Total Notion operations: 3 page creations + 13 edits + 1 link update = 17 operations.

Notion MCP reliability note (per your memory): each edit block uses unique surrounding context. Break into small targeted calls. Fetch page before writing to avoid stale assumptions. These drafts are sized with that in mind — each find/replace pair scoped narrowly.


---

## 3. Decisions Log (ID: 334b4318-e88b-811d-ace4-d189fd5a57aa)

### 3a. Add new entry — Phase 3 architecture + code audit

**Add at the top of the page (after the intro paragraph, before the first `---`):**

```
## Phase 3 architecture + code audit
**Decision:** Full architecture and code audit performed 2026-04-16 against Code Gen doc v2.0, orchestrator decision contract standard, and user-defined criteria (code structure/style/naming, assumption traceability, genericization, hard-coded decision trees vs AI reasoning, phase-to-user-deliverable mapping, component self-containment). 22 source files + 18 test files reviewed across 11 audit chunks.

Findings: 1 RED (2026-04-16-OT-4 module-level PO sequence counter), 14 RED-adjacent YELLOW, ~190 YELLOW (dominated by standards drift and test-quality), ~65 GREEN. 11 recurring codebase patterns identified.

Tier 0+1 remediation approved (10 combined items, ordered by dependency). Tier 2 tracked but not scheduled; Tier 3 documented in audit .docx only; Tier 4 deferred to OTM v2 intake.

In-audit regression fix: outputRouter.ts type annotation + test alignment to AES-256-GCM contract (committed 2026-04-16).

Test count reconciliation: env 39 (prior 26), commsDrafter 26 (verified), sheetOutput 22 (prior 20), eventClassifier 20 (prior 21).

Artifact outputs per OTM Audit Standards v1.0: (A) in-conversation detail in audit session, (B) Notion audit page at Audit Log > Phase 3 Architecture + Code Audit — 2026-04-16, (C) downloadable .docx report OTM-Phase3-Audit-2026-04-16.docx committed to repo at docs/audits/2026-04-16-phase3/.

**Affects:** Phase 3 (closure), Phase 4 (readiness — 4 Tier 0 items must resolve before build begins), Phases 5–9 (scope additions to Roadmap), all phases (Audit Standards v1.0 now in effect)
**Status:** Settled — 2026-04-16
```

### 3b. Add new entry — OTM Audit Standards v1.0 codification

**Add immediately after 3a, before the next entry:**

```
## OTM Audit Standards v1.0 — codified
**Decision:** Audit methodology formalized as a cross-cutting policy document — OTM Audit Standards v1.0. Ranks alongside Code Generation and Audit Doc v2.0 and Security & Compliance Policy v1.0. Covers: audit triggers (mandatory gates + drift triggers + 12-month calendar backstop), audit scope and criteria (cumulative — baseline 6 + audit-surface 10 + conformance 5 + behavioral 4), four-stage methodology (prerequisite validation / big-picture architecture / per-module deep audit / synthesis), finding taxonomy (RED / RED-adjacent YELLOW / YELLOW / GREEN with examples), date-prefixed ID scheme (YYYY-MM-DD-<ModulePrefix>-<Number>) for global uniqueness, three-artifact reporting format (in-conversation + Notion page + .docx), and handoff protocol.

Standards v1.0 enters effect 2026-04-16. Phase 3 audit conforms retroactively.

**Affects:** All future audits, all phases
**Status:** Settled — 2026-04-16
```
