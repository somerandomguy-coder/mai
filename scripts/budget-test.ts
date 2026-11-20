// Her context budget against the SDK's own math (no model needed): at every prompt size she can reach before
// compaction, the reply cap must stay at its full size, for every setup profile's window.
// Regression: with a 16k window, the SDK's 4096-token safety margin capped replies at 1 token once the chat passed
// ~12k tokens, and she went silent (heartbeats and goal checks all came back empty).
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { contextBudget } from "../src/core/brain.js";

const sdk = (p: string) => import(pathToFileURL(join(process.cwd(), "node_modules", "@earendil-works", p)).href);
const { clampMaxTokensToContext } = await sdk("pi-ai/dist/api/simple-options.js");
const { shouldCompact } = await sdk("pi-coding-agent/dist/core/compaction/compaction.js");

/** A context whose last reply reports `promptTokens` used (that's what the SDK measures). */
const ctxWith = (promptTokens: number) => ({
	messages: [{ role: "assistant", content: [{ type: "text", text: "x" }], usage: { input: promptTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: promptTokens }, stopReason: "stop", timestamp: Date.now() }],
});
const FIXED_PROMPT = 8000; // her rules + persona + tool descriptions, measured from the session log

for (const numCtx of [8192, 12288, 16384, 32768]) {
	const b = contextBudget(numCtx);
	const model = { contextWindow: b.sdkContextWindow, maxTokens: 2048 };
	let lastBeforeCompaction = 0;
	for (let p = 1000; p < numCtx; p += 100) {
		if (shouldCompact(p, b.sdkContextWindow, b.compaction)) break;
		lastBeforeCompaction = p;
		const cap = clampMaxTokensToContext(model, ctxWith(p), 2048);
		assert.equal(cap, 2048, `numCtx ${numCtx}: prompt ${p} → reply cap ${cap}`);
		assert.ok(p + cap <= numCtx, `numCtx ${numCtx}: prompt ${p} + reply ${cap} must fit in the window`);
	}
	const old = clampMaxTokensToContext({ contextWindow: numCtx, maxTokens: 2048 }, ctxWith(lastBeforeCompaction), 2048);
	const room = lastBeforeCompaction - FIXED_PROMPT;
	console.log(
		`num_ctx ${String(numCtx).padStart(5)}: full replies up to a ${lastBeforeCompaction}-token prompt, then compaction (keeps ${b.compaction.keepRecentTokens}); ` +
			`room for conversation ≈ ${room > 0 ? room : "NONE"} tokens; old setup capped replies at ${old}`,
	);
}
console.log("budget tests passed");
