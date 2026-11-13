import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./paths.js";

/** Silero VAD v5 (MIT, 2.3 MB): tells speech from silence and background noise, 32 ms at a time. */
export const VAD_MODEL = join(APP_ROOT, "sidecars", "audiocpp", "models", "silero-vad", "silero_vad.onnx");
export const VAD_RATE = 16000;
/** Samples per VAD frame (32 ms at 16 kHz), fixed by the Silero v5 model. */
export const VAD_FRAME = 512;

export interface Vad {
	readonly kind: "silero" | "energy";
	/** Speech probability (0..1) of one VAD_FRAME of 16 kHz mono float samples (-1..1). */
	frame(samples: Float32Array): Promise<number>;
	reset(): void;
}

type Ort = typeof import("onnxruntime-web");
let ortP: Promise<Ort> | undefined;
let sessionP: Promise<import("onnxruntime-web").InferenceSession> | undefined;

/** The model is loaded once per process (~200 ms); each Vad keeps its own recurrent state. */
class SileroVad implements Vad {
	readonly kind = "silero";
	private state: import("onnxruntime-web").Tensor;
	private context = new Float32Array(64);
	private readonly sr: import("onnxruntime-web").Tensor;

	constructor(
		private readonly ort: Ort,
		private readonly session: import("onnxruntime-web").InferenceSession,
	) {
		this.state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
		this.sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(VAD_RATE)]), []);
	}

	reset(): void {
		this.state = new this.ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
		this.context = new Float32Array(64);
	}

	async frame(samples: Float32Array): Promise<number> {
		// Silero v5 expects the last 64 samples of the previous frame in front of each new one.
		const input = new Float32Array(64 + VAD_FRAME);
		input.set(this.context);
		input.set(samples.subarray(0, VAD_FRAME), 64);
		this.context = input.slice(input.length - 64);
		const out = await this.session.run({ input: new this.ort.Tensor("float32", input, [1, input.length]), state: this.state, sr: this.sr });
		this.state = out.stateN as import("onnxruntime-web").Tensor;
		return (out.output.data as Float32Array)[0];
	}
}

/**
 * Fallback when the Silero model isn't downloaded: loudness against a slowly adapting noise floor.
 * Steady noise (fans) is ignored, but music or a TV can still trigger it, so setup installs Silero.
 */
class EnergyVad implements Vad {
	readonly kind = "energy";
	private floor = 0.003;

	reset(): void {
		this.floor = 0.003;
	}

	async frame(samples: Float32Array): Promise<number> {
		let sum = 0;
		for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
		const rms = Math.sqrt(sum / samples.length);
		// The floor follows quiet frames quickly and loud ones very slowly.
		this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.998 + rms * 0.002;
		const snr = rms / Math.max(this.floor, 1e-4);
		return Math.max(0, Math.min(1, (snr - 2) / 4));
	}
}

export async function createVad(model = VAD_MODEL): Promise<Vad> {
	if (!existsSync(model)) return new EnergyVad();
	ortP ??= import("onnxruntime-web").then((ort) => {
		ort.env.wasm.numThreads = 1; // one 32 ms frame takes < 1 ms; threads need cross-origin isolation anyway
		return ort;
	});
	const ort = await ortP;
	sessionP ??= ort.InferenceSession.create(readFileSync(model));
	try {
		return new SileroVad(ort, await sessionP);
	} catch (e) {
		sessionP = undefined;
		throw e;
	}
}
