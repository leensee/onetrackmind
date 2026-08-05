# cleanroom20260805 — results notes

**What this is:** the WER pipeline proof and bench baseline — **not Q4**. Q4
(comparative WER across capture arms) stays OPEN and runs on the floor device;
these numbers come from the dev iPhone in a quiet room and establish that the
capture → receiver → transcribe → score chain works end to end.

**Provenance.** Session `cleanroom20260805`, dev iPhone (iOS 26.5.2), app build
1.0.0 (2), recorded through the guided walkthrough (its first real use — arm
sequencing, mode settling, and pre-capture validation all exercised). 62
captures: 60 scored cards (U01–U20 × `builtin-raw`, `builtin+vi`,
`builtin-std`) + 2 mode-settling captures, which carry no utterance id and are
skipped by the scorer by design. Same-day stability soak passed on this build
(see protocol.md § Devices and signing → Soak record).

**Toolchain.** whisper.cpp **v1.9.1** (commit
`f049fff95a089aa9969deb009cdd4892b3e74916`), model `ggml-large-v3.bin` (sha256
`64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2`), Metal on
Apple M4. The run manifest (bench-machine work dir, not committed) records the
same commit and hash.

**Format asymmetry to remember at analysis time.** The voice-processing path
negotiates mono 48 kHz on the built-in mic, so all three arms here were
downsampled to 16 kHz by `transcribe.sh` (afconvert). Bluetooth arms are
natively 16 kHz (mSBC cap, per Q2) — so built-in arms carry a downsample step
the BT arms won't. Probably immaterial; recorded so it isn't discovered
mid-analysis.

**Transferability caveat.** Absolute WER is transcriber-specific: production
transcription is the Whisper API, this baseline is local whisper.cpp large-v3.
Comparative arm-to-arm results transfer; the absolute numbers are not an API
prediction.
