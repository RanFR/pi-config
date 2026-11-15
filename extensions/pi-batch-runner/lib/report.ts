/**
 * Summary rendering: status-bar text, the summary widget, and report.md.
 *
 * @module
 */

import type { BatchState, TaskRecord } from "./types.ts";

/** Formats milliseconds as 4m12s / 12s / 1h02m. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "-";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Task counts by status for the whole batch. */
export interface BatchCounts {
	/** Tasks that succeeded. */
	ok: number;
	/** Tasks that failed. */
	failed: number;
	/** Tasks that were skipped. */
	skipped: number;
	/** Tasks not yet run. */
	pending: number;
	/** Tasks currently running. */
	running: number;
	/** Total number of tasks. */
	total: number;
}

/** Counts tasks by status. */
export function countTasks(state: BatchState): BatchCounts {
	const counts: BatchCounts = { ok: 0, failed: 0, skipped: 0, pending: 0, running: 0, total: state.tasks.length };
	for (const t of state.tasks) {
		if (t.status === "ok") counts.ok++;
		else if (t.status === "failed") counts.failed++;
		else if (t.status === "skipped") counts.skipped++;
		else if (t.status === "running") counts.running++;
		else counts.pending++;
	}
	return counts;
}

const STATUS_ICON: Record<TaskRecord["status"], string> = {
	pending: "·",
	running: "▶",
	ok: "✓",
	failed: "✗",
	skipped: "»",
};

const STATUS_LABEL: Record<TaskRecord["status"], string> = {
	pending: "未执行",
	running: "进行中",
	ok: "成功",
	failed: "失败",
	skipped: "跳过",
};

const MODE_LABEL: Record<TaskRecord["mode"], string> = {
	new: "新会话",
	continue: "继续",
};

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Status-bar text while running: `[batch] task 3/10 · title · attempt 1 · 4m12s`. */
export function statusText(state: BatchState, now: number): string {
	const current = state.tasks.find((t) => t.status === "running");
	if (!current) {
		const counts = countTasks(state);
		return `[batch] ${state.batchTitle} · 完成 ${counts.ok + counts.failed + counts.skipped}/${counts.total}`;
	}
	const elapsed = current.startedAt ? formatDuration(now - current.startedAt) : "-";
	return `[batch] 任务 ${current.index}/${state.tasks.length} · ${truncate(current.title, 24)} · 第${current.attempts}次尝试 · ${elapsed}`;
}

/** One-line summary for the completion notification. */
export function summaryLine(state: BatchState): string {
	const c = countTasks(state);
	const parts = [`成功 ${c.ok}`];
	if (c.failed > 0) parts.push(`失败 ${c.failed}`);
	if (c.skipped > 0) parts.push(`跳过 ${c.skipped}`);
	if (c.pending > 0) parts.push(`未执行 ${c.pending}`);
	return `批次「${state.batchTitle}」结束：${parts.join(" / ")}`;
}

/** Persistent widget lines shown above the editor. */
export function widgetLines(state: BatchState, now: number): string[] {
	const lines: string[] = [];
	lines.push(`── 批处理 · ${state.batchTitle} · ${summaryLine(state)}`);
	const max = 30;
	for (const t of state.tasks) {
		let extra = "";
		if (t.status === "running") {
			extra = ` 第${t.attempts}次尝试 · ${t.startedAt ? formatDuration(now - t.startedAt) : "-"}`;
		} else if (t.status === "ok" || t.status === "failed") {
			const dur = t.startedAt && t.endedAt ? formatDuration(t.endedAt - t.startedAt) : "-";
			extra = ` ${t.attempts}次 · ${dur}`;
		}
		if (t.error) extra += ` · ${truncate(t.error, 40)}`;
		const sessionName = t.sessionFile ? truncate(fileName(t.sessionFile), 18) : "";
		const sessionPart = t.mode === "continue" ? "" : sessionName ? ` [${sessionName}]` : "";
		lines.push(`${STATUS_ICON[t.status]} ${String(t.index).padStart(2, " ")} [${MODE_LABEL[t.mode]}] ${truncate(t.title, max)}${sessionPart}${extra}`);
	}
	return lines;
}

function fileName(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? p : p.slice(idx + 1);
}

/** Renders the full summary report as markdown. */
export function renderReportMarkdown(state: BatchState, endedAt: number): string {
	const c = countTasks(state);
	const out: string[] = [];
	out.push(`# 批处理报告 · ${state.batchTitle}`);
	out.push("");
	out.push(`- 清单文件：\`${state.listFile}\``);
	out.push(`- 开始时间：${new Date(state.startedAt).toLocaleString()}`);
	out.push(`- 结束时间：${new Date(endedAt).toLocaleString()}`);
	out.push(`- 总耗时：${formatDuration(endedAt - state.startedAt)}`);
	out.push(`- 重试次数：${state.retries} · 耗尽行为：${state.onExhaust}`);
	out.push(`- 结果：成功 ${c.ok} / 失败 ${c.failed} / 跳过 ${c.skipped}${c.pending > 0 ? ` / 未执行 ${c.pending}` : ""}（共 ${c.total}）`);
	out.push("");
	out.push("| # | 模式 | 任务 | 状态 | 尝试 | 耗时 | 会话文件 | 错误 |");
	out.push("|---|------|------|------|------|------|----------|------|");
	for (const t of state.tasks) {
		const dur = t.startedAt && t.endedAt ? formatDuration(t.endedAt - t.startedAt) : "-";
		const session = t.sessionFile ? `\`${fileName(t.sessionFile)}\`` : "";
		const err = t.error ? truncate(t.error.replace(/\|/g, "\\|"), 80) : "";
		out.push(
			`| ${t.index} | ${MODE_LABEL[t.mode]} | ${truncate(t.title, 40)} | ${STATUS_LABEL[t.status]} | ${t.attempts} | ${dur} | ${session} | ${err} |`,
		);
	}
	out.push("");
	out.push("> 由 pi-batch-runner 扩展生成");
	return out.join("\n");
}
