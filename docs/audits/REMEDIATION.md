# OTM Phase 3 — Tier 0+1 Remediation Plan

**Audit date:** 2026-04-16  
**Audit commit:** `f2b0a03` on `main`  
**Remediation approved:** 2026-04-16  
**Full audit:** `docs/audits/2026-04-16-phase3/OTM-Phase3-Audit-2026-04-16.md`  
**GitHub Issues:** [#TBD — create one issue per commit row below, link here after creation]

---

## Scope

10 commits covering all Tier 0 (RED) and Tier 1 (RED-adjacent YELLOW) findings from the Phase 3 audit. One commit per Claude Code session. Commits are sequenced by dependency order, not severity.

**Out of scope for this plan:** ~190 YELLOW and ~65 GREEN findings (Phase 4 backlog). `.env.example` FCM_PAYLOAD_KEY entry is a tracked side item — non-blocking, append to any convenient commit or handle standalone.

---

## Workflow per session (Code Gen v2.0)

Every commit follows three gated sections. Claude Code must STOP for explicit approval before proceeding past Section 1 and Section 2.

```
Section 1: Context & Intent        → STOP, await approval
Section 2: Proposed Changes        → STOP, await approval
Section 3: Implementation + tests  → commit with template below
```

**Commit message template:**

```
<type>: <concise description>

<paragraph body>

Resolves audit finding <2026-04-16-FULL-ID> (Phase 3 audit 2026-04-16).
Ref: Decisions Log 'Phase 3 architecture + code audit'.
```

---

## Session start instruction (copy-paste into Claude Code)

```
Read docs/audits/REMEDIATION.md. The current commit is #<N>. 
Begin Section 1: Context & Intent for that commit. 
Reference docs/audits/2026-04-16-phase3/OTM-Phase3-Audit-2026-04-16.md 
for full finding detail. Stop after Section 1 and await approval.
```

---

## Commit registry

| # | GitHub Issue | Finding IDs | Files touched | Dependency | Status |
|---|---|---|---|---|---|
| 1 | #3 | TYU-4, TYU-5 | `backend/src/orchestration/typeUtils.ts` | none | ✅ Committed |
| 2 | #4 | OT-4, OT-5 | `backend/src/orchestration/orchestratorTools.ts`, `backend/src/orchestration/tools/poSequence.ts` (new) | none | ✅ Committed |
| 3 | #5 | SP-6, SP-7, CL-5, CL-6, CL-7, CL-8 | `sessionPersistence.ts`, `contextLoader.ts` | needs #1 | ✅ Committed |
| 4 | #6 | CD-1, T-5, CD-5 | `commsDrafter.ts`, `types.ts`, `commsDrafter.test.ts` | none | ✅ Committed |
| 5 | #7 | OT-9, PA-8, MA-5, PF-15 | `backend/src/orchestration/formatters.ts` (new) | none | ✅ Committed |
| 6 | #8 | AG-3, AG-10 | `approvalGate/pure.ts` (new), `approvalGate/index.ts` | none | ✅ Committed |
| 7 | #9 | AG-2, AG-4, S1-E2 | `approvalGate/`, `outputRouter.ts`, `EditionConfig` type | needs #6 | ✅ Committed |
| 8 | #10 | MA-4, MA-5 | `modelAudit.ts`, `promptAssembler.ts`, `configLoader.ts` (new), `model-audit-prompt.ts` (new), `EditionConfig` | needs #7 | ✅ Committed |
| 9 | #11 | SO-3, SO-2, SO-6, SO-7 | `sheetOutput.ts`, `types.ts`, `sheetOutput.test.ts` | none | ✅ Committed |
| 10 | #12 | PF-6, PF-7 | `preflight.ts`, orchestrator state | needs #7 | ⬜ TODO |

**Status key:** ⬜ TODO · 🔄 In progress · ✅ Committed · 🚫 Blocked

---

## Commit detail

### #1 — typeUtils extensions
**Findings:** TYU-4, TYU-5  
**Prerequisite for:** #3  
**File:** `src/utils/typeUtils.ts`  
**Change:** Add `extractArray`, `extractBoolean`, `extractOneOf<T>` helpers.  
**Tests:** Unit tests covering nominal, null, wrong-type, and edge inputs for each helper.  
**Commit type:** `feat`

---

### #2 — OT-4 RED fix: persist PO sequence to DB
**Findings:** OT-4 (RED), OT-5  
**File:** Orders module + new DB migration  
**Change:** Replace module-level `poSequenceCounter` with per-user counter table. Use `SELECT MAX(...) FROM orders_log WHERE user_id = ?` at call time. Remove the in-memory counter entirely.  
**Tests:** Concurrency test (two simultaneous requests, same user — assert no duplicate sequence numbers). Reset test (server restart — assert counter resumes from DB state).  
**Commit type:** `fix`

---

### #3 — DB coercion bundle
**Findings:** SP-6, SP-7, CL-5, CL-6, CL-7, CL-8  
**Prerequisite:** #1 (requires `extractString` from typeUtils)  
**Files:** `sessionPersistence.ts`, `contextLoader.ts`  
**Change:** Replace `as string` casts in `sessionPersistence` replay with `extractString`. Tighten `coerceSetting` in `contextLoader` using the new type helpers.  
**Tests:** Coercion tests for each replaced cast site — verify runtime type errors surface correctly instead of silently coercing.  
**Commit type:** `fix`

---

### #4 — Discriminated CommsDraftInput union
**Findings:** CD-1, T-5  
**Files:** `commsDrafter.ts`, `types.ts`  
**Change:** Make `CommsDraftInput` a discriminated union on `channel` field. Eliminates the `!` non-null assertion at `commsDrafter.ts:97`.  
**Tests:** Type-level test (compile-time check that each channel variant narrows correctly). Runtime test for unrecognised channel value.  
**Commit type:** `refactor`

---

### #5 — OT-9 + shared formatters.ts
**Findings:** OT-9, PA-8, MA-5, PF-15  
**Files:** `backend/src/orchestration/formatters.ts` (new file). Minor edits to `orchestratorTools.ts`, `promptAssembler.ts`, `modelAudit.ts`, `preflight.ts`. Comment-only edit to `outputRouter.ts` (OR-3 migration tracked in issue #25).  
**Change:** Create `backend/src/orchestration/formatters.ts` (codebase convention — `utils/` directory does not exist). Replace `JSON.stringify(draft)` in the orchestrator dispatcher with `formatDraftForApproval` so the approval gate receives human-readable content (OT-9). Migrate PA-8 (`buildContextBlock`), MA-5 (`buildAuditPrompt`), and PF-15 (Rule 6 markdown detection) to consume the shared module. OR-3 migration for `outputRouter.formatForSms` deferred to issue #25.  
**Tests:** Unit tests for every exported formatter (element + list + draft + SMS patterns). Anti-drift test asserts shared formatter output appears verbatim in `buildAuditPrompt`.  
**Commit type:** `feat`

---

### #6 — approvalGate module split
**Findings:** AG-3, AG-10  
**Files:** `approvalGate/pure.ts` (new), `approvalGate/index.ts` (refactored)  
**Change:** Extract pure logic into `approvalGate/pure.ts`. Fix `fallbackEmailFn(payload: FeedbackPayload)` signature. Split in single commit.  
**Tests:** Pure function unit tests (no side effects, deterministic). Integration test for the index re-export surface.  
**Commit type:** `refactor`

---

### #7 — EditionConfig injection (AG-2, AG-4, S1-E2)
**Findings:** AG-2, AG-4, S1-E2  
**Prerequisite:** #6  
**Files:** `approvalGate/`, `EditionConfig` type definition  
**Change:** Inject `feedbackRepo`, `feedbackIssueTitleFormat`, `productName` from `EditionConfig`. Extend `EditionConfig` type with these fields.  
**Tests:** Test that hardcoded values are gone. Test injection with two different EditionConfig instances.  
**Commit type:** `feat`

---

### #8 — Edition-inject audit system prompt
**Findings:** MA-4, MA-5  
**Prerequisite:** #7 (EditionConfig extension)  
**Files:** `buildAuditPrompt.ts`, `EditionConfig`  
**Change:** Add `EditionConfig.auditSystemPromptPath`. Load audit system prompt from that path at runtime. Fix hardcoded shapes in `buildAuditPrompt`.  
**Tests:** Test with missing path (graceful error). Test with valid path (correct prompt loaded). Test hardcoded shape removal.  
**Commit type:** `fix`

---

### #9 — Sheet output title handling
**Findings:** SO-3  
**Files:** Sheet output module  
**Change:** Omit title from CSV payload. Pass title as out-of-band metadata instead.  
**Tests:** Assert title absent from CSV bytes. Assert title present in metadata object. Regression test for existing CSV consumers.  
**Commit type:** `fix`

---

### #10 — Preflight rework (largest design work)
**Findings:** PF-6, PF-7  
**Prerequisite:** #7 (orchestrator state signals)  
**Files:** `preflight.ts`, orchestrator state interface  
**Change:** Pass `action-was-invoked` and `gate-was-invoked` boolean signals from orchestrator state into `preflight`. Text heuristic demoted to defense-in-depth only — not primary gating logic.  
**Design note:** Requires defining the orchestrator→preflight signal interface before implementation. Section 2 must include interface proposal for explicit approval before coding begins.  
**Tests:** Test each signal combination (both false, action only, gate only, both true). Regression test that text heuristic still fires when signals are unavailable.  
**Commit type:** `refactor`

---

## Side items (non-blocking)

| Item | Source | Owner | Target |
|---|---|---|---|
| Add `FCM_PAYLOAD_KEY` to `.env.example` | Phase 2 queue, acknowledged Phase 3 audit | TBD | Append to any Tier 0+1 commit or standalone |
| Inject logger surface into orchestration modules (tracking #27) | Deferred from AG-10 during commit #6 | TBD | Phase 4 candidate — see issue #27 |

---

## Completion criteria

All 10 commits merged to `main`. GitHub Issues #1–10 closed. `REMEDIATION.md` status column updated to ✅ for all rows. Notion Roadmap/Task Backlog updated. Phase 4 (YELLOW backlog) planning can begin.
