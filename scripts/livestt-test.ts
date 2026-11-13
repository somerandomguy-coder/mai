// Live voice typing state machine (src/core/livestt.ts) with the real Silero VAD and a fake recognizer:
// partials while talking, one auto-send after the pause, short pauses don't split a message, noise and
// silence don't trigger it, stop/cancel work. Speech comes from Windows' built-in offline voice (SAPI).
// Usage: npx tsx scripts/livestt-test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LiveEvent, type LiveOptions, LiveTranscriber } from "../src/core/livestt.js";
import { VAD_MODEL } from "../src/core/vad.js";

const RATE = 16000;
assert.ok(existsSync(VAD_MODEL), `Silero VAD missing at ${VAD_MODEL}: run setup.cmd`);
const tmp = mkdtempSync(join(tmpdir(), "mai-livestt-"));

/** Offline English speech from Windows' SAPI voice, 16 kHz mono. */
function say(text: string): Int16Array {
	const out = join(tmp, `say-${Math.random().toString(36).slice(2)}.wav`);
	const ps1 = join(tmp, "say.ps1");
	writeFileSync(
		ps1,
		[
			"param([string]$Text, [string]$Out)",
			"Add-Type -AssemblyName System.Speech",
			"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
			"$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
			"$s.SetOutputToWaveFile($Out, $f)",
			"$s.Speak($Text)",
			"$s.Dispose()",
		].join("\r\n"),
	);
	execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Text", text, "-Out", out], { windowsHide: true });
	const w = readFileSync(out);
	const p = w.indexOf("data");
	const pcm = w.subarray(p + 8, p + 8 + w.readUInt32LE(p + 4));
	const a = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
	// SAPI pads clips with silence; trim it so the pauses in each scenario are exactly what they say.
	const loud = (v: number) => Math.abs(v) > 500;
	return a.slice(Math.max(0, a.findIndex(loud) - RATE / 20), a.findLastIndex(loud) + RATE / 20);
}

const silence = (sec: number) => new Int16Array(Math.round(sec * RATE));
/** Fan-like (white) or rumble-like (brown) noise at an RMS level in dBFS. */
function noise(sec: number, db: number, kind: "white" | "brown"): Int16Array {
	const n = Math.round(sec * RATE), out = new Int16Array(n);
	const amp = 32767 * 10 ** (db / 20) * Math.sqrt(3);
	let b = 0;
	for (let i = 0; i < n; i++) {
		const w = Math.random() * 2 - 1;
		b = kind === "brown" ? Math.max(-1, Math.min(1, b * 0.98 + w * 0.2)) : w;
		out[i] = Math.round(b * amp * (kind === "brown" ? 2 : 1));
	}
	return out;
}
const join2 = (...parts: Int16Array[]) => {
	const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) (out.set(p, o), (o += p.length));
	return out;
};
const mix = (a: Int16Array, b: Int16Array) => a.map((v, i) => Math.max(-32768, Math.min(32767, v + (b[i % b.length] ?? 0))));

interface Result { events: LiveEvent[]; passes: number[]; finalText?: string }

/**
 * Feeds audio in 100 ms chunks (as the pet window does) and lets each transcription finish before the next
 * chunk. The fake recognizer answers with how many seconds it heard, so the test can check coverage.
 */
async function run(audio: Int16Array, opts: Partial<LiveOptions> = {}, control?: (t: number, live: LiveTranscriber) => void, lagChunks = 0): Promise<Result> {
	const events: LiveEvent[] = [];
	const passes: number[] = [];
	// lagChunks > 0: each transcription answers only after that many more 100 ms chunks (a slow CPU).
	const waiting: Array<{ left: number; done: () => void }> = [];
	const live = new LiveTranscriber(
		async (wav) => {
			const sec = (wav.length - 44) / 2 / RATE;
			passes.push(sec);
			if (lagChunks) await new Promise<void>((done) => waiting.push({ left: lagChunks, done }));
			return `heard ${sec.toFixed(1)}s`;
		},
		(e) => events.push(e),
		opts,
	);
	await live.start();
	const tick = () => new Promise((r) => setImmediate(r));
	for (let o = 0; o < audio.length && live.active; o += RATE / 10) {
		live.push(audio.subarray(o, o + RATE / 10));
		for (const w of waiting.splice(0)) if (--w.left > 0) waiting.push(w); else w.done();
		for (let i = 0; i < 20; i++) await tick();
		control?.(o / RATE, live);
	}
	for (let i = 0; i < 50 && live.active; i++) await tick();
	const final = events.find((e) => e.type === "final");
	return { events, passes, finalText: final?.type === "final" ? final.text : undefined };
}
const types = (r: Result) => r.events.map((e) => e.type).filter((t) => t !== "partial");
let ok = 0;
const pass = (name: string, r: Result) => {
	ok++;
	console.log(`✓ ${name}: ${r.events.map((e) => (e.type === "partial" || e.type === "final" ? `${e.type}(${e.text})` : e.type)).join(" → ")}`);
};

const hello = say("Hey Mai, remind me to call my mom tomorrow at eight in the morning.");
const second = say("And buy some milk on the way home.");
/** Seconds from the first to the last loud sample: SAPI pads its clips with silence. */
const voicedSec = (a: Int16Array) => {
	const loud = (v: number) => Math.abs(v) > 800;
	return (a.findLastIndex(loud) - a.findIndex(loud)) / RATE;
};
const helloSec = hello.length / RATE;
console.log(`speech clips: ${helloSec.toFixed(1)} s and ${(second.length / RATE).toFixed(1)} s (SAPI)`);

{
	const r = await run(join2(silence(1), hello, silence(2.5)));
	assert.deepEqual(types(r), ["listening", "speech", "final", "end"]);
	assert.ok(r.events.filter((e) => e.type === "partial").length >= 2, "partials while talking");
	const heard = Number(r.finalText?.match(/[\d.]+/)?.[0]);
	assert.ok(heard >= voicedSec(hello) && heard <= helloSec + 1, `final covers all the speech (${heard} s for ${voicedSec(hello).toFixed(1)} s voiced)`);
	pass("speech then silence: partials, then one auto-send", r);
}
{
	const r = await run(join2(silence(0.5), hello, silence(0.5), second, silence(2.5)));
	assert.equal(r.events.filter((e) => e.type === "final").length, 1, "a short pause doesn't split the message");
	const heard = Number(r.finalText?.match(/[\d.]+/)?.[0]);
	assert.ok(heard >= voicedSec(join2(hello, silence(0.5), second)), `final has both sentences (${heard} s)`);
	pass("short pause between sentences: one message", r);
}
{
	// He pauses past pauseMs while the (slow) final pass runs, then goes on talking: same message, still live.
	const r = await run(join2(silence(0.5), hello, silence(1.1), second, silence(4)), {}, undefined, 15);
	assert.equal(r.events.filter((e) => e.type === "final").length, 1, "one message");
	const resumeAt = r.events.findIndex((e) => e.type === "partial" && Number(e.text.match(/[\d.]+/)?.[0]) > helloSec + 1.0);
	assert.ok(resumeAt > 0, `partials keep coming after he resumes: ${r.events.map((e) => e.type + (e.type === "partial" || e.type === "final" ? `(${e.text})` : "")).join(" ")}`);
	assert.ok(Number(r.finalText?.match(/[\d.]+/)?.[0]) >=voicedSec(join2(hello, silence(1.1), second)), `final has both sentences (${r.finalText})`);
	pass("goes on talking while a slow final pass runs: one message, still live", r);
}
{
	const r = await run(join2(noise(4, -35, "white"), noise(4, -30, "brown"), silence(3)), { noSpeechMs: 6000 });
	assert.deepEqual(types(r), ["listening", "nospeech", "end"]);
	assert.equal(r.passes.length, 0, "noise never reaches the recognizer");
	pass("fan + rumble noise: nothing sent", r);
}
{
	const bg = noise(1, -38, "white");
	const r = await run(join2(mix(silence(1), bg), mix(hello, bg), mix(silence(2.5), bg)));
	assert.deepEqual(types(r), ["listening", "speech", "final", "end"]);
	pass("speech over fan noise: sent", r);
}
{
	const r = await run(join2(silence(0.5), hello, hello), {}, (t, live) => t >= 0.5 + helloSec * 0.6 && live.cancel());
	assert.deepEqual(types(r), ["listening", "speech", "end"]);
	pass("cancel while talking: nothing sent", r);
}
{
	const r = await run(join2(silence(0.5), hello, hello), {}, (t, live) => t >= 0.5 + helloSec && live.finish());
	assert.deepEqual(types(r), ["listening", "speech", "final", "end"]);
	pass("stop while talking: sends what was said", r);
}
{
	const r = await run(silence(3), {}, (t, live) => t >= 1 && live.finish());
	assert.deepEqual(types(r), ["listening", "nospeech", "end"]);
	pass("stop before talking: nothing sent", r);
}
console.log(`live voice typing: ${ok} checks passed`);
