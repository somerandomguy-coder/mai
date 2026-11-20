import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./paths.js";

/**
 * "Mai ơi" wake word, few-shot: he records the phrase ~5 times (enroll), and we compare what the mic hears with
 * those recordings. Nothing is trained and nothing leaves the PC.
 *
 * Features are openWakeWord's (Apache-2.0): a mel-spectrogram model, then a speech-embedding model that turns the
 * last 0.76 s of sound into 96 numbers, every 80 ms. A recording of "Mai ơi" becomes a short sequence of those
 * vectors (a template). While listening, the newest vectors are aligned with each template (DTW) and scored by
 * cosine similarity. A hit above the threshold is then double-checked by speech recognition (see WakeListener).
 */
const OWW_DIR = join(APP_ROOT, "sidecars", "audiocpp", "models", "openwakeword");
export const WAKE_MODELS = { mel: join(OWW_DIR, "melspectrogram.onnx"), embedding: join(OWW_DIR, "embedding_model.onnx") };
export const WAKE_RATE = 16000;
const CHUNK = 1280; // 80 ms: one embedding per chunk
const MEL_CONTEXT = 480; // the mel model needs 3 extra hops of history to give 8 frames per chunk
const MEL_WINDOW = 76; // mel frames per embedding

type Ort = typeof import("onnxruntime-web");
type Session = import("onnxruntime-web").InferenceSession;
let modelsP: Promise<{ ort: Ort; mel: Session; emb: Session }> | undefined;

export function wakeModelsInstalled(): boolean {
	return existsSync(WAKE_MODELS.mel) && existsSync(WAKE_MODELS.embedding);
}

async function models() {
	modelsP ??= (async () => {
		const ort = await import("onnxruntime-web");
		ort.env.wasm.numThreads = 1;
		const [mel, emb] = await Promise.all([
			ort.InferenceSession.create(readFileSync(WAKE_MODELS.mel)),
			ort.InferenceSession.create(readFileSync(WAKE_MODELS.embedding)),
		]);
		return { ort, mel, emb };
	})().catch((e) => {
		modelsP = undefined;
		throw e;
	});
	return modelsP;
}

/** Streaming features: push 16 kHz float audio, get one 96-dim embedding per 80 ms (after the first ~0.8 s). */
export class WakeFeatures {
	private raw = new Float32Array(0); // not yet processed
	private history = new Float32Array(MEL_CONTEXT); // last samples of the previous chunk
	private mel: Float32Array[] = []; // rolling mel frames (32 each)

	async push(samples: Float32Array): Promise<Float32Array[]> {
		const { ort, mel, emb } = await models();
		const joined = new Float32Array(this.raw.length + samples.length);
		joined.set(this.raw);
		joined.set(samples, this.raw.length);
		const out: Float32Array[] = [];
		let at = 0;
		for (; at + CHUNK <= joined.length; at += CHUNK) {
			const input = new Float32Array(MEL_CONTEXT + CHUNK);
			input.set(this.history);
			input.set(joined.subarray(at, at + CHUNK), MEL_CONTEXT);
			this.history = input.slice(input.length - MEL_CONTEXT);
			// openWakeWord's models were trained on int16-range audio
			const scaled = input.map((v) => v * 32767);
			const m = await mel.run({ input: new ort.Tensor("float32", scaled, [1, scaled.length]) });
			const frames = m.output.data as Float32Array; // [1,1,8,32]
			for (let f = 0; f < frames.length / 32; f++) this.mel.push(frames.slice(f * 32, f * 32 + 32).map((x) => x / 10 + 2));
			if (this.mel.length > MEL_WINDOW) this.mel.splice(0, this.mel.length - MEL_WINDOW);
			if (this.mel.length < MEL_WINDOW) continue;
			const win = new Float32Array(MEL_WINDOW * 32);
			this.mel.forEach((fr, i) => win.set(fr, i * 32));
			const e = await emb.run({ input_1: new ort.Tensor("float32", win, [1, MEL_WINDOW, 32, 1]) });
			out.push(Float32Array.from(e[emb.outputNames[0]].data as Float32Array));
		}
		this.raw = joined.slice(at);
		return out;
	}
}

function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
	let d = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		d += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return d / (Math.sqrt(na * nb) || 1);
}

/** Similarity (about 0..1) of two embedding sequences, aligned with DTW so a faster or slower "Mai ơi" still matches. */
export function dtwSimilarity(a: ArrayLike<Float32Array | number[]>, b: ArrayLike<Float32Array | number[]>): number {
	const n = a.length;
	const m = b.length;
	const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
	const steps = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
	cost[0][0] = 0;
	for (let i = 1; i <= n; i++)
		for (let j = 1; j <= m; j++) {
			const d = 1 - cosine(a[i - 1], b[j - 1]);
			const prev = [
				[cost[i - 1][j - 1], steps[i - 1][j - 1]],
				[cost[i - 1][j], steps[i - 1][j]],
				[cost[i][j - 1], steps[i][j - 1]],
			].reduce((x, y) => (y[0] < x[0] ? y : x));
			cost[i][j] = prev[0] + d;
			steps[i][j] = prev[1] + 1;
		}
	return 1 - cost[n][m] / steps[n][m];
}

/** Where the speech is in a clean enrollment recording (loudness-based), in samples. */
export function speechBounds(samples: Float32Array): { start: number; end: number } | null {
	const hop = 160;
	const rms: number[] = [];
	for (let i = 0; i + hop <= samples.length; i += hop) {
		let s = 0;
		for (let k = i; k < i + hop; k++) s += samples[k] * samples[k];
		rms.push(Math.sqrt(s / hop));
	}
	const peak = Math.max(...rms, 0);
	if (peak < 0.01) return null; // silence
	const on = rms.map((r) => r > peak * 0.12);
	const first = on.indexOf(true);
	const last = on.lastIndexOf(true);
	return { start: first * hop, end: (last + 1) * hop };
}

export interface WakeModel {
	version: 1;
	/** One embedding sequence per enrollment take. */
	templates: number[][][];
	threshold: number;
	/** Calibration, for the record: what his takes scored against each other, and the best non-wake score. */
	calibration: { positives: number[]; negativeMax: number };
	createdAt: string;
}

const PAD = new Float32Array(WAKE_RATE); // 1 s of silence so the feature buffers are warm before the phrase

/** Embeddings of a recording (with silence in front), each tagged with the sample (in the original clip) it ends at. */
export async function embedRecording(samples: Float32Array): Promise<Array<{ at: number; v: Float32Array }>> {
	const f = new WakeFeatures();
	const audio = new Float32Array(PAD.length + samples.length + WAKE_RATE / 2);
	audio.set(samples, PAD.length);
	const vs = await f.push(audio);
	// The k-th embedding is produced after chunk (k + firstChunk); find its end time.
	const totalChunks = Math.floor(audio.length / CHUNK);
	const first = totalChunks - vs.length;
	return vs.map((v, k) => ({ at: (first + k + 1) * CHUNK - PAD.length, v }));
}

/** The template for one take: the embeddings from just after the phrase starts to just after it ends. */
export async function templateFromTake(samples: Float32Array): Promise<Float32Array[] | null> {
	const b = speechBounds(samples);
	if (!b) return null;
	const embs = await embedRecording(samples);
	const from = b.start + 0.25 * WAKE_RATE;
	const to = b.end + 0.25 * WAKE_RATE;
	const t = embs.filter((e) => e.at >= from && e.at <= to).map((e) => e.v);
	return t.length >= 3 ? t : null;
}

/** Best score of any template against a running stream of embeddings (as WakeListener would see it). */
export function bestScore(templates: ArrayLike<Float32Array | number[]>[], stream: Float32Array[]): number {
	let best = 0;
	for (const t of templates) {
		const len = t.length;
		for (let end = len; end <= stream.length; end++) best = Math.max(best, dtwSimilarity(stream.slice(end - len, end), t));
	}
	return best;
}

/**
 * Build his wake model from 3+ takes of "Mai ơi" and some ordinary speech (negatives).
 * The threshold sits between how well his takes match each other and how well anything else matches.
 */
export async function enroll(takes: Float32Array[], negatives: Float32Array[]): Promise<WakeModel> {
	const templates: Float32Array[][] = [];
	for (const t of takes) {
		const tpl = await templateFromTake(t);
		if (tpl) templates.push(tpl);
	}
	if (templates.length < 3) throw new Error(`Only ${templates.length} clear takes of "Mai ơi"; record at least 3 (louder, closer to the mic).`);
	const streams = await Promise.all(takes.map(async (t) => (await embedRecording(t)).map((e) => e.v)));
	const positives = templates.map((_, i) => bestScore(templates.filter((__, j) => j !== i), streams[i]));
	let negativeMax = 0;
	for (const n of negatives) negativeMax = Math.max(negativeMax, bestScore(templates, (await embedRecording(n)).map((e) => e.v)));
	const sorted = [...positives].sort((a, b) => a - b);
	const lowPositive = sorted[Math.floor(sorted.length * 0.2)]; // ignore the single worst take
	// Midway between the two, but never below the negatives + a margin.
	const threshold = Math.max((lowPositive + negativeMax) / 2, negativeMax + 0.02);
	return {
		version: 1,
		templates: templates.map((t) => t.map((v) => Array.from(v, (x) => Math.round(x * 1e4) / 1e4))),
		threshold: Math.round(threshold * 1e4) / 1e4,
		calibration: { positives: positives.map((p) => Math.round(p * 1e4) / 1e4), negativeMax: Math.round(negativeMax * 1e4) / 1e4 },
		createdAt: new Date().toISOString(),
	};
}

// The second check only has to tell "Mai ơi" from things that merely sound close ("ngày mai", "Mai à", "trời ơi",
// "anh ơi"). Qwen3-ASR often writes the phrase itself as "Mày ơi", "AI ơi", "mai ổi", "bài ơi", so accept any
// syllable ending in -ai/-ay followed by an "ơi"-like one (no consonant), except the real word "hai ơi".
const AI_SYLLABLE = String.raw`[\p{L}]*?(?:[aàáảãạ][iy]|[âầấẩẫậ]y)`;
const OI_SYLLABLE = String.raw`(?:[ơờớởỡợôồốổỗộoòóỏõọưừứửữự]i)`;
const WAKE_RE = new RegExp(String.raw`(?:^|[^\p{L}])(${AI_SYLLABLE})\s*[,.!?…-]?\s*${OI_SYLLABLE}(?![\p{L}])`, "u");

/** Did speech recognition hear something that can be "Mai ơi"? (lenient on purpose; see above) */
export function heardWakePhrase(text: string): boolean {
	const t = text.normalize("NFC").toLowerCase();
	const m = WAKE_RE.exec(t);
	return !!m && m[1] !== "hai";
}

/** Remove a leading "Mai ơi" (and punctuation) from what he said after waking her. */
export function stripWakePhrase(text: string): string {
	return text
		.normalize("NFC")
		.replace(/^\s*m(?:a[iìỉĩíịy]|à[iy]|ả[iy]|ã[iy]|á[iy]|ạ[iy]|â[iy]|ầ[iy]|ấ[iy]|ay)\s*[,.!?…-]?\s*(?:ơi|ời|ởi|ơ|oi|ôi|ới)(?![\p{L}])[\s,.!?…-]*/iu, "")
		.trim();
}

export interface WakeHit {
	score: number;
	/** What speech recognition heard around the hit (empty if it wasn't asked). */
	heard: string;
}

/**
 * Always-on listener. Push 16 kHz mic audio; `onWake` fires when "Mai ơi" is heard.
 * Cheap path: features + DTW every 80 ms, only while there's sound. Expensive path (speech recognition on the
 * last 2 s) runs only on a hit, to throw out "ngày mai", "trời ơi" and anything else that merely sounds close.
 */
export class WakeListener {
	private feats = new WakeFeatures();
	private recent: Float32Array[] = []; // newest embeddings
	private ring = new Float32Array(WAKE_RATE * 4);
	private ringFill = 0;
	private above = 0;
	private quietUntil = 0; // refractory: no new hit before this (ms clock)
	private checking = false;
	private chain: Promise<void> = Promise.resolve();
	/** Sample count of audio received; the wake phrase end is reported in this clock. */
	received = 0;

	constructor(
		private readonly model: WakeModel,
		private readonly onWake: (hit: WakeHit & { endSample: number }) => void,
		private readonly confirm?: (wav16k: Float32Array) => Promise<string>,
		private readonly log: (msg: string) => void = () => {},
	) {}

	private get maxLen(): number {
		return Math.max(...this.model.templates.map((t) => t.length));
	}

	/** Audio from the mic. Chunks are processed in order. */
	push(pcm: Int16Array): void {
		const f = Float32Array.from(pcm, (v) => v / 32768);
		this.received += f.length;
		// keep the last 4 s for the confirmation pass
		if (f.length >= this.ring.length) this.ring.set(f.subarray(f.length - this.ring.length));
		else {
			this.ring.copyWithin(0, f.length);
			this.ring.set(f, this.ring.length - f.length);
		}
		this.ringFill = Math.min(this.ring.length, this.ringFill + f.length);
		this.chain = this.chain.then(() => this.process(f)).catch((e) => this.log(`wake: ${(e as Error).message}`));
	}

	/** The audio received after `sample` (up to the last 4 s), e.g. what he said right after "Mai ơi". */
	audioSince(sample: number): Int16Array {
		const n = Math.max(0, Math.min(this.received - sample, this.ringFill));
		return Int16Array.from(this.ring.subarray(this.ring.length - n), (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
	}

	/** Forget what was heard (e.g. after she spoke, so her own voice can't complete a match). */
	reset(): void {
		this.recent = [];
		this.above = 0;
	}

	private async process(f: Float32Array): Promise<void> {
		const embs = await this.feats.push(f);
		for (const v of embs) {
			this.recent.push(v);
			if (this.recent.length > this.maxLen + 4) this.recent.shift();
			const score = bestScore(this.model.templates, this.recent.slice(-this.maxLen));
			this.above = score >= this.model.threshold ? this.above + 1 : 0;
			if (this.above >= 2 && Date.now() >= this.quietUntil && !this.checking) {
				this.quietUntil = Date.now() + 2000;
				const endSample = this.received;
				void this.check(score, endSample);
			}
		}
	}

	private async check(score: number, endSample: number): Promise<void> {
		if (!this.confirm) {
			// Without speech recognition, demand a clearly better match.
			if (score >= this.model.threshold + 0.03) this.onWake({ score, heard: "", endSample });
			return;
		}
		this.checking = true;
		try {
			const n = Math.min(this.ringFill, WAKE_RATE * 2.5);
			const heard = await this.confirm(this.ring.slice(this.ring.length - n));
			this.log(`wake: score ${score.toFixed(3)} (threshold ${this.model.threshold}), heard "${heard}"`);
			if (heardWakePhrase(heard)) this.onWake({ score, heard, endSample });
		} catch (e) {
			this.log(`wake check failed: ${(e as Error).message}`);
		} finally {
			this.checking = false;
		}
	}
}
