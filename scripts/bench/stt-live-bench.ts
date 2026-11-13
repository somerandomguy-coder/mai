// Live speech recognition bench: accuracy and latency of the ways Mai can show words while you talk.
// Plays each clip in real time against Mai's voice server (audio.cpp + Qwen3-ASR) and scores the text.
//
// Usage: npx tsx scripts/bench/stt-live-bench.ts <clips folder> [mode ...] [--server http://127.0.0.1:8080]
//   <clips folder>: pairs of name.wav (any PCM/float WAV) + name.txt (what was said). Name them vi-* / en-*.
//   modes: offline        one request after the clip ends (the old mic)
//          live:<model>   POST /v1/audio/transcriptions/live (model configured with mode=streaming)
//          regrow:<ms>    re-send the growing clip every <ms> while "speaking", then one final pass
//          mai            what the 🎙️ button does (src/core/livestt.ts: Silero VAD + regrow + auto-send);
//                         times are from the first/last voiced sample of the clip
// Results table: docs/BENCHMARKS.md.
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { LiveTranscriber } from "../../src/core/livestt.js";
import { ASR_MODEL_ID } from "../../src/core/sidecars.js";
import { transcribeAudio } from "../../src/core/stt.js";

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) throw new Error("usage: stt-live-bench.ts <clips folder> [modes]");
const si = args.indexOf("--server");
const server = (si >= 0 ? args[si + 1] : "http://127.0.0.1:8080").replace(/\/$/, "");
const modes = args.slice(1).filter((a, i, all) => a !== "--server" && all[i - 1] !== "--server");
if (!modes.length) modes.push("offline");
const RATE = 16000;

/** Any 16-bit PCM or 32-bit float WAV → 16 kHz mono 16-bit samples. */
function readPcm16k(file: string): Int16Array {
	const w = readFileSync(file);
	let p = 12, fmt = 1, bits = 16, rate = RATE, ch = 1;
	let data = Buffer.alloc(0);
	while (p + 8 <= w.length) {
		const id = w.toString("ascii", p, p + 4), sz = w.readUInt32LE(p + 4);
		if (id === "fmt ") { fmt = w.readUInt16LE(p + 8); ch = w.readUInt16LE(p + 10); rate = w.readUInt32LE(p + 12); bits = w.readUInt16LE(p + 22); }
		if (id === "data") { data = w.subarray(p + 8, p + 8 + sz); break; }
		p += 8 + sz + (sz & 1);
	}
	const frames = Math.floor(data.length / (bits / 8) / ch);
	const outN = Math.floor((frames * RATE) / rate);
	const out = new Int16Array(outN);
	for (let i = 0; i < outN; i++) {
		const f = Math.min(frames - 1, Math.floor((i * rate) / RATE));
		let v = 0;
		for (let c = 0; c < ch; c++) v += fmt === 3 ? data.readFloatLE((f * ch + c) * 4) : data.readInt16LE((f * ch + c) * 2) / 32768;
		out[i] = Math.max(-32768, Math.min(32767, Math.round((v / ch) * 32767)));
	}
	return out;
}

function wav(samples: Int16Array): Buffer {
	const b = Buffer.alloc(44 + samples.length * 2);
	b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVEfmt ", 8);
	b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24);
	b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
	Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(b, 44);
	return b;
}

const words = (s: string) => s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
/** Word error rate (Vietnamese words are syllables, so this is the syllable error rate there). */
function wer(ref: string, hyp: string): number {
	const r = words(ref), h = words(hyp);
	let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
	for (let i = 1; i <= r.length; i++) {
		const cur = [i];
		for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[h.length] / Math.max(1, r.length);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const langName = (name: string) => (name.startsWith("vi") ? "Vietnamese" : "English");

async function offline(samples: Int16Array, lang: string): Promise<string> {
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(wav(samples))], { type: "audio/wav" }), "a.wav");
	form.append("model", ASR_MODEL_ID);
	form.append("language", lang);
	const res = await fetch(`${server}/v1/audio/transcriptions`, { method: "POST", body: form });
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
	return ((await res.json()) as { text: string }).text.trim();
}

interface Run { text: string; firstMs: number; finalMs: number; updates: number[] }

/** The old mic: wait for the whole clip, then one request. */
async function runOffline(s: Int16Array, lang: string): Promise<Run> {
	await sleep((s.length / RATE) * 1000);
	const t = performance.now();
	const text = await offline(s, lang);
	const ms = performance.now() - t;
	return { text, firstMs: (s.length / RATE) * 1000 + ms, finalMs: ms, updates: [] };
}

/** Re-send the clip so far every `period` ms while it plays (one request at a time), then a final pass. */
async function runRegrow(s: Int16Array, lang: string, period: number): Promise<Run> {
	const t0 = performance.now();
	const durMs = (s.length / RATE) * 1000;
	const updates: number[] = [];
	let first = 0;
	while (performance.now() - t0 < durMs) {
		const startedAt = performance.now();
		const upto = Math.min(s.length, Math.floor(((startedAt - t0) / 1000) * RATE));
		if (upto > RATE * 0.5) {
			const text = await offline(s.subarray(0, upto), lang);
			if (text && !first) first = performance.now() - t0;
			updates.push(performance.now() - t0);
		}
		const wait = period - (performance.now() - startedAt);
		if (wait > 0) await sleep(wait);
	}
	const left = durMs - (performance.now() - t0);
	if (left > 0) await sleep(left);
	const t = performance.now();
	const text = await offline(s, lang);
	return { text, firstMs: first, finalMs: performance.now() - t, updates };
}

/** Native streaming: raw PCM in a chunked body, transcript deltas back as SSE. */
function runLive(s: Int16Array, lang: string, model: string): Promise<Run> {
	return new Promise((resolve, reject) => {
		const u = new URL(`${server}/v1/audio/transcriptions/live?model=${encodeURIComponent(model)}&sample_rate=${RATE}&channels=1&format=s16le&language=${lang}`);
		const t0 = performance.now();
		let uploadDone = 0, first = 0, text = "";
		const updates: number[] = [];
		const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" } });
		req.on("response", (res) => {
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (d: string) => {
				buf += d.replace(/\r\n/g, "\n");
				let i;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const data = buf.slice(0, i).replace(/^data: ?/gm, "");
					buf = buf.slice(i + 2);
					if (data === "[DONE]") continue;
					const ev = JSON.parse(data) as { type: string; delta?: string; text?: string; error?: { message: string } };
					if (ev.type === "error") reject(new Error(ev.error?.message));
					if (ev.type === "transcript.text.delta" && ev.delta?.trim()) {
						if (!first) first = performance.now() - t0;
						updates.push(performance.now() - t0);
					}
					if (ev.type === "transcript.text.done") text = (ev.text ?? "").trim();
				}
			});
			res.on("end", () => resolve({ text, firstMs: first, finalMs: performance.now() - t0 - uploadDone, updates }));
		});
		req.on("error", reject);
		void (async () => {
			const step = RATE / 10; // 100 ms, like the mic
			for (let o = 0; o < s.length; o += step) {
				const c = s.subarray(o, o + step);
				req.write(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
				await sleep(100);
			}
			uploadDone = performance.now() - t0;
			req.end();
		})();
	});
}

/** First and last 20 ms frame louder than 5% of the clip's loudest frame. */
function voicedSpan(s: Int16Array): [number, number] {
	const f = RATE / 50, rms: number[] = [];
	for (let o = 0; o + f <= s.length; o += f) {
		let sum = 0;
		for (let i = o; i < o + f; i++) sum += s[i] * s[i];
		rms.push(Math.sqrt(sum / f));
	}
	const max = Math.max(...rms);
	return [rms.findIndex((r) => r > max * 0.05) * f, (rms.findLastIndex((r) => r > max * 0.05) + 1) * f];
}

/** The 🎙️ button: 1 s of silence, the clip, 3 s of silence, in 100 ms chunks at real time. */
async function runMai(s: Int16Array, lang: string): Promise<Run> {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.tts.vieneu.serverUrl = server;
	const lead = RATE;
	const audio = new Int16Array(lead + s.length + RATE * 3);
	audio.set(s, lead);
	const [v0, v1] = voicedSpan(s).map((x) => ((lead + x) / RATE) * 1000);
	const updates: number[] = [];
	let final = "", finalAt = 0, t0 = 0;
	const done = new Promise<void>((resolve) => {
		const live = new LiveTranscriber(
			(wav) => transcribeAudio(wav, cfg, { lang: lang === "Vietnamese" ? "vi" : "en" }),
			(e) => {
				const t = performance.now() - t0;
				if (e.type === "partial") updates.push(t);
				if (e.type === "final") (final = e.text), (finalAt = t);
				if (e.type === "error") console.log("   error:", e.message);
				if (e.type === "end") resolve();
			},
		);
		void live.start().then(async () => {
			t0 = performance.now();
			for (let o = 0; o < audio.length && live.active; o += RATE / 10) {
				live.push(audio.subarray(o, o + RATE / 10));
				const next = ((o + RATE / 10) / RATE) * 1000 - (performance.now() - t0);
				if (next > 0) await sleep(next);
			}
			live.finish();
		});
	});
	await done;
	return { text: final, firstMs: (updates[0] ?? finalAt) - v0, finalMs: finalAt - v1, updates };
}

const clips = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();
// Warm the model so the first clip doesn't pay the load.
await offline(readPcm16k(join(dir, clips[0])).subarray(0, RATE * 2), "English").catch(() => {});

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
for (const mode of modes) {
	console.log(`\n=== ${mode} (${server})`);
	const per: Record<string, { wer: number[]; first: number[]; final: number[]; gap: number[] }> = {};
	for (const f of clips) {
		const name = f.replace(/\.wav$/, "");
		const ref = readFileSync(join(dir, `${name}.txt`), "utf8").trim();
		const s = readPcm16k(join(dir, f));
		const lang = langName(name);
		const [kind, arg] = mode.split(":");
		const run =
			kind === "live" ? await runLive(s, lang, arg) : kind === "regrow" ? await runRegrow(s, lang, Number(arg)) : kind === "mai" ? await runMai(s, lang) : await runOffline(s, lang);
		const e = wer(ref, run.text);
		const gaps = run.updates.slice(1).map((t, i) => t - run.updates[i]);
		const k = name.slice(0, 2);
		per[k] ??= { wer: [], first: [], final: [], gap: [] };
		per[k].wer.push(e);
		per[k].first.push(run.firstMs);
		per[k].final.push(run.finalMs);
		if (gaps.length) per[k].gap.push(avg(gaps));
		console.log(`${name} ${(s.length / RATE).toFixed(1)}s  err ${(e * 100).toFixed(1)}%  first words ${Math.round(run.firstMs)} ms  final ${Math.round(run.finalMs)} ms after the end  updates ${run.updates.length}\n   ref: ${ref}\n   got: ${run.text}`);
	}
	for (const [k, v] of Object.entries(per)) {
		console.log(`SUMMARY ${mode} ${k}: err ${(avg(v.wer) * 100).toFixed(1)}%  first words ${Math.round(avg(v.first))} ms  final ${Math.round(avg(v.final))} ms  update every ${Math.round(avg(v.gap))} ms`);
	}
}
