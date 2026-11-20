// End-to-end check of "Mai ơi" + hands-free conversation in the real pet window, with the app's own mic wiring
// (src/app/voicein.ts). Chromium's fake mic plays: silence, "Mai ơi, <question>", then silence.
// Expected: she wakes (chime), the question (without "Mai ơi") sends itself, she "answers" (a fake reply with a
// short tone as her voice), the mic opens again for the follow-up window, and silence ends the conversation.
// Needs Mai's voice server (speech recognition) and a build: npm run build
// Usage: npx electron scripts/wake-e2e.mjs <enroll dir with enroll_*.wav + cal_*.wav> <question.wav>
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("wake-e2e.mjs")) + 1);
const [enrollDir, questionWav] = args;
if (!enrollDir || !questionWav) throw new Error("usage: npx electron scripts/wake-e2e.mjs <enroll dir> <question.wav>");
const userCfg = (await import("../dist/core/config.js")).loadConfig(); // his voice server URL, before switching homes
process.env.MAI_HOME = mkdtempSync(join(tmpdir(), "mai-wake-"));
const { ensureDirs, paths } = await import("../dist/core/paths.js");
const { enroll } = await import("../dist/core/wake.js");
const { pcmToWav } = await import("../dist/core/livestt.js");
const { wireVoiceInput } = await import("../dist/app/voicein.js");
ensureDirs();

function readWav(p) {
	const b = readFileSync(p);
	let off = 12;
	while (off < b.length) {
		const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
		if (id === "data") return Float32Array.from({ length: size / 2 }, (_, i) => b.readInt16LE(off + 8 + i * 2) / 32768);
		off += 8 + size + (size % 2);
	}
	throw new Error(`no data in ${p}`);
}
const list = (prefix) => readdirSync(enrollDir).filter((f) => f.startsWith(prefix) && f.endsWith(".wav")).sort().map((f) => join(enrollDir, f));
const model = await enroll(list("enroll_").map(readWav), list("cal_").map(readWav));
writeFileSync(join(paths.wake, "wake.json"), JSON.stringify(model));
const cfg = { ...userCfg, mic: { ...userCfg.mic, wakeWord: true, followUpSec: 5, autoSend: true } };

// The fake mic: 1.5 s silence, the question, 14 s silence (covers her reply and the follow-up window).
const q = readWav(questionWav);
const total = new Float32Array(Math.round(16000 * 1.5) + q.length + 16000 * 14);
total.set(q, Math.round(16000 * 1.5));
const micFile = join(process.env.MAI_HOME, "mic.wav");
writeFileSync(micFile, pcmToWav(Int16Array.from(total, (v) => Math.round(v * 32767))));
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", `${micFile}%noloop`);
app.on("window-all-closed", () => {});

/** Her "voice": a 1.2 s tone, as the TTS would send it. */
function toneWav() {
	const n = 16000 * 1.2;
	return pcmToWav(Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin((i / 16000) * 2 * Math.PI * 440) * 6000 * Math.min(1, (n - i) / 800))));
}

app.whenReady().then(async () => {
	const t0 = performance.now();
	const ms = () => Math.round(performance.now() - t0);
	const log = (m) => console.log(`${String(ms()).padStart(6)} ms  ${m}`);
	const win = new BrowserWindow({
		width: 400, height: 760, show: false,
		webPreferences: { preload: join(root, "scripts", "wake-e2e-preload.cjs"), contextIsolation: false, sandbox: false, backgroundThrottling: false },
	});
	win.webContents.on("console-message", (e) => log(`page: ${e.message ?? e}`));
	const send = (ch, payload) => win.webContents.send(ch, payload);
	let wakes = 0;
	wireVoiceInput({ cfg: () => cfg, send: (ch, p) => { if (ch === "live-stt") log(`live ${p.type}${p.text ? `: ${p.text}` : ""}`); send(ch, p); }, stopSpeech: () => send("speech-stop"), onWake: () => { wakes++; log("WAKE"); } });
	ipcMain.handle("get-config", () => cfg);
	const sent = [];
	ipcMain.handle("chat", async (_e, text) => {
		sent.push(text);
		log(`SENT: ${text}`);
		// her turn: think, answer, speak, done
		send("brain-event", { type: "state", state: "thinking" });
		await new Promise((r) => setTimeout(r, 600));
		send("brain-event", { type: "say", text: "Bây giờ là 9 giờ tối rồi đó anh.", mood: "neutral", proactive: false });
		send("speech", { audio: toneWav().toString("base64"), mime: "audio/wav", text: "…" });
		send("brain-event", { type: "state", state: "idle" });
		send("speech-drained");
		log("her answer sent (1.2 s of voice)");
	});

	await win.loadFile(join(root, "src", "app", "renderer", "pet.html"));
	await win.webContents.executeJavaScript(`__demo.pose({mode:"chat",behaviour:"idle",facing:"left"})`);
	// Watch the pet's state like he would see it.
	let last = "";
	const states = [];
	const poll = setInterval(async () => {
		const s = await win.webContents
			.executeJavaScript(`JSON.stringify({ convo: !!convo, live: live ? (live.fromEar ? "ear" : "mic") : null, speaking, bubble: document.getElementById("activity").classList.contains("hidden") ? "" : document.getElementById("activity-text").textContent, ear: !!ear, said: document.getElementById("bubble-text").textContent.slice(0, 160) })`)
			.catch(() => "");
		if (s && s !== last) {
			last = s;
			states.push(s);
			log(`pet ${s}`);
		}
	}, 150);
	await new Promise((r) => setTimeout(r, 1500 + (q.length / 16000) * 1000 + 13_000));
	clearInterval(poll);
	const followUps = states.filter((s) => s.includes('"live":"ear"')).length;
	const ended = JSON.parse(last || "{}");
	console.log("\nresult:");
	console.log(`  woke: ${wakes}`);
	console.log(`  sent: ${JSON.stringify(sent)}`);
	console.log(`  listened from the ear: ${followUps > 0}; conversation over at the end: ${!ended.convo}; ear still open: ${ended.ear}`);
	const ok = wakes === 1 && sent.length === 1 && !/mai ơi/i.test(sent[0]) && !ended.convo && ended.ear;
	console.log(ok ? "wake e2e: passed" : "wake e2e: FAILED");
	app.exit(ok ? 0 : 1);
});
