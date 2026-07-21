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

**Status: ANSWERED — YES (2026-07-21, dev iPhone, iOS 26.5.2; Shokz OpenDots ONE clip headset as air-conduction proxy).** VI holds on the BT recording path at protocol level; `builtin-mounted-fixed` does **not** activate. Result transfers to the user's headsets at protocol level only — mic quality does not transfer.

| Item | Result |
|---|---|
| BT input portType observed (`bluetoothHFP` / `bluetoothLE`) | **`BluetoothHFP`** ("OpenDots ONE by Shokz") |
| Negotiated input sample rate on BT (codec inference) | **16 000 Hz ⇒ mSBC** (wideband HFP; not CVSD, not LE Audio). Captured file: mono 16 kHz 16-bit WAV — the codec cap flows through to the corpus format |
| Mic-mode sheet offers VI with BT input active | **YES** — Automatic / Standard / Voice Isolation, observed during capture (same options as built-in mic) |
| `activeMicrophoneMode` holds VI on BT, or falls back to standard | **HOLDS** — capture `5cc55eb4`: `atStop active: voiceIsolation` with `BluetoothHFP` input, 16 kHz throughout; no fallback event |
| `bt-hq` (iOS 26 high-quality BT recording) available / behavior | **API present, engagement headset-dependent.** Profile configures cleanly; capture `e1c8f39e` logs `bluetoothHighQualityRecording` in active session options — but route stayed `BluetoothHFP` @ 16 kHz (this headset lacks HQ support). VI unaffected under the option |
| **Consequence:** `builtin-mounted-fixed` arm activated? | **NO** — VI-over-BT is alive; the headset arms stand as planned |

Operational note: after pairing, the inactive session's route showed **no inputs** ­— the BT input only claimed the route on session reactivation (bench workaround: re-select the profile to force deactivate→configure→activate). The field runbook's per-arm step "verify snapshot route matches the arm" already covers this.

## Q3 — Siri shortcut resumes after Face ID unlock?

**Status: ANSWERED — PASS, both cases (2026-07-21, dev iPhone, iOS 26.5.2).** Gloved, zero-screen-contact entry works warm and cold. Captures `7e0ab901` (warm) / `81fa9427` (cold), both `trigger_source: siri-shortcut`, VI active over the connected BT headset.

| Item | Warm start | Cold start |
|---|---|---|
| Continued hands-free after Face ID (no touch) | **YES** | **YES** ("no delay at all" — operator) |
| Capture started (t_intentPerform → t_firstBuffer, ms) | **638 ms** (sessionActive +190, engineStart +382) | **506 ms** (sessionActive +56, engineStart +251) |
| `isProtectedDataAvailable` at perform | **true** | **true** |
| Mic-mode per-app persistence across relaunch (smoke) | **PASS** — both captures started with `preferred: voiceIsolation` already set; survived backgrounding, force-quit, relaunch, and a reinstall (same bundle id) | — |

Notes:
- The intent performs **post-unlock** (`protectedData: true`, `applicationStateAtPerform: 1`) — Face ID completes before `perform()` runs, so `.complete` file protection is compatible with the Siri entry path.
- `t_appActive` (+550 warm / +814 cold) lands **after** first buffer in both runs — the Swift-side start sequence really does run ahead of app/Flutter activation, as designed; Flutter cold-start cost stays out of the capture path.
- First-ever Siri invocation raised a one-time "Turn on capture with OneTrackMind?" authorization — **answerable by voice** (no touch); it does not recur.
- **Harness fix required for Q3 (committed this session):** with `CFBundleDisplayName` = "App", Siri could not bind the phrase ("no app named capture"). Renamed to **OneTrackMind**; phrase "Start OneTrackMind capture" recognized reliably. Any future rename must re-verify the App Shortcut phrase.

## Q4 — Comparative WER across capture arms (floor device)

**Status: OPEN** — field session pending paid-enrollment gate. Results: `docs/bench/results/<session>/wer.md`.

| Arm | WER % | Flagged captures | Notes |
|---|---|---|---|
| _pending field session_ | | | |

Same-session verifications (floor device): mic-mode persistence — _pending_; per-headset HFP sample rate — _pending_; glove operability (physical vs capacitive controls per headset) — _pending_.

## Corpus deletion

Per the §10 bench-exception ruling: corpus deleted when Q1–Q4 above are answered and recorded; deletion logged in [protocol.md](protocol.md) § Corpus deletion record. **Status: corpus not yet created.**
