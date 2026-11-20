# Benchmarks

Measured on the dev PC (RTX 5060 Ti 16 GB, Ollama 0.40.12) on 2026-10-29. Re-run them after changing the judge,
the prompt layout or Ollama's cache settings.

## Goal-check judge

After a reply, a judge decides whether to nudge her: **CONTINUE** (she promised or started work and stopped)
or **FABRICATED** (she stated live facts or claimed an action without the tool), versus **DONE** / **BLOCKED**
(leave her alone). A wrong nudge makes her repeat herself; a missed one lets her stop halfway or make things up.

```powershell
npx tsx scripts/bench/judge-bench.ts rules mai-brain so/tev1:4b-q4_K_M      # $env:GATE = "narrow" | "wide" | "all"
```

The test set is `scripts/bench/judge-cases.json`: 40 labeled Mai turns in Vietnamese and English. "Right in
Mai" counts what she actually does, including which replies reach the judge (`judgeGate` in
`src/core/judge.ts`).

| Judge | Kind | Replies checked | Right in Mai | Wrong nudges | Missed | Per check | VRAM |
|---|---|---|---|---|---|---|---|
| **`tev1:4b-q4_K_M`** (Together AI) | decision model | all | **98%** | **0** | 1 | **78 ms** | 3.9 GB |
| `nimble` (Bespoke Labs, 9B) | decision model | all | 98% | 0 | 1 | 141 ms | 9.7 GB |
| `mai-brain` (gemma4:12b) judging itself | chat | all | 100% | 0 | 0 | 860 ms | shared* |
| `mai-brain` judging itself | chat | wide | 98% | 0 | 1 | 860 ms | shared* |
| `d1:3b` (Liquid AI, multilingual) | decision model | all | 93% | 0 | 3 | 45 ms | 3.3 GB |
| no model, regex gate only | none | n/a | 90% | 0 | 4 | 0 | 0 |
| `kev:4b-q4_K_M` | decision model | all | 88% | 0 | 5 | 98 ms | 6.6 GB |
| `qwen3.5:2b` | chat | wide | 88% | 4 | 1 | 316 ms | 2.4 GB |
| `mai-helper` (qwen3.5:4b), the old judge | chat | narrow | 80–85% | 0 | 6–8 | 446 ms | 3.6 GB |
| `tev1:0.8b` | decision model | wide / all | 85% / 78% | 0 / 4 | 6 / 5 | 31 ms | 1.3 GB |
| `granite4:1b` | chat | wide | 80% | 0 | 8 | 381 ms | 3.6 GB |
| `d1-omni:600m` / `laya` | decision model | wide | 80% / 55% | 1 / 0 | 7 / 18 | 30 ms | 2.8 / 0.8 GB |
| needle (sidecar) | tool-call model | wide | 68% | 4 | 9 | 215 ms | CPU |

\* Judging with her own model costs no extra VRAM, but each check pushes her chat out of Ollama's single slot.
She then needs the prompt cache (below) to get it back.

**What Mai uses:**
- **16 GB+ cards:** `tev1:4b-q4_K_M`, checking every reply.
- **Smaller cards** (`judgeModel` empty), or if the decision model fails: her own model judges, and only replies
  the regex flags (claims, promises) or that used tools.
- The old `mai-helper` was worse than no judge at all: it called unfinished work "FABRICATED", which Mai
  ignores when tools were used.

Decision models are a newer Ollama capability ("Decision" filter on ollama.com/search). They generate no text:
`POST /v1/systemone` scores the options you give in one pass and returns probabilities. That's why they're fast
enough to check every reply. They need Ollama 0.40.4+. `strands-decider` needs Apple's MLX runtime and doesn't
run on Windows.

## Ollama prompt cache and prompt layout

`node scripts/bench/cache-bench.mjs mai-brain <inline|tail|append> [setting]` replays a 12-turn Mai-like chat
on a private Ollama server for each cache setting. Every 3rd turn includes a side call on the same model (a
judge or vision call), which evicts the chat.

| Prompt layout | Cache setting | Normal turn | Turn right after a side call | Runner RAM |
|---|---|---|---|---|
| "Right now" inside the system prompt (old) | default (8 GB, 32 checkpoints) | 2.5 s | 2.5 s | 8.2 GB |
| "Right now" on the newest message (current) | default | 1.39 s | 1.50 s | 9.6 GB |
| current | **2 GB, 4 checkpoints** (setup's setting) | **1.38 s** | **1.51 s** | **2.9 GB** |
| current | 1 GB, 4 checkpoints | 1.92 s | 3.42 s | 1.5 GB |
| current | no cache, no checkpoints | 1.75 s | 3.26 s | 1.4 GB |

- **Why a cache at all, with one conversation:** Ollama keeps one chat per model "slot". Any other call on the
  same model replaces it (vision, or the fallback judge). The cache is what brings her chat back without
  re-reading the whole conversation.
- **Why 2 GB:** 1 GB is too small to hold her chat, so it doesn't come back. 2 GB is enough, and the default
  8 GB only costs RAM.
- **Why the layout matters:** the changing time and mood block used to sit in the system prompt, before the
  history, so every turn re-read everything. It's now attached to his newest message (`buildNowNote` /
  `withNowNote` in `src/core/prompt.ts`), and turns got about 2× faster.

## Live voice typing (🎙️)

Goal: words show up in the box while he talks, and the message sends itself when he stops. Measured on
2026-11-13 on the dev PC's CPU (Ryzen 5 8500G, 6 cores). The audio.cpp build is CPU-only, 6 threads, with
Qwen3-ASR-0.6B q8_0. The 32 GB profile installs the CUDA build, where every pass is faster; that wasn't measured.

```powershell
npx tsx scripts/bench/stt-live-bench.ts <clips folder> offline regrow:1000 mai    # needs Mai's voice server
npx tsx scripts/livestt-test.ts                                                   # VAD + auto-send logic, no server
npx electron scripts/live-mic-e2e.mjs <clip.wav> vi "expected text"              # the real pet window (npm run build first)
```

- **Clips:** 6 Vietnamese and 6 English sentences of real read speech, 4–11 s each, from the FLEURS dev set
  (CC BY 4.0). They aren't in the repo; any folder of `vi-*.wav` / `en-*.wav` + `.txt` works.
- **Playback:** each clip is played in real time, in 100 ms chunks, like the mic.
- **Error:** word error rate after lowercasing and dropping punctuation; for Vietnamese each word is a
  syllable. Spelled-out names and numbers count as errors (one clip with "Lakkha Singh … bhajan" causes most of
  them). With six clips per language, ±3 points is noise.

| Approach | VI error | EN error | First words | Updates | Sent after he stops | Cost |
|---|---|---|---|---|---|---|
| Old mic: record, click stop, one request | 9.8% | 13.3% | only after he stops | none | 1.9 s VI / 1.1 s EN, after his click | none |
| audio.cpp native streaming (`/v1/audio/transcriptions/live`, 2 s windows) | 17.8% | 22.3% | 2.5 s | every 1.8 s | 0.3 s | windows are cut blindly: words split, stray "Okay." / "Yeah." on short tails |
| Re-send the growing clip every 1 s, no VAD | 9.8% | 13.3% | 1.3 s | every 1.2–1.5 s | 2.3 s VI / 1.2 s EN | none |
| **Mai: Silero VAD + re-send + auto-send** | **6.9%** | **14.4%** | **1.2 s** after he starts | **~1 s** | **2.4 s VI / 1.6 s EN**, including the 0.9 s pause | 2.3 MB model, < 1 ms per 32 ms of audio on the CPU |
| sherpa-onnx zipformer-vi int8 (CPU) | 10.1% | 97% | | | 15× faster than Qwen3-ASR | 60 MB; Vietnamese only, all caps, no punctuation or digits |

**What Mai does:** the 🎙️ button streams 16 kHz audio to `src/core/livestt.ts`.
- **Finding speech:** Silero VAD tells speech from silence and noise. A noise burst has to last 250 ms to
  count as speech.
- **Live words:** while he talks, the whole utterance so far is sent to Qwen3-ASR about once a second, so the
  words keep firming up.
- **Sending:** when he pauses, the next pass starts at once. If the pause lasts 0.9 s, that pass is the final
  text and the message sends.
- **In the real pet window** (`live-mic-e2e.mjs`): a Vietnamese clip came out with 0% error and an English one
  with 9.5% (only "U.N." → "UN"). Words reached the box every 0.8–1 s.
- **Noise:** in `livestt-test.ts`, fan and rumble noise never reach the recognizer, and speech over a fan still
  sends.

**Why this one:**
- **Native streaming:** fast, but each 2 s window is decoded alone, so the error rate nearly doubles. That
  makes it fine for a preview but not for the text she reads. An accurate final would need a second copy of
  the model in offline mode (+1.1 GB RAM).
- **Re-sending the growing utterance:** keeps one-shot accuracy and uses the model and endpoint Mai already has.
  Each pass corrects the last one, which is exactly "partial text that firms up".
  - **Its cost:** CPU time that grows with the length of the sentence. A 10 s sentence takes ~1.5–2 s per pass,
    so updates slow down and sending takes longer on long sentences.
  - **Long speech:** Qwen3-ASR decodes up to 30 s at once, so after 28 s of talking the message is sent.
- **sherpa-onnx zipformer:** as accurate in Vietnamese and far faster, but useless for English and for mixed
  Vietnamese/English. It would need a second model, a native add-on and its own language switch.
- **Whisper / PhoWhisper** (with a VAD and sliding window): not measured.
  - **Setup:** it would need a new Python + CUDA sidecar (faster-whisper / CTranslate2 + cuDNN) or whisper.cpp.
  - **VRAM:** 1–3 GB next to gemma4:12b (~8.4 GB) and the voice.
  - **Silence:** it makes up text on silence, so it would need the same VAD anyway.
  - **Verdict:** Qwen3-ASR's 7–10% Vietnamese error leaves little room to win for that cost.

## Reading the screen (OCR)

Goal: when he says "read what's on my screen", `read_screen` gets the exact text (Vietnamese tones, code,
commands), fast, without crowding gemma4 out of the 16 GB card. Measured on 2026-11-20 on the dev PC with
Ollama 0.40.13, gemma4:12b loaded.

- **Test screens:** four 1920×1080 renders with known text: a Vietnamese task list (Notepad), TypeScript with
  Vietnamese comments (dark VS Code, 15 px Consolas), a PowerShell `git log`, and a Vietnamese YouTube page.
- **Error:** character error rate against the text (spaces and Markdown ignored). Everything the models also
  read (title bar, taskbar clock) counts as an error, so ~0.08–0.12 is the floor for a perfect read; read
  the notes below rather than the decimals.
- **Picking the model:** shortlisted from MDPBench (Mar 2026), which scores Vietnamese separately:
  PaddleOCR-VL-1.5 78.9, GLM-OCR 69.2, DeepSeek-OCR 54.1.

| Model | VRAM | Time per screen | Vietnamese tones | Code / terminal |
|---|---|---|---|---|
| **gemma4:12b** (her own model, the default) | 0 extra | ~4.5 s | right on all four screens | code exact; changed 2 characters in git hashes |
| PaddleOCR-VL-1.5 (`hf.co/PaddlePaddle/PaddleOCR-VL-1.5-GGUF`) | +1.8 GB | ~1.3 s | ~6 slips per screen (tắt→tất, phỏng→phóng, Sáu→Sâu) | `Nam`→`Wam`, `--oneline`→`--online`, a hash in capitals |
| GLM-OCR (`glm-ocr`) | +2 GB | ~1.8 s | unusable (`Cảm ơn`→`Cám ön`, `gửi lại`→`güì lái`) | perfect terminal, near-perfect code |

- **What Mai uses:** her own model (`screen.ocrModel` empty), with a full-resolution PNG and a strict prompt:
  copy character for character, expand and correct nothing. It's the only one that keeps Vietnamese right,
  and it costs no download or VRAM. Its one habit to know: on one screen it read "từ con số 0" as "từ cơ sở",
  even with the strict prompt.
- **Strips don't help.** Cutting the screen into 2–4 overlapping strips gives each line more pixels, but the
  overlaps repeat lines and the copies disagree. A whole screenshot is better.
- **Switching models:** for mostly-English code and terminals, `glm-ocr` is the most exact and 2.5× faster.
  Set it in Settings → Eyes → *Model that reads text on screen*. Dedicated OCR models get their own trigger
  prompt (`OCR:`, `Text Recognition:`) in `src/core/ocr.ts`.
- **End to end** (`scripts/screen-e2e.ts`, approval included): 8.7 s from his question to her answer, which
  quoted the code `XK-4821` from the screen correctly.

## "Mai ơi" wake word

Goal: wake on his "Mai ơi" (alone, or starting a sentence), never on "ngày mai", "Mai à", "trời ơi", other people,
or her own voice, cheaply enough to run all the time. Measured on 2026-11-20 on the dev PC (Ryzen 5 8500G).

- **Test set:** synthetic, from VieNeu's preset voices.
  - **4 male "users":** Northern, Central and Southern accents.
  - **Each one:** 5 enrollment takes, 2 ordinary sentences for calibration, 5 held-out wake clips (3 of them
    "Mai ơi, …" sentences) and 10 look-alikes: ngày mai, trời ơi, anh ơi, mai mốt, mãi mới, em ơi, hai ơi,
    Mai à, mấy giờ rồi, a GitHub sentence.
  - **Also scored:** other speakers' clips, and Mai's own voice saying sentences with "Mai" in them.
- **Not tested:** real voices, room noise, a TV in the background. Enrolling his real voice is the real test.
  `state\wake.log` in the data folder records every candidate with what speech recognition heard.

| Stage | "Mai ơi" clips that woke her | Other clips that woke her |
|---|---|---|
| Detector only (his 5 takes, DTW on openWakeWord embeddings) | 20 / 20 | 12 / 92 (look-alikes in his own voice: "Mai à", "mãi mới", "hai ơi", "mai mốt") |
| + strict check ("m…ai ơi" in the transcript) | 10 / 20 | 0 / 92 |
| **+ lenient check (any "-ai/-ay + ơi"; what Mai uses)** | **18 / 20** | **1 / 92** ("hai ơi" heard as "ai ơi") |

- **Streaming** (the real `WakeListener`, 58 s of mixed audio in 100 ms chunks): 2/2 wakes at the right
  moment, 0 wrong. On "Mai ơi, mấy giờ rồi?" it fires after "Mai ơi", so the question still reaches her.
- **Cost:** about 8% of one CPU core for the detector, which is ~1.3% of the 6-core CPU; less in a quiet room.
  Speech recognition runs only on a hit.
- **Why the strict check failed:** Qwen3-ASR wrote his "Mai ơi" as "Mày ơi", "AI ơi", "mai ổi", "tai ơi",
  "bài ơi". The acoustic match already did the hard part, so the check only has to rule out the look-alikes.
- **In the real pet window** (`wake-e2e.mjs`, fake mic): she woke 3.0 s after the clip started, "Mấy giờ rồi"
  was sent 1.4 s later, her answer played to the end, the mic reopened 0.5 s after it, and 5 s of silence
  ended the conversation.
- **Ruled out:**
  - **sherpa-onnx keyword spotting:** no Vietnamese model.
  - **Porcupine:** no Vietnamese, and it needs an online key.
  - **Re-running speech recognition on every utterance:** 1–2 s of CPU per sentence in the room, 1.5–3 s late,
    and "ngày mai" is everywhere.
  - **A trained openWakeWord model:** the next step, once his enrollment takes plus synthetic voices make a
    training set ([STT-PLAN.md](STT-PLAN.md)).
