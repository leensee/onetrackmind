# Dependabot daily audit

Runbook for the daily job that keeps Dependabot PRs from piling up. Tracking
issue for the automation: #124. Report log (one comment per run): #125.

## What one run does

1. Lists open Dependabot PRs and classifies each one:
   `ready` (all-green, up to date with `main`), `wait:*` (CI pending, behind
   `main`, blocked), or `hold:*` (draft, conflict, red CI, optionally major bump).
2. Squash-merges the first `ready` PR. Security updates go first, then oldest.
3. Branch protection is **strict**, so that merge puts every other PR `BEHIND`.
   The script comments `@dependabot rebase` on each one (once per head SHA),
   polls every 30 s, and merges the next PR when it turns `CLEAN`. This is the
   serial "rebase cascade" — with N PRs it costs N CI rounds. Do not bypass it.
4. Gives up on a PR that sits on the same head for 20 min (`stalled`) and on the
   whole run after 60 min; both are reported, never merged.
5. Local cleanup in the clone (`~/OneTrackMind/code`): `fetch --prune`,
   `worktree prune`, remove **clean** worktrees whose branch is gone or merged,
   delete local branches whose upstream is gone, fast-forward `main`. Dirty
   worktrees and non-empty orphan dirs are listed and left alone. The script
   also prunes its own run directories older than 30 days
   (`OTM_AUDIT_KEEP_DAYS`), so `.otm-audit/runs/` stays bounded.
6. Writes `summary.json` + `report.md` under `~/OneTrackMind/.otm-audit/runs/<ts>/`
   and dispatches `.github/workflows/dependabot-audit-report.yml`, which posts
   the report on #125 as `github-actions[bot]` — that comment is what GitHub
   emails to @leensee.

Exit codes: `0` settled, `2` something held/timed out, `3` preflight failure
(no `gh` auth, missing `jq`, or another run holds the lock).

## Running it

```bash
tools/dependabot-audit/audit.sh --dry-run --merge --cleanup   # classify only, no side effects
tools/dependabot-audit/audit.sh --merge --cleanup --report    # the daily run
tools/dependabot-audit/audit.sh --post notes.md               # deliver an addendum to #125
```

`gh` reads its token from the macOS keychain. The Claude Code Bash sandbox
blocks keychain access, so from a Claude session the script must run with the
sandbox disabled for that command; from a terminal it just works.

Flags: `--merge`, `--cleanup`, `--report`, `--dry-run`, `--hold-major`
(hold semver-major bumps for a human; off by default — the standing instruction
is "auto-merge on all green"), `--post FILE`.

Env: `OTM_REPO`, `OTM_CLONE`, `OTM_AUDIT_STATE`, `OTM_AUDIT_ISSUE`,
`OTM_AUDIT_POLL`, `OTM_AUDIT_MAX_TOTAL`, `OTM_AUDIT_MAX_ROUND`,
`OTM_AUDIT_KEEP_DAYS` (run-dir retention, default 30), `OTM_OWNER_HANDLE`.

## Merge rules

- Required checks that must be `SUCCESS`: `test`, `lint`,
  `GitGuardian Security Checks` — the same set enforced by branch protection and
  the `otm` ruleset. `NEUTRAL`/`SKIPPED` (CodeQL) is fine.
- Any `FAILURE` on *any* check holds the PR. "All green" means all green.
- Only PRs authored by `app/dependabot`. Human PRs are never touched.
- Merge method is squash, matching the repo's history.
- The script never force-pushes, never edits protection, never merges a `hold:*`.

## Scheduler

A Claude Code desktop **scheduled task** (`dependabot-daily-audit`, cron
`13 7 * * *` local, fires ~07:21 after scheduler jitter) runs the script and,
when anything is held or stalls, investigates the failing check and posts a
short "Analyst notes" addendum with `--post`. It runs while the Claude desktop
app is open; a missed run fires at next launch. Tool approvals granted during a
run are remembered by the task, so click "Run now" once after this lands to
pre-approve the sandbox-disabled `gh` call.

Headless fallback if the app is not open on the bench Mac: a user LaunchAgent
that calls the script directly and pipes `summary.json` to
`claude -p --model claude-fable-5-1` for the notes. Sketch:

```xml
<!-- ~/Library/LaunchAgents/com.otm.dependabot-audit.plist -->
<key>ProgramArguments</key>
<array><string>/bin/bash</string><string>-lc</string>
  <string>~/OneTrackMind/code/tools/dependabot-audit/audit.sh --merge --cleanup --report</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>13</integer></dict>
```

## Failure modes you will actually see

| Symptom in report | Meaning | Do |
|---|---|---|
| `hold:ci-red` | a check failed on the PR head | open the run link; if it is the dependency, close the PR with a comment, Dependabot will not reopen it |
| `hold:conflict` | Dependabot could not rebase cleanly | usually resolves on Dependabot's next weekly run; or `@dependabot recreate` |
| `stalled` | rebase requested but no new head / no CLEAN for 20 min | Dependabot backlog; the next daily run picks it up |
| `timed out` | run hit the 60 min budget | same as above; nothing was left half-done |
| cleanup `kept (dirty)` | a worktree has uncommitted changes | finish or discard the work by hand |
| exit 3 "another audit run holds lock" | a run is in progress (or crashed <2 h ago) | wait, or `rm -rf ~/OneTrackMind/.otm-audit/lock` if you are sure |

## Dependabot grouping (in place since PR #129)

`.github/dependabot.yml` groups backend minor/patch bumps into two PRs
(production / development by `dependency-type`), groups `/tools/bench-receiver`
and GitHub Actions bumps, and leaves majors as individual PRs so each is
visible. A typical week is therefore two or three PRs and the cascade settles
in one or two CI rounds. If a whole group is held, Dependabot's PR body lists
every member, so the culprit is still identifiable.
