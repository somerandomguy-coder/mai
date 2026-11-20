import { ollamaChat } from "./ollama.js";

/**
 * Reading text off an image (OCR) through Ollama. Dedicated OCR models want their own short trigger prompt;
 * general vision models (her own gemma4) get a strict "copy, don't fix" instruction.
 * Measured on 1080p screenshots in docs/BENCHMARKS.md ("Reading the screen").
 */
export function ocrPrompt(model: string): string {
	const m = model.toLowerCase();
	if (m.includes("paddleocr")) return "OCR:";
	if (m.includes("glm-ocr")) return "Text Recognition:";
	return (
		"Transcribe every piece of text in this screenshot exactly as written, line by line, top to bottom. " +
		"Copy it character for character: keep abbreviations, numbers, typos, casing and punctuation as they are; " +
		"do not expand, translate, correct or summarize anything. Output only the text."
	);
}

/** Cut repeated lines a small model can loop on, and cap the size she gets back. */
export function tidyOcr(text: string, maxChars = 8000): string {
	const lines = text.replace(/\r/g, "").split("\n");
	const out: string[] = [];
	let repeats = 0;
	for (const line of lines) {
		if (out.length && line.trim() && line === out[out.length - 1]) {
			if (++repeats >= 2) continue; // same line 3+ times in a row: a decoding loop, not the screen
		} else repeats = 0;
		out.push(line);
	}
	const joined = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…(cut: the screen had more text)` : joined;
}

export async function readImageText(baseUrl: string, model: string, base64: string): Promise<string> {
	const raw = await ollamaChat(baseUrl, model, [{ role: "user", content: ocrPrompt(model), images: [base64] }], {
		temperature: 0,
		numPredict: 3000,
		timeoutMs: 120_000,
	});
	return tidyOcr(raw);
}
