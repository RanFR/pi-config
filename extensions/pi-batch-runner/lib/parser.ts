/**
 * Manifest file parsing.
 *
 * Format specification (PLAN section 4):
 * - Task entries are separated by a lone `---` line (surrounding whitespace
 *   allowed); everything before the first `---` is ignored.
 * - If an entry's first line matches ^[(新会话|new)] or ^[(继续|continue)]
 *   (case-insensitive) it is a mode marker line; without a marker the default
 *   mode is "new session".
 * - Non-empty text after the marker on the marker line = task title; without
 *   a marker the entry's first non-empty line = title. All remaining non-empty
 *   lines form the prompt body. When an entry is a single line, title = first
 *   line of the body.
 * - After a bare marker line (no title) and before the title line, reserved
 *   field lines `key: value` are allowed (v1 only reserves the parsing slot
 *   for future extensions: recognized and ignored, no semantics). Once the
 *   title is set, `key: value` lines are always treated as body text, so
 *   ordinary content is never swallowed.
 * - Blank lines inside the prompt body are preserved; the body is trimmed at
 *   both ends.
 * - Line endings accept CRLF/LF; zero parsed tasks is an error.
 *
 * @module
 */

import { ManifestParseError, type BatchTask, type TaskMode } from "./types.ts";

export { ManifestParseError };

/** v1 reserved fields: ignored only when they appear between a bare marker line and the title line. */
const RESERVED_FIELD_KEYS = new Set(["model", "timeout", "retries", "max-turns", "on-exhaust"]);

const MARKER_RE = /^\s*\[(新会话|new|继续|continue)\]\s*(.*)$/i;
const FIELD_LINE_RE = /^([a-z][a-z0-9_-]*):\s*(.*)$/;
const SEPARATOR_RE = /^\s*---\s*$/;

/** Normalizes a raw marker into the task mode. */
function normalizeMode(marker: string): TaskMode {
	const m = marker.toLowerCase();
	if (m === "新会话" || m === "new") return "new";
	return "continue";
}

/**
 * Parses manifest text into a task list.
 *
 * @param content - Raw manifest file content.
 * @returns Parsed tasks in manifest order.
 * @throws {@link ManifestParseError} when zero tasks are found.
 */
export function parseManifest(content: string): BatchTask[] {
	const normalized = content.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");

	// Skip everything before the first --- separator
	let i = 0;
	while (i < lines.length && !SEPARATOR_RE.test(lines[i] ?? "")) i++;
	// Skip the first --- itself
	i++;

	const tasks: BatchTask[] = [];

	while (i < lines.length) {
		// Collect one entry (up to the next --- or end of file)
		const entryLines: string[] = [];
		while (i < lines.length && !SEPARATOR_RE.test(lines[i] ?? "")) {
			entryLines.push(lines[i] ?? "");
			i++;
		}
		i++; // Skip the separator

		if (entryLines.join("").trim() === "") continue; // Skip empty entries

		const task = parseEntry(entryLines, tasks.length + 1);
		if (task) tasks.push(task);
	}

	if (tasks.length === 0) {
		throw new ManifestParseError("清单中未找到任何任务：请确认文件以 --- 分隔任务条目");
	}
	return tasks;
}

/** Parses one entry; returns undefined for empty content (callers already filter empties; kept defensively). */
function parseEntry(entryLines: string[], oneBasedIndex: number): BatchTask | undefined {
	let mode: TaskMode = "new";
	let explicitTitle = "";
	let cursor = 0;

	// (1) Mode marker line (optional)
	const first = entryLines[0] ?? "";
	const markerMatch = MARKER_RE.exec(first);
	if (markerMatch) {
		mode = normalizeMode(markerMatch[1] ?? "");
		explicitTitle = (markerMatch[2] ?? "").trim();
		cursor = 1;

		// (2) Bare marker line: allow reserved field lines before the title for future extensions
		if (explicitTitle === "") {
			while (cursor < entryLines.length) {
				const line = (entryLines[cursor] ?? "").trim();
				if (line === "") {
					cursor++;
					continue;
				}
				const fieldMatch = FIELD_LINE_RE.exec(line);
				if (fieldMatch && RESERVED_FIELD_KEYS.has(fieldMatch[1] ?? "")) {
					cursor++; // Reserved field: ignore
					continue;
				}
				break; // First non-field text line = title
			}
			if (cursor < entryLines.length) {
				explicitTitle = (entryLines[cursor] ?? "").trim();
				cursor++;
			}
		}
	} else {
		// (3) No marker: first non-empty line = title
		while (cursor < entryLines.length && (entryLines[cursor] ?? "").trim() === "") cursor++;
		if (cursor < entryLines.length) {
			explicitTitle = (entryLines[cursor] ?? "").trim();
			cursor++;
		}
	}

	// (4) Remaining lines form the body
	const body = entryLines
		.slice(cursor)
		.join("\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "")
		.trim();

	if (explicitTitle === "" && body === "") {
		// Marker present but no content at all: an empty entry is an explicit
		// authoring error, so throw instead of skipping silently
		if (markerMatch) {
			throw new ManifestParseError(`任务 ${oneBasedIndex} 提示词正文为空`, oneBasedIndex);
		}
		return undefined;
	}

	// Title fallback: single-line entry, title = first line of the body (the line doubles as the prompt)
	let title: string;
	let prompt: string;
	if (explicitTitle !== "") {
		title = explicitTitle;
		prompt = body !== "" ? body : explicitTitle;
	} else {
		title = firstLineOf(body);
		prompt = body;
	}

	if (prompt === "") {
		throw new ManifestParseError(`任务 ${oneBasedIndex}（${title}）提示词正文为空`, oneBasedIndex);
	}

	return { index: oneBasedIndex, mode, title, prompt };
}

/** Returns the first line of `text`, trimmed. */
function firstLineOf(text: string): string {
	const idx = text.indexOf("\n");
	return (idx === -1 ? text : text.slice(0, idx)).trim();
}

/**
 * Splits command arguments into tokens; supports double-quoted paths
 * containing spaces.
 */
export function tokenizeArgs(raw: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) {
		tokens.push(m[1] ?? m[2] ?? "");
	}
	return tokens;
}
