import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ipcMain } from "electron";
import type { Config } from "../core/config.js";
import { LiveTranscriber, pcmToWav } from "../core/livestt.js";
import { paths } from "../core/paths.js";
import { assertAsrInstalled, transcribeAudio } from "../core/stt.js";
import { enroll, stripWakePhrase, type WakeModel, WakeListener, wakeModelsInstalled } from "../core/wake.js";

export interface VoiceInput {
	/** Settings changed (wake word on/off, re-enrolled): rebuild the listener. */
	reloadEar(): void;
}

/**
 * Mic input from the pet window, in the main process:
 * - Live voice typing (🎙️): the pet streams 16 kHz mic audio ("live-stt-audio"); partial/final text comes back
 *   as "live-stt" events (errors too, which the pet shows in her bubble). Events carry the session id, so a
 *   late event from a cancelled session can't touch the next one.
 * - "Mai ơi": with mic.wakeWord on, the pet keeps one mic open and streams it here ("wake-audio"). Until he says
 *   the phrase only the local detector (core/wake.ts) hears it; after a wake (and in the follow-up window after
 *   her answer) the same audio feeds a live session instead.
 * Used by main.ts and by scripts/wake-e2e.mjs, so the test runs the app's own wiring.
 */
export function wireVoiceInput(deps: {
	cfg: () => Config;
	send: (channel: string, payload: unknown) => void;
	stopSpeech: () => void;
	onWake: () => void;
}): VoiceInput {
	let live: LiveTranscriber | undefined;
	let liveId = 0;
	/** The live session is fed from the always-open "ear" mic (hands-free) instead of its own mic. */
	let liveFromEar = false;
	const toInt16 = (pcm: Uint8Array) => new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~1)));

	const wakeFile = join(paths.wake, "wake.json");
	let ear: WakeListener | undefined;
	let lastWake: { at: number; endSample: number } | undefined;
	const wakeLog = (m: string) => {
		try {
			appendFileSync(join(paths.state, "wake.log"), `${new Date().toISOString()} ${m}\n`);
		} catch {}
	};
	const loadEar = () => {
		ear = undefined;
		if (!deps.cfg().mic.wakeWord || !existsSync(wakeFile) || !wakeModelsInstalled()) return;
		const model = JSON.parse(readFileSync(wakeFile, "utf8")) as WakeModel;
		ear = new WakeListener(
			model,
			(hit) => {
				lastWake = { at: Date.now(), endSample: hit.endSample };
				wakeLog(`woke (score ${hit.score.toFixed(3)}, heard "${hit.heard}")`);
				deps.onWake();
				deps.send("wake", { heard: hit.heard });
			},
			async (f) => {
				try {
					assertAsrInstalled();
				} catch {
					return "mai ơi"; // no speech recognition installed: trust the detector alone
				}
				return transcribeAudio(pcmToWav(Int16Array.from(f, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))))), deps.cfg(), { lang: "vi" });
			},
			wakeLog,
		);
	};
	loadEar();

	ipcMain.handle("wake-status", () => ({ on: !!deps.cfg().mic.wakeWord, enrolled: existsSync(wakeFile), installed: wakeModelsInstalled(), ready: !!ear }));
	ipcMain.on("wake-audio", (_e, pcm: Uint8Array) => {
		const s = toInt16(pcm);
		if (live && liveFromEar) live.push(s);
		else ear?.push(s);
	});
	// Enrollment from Settings: his takes of "Mai ơi" + a few seconds of ordinary speech (all 16 kHz PCM).
	ipcMain.handle("wake-enroll", async (_e, args: { takes: Uint8Array[]; other: Uint8Array[] }) => {
		if (!wakeModelsInstalled()) throw new Error("The wake-word models aren't installed. Run setup.cmd once.");
		const f32 = (u: Uint8Array) => Float32Array.from(toInt16(u), (v) => v / 32768);
		const model = await enroll(args.takes.map(f32), args.other.map(f32));
		writeFileSync(wakeFile, JSON.stringify(model));
		// Keep the recordings with the model (his data folder only): they're the start of a training set for a
		// real wake-word model and for tuning speech recognition to his voice later (docs/STT-PLAN.md).
		args.takes.forEach((u, i) => writeFileSync(join(paths.wake, `take-${i + 1}.wav`), pcmToWav(toInt16(u))));
		args.other.forEach((u, i) => writeFileSync(join(paths.wake, `other-${i + 1}.wav`), pcmToWav(toInt16(u))));
		loadEar();
		return { threshold: model.threshold, takes: model.calibration.positives, other: model.calibration.negativeMax, used: model.templates.length };
	});

	ipcMain.handle("live-stt-start", async (_e, args: { lang?: "vi" | "en" | "auto"; fromEar?: boolean; noSpeechMs?: number }) => {
		const id = ++liveId;
		live?.cancel();
		assertAsrInstalled();
		deps.stopSpeech(); // he's talking now, and her voice would leak into the mic
		const cfg = deps.cfg();
		const fromEar = !!args.fromEar && !!ear;
		const t: LiveTranscriber = new LiveTranscriber(
			(wav) => transcribeAudio(wav, deps.cfg(), { lang: args.lang ?? "vi" }),
			(ev) => {
				let out = ev;
				// Hands-free: he may have said "Mai ơi, …" in one breath; keep only what came after.
				if (fromEar && (ev.type === "partial" || ev.type === "final")) {
					const text = stripWakePhrase(ev.text);
					out = text ? { ...ev, text } : ev.type === "final" ? { type: "nospeech" } : { ...ev, text: "" };
				}
				if (!(out.type === "partial" && !out.text)) {
					deps.send("live-stt", { ...out, id, ...(out.type === "final" ? { autoSend: cfg.mic.autoSend !== false || fromEar } : {}) });
				}
				if (ev.type === "end" && live === t) {
					live = undefined;
					liveFromEar = false;
					ear?.reset();
				}
			},
			{ pauseMs: Math.max(300, Number(cfg.mic.pauseMs) || 900), ...(args.noSpeechMs ? { noSpeechMs: args.noSpeechMs } : {}) },
		);
		live = t;
		liveFromEar = fromEar;
		await t.start();
		// Right after a wake: start from the end of "Mai ơi", so a question in the same breath isn't lost.
		if (fromEar && ear && lastWake && Date.now() - lastWake.at < 5000) t.push(ear.audioSince(lastWake.endSample));
		lastWake = undefined;
		return id;
	});
	ipcMain.on("live-stt-audio", (_e, pcm: Uint8Array) => {
		if (!liveFromEar) live?.push(toInt16(pcm));
	});
	ipcMain.handle("live-stt-stop", (_e, how: "send" | "cancel") => (how === "cancel" ? live?.cancel() : live?.finish()));

	return { reloadEar: loadEar };
}
