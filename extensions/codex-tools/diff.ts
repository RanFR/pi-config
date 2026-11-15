/**
 * `/diff` command, ported from codex's TUI `/diff` (get_git_diff.rs).
 *
 * Shows the working-tree diff (staged + unstaged + untracked) in a scrollable
 * full-screen viewer; falls back to writing a patch file outside TUI mode.
 *
 * @module
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import { getWorkingTreeDiff } from "./git.ts";

/** Cap viewer content so giant diffs cannot stall the TUI. */
const MAX_DIFF_CHARS = 2_000_000;

/**
 * Full-screen scrollable viewer for diff text.
 *
 * Keys: j/k or ↑/↓ line scroll · PgUp/PgDn/Space page · g/Home top ·
 * Shift+G/End bottom · q/Enter/Esc close.
 */
class DiffViewer {
	private scrollTop = 0;
	private cached: { width: number; lines: string[] } | undefined;

	constructor(
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly title: string,
		private readonly rows: string[],
		private readonly viewportRows: number,
	) {}

	/** Handles a key press, scrolling the viewport or closing the viewer. */
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "return")) {
			this.done();
			return;
		}
		let delta = 0;
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) delta = -1;
		else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) delta = 1;
		else if (matchesKey(data, Key.pageUp)) delta = -Math.max(1, this.viewportRows - 1);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) delta = Math.max(1, this.viewportRows - 1);
		else if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.scrollTop = 0;
			this.invalidate();
			this.requestRender();
			return;
		} else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			this.scrollTop = Math.max(0, this.rows.length - this.viewportRows);
			this.invalidate();
			this.requestRender();
			return;
		}
		if (delta === 0) return;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop + delta, Math.max(0, this.rows.length - this.viewportRows)));
		this.invalidate();
		this.requestRender();
	}

	/** Colors a diff line by its prefix (+, -, @@, and file headers). */
	private styleLine(line: string): string {
		if (line.startsWith("+++") || line.startsWith("---")) return this.theme.fg("dim", line);
		if (line.startsWith("@@")) return this.theme.fg("accent", line);
		if (line.startsWith("+")) return this.theme.fg("success", line);
		if (line.startsWith("-")) return this.theme.fg("error", line);
		return line;
	}

	/**
	 * Renders the viewport: title, position label, visible rows, and footer.
	 * Cached by width; call {@link invalidate} after scrolling.
	 */
	render(width: number): string[] {
		if (this.cached && this.cached.width === width) return this.cached.lines;

		const total = this.rows.length;
		const header = this.theme.fg("accent", this.theme.bold(this.title));
		const position = this.theme.fg("dim", this.positionLabel(total));
		const visible = this.rows.slice(this.scrollTop, this.scrollTop + this.viewportRows);
		const body =
			visible.length > 0
				? visible.map((line) => truncateToWidth(this.styleLine(line), width))
				: [this.theme.fg("dim", "(empty)")];
		const footer = this.theme.fg(
			"dim",
			"↑/↓ scroll • PgUp/PgDn page • g/Home top • Shift+G/End bottom • q/Esc close",
		);

		const lines = [header, position, ...body, footer];
		this.cached = { width, lines };
		return lines;
	}

	/** Formats the "lines X-Y of Z" position indicator. */
	private positionLabel(total: number): string {
		const end = Math.min(total, this.scrollTop + this.viewportRows);
		return `lines ${total === 0 ? 0 : this.scrollTop + 1}-${end} of ${total}`;
	}

	/** Drops the render cache so the next paint reflects the scroll position. */
	invalidate(): void {
		this.cached = undefined;
	}
}

/**
 * Opens the diff viewer as a custom TUI component sized to the terminal.
 *
 * @param diff - Full diff text (one viewer row per line).
 * @param ctx - Command context providing the custom UI host.
 */
async function showDiffViewer(diff: string, ctx: ExtensionCommandContext): Promise<void> {
	await ctx.ui.custom((tui, theme, keybindings, done) => {
		const rows = diff.split("\n");
		const viewportRows = Math.max(3, tui.terminal.rows - 5);
		return new DiffViewer(theme, keybindings, () => done(undefined), () => tui.requestRender(), "D I F F", rows, viewportRows);
	});
}

/**
 * Writes the diff to a timestamped patch file in the OS temp directory.
 *
 * @returns Absolute path of the written patch file.
 */
async function writePatchFile(diff: string): Promise<string> {
	const path = join(tmpdir(), `pi-diff-${Date.now()}.patch`);
	await writeFile(path, diff, "utf8");
	return path;
}

/**
 * Registers the `/diff` command.
 *
 * Behavior by mode: TUI opens the scrollable viewer, print streams the diff
 * to stdout, other non-TUI modes write a patch file and notify.
 *
 * @param pi - Extension API used to register the command and run git.
 */
export function registerDiffCommand(pi: ExtensionAPI): void {
	pi.registerCommand("diff", {
		description: "Show git diff incl. untracked files (from codex)",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) ctx.ui.setStatus("codex-diff", "Computing diff...");
			const result = await getWorkingTreeDiff(pi.exec, ctx.cwd);
			if (ctx.hasUI) ctx.ui.setStatus("codex-diff", undefined);

			if (!result.ok) {
				if (ctx.hasUI) ctx.ui.notify(`/diff — ${result.error}`, "error");
				return;
			}
			let diff = result.diff;
			if (diff.trim().length === 0) {
				if (ctx.hasUI) ctx.ui.notify("No changes detected", "info");
				return;
			}
			if (diff.length > MAX_DIFF_CHARS) {
				diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncated at ${MAX_DIFF_CHARS} characters\n`;
			}

			if (ctx.mode === "tui") {
				await showDiffViewer(diff, ctx);
				return;
			}
			if (ctx.mode === "print") {
				// No TUI to corrupt in print mode; emit the diff for scripts.
				process.stdout.write(`${diff}\n`);
				return;
			}
			const path = await writePatchFile(diff);
			if (ctx.hasUI) ctx.ui.notify(`Diff written to ${path}`, "info");
		},
	});
}
