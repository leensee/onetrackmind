# OTM Audit Standards v1.0

**Status:** Settled — 2026-04-16
**Proposed location:** OneTrackMind > Documents > Policy > OTM Audit Standards v1.0
**Ranks alongside:** Code Generation and Audit Doc v2.0, Security & Compliance Policy v1.0

---

## Purpose

Codifies when OTM audits run, how they execute, and what artifacts they produce. Ensures audit output is reproducible across phases, comparable across editions, and traceable to source code. Cross-cutting policy — does not replace Code Gen v2.0 (which governs code production) or Security & Compliance Policy v1.0 (which defines the security conformance target). This document governs the audit process itself.

## Scope

Applies to all architectural, code, and conformance audits of OTM editions — OTM v1, OTM v2, and future editions.


## Section 1 — Audit triggers

Audits run at defined milestone gates and on trigger events. Unscheduled audits are permitted when justified.

### Mandatory audit gates

- End of Phase 2 (orchestration complete) — architecture audit
- End of Phase 3 (tool layer complete) — architecture + code audit
- End of Phase 6 (interface complete) — integration audit before Phase 7 wiring
- End of Phase 7 (data layer complete) — full-stack pre-launch audit
- Phase 8 (Security Audit phase) — full conformance sweep against Security & Compliance Policy v1.0
- Phase 9 (Test & calibrate) — behavioral audit of heuristic components
- Pre-launch of each edition (final blocker sweep)

### Drift audit triggers (active use — any of these fires a drift audit)

- Ten or more source-file modifications since the last audit
- New feature land (new tool, new orchestration module, new integration)
- RED or RED-adjacent finding surfaces in production (regression audit)
- Refactor affecting three or more modules (post-refactor verification)

### Calendar backstop

No more than 12 months between drift audits regardless of trigger state. Ensures slow drift gets caught and enforces at least annual review for continuous improvement.

### Optional audit triggers

- Before a major refactor affecting three or more modules (pre-refactor baseline)
- When a new edition is defined (audit predecessor edition for patterns that may repeat)
- On explicit user request


## Section 2 — Audit scope & parameters

Every OTM audit evaluates against a fixed set of criteria. Criteria are cumulative — later-phase audits inherit earlier criteria plus additions.

### Baseline criteria (apply to every audit)

1. Code structure, style, patterns, and naming consistency with Code Gen v2.0
2. Assumptions and dependencies without noted future design
3. Genericization — edition/client/provider-agnostic where claimed
4. Unnecessary AI reasoning where deterministic trees work
5. Phase-to-user-deliverable traceability
6. Component self-containment

### Audit-surface criteria (Phase 2+ code audits)

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

### Conformance criteria (Phase 8 Security Audit — adds to above)

17. All controls in Security & Compliance Policy v1.0 validated on live implementation
18. Full-stack threat model verification
19. Data retention, purge, and backup validated
20. Auth flow end-to-end
21. Secrets management audit

### Behavioral criteria (Phase 9 calibration audit — adds to above)

22. Heuristic rule accuracy (false-positive, false-negative rates)
23. Safety redline behavior on representative scenarios
24. Push/pull judgment calibration
25. Evidence standard enforcement on edge cases


## Section 3 — Audit methodology

Every audit executes in four stages. Stages may be interleaved but all four must complete before audit is finalized.

### Stage 0 — Prerequisite validation

Run the project's test suite in a clean environment. Capture any pre-existing failures. A failing test suite halts the audit — findings are indistinguishable from regressions until tests are stable. If a failure is detected, either fix-in-audit (document as part of the audit record) or abort until fixed.

### Stage 1 — Big-picture architecture check

Codebase-level checks that require the whole tree to evaluate. Performed via targeted searches (grep, directory listing, import graph walk). Finds patterns invisible at per-module depth.

**Minimum checks:**
- Layer discipline / import graph
- Silent-drop / unchecked-cast sweep
- Edition-specific literal sweep
- Cross-module constant duplication
- Test helper duplication
- Orchestrator decision contract compliance

Stage 1 may be executed before or after Stage 2 depending on audit scope.

### Stage 2 — Per-module deep audit

Every source file and every test file read and evaluated against baseline + audit-surface criteria. Each module produces a findings table with:

- Finding ID (scheme in Section 4)
- Level (RED / RED-adjacent YELLOW / YELLOW / GREEN)
- One-sentence finding with line reference if applicable

Modules chunked by logical boundary (prevents context exhaustion). Each chunk closes with pattern observations spanning modules seen so far.

### Stage 3 — Synthesis and remediation planning

- Cross-module pattern coherence confirmation
- Phase-to-next-phase readiness assessment
- Phase-to-user-deliverable walk (criterion #5)
- Consolidated remediation plan (tiered)
- Artifact production (Notion page, .docx, corrections to other docs)


## Section 4 — Finding taxonomy

Every finding gets exactly one level. Levels drive remediation priority.

### RED — Bug or data-integrity risk

Finding is a defect that will cause incorrect behavior in production. Examples: shared mutable state across users, SQL injection vector, unchecked race condition, hardcoded credentials. **Remediation is Tier 0 (must-fix before next phase).**

### RED-adjacent YELLOW — Architectural risk or significant drift

Finding is not a defect today but will become one under reasonable future conditions (additional user, edition change, scale growth). Examples: hardcoded edition name in a module claimed to be agnostic, silent-drop pattern that will cause debug-invisibility, text heuristic where structured approach exists. **Remediation is Tier 1 (fix before next phase closure) or Tier 0 if a specific blocker exists.**

### YELLOW — Code-quality or standards drift

Finding is a quality concern — style inconsistency, test gap, minor duplication, comment drift. Does not affect correctness. Examples: test file uses `beforeEach:` as a label instead of a hook, constant defined in three places with same value, missing test for utility module. **Remediation is Tier 2 (schedule at convenience) or Tier 3 (defer).**

### GREEN — Confirmed-correct

Explicit positive finding: a standard met, a pattern correctly applied, a settled design decision accurately implemented. **GREEN findings are reported alongside issues to prevent audit output from feeling one-sidedly negative; they also serve as future regression guards.**

### Finding ID scheme

Format: `YYYY-MM-DD-<ModulePrefix>-<Number>` for per-module findings.

Examples:
- `2026-04-16-OT-4` — 4th finding in orchestratorTools, from audit on 2026-04-16
- `2026-04-16-S1-L1` — 1st layer-discipline finding in Stage 1 of audit on 2026-04-16
- `2026-04-16-PH-1` — 1st phase-map finding in audit on 2026-04-16

Date-prefixing guarantees global uniqueness across all audits. Cross-audit references (regression tracking, commit messages) use full ID; within-audit references may use short form (e.g., `OT-4`) when context is unambiguous — same convention as `CVE-2024-XXXX` or `PR-1234` usage in practice.

Stage-level findings use `S<stage>-<Check><Number>`. Phase-map findings use `PH-<Number>`.

IDs are never reused across audits — the date prefix enforces this by construction.


## Section 5 — Reporting format

Every audit produces three artifacts. All three are mandatory.

### Artifact A — In-conversation detail

The raw finding stream as the audit is performed, delivered in chat. Enables in-the-moment questions, clarifications, and scope adjustments. Not a deliverable; the working record.

### Artifact B — Notion audit page

Permanent home for the audit. Lives as a child of the `Audit Log` top-level page.

**Filename format:** `<Phase> <Audit Type> — <YYYY-MM-DD>`
**Example:** `Phase 3 Architecture + Code Audit — 2026-04-16`

**Structure (every audit page has every section):**

1. **Audit Parameters** — triggers, criteria, scope, execution date, auditor, source code commit SHA at audit time
2. **Execution Structure** — stages executed, chunk breakdown, test suite state (Stage 0 result)
3. **Findings Index** — RED and RED-adjacent YELLOW findings inline; full table deferred to .docx when length exceeds Notion-practical threshold (~50 rows)
4. **Pattern Observations** — codebase-level patterns with instance counts
5. **Notion Corrections Applied** — change log for edits this audit made to other Notion pages
6. **Remediation Tracker** — tiered remediation list with commit SHAs once resolved
7. **Downloadable Report** — link to .docx

### Artifact C — Downloadable .docx report

Standalone document, self-contained, conformant to this Standards v1.0 format.

**Filename format:** `OTM-<Phase>-Audit-<YYYY-MM-DD>.docx`
**Distribution:** attached to Notion audit page, committed to repo at `docs/audits/<YYYY-MM-DD>-<phase>/`, also downloadable ad-hoc

**Content rules:**
- Complete findings — every finding in full, including YELLOW and GREEN
- No cuts — only tightening size through denser tables, consolidated subsections, and removed padding
- Self-contained prose — does not reference Notion links as the primary path to detail
- Tables preferred over prose for findings (one row per finding)

### Audit content priority rule

When information is significantly large, defer to .docx and link from Notion. Notion page carries the audit story and RED-tier findings. The .docx carries completeness.


## Section 6 — Handoff protocol

Every audit produces corrections to other Notion documents. Every audit adds a Decisions Log entry.

### Notion correction wording rules

- Corrections are additive when possible (add a subsection, not rewrite)
- Every correction states the finding ID and audit date for traceability
- Removal of prior text requires explicit replacement text — never delete-without-replace
- Test count updates include both the prior count and the reconciled count with rationale
- Phase status is never downgraded retroactively — instead, add a "Re-validated <date>" note with new state

### Remediation tier assignment criteria

| Tier | Definition | Execution window |
|---|---|---|
| 0 | Must-fix before current phase closure OR before next phase build begins | Immediately upon audit finalization |
| 1 | Fix during next phase build, before next phase closure | Next phase (tracked via Task Backlog) |
| 2 | Fix at convenience, schedule into a later phase | Flagged in Task Backlog, not phase-blocking |
| 3 | Defer — document only, revisit in later audit | Tracked in Audit page only, not Task Backlog |
| 4 | Defer to next edition intake (OTM v2+) | Tracked in Edition intake worksheet |

**Tier promotions (T2 → T1, etc.) are permitted when a later finding interacts with an earlier one.** Document the promotion in the audit page with rationale.

### Commit message format for audit-driven fixes

```
<type>: <concise change description>

<one-paragraph body explaining what changed and why>

Resolves audit finding <ID> (<audit short-name>).
Ref: Decisions Log '<Decisions Log entry name>'.
```

**Example:**

```
fix: persist PO sequence counter to DB

Replaces module-level mutable counter with DB-backed sequence per user.
Eliminates cross-session/cross-user collision risk under multi-user
instance model.

Resolves audit finding 2026-04-16-OT-4 (Phase 3 audit 2026-04-16).
Ref: Decisions Log 'Phase 3 architecture + code audit'.
```

### Audit finalization checklist

- [ ] All four stages completed
- [ ] Findings count totaled by level (RED / RED-adj / YELLOW / GREEN)
- [ ] Pattern observations consolidated
- [ ] Remediation plan tiered and user-approved
- [ ] Notion Audit Log child page created with all seven sections
- [ ] .docx report generated with complete findings
- [ ] Notion corrections to other pages applied
- [ ] Decisions Log entry added
- [ ] Task Backlog updated with Tier 0/1 remediation items
- [ ] Audit commit (if any in-audit fixes) committed and referenced

## Section 7 — Version history

| Version | Date | Change |
|---|---|---|
| v1.0 | 2026-04-16 | Initial. Codified during Phase 3 audit. |
