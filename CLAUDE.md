# OneTrackMind — repo guide

Pointers only. This file names where authority lives. It never restates a rule
enforced or documented elsewhere.

- Governing documents live in Notion, with co-canonical local `.docx` copies
  under `~/OneTrackMind/reference/Current/Policy`.
- Root `SECURITY.md` is a vulnerability-disclosure policy, not the OTM Security
  & Compliance Policy — two different documents; the root file has no authority
  over controls.
- `docs/` holds audits and handoffs, not standards.
- Design-precedent test for `app/`: files existing is not UI existing; UI
  existing is not a design precedent existing — each step is a separate check.
- Lint authority is `backend/eslint.config.mjs`. Do not restate rules here.
- npm commands run from `backend/` — a repo-root `package.json` is local,
  non-project APM scaffolding (gitignored).
