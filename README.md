# OneTrackMind

OneTrackMind (OTM) is a family of role-specific AI assistants for railroad
field operations personnel. The first edition, **OTM v1 — Mechanic /
Maintenance Coordinator**, is a field partner for a maintenance-of-way
mechanic. It drafts communications, purchase orders, expense records,
spec lookups, todos and diagnostic logs. It does this under a strict evidence
standard, safety redlines, and an approval gate: nothing is sent without
explicit user approval, and tool drafts pass through the gate before they are
written.

> **Status: pre-release, private use.** Nothing here is deployed. Only the
> latest commit on `main` is supported (see [SECURITY.md](SECURITY.md)).

## Where the project stands

The roadmap, decisions log and governing specs live outside this repo. This
section summarizes them as of **2026-09-08**.

| Phase | State |
| --- | --- |
| 1 — Foundation | Complete |
| 2 — Orchestration | Complete |
| 3 — Tool layer | Complete; audit and Tier 0/1 remediation finished 2026-04-24 ([REMEDIATION.md](docs/audits/REMEDIATION.md)) |
| 4 — Communications foundation (4.1) | Complete 2026-07-22. Provider integration moved to Phase 12; device-sync and push-receiver pieces moved to Phases 7 and 6 |
| **7 — Data layer** | **Current.** Design lock (7.0) in progress; 7.1 substrate build follows |
| 5, 6, 8, 9, 10, 12, 13, 11 | Not started |

The Build→Launch restructure (2026-07-21) changed the execution order to
**4-closeout → 7 → 5 → 6 → 8 → 9 → 10 → 12 → 13 → 11**. Phase identifiers did
not change. In summary:

- **Phase 7** is the long pole before anything user-visible.
- **Phase 12 (Communications Provider Integration)** defers *provider
  integration*: Microsoft Graph, IMAP/SMTP, Twilio, webhooks and delivery
  tracking. It does not defer communications as a capability.
- **Soft launch** targets iOS plus a full-parity web client.
- **Phase 13** covers Android, tablet layouts and wake word.

**Platform change not yet reflected in code.** The Phase 7 platform
re-assessment (2026-08-28) made three decisions:

- **Neon** is the authoritative store, and Supabase is retired.
- **Render** is the backend host.
- **Better Auth**, mounted on the Fastify backend, handles auth.

The backend code predates this. It still depends on `@supabase/supabase-js`
and reads `SUPABASE_*` env vars. Expect those to change during the 7.1 build.

## Repository layout

```
backend/   Node + TypeScript orchestration service (Fastify, Anthropic SDK)
app/       Flutter client — currently the iOS capture-path bench harness
tools/     Bench and maintenance tooling, isolated from the backend
docs/      Audit records, session handoffs, bench protocol and findings
```

### `backend/`

Most of the logic lives here, written as dependency-injected modules with a
test suite per module:

- `src/orchestration/` is the event pipeline. It runs event classification,
  context loading and prompt assembly, then the primary model call. Every
  response passes a two-layer audit (a deterministic pre-flight plus a model
  audit) before it reaches the approval gate and the output router. The same
  folder handles session persistence (log-first, with state replayed from the
  log).
- `src/orchestration/tools/` is the tool layer. It holds the comms drafter,
  PO generator, expense parser, spec lookup, todo tool, sheet (CSV) output
  and diagnostic logger.
- `src/comms/` holds the communications foundation: provider-agnostic
  contracts, content hashing, the idempotency checker and the comms-log
  writer. The provider interfaces are dormant until Phase 12 but stay in CI.
- `src/db/` and `migrations/` hold the SQLite client and a forward-only
  migration runner. Backend SQLite is transitional and retires in Phase 7,
  when the stores become Neon plus on-device Drift.
- `src/config/` holds environment loading and the versioned system prompt.

The pipeline modules are built and tested, but they are **not yet wired into
the server**. `src/index.ts` is a Fastify stub that serves only `GET /health`.
Migrations are run by hand and do not run at boot.

### `app/`

A Flutter project. Today it holds the **bench harness** for the iOS
capture-path spike (`lib/bench/`), not the product UI. Interface work is
Phase 6. Bench protocol and results are in [docs/bench/](docs/bench/).

### `tools/`

- [`bench-receiver/`](tools/bench-receiver/) is a LAN-only corpus receiver
  for the bench spike. It is a separate package with no import path from the
  backend, so it can never be mounted on it.
- [`wer/`](tools/wer/) holds word-error-rate scoring for the bench corpus.
  Transcription uses whisper.cpp and scoring is a stdlib-only Python script.
- [`dependabot-audit/`](tools/dependabot-audit/README.md) is the daily job
  that merges and cleans up Dependabot PRs.

## Getting started

All npm commands run from `backend/`. The repo-root `package.json` is
gitignored local tooling, not part of the project.

```bash
cd backend
npm ci
```

The current `npm run dev` stub needs no environment variables. Modules that
read config expect the variables listed in
[`backend/.env.example`](backend/.env.example), which also marks which ones are
required. Nothing loads a `.env` file automatically, so export the variables in
your shell or pass them with `node --env-file`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the server with reload (`tsx` + `nodemon`) on port 3000 |
| `npm run build` | Type-check and compile to `dist/` |
| `npm test` | Type-check, then run every `tests/*.test.ts` in its own process |
| `npm run test:<module>` | Run one suite, for example `test:gate` or `test:router` |
| `npm run lint` | ESLint; [`eslint.config.mjs`](backend/eslint.config.mjs) is the rule authority |
| `npm run migrate` | Apply pending migrations to `BACKEND_SQLITE_PATH` (default `data/backend.sqlite3`) |

For the Flutter app, run this from `app/`:

```bash
flutter analyze && flutter test
```

CI has no Flutter job, so that local run is the only gate for `app/` changes.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs two jobs on every
PR and push to `main`, both on Node 24 against `backend/`:

- `test` runs `npm run build` and `npm test`.
- `lint` runs `npm run lint`.

Branch protection requires both, plus a GitGuardian scan.

## Contributing

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, …) and a GitHub
  `noreply` commit email.
- Link the issue a PR addresses (`Closes #N`). See the
  [PR template](.github/pull_request_template.md).
- Review priorities and repo conventions are in
  [`.github/copilot-instructions.md`](.github/copilot-instructions.md).
- Fixtures and examples use synthetic identifiers only. Never commit real
  secrets, emails or phone numbers.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md). That file is the
disclosure policy only. OTM's security and compliance controls are governed
by a separate policy document maintained outside this repo.
