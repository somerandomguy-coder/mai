# Troubleshooting

**First step for anything:** run `setup.cmd -CheckOnly`. It lists what's missing or broken without changing
anything. Run `setup.cmd` to fix it.

### I can't find her
- She roams along the bottom of the screen. Click her to open the chat.
- `Ctrl+Alt+M` brings her up from anywhere (`Ctrl+Alt+Shift+M` if another app owns the first shortcut).
- The tray icon (click **^** next to the clock) → *Show / hide Mai*.
- Starting Mai again (desktop shortcut) while she's running just brings her back.

### She says "Ollama is not reachable"
Start Ollama (Start menu → Ollama), wait a few seconds, then restart Mai. `ollama list` in a terminal should
show `mai-brain` (and `tev1:4b-q4_K_M` on 12 GB+ cards). If they're missing, run `setup.cmd`.

### "goal-check model … unavailable" in the log
The decision model isn't downloaded, or Ollama is older than 0.40.4. She still works: her own model judges
instead. Run `setup.cmd` to upgrade Ollama and download it.

### Replies are slow
- Right after start she yawns while the models load; the first reply after that should take a few seconds.
- Check the GPU: `nvidia-smi` should show her model in VRAM. `ollama ps` should show `100% GPU`; if it says
  CPU, the model is too big for your card. Run setup with a smaller `-Profile`.
- Leave *Thinking* off in Settings → Brain.

### Her voice is the "online" one, or she's silent
- A notice like *"Local voice unavailable…"* means she fell back to the online voice. Check
  `%USERPROFILE%\.mai-companion\state\audiocpp-server.log`, then run `setup.cmd`.
- 🔊 might be muted (🔇).
- Test the voice on its own while Mai is running: `npx tsx scripts/tts-test.ts` writes WAVs into
  `.mai-companion\state\tts-test`.
- VoxCPM2 needs the CUDA build. Re-run setup, or `scripts\setup-vieneu.ps1 -Cuda -Expressive`.

### The mic (🎙️) doesn't type, or sends too early / too late
- **How it works:** click 🎙️ and just talk. Words show up in the box as you speak, and the message sends itself
  after about a second of quiet. Click ⏹️ to send right away, or press **Esc** to cancel.
- **"Speech recognition isn't installed yet":** run `setup.cmd`.
- **"The voice server … isn't answering":** the mic uses her local voice server. Check
  `stateaudiocpp-server.log`, then restart Mai.
- **"I didn't catch anything":**
  - pick the right microphone in ⚙ → Settings → *Microphone & Voice Input* (press *Test Mic*: the meter should
    move when you talk);
  - talk a little closer.
  - Background noise alone doesn't trigger it, but a TV or other people talking can.
- **Wrong language:** right-click 🎙️ to switch between Tiếng Việt and English.
- **It sends before you've finished a thought:** raise Settings → Mic → *Pause before sending* (e.g. 1500 ms).
- **You'd rather press Enter yourself:** untick *Send by itself*.
- **Words lag behind on long sentences:** each update re-reads the whole sentence. On the CPU voice build
  that takes ~1.5 s for a 10 s sentence; the CUDA build (32 GB profile, or `scriptssetup-vieneu.ps1 -Cuda`) is
  faster.
- **`setup.cmd -CheckOnly` says "Silero VAD … need":** run `setup.cmd`. Until then the mic falls back to a
  simple loudness check, which noise can trigger.

### Windows asks about `audiocpp_server.exe` or `python.exe`
They're her local voice server and helper, listening on 127.0.0.1 only. Allow them.

### She did something I didn't want
- **Personality or memory:** ⚙ → History & rollback → pick the version before it → *Restore*.
- **Files:** she can only move files after you click *Allow*. Moves are listed in the chat history.
- **Turn things off:** Settings → Hands (PowerShell, quests, folders) and Settings → Eyes (screen).

### Setup fails
- **"winget is missing":** install *App Installer* from the Microsoft Store.
- **"not on PATH yet":** close the window, open a new one, run setup again (installers update PATH for new
  windows only).
- **A model download fails:** run setup again; finished downloads are kept.

### Start over
Quit Mai (tray → Quit) and rename `%USERPROFILE%\.mai-companion`. Next start she's brand new. Your old self is
still in the renamed folder.

### llama-server uses 10–15 GB of RAM (not VRAM)

That is Ollama's runner caching old conversations in system RAM: a prompt cache of up to 8 GB plus up to
32 "context checkpoints" per chat. The model itself is still in VRAM. `setup.cmd` caps it with two user
environment variables (`LLAMA_ARG_CACHE_RAM=2048`, `LLAMA_ARG_CTX_CHECKPOINTS=4`) and restarts Ollama. In
tests, RAM went from ~9.6 GB to ~2.9 GB at the same speed ([BENCHMARKS.md](BENCHMARKS.md)). Smaller caps make
her slower after screen peeks. To undo it, delete those two variables and restart Ollama.
