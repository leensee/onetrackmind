# Copilot instructions — onetrackmind

Repository-specific context for GitHub Copilot code review and Copilot Chat.
Keep reviews grounded in the facts below.

## Repository layout

This is a two-part repo:

- **`app/`** — Flutter (Dart) client. Entry point `app/lib/main.dart`, `app/pubspec.yaml`. Not published to pub.dev (`publish_to: none`).
- **`backend/`** — Node/TypeScript orchestration service (CommonJS). This is where most reviewable logic lives. Built on **Fastify**, **Supabase** (`@supabase/supabase-js`), and the **Anthropic SDK** (`@anthropic-ai/sdk`). Source under `backend/src/` — notably `config/`, `orchestration/`, `orchestration/tools/`, and `orchestration/approvalGate/`.
- **`docs/`** — `audits/` (phase audit records) and `handoffs/` (session handoff specs). Treat these as the specs of record when a PR references them.

The **repository root** is legacy Dart-era scaffolding. The root `.gitignore`, and any root `node_modules/`, `package.json`, or `package-lock.json`, are **not** project files — the root `package.json` is APM/tooling injection and is intentionally gitignored. The real Node manifests are `backend/package.json` and `backend/package-lock.json`. Do not flag the root Node artifacts or suggest committing them.

## Backend build & test (run from `backend/`)

- **Build / type-check:** `npm run build` (`tsc`). Type errors are failures; changed code must type-check clean.
- **Tests:** `npm test` runs per-module suites as `ts-node` scripts via `tsconfig.test.json` (currently 23 suites, ~577 assertions). Changed or new backend logic should come with a matching `tests/<module>.test.ts`.
- **Fixtures corpus:** guarded by `tests/fixturesMeta.test.ts`, which enforces manifest↔filesystem sync, synthetic-only identifiers, and a no-invisible-character rule. Respect these invariants when touching `backend/tests/fixtures/`.

## Conventions

- **Commits:** Conventional Commits — `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
- **PRs:** link the associated issue with `Closes #N` / `Fixes #N` so it auto-closes on merge.
- **Commit email:** use the GitHub `noreply` email. The account blocks pushes that expose a private email (`GH007`), so commits authored with a personal email will be rejected.
- **Anthropic models:** when touching model calls, prefer current Claude models; keep `@anthropic-ai/sdk` on a patched version (Dependabot-tracked).

## What to prioritize in review

- **Correctness** in `backend/src/orchestration/*` — approval gate, tool dispatch, output routing, session persistence. Watch for unsafe coercion of DB/LLM reads and unhandled error paths.
- **Test coverage** — flag changed backend logic that lacks or weakens a `tests/*.test.ts`.
- **Security & PII** — no real secrets, tokens, emails, or phone numbers anywhere; fixtures and examples must use synthetic identifiers (`@example.com` emails, `555-01xx` phones). Validate external input; see `SECURITY.md`.
- **Dependencies** — call out newly introduced vulnerable or unmaintained packages.
