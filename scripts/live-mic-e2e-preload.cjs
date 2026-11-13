// The screenshot stub bridge, with the live mic calls wired to the real main process (scripts/live-mic-e2e.mjs).
require("./screenshots/stub-preload.cjs");
const { ipcRenderer } = require("electron");

Object.assign(window.mai, {
	send: (text) => ipcRenderer.invoke("chat", text),
	liveStart: (args) => ipcRenderer.invoke("live-stt-start", args),
	liveAudio: (pcm) => ipcRenderer.send("live-stt-audio", pcm),
	liveStop: (how) => ipcRenderer.invoke("live-stt-stop", how),
	onLive: (cb) => ipcRenderer.on("live-stt", (_e, ev) => cb(ev)),
});
