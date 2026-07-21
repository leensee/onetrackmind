#!/usr/bin/env python3
"""WER scorer for the bench corpus. Python 3 stdlib only.

Usage:
    score_wer.py --references references.json \
                 --corpus <corpus-session-dir> \
                 --hypotheses <work-dir>/hyp \
                 --out <results-dir>

Reads entry sidecars (<corpus>/<arm>/<id>.json) to map each hypothesis to its
utterance card, normalizes both sides, and computes word-level Levenshtein
S/D/I. WER = (S+D+I)/N.

Fabrication defense (Whisper's documented failure mode on non-speech audio is
fluent fabrication, not garbling): a hypothesis is flagged when hyp/ref token
ratio > 1.5 or per-utterance WER > 1.0. Aggregates are reported both with and
without flagged items — flagged rows are never silently dropped.

Normalization is fixed and identical across arms, so absolute WER carries its
known quirks (fraction words, run-together numerals) equally into every arm;
the comparative ranking the spike needs is unaffected.
"""

import argparse
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

FLAG_LENGTH_RATIO = 1.5
FLAG_WER = 1.0

UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
}
TEENS = {
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
TENS = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}


def merge_number_words(tokens):
    """seventy three -> 73; five hundred -> 500; forty one -> 41.
    Number words that don't combine become their digit form alone."""
    out = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in UNITS and i + 1 < len(tokens) and tokens[i + 1] == "hundred":
            value = UNITS[tok] * 100
            i += 2
            if i < len(tokens) and tokens[i] in TEENS:
                value += TEENS[tokens[i]]
                i += 1
            elif i < len(tokens) and tokens[i] in TENS:
                value += TENS[tokens[i]]
                i += 1
                if i < len(tokens) and tokens[i] in UNITS:
                    value += UNITS[tokens[i]]
                    i += 1
            elif i < len(tokens) and tokens[i] in UNITS:
                value += UNITS[tokens[i]]
                i += 1
            out.append(str(value))
        elif tok in TENS:
            value = TENS[tok]
            i += 1
            if i < len(tokens) and tokens[i] in UNITS:
                value += UNITS[tokens[i]]
                i += 1
            out.append(str(value))
        elif tok in TEENS:
            out.append(str(TEENS[tok]))
            i += 1
        elif tok in UNITS:
            out.append(str(UNITS[tok]))
            i += 1
        else:
            out.append(tok)
            i += 1
    return out


def normalize(text):
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"[/\-]", " ", text)
    # Keep intra-word apostrophes; drop everything else non-alphanumeric.
    text = re.sub(r"[^\w\s']", " ", text)
    text = re.sub(r"(?<!\w)'|'(?!\w)", " ", text)
    tokens = text.split()
    return merge_number_words(tokens)


def levenshtein_sdi(ref, hyp):
    """Word-level alignment; returns (S, D, I)."""
    rows, cols = len(ref) + 1, len(hyp) + 1
    cost = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        cost[i][0] = i
    for j in range(cols):
        cost[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            if ref[i - 1] == hyp[j - 1]:
                cost[i][j] = cost[i - 1][j - 1]
            else:
                cost[i][j] = 1 + min(
                    cost[i - 1][j - 1],  # substitution
                    cost[i - 1][j],      # deletion
                    cost[i][j - 1],      # insertion
                )
    s = d = ins = 0
    i, j = len(ref), len(hyp)
    while i > 0 or j > 0:
        if i > 0 and j > 0 and ref[i - 1] == hyp[j - 1] and cost[i][j] == cost[i - 1][j - 1]:
            i, j = i - 1, j - 1
        elif i > 0 and j > 0 and cost[i][j] == cost[i - 1][j - 1] + 1:
            s += 1
            i, j = i - 1, j - 1
        elif i > 0 and cost[i][j] == cost[i - 1][j] + 1:
            d += 1
            i -= 1
        else:
            ins += 1
            j -= 1
    return s, d, ins


def score_session(references, corpus_dir, hyp_dir):
    rows = []
    skipped = []
    for hyp_path in sorted(hyp_dir.glob("*/*.txt")):
        arm = hyp_path.parent.name
        entry_id = hyp_path.stem
        sidecar = corpus_dir / arm / f"{entry_id}.json"
        if not sidecar.exists():
            skipped.append((arm, entry_id, "no corpus sidecar"))
            continue
        entry = json.loads(sidecar.read_text())["entry"]
        utterance_id = entry.get("utterance_id")
        if not utterance_id or utterance_id not in references:
            skipped.append((arm, entry_id, f"no reference (utterance_id={utterance_id})"))
            continue
        ref = normalize(references[utterance_id])
        hyp = normalize(hyp_path.read_text())
        s, d, ins = levenshtein_sdi(ref, hyp)
        n = len(ref)
        wer = (s + d + ins) / n if n else 0.0
        ratio = (len(hyp) / n) if n else 0.0
        flags = []
        if ratio > FLAG_LENGTH_RATIO:
            flags.append(f"length-ratio {ratio:.2f} > {FLAG_LENGTH_RATIO}")
        if wer > FLAG_WER:
            flags.append(f"wer {wer:.2f} > {FLAG_WER}")
        rows.append({
            "arm": arm,
            "entry_id": entry_id,
            "utterance_id": utterance_id,
            "ref_tokens": n,
            "hyp_tokens": len(hyp),
            "S": s, "D": d, "I": ins,
            "wer": round(wer, 4),
            "flagged": bool(flags),
            "flag_reason": "; ".join(flags),
        })
    return rows, skipped


def aggregate(rows, include_flagged):
    by_arm = {}
    for row in rows:
        if not include_flagged and row["flagged"]:
            continue
        agg = by_arm.setdefault(row["arm"], {"S": 0, "D": 0, "I": 0, "N": 0, "count": 0, "flagged": 0})
        agg["S"] += row["S"]
        agg["D"] += row["D"]
        agg["I"] += row["I"]
        agg["N"] += row["ref_tokens"]
        agg["count"] += 1
    for row in rows:
        if row["flagged"] and row["arm"] in by_arm:
            by_arm[row["arm"]]["flagged"] += 1 if include_flagged else 0
    return by_arm


def write_outputs(rows, skipped, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "wer.csv"
    with csv_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "arm", "entry_id", "utterance_id", "ref_tokens", "hyp_tokens",
            "S", "D", "I", "wer", "flagged", "flag_reason",
        ])
        writer.writeheader()
        writer.writerows(rows)

    lines = ["# WER results", ""]
    for label, include in (("All captures", True), ("Excluding flagged (suspect fabrication)", False)):
        lines += [f"## {label}", "", "| Arm | WER % | S | D | I | N | Utterances | Flagged |", "|---|---|---|---|---|---|---|---|"]
        flagged_counts = {}
        for row in rows:
            if row["flagged"]:
                flagged_counts[row["arm"]] = flagged_counts.get(row["arm"], 0) + 1
        for arm, agg in sorted(aggregate(rows, include).items()):
            wer_pct = 100.0 * (agg["S"] + agg["D"] + agg["I"]) / agg["N"] if agg["N"] else 0.0
            lines.append(
                f"| {arm} | {wer_pct:.1f} | {agg['S']} | {agg['D']} | {agg['I']} "
                f"| {agg['N']} | {agg['count']} | {flagged_counts.get(arm, 0)} |")
        lines.append("")
    if skipped:
        lines += ["## Skipped", ""]
        lines += [f"- {arm}/{entry_id}: {reason}" for arm, entry_id, reason in skipped]
        lines.append("")
    (out_dir / "wer.md").write_text("\n".join(lines))
    return csv_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--references", required=True, type=Path)
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--hypotheses", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    references = json.loads(args.references.read_text())["references"]
    rows, skipped = score_session(references, args.corpus, args.hypotheses)
    if not rows:
        print("no scorable hypotheses found", file=sys.stderr)
        return 1
    csv_path = write_outputs(rows, skipped, args.out)
    flagged = sum(1 for r in rows if r["flagged"])
    print(f"scored {len(rows)} captures ({flagged} flagged, {len(skipped)} skipped) → {csv_path.parent}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
