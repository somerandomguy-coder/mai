# Plan: speech recognition that understands his voice

Status: plan only (2026-11-20). He says the mic often gets his words wrong. The wake-word tests agree: Qwen3-ASR
wrote "Mai ơi" as "Mày ơi", "AI ơi", "mai ổi" or "bài ơi" depending on the voice.

## What runs today

- **Model:** Qwen3-ASR-0.6B (q8_0) on the CPU through audio.cpp, re-run on the growing utterance about once a
  second ([BENCHMARKS.md](BENCHMARKS.md#live-voice-typing-)).
- **Scores:** 6.9% word error on clean read Vietnamese (FLEURS) and 14.4% on English. Those are studio-ish
  clips, not him on his own mic with mixed Vietnamese/English and names (Lyra, GitHub, Claude).

## 1. Measure on his voice first (an evening)

Fine-tuning only helps if we know where the errors come from.

1. **Voice check:** a Settings page that shows 30 sentences, one at a time, and records him reading each.
   - **What they cover:** chat-style Vietnamese, English words mixed in, his names and projects, numbers and
     times.
   - **What it computes:** word error per model, plus a list of the words it gets wrong.
2. **Cheap fixes to try against that set before any training:**
   - **Mic chain:** echo cancellation, noise suppression and auto gain on/off, and the mic itself (a headset
     often beats a laptop mic by more than any model change).
   - **Language hint:** "vi" vs "auto" (auto is better for mixed sentences, vi for pure Vietnamese).
   - **Context biasing:** pass his names and terms as context, if the audio.cpp route supports it.
   - **Bigger or GPU models:** the CUDA build of audio.cpp (the 32 GB profile already uses it), a larger
     Qwen3-ASR if audio.cpp has one, and PhoWhisper (Whisper fine-tuned on Vietnamese) as a reference point.
3. **Decide:** if one of those closes most of the gap, stop here.

## 2. Collect training data while he uses her (opt-in)

- **The switch:** *Help her learn my voice* in Settings → Mic, off by default.
- **What gets saved:** every voice message's audio plus the text that was finally sent. If he fixed a word in the
  box before sending, that fix is the label. They go to `state\voice-data\` in his data folder, never the repo.
- **Review page:** listen, fix the text, delete clips. Same idea as the voice lab's dataset review page.
- **Already started:** his "Mai ơi" enrollment takes are kept in `state\wake\`.
- **Target:** about 1–2 hours of his speech. That's a few weeks of normal use, plus one or two 30-minute reading
  sessions from the voice check above.

## 3. Fine-tune (once there's data)

- **What:** a LoRA adapter on Qwen3-ASR-0.6B (or on PhoWhisper, if it won step 1), trained on his clips mixed
  with general Vietnamese speech so it doesn't forget everyone else.
- **Where:** the 16 GB GPU is plenty for a 0.6B model; expect well under an hour per run. The voice lab
  (`voice-lab\`) already has the dataset tooling: Whisper-checked clips, `train.jsonl`, and a review page.
- **Measured on:** the held-out sentences from step 1, before vs after. Speaker adaptation typically cuts errors
  substantially for one voice, but that has to be measured here.
- **Shipping it:** merge the adapter and convert it for audio.cpp, or run it in a small sidecar if audio.cpp
  can't load it. His model stays in his data folder.

## 4. A trained "Mai ơi" model (wake word v2)

Today's detector is few-shot: it compares the mic with his 5 takes, and speech recognition double-checks
([ARCHITECTURE.md](ARCHITECTURE.md#mai-ơi-and-hands-free-conversation)). A trained model is more robust
to noise and to how he says it on a tired day.

- **Positives:** his enrollment takes, plus thousands of synthetic "Mai ơi" clips from the voice lab's voices
  (VieNeu presets, VoxCPM clones), with speed and pitch changes.
- **Negatives:** look-alikes ("ngày mai", "Mai à", "hai ơi", "trời ơi") in the same voices, and Mai's own voice.
- **Train and run:** an openWakeWord classifier head on the same embeddings Mai already computes, so it runs at
  the same cost as today.
