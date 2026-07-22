// ============================================================
// OTM Backend — ESLint gate (narrow, principle-mapped)
//
// Exactly seven rules; each traces to a governing principle or an
// Audit Standards §2 audit-surface criterion. No formatting, naming,
// or stylistic rules. No unused-export detection: the dormant comms
// modules (commsLogWriter, provider contracts in src/comms/) are
// deliberately unused pending Phase 12, with their tests retained in
// the active suite.
//
//   no-console                 error  Standing Principles §17 (injected Logger seam)
//   import/no-restricted-paths error  layer boundaries (zones below) — criterion 3
//   import/no-cycle            error  circular imports — criterion 3
//   @typescript-eslint/no-explicit-any        error  criterion 1
//   @typescript-eslint/no-non-null-assertion  error  criterion 1
//   @typescript-eslint/consistent-type-assertions ('never') error
//          criterion 1 — as-casts are escape hatches; 'as const' is
//          always exempt per the rule's documentation
//   no-warning-comments        WARN   criterion 10 — TODO/FIXME sweep
//          aid, deliberately not a gate; the lint script must never
//          pass --max-warnings
//
// Scope: TypeScript sources only. tests/run-all.mjs and this file are
// intentionally unlinted — the runner's console output is its harness
// function, and no TS rule applies to .mjs.
//
// Suppression convention (per-line, never blanket):
//   // eslint-disable-next-line <rule> -- <one-line reason> (otm#NN)
// Legacy console sites carry otm#27 (scheduled Logger-seam sweep);
// legacy as-casts carry otm#85 (as-cast audit).
// ============================================================

import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default [
  { ignores: ['dist/', 'dist-test/'] },

  // ── Base: all TypeScript (src + tests) ──────────────────────────
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      // Deliberately NO parserOptions.project: all seven rules are
      // syntactic; type-aware linting is out of scope.
      parserOptions: { sourceType: 'module' },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      import: importPlugin,
    },
    settings: {
      // Resolve extensionless relative imports ('./pure') to .ts files
      // so no-cycle / no-restricted-paths can follow them.
      'import/resolver': { node: { extensions: ['.ts', '.js'] } },
      'import/parsers': { '@typescript-eslint/parser': ['.ts'] },
    },
    linterOptions: {
      // v9 default, made explicit: stale suppressions surface as
      // non-gating warnings as the otm#27 sweep proceeds.
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // 1 — observability goes through the injected Logger seam
      //     (src/observability/logger.ts), never console.* directly.
      'no-console': 'error',

      // 2 — Layer boundaries: orchestration → comms → db, with
      //     observability and config as leaves. Paths resolve against
      //     the lint working directory, which is always backend/
      //     (npm script locally, working-directory in CI).
      //     SqliteClient/DiagnosticSeverity currently live in
      //     orchestration/types.ts and are consumed below the
      //     orchestration layer; types.ts is the sanctioned shared-
      //     contract surface until relocation (otm#86).
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/comms',
              from: './src/orchestration',
              except: ['./types.ts'],
              message:
                'Comms sits below Orchestration. Shared contracts may come from orchestration/types.ts only (relocation: otm#86).',
            },
            {
              target: './src/db',
              from: './src/orchestration',
              except: ['./types.ts'],
              message:
                'Data layer sits below Orchestration. Shared contracts may come from orchestration/types.ts only (relocation: otm#86).',
            },
            {
              target: './src/db',
              from: './src/comms',
              message:
                'Data layer sits below Communications and may not import from it.',
            },
            {
              target: './src/observability',
              from: './src/orchestration',
              message:
                'The Logger seam is a leaf; it may not import from Orchestration.',
            },
            {
              target: './src/observability',
              from: './src/comms',
              message:
                'The Logger seam is a leaf; it may not import from Communications.',
            },
            {
              target: './src/observability',
              from: './src/db',
              message:
                'The Logger seam is a leaf; it may not import from the Data layer.',
            },
            {
              target: './src/config',
              from: './src/orchestration',
              message:
                'Config must not depend on Orchestration (see src/config/env.ts).',
            },
            {
              target: './src/config',
              from: './src/comms',
              message: 'Config must not depend on Communications.',
            },
            {
              target: './src/config',
              from: './src/db',
              message: 'Config must not depend on the Data layer.',
            },
          ],
        },
      ],

      // 3 — Circular imports. Known limit (verified during gate
      //     bring-up): bare side-effect imports (`import './x'`) do
      //     not join the plugin's dependency graph, so a cycle formed
      //     only of them goes undetected. All current imports are
      //     named; keep it that way for cycle coverage.
      'import/no-cycle': ['error', { ignoreExternal: true }],

      // 4/5/6 — Type-safety escape hatches.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],

      // 7 — Sweep aid, NOT a gate. 'start' (not 'anywhere') so prose
      //     mentioning "todo" (todoTool.ts, section headers) stays
      //     quiet; only marker comments beginning TODO/FIXME warn.
      'no-warning-comments': [
        'warn',
        { terms: ['todo', 'fixme'], location: 'start' },
      ],
    },
  },

  // ── Tests: the harness prints to console by design; fixtures
  //    deliberately shape rows via casts and non-null assertions. ──
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },
];
