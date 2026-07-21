# iOS Capture-Path Bench Spike — Findings

Updated as each question lands, not only at spike end. Evidence = capture metadata (logged `activeMicrophoneMode`, route, sample rate), never intent. Protocol and checklists: [protocol.md](protocol.md).

## Q1 — Voice Isolation reachable from a Flutter app on the recording path?

**Status: ANSWERED — YES (2026-07-21, dev iPhone, iOS 26.5.2).** Both VP profiles surface microphone modes; Voice Isolation held on the recording path with logged evidence. Nothing downstream is blocked.

| Item | Result |
|---|---|
| `vp-mode` profile (.voiceChat) confers mic-mode eligibility | **YES** — system sheet listed Automatic / Standard / Voice Isolation during active capture (observed; sheet contents are UI-only). Logged: capture `b63e3e01`, `micModeChanged standard→voiceIsolation` **during** capture, `atStop active: voiceIsolation`, session `PlayAndRecord`/`VoiceChat` |
| `vp-engine` profile (setVoiceProcessingEnabled) confers eligibility | **YES** — same sheet options. Logged: capture `929fe272`, `active: voiceIsolation` atStart→atStop, `isVoiceProcessingEnabled: true`. Note: profile configures mode `.default`, but enabling engine VP flips the live session to `VoiceChat` (logged atStop mode) |
| `activeMicrophoneMode == voiceIsolation` observed during capture | **YES** — three captures (`b63e3e01`, `929fe272`, `16c513d2`), polled at 1 Hz during capture |
| Format forced by VP path (channels / sample rate) | **Mono, 48 kHz** (tap and file, 16-bit WAV) under both VP profiles; the `raw`/`.measurement` control also negotiated mono/48 kHz on the built-in mic |
| A/B listen VI vs Standard vs raw | **VI near-zero background noise (running water), speech clear and unaffected** vs Standard and raw (operator judgment). Caveat: in the VI take (`16c513d2`) VI was selected at +2.0 s of 23.6 s; sentence spoken after the switch |

Sheet detail (iOS 26): options shown are Automatic / Standard / Voice Isolation — Wide Spectrum was not offered to this app. Mic-mode sheet is empty unless the app has a live mic session (blank blur when idle); eligibility checks must run during capture.

The per-app `preferredMicrophoneMode` persisted across profile switches and captures without re-selection (early positive signal for the Q3 persistence smoke).

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
