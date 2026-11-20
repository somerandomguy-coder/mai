// The screenshot stub bridge, with the mic, wake word and speech calls wired to the test's main process
// (scripts/wake-e2e.mjs).
require("./screenshots/stub-preload.cjs");
const { ipcRenderer } = require("electron");

Object.assign(window.mai, {
	send: (text) => ipcRenderer.invoke("chat", text),
	onEvent: (cb) => ipcRenderer.on("brain-event", (_e, ev) => cb(ev)),
	onSpeech: (cb) => ipcRenderer.on("speech", (_e, s) => cb(s)),
	onSpeechStop: (cb) => ipcRenderer.on("speech-stop", () => cb()),
	onSpeechDrained: (cb) => ipcRenderer.on("speech-drained", () => cb()),
	getConfig: () => ipcRenderer.invoke("get-config"),
	liveStart: (args) => ipcRenderer.invoke("live-stt-start", args),
	liveAudio: (pcm) => ipcRenderer.send("live-stt-audio", pcm),
	liveStop: (how) => ipcRenderer.invoke("live-stt-stop", how),
	onLive: (cb) => ipcRenderer.on("live-stt", (_e, ev) => cb(ev)),
	wakeStatus: () => ipcRenderer.invoke("wake-status"),
	wakeAudio: (pcm) => ipcRenderer.send("wake-audio", pcm),
	onWake: (cb) => ipcRenderer.on("wake", (_e, ev) => cb(ev)),
});
