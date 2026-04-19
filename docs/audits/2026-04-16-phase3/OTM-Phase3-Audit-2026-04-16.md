# OneTrackMind — Phase 3 Architecture + Code Audit

**Date:** 2026-04-16
**Conforms to:** OTM Audit Standards v1.0
**Artifact:** 1 of 3 (in-conversation record, Notion audit page, .docx report)
**Auditor:** Claude Opus 4.6 via claude.ai + Desktop Commander MCP workflow
**Source commit SHA at audit start:** `3e3b9d1`
**Repository:** `github.com/leensee/onetrackmind`

---

## Note on source fidelity

This report was assembled during a conversation that compacted partway through generation. All finding tables in Sections 4–6 are reproduced **verbatim from original in-conversation delivery** — both pre-compaction and post-compaction chunks were preserved by pasting the complete conversation transcript across two document attachments. Where original wording used informal phrasing or abbreviations, those are preserved exactly. Where the transcript itself contained small typos or rendering artifacts from conversation formatting, those have been left intact to preserve audit traceability.

Finding ID scheme per OTM Audit Standards v1.0 Section 4: `YYYY-MM-DD-<ModulePrefix>-<Number>`. Short form (e.g. `OT-4`) used within tables to preserve readability; full form (`2026-04-16-OT-4`) used in Section 7 Remediation Tracker and any commit references.

---

## Section 1 — Executive Summary

Phase 3 (tool layer) was declared complete on 2026-04-15 with 256 tests, 0 failures. End-of-phase audit performed 2026-04-16 against 22 source files and 18 test files, applying OTM Audit Standards v1.0 criteria #1–16.

**Verdict: Phase 3 is substantively complete. Architecture holds. Four items must be fixed before Phase 4 build begins.**

Code quality is meaningfully above typical mid-stage codebases. Layer discipline is clean, the import graph is a tree with no cycles, every decision point uses a discriminated result, and 4 of 5 switches over union types use `const _: never = value` for exhaustive-check enforcement. Tool layer isolation is strict — no tool imports from another tool, no tool imports orchestration modules. Error handling is consistently return-not-throw in tool modules. Parameterized SQL throughout. AES-256-GCM FCM payload encryption verified.

**Finding totals:**

| Level | Count |
|---|---|
| RED | 1 |
| RED-adjacent YELLOW | 14 |
| YELLOW | ~190 |
| GREEN | ~65 |

The single RED finding (2026-04-16-OT-4) is module-level mutable state in `orchestratorTools.ts` — the PO sequence counter is shared across all sessions and all users that hit the same Node process, creating real data-integrity collision risk under the planned multi-user instance model. Fix is small-surface: persist per-user sequence in DB.

The 14 RED-adjacent YELLOW findings cluster around three architectural patterns: hardcoded edition-specific literals in modules claimed to be agnostic (6 instances), text heuristics where state-check or structured approach would be exact (3 instances, all in audit-adjacent code), and silent data-corruption handling at DB boundaries (2 fully silent + 8 warn-and-drop).

**Four must-fix items before Phase 4 build begins:**

1. `2026-04-16-OT-4` — persist PO sequence to DB (the RED)
2. `2026-04-16-AG-3` — `fallbackEmailFn(payload: FeedbackPayload)` signature fix before Phase 4 email wiring
3. `2026-04-16-CD-1` + `2026-04-16-T-5` — discriminated `CommsDraftInput` on `channel` field, eliminates `!` at type level before email send path is wired
4. `2026-04-16-OT-9` — human-readable approval content before Phase 4 wires the UI layer

Everything else is scheduled: Tier 0+1 combined scope (12 items, 10 commits) approved for remediation starting immediately post-audit. Tier 2 consolidation work folded in where the same file is touched. Tier 3 standards-drift and Tier 4 edition-intake items tracked but deferred.

**Patterns observed across the codebase:** 11 codebase-level patterns identified, spanning multiple modules each. See Section 5.

**In-audit regression fix:** `outputRouter.ts` type annotation + test alignment to AES-256-GCM contract. Held in working tree during audit, committed 2026-04-16. Surfaced one gap in Phase 2 audit closure: completion declarations should include a re-run of `npm test` in a clean environment, not just reliance on the test run from initial commit.

---

## Section 2 — Audit Parameters

**Trigger:** End of Phase 3 (tool layer complete). Mandatory gate per OTM Audit Standards v1.0 Section 1.

**Execution date:** 2026-04-16

**Auditor:** AI-assisted audit by Claude Opus 4.6 via claude.ai + Desktop Commander MCP workflow.

**Source code commit SHA at audit start:** `3e3b9d1` (backend monorepo at `github.com/leensee/onetrackmind`).

**In-audit regression fix:** `outputRouter.ts` type annotation + test alignment to AES-256-GCM contract. Committed 2026-04-16 (user confirmation received during audit closeout).

**Scope reviewed:**
- `/Users/linds/onetrackmind/backend/src/` — 22 source files
- `/Users/linds/onetrackmind/backend/tests/` — 18 test files

### Criteria applied

User-defined baseline criteria (criteria #1–6):

1. Code structure, style, patterns, and naming consistency with Code Gen doc v2.0
2. Assumptions and dependencies without noted future design
3. Genericization — edition/client/provider-agnostic where claimed
4. Unnecessary AI reasoning where deterministic trees work
5. Phase-to-user-deliverable traceability
6. Component self-containment

Auditor-added audit-surface criteria (criteria #7–16, approved at audit start):

7. Type-safety escape hatches (`as` casts, non-null `!`, `any`)
8. Exhaustive-switch enforcement via `const _: never = value`
9. Import graph discipline (layer boundaries, circular imports)
10. Error telemetry consistency across modules
11. Cross-module constant duplication
12. Contract symmetry (types produced == types consumed)
13. Test quality (coverage, independence, fragility)
14. Dead code detection
15. Documentation vs code drift
16. TODO/FIXME sweep

---

## Section 3 — Execution Structure

### Stage 0 — Prerequisite validation

`npm test` initially failed at compile. TS2322 error at `outputRouter.ts:174`: `EncryptedContent` not assignable to `Record<string, unknown>`. Additionally, one stale test in `outputRouter.test.ts` asserted pre-encryption shape (`data.fullContent === SHORT_TEXT`), which is incorrect post-2026-04-11 AES-256-GCM contract.

Verification via Desktop Commander confirmed both fixes were already present in the working tree — type annotation corrected to `EncryptedContent | undefined`, and three new tests replacing the stale assertion covered the three-state formatForPush contract (no key, valid key, invalid key).

The fixes had not been committed at audit start. They were committed during audit closeout with the commit message:

```
fix: outputRouter type annotation + test alignment to AES-256-GCM contract

- outputRouter.ts: EncryptedContent | undefined replaces Record<string, unknown> | undefined
- outputRouter.test.ts: three-state formatForPush tests (no key, valid key, invalid key)
  replace stale fullContent===plaintext assertion from pre-2026-04-11 contract

Regression surfaced and fixed during Phase 3 architecture + code audit 2026-04-16.
```

**Post-fix test state:** 422 active tests passed, 0 failures, 1 designed-skip (Primary Call integration requires live API key).

### Stage 1 — Big-picture architecture check

Six codebase-level checks performed via targeted grep and directory walk:

**Check 1 — Layer discipline / import graph.** Clean tree, no cycles. Tools layer consists of leaf nodes (no tool imports from another tool, no tool imports from orchestration). Orchestration imports from `./types`, `./typeUtils`, `./tokenUtils`, and one cross-module import (`modelAudit → primaryCall` for `sanitizeErrorMessage` reuse). `orchestratorTools.ts` is the root consumer. `types.ts` is the leaf — imports nothing internal. No orchestration module imports from `config/`.

**Check 2 — Silent-drop / unchecked-cast sweep.** 14 unchecked casts total across codebase. 3 legitimate (`as string[]` narrowing on runtime-enumerated `VALID_*` arrays), 9 in `sessionPersistence.ts` replay path (finding SP-6 scope), 1 in `contextLoader.ts` (CL-6 scope), 2 justified structural-interface casts. Silent-drop behavior in catch blocks: 2 fully silent (`contextLoader.ts:120` styleExclusions JSON parse, `specLookup.mapRosterRow` malformed `common_names`), 8 warn-and-drop patterns. Concentrated at DB boundaries where unknown-shape values coerce to typed values.

**Check 3 — Edition-specific literal sweep.** 6 locations confirmed outside `system-prompt.v1.0.ts` (which is intentionally edition-bound). Detailed in Pattern 2 (Section 5).

**Check 4 — Cross-module constant duplication.** `MAX_RETENTION_DAYS = 180` in 3 modules (`sessionPersistence`, `diagnosticLogger`, `todoTool` — the latter is dead code). `FCM_KEY_PATTERN` in 2 modules. Model string `'claude-sonnet-4-6'` in 2 modules (by design — audit and primary models may diverge Phase 8). `IS_NOT_SYNCED = 0` in 3 tool modules.

**Check 5 — Test helper duplication.** 18 test files, each reimplements `test()` and `assert()`. `env.test.ts` uses a different inline-assertion pattern from the majority wrapped-test-function style.

**Check 6 — Orchestrator decision contract compliance.** 4 of 5 switches over union types use `const exhaustiveCheck: never = X`. Missing from `contextLoader.filterContextForEvent` (if/else over `EventType` with no compile-time exhaustiveness guarantee). All discriminated result types used consistently across draft-producing tools.

### Stage 2 — Per-module deep audit

Performed in 11 conversation chunks. Full findings per module in Section 4.

| Chunk | Modules |
|---|---|
| 1 | Event Classifier; Comms Drafter |
| 2 | Env Config; Sheet Output |
| 3a-i | Primary Call; Model Audit |
| 3a-ii | Approval Gate; Types.ts (partial) |
| 3b-i | Context Loader; Prompt Assembler |
| 3b-ii | Pre-flight; Session Persistence |
| 3c-i | Spec Lookup; Diagnostic Logger |
| 3c-ii | Todo Tool |
| 3d-i | Expense Parser; PO Generator |
| 3d-ii | Orchestrator Tools |
| 3e | tokenUtils; typeUtils; index.ts; system-prompt.v1.0.ts |

### Stage 3 — Synthesis and remediation planning

Cross-module pattern coherence confirmation, Phase 3 → Phase 4 readiness assessment, phase-to-user-deliverable walk (criterion #5), consolidated Notion corrections, Tier 0/1/2/3/4 remediation plan. All in Sections 5 through 8.

---

## Section 4 — Full Findings Index

Findings grouped by module in chunk order. Each module: brief description, then findings table.

Level key: **RED** = bug/data-integrity risk | **R-Adj** = RED-adjacent YELLOW (architectural risk) | **Y** = YELLOW (standards drift / test quality) | **G** = GREEN (confirmed-correct regression guard)

---

### 4.1 — Event Classifier (`eventClassifier.ts`)

255 lines. `classifyEvent` + 5 extractors + `buildMetadata` + `ClassificationError` class. 20 tests.

Notion record drift: Notion said 21 tests, file has 20. No commented-out test, no `.skip`, no test removed mid-file. Notion record drift, not code drift.

| ID | Level | Finding |
|---|---|---|
| EC-1 | G | Source/test alignment is clean. Provider-agnostic by design — `ClassificationSource` names categories (app/email/sms/internal/lifecycle), never vendors. Matches Decisions Log ruling on email provider normalization. |
| EC-2 | Y | `extractLifecycleContent` has a dual path (uses `internalPayload` OR falls back to `body.event`) that no other source has. Both paths are tested, but the file header does not explain why lifecycle is the only source with a fallback. Queue a comment clarification. Best inference: internal scheduler uses payload; external lifecycle webhooks use `body.event`. If that's wrong, the dual path may be dead code. |
| EC-3 | Y | Test helper duplication (cross-file). `assertThrows` in this file is an inline helper. `assertRejects` in `outputRouter.test.ts` is its async cousin. Same job, different signatures, copy-pasted across 18 files. Not blocking Phase 3, but a shared `tests/_helpers.ts` would cut ~50 lines per file and enforce consistent error-checking patterns. |
| EC-4 | Y | No runtime test for the `default:` branch with `const exhaustiveCheck: never = input.source;`. That branch is compile-time protection; at runtime it only fires if someone passes an invalid source via `as any` in a handler. Low severity — the test suite correctly trusts the compiler. Optional defense-in-depth test. |

### 4.2 — Comms Drafter (`commsDrafter.ts`)

106 lines. Pure validation + `buildCommsDraft` returning discriminated union. 26 tests (6 validateToneLevel + 4 validateRecipients + 9 validateCommsDraftInput + 7 buildCommsDraft).

Count reconciled during audit: original run reported 21, actual is 26. Typo in initial paste confirmed by user.

| ID | Level | Finding |
|---|---|---|
| CD-1 | R-Adj | `buildCommsDraft` uses a non-null assertion: `subject: input.subject!.trim()` (line 97). Works because `validateCommsDraftInput` guarantees it, but this is a type-escape hatch — exactly what the audit criterion flagged against. The idiomatic fix: make `CommsDraftInput` a discriminated union on `channel` where the email variant has required `subject`. The `!` disappears, the compiler enforces it, and the run-time check becomes redundant. Recommendation: convert on next touch. Tier 0. |
| CD-2 | G | Tool is genuinely pure. No DB, no external clients, no I/O. Matches settled design contract. |
| CD-3 | G | Fully provider-agnostic. No `twilio`, `gmail`, `smtp`, or `mailgun` anywhere. Channels are `'sms' \| 'email'`; recipients are pre-resolved strings. Criterion #3 satisfied. |
| CD-4 | Y | Tone anchors (`TONE_ANCHOR_NEUTRAL=0`, `TONE_ANCHOR_PEER=5`, `TONE_ANCHOR_FORMAL=10`) are exported as individual constants. Fine, but they're really a data table ("anchor points on a 0–10 scale"). A `TONE_ANCHORS` const object with `{ neutral: 0, peer: 5, formal: 10 }` is more structural and easier to extend. Criterion #4 (hard-coded decision trees over reasoning) applies weakly — this is more stylistic than structural. Not blocking. |
| CD-5 | Y | Test-quality: `makeEmailInput` defaults `toneLevel: 7` — arbitrary value. `makeSmsInput` defaults `toneLevel: 5` — matches the peer anchor, which is meaningful. Email fixture should default to an anchor value or to a documented "typical external contact" tone. 7 is mystery default. |
| CD-6 | G | Edge-case coverage is comprehensive: NaN, whitespace, float, below/above range all tested. Matches Code Gen v2.0 Section 3 test-depth expectation. |

### 4.3 — Env Config (`config/env.ts` + `config/index.ts`)

Two files per the module side-effect separation standard. `env.ts` (109 lines) pure; `index.ts` (52 lines) runtime IIFE. 39 tests (+13 from Notion-recorded 26 — valid coverage expansion: PORT edge cases, whitespace trimming, FCM mixed-case, frozen-result test, error-variable assertions).

| ID | Level | Finding |
|---|---|---|
| ENV-1 | G | Exemplar for the module side-effect separation standard. Pure module has zero side effects. Runtime IIFE in separate file. Tests import from pure module only. This is the pattern every module should match. |
| ENV-2 | Y | Regex duplication across layer boundary. `FCM_KEY_PATTERN = /^[0-9a-fA-F]{64}$/` exists in both `env.ts:57` and `outputRouter.ts:21` (in `validateKeyHex`). Env has a comment explaining why ("config layer must not depend on orchestration") — architecturally correct. But `outputRouter.ts` has no reciprocal comment. If the FCM key format spec changes, only one site will get updated. Minimum fix: add a cross-reference comment at `outputRouter.ts:21`. Bigger fix (defer): extract to `src/utils/hexValidation.ts` as a pure util both layers depend on — that's a shared primitive, not a layer violation. Recommend fixing the comment now; flag the util extraction as a post-audit cleanup. |
| ENV-3 | G | `logStartupStatus` logs key names only, never values. Textbook secrets-safe. |
| ENV-4 | Y | Optional vars listed in two places. The `optional` array inside `logStartupStatus` duplicates the four optional fields in `OtmEnv`. Adding a new optional env var requires updating both. Low risk now (4 vars), but the pattern will break silently as optional vars grow with Phase 4 (Comms). Fix when Phase 4 touches this file. |
| ENV-5 | Y | `requirePort` is a misleading name — it returns a default if absent, throws only on invalid non-empty. Better: `parsePortWithDefault` or `readPort`. Minor. |
| ENV-6 | Y | Test helper pattern inconsistency (cross-file). `env.test.ts` uses global passed/failed counters with `assert`/`assertThrows` directly mutating them. Other test files use a local `test(name, fn)` wrapper. Same job, different style. Reinforces the cross-file finding from Chunk 1 about helper duplication. |
| ENV-7 | G | Frozen-result test verifies `Object.freeze` contract defensively. Good. |
| ENV-8 | G | `EnvConfigError` carries variable + reason but not `sessionId`/`requestId` — correct, because config errors fire at startup before any request exists. Legitimate exception to the "domain errors carry sessionId+requestId" pattern. Worth documenting in Notion as a settled pattern exception. |

### 4.4 — Sheet Output (`tools/sheetOutput.ts`)

84 lines. Pure RFC 4180 CSV builder. `validateSheetTable`, `escapeCsvCell`, `buildCsvRow`, `buildCsvPayload`, `buildSheetOutput`. 22 tests (+2 from Notion-recorded 20 — valid edge case coverage: 'no comment line when title absent' + 'null values produce empty cells').

| ID | Level | Finding |
|---|---|---|
| SO-1 | G | Pure. No Google Sheets API, no Excel library, no file I/O. Provider-agnostic. |
| SO-2 | Y | Possible dead defensive check. `escapeCsvCell` handles both `null` and `undefined`, but `SheetCellValue` type (confirmed in types.ts audit: `string \| number \| null`, does NOT include undefined) does not include `undefined`. The `undefined` branch is dead code and TypeScript should be catching it. |
| SO-3 | R-Adj | Factually wrong source comment. Line 59: "Optional title written as a comment line (`#`) at top — Google Sheets and Excel ignore comment lines on import." This claim is incorrect. CSV has no standard comment mechanism. Google Sheets Import will show `# Expense Report` as a literal row in cell A1. Excel the same. Only tools that explicitly configure `#` as a comment character (postgres COPY, pandas with `comment='#'`) will skip it. The test passes because it just verifies the prefix exists — not that downstream consumers ignore it. Impact on Kurt: any exported sheet will have `# <title>` as a visible first row. Likely not desired. Two fixes: (a) rewrite the comment to match reality (title becomes a visible title row); (b) change behavior to put the title in a different place — e.g., as plain text in cell A1 not prefixed with `#`, or omit title from CSV and pass it as a separate field for the interface layer to handle. Recommendation: (b). The current code is creating a silent surprise in the output. This is exactly criterion #2 — assumption without noted future design. Tier 1. |
| SO-4 | Y | Numeric formatting edge case. `Amount: 47.00` becomes `47` in CSV (JS number coercion drops trailing zeros). Test fixture has `47.00` and tests don't assert it stays `47.00`. For expense data, this is user-facing surprise. The contract is "sheetOutput doesn't format, caller formats." If `expenseParser` doesn't format currency as string before passing, this becomes a silent quality bug. Verify during `expenseParser` audit (Chunk 3). If `expenseParser` does format, document the contract clearly in `sheetOutput` header. If it doesn't, one of the two needs to. |
| SO-5 | G | RFC 4180 compliance is explicit and tested. Double-quote doubling, comma quoting, newline quoting all covered. |
| SO-6 | Y | Test-quality: 'no comment line when title absent' checks `!csv.startsWith('#')`. Correct for current behavior but weak against malformed output — a comment line mid-file would still pass. Minor. |
| SO-7 | Y | Test-quality: 'csv is RFC 4180 parseable (round-trip check)' doesn't actually round-trip (parse the CSV back). It just verifies quotes are doubled in the output. Either rename ('RFC 4180 quote doubling') or strengthen to a real round-trip by adding a simple CSV parser in the test. Naming inaccuracy is misleading if someone reads the test name as a contract. |

### 4.5 — Primary Call (`primaryCall.ts`)

192 lines. `primaryCall`, `accumulateDeltas`, `sanitizeErrorMessage`, `PrimaryCallError`, `StreamHandle`. 10 tests (9 active + 1 skipped integration).

Label drift: Notion said 10/10; reality is 9 active + 1 designed-skip.

| ID | Level | Finding |
|---|---|---|
| PC-1 | G | Model/token/temp/timeout all named constants. Phase 8 calibration hooks are exactly where they should be. |
| PC-2 | G | `StreamHandle` structural interface isolates SDK type churn. Exemplar pattern. |
| PC-3 | G | Timeout properly aborts the in-flight stream (line 102) — not just rejects the promise. Many implementations leak the stream on timeout; this doesn't. |
| PC-4 | G | `sanitizeErrorMessage` is exported, pure, and targets three specific patterns (`Bearer`, `sk-*`, `authorization` headers). First-line-only + 200-char cap limits blast radius. |
| PC-5 | Y | No test for `sanitizeErrorMessage`. The function is exported for isolated testing (the header says so) but has no test. Bearer-token pattern, `sk-` pattern, auth header pattern, first-line extraction, 200-char cap — five behaviors, zero tests. Queue for the remediation pass. |
| PC-6 | Y | Timeout race doesn't clean up on SDK rejection. If `finalMessage()` rejects fast (before the race resolves either way), the timeout handle is cleared in the catch — good. But the stream was created successfully and never aborted. If the stream holds any open connection, it may linger. Probably handled by the SDK, but worth confirming. Low risk. |
| PC-7 | Y | Test-quality: Happy-path test uses the mock. Test 6 asserts `responseText === 'The PM interval for the 6700 is 250 hours per spec.'` — but this is only true because the mock fires callbacks in a specific order. The skipped integration test is the real validation. Not wrong, just worth knowing: the passing "happy path" test validates the mock as much as it validates the code. |
| PC-8 | Y | Log content concern. Line 94: `estimatedInputTokens=${assemblerOutput.tokenEstimate}` — fine. But the completion log at line 154 logs `inputTokens`/`outputTokens` from the API response. Acceptable for debug, but if logs are retained 180 days and someone does traffic analysis, token counts per request expose message size patterns. Defensive info-leakage concern, low urgency. Flag only. |
| PC-9 | G | `accumulateDeltas` as a tiny pure function tested in isolation is the right pattern — the whole reason the "middle path" test strategy in the Decisions Log works. |

### 4.6 — Model Audit (`modelAudit.ts`)

306 lines. `shouldRunModelAudit`, `buildAuditPrompt`, `parseAuditResponse`, `runModelAudit`, `ModelAuditError`. 24 tests.

| ID | Level | Finding |
|---|---|---|
| MA-1 | G | `MODEL_AUDIT_SYSTEM_PROMPT` is exported. Transparency standard met — audit prompt is inspectable and testable. |
| MA-2 | G | `shouldRunModelAudit` is explicit about which conditions were dropped from the original 5 and why. The comment calls out that conditions 1 and 2 are not evaluable without response content. That's exactly the kind of doc-code fidelity criterion #2 asks for. |
| MA-3 | G | `parseAuditResponse` enforces non-empty `issue` and `correction` on non-pass results (lines 177–189). This is the Phase 2 audit fix landing correctly. |
| MA-4 | R-Adj | Hardcoded OTM v1 domain language in the audit system prompt. Line 33: "You are a compliance auditor for an AI assistant used in railroad maintenance field operations." Line 39 criterion 1: "Every field-specific claim (part numbers, specs, costs, serial numbers, schedules, compliance figures, contact details)" — this is the mechanic/coordinator scope, not universal. Line 40 criterion 4: "direct peer vs. upward reporting vs. vendor" — this is OTM v1's specific tone taxonomy. Criterion #3 violation — not edition-agnostic. OTM v2 (Supervisor) won't use this prompt as-is; it'll need different categories. Contrast with `shouldRunModelAudit`, which is fully generic. The fix: the system prompt should be edition-injected, same way `promptAssembler.ts` handles the primary system prompt (per the Decisions Log: "Edition-specific config injected via EditionConfig interface — system prompt path..."). Right now it's inline. Tier 1. |
| MA-5 | Y | `buildAuditPrompt` has a magic formatting literal. Line 127: `m.position, m.name, m.serialNumber` — this is a concrete shape of `relevantMachines` entries. If `types.ts` changes the consist context shape, this breaks silently (only caught if a test fixture happens to test it). Coupling is reasonable for Phase 3, but flag as a type-coupling point. |
| MA-6 | Y | Default fallback `'unknown'` on channel. Line 108: `const channel = event.metadata.channel ?? 'unknown';` — criterion #4 (exhaustive hard-coded trees) is violated mildly. `EventMetadata.channel` shape in `types.ts` should be a discriminated union over the 5 classification sources we saw in Event Classifier. If so, `??` is dead code. If it's optional, the `'unknown'` sentinel is a silent downgrade that could reach the audit model and produce noise. Verify when auditing `types.ts`. |
| MA-7 | G | `sanitizeErrorMessage` reused from `primaryCall`. Not duplicated. Cross-module reuse of a cross-cutting sanitizer — textbook. This is one of the things done right that Chunk 2's ENV-2 (the `FCM_KEY_PATTERN` duplication) wasn't. |
| MA-8 | Y | `shouldRunModelAudit` signature takes three large objects. Easier to call, but every caller must have all three ready. If any caller only has two (e.g. a test scenario), ergonomic friction. Minor. |
| MA-9 | Y | Test-quality: Tests don't cover the `[INTEGRATION — skipped]` symmetry. Primary Call has an explicit skipped integration test. Model Audit doesn't. For parallelism and Phase 9 calibration planning, add the same skipped-integration marker. |
| MA-10 | G | Timeout handling mirrors Primary Call exactly — same pattern, same cleanup, same error shape. Cross-module consistency. |

### 4.7 — Approval Gate (`approvalGate.ts`)

298 lines. `buildApprovalMessage`, `buildRegenLimitMessage`, `sendApprovalRequest`, `sendRegenLimitMessage`, `waitForDecision`, `submitFeedback`, `runApprovalGate`, `ApprovalGateError`. 22 tests (Notion 19 → now 22 after the retroactive `submitFeedback` `token: undefined` path fix. Three tests added by design — explicitly noted in Task Backlog).

| ID | Level | Finding |
|---|---|---|
| AG-1 | G | Listener cleanup is correct. Both the resolve path and timeout path call `cleanup()` which removes the listener AND clears the timeout. Both paths are explicitly tested. |
| AG-2 | Y | `FEEDBACK_GITHUB_REPO = 'leensee/onetrackmind'` is hardcoded OTM v1 client-specific literal. Criterion #3 — not edition-agnostic. `types.ts` line 34 has `AuditConfig.githubRepo?` as an optional field, so the config interface is ready; the gate just isn't consuming it. The Decisions Log entry for audit failure feedback specifies `leensee/onetrackmind` as the target, but a Supervisor Edition for a different company probably wouldn't route feedback to the same repo. Fix direction: accept `githubRepo` via `AuditConfig` (already typed), pass through via the `submitFeedback` signature. Default to `'leensee/onetrackmind'` for OTM v1 is fine — just make it injectable. Tier 1. |
| AG-3 | R-Adj | Feedback fallback is structural dead code right now. The `fallbackEmailFn?` is typed as `() => Promise<void>` — no payload passed in. That means the fallback email must be constructed by the caller, who needs to serialize the payload themselves. Three consequences: (a) duplicate payload-formatting logic across caller and gate; (b) caller can get the payload serialization wrong and silently send wrong data; (c) there's no structural link between the payload the gate receives and the email the fallback sends. Better signature: `fallbackEmailFn?: (payload: FeedbackPayload) => Promise<void>` — forces the caller to receive the actual payload and enforces contract parity. The tests pass because they use no-payload fallbacks, but that's not a realistic integration. Tier 0. |
| AG-4 | Y | GitHub issue title is hardcoded format. Line 219: `` title: `[audit-failure] ${payload.sessionId}` ``. For OTM v1 fine; for another edition with different ownership, the title prefix shape might change. Less severe than AG-2 because it's purely cosmetic, but same class of issue. |
| AG-5 | Y | `submitFeedback` throws `ApprovalGateError` with `requestId: payload.sessionId`. Line 213: `payload.sessionId` is passed as the `requestId` parameter of the error constructor. This is a type mismatch at the semantic level even though both are strings. If log grepping for a specific `requestId`, feedback errors won't show up. Test at line 341 even asserts `err.requestId === SESSION_ID` — the test is validating the bug. Fix: feedback payloads don't have a `requestId` at this point in the flow (the regen sequence involved multiple request IDs), so either add `requestId: string` as a required field to `FeedbackPayload` (use the final manual regen's `requestId`, or a new feedback-specific UUID), or change the error class to carry `sessionId` instead of `requestId` for this specific cause. |
| AG-6 | G | Test cleanup is thorough — listener count asserts prove no memory leaks on either path. |
| AG-7 | Y | `ApprovalDecision` union has 7 values across two message types. `approve`/`reject`/`edit` belong to `approval_required`; `try_again`/`use_as_is`/`drop`/`send_feedback` belong to `regen_limit`. Anything consuming `ApprovalDecision` has to know which subset applies based on context. Better: two separate union types (`ApprovalResponse` + `RegenLimitResponse`). Testable, typed separation. Not blocking, but it's a class of "one type, two actual contracts" that future callers will stumble over. |
| AG-8 | G | `fetch` used directly (Node 18+) — no HTTP client dependency added. Matches "no new deps" rule. |
| AG-9 | Y | No retry on GitHub API transient failures. A 500 or network blip aborts to fallback immediately. For a feature that fires rarely (regen limit reached) and is low-cost to retry, a single retry with 1s backoff would reduce fallback noise. Defer to Phase 4 when retry patterns are established for comms. |
| AG-10 | Y | Module embeds logging I/O and pure functions in same file. The side-effect separation standard (established by env config) would suggest `approvalGate/pure.ts` (message builders, `waitForDecision`) + `approvalGate/index.ts` (`submitFeedback` with fetch side effect). Not a Phase 3 blocker, but the standard was retroactively applied to config — consistency argues for retroactive application here too. Queue for cleanup. |

### 4.8 — Types (`types.ts`) — structural audit findings

Shared type definitions — discriminated unions, tool input/output types, event types, session types. Partial audit performed during approval gate chunk to resolve cross-references; full types audit queued as standalone module pass.

| ID | Level | Finding |
|---|---|---|
| T-1 | Y | Confirms MA-6 as real. `EventMetadata.channel?: string` (line 57) — channel is both optional AND an unconstrained string. The Model Audit's `event.metadata.channel ?? 'unknown'` fallback is necessary given this type. But either `channel` should be required (with the 5 classification sources as a union) or the fallback should be a specific `"MISSING_CHANNEL"` sentinel for observability. The `'unknown'` string gets embedded in the audit prompt to Claude, which is noise. |
| T-2 | Y | Confirms SO-2 as real dead code. `SheetCellValue = string \| number \| null` (line 511) — does NOT include `undefined`. But `sheetOutput.ts` `escapeCsvCell` handles `undefined` explicitly. Dead defensive code. Either remove the `undefined` branch or add `undefined` to the type. |
| T-3 | Y | Validates MA-5. `MachineRef.position: number, name: string, serialNumber?: string` — the exact shape Model Audit's `buildAuditPrompt` inlines. Coupling is real but the shape is stable enough for Phase 3. Flag stands as future-proofing concern. |
| T-4 | Y | `ActiveFlag.type` has 4 values (`'safety' \| 'push' \| 'pull' \| 'audit'`). `modelAudit.shouldRunModelAudit` only checks for `type === 'safety'`. Is the "active unacknowledged safety flag" skip condition supposed to be "any unacknowledged flag" or specifically safety? Decisions Log says "no active unacknowledged safety flags." So the current impl is correct. But an `audit` flag type being unacknowledged is implicitly acceptable for skipping. Is that intended? Queue question for clarification. |
| T-5 | R-Adj | `CommsDraftInput.subject?: string` with comment "required for email, ignored for sms" — which matches CD-1's finding exactly. The discriminated-union refactor (separate `SmsDraftInput` and `EmailDraftInput` types) would eliminate the `!` non-null assertion in `commsDrafter.ts` line 97. The fix belongs in `types.ts`, not the tool. Tier 0 (shared fix with CD-1). |
| T-6 | G | `SpecLookupResult` 4-branch discriminated union is a model citizen. Every caller forced to handle each case. Matches the retrofit commit. |
| T-7 | G | `SessionLogEntryType` union and `schemaVersion` field on `SessionLogEntry` — replay-safe design. |
| T-8 | G | `EditionConfig`, `ContextFieldConfig`, `ContextWindowConfig`, `AuditConfig` — all edition-config interfaces are properly typed. Problem from AG-2 is not missing type, it's missing consumption. |
| T-9 | Y | `ToolCallStatus` is a 6-variant union where three variants (`approved`/`direct_write`/`read_result`) carry `result: unknown`. `unknown` loses type safety at the boundary. Callers have to type-cast. Consider `result: ToolResultByName[T['tool']]` — a lookup-type mapping from tool name to its output type. More complex but restores type safety end-to-end. Phase 4 concern, not Phase 3 blocker. |
| T-10 | R-Adj | `ToolCallInput` variant `'sheet_output'` has `input: SheetTable` (line 641). But `SheetTable` isn't a validated input — it's the raw table shape. Every other tool input has its own `*Input` wrapper (`TodoCreateInput`, `CommsDraftInput`, etc.) with `sessionId` + `requestId` baked in. Sheet output tool calls will be un-traceable because the input type has no session/request ID. Either wrap in `SheetOutputInput { table: SheetTable; sessionId: string; requestId: string }` or add a comment explaining why sheet output doesn't need tracing. Tier 1. |

### 4.9 — Context Loader (`contextLoader.ts`)

325 lines. `loadContext`, `fetchStyleProfile`, `fetchUserSettings`, `filterContextForEvent`, `machineIsReferenced`, `coerceSetting`, `ContextLoaderError`, `DEFAULT_USER_SETTINGS`. 15 tests.

| ID | Level | Finding |
|---|---|---|
| CL-1 | G | DB client injected (Supabase). Per-call statelessness maintained. Matches settled design. |
| CL-2 | G | `fetchStyleProfile` + `fetchUserSettings` parallelized via `Promise.all`. Matches Decisions Log note. |
| CL-3 | G | First-session-state (empty rows) is explicitly non-error. Empty string and `DEFAULT_USER_SETTINGS` applied. |
| CL-4 | Y | `DEFAULT_USER_SETTINGS.timeZone: 'America/Chicago'` is a hardcoded OTM v1 assumption. Decisions Log settings list says "field crews travel; required for accurate HOS, digest timing" — meaning the default should be what? There's no universal correct timezone default. For a new user with no setting, `'America/Chicago'` is chauvinistic. Options: (a) require timezone at account creation (no default), (b) default to UTC as neutral, (c) make default edition-configurable. Criterion #3 concern — this is edition-coupled behavior, not edition-agnostic. Related: `shiftStartTime: '06:00'` has the same issue, but shift time actually has a plausible "dawn-ish" default. Timezone doesn't. |
| CL-5 | Y | `coerceSetting` silently returns `[]` on malformed JSON for array keys. Line 117-121: `try { JSON.parse(raw) ... } catch { return []; }` — bad row produces valid-looking empty array. If `styleExclusions` column has a corrupted value, user's exclusion rules vanish silently. Criterion #2 — assumption without explicit failure path. Should throw `ContextLoaderError` with a key label, or at minimum log `console.warn`. |
| CL-6 | Y | `coerceSetting` silently accepts non-array JSON for array keys. Line 120: `Array.isArray(parsed) ? (parsed as string[]) : []` — if DB has `{}` or `"exclusion1"` (not an array), returns `[]`. Same silent-drop problem. |
| CL-7 | Y | `coerceSetting` for numeric keys uses `Number(raw)` unchecked. Line 113: `Number("abc")` returns `NaN`, and `NaN` flows through as a valid-looking number. If `digestThresholdHours` has a corrupted value in DB, logic like "fires after 8 hours" becomes "fires after NaN hours" and timer comparisons break silently. Validate with `isFinite` or reject. |
| CL-8 | Y | `coerceSetting` does not validate string-union values. Lines 125-126: `voiceResponseMode` is typed as `'always' \| 'wake_word_only' \| 'never'`. If DB has `'sometimes'`, the coercer returns it unchanged, and the TypeScript type lies — runtime value is outside the union. Validation would be: enumerate each union member's allowed values and reject otherwise. Adds code, but catches data corruption. |
| CL-9 | Y | The fallback warning at line 300 triggers on valid event types. The `EventType` union in `types.ts` has 5 values, and the function handles all 5 explicitly (`system_trigger`, `session_lifecycle`, `inbound_sms`, `inbound_email`, `user_message`). The fallback is effectively unreachable — TypeScript would catch any missing case if the switch used an exhaustive discriminator. Better: make it a compile-time `never` check like the event classifier's `default` branch. Right now it's dead code disguised as defense. |
| CL-10 | Y | Machine-reference detection is sensitive to capitalization inconsistencies. `lower.includes(machine.name.toLowerCase())` — if `machine.name` contains a period (e.g. `'3300 Jr. Tamper'` as in fixture) and the user types `'3300 Jr Tamper'` (no period), no match. Common-name mismatch from Notion (`'Harsco Jackson 3300 Jr Tamper'` vs DC docs `'Pup Tamper'`) wouldn't resolve. Flagged in the settled design as "partial/token matching deferred to Phase 8 calibration" — so not a violation. Noting for Phase 8 scope. |
| CL-11 | R-Adj | Machine-reference match checks `#${pos}` — collides with US phone number formatting and HGPT column numbers. Example: text `"ticket #14"` matches position 14. Text `"call the office at #13 ext 2"` matches position 13. Low likelihood with Kurt's peer-register, but in `inbound_sms` from external vendors? Higher risk. Either require a bounded prefix (`\bpos #${pos}\b`, `\bposition #${pos}\b`) or drop the `#N` pattern entirely and rely on `pos N`/`position N`. This is criterion #4 territory — the matching heuristic is where AI-model reasoning takes over because deterministic detection is fragile. Fix direction: tighten the patterns to word-bounded regex. Tier 1. |
| CL-12 | Y | `_editionConfig` parameter is unused (line 183 `filterContextForEvent`). Comment says "reserved for future edition-specific filter tuning." Valid. Keep the comment, but name it `editionConfig` per TypeScript convention and reference it in at least a no-op `void editionConfig;` to signal intentional unuse. Or genuinely use it for the PHP of criterion #5 — Phase 6 Interface design decisions flag edition-specific filter tuning as future work, so this is an unresolved design hook. |
| CL-13 | Y | Duplication between `machineIsReferenced` and the inline filtering in lines 227-231 / 243-251. The `machineIsReferenced` helper isn't reused for `openItems` content matching or for flag content matching. Item content is checked with `includes(m.name.toLowerCase())` + `` includes(`pos ${m.position}`) `` + `` includes(`#${m.position}`) `` — same pattern, reimplemented inline. Should all call `machineIsReferenced` (after generalizing signature to take `(machine, text)` which it already does). Reduces drift risk. |
| CL-14 | Y | Test-quality: No test for the malformed-JSON silent-drop path (CL-5). No test for NaN coercion (CL-7). No test for out-of-union string (CL-8). These are the data-corruption surfaces, and they're untested. |
| CL-15 | Y | `SettingRow` type declared inside the function — one-line type declaration at line 104. Should live in `types.ts` if it represents a DB row shape, or at module scope. Minor style. |

### 4.10 — Prompt Assembler (`promptAssembler.ts`)

198 lines. `assemblePrompt`, `buildStyleBlock`, `buildContextBlock`, `trimHistory`, `loadSystemPrompt`. Token utilities imported. 10 tests.

| ID | Level | Finding |
|---|---|---|
| PA-1 | G | Edition-agnostic design is clean. System prompt path, style table, token budgets all via `EditionConfig`. |
| PA-2 | G | History trimming is explicit, logged, non-silent. Current input guaranteed-present test enforces invariant. |
| PA-3 | G | Unconditional dynamic-injection metric log (Phase 2 audit fix landed correctly). |
| PA-4 | Y | `loadSystemPrompt` uses `require()` at runtime. Line 102: `require(resolvedPath) as unknown` with an `eslint-disable` comment. This works in CJS but is a layer violation of module side-effect separation — the assembler dynamically loads a module at call time, not at import time. Consequences: (a) the loaded module isn't tree-shakeable; (b) if the same path is loaded twice, CJS caches it, so hot-reload doesn't work; (c) the require resolution depends on working directory, not just `PROJECT_ROOT`. Alternative: pass `systemPromptText` directly on `EditionConfig` instead of a path — orchestrator reads the file once at startup. This is a bigger architectural question, queue for Stage 3. |
| PA-5 | Y | `loadSystemPrompt` error handling flattens useful detail. Line 113-116: the outer catch wraps all errors (module-not-found, wrong shape, filesystem error) into a single generic `Error`. Orchestrator can't distinguish "config path typo" from "corrupt module" from "missing export." Flag as `ContextLoaderError`-style domain error with structured cause. |
| PA-6 | Y | No test coverage for `loadSystemPrompt` error paths. Missing module, module without `SYSTEM_PROMPT` export, `SYSTEM_PROMPT` not a string — all three failure modes are written in source but none are tested. |
| PA-7 | Y | Magic literal `+ 4` for current input token budget. Line 160: `estimateTokens(currentInput.rawContent) + 4`. The `+4` is tokenizer overhead for role tags — should be a named constant with a comment explaining the source of the number. Currently it's a floating magic number with no test. |
| PA-8 | Y | `buildContextBlock` duplicates `buildAuditPrompt` (`modelAudit.ts`) formatting logic. Both iterate `activeFlags`, `openItems`, `consistContext` and format them as labeled sections. Same source data, two formatters, slightly different output. If one changes the format, the other won't. Candidates for a shared pure `formatters.ts` that both consume. |
| PA-9 | Y | `AssemblerInput` has `currentInput: ProcessedEvent` but assembler only uses `currentInput.rawContent` and `currentInput.timestamp`. Tight coupling to the full event type when only two string fields are needed. Interface should take `{ rawText: string; timestamp: string }` — lets non-event sources (e.g. test fixtures, replay paths) call assembler without constructing a full `ProcessedEvent`. |
| PA-10 | Y | `PROJECT_ROOT` computed via `path.resolve(__dirname, '..', '..')`. Works when `src/orchestration/promptAssembler.ts` is at a specific depth. If the file is ever moved, this silently breaks. Better: pass `projectRoot` via config, or use an explicit `PROJECT_ROOT` env var, or base it on `process.cwd()`. Coupling of module location to filesystem layout is fragile. |
| PA-11 | G | Token budget resolution is explicit at call time; edition overrides work as designed. |
| PA-12 | Y | Test-quality: Happy-path test at line 77-86 uses `baseInput` which has a non-trivial `styleProfile`. So the "assembles without error" test covers both the empty and non-empty style path implicitly. Would be cleaner to have an explicit `emptyStyleProfile` baseline and layer style injection into its own test. |
| PA-13 | Y | No test asserting the `[STYLE PROFILE]` block comes before `[SESSION CONTEXT]` in output. Current tests check each is present. Order is important (style profile sets tone before context is applied). Worth asserting explicitly. |

### 4.11 — Pre-flight (`preflight.ts`)

327 lines. 6 rule functions + `runPreflight` entry. Pure, synchronous, all heuristics inline. 35 tests.

| ID | Level | Finding |
|---|---|---|
| PF-1 | G | Module is pure and synchronous per design. No DB, no external calls. |
| PF-2 | G | Rule 3 filter length `>= 4` fix from Phase 2 audit is in place. |
| PF-3 | G | `postApproval` suppression correctly applied to Rules 1+2, tested. |
| PF-4 | G | Rule 4 bidirectional serial match (`v.includes(candidate) \|\| candidate.includes(v)`) correctly handles both `SN153640↔153640` and `153640↔SN153640` directions, tested. |
| PF-5 | G | `pass` determination correctly distinguishes warn (passes) from flag/hold (fails). Tested explicitly. |
| PF-6 | R-Adj | Rule 1 `AUTONOMOUS_PATTERNS` is English-only and informal-style-only. The 10 phrases are all specific English idioms: `"i've sent"`, `"message sent"`, etc. If Kurt's style profile drifts toward tighter language (`"sent"`, `"done"`, `"completed"`), no pattern matches. Inversely, a perfectly normal phrase like `"The email sent successfully last night per the log"` is false-positive territory. Criterion #4 — this rule reasons by phrase-matching where an assertion-based approach would be exhaustive. Better mechanism: orchestrator tracks whether an action was actually invoked (tool call fired, approval gate cleared), and Rule 1 checks that truth instead of guessing from text. The text check is a cheap heuristic that's insufficient for the safety claim it's making. Keep as defense-in-depth, but not as primary. |
| PF-7 | R-Adj | Rule 2 gate-marker phrases are limited English idioms too. `"approve"`, `"send this"`, `"ready to send"`, etc. — 8 phrases. A genuine outbound draft that says `"Let me know if this looks right before I route it"` passes Rule 2 without any listed marker. Same root issue as PF-6 — text heuristic where state check would be exhaustive. Orchestrator already knows whether the approval gate was invoked; this rule should query that state, not scan text. |
| PF-8 | Y | Rule 3's `significantTerms.some(term => lower.includes(term))` is overly permissive. A safety flag `"Hydraulic line visibly leaking on pos 13"` produces significant terms `[hydraulic, line, visibly, leaking, pos]`. The response `"Hydraulic fluid types explained"` contains `hydraulic` → Rule 3 passes. The rule is supposed to verify safety is addressed, not just topically adjacent. Classic false-negative — the rule's bar is too low for its safety claim. Options: (a) require multiple term matches, not just one; (b) require the flag's unique content phrase (not noise words); (c) escalate to model-level check for semantic addressing. Queue for Phase 8 calibration. |
| PF-9 | Y | Rule 3 exits on first unmatched flag. `return;` at line 118 means if flag 1 is addressed and flag 2 is not, the rule still matches on flag 1, skips flag 2. Multi-flag scenarios are under-tested (one-flag fixture only). Fix: iterate all unmatched flags and push all findings, or document the "first-fail" semantics explicitly. |
| PF-10 | Y | Rule 4 regex state — `two new RegExp(pattern.source, 'g')`. Lines 166, 188. The literal patterns declared at module scope include `/g` flag, but the function creates fresh instances to avoid `lastIndex` carry-over between invocations. This works, but is awkward — either (a) define patterns without `/g` and add it at construction, or (b) reset `lastIndex = 0` before the while loop. Document the pattern either way. |
| PF-11 | Y | Rule 4 phone exclusion is a 27-char window around the match. `Math.max(0, matchIndex - 12) + Math.min(text.length, matchIndex + 15)`. The asymmetric window (12 before, 15 after) is odd — comment doesn't explain. Also, `"ext 55012"` test passes, but `"Call the 24-hour hotline: 8005551234"` has no marker within 12 chars of the digit start, so phone exclusion fails → false positive serial flag. The window should be generous enough to catch natural phone references, or the markers should include digit-sequence shape (e.g. 10+ consecutive digits = phone, regardless of context). |
| PF-12 | Y | Rule 4 flags only the first unverified serial. `return;` at line 180 / 198. If a response contains three hallucinated serials, only one is reported. Enforces a short list of flags per run, which is good for user-facing feedback, but fails to give the model audit or regen pass a full picture. Consider continuing through all matches but capping at 3 flags. |
| PF-13 | Y | Rule 5 `ESTIMATION_MARKERS` includes `"around"` and `"about"` — same over-matching problem as PF-8. Response: `"Kurt, I checked around $500 in past invoices"` contains `"around"` at sentence level → Rule 5 passes even though the $500 claim isn't an estimate. Narrow the markers to ones that grammatically modify the number (`~`, `"approximately $N"`, `"about $N"`), not just sentence-level presence. |
| PF-14 | Y | Rule 5 sentence split via `/[.!?\n]+/`. Fails on dollar amounts inside sentences that use the period as a decimal — `$1,200.50` could split badly on some edge cases. The response sentence containing the cost might be truncated. Low-likelihood but worth a regex tightening to exclude `.\d`. |
| PF-15 | Y | Rule 6 markdown indicators are a subset of `formatForSms` strippers in `outputRouter.ts`. `outputRouter` strips `##`, `**`, backtick, lists, tables. Reimplemented detection logic. Part of shared-formatters remediation (folded into OT-9 Tier 0 commit). |
| PF-16 | Y | Rule 4 `UNVERIFIED_SERIAL_NUMBER` — doesn't check support equipment serials. `verifiedSerials` is built only from `consistContext.relevantMachines`. Support equipment (Knox Kershaw 12-12, serial `12-1350-22` per Notion) is tracked separately in `fleet_master`. A response citing `12-1350-22` without consist relevance → false-positive flag. Matters when Kurt asks about support equipment directly. Missing data source in the rule's verification logic. |
| PF-17 | G | Rule 6 is the only warn rule — all others are flag or hold. The "pass=true on warn only" design implies SMS markdown violations don't block. That matches the intent (warn user, don't stop), but worth documenting in the module header so future rules know the severity semantics. |
| PF-18 | Y | No test for multiple rules firing simultaneously. E.g. autonomous action + safety flag not surfaced should both appear in `flags[]`. Currently untested. |

### 4.12 — Session Persistence (`sessionPersistence.ts`)

535 lines. `serializePayload`, `writeLogEntry`, `updateStateObject`, `replaySessionLog`, `openSession`, `closeSession`, `purgeExpiredLogs`. SQLite client injected. 20 tests.

| ID | Level | Finding |
|---|---|---|
| SP-1 | G | `MAX_RETENTION_DAYS = 180` enforced in `purgeExpiredLogs` via `Math.min(retentionDays, MAX_RETENTION_DAYS)`. Phase 2 audit fix landed correctly. |
| SP-2 | G | Parameterized SQL throughout. No string interpolation. Matches Code Gen v2.0 baseline. |
| SP-3 | G | Exhaustive switch on `SessionLogEntryType` with `const exhaustiveCheck: never`. Correct pattern. |
| SP-4 | G | Return-not-throw for `writeLogEntry`, `updateStateObject`, `closeSession`. Matches orchestrator decision contract. |
| SP-5 | G | Schema version check skips unknown versions (forward-compat). Tested. |
| SP-6 | R-Adj | `replaySessionLog` uses bare `as string` casts without validation. Lines 279, 288, 295, 304-308, etc. — every `data['fieldName'] as string` is an unchecked cast. If the payload was written pre-validation (older entry) or via a path that bypassed `serializePayload`, the field could be `undefined` or of wrong type, and the replay silently produces a `SessionState` with `undefined` in typed string fields. Zero runtime check. Since the orchestrator contract says "never interpret prose, never silently fail," this is a gap. Fix direction: add a `typeof data['field'] !== 'string' { console.warn; continue; }` guard per field access, or extract typed accessors (`getString(data, 'editionId')`). |
| SP-7 | R-Adj | `replaySessionLog` silently skips unparseable payloads. Lines 261-267: `try { JSON.parse } catch { console.warn; continue; }`. Warn-and-continue hides real corruption. If 5 of 10 entries are corrupted, the resulting state is silently incomplete. A corrupted log is a serious event — should surface, not warn. At minimum, return a per-entry status in the replay result. |
| SP-8 | Y | `replaySessionLog` return `isFromLogReplay: true` is mutated on line 378-380 in `openSession`. The state is first created via replay with `isFromLogReplay: true`, then `openSession` reads from state cache and sets `state.isFromLogReplay = false`. The "is this a replay?" signal is set by the caller, not the producer. Inconsistent ownership — confusing. One of them should own this flag definitively. Suggest: state cache hit → `isFromLogReplay: false`; replay path → `true`; both set by `openSession`, removed from `replaySessionLog`. |
| SP-9 | Y | `openSession` has a subtle ordering issue. It writes a `session_open` log entry BEFORE calling `purgeExpiredLogs`. If the purge deletes entries older than retention, the `session_open` entry is never at risk because it's just-written. But a prior `session_open` for the same session, if it existed and was old, would be deleted — leaving the log with only the new `session_open` and then whatever came before. Probably not a real scenario (sessions don't normally reopen after retention), but worth considering. Low risk. |
| SP-10 | Y | `purgeExpiredLogs` catch block logs but does not surface failure. Lines 483-487: if the purge fails (disk error, etc.), it returns `{ entriesDeleted: 0, sessionsDeleted: 0, purgedBefore: cutoff }` as if successful. Silent failure pattern. Since purge is non-fatal for the session but is a compliance concern (retention must run), the caller should know. Return `{ ... purgeFailed: true; error: string }` or a discriminated union. Related to Security & Compliance Policy v1.0 retention requirements. |
| SP-11 | Y | `SessionLogEntryType` missing entries for Phase 3 additions. `PAYLOAD_SCHEMAS` has 8 entries; `SessionLogEntryType` in `types.ts` has 8 matching values. But Phase 3 added: todo create, todo update, po generate draft, comms draft, diagnostic log events. None of those are logged to `session_log` — they go to their own tables. OK, but worth documenting explicitly: `session_log` captures conversation flow + approval events; tool-layer writes go elsewhere. Otherwise, someone looking at `session_log` alone gets an incomplete history. |
| SP-12 | Y | `purgeExpiredLogs` uses two separate queries for count + delete. Lines 450-459 and 472-479. Race condition window — if an entry is written between count and delete, count is stale. Not a correctness bug (delete still deletes what matches at delete time), but the returned `entriesDeleted` doesn't match reality if writes are concurrent. Either use `DELETE ... RETURNING` (SQLite 3.35+), or document that the count is best-effort. Same issue for `sessionsDeleted`. |
| SP-13 | Y | `replaySessionLog` pushes to arrays with `satisfies Message` / `satisfies ActiveFlag`. The `satisfies` keyword is great for type-checking, but the values still have unchecked `as X` casts upstream. Type safety illusion — the `satisfies` check runs on values that may include `undefined` from bad casts. |
| SP-14 | Y | No test for the `route_result` entry type in replay. `PAYLOAD_SCHEMAS` has it, the switch has it, but the replay test covers only `session_open`, `user_message`, `assistant_response`, `flag_raised`, `flag_acknowledged`. Missing: `approval_decision`, `route_result`, `session_close` in the replay test. |
| SP-15 | Y | Mock `SqliteClient` uses `sql.trim().split('\n')[0]` as the cache key. Fragile — if a SQL query is reformatted, keys change. Tests that use `makeMockDb({ rows: {...} })` depend on specific formatting. |

### 4.13 — Spec Lookup (`tools/specLookup.ts`)

273 lines. `specLookup` + `resolveMachineIdentifier`, `mapRosterRow`, `mapSpecRow`, `buildSpecLookupResult`, `fetchRoster`, `fetchSpecRows`. 35 tests.

| ID | Level | Finding |
|---|---|---|
| SL-1 | G | 4-branch `SpecLookupResult` discriminated union with explicit caller handling. Return-not-throw pattern. Retrofit landed correctly. |
| SL-2 | G | EAV model exposed via `SpecEntry`. `isGap` as first-class field. `unknownKeys` distinct from `isGap`. Matches Decisions Log. |
| SL-3 | G | Resolution steps 1→5 are ordered and short-circuit — deterministic, no AI reasoning. Criterion #4 satisfied. |
| SL-4 | G | Narrow `SpecLookupDbClient` interface (only `all`) — tighter than shared `SqliteClient`. Dependency minimization. |
| SL-5 | G | Common names data-driven from roster — no hardcoded machine names. Criterion #3 satisfied. |
| SL-6 | Y | `mapRosterRow` silently swallows malformed JSON. Line 54-61: `try { JSON.parse } catch {}` returns `[]` for `commonNames`. Same silent-drop pattern as CL-5/6/7. Comment says "log at call site" — but the call site (`fetchRoster` line 192) only logs on exception, not on silent empty-array. Malformed `common_names` JSON produces a machine with empty `commonNames[]` → step 4/5 resolution always misses it → user gets "unknown_machine" for a machine that exists. Fix: `mapRosterRow` should warn-log when the JSON parse fails, not silently return empty. Or return `{ entry, warning? }` so caller can route the warning. |
| SL-7 | Y | Type mismatch at `rows.map(row => { try { return mapRosterRow(row); } catch })`. Line 188-196. `mapRosterRow` never throws — the try/catch is defensive code for an impossibility. The `.filter((m): m is MachineRosterEntry => m !== null)` then filters out a null that can't happen. Dead code. |
| SL-8 | Y | SQL `NULLS LAST` clause may not be SQLite-compatible. Line 187: `ORDER BY machine_type ASC, position ASC NULLS LAST`. SQLite supports `NULLS LAST` since 3.30 (2019) — fine in practice, but the `.env.example` doesn't pin SQLite minimum version anywhere and Drift wrapper behavior is edition-dependent. Document or sort in-code after fetch for portability. |
| SL-9 | Y | `resolveMachineIdentifier` step 5 uses bidirectional substring without bounding. Line 128-132: `cnLower.includes(qLower) \|\| qLower.includes(cnLower)`. A query `"a"` would match any common name containing `"a"`. Step 5 intent is fuzzy common-name matching but the bar is too low. Consider minimum length requirement (query length ≥ 3). |
| SL-10 | Y | Position match is position-number-only — ignores `machineType`. Line 110: `roster.find(m => m.position === posNum)`. A position 1 on a consist matches, but support equipment is `position null` — no collision. However if two editions had overlapping position numbers, this would match the first. Not relevant now; worth a comment. |
| SL-11 | Y | `SpecLookupInput` interface has no `MachineType` filter. Caller can't ask "what machine does 'Tamper' refer to among consist only?" — always searches full roster. Not a v1 blocker (14 consist + 2 support), but could matter when support equipment grows. |
| SL-12 | Y | Error messages embed `sessionId`/`requestId`. Lines 219, 254: `sessionId=${sessionId} requestId=${requestId}`. Useful for correlation but means the `.message` field carries identifying info. If the error is logged elsewhere (e.g. a central log collector) you've spread the session ID. Usually fine for internal tools, but inconsistent with `primaryCall`/`modelAudit` which carry `sessionId` as a typed property, not embedded in the message. |
| SL-13 | Y | No test for `fetchRoster` logging the skipped-row warning. The catch block at line 193 logs a warning but no test verifies that path. |

### 4.14 — Diagnostic Logger (`tools/diagnosticLogger.ts`)

219 lines. `validateInput`, `serializeMetadata`, `logDiagnosticEntry`, `purgeOldDiagnostics`. Narrow DB interface (`run` + `get`). 21 tests.

| ID | Level | Finding |
|---|---|---|
| DL-1 | G | `IS_NOT_SYNCED = 0` named constant; hardcoded into SQL parameter (not caller-settable). Prevents accidental pre-synced writes. |
| DL-2 | G | Purge gated on `is_synced = 1` — pending-sync rows never deleted. Matches "Local-first sync gate" standing decision. |
| DL-3 | G | Return-not-throw. `DiagnosticLogError` with typed cause. |
| DL-4 | G | Narrow `DiagnosticLogDbClient` (`run` + `get` only) — write-only module, no `all()` needed. |
| DL-5 | G | `validateInput` checks severity against explicit `VALID_SEVERITIES` array, not just "non-empty." Good defense against type-assertion escape. |
| DL-6 | Y | `DIAGNOSTIC_MAX_RETENTION_DAYS = 180` is duplicated from `sessionPersistence.MAX_RETENTION_DAYS = 180`. Two modules, two constants, same value, same purpose. Source of truth is Security & Compliance Policy v1.0. One place should define it; others should import. Queue for util-extraction pass. |
| DL-7 | Y | `purgeOldDiagnostics` returns zero counts on DB failure — same pattern as SP-10. A failed purge returns `{ entriesDeleted: 0, purgedBefore: cutoff }`. Indistinguishable from a purge that found nothing. Compliance concern — retention must run, and failure should surface. Same fix direction as SP-10: discriminated result with `{ok:true;...} \| {ok:false;error}`, or add `purgeFailed: boolean`. |
| DL-8 | Y | Purge race: get count then delete — same race window as SP-12. Between reading count and executing delete, new rows could be inserted that match the predicate and get deleted but not counted. Returned `entriesDeleted` understates. Not a correctness bug, but an accuracy gap. |
| DL-9 | Y | Category is free-text but not validated. Line 79: empty check only. The comment at line 14 says "Categories are plain strings — new categories addable as data, no code or schema migration required." OK, but does any reporting/filtering rely on category consistency? If `equipment_fault` vs `Equipment Fault` coexist due to caller typo, aggregate views split. Consider normalizing to lowercase + trim, or a `VALID_CATEGORIES` data set Phase 7 loads from DB. |
| DL-10 | Y | `serializeMetadata` catches serialization errors and returns `null` silently. Line 99-103 logs a warn but drops the metadata — the diagnostic event writes with null metadata. Comparable to CL-5/6. The caller expected metadata to be persisted; silently dropping it on circular ref is a hidden failure. Better: return `{ ok: true; json: string } \| { ok: false; reason: string }` and let `logDiagnosticEntry` decide whether to fail the whole insert or degrade. |
| DL-11 | Y | `logDiagnosticEntry` never logs the message content itself. Info log at line 161 captures `entryId`, `category`, `severity`, `machineId`, `sessionId` — but not the actual message. For quick log-scraping during debugging, you'd have to query the DB. This is defensible (PII-shy), but worth a note: the diagnostic log's whole point is to be queryable, so console-log visibility isn't critical. Prefer status quo for security. |
| DL-12 | Y | No test for the "category whitespace-trimmed on write" behavior. Line 143 `input.category.trim()` — if someone writes category `'  safety  '`, the trimmed `safety` goes to DB. Test passes for empty category but not for whitespace-trim on write path. |
| DL-13 | Y | No test verifying the info-log fires on success. The happy-path test asserts INSERT happened; doesn't check that the `console.info` was emitted with correct fields. |

### 4.15 — Todo Tool (`tools/todoTool.ts`)

268 lines. `buildTodoDraft`, `validateCreateInput`, `validateUpdateInput`, `serializeTodoMetadata`, `writeTodo`, `updateTodoStatus`, `writeTimeLogEntry` (stub). 31 tests.

| ID | Level | Finding |
|---|---|---|
| TT-1 | G | Pure `buildTodoDraft` returns discriminated result. Orchestrator routes draft through approval gate. Matches settled design. |
| TT-2 | G | `updateTodoStatus` direct-write (no gate) per settled "approval gate scope — user-directed actions" decision. |
| TT-3 | G | `VALID_CATEGORIES` / `VALID_TIME_SENSITIVITIES` / `VALID_TERMINAL_STATUSES` — explicit arrays, not string-union-trust. Good defensive validation. |
| TT-4 | G | `IS_NOT_SYNCED = 0` constant, hardcoded in SQL params. Same pattern as `diagnosticLogger`. |
| TT-5 | G | Return-not-throw everywhere. Three explicit error causes: `write_error`, `invalid_input`, `not_found`. |
| TT-6 | Y | `TODO_MAX_RETENTION_DAYS = 180` — third duplication of the same retention constant. Now present in `sessionPersistence.MAX_RETENTION_DAYS`, `diagnosticLogger.DIAGNOSTIC_MAX_RETENTION_DAYS`, and here. Unused in this file (no purge function exists in `todoTool` — todos aren't purged by retention). Exported for symmetry with other tools, but it's literally dead code right now. Either implement `purgeCompletedTodos` consistent with `diagnosticLogger`, or remove the constant. The latter is more honest. |
| TT-7 | Y | Three calls to `trim` on one input. Lines 134 (`input.description.trim()`), 73 (`input.description.trim() === ''`), 91 (`input.equipmentId.trim()`). The validator uses trim to check emptiness but doesn't emit the trimmed value; the builder trims again. If trim semantics change, two places to update. Minor. |
| TT-8 | Y | `writeTodo` hardcodes `'open'` in the SQL string instead of as a parameter. Line 168: `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`. Mixing param-binding with literal-inline is inconsistent. The test even asserts this: line 154 `assert(sql.includes("'open'"), 'status open in SQL')`. For the string `'open'`, which is server-controlled and not user input, hardcoding is safe. But it's a stylistic inconsistency with the rest of the INSERT and breaks the "all queries parameterized" rule stated in the module header. Either move `'open'` to a param or add a `STATUS_OPEN` named const with a comment. |
| TT-9 | Y | `writeTimeLogEntry` is a stub that always throws. Line 189-196. Called from `updateTodoStatus` when `status === 'done'`; the try/catch swallows the throw as warn. This means every single "done" update logs `[TodoTool] TimeLog write skipped`. That's not a stub, that's a guaranteed side-effect warning on every done. Comment says "will be re-attempted when TimeLog is implemented in Phase 7" — OK, but in the meantime users' logs are noisy. Options: (a) silently no-op until Phase 7, (b) conditionally skip based on a `PHASE_7_TIMELOG_ENABLED` flag, (c) log once per session, not every call. (a) is the cleanest honest path. |
| TT-10 | Y | `updateTodoStatus` verifies existence with `SELECT` then does `UPDATE` — same race-condition pattern as purge. Between the `SELECT` and the `UPDATE`, the row could be deleted. The `UPDATE` would then be a no-op but return as success (SQLite `UPDATE` doesn't return affected rows by default here). If the row doesn't exist anymore, caller sees success and caller's state diverges from DB. For single-user local SQLite this is near-impossible; for multi-user Supabase sync (Phase 7) it's a real concern. Could use `UPDATE ... WHERE ... RETURNING *` and check for zero rows returned, or add a compound test. |
| TT-11 | Y | `updateTodoStatus` on success returns `null` even when TimeLog write failed. Intentional per comment, but the caller can't distinguish "done, TimeLog OK" from "done, TimeLog silently failed." For Phase 3 that's fine because TimeLog is a guaranteed failure. Phase 6+, if TimeLog is real and a done with no TimeLog entry is a problem, the failure needs to surface. Flag as design-review-at-Phase-7. |
| TT-12 | Y | `TodoDraft` does not include status; relies on convention. The draft is written with hardcoded `'open'` status. If a future edition needs to support a different initial status (e.g. a template edition creating `'pending'` todos), the draft can't carry it. Ties back to TT-8. |
| TT-13 | Y | Test for status open in SQL asserts a specific SQL format. Line 154-155 checks the hardcoded literal. Correct for current behavior but locks in the exact SQL string shape. Fragile. |
| TT-14 | Y | No test asserting that `buildTodoDraft` preserves `userId`/`sessionId`/`requestId` unchanged. These fields flow through; if they were accidentally trimmed/renamed, no test catches it. |
| TT-15 | Y | No test for metadata serialization into the draft. `buildTodoDraft` calls `serializeTodoMetadata` and stores in `draft.metadataJson`. That integration isn't asserted. Test covers `serializeTodoMetadata` alone and `buildTodoDraft` alone but not their composition. |

### 4.16 — Expense Parser (`tools/expenseParser.ts`)

226 lines. `parseExpense`, `validateParseInput`, `buildExpenseRecord`, 6 pure parsers, `ImageExtractorClient` interface. 34 tests.

| ID | Level | Finding |
|---|---|---|
| EP-1 | G | `ImageExtractorClient` is a clean injection point. No vendor name hardcoded. Swap provider via implementation change. Criterion #3 satisfied. |
| EP-2 | G | Two-stage pipeline (extract → parse) with pure parsers. Each testable in isolation. |
| EP-3 | G | Partial results first-class — null fields + warnings array. Matches settled design. |
| EP-4 | R-Adj | Regex-based receipt parsing is the wrong tool for this job. The six pure parsers use English-only labels (`total`, `subtotal`, `tax`, `date`, `vendor`), US date formats, `$` currency sigil, English month names. None of these are declared as OTM v1 constraints — they're assumptions. More importantly, this entire module is fighting against its own interface: the injected `ImageExtractorClient` is Claude vision (per the comment), which can return structured data directly in a single call. The current flow is: Claude extracts verbatim text → fragile regex parses that text back into structure. Losing information on every hop. Better design: `ImageExtractorClient.extractStructured()` returns `Partial<ExpenseRecord>` shape directly from the vision model, and the regex parsers become fallback-only. Criterion #4 — reasoning via brittle heuristics where a structured output eliminates the problem. Queue for remediation discussion. |
| EP-5 | Y | `parseAmount` prefers "total" line but picks the last match on that line. Line 99: `amounts[amounts.length - 1]`. If a receipt reads `Total $23.21 (was $28.50 before coupon)`, `"23.21"` is correct. But if labeling is unusual — `Total amount $20.00 tip included, thank you!` — the last match wins and might be tip, not total. Fragile. |
| EP-6 | Y | `parseDate` uses `new Date(match[0])` — runtime behavior varies by Node version and locale. Line 94: parsing a string like `4/15/2026` in Node works, but edge dates (`02/29/2024` vs `02/29/2025`) would silently roll to March 1 in the invalid case. Native `Date` parsing is famously unreliable. Use a purpose-built parse or `Date.parse(isoStr)` with ISO format only. |
| EP-7 | Y | `parseVendor` first-3-lines rule is a heuristic. Real receipts vary wildly. For v1 where most extractions go through Claude vision, the prompt could include vendor explicitly as part of structured output (see EP-4). The heuristic here is a safety net but it's being treated as primary logic. |
| EP-8 | Y | `parseLineItems` requires `^description ... $price$` anchored to start-of-line. Line 136 regex: `^(.+?)\s+\$?\s*(\d+(?:\.\d{2})?)$`. Multi-column receipts (qty / description / price) don't match this shape. |
| EP-9 | Y | `DEFAULT_CURRENCY = 'USD'` hardcoded. Line 24. OTM v1 user is US-based, fine for now, but the `ExpenseRecord.currency` field is typed as `string` so non-USD is supported at data layer. If rail contractors cross into Canada or Mexico for rare work, USD flag is wrong. Edition-coupled default. |
| EP-10 | Y | `parsePurchaseMethod` card-detection regex misses common formats. Line 110: requires `"card/visa/mastercard/amex/credit/debit"` prefix. Modern receipt text often just says `xxxx-xxxx-xxxx-4892` or `**** 4892` with no prefix word. |
| EP-11 | Y | Non-null assertions sneak in. Line 152, 176, 186: `input.text!`, `input.imageBytes!`, `input.imageMimeType!`. The validator guarantees these are present when `inputType` matches, but the compiler can't see that. Same class of issue as CD-1 — discriminated union on `inputType` would let you narrow the type properly. |
| EP-12 | Y | Line 79 regex misses lowercase month shorthand. `/jan|feb|.../` only — doesn't match `"January"`, `"january"`, etc. consistently across full forms and three-letter abbrevs. |
| EP-13 | Y | No test for `parsePurchaseMethod` with non-English text. All test fixtures English-only. Matches OTM v1 scope; flag for future. |
| EP-14 | Y | No test for multiple currency amounts with one labeled total. `$20.00 cash + $15.00 change, Total $5.00` — which does `parseAmount` pick? Untested edge case. |

### 4.17 — PO Generator (`tools/poGenerator.ts`)

213 lines. `buildPoGenerateResult`, `validatePoInput`, `generatePoNumber`, `computeSubtotal`, `buildPurchaseOrder`, `buildPoDocument`, `writePurchaseOrder`, `formatLineItem`, `formatCurrency`. 24 tests.

| ID | Level | Finding |
|---|---|---|
| PO-1 | G | Pure draft generation with DB write separated. Orchestrator owns approval gate. Matches settled design. |
| PO-2 | G | `sequenceNumber` dispatcher-owned (moved to `buildPoGenerateResult` parameter from input). Retrofit correctly applied. |
| PO-3 | G | Floating-point subtotal handled via `Math.round(... * 100) / 100` — tested explicitly with `3 × 0.1 → 0.30`. |
| PO-4 | G | `formatCurrency` and `formatLineItem` are internal helpers (not exported) — right scope. |
| PO-5 | Y | `formatCurrency` hardcodes `$` and `.toFixed(2)`. Line 98: `` return `$${amount.toFixed(2)}` ``. Same currency assumption as EP-9. Edition-coupled. If a future PO ever needs CAD or different precision, this is inline. |
| PO-6 | Y | `PoDocument.equipmentLabel` format is OTM v1-specific. Line 139: `` `Pos ${order.equipmentPosition}${order.equipmentId ? ` — ${order.equipmentId}` : ''}` ``. `"Pos N — machine-id"` is a MOW consist convention. For a non-consist edition, this labeling is wrong. The tool should delegate the label format to `EditionConfig` or a simpler schema. |
| PO-7 | Y | `generatePoNumber` assumes YYYY-MM-DD input. Line 87: `issuedDate.replace(/-/g, '').slice(0, 8)`. If `issuedDate` is provided as ISO-8601 datetime (`2026-04-15T12:00:00Z`), the `.slice(0, 8)` still yields `20260415` — works by coincidence. If it's `04/15/2026`, it yields `04152026` — wrong order, never caught at runtime. `validatePoInput` accepts any Date-parseable string; the PO number formatter assumes a specific one. Either validate format strictly, or compute the date part from a parsed `Date`. |
| PO-8 | Y | `buildPurchaseOrder` doesn't trim description or partNumber on line items. Line 108 trims `vendorName`, line 127 trims `notes`, but line items flow through untouched. If caller includes whitespace-padded descriptions, they persist. Minor inconsistency. |
| PO-9 | Y | `PurchaseOrder.status` is a literal type `'draft'`. Correct for generation, but `types.ts` line 477 also types it as `'draft'` with no union. When the orchestrator later transitions (e.g. to `'approved'` or `'sent'`), either the type must expand or the orchestrator writes a separate field. Not broken now, but the single-value literal implies a state machine that isn't there. |
| PO-10 | Y | `writePurchaseOrder` SQL status is a parameter but `PurchaseOrder.status` is always `'draft'`. Line 185, 197: `order.status` is passed. If somehow the caller constructs a `PurchaseOrder` with a different status (impossible via `buildPurchaseOrder`, but typescript doesn't know that through the full flow), the insert writes that. Because of the `'draft'` literal type this is safe, but the pairing is fragile. |
| PO-11 | Y | `equipmentPosition` validation gap. `validatePoInput` doesn't check whether `equipmentPosition` is a valid number when provided. If caller passes `equipmentPosition: NaN` or `equipmentPosition: -5`, validator says OK. `buildPoDocument` happily formats `Pos NaN` or `Pos -5`. |
| PO-12 | Y | No `DEFAULT_CURRENCY` / currency concept in `PurchaseOrder` at all. The `PurchaseOrder` type doesn't have a `currency` field; `formatCurrency` hardcodes `$`. If you ever need multi-currency POs, the whole type needs revision. Tight coupling to USD. |
| PO-13 | Y | No test for `writePurchaseOrder` with notes containing JSON-breaking characters. Notes are written as a parameter (safe via parameterized query), but if the notes contained embedded single-quotes and a future migration converted the INSERT to a raw string, they'd break. Paranoid, but easy test. |
| PO-14 | Y | No test for `buildPoDocument` when `order.notes` is empty string vs undefined. The nullish coalesce `order.notes ?? null` treats `''` as present → `notes: ''` in the doc. Probably fine, but untested. |

### 4.18 — Orchestrator Tools (`orchestratorTools.ts`)

185 lines. `dispatchToolCall`, `runGate` helper, `poSequenceCounter` module state, `resetPoSequence`, `ToolWriteDbClient` composition interface, `ToolDeps`. 17 tests.

This module is the integration surface for the tool layer and its findings concentrate patterns from the entire codebase.

| ID | Level | Finding |
|---|---|---|
| OT-1 | G | Exhaustive switch with `const exhaustiveCheck: never` on default. TypeScript enforces every `ToolCallInput` variant is handled. |
| OT-2 | G | Tools imported are pure drafts; orchestrator owns approval gate call for gated tools. Matches "tools are pure" settled standard. |
| OT-3 | G | Direct-write vs gate routing matches the Decisions Log settled scope (`todo_update` + `log_diagnostic` = direct; `todo_create`, `comms_draft`, `po_generate` = gated; `spec_lookup`, `expense_parse`, `sheet_output` = read-only). |
| OT-4 | **RED** | Module-level mutable state. Line 46: `let poSequenceCounter = 0;`. This is a shared counter across all sessions, all users, all requests that hit the same Node process. In a multi-user future (Decisions Log has "Multi-user instance model decision" as open), PO sequence numbers collide across users — user A's session increments it, user B's PO gets a number that looks like A's next number + 1. Within a single user's session today it works. This is the first RED finding in the audit. Criterion #2 — assumption without noted future design. Fix direction: sequence persistence in DB (per-user counter table) with `SELECT MAX(...) FROM orders_log WHERE user_id = ?`, done at call time. Queue for immediate-fix candidate list — it's small-surface and it prevents a real data-integrity bug. |
| OT-5 | R-Adj | `poSequenceCounter` is decremented on rejection/timeout. Lines 124, 125: `poSequenceCounter--`. Intent: "don't waste a number on a rejected draft." But: (a) if two concurrent PO drafts race — approve + reject — the decrement from reject might yield a number already used by approve. (b) If process crashes between approve-gate-success and write, the counter is lost entirely. (c) On restart, counter resets to 0 and re-collides with existing PO numbers. The decrement is trying to solve a problem the architecture creates. Same fix as OT-4 — persist sequence in DB. |
| OT-6 | Y | `runGate`'s `'approve' → 'approved' / else → 'rejected'` collapses all non-approve decisions. Lines 57-60: `if (decision === 'approve') return 'approved'; return 'rejected';`. But `ApprovalDecision` has 7 values (`approve`, `reject`, `edit`, `try_again`, `use_as_is`, `drop`, `send_feedback`). The `edit` decision is treated as `rejected` — user sent an edit request, the dispatch drops it. That's silent loss of user intent. Also ties to AG-7 (the overloaded `ApprovalDecision` type). A proper split would route `edit` back to the caller for re-draft, not to `"rejected"`. |
| OT-7 | Y | `.catch(err => ({ gateErr: ... }))` pattern is non-typical error flow. Lines 91-92, 110-111, 121-122: the `runGate` call can throw (`send_error` propagates), and catch converts it to a `{ gateErr }` object. Then line 94 checks `typeof gate === 'object'` to branch. This works but conflates three outcomes: `approved` (string), `rejected` (string), timeout (string), `gateErr` (object). A single discriminated result would be cleaner: `{ status: 'approved' \| 'rejected' \| 'timeout' \| 'gate_error' }` with typed fields per status. |
| OT-8 | Y | `as DiagnosticLogInput` cast at line 169. `call.tool === 'log_diagnostic'` narrows call to `{ tool: 'log_diagnostic'; input: DiagnosticLogInput }` via the discriminated union. The cast is unnecessary — TypeScript should already know the type. Either the discriminated union narrowing isn't firing (check tsconfig), or the cast is superstitious. Remove. |
| OT-9 | Y | `JSON.stringify(draft)` for approval content. Lines 89, 108, 120: the approval gate receives a JSON blob of the draft. A human approving this sees raw JSON in their UI. For Kurt's tablet UI, this will look terrible. The gate is supposed to show the user what they're approving in readable form. Contract misalignment: the approval gate wants human-readable `content: string`, but the dispatcher is feeding machine-serializable JSON. Either the tool returns a `userFacingContent: string` field alongside the draft, or the dispatcher renders it. Phase 6 Interface concern, but queue now. |
| OT-10 | Y | Three `write_error` branches collapse to `{ status: 'error', tool, error: writeResult.message }`. Lines 97, 104, 129, 171. Caller loses the typed `cause` field. If the caller wants to distinguish `"write_error"` from `"invalid_input"` for retry policy, they can't — they get a string. Could pass through `cause` as a field on `ToolCallStatus`'s error variant. |
| OT-11 | Y | Test file uses `beforeEach: resetPoSequence();` as a statement label, not a test hook. Line 112 of the test: `beforeEach: resetPoSequence();` — this is a JavaScript labeled statement, not a real lifecycle hook. The `resetPoSequence()` runs exactly once at runner startup, not before each test. The only reason tests pass is that individual tests explicitly call `resetPoSequence()` again. The label is misleading — a reader would think there's a test hook here. Fix: remove the label, rely on per-test calls, or implement a real `beforeEach`. |
| OT-12 | Y | `ToolWriteDbClient` composes 4 interfaces + adds `all`. Lines 36-39. TypeScript-friendly but the composed interface is the union of everything needed. If an edition adds a tool needing a different method, the interface grows. Acceptable for Phase 3; note the pattern. |
| OT-13 | Y | No test for rejection of `po_generate` that verifies the counter decrement behavior. Test at line 195 asserts `status === 'rejected'` but not that `poSequenceCounter` was decremented. The behavior at lines 124-125 is untested. Given OT-5 flags this as problematic, it's worth confirming the current-state behavior is at least tested. |
| OT-14 | Y | Stub `all` returns `fleet_master` data based on SQL string inclusion check. Test file line 34: `if (sql.includes('fleet_master'))`. Fragile — if SQL changes phrasing, test silently returns empty. Same pattern as SP-15. |
| OT-15 | Y | No test for the default (never) branch. Unreachable at compile time, but if someone bypasses with an `as any`, the runtime behavior isn't asserted. Minor. |

### 4.19 — tokenUtils (`tokenUtils.ts`)

20 lines. `estimateTokens`, `estimateMessagesTokens`. No tests.

| ID | Level | Finding |
|---|---|---|
| TU-1 | G | Module is pure. No side effects. |
| TU-2 | Y | No tests. No `tokenUtils.test.ts` in the tests directory. The functions are used by `promptAssembler` (the `+ 4` magic in PA-7 comes from here — `estimateMessagesTokens` line 17 adds 4 per message). Context window management decisions depend on these estimates. A file with no tests and callers that depend on it for budget enforcement is a gap. |
| TU-3 | Y | `CHARS_PER_TOKEN = 4` is a constant with no source or tolerance stated. Comment says "conservative average for English prose" and "±10% accuracy." Not calibrated against real Claude tokenizer. For short SMS messages, off by 30-50%; for long prose, closer to 4. History-trim decisions that push the budget edge will mis-estimate. Phase 8 calibration candidate — flag as carrying real uncertainty. |
| TU-4 | Y | `+ 4` message overhead is same magic number as PA-7. Cross-module duplication-by-coincidence: `promptAssembler` adds `+ 4` for current input tokens; `tokenUtils` adds `+ 4` per message. Two different semantics, same literal. Name each with its own constant. |

### 4.20 — typeUtils (`typeUtils.ts`)

45 lines. `extractString`, `extractNumber`, `extractObject`. No tests.

| ID | Level | Finding |
|---|---|---|
| TYU-1 | G | Pure typed accessors for untrusted input. Never throws. Returns `undefined` on mismatch. Textbook defensive coding. |
| TYU-2 | G | Used correctly in `eventClassifier.ts` for webhook payloads. |
| TYU-3 | Y | No tests. Same issue as `tokenUtils`. Three helpers used at untrusted-input boundaries, no test coverage. |
| TYU-4 | Y | Missing `extractArray` and `extractBoolean`. Classifier uses `extractString` and `extractObject`; context loader would benefit from `extractArray` (the `styleExclusions` JSON parse path could use a typed array accessor); approval gate `ApprovalDecision` cases could use `extractBoolean`. Easy extension, would eliminate several `as string[]` casts throughout the codebase. |
| TYU-5 | Y | No `extractOneOf<T extends string>(obj, key, allowed: readonly T[])` — would validate string-union values at untrusted-input boundaries and eliminate CL-8 class of problem. Structural helper this module was built to provide. |

### 4.21 — index.ts

18 lines. Fastify server boot, `/health` endpoint only.

| ID | Level | Finding |
|---|---|---|
| IDX-1 | G | Minimal scaffold — no orchestration wiring yet. Phase 4 integration work. |
| IDX-2 | R-Adj | Hardcoded port and host. Line 11: `app.listen({ port: 3000, host: '0.0.0.0' })`. Bypasses the env config module entirely. `PORT` env var exists (validated in `env.ts`), `env.port` is exported — not used here. Comment in `.env.example` says "Railway injects `PORT` automatically — do not hardcode in production." Yet this file does exactly that. When Phase 4 wiring happens, this needs to pull from env. If it ships as-is to Railway, the platform's injected `PORT` is ignored and the health check fails. Tier 1. |
| IDX-3 | Y | `host: '0.0.0.0'` binds to all interfaces. Correct for Railway/containerized deployment, but should be documented or env-configurable. Not a bug; flag for awareness. |
| IDX-4 | Y | No error handling beyond `process.exit(1)`. No graceful shutdown on SIGTERM (Railway sends SIGTERM during deploys), no connection draining. Phase 4 work. |
| IDX-5 | Y | No import of the config module. The whole env config infrastructure sits unused at the entry point. When Phase 4 lands, this file becomes the place where env validation actually runs (via `import { env } from './config'`). Currently the startup IIFE in `config/index.ts` never executes because nothing imports it. This means `.env.example` validation is theoretical, not enforced at boot today. |

### 4.22 — system-prompt.v1.0.ts

145 lines. Exports `SYSTEM_PROMPT_VERSION` and `SYSTEM_PROMPT` — the OTM v1 system prompt as a string.

| ID | Level | Finding |
|---|---|---|
| SP-V1-1 | G | Versioned artifact, loaded via `promptAssembler.loadSystemPrompt(editionConfig.systemPromptPath)`. Matches "Prompt assembler — edition-agnostic" design. |
| SP-V1-2 | G | `SYSTEM_PROMPT_VERSION` exported for traceability. |
| SP-V1-3 | R-Adj | Inconsistency with retired "Wrench" naming. Line 17 (Section 2): `"[Assistant name TBD]"` — correctly leaves placeholder per Decisions Log "Assistant naming" entry. But the Decisions Log says Wrench is retired from ALL documents. "Wrench" is not referenced in this file, so this part is fine. However, the Notion Decisions Log itself still contains many references to "Wrench" describing the predecessor. The fact the system prompt correctly uses "the system" / "the assistant" but other documents don't is a documentation-drift finding. Flag for Stage 3 Notion update. Tier 2. |
| SP-V1-4 | Y | Section 7 seed examples are OTM v1 Kurt-specific peer phrases. Per Decisions Log: "Peer phrases removed from static system prompt and moved to dynamic style profile." These three seed examples (lines 93–95) are explicitly documented as "starting baseline only, before the style profile has enough observations to carry the voice." OK as an intentional baseline, but it means the static prompt is STILL partially Kurt-specific — not fully edition-agnostic. An OTM v2 Supervisor prompt file would have different seed examples. Confirms MA-4's pattern — the audit prompt has OTM v1 domain language and here the assistant prompt does too, for justified reasons. Document as edition-bound-by-design. |
| SP-V1-5 | Y | Fleet consist (Section 9) is hardcoded into the prompt. Lines 130–144. 14 machines listed verbatim. Yet Decisions Log is clear: "Fleet knowledge starts at zero. Grows only from verified inputs." And `contextLoader.ts` injects `consistContext` dynamically per event. The static prompt lists the consist; the dynamic injection also lists the consist. Duplication. If the consist changes (machine added, removed, replaced), the static prompt and the database roster can drift. Fix: remove Section 9's machine list, keep only the policy language ("Fleet knowledge starts at zero..."). Let the consist be injected dynamically only. |
| SP-V1-6 | Y | Token count "~2,727" claim unverified. Comment at top says estimated 2,727 tokens. No test confirms this. `estimateTokens` in `tokenUtils` would give ~2,500 (assuming ~10,000 chars / 4); real Claude tokenizer gives something different. Matters for context budget planning (PA-1 uses this). Calibration item. |
| SP-V1-7 | Y | Seed examples include language that's a liability for content moderation. Line 93 contains the phrase `"I will stomp a bone out yo bitch ass"` — Kurt's peer-register phrase, per Decisions Log "This is how Kurt actually talks" context. OK for OTM v1 per settled tone decision, but: if the system prompt is ever shared with Anthropic's content policy review (for claude.ai, not API), or leaked in logs, or reviewed by a non-Kurt party, it looks bad. The Decisions Log acknowledges moving peer phrases OUT of the static prompt for exactly this reason; the migration didn't happen. Flag: these three lines should move to `style_observations` seed data, not the prompt. |
| SP-V1-8 | Y | No `SYSTEM_PROMPT_CHECKSUM` or similar integrity marker. File header says "Do not edit without bumping `SYSTEM_PROMPT_VERSION` and updating the Notion source document." Nothing enforces this. If someone edits and forgets the version bump, no alarm. A simple hash check at startup (computed at build, verified at runtime) would catch it. Operational improvement; not blocking. |

### 4.23 — Stage 1 findings (codebase-level checks)

Stage 1 findings surface patterns only visible when the whole codebase is examined at once. Six checks, executed via grep + directory walk + import graph trace.

**Check 1 — Layer Discipline / Import Graph**

| ID | Level | Finding |
|---|---|---|
| S1-L1 | G | Layer discipline is clean. `orchestration/tools/*` files import only from `../types` (one parent directory). No tool imports from another tool. No tool imports orchestration modules. Tools are leaf nodes in the dependency graph. |
| S1-L2 | G | Orchestration modules import from `./types`, `./typeUtils`, `./tokenUtils`, and each other (only `modelAudit → primaryCall` for `sanitizeErrorMessage` reuse). No orchestration module imports from `tools/`. Inversion of control: orchestrator calls tools via `orchestratorTools.ts`. |
| S1-L3 | G | No circular imports. Manual trace of the graph: `types.ts` is leaf (imports nothing internal). `typeUtils`/`tokenUtils` also leaf. All orchestration + tools depend on `types.ts`. `orchestratorTools.ts` is root consumer (imports from every tool + approval gate). Classic tree, no cycles. |
| S1-L4 | Y | `modelAudit → primaryCall` for `sanitizeErrorMessage` is the only cross-orchestration import. Works, but `sanitizeErrorMessage` is a cross-cutting utility, not a `primaryCall` concern. Per pattern established in Stage 2, this should live in a shared `utils/` directory alongside hex validation, retention constants, markdown patterns. Low urgency. |
| S1-L5 | G | No orchestration module imports from `config/`. Config is imported only by whatever starts up the server — and today that's nothing (see IDX-5 — `index.ts` doesn't import config either). When Phase 4 wires the server to orchestration, the import chain becomes `index.ts → config/index.ts → env.ts` at startup, and everything else is unchanged. Clean. |
| S1-L6 | G | `eventClassifier.ts` imports `typeUtils` — appropriate use. Webhook payloads are untrusted, type-safe extractors are the right tool. No other module uses `typeUtils` — consistent with the decision that DB-sourced data should be coerced differently from webhook-sourced data (though see Check 2 on silent-drop pattern where DB-sourced data is often coerced without any helper at all). |

**Check 2 — Silent-Drop Data Corruption Sweep**

| ID | Level | Finding |
|---|---|---|
| S1-D1 | Confirmation | Unchecked cast count: 14 total across codebase. Breakdown: 3 legitimate (`as string[]` on runtime-enumerated `VALID_*` arrays — these narrow from broader types to validate inclusion, safe), 8 in `sessionPersistence.ts` replay (SP-6 scope), 1 in `contextLoader.ts` for `styleExclusions` (CL-6 scope), 2 "structural interface" casts (settings map, `StreamHandle` — both justified by comments and safe). Real concerning casts: 9 (all in session replay path). |
| S1-D2 | Confirmation | Silent-drop `return []` / `return null` in catch blocks: 2 confirmed. `contextLoader.ts:120` (styleExclusions malformed JSON) and implicit via `specLookup.mapRosterRow` (returns empty `commonNames` on malformed JSON, no return from catch, just empty array from initialization). Other instances fire `console.warn` first (`serializeMetadata`, `serializeTodoMetadata`) — these are technically logged, not silent. Actually-silent count is smaller than Stage 2 suggested (2, not 10+). The broader pattern is "logged-but-loss" — warn fires but data is dropped. Still a concern but different severity than truly silent. Revised count: 2 fully silent + 8 warn-and-drop + 6 throw-or-skip patterns. |
| S1-D3 | Y | No centralized typed accessor for DB result rows. `typeUtils.ts` has `extractString`/`extractNumber`/`extractObject` for untrusted input, but they're not used in `sessionPersistence` replay or `contextLoader` setting coercion. Each module re-invents the pattern (`sessionPersistence` uses bare `as string`, `contextLoader` uses if-else+`Number`+`JSON.parse`). A shared `extractTypedField(obj, key, 'string' \| 'number' \| etc.)` + `extractUnion(obj, key, allowed[])` helper in `typeUtils` would fix all 14+ cases uniformly. Ties directly to TYU-4/TYU-5 findings. |

**Check 3 — Edition-Specific Literals**

| ID | Level | Finding |
|---|---|---|
| S1-E1 | Confirmation | Edition-specific literals outside `system-prompt.v1.0.ts` (which is intentionally edition-bound): 6 locations. `approvalGate.ts:16` (`leensee/onetrackmind` GitHub repo — AG-2 confirmed), `outputRouter.ts:197` (`'OneTrackMind'` notification title — new finding, didn't catch in Stage 2), `index.ts:6` (`'onetrackmind-backend'` service name — acceptable; service names aren't edition-specific), `expenseParser.ts:20` (`'USD'` — EP-9 confirmed), `types.ts:530` ("defaults to `'USD'`" — comment, acceptable), `contextLoader.ts:38` (`'America/Chicago'` — CL-4 confirmed), plus model audit prompt content (MA-4 confirmed). |
| S1-E2 | R-Adj | **NEW finding.** `outputRouter.ts:197` hardcodes `'OneTrackMind'` as FCM notification title. Line 197: `title: 'OneTrackMind'`. Missed in Stage 2 — review at Chunk 3a-ii focused on encrypted content invariants. For OTM v1 fine; for any future edition using a different product name (or a white-labeled deployment), wrong. Should pull from `EditionConfig` or a product-name constant. Tier 1. |
| S1-E3 | Confirmation | `MachineType = 'consist' \| 'support'` (`types.ts:430`) and related fleet abstractions are railroad-MOW-specific vocabulary. OTM v2 Supervisor Edition may or may not use this taxonomy; the `types.ts` fleet shape is fine for OTM v1 but represents a cross-edition design decision that hasn't been made. Note for OTM v2 intake phase. |
| S1-E4 | Pattern | The system prompt (intentionally edition-bound) and the code (claimed edition-agnostic) both contain Kurt-specific language. The inconsistency is: system prompt gets a pass because it's versioned per edition; `approvalGate`/`outputRouter`/`contextLoader` don't get a pass because they claim to be agnostic in comments. |

**Check 4 — Cross-Module Constant Duplication**

| ID | Level | Finding |
|---|---|---|
| S1-C1 | Confirmation | `= 180` retention constant: 3 distinct exports. `sessionPersistence.MAX_RETENTION_DAYS`, `diagnosticLogger.DIAGNOSTIC_MAX_RETENTION_DAYS`, `todoTool.TODO_MAX_RETENTION_DAYS`. All 180. `todoTool`'s is unused dead code (TT-6). |
| S1-C2 | Confirmation | FCM hex pattern: 2 copies. `config/env.ts:49` and `outputRouter.ts:20`. Env comments acknowledge the duplication with a "config layer must not depend on orchestration" rationale. `outputRouter` has no reciprocal comment. Same pattern, same error message string repeated. |
| S1-C3 | Y | **NEW finding.** Claude model string `'claude-sonnet-4-6'`: 2 copies. `primaryCall.PRIMARY_CALL_MODEL` and `modelAudit.MODEL_AUDIT_MODEL`. Currently identical. Decisions Log allows them to diverge (Phase 8 could evaluate Opus for primary, keep Sonnet for audit, or vice versa) — so the duplication is by design. Not a bug, but worth a comment in each noting "intentionally independent; Phase 8 may calibrate these separately." Without that comment, a reader might incorrectly unify them. |
| S1-C4 | Confirmation | `IS_NOT_SYNCED = 0` duplicated across 3 tools — `diagnosticLogger`, `todoTool`, `poGenerator`. Each redefines the constant at module scope. Pattern is correct (matches Decisions Log "Local-first sync gate — `is_synced` flag") but the literal `0` recurs. Candidate for shared `tools/constants.ts`. |

**Check 5 — Test Helper Duplication**

| ID | Level | Finding |
|---|---|---|
| S1-T1 | Confirmation | Test helper duplication: 18 files, each reimplements `test()` and `assert()`. Count of `function assert` per file ranges from 1 to 3. `env.test.ts` uses a different pattern (no `test()` wrapper, just inline `assert`/`assertThrows`). Rough estimate: ~900 lines of duplicated test infrastructure across the suite. |
| S1-T2 | Y | `env.test.ts` uses different style from the rest. Global counters + inline asserts instead of wrapped `test(name, fn)` blocks. Pattern inconsistency noted in Chunk 2 (ENV-6) — confirmed at codebase level. Either env conforms to the majority pattern, or a shared test harness accommodates both. |
| S1-T3 | Y | No tests for `tokenUtils.ts`, `typeUtils.ts`, `index.ts`, `system-prompt.v1.0.ts`. 4 files without direct coverage. Two are utility modules depended on by multiple callers (`tokenUtils` used by `promptAssembler`; `typeUtils` used by `eventClassifier`). |

**Check 6 — Orchestrator Decision Contract Compliance**

| ID | Level | Finding |
|---|---|---|
| S1-O1 | G | Exhaustive-switch discipline: 4 instances, all correct. Each uses `const exhaustiveCheck: never = X;` to force TypeScript to error at compile time if a union variant is added without handling. `sessionPersistence`, `outputRouter`, `orchestratorTools`, `eventClassifier`. |
| S1-O2 | Y | Missing exhaustive check in `contextLoader.filterContextForEvent`. Handles 5 event types with if/else chain, has a `console.warn` fallback for "unhandled eventType." No `const _: never = eventType;` — TypeScript won't catch a new variant added to `EventType`. CL-9 finding confirmed at codebase level. This is the only switch-adjacent decision point without the `never` guard. |
| S1-O3 | G | Three `satisfies` checks in `sessionPersistence` replay. Used alongside `as string` casts. As SP-13 noted, `satisfies` gives type-check illusion while `as` bypasses it upstream. The pattern should be: replace `as string` with `extractString`, then `satisfies` has meaningful checks to run. |
| S1-O4 | G | Discriminated result types used consistently. Verified: `SpecLookupResult` (4 branches), `CommsDraftResult` (2), `ExpenseParseResult` (2), `PoGenerateResult` (2), `SheetOutputResult` (2), `ToolCallStatus` (6). Every draft-producing tool returns a discriminated union. Every orchestration result path is explicit. |
| S1-O5 | Y | Error classes don't share a base. 8 domain error classes (`ClassificationError`, `ContextLoaderError`, `PrimaryCallError`, `ModelAuditError`, `ApprovalGateError`, `OutputRouterError`, `SessionPersistenceError`, `EnvConfigError`, `DiagnosticLogError`, `TodoWriteError`, `PoWriteError`, `SpecLookupError`-removed-but-error-cause-lives-in-result). None inherit from a common base; each duplicates name, message, plus unique fields. A common `OtmDomainError` base with `sessionId?`, `requestId?`, and typed `cause` would standardize. Not blocking; a consolidation opportunity. |

---

## Section 5 — Pattern Observations

Eleven codebase-level patterns identified, each spanning multiple modules. Patterns are distinct from individual findings — each represents a class of issue rather than a single instance. Severity reflects aggregate impact across all instances.

### Pattern 1 — Silent / warn-and-drop data corruption at DB boundaries

**Severity: Medium (revised down from Stage 2 estimate).**

Stage 2 hypothesized 10+ fully silent instances. Stage 1 Check 2 resolved this to:
- 2 fully silent: `contextLoader.ts:120` (styleExclusions JSON parse), `specLookup.mapRosterRow` (malformed `common_names`)
- 8 warn-and-drop: `serializeMetadata` (diagnosticLogger), `serializeTodoMetadata` (todoTool), `coerceSetting` (contextLoader, 4 paths), `replaySessionLog` payload-parse, `purgeOldDiagnostics` catch
- 6 throw-or-skip: session replay entry-type skip, various validator rejections

Instance findings: CL-5, CL-6, CL-7, CL-8, SP-6, SP-7, SL-6, DL-10, TT metadata serialize.

Remediation direction: centralized typed accessors in `typeUtils` (TYU-4 + TYU-5 cover the extension). Each DB-boundary coercion becomes `extractString(row, 'field')` or `extractOneOf(row, 'field', VALID_VALUES)`. The silent-drop pattern converts to warn-and-continue with explicit per-field reporting, or to hard-fail with structured error cause.

Concentrated localization: 9 of the 14 unchecked casts are in `sessionPersistence.ts` replay path alone — fix is smaller-surface than the instance count suggests.

### Pattern 2 — Hardcoded edition/locale assumptions in "agnostic" modules

**Severity: Medium.**

Six locations outside `system-prompt.v1.0.ts` (which is intentionally edition-bound):

1. `approvalGate.ts:16` — `FEEDBACK_GITHUB_REPO = 'leensee/onetrackmind'` (AG-2)
2. `approvalGate.ts:219` — GitHub issue title format `[audit-failure]` (AG-4)
3. `outputRouter.ts:197` — `title: 'OneTrackMind'` FCM notification (S1-E2)
4. `expenseParser.ts:20` — `DEFAULT_CURRENCY = 'USD'` (EP-9)
5. `contextLoader.ts:38` — `timeZone: 'America/Chicago'` (CL-4)
6. `modelAudit.MODEL_AUDIT_SYSTEM_PROMPT` — OTM v1 vocabulary (MA-4)

Plus the `MachineType` taxonomy (S1-E3) as a cross-edition design decision deferred to OTM v2 intake.

Remediation direction: extend `EditionConfig` with `feedbackRepo`, `feedbackIssueTitleFormat`, `productName`, `auditSystemPromptPath`, `timezone`, `currency` fields. Inject via orchestrator `ToolDeps` and dispatcher. Defaults preserved for OTM v1.

### Pattern 3 — Text heuristic where state-check / structured approach exists

**Severity: High — audit-adjacent impact.**

Three instances, all in audit/safety code:

1. `preflight` Rule 1 autonomous-action detection — 10 English phrase patterns (PF-6). Orchestrator already knows whether a tool was invoked.
2. `preflight` Rule 2 gate-marker detection — 8 English phrase patterns (PF-7). Orchestrator already knows whether approval gate was invoked.
3. `expenseParser` regex pipeline (EP-4). `ImageExtractorClient` is Claude vision — could return structured data directly in one call.

Remediation direction: pass orchestrator state signals into `preflight` (action-was-invoked, gate-was-invoked booleans). Text heuristic becomes defense-in-depth only. For expense parse, restructure `ImageExtractorClient` to return `Partial<ExpenseRecord>` directly; regex parsers become fallback for no-vision deployments.

Criterion #4 directly targets this pattern. Phase 9 calibration cannot tune these to accuracy unless the fundamental approach changes first.

### Pattern 4 — Cross-module constant duplication

**Severity: Low.**

Three distinct instances:
- `MAX_RETENTION_DAYS = 180` × 3 modules (S1-C1, DL-6, TT-6)
- `FCM_KEY_PATTERN` × 2 modules (S1-C2, ENV-2)
- `'claude-sonnet-4-6'` × 2 modules (S1-C3 — by design, needs documenting)
- `IS_NOT_SYNCED = 0` × 3 tool modules (S1-C4)

Remediation direction: `src/config/retention.ts` for retention, `src/utils/hexValidation.ts` for FCM pattern, `src/tools/constants.ts` for sync flag. Cross-ref comment for model strings until Phase 8 divergence decision.

### Pattern 5 — Non-null assertions leaking past discriminated unions

**Severity: Low.**

Two instances:
- `commsDrafter.ts:97` — `subject: input.subject!.trim()` (CD-1)
- `expenseParser.ts` lines 152, 176, 186 — `input.text!`, `input.imageBytes!`, `input.imageMimeType!` (EP-11)

Same fix shape in both: discriminate the input type on a mode field (`channel` for comms, `inputType` for expense). Compiler narrows per branch, `!` disappears, runtime checks become redundant.

### Pattern 6 — Purge operations return success-looking results on DB failure

**Severity: Low — compliance-adjacent.**

Two instances:
- `sessionPersistence.purgeExpiredLogs` (SP-10) — catch returns `{ entriesDeleted: 0, sessionsDeleted: 0, purgedBefore: cutoff }` on error
- `diagnosticLogger.purgeOldDiagnostics` (DL-7) — same pattern

Retention is a Security & Compliance Policy v1.0 requirement. Silent failure means retention drift can accumulate without operator awareness. Remediation: both return discriminated result `{ok:true; ...} | {ok:false; error}` or add `purgeFailed: boolean` to the success shape.

### Pattern 7 — Reimplemented format logic for the same data types

**Severity: Medium.**

Four instances of `ActiveFlag` / `OpenItem` / `MachineRef` formatting:
- `promptAssembler.buildContextBlock` (PA-8)
- `modelAudit.buildAuditPrompt` (MA-5)
- `preflight` Rule 6 (PF-15)
- `orchestratorTools` JSON-stringify-for-approval (OT-9)

Each iterates the same data with slightly different output. If one format changes, others drift. `formatForSms` in `outputRouter` has overlapping markdown-stripping logic.

Remediation direction: shared `src/utils/formatters.ts` module exporting pure formatters (`formatActiveFlags`, `formatOpenItems`, `formatConsistContext`, `formatDraftForApproval`). Consumers import instead of reimplementing. Folded into OT-9 Tier 0 commit — building the formatters module is a prerequisite for human-readable approval content.

### Pattern 8 — Test helper duplication across 18 files

**Severity: Low — maintainability, not correctness.**

Each test file reimplements `test(name, fn)`, `assert(cond, msg)`, `assertThrows`/`assertRejects`. 18 files × ~50 lines = ~900 lines of duplicated infrastructure (S1-T1). `env.test.ts` uses a different divergent style (S1-T2, ENV-6).

Remediation direction: shared `tests/_helpers.ts` that every test file imports. Single source of truth for test infrastructure. Deferred to Tier 2 — not a correctness issue, but one refactor pass clears ~900 lines of noise.

### Pattern 9 — Utility modules without direct test coverage

**Severity: Medium — callers depend on correctness.**

Four files with zero direct tests (S1-T3):
- `tokenUtils.ts` — used by `promptAssembler` for context budget enforcement
- `typeUtils.ts` — used by `eventClassifier` at untrusted-input boundary
- `index.ts` — server entry point
- `system-prompt.v1.0.ts` — versioned prompt string

Callers test them implicitly via integration. But `tokenUtils` budget decisions push the boundary between "fits" and "truncates"; a 10% off-estimate error becomes a silent context-overflow or silent history-trim. Not a blocker; a coverage gap that should be closed before Phase 8 calibration.

### Pattern 10 — Magic numbers with no calibration tie-back

**Severity: Medium — Phase 8 input.**

Numbers that carry real uncertainty, each justified by comment but none asserted by test or pointed to by a Phase 8 calibration entry:

- `CHARS_PER_TOKEN = 4` (TU-3) — ±10% claim, uncalibrated
- `+ 4` message overhead in `tokenUtils` vs `promptAssembler` (TU-4, PA-7) — same literal, two semantics
- `"~2,727"` token count for system prompt (SP-V1-6) — unverified
- `preflight` phone exclusion window `12/15` chars (PF-11) — asymmetric, unexplained
- `MODEL_AUDIT_MAX_TOKENS = 500` response cap (MA-1 context) — why 500?
- `PRIMARY_CALL_TEMPERATURE = 0.7` (PC-8 context) — no test, no rationale document

Phase 8 is described in Notion as "behavioral calibration" — these constants deserve to be on that list explicitly.

### Pattern 11 — Documentation drift between system prompt and architecture

**Severity: Low.**

Three instances:
- SP-V1-5 — fleet consist hardcoded in prompt AND injected dynamically
- SP-V1-6 — token count comment unverified
- SP-V1-7 — peer phrases should have moved to `style_observations` per Decisions Log; migration didn't happen

The settled design has moved past what the static prompt reflects. Remediation direction: update the prompt to match current architecture (remove Section 9 fleet list, migrate Section 7 peer phrases to style seed data, verify token count).

---

### Pattern severity summary

| # | Pattern | Severity | Remediation Tier |
|---|---|---|---|
| 1 | Silent/warn-and-drop data corruption | Medium | Tier 1 (TYU + SP + CL bundle) |
| 2 | Hardcoded edition/locale assumptions | Medium | Tier 1 (multiple commits) |
| 3 | Text heuristic where state-check works | High | Tier 1 (PF-6/PF-7 largest) |
| 4 | Cross-module constant duplication | Low | Tier 2 |
| 5 | Non-null assertions leaking | Low | Tier 0 (CD-1) + Tier 2 (EP-11) |
| 6 | Purge silent-success on failure | Low | Tier 2 |
| 7 | Reimplemented format logic | Medium | Tier 0 (folded into OT-9) |
| 8 | Test helper duplication | Low | Tier 2 |
| 9 | Utility modules without tests | Medium | Tier 3 |
| 10 | Magic numbers with no calibration | Medium | Phase 8 |
| 11 | System prompt documentation drift | Low | Tier 2 |

---

## Section 6 — Phase-to-User-Deliverable Walk (Criterion #5)

Every phase must trace to a user-facing capability or be a hard dependency of one. Walk of all 11 Roadmap phases:

| Phase | What Kurt sees | User-deliverable rating |
|---|---|---|
| 0 Environment setup | Nothing — infrastructure | Dependency of all others. GREEN. |
| 1 Foundation | Nothing — docs + system prompt | Dependency of Phase 2+. GREEN. |
| 2 Orchestration | Nothing — backend plumbing | Dependency of 4,5,6,7. GREEN. |
| 3 Tool layer | Nothing — backend plumbing | Dependency of 4,5,6,7. GREEN. |
| 4 Communications layer | "I send an SMS and the system receives it." | First user-visible phase. GREEN. |
| 5 Push/pull monitor | "My phone pings me when something matters." Session-open notification list. | GREEN. |
| 6 Interface | "I open the app and talk to it." Voice, tablet, phone, web. Onboarding guide. Settings UI. | GREEN — largest user-visible phase. |
| 7 Data layer | "The system remembers fleet, parts, PM, expenses." Without this, sessions are stateless. | GREEN — foundational for Kurt's actual use. |
| 8 Security Audit | Nothing direct — protects data + device | YELLOW — no direct deliverable, protects everything else. |
| 9 Test & calibrate | "The system behaves correctly in representative field scenarios." | GREEN — field readiness. |
| 10 Deploy OTM v1 | "Kurt is using the system." | Final GREEN. Endpoint. |
| 11 OTM v2 | A different user gets their edition | Out of scope for v1; trace to v2's user. GREEN for the v2 user. |

### Traceability findings

| ID | Level | Finding |
|---|---|---|
| PH-1 | Y | Phase 3's scope is invisible to Kurt except through downstream phases. That's fine — it's a tool layer — but the Roadmap doesn't make clear which Phase 3 tools surface in which later phase. Example: `commsDrafter` → Phase 4; `poGenerator` → Phase 6 UI + Phase 7 data; `expenseParser` → Phase 6 UI; `sheetOutput` → Phase 6 report surface. Without this map, it's hard to tell if a Phase 3 tool is "complete" in the sense that its downstream consumer can use it. Recommend adding a "downstream consumers" column to Phase 3 Roadmap entries. |
| PH-2 | Y | Phase 5 (push/pull monitor) has a dependency not documented. Session-open notification algorithm requires both `SessionState` (Phase 7 data) and `eventClassifier` (Phase 2) and a push/pull scheduler that doesn't exist yet. The deferred-from-Phase-2 algorithm is labeled "requires full data layer" but the scheduler piece isn't enumerated. Add scheduler explicitly. |
| PH-3 | Y | Phase 6 onboarding guide content is described in Decisions Log but not linked from Roadmap. Phase 6 deliverables list doesn't mention the onboarding guide, even though Decisions Log commits to it as a Phase 6 deliverable. Add it. |
| PH-4 | Y | Phase 7 lists `user_settings` table but not the other tables introduced in Phase 2/3. Phase 3 introduced `diagnostic_log`, `todos`, `orders_log`, `machine_specs`, `fleet_master`, `expenses` (implied), and Phase 2 introduced `session_log`, `session_states`, `style_observations`, `style_exclusions`. Phase 7 needs to own the schema for all of these. Currently only `user_settings` is mentioned. |
| PH-5 | Y | Phase 9 "Test and calibrate" deliverables list text heuristics to calibrate (HOS escalation, push judgment) but not the pre-flight audit rules themselves. Per PF-6/PF-7/PF-8 findings, the pre-flight rules are heuristic and will need Phase 9 calibration with real data. Add to Phase 9 scope. |
| PH-6 | Y | Phase 10 deployment doesn't specify what "monitor and refine" means. What's the success criteria for considering the v1 launch done? What metrics? What user feedback cadence? Open question. Not an audit finding per se, but a roadmap-gap — you'd want this defined before deploying. |
| PH-7 | G | Every phase traces to a user deliverable or is a hard dependency of one. Criterion #5 satisfied — no phase is orphaned. Phase 8 is the only non-direct-deliverable phase, justified as cross-cutting risk reduction. |

**Bottom line on criterion #5:** The phase map is structurally sound. Every phase earns its place. The issues above are about clarity and completeness of deliverable descriptions, not about a phase failing to trace to real user value.

---

## Section 7 — Remediation Plan

### Phase 3 → Phase 4 readiness assessment

Phase 4 is the Communications Layer. Its deliverables per Notion Roadmap: bidirectional SMS (Twilio), multi-inbox email (Gmail API), inbound triage engine, sender recognition, thread management, comms log.

**What Phase 3 delivered that Phase 4 depends on (verified working):**
- `commsDrafter.ts` — draft objects typed and validated. Provider-agnostic.
- `outputRouter.ts` — SMS segmenting, push formatting, routing by channel.
- `eventClassifier.ts` — provider-agnostic event classification from normalized inputs.
- `approvalGate.ts` — universal gate for outbound drafts.
- `orchestratorTools.ts:case 'comms_draft'` — draft→gate→return flow.

**What Phase 3 left for Phase 4 to resolve (blockers before Phase 4 build begins):**

| Blocker | Source finding | Severity for Phase 4 |
|---|---|---|
| `outputRouter.ts` embedded crypto module needs split | Stage 0 queued (crypto module split pin) | Low — unblocks Phase 8 Flutter FCM decryption work |
| `commsDrafter` uses `!` for subject — discriminated-union refactor | CD-1, T-5 | Medium — Phase 4 adds email send paths; better to fix the type now than repeat the `!` pattern downstream |
| AG-3 — `fallbackEmailFn` signature has no payload parameter | AG-3 | Medium — Phase 4 will wire email fallback; fixing after wiring is harder |
| Provider normalization contract for SMS | Decisions Log settled but unimplemented | High — Phase 4 must normalize Twilio webhooks to classifier input. No integration point exists yet |
| Provider normalization contract for Gmail | Decisions Log settled but unimplemented | High — same |
| OT-9 approval JSON is not human-readable | OT-9 | Medium — Phase 4 wires the UI layer. JSON-as-approval-content breaks the user experience |
| PF-6 / PF-7 text-heuristic audit rules | Stage 2 RED-adjacent | Medium — Phase 4 output goes through pre-flight; false positives will be frequent |

**Assessment:** Phase 4 can begin, but it should begin with 4 items resolved first — otherwise the communications layer is built on unstable foundations and needs rework:

1. Fix AG-3 — `fallbackEmailFn(payload: FeedbackPayload)` before wiring email
2. Fix CD-1/T-5 — discriminated `CommsDraftInput` before adding email send
3. Fix OT-9 — draft-to-approval human-readable contract before wiring UI
4. Fix OT-4 (RED) — move PO sequence to DB before any PO interaction surfaces in UI

The crypto module split, PF-6/PF-7 heuristic refactor, and other YELLOW items can be deferred.

Phase 3 is complete in deliverables but not complete in "ready for next phase to build on top of." That distinction is preserved in the Roadmap Phase 3 section.

### Tier 0 + 1 combined remediation scope (approved 2026-04-16)

Tier 0 (4 items) + Tier 1 (7 items) = 11 items, plus Tier 2 fold-ins where the same file is touched. Each item follows Code Gen v2.0 Section 1→2→3 approval cycle.

Tier 2 items folded into Tier 0/1:
- AG-10 (module side-effect split) folded into AG-3 commit
- MA-5 (hardcoded prompt shapes) folded into MA-4 commit
- PA-8 / MA-5 / PF-15 (reimplemented format logic) folded into OT-9 + shared `formatters.ts` commit
- TYU-4 / TYU-5 (typeUtils extensions) promoted to Tier 1 as prerequisite for SP-6/7 and CL-5/6/7/8
- AG-2 / AG-4 (hardcoded repo + issue title) bundled with S1-E2 (hardcoded product name) in one commit

### Combined Tier 0+1 remediation order

10 commits, executed in dependency order. Each commit follows Code Gen v2.0 Section 1→2→3 approval cycle.

| # | Commit | Items covered | Tier (source) | Prerequisite | Rationale for ordering |
|---|---|---|---|---|---|
| 1 | typeUtils extensions | TYU-4, TYU-5 | T2 → T1 | None | Prerequisite for #3. Build first. |
| 2 | OT-4: Persist PO sequence to DB (RED) | OT-4, OT-5 | T0 | None | Only RED. Isolated surface. Prevent data-integrity bug. |
| 3 | DB-coercion tightening (SP + CL bundle) | SP-6, SP-7, CL-5, CL-6, CL-7, CL-8 | T1 | #1 | All same root pattern; all consume TYU extensions. One commit. |
| 4 | CD-1/T-5: Discriminated CommsDraftInput | CD-1, T-5 | T0 | None | Types change + commsDrafter update. Before Phase 4 email wiring. |
| 5 | OT-9 + shared formatters.ts | OT-9, PA-8, MA-5, PF-15 | T0 + T2 fold-ins | None | New utils file. Touched by orchestratorTools, modelAudit, promptAssembler, preflight. |
| 6 | AG-3 + AG-10 module split | AG-3, AG-10 | T0 + T2 fold-in | None | One file touched; do the signature fix + pure/impure split together. |
| 7 | AG-2 + AG-4 + S1-E2 edition-injection | AG-2, AG-4, S1-E2 | T1 | None | Same pattern (pull from EditionConfig). Same file (mostly). |
| 8 | MA-4 + MA-5 edition-injection | MA-4, MA-5 | T1 | None | modelAudit system prompt externalized. |
| 9 | SO-3 sheet title fix | SO-3 | T1 | None | Small-surface. Kurt-facing bug. |
| 10 | PF-6 / PF-7 pre-flight rework | PF-6, PF-7 | T1 | None — largest design work | Final because it's the largest refactor; orchestrator state signals into preflight. |

Estimated total: 6–8 sessions of Code Gen v2.0 cycles.

### Tier 2 items not folded in (deferred)

| Item | Source | Rationale for defer |
|---|---|---|
| Consolidate `MAX_RETENTION_DAYS` to `src/config/retention.ts` | SP-1, DL-6, TT-6 | One-hour cleanup, no correctness impact. |
| Extract `FCM_KEY_PATTERN` + `sanitizeErrorMessage` to `src/utils/` | ENV-2, S1-L4 | Util-extraction pass with retention consolidation. |
| Shared `tests/_helpers.ts` for test infrastructure | S1-T1 | ~900 line cleanup, no correctness impact. |
| Crypto module split: `outputRouter.ts` → `outputRouter.ts` + `crypto/fcmPayload.ts` + roundtrip test | Stage 0 queue | Unblocks Phase 8 Flutter FCM decryption work only. |
| `preflight.ts` support equipment serial inclusion (PF-16) | PF-16 | Rule 4 verification logic gap; defer to Phase 9 calibration. |
| `contextLoader.ts` exhaustive never check on `eventType` (CL-9 / S1-O2) | CL-9, S1-O2 | Trivial fix, non-blocking. |
| Fix `index.ts` to use `env.port`, import config (IDX-2 + IDX-5) | IDX-2, IDX-5 | Phase 4 will touch `index.ts` substantially; fold in then. |
| EP-11 non-null assertions — discriminated inputType | EP-11 | Same fix shape as CD-1; deferred to next expenseParser touch. |
| Fleet-consist hardcoded in system-prompt.v1.0.ts | SP-V1-5 | Single-edit fix; Tier 2 cleanup pass. |

### Tier 3 (standards-drift, ~180 findings)

Tracked in this audit page only. Not surfaced as Task Backlog items. Review at future milestone audits.

### Tier 4 (OTM v2 intake)

- `MachineType = 'consist' | 'support'` genericization (S1-E3) — cross-edition design decision
- Locale/currency abstraction (`DEFAULT_CURRENCY`, `America/Chicago`) — needs edition-intake pattern
- `ApprovalDecision` split into two typed unions (AG-7, T-6) — design work with Phase 6 Interface
- `ToolCallStatus.result: unknown` → `ToolResultByName[T['tool']]` lookup type (T-9) — type-safety improvement
- `OtmDomainError` common base class (S1-O5) — error consolidation opportunity

### Commit message template

```
<type>: <concise change description>

<one-paragraph body explaining what changed and why>

Resolves audit finding <2026-04-16-FULL-ID> (Phase 3 audit 2026-04-16).
Ref: Decisions Log 'Phase 3 architecture + code audit'.
```

Example:
```
fix: persist PO sequence counter to DB

Replaces module-level mutable counter with DB-backed sequence per user.
Eliminates cross-session/cross-user collision risk under multi-user instance model.

Resolves audit finding 2026-04-16-OT-4 (Phase 3 audit 2026-04-16).
Ref: Decisions Log 'Phase 3 architecture + code audit'.
```

---

## Section 8 — Notion Corrections Applied

Corrections proposed by this audit to existing Notion pages. Applied via separate change-log document at `notion-drafts/04-Notion-corrections-to-apply.md` — user pastes into Notion. Every correction traceable to audit finding or ID.

### Roadmap — Phase 2

**Change:** Test count updated.

From: `Total: 175 tests, 0 failures`
To: `Total: 175 active tests + 1 designed-skip integration test (Primary Call, requires live API key), 0 failures`

**Rationale:** Decisions Log already documents the skip-by-design. Current "175/175" shorthand is slightly inaccurate.

### Roadmap — Phase 3

**Change 1:** Status updated to acknowledge re-validation.

From: `Status: Complete — 2026-04-15.`
To: `Status: Complete — 2026-04-15. Re-validated 2026-04-16 following Phase 3 architecture + code audit. One regression found and fixed: outputRouter.ts type annotation + stale test against pre-encryption shape (committed 2026-04-16).`

**Change 2:** Test count reconciliation.

Add: `Test counts updated after audit reconciliation: env 39 (was 26), commsDrafter 26 (verified), sheetOutput 22 (was 20), eventClassifier 20 (was 21). Totals reflect actual test file content.`

**Change 3:** New subsection for Phase 3 → Phase 4 readiness.

Add: `Phase 3 → Phase 4 readiness — 4 must-fix items before Phase 4 build begins: 2026-04-16-OT-4 (RED: persist PO sequence to DB), 2026-04-16-AG-3 (fallbackEmailFn payload signature), 2026-04-16-CD-1/T-5 (discriminated CommsDraftInput), 2026-04-16-OT-9 (human-readable approval content).`

### Roadmap — Phase 4

**Change:** Add 3 architecture decisions pending design.

Add to deliverables list:
- `Provider normalization handler for Twilio SMS webhooks (classifier input)`
- `Provider normalization handler for Gmail webhooks (classifier input)`
- `Email fallback for approval gate feedback submission — signature takes FeedbackPayload`

### Roadmap — Phase 5

**Change:** Add push/pull scheduler.

Add to deliverables: `Push/pull scheduler (deferred from Phase 2 when session open notification algorithm required data layer).`

### Roadmap — Phase 6

**Change:** Add onboarding guide.

Add to deliverables: `Onboarding guide (settled design in Decisions Log).`

### Roadmap — Phase 7

**Change:** Expand schema list.

From: `user_settings table`
To: `Schema for all Phase 2/3 tables: session_log, session_states, style_observations, style_exclusions (Phase 2), diagnostic_log, todos, orders_log, machine_specs, fleet_master, expenses (Phase 3), user_settings.`

### Roadmap — Phase 9

**Change:** Add pre-flight audit rule calibration.

Add to deliverables: `Pre-flight audit rule calibration — autonomous action detection, gate marker detection, safety flag surfacing threshold, serial false-positive sweep, cost figure estimation markers (per Phase 3 audit).`

### Task Backlog — Phase 3 section

**Change 1:** Mark 4 audit checkboxes as done (with the noted outputRouter fix): `Run full npm test suite`, `Architecture audit`, `Cross-component validation`, `Code Gen doc v2.0 compliance sweep`.

**Change 2:** Add new section `Phase 3 audit findings — Tier 0/1/2/3 remediation` with 12 combined items (Tier 0+1 approved for immediate remediation per Section 7 of this report).

### Decisions Log

**Change:** Add new entry dated 2026-04-16.

Entry content: `Phase 3 architecture + code audit. Full architecture and code audit performed against Code Gen doc v2.0, orchestrator decision contract standard, and user-defined criteria (code structure/style/naming, assumption traceability, genericization, hard-coded decision trees, phase-to-user-deliverable mapping, self-contained component scope). 22 source files + 18 test files reviewed across 12 audit chunks. 1 RED finding (2026-04-16-OT-4, module-level PO counter), 14 RED-adjacent YELLOW findings, ~190 YELLOW findings, ~65 GREEN confirmations. 11 recurring patterns identified. Tier 0+1 combined remediation approved (12 items, 10 commits). Phase 3 confirmed substantively complete with 4 must-fix items before Phase 4 build begins. Also identified: test count drift in 4 modules between recorded completion and actual files (reconciled); one regression in outputRouter.ts between Phase 2 audit and Phase 3 completion (fixed in-audit). Affects: Phase 3 (closure), Phase 4 (readiness items), Phase 5–9 (scope additions to Roadmap). Status: Settled — 2026-04-16.`

### Data Collection Status Tracker

No changes required. The tracker is for fleet data gaps, not code audit findings.

### New pages created

Three new Notion pages drafted for paste:
1. **OTM Audit Standards v1.0** (Documents > Policy) — cross-cutting policy doc governing audit triggers, methodology, taxonomy, reporting format, handoff protocol. Ranks alongside Code Gen v2.0 and Security & Compliance Policy v1.0.
2. **Audit Log** (top-level) — index page for all OTM audits.
3. **Phase 3 Architecture + Code Audit — 2026-04-16** (Audit Log child) — the Notion-formatted version of this audit, referencing back to this .docx as the canonical complete record.

---

## Section 9 — Appendix

### Appendix A — RED + RED-adjacent YELLOW quick reference

Fifteen findings that drive all Tier 0 and Tier 1 remediation work. Full-form IDs for commit reference.

| Full ID | Module | One-line finding |
|---|---|---|
| 2026-04-16-OT-4 | orchestratorTools | **RED.** Module-level mutable `poSequenceCounter` — cross-session/cross-user collision risk. |
| 2026-04-16-SO-3 | sheetOutput | Sheet title rendered as literal `#`-prefixed first row — Kurt-facing rendering bug. |
| 2026-04-16-MA-4 | modelAudit | OTM v1 domain vocabulary hardcoded in audit system prompt. |
| 2026-04-16-AG-3 | approvalGate | `fallbackEmailFn` signature lacks `FeedbackPayload` parameter. |
| 2026-04-16-T-10 | types | `sheet_output` tool added without settled build-order decision record. |
| 2026-04-16-CL-11 | contextLoader | `#N` position-reference pattern collides with phone-number heuristic. |
| 2026-04-16-PF-6 | preflight | Rule 1 autonomous-action uses phrase-match where state-check would be exact. |
| 2026-04-16-PF-7 | preflight | Rule 2 gate-marker uses phrase-match where state-check would be exact. |
| 2026-04-16-SP-6 | sessionPersistence | Unchecked `as string` casts in replay — silent corruption risk. |
| 2026-04-16-SP-7 | sessionPersistence | Silent skip in replay on unparseable payloads. |
| 2026-04-16-EP-4 | expenseParser | Regex-based parsing where vision model can return structured data directly. |
| 2026-04-16-OT-5 | orchestratorTools | PO sequence counter decrement on rejection — race condition. |
| 2026-04-16-IDX-2 | index.ts | Hardcoded port/host — bypasses env config entirely. |
| 2026-04-16-SP-V1-3 | system-prompt.v1.0.ts | Documentation drift: retired "Wrench" name persists in other Notion docs. |
| 2026-04-16-S1-E2 | outputRouter | Hardcoded `'OneTrackMind'` FCM notification title — not edition-agnostic. |

### Appendix B — Test count reconciliation

| Module | Notion-recorded | Actual | Delta | Resolution |
|---|---|---|---|---|
| eventClassifier | 21 | 20 | −1 | Notion record drift, not code drift. |
| commsDrafter | 21 | 26 | +5 | Typo in initial run paste. Confirmed 26 by user. |
| env | 26 | 39 | +13 | Valid coverage expansion: PORT edge cases (6), whitespace trimming (3), FCM mixed-case, frozen-result test, error-variable assertions. |
| sheetOutput | 20 | 22 | +2 | Valid edge case coverage: 'no comment line when title absent' + 'null values produce empty cells'. |
| primaryCall | 10 | 9 + 1 skip | — | Label drift — 9 active + 1 designed-skip integration. |
| modelAudit | 24 | 24 | 0 | Clean. |
| approvalGate | 19 | 22 | +3 | Retroactive `submitFeedback` `token: undefined` path fix. Explicitly noted in Task Backlog. |
| contextLoader | 15 | 15 | 0 | Clean. |
| promptAssembler | 10 | 10 | 0 | Clean. |
| preflight | 35 | 35 | 0 | Clean. |
| sessionPersistence | 20 | 20 | 0 | Clean. |
| specLookup | 35 | 35 | 0 | Clean. |
| diagnosticLogger | 21 | 21 | 0 | Clean. |
| todoTool | 31 | 31 | 0 | Clean. |
| expenseParser | 34 | 34 | 0 | Clean. |
| poGenerator | 24 | 24 | 0 | Clean. |
| orchestratorTools | 17 | 17 | 0 | Clean. |
| outputRouter | — | — | — | Test file restored during audit to match AES-256-GCM contract. |

**Post-reconciliation total:** 422 active tests passed + 1 designed-skip = 423 total. 0 failures.

### Appendix C — Import graph (tree representation)

```
types.ts (leaf — imports nothing internal)
├── typeUtils.ts (leaf)
├── tokenUtils.ts (leaf)
└── [all other modules depend on types.ts]

orchestration/
├── eventClassifier.ts → types, typeUtils
├── contextLoader.ts → types
├── promptAssembler.ts → types, tokenUtils, system-prompt.v1.0.ts (via require)
├── primaryCall.ts → types
├── preflight.ts → types
├── modelAudit.ts → types, primaryCall (sanitizeErrorMessage only)
├── approvalGate.ts → types
├── outputRouter.ts → types
├── sessionPersistence.ts → types
└── orchestratorTools.ts → types, approvalGate, + all tools

orchestration/tools/
├── commsDrafter.ts → ../types
├── sheetOutput.ts → ../types
├── specLookup.ts → ../types
├── diagnosticLogger.ts → ../types
├── todoTool.ts → ../types
├── expenseParser.ts → ../types
└── poGenerator.ts → ../types

config/
├── env.ts (pure, leaf)
├── index.ts → env.ts (runtime IIFE)
└── system-prompt.v1.0.ts (leaf — string constants only)

index.ts (entry point — currently imports nothing internal; Phase 4 will wire)
```

**Properties verified:**
- No circular imports
- Tools are leaves (no tool imports another tool, no tool imports orchestration)
- One cross-orchestration import: `modelAudit → primaryCall` for `sanitizeErrorMessage` reuse (flagged S1-L4)
- No orchestration module imports `config/` (clean; Phase 4 wires)

### Appendix D — Finding ID scheme reference

Per OTM Audit Standards v1.0 Section 4.

**Full form:** `YYYY-MM-DD-<Prefix>-<Number>`

**Short form (in-audit tables):** `<Prefix>-<Number>`

**Module prefixes used in this audit:**

| Prefix | Module |
|---|---|
| EC | Event Classifier (`eventClassifier.ts`) |
| CD | Comms Drafter (`commsDrafter.ts`) |
| ENV | Env Config (`config/env.ts` + `config/index.ts`) |
| SO | Sheet Output (`tools/sheetOutput.ts`) |
| PC | Primary Call (`primaryCall.ts`) |
| MA | Model Audit (`modelAudit.ts`) |
| AG | Approval Gate (`approvalGate.ts`) |
| T | Types (`types.ts`) |
| CL | Context Loader (`contextLoader.ts`) |
| PA | Prompt Assembler (`promptAssembler.ts`) |
| PF | Pre-flight (`preflight.ts`) |
| SP | Session Persistence (`sessionPersistence.ts`) |
| SL | Spec Lookup (`tools/specLookup.ts`) |
| DL | Diagnostic Logger (`tools/diagnosticLogger.ts`) |
| TT | Todo Tool (`tools/todoTool.ts`) |
| EP | Expense Parser (`tools/expenseParser.ts`) |
| PO | PO Generator (`tools/poGenerator.ts`) |
| OT | Orchestrator Tools (`orchestratorTools.ts`) |
| TU | tokenUtils (`tokenUtils.ts`) |
| TYU | typeUtils (`typeUtils.ts`) |
| IDX | index.ts (`index.ts`) |
| SP-V1 | system-prompt.v1.0.ts (`config/system-prompt.v1.0.ts`) |

**Stage-level prefixes:**

| Prefix | Scope |
|---|---|
| S1-L | Stage 1, Layer Discipline (Check 1) |
| S1-D | Stage 1, Data corruption sweep (Check 2) |
| S1-E | Stage 1, Edition-specific literals (Check 3) |
| S1-C | Stage 1, Constant duplication (Check 4) |
| S1-T | Stage 1, Test helper duplication (Check 5) |
| S1-O | Stage 1, Orchestrator decision contract (Check 6) |
| PH | Stage 3, Phase-to-user-deliverable walk |

**Uniqueness property:** `YYYY-MM-DD-<Prefix>-<Number>` is globally unique by construction. Future audits of `orchestratorTools.ts` will produce their own `OT-*` series — short forms overlap within audit scope, full forms do not.

---

## Audit Closeout

**Phase 3 audit status:** Complete, 2026-04-16.

**Immediate next action:** Tier 0+1 remediation begins. Commit #1 (typeUtils extensions — TYU-4, TYU-5) is the prerequisite for commit #3 (SP/CL DB-coercion bundle). Commit #2 (OT-4 RED fix) can proceed in parallel.

**Next audit:** End of Phase 6 (Interface complete) — integration audit before Phase 7 wiring, per OTM Audit Standards v1.0 Section 1.

---

*End of audit report. Conforms to OTM Audit Standards v1.0 Artifact C specification.*
