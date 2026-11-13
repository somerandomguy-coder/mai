# Plan: Mai's desktop shell on Rune (Rust)

Status: plan only, nothing started (2026-11-13). Goal: replace the Electron shell with a native Rust app built on
[Rune](https://github.com/anomalyco/rune) to cut memory and startup time. Fallback: Tauri.

## Why, and what it will (and won't) save

- **Electron cost:** Mai's shell is Electron, which means Chromium (a GPU process, a renderer per window and a
  main process). That's typically 250–400 MB of RAM for a small app.
- **Rune's cost:** a GPU-rendered native UI (wgpu, its own text and layout) should run the shell in tens of MB.
- **Not touched by this:** the models (gemma4 in VRAM, Ollama's runner RAM, the TTS) dominate Mai's footprint
  and don't change. Measure the shell before and after (phase 0) so the win is a number, not a hope.
- **The brain stays TypeScript at first** (`src/core`, the pi SDK agent, tools, persona, heartbeat). It runs as
  a headless Node process the Rust shell talks to. Porting the brain to Rust is a separate, much bigger project.
  It's only worth it if Node's ~100 MB still matters after the shell is native.

## What Rune gives us (checked in its docs, `dev` branch, 2026-11-13)

| Mai needs | Rune | Notes |
|---|---|---|
| Transparent, always-on-top pet window | partly | `App::overlay`: transparent, topmost, never steals focus, clicks pass through unless `interactive`. But only anchored to the **top or bottom edge** of the primary display, with no per-monitor placement. `WindowOptions { borderless, always_on_top }` exist for normal windows, but nothing says they can be transparent. |
| Pet roams anywhere, can be dragged | gap | Needs a transparent overlay or window placed at any x,y and moved every frame (`set_position` exists on tray windows). |
| Click-through except on the sprite | gap | Overlays are all-or-nothing (`WS_EX_TRANSPARENT` unless interactive). Mai needs per-pixel hit testing, or toggling pass-through as the cursor enters the sprite (Electron does this with `setIgnoreMouseEvents(.., {forward: true})`). |
| Chat bubble with Markdown | yes | rune-kit `Markdown` (selectable), rich text, scroll that sticks to the bottom. |
| Text box for Vietnamese | likely | `text_input` with IME preedit through winit. **Must test with Telex/VNI input methods** (UniKey, EVKey, Windows' own Vietnamese keyboard). Inter covers Vietnamese glyphs. |
| Settings window, dialogs | yes | Multiple windows (`run_windows`, `WindowSpec`), custom titlebars, rune-kit components. |
| Drag a file onto her | yes | `on_drop_files`, `on_drop_hover` (`examples/drop-files`). |
| Tray icon | app's job | "The app owns its tray; Rune supplies the window lifetime and handles": use the `tray-icon` crate. |
| Global hotkey (Ctrl+Alt+M) | app's job | `global-hotkey` crate (Rune's shortcuts are in-app). |
| Sprite animation, moods | yes | Images, springs and motion (`rune-motion`), presence transitions. |
| Voice playback, mic | not UI | `rodio` / `cpal` in Rust, or keep audio in the Node brain. |
| Headless tests | yes, a bonus | Render to PNG, dump the element tree, drive with scripted input. Replaces `scripts/screenshots/capture.cjs`. |

**Risk:** Rune's README says its Windows build is "checked with `cargo xwin clippy` only", meaning compiled but not
run-tested by the authors. Mai is Windows-first, so phase 0 decides whether Rune is usable at all.

## Contributing back

Rune **does not accept pull requests**: "Have your agent open an issue describing the bug or idea, and our
agents usually turn it around fast." So when something is missing or broken, we file a **GitHub issue** with:
- a minimal repro based on one of their examples;
- what happened versus what we expected;
- Windows version and GPU;
- a headless PNG or tree dump where it helps.

Then we work around the problem while waiting. Likely issues from the table above:
1. Overlays (or transparent borderless windows) at an arbitrary position, movable each frame, per monitor.
2. Per-element click-through: pass clicks through transparent areas, catch them on an element (or a
   `set_ignore_cursor(bool)` toggle the app drives from hover).
3. Anything that fails when actually running on Windows (phase 0 will find these).
4. Vietnamese IME problems in `text_input`, if any.

Filing an issue is public and outward-facing: show the user the draft before posting.

## Phases

### Phase 0: spike, about 1–2 days. Go or no-go.
In a scratch crate, on the dev PC (Windows 11, RTX 5060 Ti):
1. Build and run `examples/hello`, `examples/overlay`, `examples/drop-files` and `examples/settings` with MSVC.
   Note every crash or visual bug.
2. A 256×256 transparent pet:
   - shows a sprite PNG;
   - sits above other windows;
   - lets clicks through outside the sprite and catches them on the sprite;
   - can be dragged;
   - moves across the screen by itself.
   Try overlay first, then a borderless always-on-top window, then a raw `HWND` tweak through the window handle
   (`SetWindowLongPtr` with `WS_EX_LAYERED|WS_EX_TRANSPARENT`, toggled on hover) as the workaround.
3. A text box: type Vietnamese with Telex (UniKey or the Windows Vietnamese keyboard), and paste emoji.
4. Measure RAM (private working set) of the spike next to today's Electron shell showing the same sprite and
   bubble, both idle and while animating.

- **Go:** items 2 and 3 work (natively or with a small, contained workaround) and RAM is clearly lower.
- **No-go:** Tauri (see below).

### Phase 1: split the brain into its own process
- Add `src/brain-server.ts`: runs `Brain` headless and speaks JSON lines over stdio.
  - **Requests:** `chat`, `poke`, `feed`, `stopTask`, `approve` answers, `getStatus`, `getConfig` /
    `setConfig`, `transcribe`, `persona` history and rollback, `quit`.
  - **Events:** everything `Brain` emits today (`utterance`, `mood`, `tool`, `task`, `needs`, `repair`,
    `state`, approval requests, audio-ready).
  - This is the same surface as `src/app/preload.cjs` / IPC in `src/app/main.ts`, so it can be generated from one
    list.
- Move TTS synthesis and playback ordering into the brain side (or a small audio module). The shell then
  only plays files or PCM it's told to.
- Electron switches to the same protocol first, so both shells work and the protocol is proven before any Rust
  exists. `src/core` still must not import Electron.

### Phase 2: the Rust shell (`shell/`, a Cargo crate in this repo)
- **Process:** spawns `node dist/brain-server.js` and restarts it if it dies.
- **Windows and system:**
  - single instance;
  - tray icon (`tray-icon`): show/hide/quit;
  - `Ctrl+Alt+M` (`global-hotkey`).
- **Pet window:**
  - sprite sets from `sprites/<set>/sprite.json` (the same format; `scripts/check-sprites.mjs` still applies);
  - states: idle, talk, yawn, moods;
  - roaming and drag/drop, poke and feed.
- **Chat bubble and box:**
  - streaming text with Markdown;
  - a bigger chat box;
  - the task bar with a Stop button;
  - approval dialogs: PowerShell, move, edit with a diff preview, long task. These must stay modal and explicit.
    Never weaken them (`AGENTS.md`).
- **Settings window:** every field in `src/app/renderer/settings.js`, plus persona history and rollback.
- **Audio:**
  - `rodio` for the sentence queue;
  - `cpal` for the mic at 16 kHz mono, using the live-transcription protocol from the mic session (stream
    chunks to the brain/ASR, show partial text).
- **Tests:** headless PNG goldens of the pet, the bubble and settings in `scripts/` (or `cargo test`). Plus the
  brain's existing tests, unchanged.

### Phase 3: ship it
- **Prebuilt download:** a GitHub release with `mai.exe`, so the friend's PC doesn't need Rust. `setup.ps1`
  downloads it (idempotent, ASCII), and the desktop shortcut points to it.
- **Build from source:** `cargo build --release` for anyone who wants it. Pin Rune to a `dev` rev
  (`dev` is never rewritten); bump it on purpose.
- Update the docs: README (what's inside, RAM numbers), ARCHITECTURE (the two processes), AGENTS (where
  things are now), CUSTOMIZE (sprites unchanged), TROUBLESHOOTING.

### Phase 4: retire Electron
Once the parity checklist below passes on both PCs, delete `src/app` and the Electron dependency. That drops
`node_modules` by hundreds of MB. Keep `src/tui.ts`.

## Parity checklist (from today's Electron app)

- [ ] Transparent roaming pet; drag/drop; click-through outside the sprite; yawns while models load
- [ ] Mood and expression sprites; poke; feed; needs stats
- [ ] Chat: streaming bubble, Markdown, big input box, Vietnamese typing (Telex/VNI)
- [ ] Voice: sentences play in order with no gaps; mic with live partial transcripts (from the mic session)
- [ ] Approvals: PowerShell, move file, edit file (diff), read outside roots, long task; "allow all for this
      request"; deny by default
- [ ] Work mode task bar with progress and Stop
- [ ] Settings: all fields, sprite set, voice engine and voice, models, allowed folders; persona history and
      rollback
- [ ] Tray show/hide/quit, `Ctrl+Alt+M`, single instance, starting again brings her back
- [ ] Works on the dev PC (16 GB) and the friend's PC (32 GB); RAM measured and written in the README

## Fallback: Tauri

Use Tauri v2 if phase 0 says no-go, or Rune blocks us for more than about a week.
- **Reuse:** it keeps the existing HTML/CSS/JS renderer almost as is (`src/app/renderer`), with a Rust backend
  and WebView2, which Windows 11 already has.
- **Built in:** transparent windows, `set_ignore_cursor_events`, tray, global shortcuts and single instance are
  plugins.
- **Memory:** WebView2 is heavier than Rune, but usually well under Electron, because it shares the system
  runtime and there's no bundled Chromium.
- **Same plan otherwise:** phase 1 (brain process) applies unchanged; phase 2 becomes "port `main.ts`
  to Rust commands".
