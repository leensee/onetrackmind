#!/usr/bin/env bash
# Transcribes a bench corpus session with whisper.cpp for WER scoring.
# Mac-side bench tool — whisper.cpp is a bench-machine dependency, not a
# repo dependency. Its commit and model hash go into the run manifest for
# reproducibility.
#
# Usage:
#   WHISPER_MODEL=~/models/ggml-large-v3.bin ./transcribe.sh <corpus-session-dir> <work-dir>
# Env:
#   WHISPER_MODEL  path to ggml-large-v3.bin (required)
#   WHISPER_CLI    whisper.cpp CLI binary (default: whisper-cli on PATH)
#   WHISPER_COMMIT whisper.cpp commit recorded in the manifest
#                  (default: git-derived from the CLI's checkout, else "unknown")
#
# Layout in:  <corpus-session-dir>/<arm_label>/<entry_id>.wav
# Layout out: <work-dir>/hyp/<arm_label>/<entry_id>.txt + manifest.json
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <corpus-session-dir> <work-dir>" >&2
  exit 2
fi

CORPUS_DIR=$1
WORK_DIR=$2
WHISPER_CLI=${WHISPER_CLI:-whisper-cli}
: "${WHISPER_MODEL:?WHISPER_MODEL must point at the ggml model file}"

command -v "$WHISPER_CLI" >/dev/null || { echo "whisper CLI not found: $WHISPER_CLI" >&2; exit 1; }
command -v afconvert >/dev/null || { echo "afconvert not found (macOS required)" >&2; exit 1; }
[[ -f "$WHISPER_MODEL" ]] || { echo "model not found: $WHISPER_MODEL" >&2; exit 1; }

# A non-git install (e.g. brew) has no derivable commit — set WHISPER_COMMIT explicitly there.
# Symlinks are followed by hand: plain readlink (no -f) exists on every macOS,
# and a failed resolution must yield "unknown", never a git lookup in the cwd.
resolve_cli() {
  p=$(command -v "$WHISPER_CLI")
  while [ -L "$p" ]; do
    t=$(readlink "$p") || break
    case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac
  done
  printf '%s' "$p"
}
WHISPER_COMMIT=${WHISPER_COMMIT:-$(CLI=$(resolve_cli); [ -n "$CLI" ] && git -C "$(dirname "$CLI")" rev-parse HEAD 2>/dev/null || echo unknown)}

mkdir -p "$WORK_DIR/hyp" "$WORK_DIR/wav16k"

MODEL_SHA=$(shasum -a 256 "$WHISPER_MODEL" | cut -d' ' -f1)
cat > "$WORK_DIR/manifest.json" <<EOF
{
  "transcribed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "whisper_cli": "$($WHISPER_CLI --help 2>&1 | head -1 | tr -d '"' || true)",
  "whisper_commit": "$WHISPER_COMMIT",
  "model": "$(basename "$WHISPER_MODEL")",
  "model_sha256": "$MODEL_SHA",
  "corpus_dir": "$CORPUS_DIR"
}
EOF

find "$CORPUS_DIR" -name '*.wav' | while read -r wav; do
  arm=$(basename "$(dirname "$wav")")
  id=$(basename "$wav" .wav)
  mkdir -p "$WORK_DIR/hyp/$arm" "$WORK_DIR/wav16k/$arm"
  wav16k="$WORK_DIR/wav16k/$arm/$id.wav"
  # whisper.cpp wants 16 kHz mono; afconvert is built into macOS.
  afconvert -f WAVE -d LEI16@16000 -c 1 "$wav" "$wav16k"
  "$WHISPER_CLI" -m "$WHISPER_MODEL" -nt -l en -otxt \
    -of "$WORK_DIR/hyp/$arm/$id" -f "$wav16k" >/dev/null
  echo "transcribed $arm/$id"
done

echo "done — hypotheses in $WORK_DIR/hyp, manifest in $WORK_DIR/manifest.json"
