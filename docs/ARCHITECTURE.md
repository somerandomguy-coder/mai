# Architecture

```
            ┌──────────── Electron main (src/app/main.ts) ────────────┐
 pet window │  roam.ts: roam/chat modes, wandering, drag & drop       │  settings window
 (renderer) │  speech queue → TTS → audio chunks to the pet           │  (persona, history,
  pet.js  ◄─┤  approvals (dialogs), tray, hotkey, IPC                 ├─► config, look)
            └──────────────┬──────────────────────────────────────────┘
                           │ events
            ┌──────────────▼────────── Brain (src/core/brain.ts) ─────┐
            │ pi AgentSession (Ollama via OpenAI API)                  │
            │  hooks: system prompt + "right now" note · tool repair · │
            │         goal check (keep going / don't fabricate)        │
            │ tools.ts (30 tools) · persona (git) · mood · needs ·     │
            │ calendar · todos · quests · screen · heartbeat           │
            └──────┬───────────────────────────┬──────────────────────┘
                   │                           │
           Ollama :11434              sidecars (sidecars.ts)
           mai-brain + tev1 judge     ├ Python :8765  needle repair + sea-g2p phonemizer
                                      └ audio.cpp :8080  VieNeu (+ VoxCPM2), Qwen3-ASR (mic)
```

`src/core` has no Electron imports, so the same brain runs in the terminal (`src/tui.ts`) and in the tests.

## A turn

1. **He types.** `Brain.chat()` adds a timestamp and language hint, then `session.prompt()`.
2. **`before_agent_start`** builds the prompt (`prompt.ts`) in two parts:
   - the system prompt: SOUL / USER / MEMORY / HEARTBEAT and the rules. It only changes when she edits
     those, so Ollama keeps the whole chat after it cached;
   - a "[Right now]" note (time, 7-day dates, mood, needs, screen, calendar, quests, todos, work mode). The
     `context` hook attaches it to his newest message on every LLM call of the run, never to older ones.
     This made turns ~2× faster ([BENCHMARKS.md](BENCHMARKS.md)).
3. **The model streams.** Text deltas go to the bubble, and finished sentences become `utterance` events. The
   main process synthesizes them in order and the pet plays them back to back.
4. **`message_end`.** If the model wrote a tool call as *text*, `repair.ts` turns it back into a real one, using
   `jsonrepair` first and the needle sidecar as fallback.
5. **Tools run.** `move_file` and non-read-only `run_powershell` go through `Services.approve()`. The renderer
   shows a dialog; the answer is Allow once / Allow all for this request / Deny.
6. **`agent_before_settle`.** The run is checked before it ends:
   - if she said nothing, she's told to answer;
   - if he denied an approval, nothing more happens: it's his call;
   - otherwise the judge (`judge.ts`) looks at the request, the tools used and her reply. It's the decision
     model `ollama.judgeModel` via `POST /v1/systemone` on every reply (~80 ms). With no decision model, her
     own model judges, but only replies that make claims, promise work or used tools. CONTINUE or
     FABRICATED nudges her to go on (at most `agent.maxAutoContinues`).

## Live voice typing (🎙️)

1. **Click.** `pet.js` asks the main process to start a `LiveTranscriber` (`livestt.ts`) and stops her voice.
   An AudioWorklet (`mic-worklet.js`) sends 16 kHz mono PCM every 100 ms over IPC.
2. **VAD.** Silero VAD (`vad.ts`, onnxruntime-web on the CPU) scores each 32 ms frame. 250 ms of speech starts
   an utterance; silence and steady noise never do. Without the model it falls back to a loudness check.
3. **Partials.** While he talks, the whole utterance so far goes to Qwen3-ASR (`stt.ts`) about once a second,
   one request at a time. Each answer replaces the words in the box (in grey italics), so the text firms up.
4. **Auto-send.** When he pauses, a pass starts right away. If the silence reaches `mic.pauseMs` (900 ms), that
   pass is the final text and the pet submits it (`mic.autoSend`).
   - **Stop and cancel:** clicking ⏹️ sends now, Esc cancels, typing takes over.
   - **No speech:** nothing for 10 s just stops listening.
5. **Why not native streaming:** audio.cpp's `/v1/audio/transcriptions/live` decodes fixed 2 s windows on their
   own and nearly doubled the error rate; numbers in [BENCHMARKS.md](BENCHMARKS.md).

## Work mode (long tasks)

1. **She asks.** `start_long_task` sends a goal and a step list to an approval dialog. On approval, `TaskBoard`
   (`longtask.ts`) saves the task to `state/task.json`.
2. **Every turn.** The prompt gets a "Work mode" section: goal, checklist, her recent notes, budget left. She logs
   each finished step and any findings with `task_progress`.
3. **Keep going.** In `agent_before_settle`, a running task always continues with "Keep going: step N".
   - **Context guard:** pi only compacts when a run *starts*, and a long task is one long run. Past ~65% of the
     window, or after a turn that ran out of room, work mode compacts everything but the last few turns into the
     task board's goal, checklist and notes.
   - **Stall guard:** three continuations in a row without any tool use pause the task, and she reports what's
     blocking.
   - **Budget:** `agent.longTask.maxTurns` / `maxMinutes`; when it runs out she reports what's done and what's left.
4. **Resume.** If a run errors or the app restarts mid-task, the heartbeat's minute tick calls `resumeTask()`.
   ⏹ in the task bar calls `stopTask()`.

## Proactive behaviour (`heartbeat.ts`)

- **Every minute:**
  - needs tick, and the model keep-warm ping;
  - due reminders, then auto-verified quests;
  - "welcome back" after being idle.
- **Every N minutes:** gather signals and wake her with a `[HEARTBEAT]` message. She answers `SILENT` if there's
  nothing worth saying. Signals include:
  - first run, late night, long app sessions;
  - overdue honor quests and overdue todos;
  - urgent needs;
  - a random "spontaneous" moment.
- Daily cap and quiet hours apply.

## Where to change things

| Change | File |
|---|---|
| File exploring / editing | `src/core/fsops.ts` (walk, find, search, exact edits, insert, backups) |
| Work mode (long tasks) | `src/core/longtask.ts` (task board) + the work-mode branch of `agent_before_settle` in `brain.ts` |
| Mic / live voice typing | `src/core/livestt.ts` (VAD → partials → auto-send), `src/core/vad.ts` (Silero), `src/core/stt.ts` (Qwen3-ASR request), `mic-worklet.js` + the 🎙️ block in `pet.js` |
| Add a tool | `src/core/tools.ts` (`defineTool`, add to the returned list; give it a label in `TOOL_LABEL` in `pet.js`) |
| A new need / tweak rates | `src/core/needs.ts` |
| Prompt structure | `src/core/prompt.ts` |
| Proactive signals | `src/core/heartbeat.ts` |
| Voice engines / mood delivery | `src/core/tts.ts`, server config in `src/core/sidecars.ts` |
| Roaming / window modes | `src/app/roam.ts` |
| Pet UI | `src/app/renderer/pet.{html,css,js}` (no build step; plain JS) |
| Settings UI | `src/app/renderer/settings.{html,css,js}` (fields in `FIELDS`) |
| Config defaults | `src/core/config.ts` |
| Setup steps | `setup.ps1`, `scripts/setup-vieneu.ps1` |

## Tests

| Command | What |
|---|---|
| `npx tsx scripts/repair-test.ts` | tool-call repair, mood tags, sentence chunking |
| `npx tsx scripts/shell-test.ts` | PowerShell safety classifier + runner |
| `npx tsx scripts/markdown-test.ts` | bubble Markdown renderer (incl. XSS cases) |
| `npx tsx scripts/needs-test.ts` | needs drift, feeding, todos |
| `npx tsx scripts/fsops-test.ts` | find/search/tree, exact edits, insert by anchor, CRLF/BOM, backups |
| `npx tsx scripts/task-test.ts` | work-mode task board: steps, notes, budget, restart |
| `$env:MAI_HOME="$env:TEMP\mai-work"; npx tsx scripts/work-e2e.ts` | real model: explore, edit, and long tasks looped to completion |
| `npx tsx scripts/livestt-test.ts` | live mic logic with the real Silero VAD: partials, one auto-send, short pauses, noise, stop/cancel |
| `npx tsx scripts/stt-test.ts` | mic round trip VieNeu → Qwen3-ASR (needs Mai's voice server running) |
| `npx electron scripts/live-mic-e2e.mjs <wav> vi` | the real pet window with a fake mic, live transcription, auto-send (needs the voice server + `npm run build`) |
| `npx tsx scripts/bench/stt-live-bench.ts <clips>` | live voice typing latency/accuracy ([BENCHMARKS.md](BENCHMARKS.md)) |
| `npx tsx scripts/files-test.ts [--vision]` | read_file across ~15 formats (+ real vision model) |
| `node scripts/check-sprites.mjs [dir]` | sprite set validator |
| `$env:MAI_HOME="$env:TEMP\mai-e2e"; npx tsx scripts/e2e.ts` | real-model scenarios (needs Ollama) |
| `npx tsc --noEmit -p .` | typecheck |
