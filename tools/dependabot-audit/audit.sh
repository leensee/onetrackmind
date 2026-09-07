#!/usr/bin/env bash
# tools/dependabot-audit/audit.sh — daily Dependabot PR audit for leensee/onetrackmind.
#
# Each step is opt-in by flag so the script can be run read-only:
#   --merge       squash-merge every open Dependabot PR that is all-green and up to
#                 date with main. Branch protection is strict, so each merge puts the
#                 others BEHIND; the script comments `@dependabot rebase` on them and
#                 waits for CI before merging the next one. It never bypasses a check,
#                 never force-pushes, never merges a PR it classified as held.
#   --cleanup     local clone: fetch --prune, git worktree prune, remove clean worktrees
#                 whose branch is gone/merged, delete local branches whose upstream is
#                 gone, fast-forward main. Dirty worktrees are always left alone. Also
#                 prunes this script's own run directories older than OTM_AUDIT_KEEP_DAYS.
#   --report      dispatch .github/workflows/dependabot-audit-report.yml, which posts the
#                 Markdown report on the tracking issue as github-actions[bot] so GitHub
#                 emails the owner (a self-authored comment would not notify).
#   --dry-run     classify + render only: no merges, comments, deletions, or dispatch.
#   --hold-major  additionally hold semver-major bumps for a human (default: merge them
#                 when green, per the standing instruction "auto-merge on all green").
#   --post FILE   deliver an arbitrary Markdown file via the report workflow and exit
#                 (used by the scheduled task for analyst addenda).
#   --detach      start the run in the background (nohup, own log at
#                 $OTM_AUDIT_STATE/last-run.log), return once it holds the lock. Use this
#                 from any caller whose own call has a timeout — a full cascade can take
#                 longer than the 10-minute cap on a single Claude Code tool call.
#   --wait [SEC]  block until no run holds the lock, or SEC seconds (default 570) pass.
#                 Exit 0 = finished, 3 = still running (call again). Needs no gh auth.
#   --quiet-if-idle  with --report: skip the dispatch (no email) when the run merged,
#                 held, and timed out nothing, no PRs remain open, and cleanup changed
#                 nothing. The report is still written locally.
#   --heartbeat DOW  with --quiet-if-idle: always dispatch on this weekday anyway
#                 (0 = Sunday … 6 = Saturday) so a quiet week still proves the job runs.
#
# Required checks (must all be SUCCESS): test, lint, GitGuardian Security Checks —
# the same set enforced by branch protection + the `otm` ruleset. Any FAILURE on any
# other check (e.g. CodeQL) also holds the PR: "all green" means all green.
#
# Signals: on TERM/INT/HUP the run finalizes early — writes summary.json and report.md
# marked "interrupted", dispatches the report if --report, releases the lock, exits 2.
# Merges already made are on GitHub; PRs still waiting simply retry on the next run.
#
# Output: Markdown report on stdout; JSON + Markdown copies under $OTM_AUDIT_STATE/runs/.
# Exit: 0 settled (nothing left waiting), 2 held/timed out/interrupted, 3 preflight failure.
#
# Environment overrides:
#   OTM_REPO (leensee/onetrackmind)  OTM_CLONE (~/OneTrackMind/code)
#   OTM_AUDIT_STATE (~/OneTrackMind/.otm-audit)  OTM_AUDIT_ISSUE (125)
#   OTM_AUDIT_POLL (30s)  OTM_AUDIT_MAX_TOTAL (3600s)  OTM_AUDIT_MAX_ROUND (1200s)
#   OTM_AUDIT_KEEP_DAYS (30)
#
# Portability: written for macOS /bin/bash 3.2 (no associative arrays, no mapfile).

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REPO="${OTM_REPO:-leensee/onetrackmind}"
CLONE="${OTM_CLONE:-$HOME/OneTrackMind/code}"
STATE_DIR="${OTM_AUDIT_STATE:-$HOME/OneTrackMind/.otm-audit}"
LOCK="$STATE_DIR/lock"
TRACKING_ISSUE="${OTM_AUDIT_ISSUE:-125}"
REPORT_WORKFLOW="dependabot-audit-report.yml"
POLL_SECONDS="${OTM_AUDIT_POLL:-30}"
MAX_TOTAL="${OTM_AUDIT_MAX_TOTAL:-3600}"
MAX_ROUND="${OTM_AUDIT_MAX_ROUND:-1200}"
REQUIRED_JSON='["test","lint","GitGuardian Security Checks"]'
OWNER_HANDLE="${OTM_OWNER_HANDLE:-leensee}"

DO_MERGE=0; DO_CLEANUP=0; DO_REPORT=0; DRY_RUN=0; HOLD_MAJOR=0; POST_FILE=""; DETACH=0; WAIT_SECONDS=""
QUIET_IF_IDLE=0; HEARTBEAT_DOW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --merge) DO_MERGE=1 ;;
    --cleanup) DO_CLEANUP=1 ;;
    --report) DO_REPORT=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --hold-major) HOLD_MAJOR=1 ;;
    --post) shift; POST_FILE="${1:-}" ;;
    --detach) DETACH=1 ;;
    --quiet-if-idle) QUIET_IF_IDLE=1 ;;
    --heartbeat)
      shift; HEARTBEAT_DOW="${1:-}"
      printf '%s' "$HEARTBEAT_DOW" | grep -Eq '^[0-6]$' || { echo "--heartbeat expects a weekday 0-6 (0 = Sunday)" >&2; exit 3; } ;;
    --wait)
      WAIT_SECONDS=570
      if [ $# -gt 1 ] && printf '%s' "$2" | grep -Eq '^[0-9]+$'; then WAIT_SECONDS="$2"; shift; fi ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 3 ;;
  esac
  shift
done

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
now() { date +%s; }
utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# ------------------------------------------------------------------- wait ----
# Needs no gh auth: a caller with a bounded tool timeout polls in chunks.
if [ -n "$WAIT_SECONDS" ]; then
  waited=0
  while [ -d "$LOCK" ] && [ "$waited" -lt "$WAIT_SECONDS" ]; do sleep 5; waited=$((waited + 5)); done
  if [ -d "$LOCK" ]; then
    echo "still running after ${WAIT_SECONDS}s (lock held: $LOCK); call --wait again"
    exit 3
  fi
  echo "no audit run in progress"
  latest="$(ls -td "$STATE_DIR"/runs/*/ 2>/dev/null | head -1 || true)"
  [ -n "$latest" ] && echo "latest run: ${latest%/}"
  [ -f "$STATE_DIR/last-run.log" ] && echo "log: $STATE_DIR/last-run.log"
  exit 0
fi

# ----------------------------------------------------------------- detach ----
# Re-exec without --detach under nohup, then return once the child holds the
# lock (or has exited), so a following --wait cannot race the startup.
if [ "$DETACH" = 1 ]; then
  mkdir -p "$STATE_DIR"
  DETACH_LOG="$STATE_DIR/last-run.log"
  args=()
  [ "$DO_MERGE" = 1 ]   && args+=(--merge)
  [ "$DO_CLEANUP" = 1 ] && args+=(--cleanup)
  [ "$DO_REPORT" = 1 ]  && args+=(--report)
  [ "$DRY_RUN" = 1 ]    && args+=(--dry-run)
  [ "$HOLD_MAJOR" = 1 ] && args+=(--hold-major)
  [ "$QUIET_IF_IDLE" = 1 ] && args+=(--quiet-if-idle)
  [ -n "$HEARTBEAT_DOW" ]  && args+=(--heartbeat "$HEARTBEAT_DOW")
  nohup "$0" "${args[@]+"${args[@]}"}" > "$DETACH_LOG" 2>&1 &
  child=$!
  for _ in $(seq 1 60); do
    { [ -d "$LOCK" ] && kill -0 "$child" 2>/dev/null; } && break
    kill -0 "$child" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$child" 2>/dev/null; then
    echo "started pid $child (${args[*]:-no flags}); log: $DETACH_LOG"
    echo "poll with: $0 --wait 570   (exit 0 = finished, 3 = still running)"
    exit 0
  fi
  echo "run exited before it could start (another run may hold the lock); log tail:" >&2
  tail -5 "$DETACH_LOG" >&2 || true
  exit 3
fi

# ---------------------------------------------------------------- delivery ----
# Posts a Markdown file through the report workflow. Inputs to workflow_dispatch
# are capped at 65,535 chars in total, so oversize reports are truncated with a
# note rather than failing the run.
deliver() {
  local file="$1" b64 max=60000
  b64="$(base64 < "$file" | tr -d '\n')"
  if [ "${#b64}" -gt "$max" ]; then
    log "report too large for workflow_dispatch (${#b64} chars); truncating"
    { head -c 40000 "$file"; printf '\n\n_…truncated; full report on the bench Mac under %s_\n' "$STATE_DIR/runs"; } > "$file.trunc"
    b64="$(base64 < "$file.trunc" | tr -d '\n')"; rm -f "$file.trunc"
  fi
  if [ "$DRY_RUN" = 1 ]; then log "dry-run: would dispatch $REPORT_WORKFLOW -> issue #$TRACKING_ISSUE"; return 0; fi
  if gh workflow run "$REPORT_WORKFLOW" --repo "$REPO" -f "report_b64=$b64" -f "issue=$TRACKING_ISSUE" >&2; then
    log "dispatched $REPORT_WORKFLOW -> issue #$TRACKING_ISSUE"
  else
    log "WARNING: workflow dispatch failed; report kept locally only"; return 1
  fi
}

if [ -n "$POST_FILE" ]; then
  [ -s "$POST_FILE" ] || { echo "--post: file missing or empty: $POST_FILE" >&2; exit 3; }
  deliver "$POST_FILE"; exit $?
fi

# --------------------------------------------------------------- preflight ----
for bin in gh jq git; do command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 3; }; done
if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated (on macOS the keychain must be reachable — the Claude Code Bash sandbox blocks it; run with the sandbox disabled)" >&2
  exit 3
fi

mkdir -p "$STATE_DIR/runs"
if ! mkdir "$LOCK" 2>/dev/null; then
  # A lock older than 2h is a crashed run; anything younger is a live one.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK"; else
    echo "another audit run holds $LOCK; refusing to run concurrently" >&2; exit 3; fi
fi
STARTED_AT="$(utc)"; T0="$(now)"
RUN_ID="$(date '+%Y-%m-%dT%H-%M-%S')"
RUN_DIR="$STATE_DIR/runs/$RUN_ID"; mkdir -p "$RUN_DIR"
EVENTS="$RUN_DIR/events.jsonl"; : > "$EVENTS"
trap 'rm -rf "$LOCK"' EXIT

event() { # event <type> <json-object-fields...>
  local type="$1"; shift
  jq -nc --arg t "$type" --arg at "$(utc)" "$@" '{type:$t, at:$at} + ($ARGS.named | del(.t, .at))' >> "$EVENTS"
}

# Interruptible sleep: `wait` returns as soon as a trapped signal arrives,
# where a foreground `sleep` would make bash defer the handler until it ended.
nap() { sleep "$1" & wait $! || true; }

# ------------------------------------------------------------ classification ----
# Normalises statusCheckRollup (CheckRun + StatusContext shapes) and assigns one
# verdict per PR:  ready | wait:<why> | hold:<why>
CLASSIFY_JQ='
def norm: map({
  name: (.name // .context // "?"),
  state: (if .__typename == "StatusContext" then (.state // "PENDING")
          elif .status == "COMPLETED" then (.conclusion // "UNKNOWN")
          else "PENDING" end),
  url: (.detailsUrl // .targetUrl // null)
});
def green: IN("SUCCESS","NEUTRAL","SKIPPED");
def red:   IN("FAILURE","ERROR","CANCELLED","TIMED_OUT","ACTION_REQUIRED","STARTUP_FAILURE","STALE");
def majors: ([ .title        | scan("[Bb]umps? .* from ([0-9]+)\\.[0-9][^ ]* to ([0-9]+)\\.[0-9]") ]
             + [ (.body // "") | scan("Updates `[^`]+` from ([0-9]+)\\.[0-9][^ ]* to ([0-9]+)\\.[0-9]") ])
            | map(select(.[0] != .[1])) | length > 0;   # title + Dependabot summary lines only, never release notes
def security: ((.labels // []) | map(.name) | index("security") != null)
              or (.headRefName | test("/npm_and_yarn-[0-9a-f]+$"));
. as $pr
| ($pr.statusCheckRollup // [] | norm) as $checks
| ($required | map(. as $r | {name: $r, states: [$checks[] | select(.name == $r) | .state]})) as $req
| ($req | map(select(any(.states[]; red))) | map(.name)) as $req_red
| ($req | map(select((.states | length) == 0 or any(.states[]; (green or red) | not))) | map(.name)) as $req_pending
| ([$checks[] | select(.state | red) | .name] | unique) as $any_red
| {
    number: $pr.number, title: $pr.title, url: $pr.url, branch: $pr.headRefName, head: $pr.headRefOid,
    createdAt: $pr.createdAt, mergeStateStatus: $pr.mergeStateStatus, mergeable: $pr.mergeable,
    isDraft: $pr.isDraft, security: ($pr | security), major: ($pr | majors),
    checks: $checks, red: $any_red, pending: $req_pending,
    verdict: (
      if $pr.isDraft then "hold:draft"
      elif $pr.mergeable == "CONFLICTING" or $pr.mergeStateStatus == "DIRTY" then "hold:conflict"
      elif ($any_red | length) > 0 then "hold:ci-red"
      elif ($hold_major and ($pr | majors)) then "hold:major"
      elif ($req_pending | length) > 0 then "wait:ci-pending"
      elif $pr.mergeStateStatus == "BEHIND" then "wait:behind"
      elif $pr.mergeStateStatus == "CLEAN" or $pr.mergeStateStatus == "HAS_HOOKS" or $pr.mergeStateStatus == "UNSTABLE" then "ready"
      elif $pr.mergeStateStatus == "BLOCKED" then "wait:blocked"
      else "wait:" + ($pr.mergeStateStatus // "unknown" | ascii_downcase) end)
  }'

fetch_prs() { # -> JSON array of classified PRs, security-first then oldest-first
  gh pr list --repo "$REPO" --state open --author app/dependabot --limit 100 \
    --json number,title,body,url,headRefName,headRefOid,createdAt,isDraft,mergeable,mergeStateStatus,labels,statusCheckRollup \
  | jq --argjson required "$REQUIRED_JSON" --argjson hold_major "$([ "$HOLD_MAJOR" = 1 ] && echo true || echo false)" \
       "map($CLASSIFY_JQ) | sort_by((if .security then 0 else 1 end), .number)"
}

# ------------------------------------------------------------------ finalize ----
# Writes summary.json + report.md and (optionally) dispatches the report. Called at
# the end of a normal run and from the signal handler with status "interrupted".
PRS="[]"; FINAL_PRS=""; CLEANUP='{"skipped":true}'
finalize() {
  local status="${1:-settled}" other_prs open_issues duration summary report_md prs_json
  prs_json="${FINAL_PRS:-$PRS}"
  if [ "$status" = "interrupted" ]; then
    other_prs="?"; open_issues="?"   # no more gh calls than necessary while the clock runs
  else
    other_prs="$(gh pr list --repo "$REPO" --state open --limit 100 --json number,author --jq '[.[] | select(.author.login != "app/dependabot")] | length' 2>/dev/null || echo "?")"
    open_issues="$(gh issue list --repo "$REPO" --state open --limit 200 --json number --jq 'length' 2>/dev/null || echo "?")"
  fi
  duration=$(( $(now) - T0 ))

  summary="$(jq -nc \
    --arg repo "$REPO" --arg started "$STARTED_AT" --arg finished "$(utc)" --argjson duration "$duration" \
    --arg status "$status" \
    --argjson dry_run "$([ "$DRY_RUN" = 1 ] && echo true || echo false)" \
    --argjson flags "$(jq -nc --argjson m "$DO_MERGE" --argjson c "$DO_CLEANUP" --argjson r "$DO_REPORT" --argjson h "$HOLD_MAJOR" '{merge:($m==1),cleanup:($c==1),report:($r==1),hold_major:($h==1)}')" \
    --slurpfile events "$EVENTS" --argjson prs "$prs_json" --argjson cleanup "$CLEANUP" \
    --arg other_prs "$other_prs" --arg open_issues "$open_issues" '
    {repo:$repo, status:$status, started:$started, finished:$finished, duration_s:$duration, dry_run:$dry_run, flags:$flags,
     merged: [$events[] | select(.type=="merged")],
     held:   ([$events[] | select(.type=="held")] + [$prs[] | select(.verdict|startswith("hold:")) | {number, title, url, reason:(.verdict|ltrimstr("hold:")), detail:((.red|join(", ")) // "")}]) | unique_by(.number),
     timed_out: [$events[] | select(.type=="timeout")],
     rebases_requested: [$events[] | select(.type=="rebase_requested") | .number],
     open_after: $prs | map({number, title, url, verdict, mergeStateStatus, security, major}),
     cleanup: $cleanup, other_open_prs:$other_prs, open_issues:$open_issues}')"
  printf '%s\n' "$summary" > "$RUN_DIR/summary.json"

  report_md="$RUN_DIR/report.md"
  printf '%s' "$summary" | jq -r --arg owner "$OWNER_HANDLE" --arg tz "$(date '+%Z')" --arg local "$(date '+%Y-%m-%d %H:%M')" '
    def li(a; f): if (a|length)==0 then "- _none_" else (a | map("- " + f) | join("\n")) end;
    "## Dependabot audit — \($local) \($tz)" + (if .dry_run then " _(dry run)_" else "" end) + (if .status == "interrupted" then " _(interrupted)_" else "" end),
    "cc @\($owner) · `\(.repo)` · " + ([.flags | to_entries[] | select(.value) | "--" + .key] | join(" ")) + " · \(.duration_s / 60 | floor)m\(.duration_s % 60)s",
    (if .status == "interrupted" then
      "\n**Interrupted** — the run was stopped by a signal before it settled. Merges already made are on GitHub; PRs still waiting simply retry on the next run. Nothing is half-done."
     else "" end),
    "",
    "**Merged (\(.merged|length))**",
    li(.merged; "#\(.number) \(.title) — `\(.sha)`"),
    "",
    "**Held (\(.held|length))** — not merged; needs a human or a fresh CI run",
    li(.held; "#\(.number) \(.title) — **\(.reason)**" + (if (.detail // "") != "" then " (\(.detail))" else "" end)),
    "",
    "**Timed out this run (\(.timed_out|length))** — still open, will retry tomorrow",
    li(.timed_out; "#\(.number) \(.title) — \(.verdict)"),
    "",
    "**Open Dependabot PRs after run (\(.open_after|length))**",
    li(.open_after; "#\(.number) \(.title) — \(.verdict)" + (if .security then " · security" else "" end) + (if .major then " · major bump" else "" end)),
    "",
    "**Local cleanup** (" + (if .cleanup.skipped then "skipped" + (if .cleanup.reason then ": " + .cleanup.reason else "" end) else
        "worktrees removed: \(.cleanup.worktrees_removed|length) · branches deleted: \(.cleanup.branches_deleted|length) · dirty worktrees kept: \(.cleanup.kept_dirty|length) · old run dirs pruned: \(.cleanup.runs_pruned // 0) · \(.cleanup.main)" end) + ")",
    (if (.cleanup.skipped|not) then
       ([ (.cleanup.worktrees_removed[]? | "- removed worktree " + .),
          (.cleanup.branches_deleted[]?  | "- deleted branch `" + . + "`"),
          (.cleanup.kept_dirty[]?        | "- kept (dirty) " + .),
          (.cleanup.orphan_dirs[]?       | "- orphan dir " + .) ] | join("\n"))
     else "" end),
    "",
    "**Queue snapshot:** other open PRs: \(.other_open_prs) · open issues: \(.open_issues)",
    "",
    "_Rebases requested: \(.rebases_requested|length) · run `\(.started)` → `\(.finished)` · state on the bench Mac under `.otm-audit/runs/`_"
  ' | sed '/^$/N;/^\n$/D' > "$report_md"

  cat "$report_md"

  # Delivery decision. "Idle" = settled with nothing merged/held/timed out, no PRs
  # left open, and cleanup changed nothing. With --quiet-if-idle such a run stays
  # local unless today is the heartbeat weekday.
  local delivery="not_requested"
  if [ "$DO_REPORT" = 1 ]; then
    local idle today_dow
    idle="$(printf '%s' "$summary" | jq -r '
      (.status == "settled") and (.merged|length) == 0 and (.held|length) == 0 and (.timed_out|length) == 0
      and (.open_after|length) == 0
      and ((.cleanup.skipped == true) or (
            (.cleanup.worktrees_removed|length) == 0 and (.cleanup.branches_deleted|length) == 0
            and (.cleanup.orphan_dirs|length) == 0 and ((.cleanup.runs_pruned // 0) == 0)))')"
    today_dow="$(date '+%w')"
    if [ "$QUIET_IF_IDLE" = 1 ] && [ "$idle" = "true" ] && [ "$today_dow" != "$HEARTBEAT_DOW" ]; then
      log "quiet run: nothing to report and today (weekday $today_dow) is not the heartbeat day — report kept locally, no dispatch"
      delivery="skipped_idle"
    elif deliver "$report_md"; then
      delivery="$([ "$DRY_RUN" = 1 ] && echo dry_run || echo dispatched)"
    else
      delivery="dispatch_failed"
    fi
  fi
  # Record the outcome so the scheduled task can say whether an email went out.
  jq --arg d "$delivery" '. + {report_delivery: $d}' "$RUN_DIR/summary.json" > "$RUN_DIR/summary.json.tmp" \
    && mv "$RUN_DIR/summary.json.tmp" "$RUN_DIR/summary.json"
}

on_signal() {
  local sig="$1"
  trap - TERM INT HUP
  log "received SIG$sig — finalizing early (merges already made are safe; waiting PRs retry next run)"
  event interrupted --arg signal "$sig"
  finalize interrupted
  rm -rf "$LOCK"
  exit 2
}
trap 'on_signal TERM' TERM
trap 'on_signal INT'  INT
trap 'on_signal HUP'  HUP

# ------------------------------------------------------------------ merge ----
# Per-PR scratch files replace bash 4 associative arrays:
#   rebase.<n>      head sha at which we last asked Dependabot to rebase
#   wait.<n>        "<epoch> <sha>" when we first saw this head waiting
#   attempts.<n>    merge attempts
#   held.<n>        terminal verdict decided by this run (stalled / merge-failed)
request_rebase() {
  local n="$1" head="$2"
  if [ -f "$RUN_DIR/rebase.$n" ] && [ "$(cat "$RUN_DIR/rebase.$n")" = "$head" ]; then return 0; fi
  if [ "$DRY_RUN" = 1 ]; then log "dry-run: would comment '@dependabot rebase' on #$n"; else
    gh pr comment "$n" --repo "$REPO" --body "@dependabot rebase" >/dev/null && log "asked Dependabot to rebase #$n"
  fi
  echo "$head" > "$RUN_DIR/rebase.$n"
  event rebase_requested --argjson number "$n" --arg head "$head"
}

merge_pr() {
  local n="$1" title="$2" attempts sha
  attempts=$(( $(cat "$RUN_DIR/attempts.$n" 2>/dev/null || echo 0) + 1 )); echo "$attempts" > "$RUN_DIR/attempts.$n"
  if [ "$DRY_RUN" = 1 ]; then
    log "dry-run: would squash-merge #$n — $title"; event merged --argjson number "$n" --arg title "$title" --arg sha "dry-run"; return 0
  fi
  if gh pr merge "$n" --repo "$REPO" --squash 2>"$RUN_DIR/merge.$n.err"; then
    sha="$(gh pr view "$n" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid // ""' 2>/dev/null | cut -c1-7)"
    log "merged #$n ($sha) — $title"
    event merged --argjson number "$n" --arg title "$title" --arg sha "$sha"
    return 0
  fi
  log "merge of #$n failed (attempt $attempts): $(tr '\n' ' ' < "$RUN_DIR/merge.$n.err")"
  if [ "$attempts" -ge 3 ]; then
    echo "merge-failed" > "$RUN_DIR/held.$n"
    event held --argjson number "$n" --arg title "$title" --arg reason "merge-failed" --arg detail "$(tr '\n' ' ' < "$RUN_DIR/merge.$n.err")"
  fi
  return 1
}

note_stall() { # returns 0 if the PR has been waiting on the same head longer than MAX_ROUND
  local n="$1" head="$2" since prev
  if [ -f "$RUN_DIR/wait.$n" ]; then
    read -r since prev < "$RUN_DIR/wait.$n"
    if [ "$prev" != "$head" ]; then echo "$(now) $head" > "$RUN_DIR/wait.$n"; return 1; fi
    [ $(( $(now) - since )) -gt "$MAX_ROUND" ]
  else
    echo "$(now) $head" > "$RUN_DIR/wait.$n"; return 1
  fi
}

if [ "$DO_MERGE" = 1 ]; then
  log "merge pass: repo=$REPO required=$REQUIRED_JSON budget=${MAX_TOTAL}s round=${MAX_ROUND}s dry_run=$DRY_RUN"
  merged_in_dry_run=""   # dry-run cannot observe its own merges; stop after the first "would merge"
  while :; do
    PRS="$(fetch_prs)"
    # Drop PRs this run already gave up on.
    for f in "$RUN_DIR"/held.*; do
      [ -e "$f" ] || continue
      n="${f##*.}"; reason="$(cat "$f")"
      PRS="$(printf '%s' "$PRS" | jq --argjson n "$n" --arg r "$reason" 'map(if .number == $n then .verdict = "hold:" + $r else . end)')"
    done
    count="$(printf '%s' "$PRS" | jq length)"
    [ "$count" -eq 0 ] && { log "no open Dependabot PRs"; break; }

    ready="$(printf '%s' "$PRS" | jq -c '[.[] | select(.verdict == "ready")] | first // empty')"
    if [ -n "$ready" ]; then
      n="$(printf '%s' "$ready" | jq -r .number)"; t="$(printf '%s' "$ready" | jq -r .title)"
      if [ "$DRY_RUN" = 1 ]; then
        [ -n "$merged_in_dry_run" ] && break
        merge_pr "$n" "$t" || true; merged_in_dry_run="$n"
        continue
      fi
      merge_pr "$n" "$t" || nap 10
      continue   # re-fetch: the others are now BEHIND
    fi

    waiting="$(printf '%s' "$PRS" | jq -c '[.[] | select(.verdict | startswith("wait:"))]')"
    wcount="$(printf '%s' "$waiting" | jq length)"
    [ "$wcount" -eq 0 ] && { log "nothing ready, nothing waiting — settled"; break; }
    if [ $(( $(now) - T0 )) -gt "$MAX_TOTAL" ]; then
      log "run budget (${MAX_TOTAL}s) exhausted with $wcount PR(s) still waiting"
      printf '%s' "$waiting" | jq -c '.[]' | while read -r p; do
        event timeout --argjson number "$(printf '%s' "$p" | jq .number)" --arg title "$(printf '%s' "$p" | jq -r .title)" --arg verdict "$(printf '%s' "$p" | jq -r .verdict)"
      done
      break
    fi
    # Ask for rebases where needed; detect stalls on everything waiting.
    printf '%s' "$waiting" | jq -c '.[]' | while read -r p; do
      n="$(printf '%s' "$p" | jq -r .number)"; h="$(printf '%s' "$p" | jq -r .head)"; v="$(printf '%s' "$p" | jq -r .verdict)"
      [ "$v" = "wait:behind" ] && request_rebase "$n" "$h"
      if note_stall "$n" "$h"; then
        echo "stalled" > "$RUN_DIR/held.$n"; log "#$n stalled in $v for >${MAX_ROUND}s; giving up on it this run"
        event held --argjson number "$n" --arg title "$(printf '%s' "$p" | jq -r .title)" --arg reason "stalled" --arg detail "$v for >${MAX_ROUND}s at head $h"
      fi
    done
    [ "$DRY_RUN" = 1 ] && { log "dry-run: would now poll every ${POLL_SECONDS}s"; break; }
    log "waiting on $wcount PR(s): $(printf '%s' "$waiting" | jq -r 'map("#\(.number) \(.verdict)") | join(", ")')"
    nap "$POLL_SECONDS"
  done
else
  PRS="$(fetch_prs)"
fi
FINAL_PRS="$(fetch_prs)"

# ---------------------------------------------------------------- cleanup ----
if [ "$DO_CLEANUP" = 1 ]; then
  # Own state first: drop run directories older than OTM_AUDIT_KEEP_DAYS
  # (default 30). The current run's directory is brand new and untouched.
  KEEP_DAYS="${OTM_AUDIT_KEEP_DAYS:-30}"
  runs_pruned=0
  while IFS= read -r old_run; do
    [ -n "$old_run" ] || continue
    if [ "$DRY_RUN" = 1 ]; then log "dry-run: would prune old run dir $old_run"; else rm -rf "$old_run"; fi
    runs_pruned=$((runs_pruned + 1))
  done < <(find "$STATE_DIR/runs" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" 2>/dev/null)
  [ "$runs_pruned" -gt 0 ] && log "pruned $runs_pruned run dir(s) older than ${KEEP_DAYS}d"

  if [ ! -d "$CLONE/.git" ]; then
    CLEANUP="$(jq -nc --arg c "$CLONE" --argjson rp "$runs_pruned" '{skipped:true, reason:("clone not found at " + $c), runs_pruned:$rp}')"
  else
    removed_wt=(); removed_br=(); kept_dirty=(); orphans=(); main_note=""
    git -C "$CLONE" fetch --prune --quiet origin || true
    [ "$DRY_RUN" = 1 ] || git -C "$CLONE" worktree prune
    # Worktrees other than the main clone: remove when clean AND (upstream gone OR merged into origin/main).
    while read -r wt; do
      if [ -z "$wt" ] || [ "$wt" = "$CLONE" ]; then continue; fi
      br="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
      [ "$br" = "HEAD" ] && continue
      if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then kept_dirty+=("$wt ($br)"); continue; fi
      track="$(git -C "$CLONE" for-each-ref --format='%(upstream:track)' "refs/heads/$br")"
      merged=0; git -C "$CLONE" merge-base --is-ancestor "$br" origin/main 2>/dev/null && merged=1
      if [ "$track" = "[gone]" ] || [ "$merged" = 1 ]; then
        if [ "$DRY_RUN" = 1 ]; then log "dry-run: would remove worktree $wt ($br)"; else
          git -C "$CLONE" worktree remove "$wt" && git -C "$CLONE" branch -D "$br" >/dev/null 2>&1 || true
        fi
        removed_wt+=("$wt ($br)")
      fi
    done < <(git -C "$CLONE" worktree list --porcelain | awk '/^worktree /{print $2}')
    # Local branches whose upstream is gone (squash-merged PR branches), not checked out anywhere.
    while read -r br track; do
      [ "$track" = "[gone]" ] || continue
      [ "$br" = "main" ] && continue
      git -C "$CLONE" worktree list --porcelain | grep -q "^branch refs/heads/$br$" && continue
      if [ "$DRY_RUN" = 1 ]; then log "dry-run: would delete branch $br"; else git -C "$CLONE" branch -D "$br" >/dev/null 2>&1 || continue; fi
      removed_br+=("$br")
    done < <(git -C "$CLONE" for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads)
    # Leftover directories under .claude/worktrees that are no longer registered worktrees.
    if [ -d "$CLONE/.claude/worktrees" ]; then
      for d in "$CLONE"/.claude/worktrees/*/; do
        [ -d "$d" ] || continue; d="${d%/}"
        git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 && continue
        if [ -z "$(ls -A "$d")" ]; then [ "$DRY_RUN" = 1 ] || rmdir "$d"; orphans+=("$d (empty, removed)"); else orphans+=("$d (non-empty, left for a human)"); fi
      done
    fi
    # Fast-forward main if the main clone is on main and clean.
    if [ "$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)" = "main" ]; then
      if [ -z "$(git -C "$CLONE" status --porcelain)" ]; then
        [ "$DRY_RUN" = 1 ] || git -C "$CLONE" pull --ff-only --quiet origin main || main_note="ff-pull failed"
        [ -z "$main_note" ] && main_note="main fast-forwarded to $(git -C "$CLONE" rev-parse --short origin/main)"
      else main_note="main clone dirty; not pulled"; fi
    else main_note="clone on $(git -C "$CLONE" rev-parse --abbrev-ref HEAD), not main; not pulled"; fi
    CLEANUP="$(jq -nc --arg main "$main_note" --argjson rp "$runs_pruned" \
      --argjson wt "$(printf '%s\n' "${removed_wt[@]:-}" | jq -R . | jq -sc 'map(select(length>0))')" \
      --argjson br "$(printf '%s\n' "${removed_br[@]:-}" | jq -R . | jq -sc 'map(select(length>0))')" \
      --argjson dirty "$(printf '%s\n' "${kept_dirty[@]:-}" | jq -R . | jq -sc 'map(select(length>0))')" \
      --argjson orphans "$(printf '%s\n' "${orphans[@]:-}" | jq -R . | jq -sc 'map(select(length>0))')" \
      '{skipped:false, worktrees_removed:$wt, branches_deleted:$br, kept_dirty:$dirty, orphan_dirs:$orphans, main:$main, runs_pruned:$rp}')"
    log "cleanup: $(printf '%s' "$CLEANUP" | jq -c .)"
  fi
fi

# ------------------------------------------------------------------ report ----
trap - TERM INT HUP   # past the point where early finalization adds anything
finalize settled

if [ "$(jq '(.held|length) + (.timed_out|length)' "$RUN_DIR/summary.json")" -gt 0 ]; then exit 2; fi
exit 0
