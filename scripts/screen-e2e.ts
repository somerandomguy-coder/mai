// End-to-end check of reading the screen (read_screen) against the real Ollama model, in a throwaway MAI_HOME.
// A full-screen test page covers his screen first, so nothing real is read.
// Usage: $env:MAI_HOME="$env:TEMP\mai-screen"; npx tsx scripts/screen-e2e.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Brain, type BrainEvent } from "../src/core/brain.js";

if (!process.env.MAI_HOME) throw new Error("Set MAI_HOME to a scratch folder");
const electron = createRequire(import.meta.url)("electron") as unknown as string;
const cover = spawn(electron, ["scripts/screen-e2e-window.cjs"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((resolve, reject) => {
	cover.stdout.on("data", (d) => String(d).includes("READY") && resolve());
	cover.on("exit", () => reject(new Error("test window closed early")));
	setTimeout(() => reject(new Error("test window didn't open")), 20_000);
});

const brain = new Brain();
brain.cfg.userName = "Nam";
brain.cfg.tts.vieneu.autostart = false;
brain.cfg.screen.allowScreenshots = false; // she must ask
const asked: string[] = [];
let answer: "once" | "deny" = "once";
brain.approver = async (req) => {
	asked.push(req.kind);
	console.log(`APPROVAL ASKED (${answer}): ${req.kind} :: ${req.summary} :: "${req.why}"`);
	return answer;
};
const tools: string[] = [];
let said = "";
brain.on("event", (e: BrainEvent) => {
	if (e.type === "tool" && e.phase === "start") tools.push(e.name);
	if (e.type === "say") said = e.text;
	if (e.type === "tool" || e.type === "say") console.log(e.type === "say" ? `SAY ${e.text}` : `TOOL ${e.name} ${e.phase}`);
});

try {
	await brain.start();

	console.log("\n=== he asks her to read the task list on his screen (approved) ===");
	let t0 = Date.now();
	await brain.chat("Em đọc giúp anh danh sách task trên màn hình được không? Mã phòng họp là gì?");
	console.log(`--- ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	assert.ok(tools.includes("read_screen"), "called read_screen");
	assert.ok(asked.includes("screenshot"), "asked before the screenshot");
	assert.match(said, /XK-?4821/, "quoted the meeting code from the screen");

	console.log("\n=== he says no ===");
	tools.length = 0;
	asked.length = 0;
	answer = "deny";
	await brain.chat("Đọc lại màn hình lần nữa xem?");
	assert.ok(asked.includes("screenshot") || !tools.includes("read_screen"), "asked again (or didn't try)");

	console.log("\n=== on her own (heartbeat): never asks for a screenshot ===");
	tools.length = 0;
	asked.length = 0;
	answer = "once";
	await brain.wake("check_in", "Spontaneous moment: read the text on his screen with read_screen and comment on it.");
	assert.ok(!asked.includes("screenshot"), "no screenshot request from a heartbeat");
	console.log("\nscreen e2e: all checks passed");
} finally {
	cover.kill();
	brain.dispose();
	process.exit(process.exitCode ?? 0);
}
