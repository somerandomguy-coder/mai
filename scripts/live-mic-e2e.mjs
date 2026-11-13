// End-to-end check of the 🎙️ button in the real pet window: Chromium's fake mic plays a WAV, the page's
// AudioWorklet streams it to the main process, Silero VAD + Qwen3-ASR transcribe it live, and the message
// must send itself after the pause. Prints what the chat box showed over time.
// Needs Mai's voice server running and a build: npm run build
// Usage: npx electron scripts/live-mic-e2e.mjs <speech.wav> <vi|en> ["expected text"]
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [wavIn, lang = "vi", expected = ""] = process.argv.slice(process.argv.findIndex((a) => a.endsWith("live-mic-e2e.mjs")) + 1);
const { loadConfig } = await import("../dist/core/config.js");
const { ensureDirs } = await import("../dist/core/paths.js");
const { LiveTranscriber } = await import("../dist/core/livestt.js");
const { transcribeAudio } = await import("../dist/core/stt.js");
ensureDirs();
const cfg = loadConfig();

/** Chromium's fake mic wants 16-bit PCM; add 1 s of silence before and 3 s after, and don't loop. */
function fakeMicFile(file) {
	const w = readFileSync(file);
	let p = 12, fmt = 1, bits = 16, rate = 16000, ch = 1, data;
	while (p + 8 <= w.length) {
		const id = w.toString("ascii", p, p + 4), sz = w.readUInt32LE(p + 4);
		if (id === "fmt ") { fmt = w.readUInt16LE(p + 8); ch = w.readUInt16LE(p + 10); rate = w.readUInt32LE(p + 12); bits = w.readUInt16LE(p + 22); }
		if (id === "data") { data = w.subarray(p + 8, p + 8 + sz); break; }
		p += 8 + sz + (sz & 1);
	}
	const frames = data.length / (bits / 8) / ch, lead = rate, tail = rate * 3;
	const out = Buffer.alloc(44 + (lead + frames + tail) * 2);
	out.write("RIFF", 0); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16);
	out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
	out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE((lead + frames + tail) * 2, 40);
	for (let i = 0; i < frames; i++) {
		let v = 0;
		for (let c = 0; c < ch; c++) v += fmt === 3 ? data.readFloatLE((i * ch + c) * 4) : data.readInt16LE((i * ch + c) * 2) / 32768;
		out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((v / ch) * 32767))), 44 + (lead + i) * 2);
	}
	const f = join(mkdtempSync(join(tmpdir(), "mai-mic-")), "mic.wav");
	writeFileSync(f, out);
	return { file: f, speechEndMs: ((lead + frames) / rate) * 1000 };
}
const mic = fakeMicFile(wavIn);
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", `${mic.file}%noloop`);
app.on("window-all-closed", () => {});

const words = (s) => s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
	const r = words(ref), h = words(hyp);
	let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
	for (let i = 1; i <= r.length; i++) {
		const cur = [i];
		for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[h.length] / Math.max(1, r.length);
}

app.whenReady().then(async () => {
	const win = new BrowserWindow({
		width: 400, height: 760, show: false,
		webPreferences: { preload: join(root, "scripts", "live-mic-e2e-preload.cjs"), contextIsolation: false, sandbox: false, backgroundThrottling: false },
	});
	// Same wiring as src/app/main.ts.
	let live, liveId = 0, t0 = 0;
	const log = [];
	ipcMain.handle("live-stt-start", async (_e, args) => {
		const id = ++liveId;
		const t = new LiveTranscriber((wav) => transcribeAudio(wav, cfg, { lang: args.lang }), (ev) => {
			log.push({ ms: Math.round(performance.now() - t0), ev: ev.type, text: ev.text ?? ev.message ?? ev.vad ?? "" });
			win.webContents.send("live-stt", { ...ev, id, ...(ev.type === "final" ? { autoSend: true } : {}) });
		}, { pauseMs: cfg.mic.pauseMs });
		live = t;
		await t.start();
		return id;
	});
	ipcMain.on("live-stt-audio", (_e, pcm) => live?.push(new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1)))));
	ipcMain.handle("live-stt-stop", (_e, how) => (how === "cancel" ? live?.cancel() : live?.finish()));
	const sent = new Promise((resolve) => ipcMain.handle("chat", (_e, text) => resolve({ text, ms: Math.round(performance.now() - t0) })));

	await win.loadFile(join(root, "src", "app", "renderer", "pet.html"));
	await new Promise((r) => setTimeout(r, 800));
	await win.webContents.executeJavaScript(`__demo.pose({mode:"chat",behaviour:"idle",facing:"left"}); ${lang === "en" ? `document.getElementById("btn-mic").dispatchEvent(new MouseEvent("contextmenu"));` : ""} document.getElementById("btn-mic").click()`, true);
	t0 = performance.now();
	// Watch the chat box like he would.
	const box = [];
	const poll = setInterval(async () => {
		const v = await win.webContents.executeJavaScript(`document.getElementById("say").value`).catch(() => "");
		if (v && v !== box.at(-1)?.text) box.push({ ms: Math.round(performance.now() - t0), text: v });
	}, 100);
	const timeout = new Promise((r) => setTimeout(() => r(null), mic.speechEndMs + 30_000));
	const result = await Promise.race([sent, timeout]);
	clearInterval(poll);
	console.log(`speech ends at ~${Math.round(mic.speechEndMs)} ms after the click (1 s lead-in)`);
	for (const l of log) console.log(`  ${String(l.ms).padStart(6)} ms  ${l.ev}${l.text ? `: ${l.text}` : ""}`);
	console.log("chat box over time:");
	for (const b of box) console.log(`  ${String(b.ms).padStart(6)} ms  ${b.text}`);
	if (!result) {
		console.log("✗ nothing was sent");
		app.exit(1);
		return;
	}
	console.log(`sent at ${result.ms} ms (${result.ms - Math.round(mic.speechEndMs)} ms after speech ended): ${result.text}`);
	if (expected) console.log(`error rate vs expected: ${(wer(expected, result.text) * 100).toFixed(1)}%`);
	const firstWords = box[0]?.ms;
	console.log(`first words in the box: ${firstWords} ms after the click`);
	app.exit(box.length >= 2 ? 0 : 1);
});
