/**
 * Progress file and report I/O.
 *
 * - Progress file: `<manifest>.progress.json` — the on-disk mirror of
 *   BatchState and the single source of truth for batch state (the extension
 *   factory re-runs on every session replacement, so state captured inside
 *   the factory body is unreliable; see the module-level state notes in
 *   index.ts and PLAN pitfall 5).
 * - When the batch finishes, the file is renamed to
 *   `<manifest>.progress.done.json` so the next run does not mistakenly
 *   trigger the resume prompt.
 * - Report: `<manifest>.report.md`.
 *
 * All writes are synchronous (the task count is small, so full rewrites are
 * fine); callers are expected to handle IO exceptions.
 *
 * @module
 */

import * as fs from "node:fs";
import type { BatchState, ProgressFile } from "./types.ts";
import { progressPathFor, reportPathFor } from "./types.ts";

/**
 * Loads an unfinished progress file.
 *
 * @returns The parsed file, or null when it does not exist, is corrupt, or
 *   has an unexpected schema.
 */
export function loadProgress(listFile: string): ProgressFile | null {
	const path = progressPathFor(listFile);
	try {
		if (!fs.existsSync(path)) return null;
		const raw = fs.readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as ProgressFile;
		if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Writes the progress file (full rewrite). */
export function saveProgress(state: BatchState): void {
	state.updatedAt = Date.now();
	const file: ProgressFile = { schemaVersion: 1, ...state };
	fs.writeFileSync(progressPathFor(state.listFile), JSON.stringify(file, null, "\t"), "utf-8");
}

/**
 * Finalizes the batch: renames progress → `.progress.done.json`.
 *
 * @returns The done-file path, or null when the source file does not exist.
 */
export function finishProgress(listFile: string): string | null {
	const from = progressPathFor(listFile);
	const to = `${from}.done`;
	if (!fs.existsSync(from)) return null;
	fs.renameSync(from, to);
	return to;
}

/** Backs up a stale `.progress.done.json` (used when restarting from scratch). */
export function backupDoneProgress(listFile: string): void {
	const donePath = `${progressPathFor(listFile)}.done`;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	try {
		if (fs.existsSync(donePath)) fs.renameSync(donePath, `${donePath}.${stamp}.bak`);
	} catch {
		// Backup failure must not block the main flow
	}
}

/** Writes the summary report markdown. */
export function writeReport(listFile: string, content: string): void {
	fs.writeFileSync(reportPathFor(listFile), content, "utf-8");
}

// ============================================================================
// (The pendingName/session_start naming mechanism from PLAN 6.7 was replaced
// by newSession({ setup }) writing directly into the sessionManager: the old
// pi facade goes stale after a session replacement (fatal in practice), and
// pi.setSessionName is unavailable inside session_start handlers, so the
// file-based relay mechanism was abandoned.)
// ============================================================================
