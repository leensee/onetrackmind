# iOS Capture-Path Bench Spike — Protocol

Standalone bench harness. Answers four questions (first three blocking, in priority order):

- **Q1** — Can a Flutter app reach Apple's voice-processing pipeline and obtain Voice Isolation on the recording path?
- **Q2** — Does Voice Isolation apply to third-party Bluetooth (HFP) microphone input, or only the built-in mic?
- **Q3** — Does a Siri shortcut resume after Face ID unlock (gloved, no-screen-contact entry)?
- **Q4** — Comparative word-error-rate across capture configurations (floor device only).

Q1 is blocking for everything downstream: if no voice-processing profile ever surfaces microphone modes for the app, report immediately and stop.

Results land in [findings.md](findings.md) as each question is answered. Utterance cards: [utterances.md](utterances.md).

---

## Policy exception record — bench/spike artifact class

**Ruled 2026-07-21 during the planning session for this spike.** Four deviations from Security & Compliance Policy v1.2 approved as a scoped exception under a new bench/spike artifact class (to be codified as §10 in the v1.3 bump). These exceptions set **no product precedent**.

1. **Voice-audio retention (§3.4 / §4.4).** The WER corpus retains audio — WER is unmeasurable without it; no compliant version of this spike exists. Conditions:
   - The corpus directory must be verified to sit **outside any cloud-sync tree** before anything is recorded (verify, don't assume — the local tree was reorganized recently). The receiver refuses to start if the corpus path resolves inside a known sync root.
   - The corpus volume must be **encrypted** (FileVault or equivalent). The receiver checks `fdesetup status` at startup.
   - Deletion is tied to a **named end condition**: the corpus is deleted when the four spike questions are answered and recorded in findings.md — not "at spike end". The deletion itself is recorded (below).
   - The field user is told, in the recording instructions, that **audio is retained for analysis and deleted afterward**, and that **other workers' voices will likely be captured incidentally** beside running equipment.
   - Device-side behavior is unchanged by this exception: audio deletes from the phone immediately on confirmed receipt.
2. **SQLCipher (§3.3).** The spike queue is JSON sidecars + files, not encrypted SQLite. Conditions: iOS file protection is set to the **complete** class explicitly (the platform default leaves files readable after first unlock); the harness records in code that the **production capture queue uses SQLCipher per §3.3, unchanged** — this file queue is not a precedent.
3. **Receiver auth (§2.1).** The bench receiver authenticates by shared secret, not Supabase JWT. It is arguably not a backend API endpoint at all — it never mounts on the production backend — but "never mounted" is enforced **structurally**, not by intention: separate package with no import path from the backend app; binds one specific LAN interface, never all-interfaces; refuses to start without a secret configured (no default, no fallback); never logs request bodies (§5.4 applies unchanged).
4. **Fastify dependency** in the isolated `tools/bench-receiver/` package. Approved — already the backend's framework, so not new to the project.

### Corpus deletion record

| Date | Corpus path | Deleted by | Q1–Q4 recorded in findings.md? |
|---|---|---|---|
| _(pending)_ | | | |

---

## Devices and signing

| Device | Role | Signing |
|---|---|---|
| iPhone Pro (dev) | All bench-phase work (Q1–Q3), stability soak | Free personal team (7-day profiles acceptable; re-signed in person) |
| iPhone Pro (field) + older iPhone (floor) | Field session (Q4) only | **Paid Apple Developer Program, ad-hoc distribution** (1-year profiles). Free profiles are prohibited on field phones: the field rotation is 7–10 days on, and a 7-day profile would expire mid-hitch with no cable and no developer present. |

The **older iPhone is the floor, not a proxy** — capability results transfer newer→older; performance and audio-quality results do not. All WER arms run on the floor device.

**Hard gate:** no field install before the dev-device stability soak passes (30+ captures across a day, incoming call mid-capture, route flap, backgrounding, Siri triggers; zero crashes, zero lost queue entries).

**Fallback (live option, not last resort):** if paid enrollment slips past the hitch, produce the Q4 corpus with the built-in Voice Memos app (Voice Isolation available on iOS 26+; input selectable in Control Center). Approximates rather than replicates the app's own session; cannot answer Q1/Q3 (already answered by then). Missing the hitch costs 12–17 days, so exercise this rather than wait.

---

## Capture arms

All arm labels are **ground-truthed by the logged `activeMicrophoneMode` and route in each capture's metadata — never by intent**. If the log disagrees with the label, the log wins and the capture is re-labeled or discarded.

| Arm label | Input | Mic mode | Session profile |
|---|---|---|---|
| `builtin-raw` | Built-in mic | n/a (control) | `raw` (.measurement) |
| `builtin+vi` | Built-in mic | Voice Isolation | VP profile from Q1 |
| `builtin-std` | Built-in mic | Standard | VP profile from Q1 |
| `ac-bt+vi` / `ac-bt-std` | Air-conduction BT headset | VI / Standard | VP profile from Q1 |
| `bc-bt+vi` / `bc-bt-std` | Bone-conduction BT headset | VI / Standard | VP profile from Q1 |
| `builtin-earsplugged` | Built-in mic, speaker's ears plugged | Voice Isolation | VP profile from Q1 |
| `builtin-mounted-fixed` | Built-in mic, fixed-distance mount | Voice Isolation | Activated only if Q2 shows VI unavailable over BT |

---

## Bench-phase checklists (dev device)

### Q1 — Voice Isolation reachability
1. Build & run; grant mic permission.
2. For each profile `vp-mode`, `vp-engine`: configure → tap **Mic mode UI** → does the system sheet list **Voice Isolation** for this app? Record per profile.
3. Select Voice Isolation; start capture; confirm live snapshot shows `activeMicrophoneMode: voiceIsolation` **during** capture; stop.
4. Repeat with Standard; capture one `raw` control.
5. A/B listen: VI vs Standard vs raw audibly differ (VI suppresses a background noise source, e.g. running water or a fan).
6. Record in findings.md: which profile(s) confer eligibility; `activeMicrophoneMode` evidence; any format forced by the VP path (mono / sample rate).

**If neither profile surfaces mic modes: STOP. Report. Everything downstream is moot.**

### Q2 — Voice Isolation over Bluetooth (protocol-level, clip headset proxy)
1. Pair + connect the clip headset; confirm route shows `bluetoothHFP` (or `bluetoothLE`) input in snapshot.
2. Note negotiated `sampleRate` with BT input active: 8 kHz ⇒ CVSD, 16 kHz ⇒ mSBC, 24/32 kHz ⇒ LE Audio/HQ. This answers the codec-cap question.
3. With the Q1-winning profile: does the mic-mode sheet still offer Voice Isolation? Set it; capture; does `activeMicrophoneMode` hold `voiceIsolation` or fall back to `standard`?
4. If the `bt-hq` profile is available (iOS 26 high-quality BT recording), repeat with it.
5. Record: VI-over-BT verdict (protocol-level — transfers to the user's air-conduction headsets; mic *quality* does not). If VI-over-BT is dead, activate `builtin-mounted-fixed` for the field session.

### Q3 — Siri shortcut through Face ID
Setup: app installed, shortcut phrase "Start \<app name\> capture" available (automatic via App Shortcuts).

For each of {warm start (app backgrounded), cold start (app force-quit)}:
1. Lock the phone. Put on gloves.
2. Headset button (or "Hey Siri") → speak the shortcut phrase.
3. Face ID prompt appears — look at the phone. **Do not touch the screen.**
4. Observe and record:
   - [ ] Did the shortcut continue automatically after Face ID, with no swipe/touch?
   - [ ] Did the app foreground and capture start (audible/visible confirmation)?
   - [ ] Timestamps in metadata: `t_intentPerform` → `t_appActive` → `t_sessionActive` → `t_firstBuffer` (total budget noted)
   - [ ] `isProtectedDataAvailable` at perform time (distinguishes pre/post-unlock execution)
5. **A required screen touch anywhere in the flow is a Q3 failure for the gloved entry path, even if capture eventually starts.**

Smoke-check while here: set VI, force-quit, relaunch — does `preferredMicrophoneMode` persist for the app?

---

## Field session runbook (floor device, single batched session)

**Recording instructions given to the field user must include:** audio from this session is retained on the bench Mac for transcription-accuracy analysis and deleted once the four spike questions are answered and recorded; other workers' voices will likely be captured incidentally beside running equipment.

Preflight (before travel): receiver running, `GET /health` green from the phone's **Ping receiver** button; session id set (`fieldYYYYMMDD`); headsets charged; utterance cards printed; floor device provisioned (ad-hoc) and soak-passed build installed.

Per arm (order: `builtin-raw` first as control, then built-in arms, then headset arms, `builtin-earsplugged` last):
1. Select arm + profile in the bench UI; verify snapshot route/mic-mode matches the arm definition.
2. Speak utterances U01–U20 (one capture each), machinery running, natural working distance. Time-boxed: if the session runs long, cut to U01–U12 for remaining arms — never cut arms.
3. Spot-check queue drains (entries flip to synced; audio leaves the device).

Interleaved same-session verifications:
- [ ] Mic-mode per-app persistence on the floor device (set VI → force-quit → relaunch → read `preferredMicrophoneMode`)
- [ ] Negotiated HFP `sampleRate` per headset (from route snapshot, each headset)
- [ ] Glove operability: each headset's controls (physical button vs capacitive tap) operated with work gloves — record pass/fail per control

Post-session (Mac): `tools/wer/transcribe.sh` over the corpus → `tools/wer/score_wer.py` → commit `docs/bench/results/<session>/wer.csv` + `wer.md` (never audio) → update findings.md Q4.

---

## Receiver operations

```bash
cd tools/bench-receiver
OTM_BENCH_SECRET=<generated-per-session> \
OTM_BENCH_BIND_ADDR=<Mac LAN IP>        \
OTM_BENCH_CORPUS_DIR=~/otm-bench/corpus \
npm start
```

Startup preflight refuses to run if: secret unset/empty; bind address unset (all-interfaces binding is not supported); corpus dir inside a known cloud-sync root (iCloud Drive `~/Library/Mobile Documents`, Dropbox, OneDrive, Google Drive); volume not FileVault-encrypted (`fdesetup status`) unless `OTM_BENCH_ALLOW_UNVERIFIED_ENCRYPTION=1` is set for a non-FileVault encrypted volume — setting it asserts the volume is otherwise encrypted.

The phone's bench UI stores receiver URL + secret locally (Settings pane); the secret is generated fresh per bench session and never committed.
