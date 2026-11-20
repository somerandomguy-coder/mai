// "Mai ơi" detector check on a folder of recordings, per speaker:
//   <dir>/<speaker>/enroll_*.wav  takes of "Mai ơi" used to enroll
//   <dir>/<speaker>/cal_*.wav     ordinary speech used to set the threshold
//   <dir>/<speaker>/pos_*.wav     held-out clips that contain "Mai ơi" (alone or starting a sentence)
//   <dir>/<speaker>/neg_*.wav     clips that must NOT wake her (ngày mai, trời ơi, anh ơi…)
//   <dir>/mai_herself/neg_*.wav   Mai's own voice
// 16 kHz mono wav. Usage: npx tsx scripts/wake-test.ts <dir> [--asr]   (--asr: double-check hits with Qwen3-ASR,
// needs Mai's voice server)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.js";
import { pcmToWav } from "../src/core/livestt.js";
import { transcribeAudio } from "../src/core/stt.js";
import { bestScore, embedRecording, enroll, heardWakePhrase, stripWakePhrase, WakeListener } from "../src/core/wake.js";

// pure checks first
const ok = (c: boolean, m: string) => {
	if (!c) throw new Error(`FAIL: ${m}`);
};
// How Qwen3-ASR actually wrote "Mai ơi" in our tests, and what it wrote for look-alikes.
for (const s of ["Mai ơi", "mai ơi, mấy giờ rồi", "Ê Mai ơi!", "Mãi ơi", "Mày ơi.", "may ơi em đang làm gì", "AI ơi.", "Em ai ơi", "mai ổi", "Mái ửi, mày dơ đó.", "MAI OI"])
	ok(heardWakePhrase(s), `should hear: ${s}`);
for (const s of ["Ngày mai anh đi", "trời ơi", "Chờ ơi, mệt quá", "anh ơi chờ em với", "mai một rảnh thì đi", "Mãi á, em ngủ chưa", "hai ơi lấy dùng kệ áo", "mãi mới xong", "mai rồi", "mày dơ rồi nhỉ"])
	ok(!heardWakePhrase(s), `should not hear: ${s}`);
ok(stripWakePhrase("Mai ơi, mấy giờ rồi?") === "mấy giờ rồi?", "strip");
ok(stripWakePhrase("mấy giờ rồi") === "mấy giờ rồi", "strip none");
console.log("phrase checks passed");

const dir = process.argv[2];
if (!dir) process.exit(0);
const useAsr = process.argv.includes("--asr");
const cfg = loadConfig();

function readWav(p: string): Float32Array {
	const b = readFileSync(p);
	let off = 12;
	while (off < b.length) {
		const id = b.toString("ascii", off, off + 4);
		const size = b.readUInt32LE(off + 4);
		if (id === "data") {
			const fmtBits = 16; // soundfile writes PCM_16 by default
			if (fmtBits !== 16) throw new Error("16-bit only");
			const n = size / 2;
			const out = new Float32Array(n);
			for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
			return out;
		}
		off += 8 + size + (size % 2);
	}
	throw new Error(`no data chunk in ${p}`);
}
const files = (d: string, prefix: string) =>
	readdirSync(d)
		.filter((f) => f.startsWith(prefix) && f.endsWith(".wav"))
		.sort()
		.map((f) => join(d, f));
const toWav = (f: Float32Array) => pcmToWav(Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)))));

const speakers = readdirSync(dir).filter((d) => d !== "mai_herself");
const totals = { pos: 0, posHit: 0, posConfirmed: 0, neg: 0, negHit: 0, negConfirmed: 0 };
for (const sp of speakers) {
	const d = join(dir, sp);
	const model = await enroll(files(d, "enroll_").map(readWav), files(d, "cal_").map(readWav));
	console.log(`\n== ${sp}: threshold ${model.threshold} (takes vs each other ${model.calibration.positives.join(" ")}, best non-wake ${model.calibration.negativeMax})`);
	const others = speakers.filter((s) => s !== sp).flatMap((s) => files(join(dir, s), "neg_").slice(0, 3));
	const cases: Array<[string, boolean]> = [
		...files(d, "pos_").map((f) => [f, true] as [string, boolean]),
		...files(d, "neg_").map((f) => [f, false] as [string, boolean]),
		...others.map((f) => [f, false] as [string, boolean]),
		...files(join(dir, "mai_herself"), "neg_").map((f) => [f, false] as [string, boolean]),
	];
	for (const [f, wake] of cases) {
		const audio = readWav(f);
		const score = bestScore(model.templates, (await embedRecording(audio)).map((e) => e.v));
		const hit = score >= model.threshold;
		let heard = "";
		let confirmed = hit;
		if (hit && useAsr) {
			heard = await transcribeAudio(toWav(audio.slice(0, 16000 * 2.5)), cfg, { lang: "vi" });
			confirmed = heardWakePhrase(heard);
		}
		const t = wake ? "pos" : "neg";
		totals[t]++;
		if (hit) totals[`${t}Hit`]++;
		if (confirmed) totals[`${t}Confirmed`]++;
		const verdict = wake ? (confirmed ? "ok (woke)" : hit ? "MISSED (asr said no)" : "MISSED") : confirmed ? "FALSE WAKE" : hit ? "ok (asr said no)" : "ok";
		console.log(`${score.toFixed(3)} ${verdict.padEnd(20)} ${f.split(/[\\/]/).slice(-2).join("/")}${heard ? `  heard: ${heard}` : ""}`);
	}
}
console.log(`\nwake word: ${totals.posHit}/${totals.pos} "Mai ơi" clips matched, ${totals.posConfirmed} woke her${useAsr ? " after the ASR check" : ""}`);
console.log(`           ${totals.negHit}/${totals.neg} other clips matched, ${totals.negConfirmed} woke her`);

// Streaming, like the app: one long recording fed in 100 ms chunks to the real WakeListener (with the ASR check
// if --asr). The first speaker's look-alikes, other people, Mai herself, and two real wakes.
{
	const sp = speakers[0];
	const d = join(dir, sp);
	const model = await enroll(files(d, "enroll_").map(readWav), files(d, "cal_").map(readWav));
	const gap = (s: number) => new Float32Array(Math.round(16000 * s));
	const parts: Array<{ audio: Float32Array; label: string; wake: boolean }> = [];
	const add = (f: string, wake: boolean) => parts.push({ audio: readWav(f), label: f.split(/[\\/]/).slice(-2).join("/"), wake });
	parts.push({ audio: gap(2), label: "silence", wake: false });
	for (const f of files(d, "neg_")) add(f, false);
	add(join(d, "pos_2.wav"), true); // "Mai ơi, mấy giờ rồi?"
	for (const s of speakers.slice(1)) add(files(join(dir, s), "neg_")[1], false);
	for (const f of files(join(dir, "mai_herself"), "neg_")) add(f, false);
	add(join(d, "pos_0.wav"), true); // "Mai ơi."
	const stream: Float32Array[] = [];
	const spans: Array<{ from: number; to: number; label: string; wake: boolean }> = [];
	let at = 0;
	for (const p of parts) {
		spans.push({ from: at, to: at + p.audio.length, label: p.label, wake: p.wake });
		stream.push(p.audio, gap(1.2));
		at += p.audio.length + 16000 * 1.2;
	}
	const all = new Float32Array(at);
	let o = 0;
	for (const s of stream) {
		all.set(s, o);
		o += s.length;
	}
	const hits: Array<{ endSample: number; heard: string; seed: number }> = [];
	let listener: WakeListener;
	listener = new WakeListener(
		model,
		(h) => hits.push({ endSample: h.endSample, heard: h.heard, seed: listener.audioSince(h.endSample).length }),
		useAsr ? (f) => transcribeAudio(toWav(f), cfg, { lang: "vi" }) : undefined,
	);
	const t0 = performance.now();
	for (let i = 0; i < all.length; i += 1600) {
		listener.push(Int16Array.from(all.subarray(i, i + 1600), (v) => Math.round(v * 32767)));
		await new Promise((r) => setImmediate(r));
	}
	await (listener as any).chain;
	await new Promise((r) => setTimeout(r, useAsr ? 4000 : 100));
	const cpu = performance.now() - t0;
	console.log(`\n== streaming (${sp}, ${(all.length / 16000).toFixed(0)} s of audio, processed in ${(cpu / 1000).toFixed(1)} s incl. ASR checks)`);
	for (const h of hits) {
		const span = spans.find((s) => h.endSample >= s.from && h.endSample <= s.to + 16000 * 1.2);
		console.log(`  woke at ${(h.endSample / 16000).toFixed(1)} s during ${span?.label ?? "?"} (${span?.wake ? "right" : "WRONG"})${h.heard ? `, heard "${h.heard}"` : ""}`);
	}
	const wanted = spans.filter((s) => s.wake).length;
	const right = new Set(hits.map((h) => spans.find((s) => s.wake && h.endSample >= s.from && h.endSample <= s.to + 16000 * 1.2)?.label).filter(Boolean)).size;
	console.log(`  ${right}/${wanted} wakes, ${hits.length - hits.filter((h) => spans.some((s) => s.wake && h.endSample >= s.from && h.endSample <= s.to + 16000 * 1.2)).length} wrong wakes`);
}
