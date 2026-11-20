import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { paths } from "./paths.js";
import { winHelper } from "./winhelper.js";

export interface ActivitySpan {
	process: string;
	title: string;
	since: number;
}

/**
 * Cheap, always-on awareness: which window is in front, for how long, and how long he's been idle.
 * Screenshots are a separate, opt-in step (see `screenshot`).
 */
export class ScreenWatcher {
	current?: ActivitySpan;
	idleMs = 0;
	recent: Array<ActivitySpan & { until: number }> = [];
	private timer?: NodeJS.Timeout;

	constructor(private readonly cfg: Config) {}

	isBlocked(text: string): boolean {
		const t = text.toLowerCase();
		return this.cfg.screen.blocklist.some((b) => t.includes(b.toLowerCase()));
	}

	/** Read the window in front right now. */
	async refresh(): Promise<void> {
		const r = await winHelper.send<{ ok: boolean; title: string; process: string; idleMs: number }>("poll");
		if (!r.ok) return;
		this.idleMs = r.idleMs;
		const blocked = this.isBlocked(`${r.process} ${r.title}`);
		const title = blocked ? "(private window)" : r.title;
		if (!this.current || this.current.process !== r.process || this.current.title !== title) {
			if (this.current) this.recent.push({ ...this.current, until: Date.now() });
			this.recent = this.recent.slice(-15);
			this.current = { process: r.process, title, since: Date.now() };
		}
	}

	start(intervalMs = 15_000): void {
		if (!this.cfg.screen.watchWindows || this.timer) return;
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Same app (by process) continuously, in minutes. */
	minutesOnCurrentApp(): number {
		if (!this.current) return 0;
		let since = this.current.since;
		for (let i = this.recent.length - 1; i >= 0 && this.recent[i].process === this.current.process; i--) since = this.recent[i].since;
		return Math.round((Date.now() - since) / 60_000);
	}

	describe(): string {
		if (!this.current) return "Screen: unknown (watching disabled or not Windows).";
		const idleMin = Math.round(this.idleMs / 60_000);
		const away = idleMin >= 5 ? ` He has been idle/away for ${idleMin} min.` : "";
		const recent = this.recent
			.slice(-4)
			.map((s) => s.process)
			.join(" → ");
		return `Screen: he's in ${this.current.process} ("${this.current.title.slice(0, 80)}") for ${this.minutesOnCurrentApp()} min.${away} Recent apps: ${recent || "n/a"}.`;
	}

	/**
	 * Grab a screenshot as base64 and delete the file immediately. The caller checks permission
	 * (`allowScreenshots`, or his approval for this one shot). A private window in front always blocks it.
	 * `forText`: full resolution PNG, so small text stays readable; otherwise a downscaled JPEG for a quick look.
	 */
	async screenshot(opts: { forText?: boolean } = {}): Promise<{ ok: true; base64: string } | { ok: false; error: string }> {
		await this.refresh();
		// refresh() stores a blocked window's title as "(private window)", so check for that too.
		if (this.current && (this.current.title === "(private window)" || this.isBlocked(`${this.current.process} ${this.current.title}`)))
			return { ok: false, error: "A private window is in front; not looking." };
		const file = join(paths.screenshots, `peek-${Date.now()}.${opts.forText ? "png" : "jpg"}`);
		const r = await winHelper.send<{ ok: boolean; error?: string }>(`screenshot ${file} ${opts.forText ? 2560 : 1280}`, 20_000);
		if (!r.ok) return { ok: false, error: r.error ?? "screenshot failed" };
		const base64 = readFileSync(file).toString("base64");
		rmSync(file, { force: true });
		return { ok: true, base64 };
	}
}
