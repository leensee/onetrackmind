# iOS Capture-Path Bench Spike — Findings

Updated as each question lands, not only at spike end. Evidence = capture metadata (logged `activeMicrophoneMode`, route, sample rate), never intent. Protocol and checklists: [protocol.md](protocol.md).

## Q1 — Voice Isolation reachable from a Flutter app on the recording path?

**Status: OPEN** — blocking. If no VP profile surfaces mic modes: stop and report.

| Item | Result |
|---|---|
| `vp-mode` profile (.voiceChat) confers mic-mode eligibility | _pending_ |
| `vp-engine` profile (setVoiceProcessingEnabled) confers eligibility | _pending_ |
| `activeMicrophoneMode == voiceIsolation` observed during capture | _pending_ |
| Format forced by VP path (channels / sample rate) | _pending_ |
| A/B listen VI vs Standard vs raw | _pending_ |

## Q2 — Voice Isolation on third-party Bluetooth input?

**Status: OPEN** — blocking. Protocol-level result via clip headset (air-conduction class; transfers to the user's headsets at protocol level, not mic quality).

| Item | Result |
|---|---|
| BT input portType observed (`bluetoothHFP` / `bluetoothLE`) | _pending_ |
| Negotiated input sample rate on BT (codec inference) | _pending_ |
| Mic-mode sheet offers VI with BT input active | _pending_ |
| `activeMicrophoneMode` holds VI on BT, or falls back to standard | _pending_ |
| `bt-hq` (iOS 26 high-quality BT recording) available / behavior | _pending_ |
| **Consequence:** `builtin-mounted-fixed` arm activated? | _pending_ |

## Q3 — Siri shortcut resumes after Face ID unlock?

**Status: OPEN** — blocking. A required screen touch anywhere in the flow is a failure for the gloved entry path.

| Item | Warm start | Cold start |
|---|---|---|
| Continued hands-free after Face ID (no touch) | _pending_ | _pending_ |
| Capture started (t_intentPerform → t_firstBuffer, ms) | _pending_ | _pending_ |
| `isProtectedDataAvailable` at perform | _pending_ | _pending_ |
| Mic-mode per-app persistence across relaunch (smoke) | _pending_ | — |

## Q4 — Comparative WER across capture arms (floor device)

**Status: OPEN** — field session pending paid-enrollment gate. Results: `docs/bench/results/<session>/wer.md`.

| Arm | WER % | Flagged captures | Notes |
|---|---|---|---|
| _pending field session_ | | | |

Same-session verifications (floor device): mic-mode persistence — _pending_; per-headset HFP sample rate — _pending_; glove operability (physical vs capacitive controls per headset) — _pending_.

## Corpus deletion

Per the §10 bench-exception ruling: corpus deleted when Q1–Q4 above are answered and recorded; deletion logged in [protocol.md](protocol.md) § Corpus deletion record. **Status: corpus not yet created.**
