import { createVad, VAD_FRAME, VAD_RATE, type Vad } from "./vad.js";

/**
 * Live voice typing for the 🎙️ button.
 *
 * The pet window streams 16 kHz mono mic audio here. Silero VAD finds where speech starts and stops. While he
 * talks, the whole utterance so far is re-sent to Qwen3-ASR about once a second, so the words in the box keep
 * firming up and the last pass is as accurate as a one-shot transcription. After `pauseMs` of silence the
 * final text is emitted and the pet sends it. Benchmarks and why this beat native streaming: docs/BENCHMARKS.md.
 */
export type LiveEvent =
	| { type: "listening"; vad: Vad["kind"] }
	| { type: "speech" }
	| { type: "partial"; text: string }
	| { type: "final"; text: string }
	/** Nothing (intelligible) was said before the timeout, or he stopped before speaking. */
	| { type: "nospeech" }
	| { type: "error"; message: string }
	/** Always the last event of a session. */
	| { type: "end" };

export interface LiveOptions {
	/** Silence after speech that ends the message. */
	pauseMs: number;
	/** Stop listening if he says nothing for this long. */
	noSpeechMs: number;
	/** Wrap up a very long message (Qwen3-ASR decodes up to 30 s in one go). */
	maxSpeechMs: number;
	/** Minimum new audio between two partial transcriptions. */
	partialEveryMs: number;
}

export const DEFAULT_LIVE: LiveOptions = { pauseMs: 900, noSpeechMs: 10_000, maxSpeechMs: 28_000, partialEveryMs: 700 };

const SPEECH_ON = 0.5; // Silero's usual thresholds: a frame this sure is speech…
const SPEECH_KEEP = 0.35; // …and one above this keeps an utterance going.
const MIN_SPEECH_MS = 250; // a cough or a door slam is shorter than this
const PRE_ROLL_MS = 300; // audio kept before the first speech frame, so the first syllable isn't clipped
const ms = (n: number) => Math.round((n * VAD_RATE) / 1000);

export function pcmToWav(samples: Int16Array, rate = VAD_RATE): Buffer {
	const b = Buffer.alloc(44 + samples.length * 2);
	b.write("RIFF", 0);
	b.writeUInt32LE(36 + samples.length * 2, 4);
	b.write("WAVEfmt ", 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(1, 22);
	b.writeUInt32LE(rate, 24);
	b.writeUInt32LE(rate * 2, 28);
	b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34);
	b.write("data", 36);
	b.writeUInt32LE(samples.length * 2, 40);
	Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(b, 44);
	return b;
}

export class LiveTranscriber {
	private readonly opts: LiveOptions;
	private vad?: Vad;
	private audio = new Int16Array(ms(60_000));
	private received = 0; // samples pushed
	private analysed = 0; // samples the VAD has seen
	private frameBusy = false;

	private candidate = -1; // first speech frame of a possible utterance
	private voiced = 0; // speech frames since `candidate`
	private speechStart = -1; // utterance start (with pre-roll) once confirmed
	private lastVoice = 0; // end of the last frame that sounded like speech

	private inflight = false;
	private covered = 0; // audio end of the newest finished transcription
	private latest = "";
	private ending = false;
	private finishRequested = false;
	private done = false;

	constructor(
		private readonly transcribe: (wav: Buffer) => Promise<string>,
		private readonly emit: (e: LiveEvent) => void,
		opts: Partial<LiveOptions> = {},
	) {
		this.opts = { ...DEFAULT_LIVE, ...opts };
	}

	get active(): boolean {
		return !this.done;
	}

	async start(): Promise<void> {
		this.vad = await createVad();
		if (!this.done) this.emit({ type: "listening", vad: this.vad.kind });
		void this.drain();
	}

	/** 16 kHz mono 16-bit samples from the mic, in any chunk size. */
	push(pcm: Int16Array): void {
		if (this.done) return;
		if (this.received + pcm.length > this.audio.length) {
			const bigger = new Int16Array(Math.max(this.audio.length * 2, this.received + pcm.length));
			bigger.set(this.audio.subarray(0, this.received));
			this.audio = bigger;
		}
		this.audio.set(pcm, this.received);
		this.received += pcm.length;
		void this.drain();
	}

	/** He clicked stop: send what he said so far (or nothing, if he hasn't spoken). */
	finish(): void {
		if (this.done) return;
		this.finishRequested = true;
		void this.drain();
	}

	/** Discard everything; nothing is sent. */
	cancel(): void {
		this.close();
	}

	private close(...events: LiveEvent[]): void {
		if (this.done) return;
		this.done = true;
		for (const e of events) this.emit(e);
		this.emit({ type: "end" });
	}

	/** Run the VAD over new audio, one frame at a time, in order. */
	private async drain(): Promise<void> {
		if (!this.vad || this.frameBusy) return;
		this.frameBusy = true;
		try {
			const frame = new Float32Array(VAD_FRAME);
			while (!this.done && this.analysed + VAD_FRAME <= this.received) {
				for (let i = 0; i < VAD_FRAME; i++) frame[i] = this.audio[this.analysed + i] / 32768;
				const p = await this.vad.frame(frame);
				this.analysed += VAD_FRAME;
				this.onFrame(p);
			}
			if (!this.done && this.finishRequested && !this.ending) {
				if (this.speechStart < 0 && this.candidate >= 0) this.speechStart = Math.max(0, this.candidate - ms(PRE_ROLL_MS));
				if (this.speechStart < 0) return this.close({ type: "nospeech" });
				this.lastVoice = this.analysed; // keep everything up to the click
				this.ending = true;
				this.schedule();
			}
		} catch (e) {
			this.close({ type: "error", message: (e as Error).message });
		} finally {
			this.frameBusy = false;
		}
	}

	private onFrame(p: number): void {
		const t = this.analysed;
		if (p >= SPEECH_ON) {
			if (this.candidate < 0) this.candidate = t - VAD_FRAME;
			this.voiced++;
			this.lastVoice = t;
			// He went on talking before the message was sent (the final pass was still running): keep going.
			if (this.ending && !this.finishRequested && t - this.speechStart < ms(this.opts.maxSpeechMs)) this.ending = false;
			if (this.speechStart < 0 && this.voiced * VAD_FRAME >= ms(MIN_SPEECH_MS)) {
				this.speechStart = Math.max(0, this.candidate - ms(PRE_ROLL_MS));
				this.emit({ type: "speech" });
			}
		} else if (p >= SPEECH_KEEP && this.candidate >= 0) {
			this.lastVoice = t;
		} else if (this.speechStart < 0 && this.candidate >= 0 && t - this.lastVoice > ms(300)) {
			this.candidate = -1; // too short to be speech: noise
			this.voiced = 0;
		}

		if (this.speechStart < 0) {
			if (this.candidate < 0 && t >= ms(this.opts.noSpeechMs)) this.close({ type: "nospeech" });
			return;
		}
		if (!this.ending && (t - this.lastVoice >= ms(this.opts.pauseMs) || t - this.speechStart >= ms(this.opts.maxSpeechMs))) this.ending = true;
		this.schedule();
	}

	/** Start the next transcription if one is due, or finish when the newest one covers all the speech. */
	private schedule(): void {
		if (this.done || this.inflight || this.speechStart < 0) return;
		const now = this.analysed;
		if (this.ending) {
			if (this.covered >= this.lastVoice) {
				const text = this.latest.trim();
				return text ? this.close({ type: "final", text }) : this.close({ type: "nospeech" });
			}
			return void this.pass(Math.min(now, this.lastVoice + ms(PRE_ROLL_MS)));
		}
		// While he talks, refresh about every partialEveryMs. When he pauses, transcribe right away: if the
		// pause turns out to be the end, that pass is the final text and nothing more has to wait for it.
		const pausing = now - this.lastVoice >= ms(200) && this.covered < this.lastVoice;
		if (now - Math.max(this.covered, this.speechStart) >= ms(this.opts.partialEveryMs) || pausing) void this.pass(now);
	}

	private async pass(upTo: number): Promise<void> {
		this.inflight = true;
		try {
			const text = await this.transcribe(pcmToWav(this.audio.slice(this.speechStart, upTo)));
			if (this.done) return;
			this.covered = upTo;
			this.latest = text;
			if (!this.ending && text.trim()) this.emit({ type: "partial", text: text.trim() });
		} catch (e) {
			return this.close({ type: "error", message: (e as Error).message });
		} finally {
			this.inflight = false;
		}
		this.schedule();
	}
}
