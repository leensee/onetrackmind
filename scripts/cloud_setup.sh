#!/bin/bash
# SessionStart hook — cloud sessions only (Claude Code on the web /
# ultrareview sandboxes). Installs backend/ deps so agents can run
# `npm test` / `tsc`. Local machines exit immediately: they manage
# node_modules themselves (fresh worktrees: run `npm ci` in backend/).

set -u

# Only run in Anthropic cloud sandboxes.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Repo root = parent of this script's directory (CLAUDE_PROJECT_DIR
# is set for hook commands, but resolving from $0 also covers manual runs).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Skip when the environment cache already carries dependencies.
if [ -d "$ROOT/backend/node_modules" ]; then
  exit 0
fi

cd "$ROOT/backend" && npm ci --no-audit --no-fund
exit 0
