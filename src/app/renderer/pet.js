// Desktop pet renderer: sprite animation, speech bubble, input, and voice playback.
const $ = (id) => document.getElementById(id);
const avatar = $("avatar");
const bubble = $("bubble");
const bubbleText = $("bubble-text");
const bubbleMeta = $("bubble-meta");
const logEl = $("log");
const logLines = $("log-lines");
const activity = $("activity");
const activityIcon = $("activity-icon");
const activityText = $("activity-text");
const badge = $("mood-badge");
const hearts = $("hearts");

const MOOD_BADGE = { happy: "💗", proud: "✨", teasing: "😏", stern: "💢", angry: "💢", pouty: "😤", worried: "💧", sleepy: "💤", neutral: "" };
const TOOL_LABEL = {
  remember: "noting that down", edit_persona: "rewriting herself", read_persona_file: "checking her notes",
  calendar_add: "writing in the calendar", calendar_list: "checking the calendar", calendar_remove: "crossing it out",
  quest_give: "inventing a quest", quest_check: "inspecting your work", quest_resolve: "judging you",
  look_at_screen: "peeking at you", system_info: "checking your PC", recommend_models: "consulting the cookbook",
  list_folder: "digging through folders", move_file: "moving files", open: "opening it",
  todo_add: "writing your todo", todo_list: "checking your todos", todo_complete: "ticking it off", todo_remove: "crossing it out",
  adjust_needs: "having feelings", run_powershell: "running a command", read_file: "reading your file",
  folder_tree: "looking around the folder", find_files: "looking for files", search_files: "searching in files",
  edit_file: "editing a file", insert_text: "adding lines", write_file: "writing a file",
  start_long_task: "asking to work on it", task_progress: "ticking off a step", read_screen: "reading text",
};
/** Icon + animation for the thought bubble over her head. "peek" = looking at his screen, "scan" = reading text off it. */
const TOOL_LOOK = {
  look_at_screen: ["👀", "peek"], read_screen: ["📄", "scan"],
  read_file: ["📄", "scan"], read_persona_file: ["📓", "tool"],
  list_folder: ["📂", "tool"], folder_tree: ["📂", "tool"], find_files: ["🔎", "tool"], search_files: ["🔎", "tool"],
  edit_file: ["✏️", "tool"], insert_text: ["✏️", "tool"], write_file: ["✏️", "tool"], move_file: ["📦", "tool"],
  remember: ["📝", "tool"], edit_persona: ["📝", "tool"], todo_add: ["📝", "tool"], todo_list: ["📋", "tool"],
  todo_complete: ["✅", "tool"], todo_remove: ["✖️", "tool"],
  calendar_add: ["📅", "tool"], calendar_list: ["📅", "tool"], calendar_remove: ["📅", "tool"],
  system_info: ["🖥️", "tool"], recommend_models: ["📖", "tool"], run_powershell: ["⌨️", "tool"], open: ["🚀", "tool"],
  quest_give: ["🎯", "tool"], quest_check: ["🧐", "tool"], quest_resolve: ["⚖️", "tool"],
};

let sprite = null;
let base = "";
let activityState = "idle"; // idle | thinking | tool | talking
let toolName = "";
let mood = "neutral";
let moodHoldUntil = 0;
let speaking = false;
let frameTimer = null;
let currentKey = "";
let hideTimer = null;
let muted = false;
let pose = { mode: "roam", behaviour: "idle", facing: "left" };
let loading = false;
/** A short one-off animation (eating after 🍙, flinching after 👉) that wins over everything but dragging. */
let flash = null;
function playFlash(names, ms) {
  flash = { state: pick(...names), until: Date.now() + ms };
  refresh();
  setTimeout(refresh, ms + 20);
}

/** First state the sprite set actually has; sets without e.g. "walk" or "yawn" fall back gracefully. */
function pick(...names) {
  return names.find((n) => sprite.states[n]) || "idle";
}

// ---------- sprite animation ----------
function stateFor() {
  if (pose.behaviour === "held") return pick("held", "surprised", "upset");
  if (pose.behaviour === "fall") return pick("fall", "surprised", "upset");
  if (flash && Date.now() < flash.until) return flash.state;
  if (speaking || activityState === "talking") return "talk";
  if (loading) return pick("yawn", "sleep", "think");
  if (pose.behaviour === "walk") return pick("walk", "idle");
  if (activityState === "tool") return (sprite.tools && sprite.tools[toolName]) || "tool";
  if (activityState === "thinking") return "think";
  // Show the mood pose for a few seconds after she speaks, then settle to idle (the badge keeps the mood visible).
  // A set may ship a state named after the mood ("pouty", "angry"); otherwise use its "moods" mapping.
  if (Date.now() < moodHoldUntil) return pick(mood, (sprite.moods && sprite.moods[mood]) || "idle");
  // Very late and drained: she dozes off (if the set has a sleep animation).
  if (lastNeeds && lastNeeds.energy < 20 && pose.behaviour === "idle") return pick("sleep", "idle");
  return "idle";
}

function play(stateName) {
  const st = sprite.states[stateName] || sprite.states.idle;
  const key = stateName;
  if (key === currentKey) return;
  currentKey = key;
  clearTimeout(frameTimer);
  let i = 0;
  const frames = st.frames;
  const tick = () => {
    if (st.blink && stateName === "idle") {
      avatar.src = base + frames[0];
      frameTimer = setTimeout(() => {
        avatar.src = base + st.blink;
        frameTimer = setTimeout(tick, 140);
      }, 2500 + Math.random() * 3500);
      return;
    }
    const idx = st.random ? Math.floor(Math.random() * frames.length) : i++ % frames.length;
    avatar.src = base + frames[idx];
    frameTimer = setTimeout(tick, 1000 / (st.fps || 4));
  };
  tick();
}

function refresh() {
  if (sprite) play(stateFor());
}
setInterval(refresh, 500);

// ---------- bubble & log ----------
function showBubble(text, { proactive = false, meta = "", streaming = false } = {}) {
  clearTimeout(hideTimer);
  // renderMarkdown escapes all HTML first, so model text can't inject markup.
  bubbleText.innerHTML = window.renderMarkdown(text, streaming);
  bubbleMeta.textContent = meta;
  bubble.classList.toggle("proactive", proactive);
  bubble.classList.remove("hidden");
  bubbleText.scrollTop = bubbleText.scrollHeight;
}
function scheduleHide(ms = 25000) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => bubble.classList.add("hidden"), ms);
}
function addLog(line) {
  const empty = logLines?.querySelector(".log-empty-hint");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `line ${line.role}`;
  if (line.role === "mai") div.innerHTML = window.renderMarkdown(line.text);
  else div.textContent = line.text;
  const small = document.createElement("small");
  small.textContent = `${new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${line.proactive ? " · on her own" : ""}`;
  div.prepend(small);
  const target = logLines || logEl;
  target.appendChild(div);
  target.scrollTop = target.scrollHeight;
}
function setMood(m) {
  mood = m;
  moodHoldUntil = Date.now() + 8000;
  badge.textContent = MOOD_BADGE[m] || "";
  badge.classList.toggle("show", !!MOOD_BADGE[m]);
  refresh();
}
function setHearts(affection) {
  const n = Math.max(0, Math.min(5, Math.round((affection + 20) / 24)));
  hearts.textContent = "♥".repeat(n) + "♡".repeat(5 - n);
  hearts.title = `affection ${Math.round(affection)}/100`;
}

// ---------- the thought bubble over her head ----------
let thinkTimer = null;
function hideActivity() {
  clearInterval(thinkTimer);
  activity.classList.add("hidden");
}
function showThinking() {
  clearInterval(thinkTimer);
  activity.className = "thinking";
  activityIcon.textContent = "💭";
  activityText.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  // A long think looks like a freeze; show that she's still on it.
  const started = Date.now();
  thinkTimer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    if (s >= 4) activityText.innerHTML = `thinking ${s}s <span class="dots"><i></i><i></i><i></i></span>`;
  }, 1000);
}
function showTool(name, text) {
  clearInterval(thinkTimer);
  const [icon, look] = TOOL_LOOK[name] || ["🛠️", "tool"];
  activity.className = look;
  activityIcon.textContent = icon;
  activityText.textContent = text || TOOL_LABEL[name] || name.replace(/_/g, " ");
  // A screenshot is being taken right now: a quick camera flash so he knows she looked.
  if (name === "look_at_screen" || name === "read_screen") {
    const sh = $("shutter");
    sh.classList.remove("flash");
    void sh.offsetWidth; // restart the animation
    sh.classList.add("flash");
  }
}

// ---------- brain events ----------
let streamingText = "";
window.mai.onEvent((e) => {
  switch (e.type) {
    case "state":
      if (e.state === "loading") { setLoading(true); break; }
      if (loading && e.state === "idle") setLoading(false);
      activityState = e.state;
      if (e.state === "thinking") { streamingText = ""; showThinking(); }
      if (e.state === "idle") hideActivity();
      refresh();
      break;
    case "delta":
      hideActivity();
      streamingText += e.text;
      showBubble(streamingText, { streaming: true });
      break;
    case "say":
      hideActivity();
      // She has something to say: come back from the floating head and show it.
      if ($("talk").dataset.panel) $("talk").dataset.panel = "";
      showBubble(e.text, { proactive: e.proactive, meta: e.proactive ? "she said this on her own" : "" });
      addLog({ role: "mai", text: e.text, ts: Date.now(), proactive: e.proactive });
      streamingText = "";
      if (muted) scheduleHide();
      break;
    case "mood":
      setMood(e.mood);
      setHearts(e.affection);
      break;
    case "needs":
      setNeeds(e.needs);
      break;
    case "task":
      setTask(e.task);
      break;
    case "planner_changed":
      if ($("talk").dataset.panel === "planner") void renderPlanner();
      break;
    case "tool":
      if (e.phase === "start") {
        toolName = e.name;
        showTool(e.name);
      } else if (e.isError) {
        showTool(e.name, `${TOOL_LABEL[e.name] || e.name}: oops, retrying`);
      } else {
        // Tool done; she goes back to thinking about what she found.
        showThinking();
      }
      refresh();
      break;
    case "error":
      showBubble(`⚠ ${e.message}`, { meta: "system" });
      bubbleText.classList.add("error");
      setTimeout(() => bubbleText.classList.remove("error"), 8000);
      scheduleHide(15000);
      break;
  }
});

// ---------- voice ----------
// Sentences arrive one by one while she's still writing; play them back to back.
const audio = new Audio();
let speechQueue = [];
function playNext() {
  const s = speechQueue.shift();
  if (!s) { speaking = false; refresh(); scheduleHide(); return; }
  audio.src = `data:${s.mime};base64,${s.audio}`;
  audio.play().catch(() => playNext());
}
function stopSpeech() {
  speechQueue = [];
  audio.pause();
}
window.mai.onSpeech((s) => {
  if (muted) return;
  speechQueue.push(s);
  if (audio.paused || audio.ended) playNext();
});
window.mai.onSpeechStop(stopSpeech);
audio.addEventListener("play", () => { speaking = true; refresh(); });
audio.addEventListener("ended", playNext);
audio.addEventListener("pause", () => { if (!audio.ended) { speaking = false; refresh(); } });

// ---------- input & toolbar ----------
$("say-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (live) { // Enter while the mic is on: send what's in the box now
    window.mai.liveStop("cancel");
    endLive();
  }
  const text = $("say").value.trim();
  if (!text) return;
  $("say").value = "";
  growInput();
  stopSpeech();
  // Sending a message always brings the conversation back into view.
  setPanel(null);
  addLog({ role: "me", text, ts: Date.now() });
  showBubble("…", { meta: `you: ${text.slice(0, 60)}` });
  await window.mai.send(text);
});
window.mai.onFocusInput(() => sayBox.focus());
// ---------- panels above her: speech bubble (default), chat history, planner ----------
function setPanel(name) {
  const talk = $("talk");
  talk.dataset.panel = talk.dataset.panel === name ? "" : name || "";
  if (talk.dataset.panel === "log") {
    const target = logLines || logEl;
    target.scrollTop = target.scrollHeight;
  }
  if (talk.dataset.panel === "planner") void renderPlanner();
}
$("btn-log").addEventListener("click", () => setPanel("log"));
$("btn-planner").addEventListener("click", () => setPanel("planner"));

// ---------- planner: his todos + the next 7 days of her calendar ----------
function dueChip(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const hasTime = /T\d/.test(iso);
  const time = hasTime ? " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const label = diff === 0 ? "today" : diff === 1 ? "tomorrow" : diff === -1 ? "yesterday" : d.toLocaleDateString([], { day: "numeric", month: "short" });
  const span = document.createElement("span");
  span.className = "chip" + ((hasTime ? d < new Date() : diff < 0) ? " overdue" : "");
  span.textContent = label + time;
  return span;
}
function xButton(title, onClick) {
  const b = document.createElement("button");
  b.className = "x"; b.type = "button"; b.title = title; b.textContent = "×";
  b.addEventListener("click", onClick);
  return b;
}
function emptyRow(text) {
  const li = document.createElement("li");
  li.className = "empty"; li.textContent = text;
  return li;
}
async function renderPlanner() {
  const { events, todos } = await window.mai.planner();
  const tl = $("todo-list");
  tl.replaceChildren();
  if (!todos.length) tl.append(emptyRow("Nothing yet. Add one, or tell her what you need to do."));
  for (const t of todos) {
    const li = document.createElement("li");
    li.className = t.done ? "done" : "";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = t.done; cb.title = t.done ? "Mark as not done" : "Done!";
    cb.addEventListener("change", () => window.mai.todoToggle(t.id, cb.checked));
    const title = document.createElement("span");
    title.className = "title"; title.textContent = t.title + (t.priority === "high" ? " ❗" : "");
    li.append(cb, title);
    if (t.due && !t.done) li.append(dueChip(t.due));
    if (t.createdBy === "mai") {
      const m = document.createElement("span");
      m.className = "by-mai"; m.title = "She added this"; m.textContent = "✦";
      li.append(m);
    }
    li.append(xButton("Delete", () => window.mai.todoRemove(t.id)));
    tl.append(li);
  }
  const el = $("event-list");
  el.replaceChildren();
  if (!events.length) el.append(emptyRow("Nothing scheduled."));
  let lastDay = "";
  for (const e of events) {
    const d = new Date(e.start);
    const day = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
    if (day !== lastDay) {
      const h = document.createElement("li");
      h.className = "day"; h.textContent = day;
      el.append(h);
      lastDay = day;
    }
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "chip"; time.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const title = document.createElement("span");
    title.className = "title"; title.textContent = e.title + (e.repeat ? ` (${e.repeat})` : "");
    li.append(time, title, xButton("Delete event", () => window.mai.eventRemove(e.id)));
    el.append(li);
  }
}
$("todo-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = $("todo-new");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  await window.mai.todoAdd(title);
});

// ---------- needs bars ("good when full": hunger and worry are shown inverted) ----------
const NEEDS = [
  { key: "hunger", icon: "🍙", invert: true, name: "Full", low: "hungry" },
  { key: "energy", icon: "⚡", name: "Energy", low: "sleepy" },
  { key: "social", icon: "💬", name: "Social", low: "lonely" },
  { key: "fun", icon: "🎲", name: "Fun", low: "bored" },
  { key: "worry", icon: "🌿", invert: true, name: "Calm", low: "worried about you" },
];
let lastNeeds = null;
function setNeeds(n) {
  lastNeeds = n;
  refresh();
  const box = $("needs");
  box.replaceChildren();
  for (const d of NEEDS) {
    const v = Math.round(d.invert ? 100 - n[d.key] : n[d.key]);
    const row = document.createElement("div");
    row.className = "need" + (v <= 25 ? " low" : "");
    row.title = `${d.name}: ${v}/100` + (v <= 25 ? ` (she is ${d.low})` : "");
    const icon = document.createElement("span");
    icon.textContent = d.icon;
    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = `${v}%`;
    bar.append(fill);
    row.append(icon, bar);
    box.append(row);
  }
}

// ---------- work mode: a long task he approved, with progress and a stop button ----------
let taskDoneTimer = null;
function setTask(t) {
  const bar = $("taskbar");
  clearTimeout(taskDoneTimer);
  if (!t) { bar.classList.add("hidden"); return; }
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const label = { running: "🛠 Working", done: "✅ Done", stopped: "⏹ Stopped", out_of_budget: "⌛ Out of time" }[t.status] || t.status;
  $("task-text").textContent = `${label}: ${t.goal} · ${t.done}/${t.total}${t.status === "running" && t.next ? ` · next: ${t.next}` : ""}`;
  $("task-progress").firstElementChild.style.width = `${pct}%`;
  $("btn-stop-task").hidden = t.status !== "running";
  bar.classList.toggle("finished", t.status !== "running");
  bar.classList.remove("hidden");
  // Finished tasks stay visible for a minute, then the bar goes away.
  if (t.status !== "running") taskDoneTimer = setTimeout(() => bar.classList.add("hidden"), 60000);
}
$("btn-stop-task").addEventListener("click", () => window.mai.stopTask());

// ---------- where she is: roaming on the desktop, or the full chat window ----------
function applyPose(p) {
  pose = p;
  const b = document.body.classList;
  b.toggle("mode-roam", p.mode === "roam");
  b.toggle("walking", p.behaviour === "walk");
  b.toggle("held", p.behaviour === "held");
  b.toggle("falling", p.behaviour === "fall");
  b.toggle("facing-right", p.facing === "right");
  refresh();
}
window.mai.onPose(applyPose);

function setLoading(on) {
  loading = on;
  if (on) {
    clearInterval(thinkTimer);
    activity.className = "tool";
    activityIcon.textContent = "🥱";
    activityText.textContent = "waking up…";
    badge.textContent = "💤";
    badge.classList.add("show");
  } else {
    hideActivity();
    badge.classList.toggle("show", !!MOOD_BADGE[mood]);
    badge.textContent = MOOD_BADGE[mood] || "";
  }
  refresh();
}


// ---------- input box: grows with the text; Enter sends, Shift+Enter is a new line ----------
const sayBox = $("say");
function growInput() {
  sayBox.style.height = "auto";
  sayBox.style.height = `${Math.min(sayBox.scrollHeight + 4, 140)}px`;
}
sayBox.addEventListener("input", growInput);
sayBox.addEventListener("keydown", (ev) => {
  // isComposing: don't send while a Vietnamese IME (Telex/VNI) is still composing a character.
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $("say-form").requestSubmit();
  }
});

// ---------- 🎙️ live voice typing (Vietnamese first, English second) ----------
// Click: listen. Words appear in the box while he talks and firm up; when he stops for a moment the message
// sends itself. Click again (or Enter) = send now, Esc = cancel, right-click = switch language.
// The mic is streamed as 16 kHz PCM to the main process, where Silero VAD + Qwen3-ASR (on her own voice
// server) do the work (src/core/livestt.ts). Chromium's SpeechRecognition can't be used: it needs Google's
// servers and fails in Electron with "network".
const btnMic = $("btn-mic");
let micLang = "vi-VN"; // Vietnamese first
let live = null; // { id, base, stream, ctx, heard }
const langLabel = () => (micLang === "vi-VN" ? "Tiếng Việt" : "English");

function updateMicUi(state) {
  if (!btnMic) return;
  btnMic.classList.toggle("listening", state === "listening");
  btnMic.classList.toggle("recording", state === "speech");
  btnMic.textContent = state ? "⏹️" : "🎙️";
  btnMic.title = state
    ? `Listening (${langLabel()})… it sends when you stop talking · click = send now · Esc = cancel`
    : `Voice typing (${langLabel()}) · right-click to switch language`;
  sayBox.placeholder = state === "listening" ? `Listening (${langLabel()})… just talk` : state === "speech" ? "…" : "Talk to her…";
  sayBox.classList.toggle("live", !!state);
}

/** What he typed before clicking the mic, plus what he's saying now. */
function showLiveText(text) {
  sayBox.value = live.base && text ? `${live.base} ${text}` : live.base || text;
  growInput();
  sayBox.scrollTop = sayBox.scrollHeight;
}

function stopMicAudio(l) {
  if (!l) return;
  if (l.stream) l.stream.getTracks().forEach((t) => t.stop());
  if (l.ctx) l.ctx.close().catch(() => {});
}

/** mode.fromEar: hands-free, the audio comes from the always-open "ear" mic (see "Mai ơi" below). */
async function startLive(mode = {}) {
  const l = { id: 0, base: mode.fromEar ? "" : sayBox.value.trim(), stream: null, ctx: null, heard: false, fromEar: !!mode.fromEar };
  live = l;
  updateMicUi("listening");
  try {
    // Start the listener first (it loads the VAD), so no audio is dropped.
    l.id = await window.mai.liveStart({ lang: micLang === "vi-VN" ? "vi" : "en", fromEar: l.fromEar, noSpeechMs: mode.noSpeechMs });
    if (live !== l) return window.mai.liveStop("cancel");
    if (l.fromEar) return;
    const savedId = localStorage.getItem("mai_mic_device_id") || "";
    const opts = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    l.stream = await navigator.mediaDevices.getUserMedia({ audio: savedId ? { ...opts, deviceId: { exact: savedId } } : opts });
    try {
      l.ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      l.ctx = new AudioContext(); // the worklet resamples
    }
    await l.ctx.audioWorklet.addModule("mic-worklet.js");
    const tap = new AudioWorkletNode(l.ctx, "mic-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
    tap.port.onmessage = (e) => { if (live === l) window.mai.liveAudio(new Uint8Array(e.data)); };
    l.ctx.createMediaStreamSource(l.stream).connect(tap);
    if (live !== l) stopMicAudio(l);
  } catch (err) {
    if (live === l) {
      live = null;
      stopMicAudio(l);
      updateMicUi(null);
      window.mai.liveStop("cancel");
      showBubble("🎙️ " + String(err.message || err).replace(/^.*Error: /, ""), { meta: "voice input" });
    }
  }
}

/** send = keep what he said (and send it); cancel = put the box back the way it was. */
function stopLive(how) {
  if (!live) return;
  if (how === "cancel") {
    sayBox.value = live.base;
    growInput();
    if (live.fromEar) endConversation();
  }
  window.mai.liveStop(how);
  if (how === "cancel" || !live.id) endLive();
}

function endLive() {
  const l = live;
  live = null;
  stopMicAudio(l);
  updateMicUi(null);
}

window.mai.onLive((ev) => {
  const l = live;
  if (!l || ev.id !== l.id) return;
  switch (ev.type) {
    case "speech":
      updateMicUi("speech");
      break;
    case "partial":
      l.heard = true;
      showLiveText(ev.text);
      break;
    case "final":
      showLiveText(ev.text);
      endLive();
      if (l.fromEar) onHandsFreeSent(ev.text);
      if (ev.autoSend) $("say-form").requestSubmit();
      else sayBox.focus();
      break;
    case "nospeech":
      sayBox.value = l.base;
      growInput();
      endLive();
      // Hands-free: silence just means the conversation is over; she goes back to waiting for "Mai ơi".
      if (l.fromEar) endConversation();
      else showBubble("🎙️ I didn't catch anything. Click the mic and talk; it sends when you stop.", { meta: "voice input" });
      break;
    case "error":
      sayBox.value = l.base;
      growInput();
      endLive();
      if (l.fromEar) endConversation();
      showBubble("🎙️ " + String(ev.message || "").replace(/^.*Error: /, ""), { meta: "voice input" });
      break;
    case "end":
      endLive();
      break;
  }
});

if (btnMic) {
  btnMic.addEventListener("click", () => (live ? stopLive("send") : startLive()));
  btnMic.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    micLang = micLang === "vi-VN" ? "en-US" : "vi-VN";
    updateMicUi(null);
    showBubble("Switched voice input to: " + (micLang === "vi-VN" ? "Tiếng Việt 🇻🇳" : "English 🇬🇧"), { meta: "language" });
  });
}
// Esc cancels; typing in the box takes over from the mic (keeping the words so far).
document.addEventListener("keydown", (ev) => {
  if (live && ev.key === "Escape") {
    ev.preventDefault();
    stopLive("cancel");
  }
});
sayBox.addEventListener("input", () => {
  if (!live) return;
  live.base = sayBox.value.trim();
  window.mai.liveStop("cancel");
  endLive();
});

// ---------- "Mai ơi": wake word + hands-free conversation ----------
// With Settings → Mic → wake word on (and his voice enrolled), one mic stays open and streams to the main
// process, where only a small local detector listens (src/core/wake.ts). "Mai ơi" → a chime, she listens, his
// sentence sends itself when he pauses. After she answers, the mic opens again for mic.followUpSec seconds
// so he can just keep talking. Silence (or "thôi / bye") ends the conversation. The ear is muted while she
// speaks, so she never hears herself.
let ear = null; // { stream, ctx }
let convo = null; // { awaitingReply, drained, ending }
let speechQuietUntil = 0;
let followUpSec = 8;

function earMuted() {
  return speaking || Date.now() < speechQuietUntil || (live && !live.fromEar);
}

async function startEar() {
  if (ear) return;
  const e = { stream: null, ctx: null };
  ear = e;
  try {
    const savedId = localStorage.getItem("mai_mic_device_id") || "";
    const opts = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    e.stream = await navigator.mediaDevices.getUserMedia({ audio: savedId ? { ...opts, deviceId: { exact: savedId } } : opts });
    try {
      e.ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      e.ctx = new AudioContext();
    }
    await e.ctx.audioWorklet.addModule("mic-worklet.js");
    const tap = new AudioWorkletNode(e.ctx, "mic-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
    tap.port.onmessage = (m) => { if (ear === e && !earMuted()) window.mai.wakeAudio(new Uint8Array(m.data)); };
    e.ctx.createMediaStreamSource(e.stream).connect(tap);
    btnMic?.classList.add("ear");
    if (btnMic) btnMic.title = "Say “Mai ơi” to talk to her hands-free · click to dictate · right-click: switch language";
  } catch (err) {
    if (ear === e) ear = null;
    stopMicAudio(e);
    showBubble("👂 Couldn't open the mic for “Mai ơi”: " + String(err.message || err), { meta: "wake word" });
  }
}

/** Two soft rising notes: she heard her name. */
function chime() {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    [[660, 0], [880, 0.11]].forEach(([f, at]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.18, t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t + at);
      o.stop(t + at + 0.18);
    });
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {}
}

function listenHandsFree(noSpeechMs) {
  if (live) return;
  clearInterval(thinkTimer);
  activity.className = "peek";
  activityIcon.textContent = "👂";
  activityText.textContent = noSpeechMs ? "listening…" : "dạ?";
  void startLive({ fromEar: true, noSpeechMs });
}

window.mai.onWake(() => {
  if (live) return; // already listening
  stopSpeech();
  chime();
  setPanel(null);
  convo = { awaitingReply: false, drained: false, ending: false };
  listenHandsFree();
});

const BYE = /^(thôi|thôi nhé|thôi nha|tạm biệt|bye|bai|ngủ đi|ngủ ngon|good ?night|that'?s all|okay bye|ok bye)[\s.!…]*$/i;
function onHandsFreeSent(text) {
  if (!convo) convo = { awaitingReply: false, drained: false, ending: false };
  convo.awaitingReply = true;
  convo.drained = false;
  convo.ending = BYE.test(text.trim()); // she still answers, but the mic doesn't reopen
}

function endConversation() {
  convo = null;
  hideActivity();
}

/** After her answer has been fully spoken, open the mic again for his next sentence. */
/** Her voice is queued, loading or playing ("play" fires a moment after play(), so check the element too). */
function voiceBusy() {
  return speaking || speechQueue.length > 0 || (!audio.paused && !audio.ended);
}
function maybeFollowUp() {
  if (!convo || !convo.awaitingReply || !convo.drained || voiceBusy() || live) return;
  convo.awaitingReply = false;
  if (convo.ending || !followUpSec) return endConversation();
  speechQuietUntil = Date.now() + 500; // let the room go quiet after her last word
  setTimeout(() => {
    if (!convo || live) return;
    if (voiceBusy()) { convo.awaitingReply = true; return; } // more of her voice arrived: wait for it to end
    listenHandsFree(followUpSec * 1000);
  }, 500);
}
window.mai.onSpeechDrained(() => {
  if (convo) convo.drained = true;
  maybeFollowUp();
});
audio.addEventListener("ended", () => { speechQuietUntil = Date.now() + 600; setTimeout(maybeFollowUp, 0); });

(async () => {
  try {
    const st = await window.mai.wakeStatus();
    const cfg = await window.mai.getConfig?.();
    if (cfg?.mic?.followUpSec != null) followUpSec = Math.max(0, Number(cfg.mic.followUpSec) || 0);
    if (st.ready) await startEar();
    else if (st.on && !st.enrolled) showBubble("👂 “Mai ơi” is on, but she hasn't learned your voice yet: Settings → Mic → Teach her “Mai ơi”.", { meta: "wake word" });
  } catch {}
})();

// ---------- click-through: empty, transparent parts of the window don't block the desktop ----------
let clickThrough = null;
let dragging = null;
function setClickThrough(on) {
  if (on === clickThrough) return;
  clickThrough = on;
  window.mai.setClickThrough(on);
}
document.addEventListener("mousemove", (ev) => {
  if (dragging) return;
  const solid = ev.target.closest && ev.target.closest("#bubble:not(.hidden), #talk[data-panel=log] #log, #talk[data-panel=planner] #planner, #taskbar:not(.hidden), #activity:not(.hidden), #avatar, #mood-badge, #needs, #controls");
  setClickThrough(!solid);
});
document.addEventListener("mouseleave", () => { if (!dragging) setClickThrough(true); });

// ---------- drag her around by the sprite (a click without moving opens the chat box) ----------
avatar.addEventListener("pointerdown", (ev) => {
  dragging = { x: ev.screenX, y: ev.screenY, moved: 0, grabbed: false };
  avatar.setPointerCapture(ev.pointerId);
  avatar.style.cursor = "grabbing";
});
avatar.addEventListener("pointermove", (ev) => {
  if (!dragging) return;
  const dx = ev.screenX - dragging.x, dy = ev.screenY - dragging.y;
  if (!dx && !dy) return;
  dragging.moved += Math.abs(dx) + Math.abs(dy);
  // Only count it as picking her up once the pointer really moves (a click shouldn't make her flail).
  if (!dragging.grabbed && dragging.moved >= 4) { dragging.grabbed = true; window.mai.grab(); }
  dragging.x = ev.screenX;
  dragging.y = ev.screenY;
  window.mai.moveBy(dx, dy);
});
avatar.addEventListener("pointerup", (ev) => {
  const wasClick = dragging && !dragging.grabbed;
  const wasGrabbed = dragging && dragging.grabbed;
  dragging = null;
  avatar.releasePointerCapture(ev.pointerId);
  avatar.style.cursor = "";
  if (wasGrabbed) window.mai.release();
  else if (wasClick && pose.mode === "roam") window.mai.setMode("chat");
  else if (wasClick) sayBox.focus();
});
$("btn-mute").addEventListener("click", async () => {
  muted = !muted;
  if (muted) stopSpeech();
  $("btn-mute").textContent = muted ? "🔇" : "🔊";
  await window.mai.setMuted(muted);
});
$("btn-wake").addEventListener("click", () => { playFlash(["poked", "surprised", "upset"], 900); window.mai.wake(); });
$("btn-settings").addEventListener("click", () => window.mai.openSettings());
$("btn-hide").addEventListener("click", () => window.mai.setMode("roam"));
$("btn-feed").addEventListener("click", () => { playFlash(["eat", "hi"], 2500); window.mai.feed(); });
bubble.addEventListener("click", () => scheduleHide(60000));
// Links open in his browser, never inside the pet window.
document.addEventListener("click", (ev) => {
  const a = ev.target.closest && ev.target.closest("a.md-link");
  if (!a) return;
  ev.preventDefault();
  window.mai.openLink(a.getAttribute("href"));
});

// ---------- clear chat / reset brain ----------
let clearConfirmTimer = null;
const btnClearChat = $("btn-clear-chat");
if (btnClearChat) {
  btnClearChat.addEventListener("click", async () => {
    if (btnClearChat.dataset.confirm === "yes") {
      clearTimeout(clearConfirmTimer);
      delete btnClearChat.dataset.confirm;
      btnClearChat.textContent = "Clearing…";
      btnClearChat.disabled = true;
      try {
        await window.mai.clearChat();
        const target = logLines || logEl;
        target.replaceChildren();
        const hint = document.createElement("div");
        hint.className = "log-empty-hint";
        hint.textContent = "Chat history cleared & brain reset.\nLong-term memories in MEMORY.md are kept safe.";
        target.appendChild(hint);
        showBubble("All clean! What are we working on now?", { meta: "brain reset" });
      } finally {
        btnClearChat.textContent = "🧹 Clean brain";
        btnClearChat.disabled = false;
      }
      return;
    }
    btnClearChat.dataset.confirm = "yes";
    btnClearChat.textContent = "Confirm reset?";
    clearConfirmTimer = setTimeout(() => {
      delete btnClearChat.dataset.confirm;
      btnClearChat.textContent = "🧹 Clean brain";
    }, 4000);
  });
}

window.mai.onChatCleared?.(() => {
  const target = logLines || logEl;
  target.replaceChildren();
  const hint = document.createElement("div");
  hint.className = "log-empty-hint";
  hint.textContent = "Chat history cleared & brain reset.\nLong-term memories in MEMORY.md are kept safe.";
  target.appendChild(hint);
});

// ---------- boot ----------
(async () => {
  const s = await window.mai.sprite();
  sprite = s.manifest;
  base = s.base;
  if (sprite.size) document.getElementById("body").style.height = `${sprite.size}px`;
  avatar.classList.toggle("smooth", sprite.pixelated === false);
  refresh();
  const hist = await window.mai.history();
  if (!hist.length) {
    const hint = document.createElement("div");
    hint.className = "log-empty-hint";
    hint.textContent = "No messages yet. Say hi!\n(You can also ask her to remember things into MEMORY.md)";
    (logLines || logEl).appendChild(hint);
  } else {
    for (const line of hist) addLog(line);
  }
  const st = await window.mai.status();
  setHearts(st.mood.affection);
  if (st.needs) setNeeds(st.needs);
  if (st.loading) setLoading(true);
  if (st.task) setTask(st.task);
  muted = st.muted;
  $("btn-mute").textContent = muted ? "🔇" : "🔊";
})();
