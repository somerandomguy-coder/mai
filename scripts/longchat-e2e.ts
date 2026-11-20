// Real-model regression for "she goes silent in long chats": fill the context past where replies used to be capped
// at 1 token, then let her heartbeat wake her. Every turn must produce real text.
// Usage: $env:MAI_HOME="$env:TEMP\mai-long"; npx tsx scripts/longchat-e2e.ts [num_ctx, default 16384]
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Brain, type BrainEvent } from "../src/core/brain.js";
import { paths } from "../src/core/paths.js";

if (!process.env.MAI_HOME) throw new Error("Set MAI_HOME to a scratch folder");
const numCtx = Number(process.argv[2] ?? 16384);
const brain = new Brain();
brain.cfg.userName = "Nam";
brain.cfg.tts.vieneu.autostart = false;
brain.cfg.ollama.contextWindow = numCtx;
brain.approver = async () => "deny";
let said = "";
brain.on("event", (e: BrainEvent) => {
	if (e.type === "say") said = e.text;
	if (e.type === "repair" || e.type === "error") console.log(`${e.type.toUpperCase()} ${JSON.stringify(e).slice(0, 200)}`);
});
await brain.start();

// ~5k tokens of note text per message (a meeting transcript he pastes and asks about).
const para =
	"Trong buổi họp hôm nay, mentor nhắc lại rằng mình cần chuẩn bị câu chuyện về dự án startup, tập trung vào các lựa chọn kỹ thuật, cách xử lý xung đột trong nhóm và cách dùng AI để kiểm tra code. ";
const note = (n: number) => `Ghi chú số ${n}:\n` + Array.from({ length: 60 }, (_, i) => `${i + 1}. ${para}`).join("\n");

const lastUsage = () => {
	const f = readdirSync(paths.sessions).filter((x) => x.endsWith(".jsonl")).sort().pop()!;
	const rows = readFileSync(join(paths.sessions, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const a = rows.filter((r) => r.message?.role === "assistant").pop()?.message;
	const compactions = rows.filter((r) => r.type === "compaction").length;
	return { prompt: (a?.usage?.input ?? 0) + (a?.usage?.cacheRead ?? 0), output: a?.usage?.output, stop: a?.stopReason, compactions };
};

const steps: Array<[string, () => Promise<unknown>]> = [
	["long note 1", () => brain.chat(`${note(1)}\n\nTóm tắt giúp anh ghi chú này trong 2 câu.`)],
	["long note 2", () => brain.chat(`${note(2)}\n\nGhi chú này khác gì ghi chú trước? Trả lời ngắn.`)],
	["question", () => brain.chat("Ok cảm ơn em. Giờ em thấy anh nên làm gì trước?")],
	["heartbeat", () => brain.wake("check_in", "You're bored. Propose a tiny side quest or ask him a fun random question.\nIf on reflection none of this is worth saying, reply SILENT.")],
];
for (const [name, fn] of steps) {
	said = "";
	const t0 = Date.now();
	await fn();
	const u = lastUsage();
	console.log(`=== ${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s, prompt ${u.prompt}, reply ${u.output} tokens (${u.stop}), compactions so far ${u.compactions}`);
	console.log(`    ${said.replace(/\s+/g, " ").slice(0, 160) || "(nothing said)"}`);
	assert.ok(!(u.output === 1 && u.stop === "length"), `${name}: reply was capped at 1 token`);
	if (name !== "heartbeat") assert.ok(said.trim().length > 0, `${name}: she said nothing`);
}
console.log("long chat e2e: passed");
brain.dispose();
process.exit(0);
