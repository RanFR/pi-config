/**
 * Execution engine (core).
 *
 * Design notes (PLAN sections 6/7, all verified against pi 1.4.0 sources):
 *
 * 1. The engine is driven by the /batch command handler: newSession/
 *    switchSession/waitForIdle may only be called from a command-handler
 *    context (calling them from event handlers deadlocks). The agent_settled
 *    subscription is used for signaling only.
 * 2. "New session" boundaries advance through the
 *    ctx.newSession({ withSession }) callback chain: inside the callback, use
 *    the fresh context's sendUserMessage / waitForIdle / newSession / ui.
 *    Only pure data (task records, configuration) crosses a boundary.
 *    Callback chain depth = number of "new session" boundaries; consecutive
 *    tasks in the same session are handled by a while loop inside the callback.
 * 3. Completion detection: subscribe to agent_settled first (via the injected
 *    SettledBus; subscribe before sending), then wait for settled after
 *    sending; after settled, waitForIdle() acts as a second check (pi's
 *    internal waitForIdle resolves only after agent_settled dispatch
 *    completes, and the Promise of ReplacedSessionContext.sendUserMessage
 *    also resolves only when the whole run ends — the two paths cross-check
 *    each other). Send-failure watchdog: still isIdle with no settled after
 *    the timeout → treat as a failure.
 * 4. Failure detection reads the stopReason of the last assistant message on
 *    the branch ("error"/"aborted"); settled.aborted means the user pressed Esc.
 * 5. Batch state uses the progress file as the single source of truth; this
 *    module holds no module-level state that survives across sessions.
 *
 * @module
 */

import * as fs from "node:fs";
import * as progress from "./progress.ts";
import * as report from "./report.ts";
import {
	PENDING_DRAIN_TIMEOUT_MS,
	RETRY_DELAY_MS,
	type BatchContext,
	type BatchLeg,
	type BatchState,
	type EngineDeps,
	type TaskRecord,
} from "./types.ts";

/** Batch stop control (held by index.ts's activeBatch; worst case of losing it is a broken re-entrancy guard). */
export interface StopHandle {
	/** "no" = running normally; "gentle" = stop after the current task ends naturally; "now" = abort the current task and stop. */
	stopFlag: "no" | "gentle" | "now";
	/** Ensures the summary runs exactly once. */
	finalized: boolean;
}

/** Creates a fresh stop handle (stopFlag = "no", not finalized). */
export function createStopHandle(): StopHandle {
	return { stopFlag: "no", finalized: false };
}

/**
 * Where the batch starts.
 * - "direct": continue from item `index` (0-based) on the current leg (the
 *   engine handles new-session boundaries inside its loop);
 * - "fresh": open a new session first, then continue from `index` (fallback
 *   when resuming and the previous session of a "continue" task is lost);
 * - "switch": switch to the given session file first, then continue from
 *   `index` (resuming reattaches to the original session).
 */
export type StartPoint =
	| { kind: "direct"; index: number }
	| { kind: "fresh"; index: number }
	| { kind: "switch"; sessionFile: string; index: number };

/** Outcome of a single attempt. */
type Outcome = "ok" | "error" | "aborted" | "send-failed";

/** Result of a single attempt. */
interface AttemptResult {
	/** What happened during the attempt. */
	outcome: Outcome;
	/** Error summary, when the attempt failed. */
	error?: string;
}

/** Extracts a message from an unknown thrown value. */
function msgOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Diagnostic log: appends to /tmp/pi-batch-debug.log when PI_BATCH_DEBUG=1. */
function debug(msg: string): void {
	if (!process.env.PI_BATCH_DEBUG) return;
	try {
		fs.appendFileSync("/tmp/pi-batch-debug.log", `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// ignore
	}
}

/** Flattens whitespace and truncates an error message, with a fallback label. */
function shortError(text: string | undefined, max = 120): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	if (!flat) return "未知错误";
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Returns the base name of a path. */
function fileName(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? p : p.slice(idx + 1);
}

/** Fills in default dependencies (now/sleep/bell). */
function withDefaults(deps: EngineDeps): Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps {
	return {
		...deps,
		now: deps.now ?? (() => Date.now()),
		sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
		bell: deps.bell ?? (() => {
			try {
				process.stdout.write("\x07");
			} catch {
				// No terminal: safe to ignore
			}
		}),
	};
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Starts a batch: dispatches on the start point (direct/fresh/switch) and
 * enters the execution loop; guarantees exactly one finalization.
 */
export async function startBatch(
	deps: EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	start: StartPoint,
	stop: StopHandle,
): Promise<void> {
	const d = withDefaults(deps);
	try {
		if (start.kind === "switch") {
			await startWithSwitch(d, leg, state, start.sessionFile, start.index, stop);
			return;
		}
		if (start.kind === "fresh") {
			await startWithFresh(d, leg, state, start.index, stop);
			return;
		}
		await runFrom(d, leg, state, start.index, stop);
	} catch (e) {
		// Engine-level safety net: finalize on any unexpected error (summary + activeBatch cleanup)
		try {
			await finalizeBatch(d, leg, state, stop, `内部错误：${shortError(msgOf(e))}`);
		} catch {
			deps.onBatchEnd?.();
		}
	}
}

/** Resume: switch to the previous task's session file; falls back to a fresh session on failure. */
async function startWithSwitch(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	sessionFile: string,
	index: number,
	stop: StopHandle,
): Promise<void> {
	let entered = false;
	let switchError: unknown;
	try {
		const res = await leg.ctx.switchSession(sessionFile, {
			withSession: async (fresh) => {
				entered = true;
				await runFrom(d, fresh, state, index, stop);
			},
		});
		if (!entered || res.cancelled) {
			await finalizeBatch(d, leg, state, stop, "会话切换被取消");
		}
		return;
	} catch (e) {
		switchError = e;
	}
	// Fallback: run in a fresh session
	leg.ctx.ui.notify(`无法恢复会话 ${fileName(sessionFile)}：${shortError(msgOf(switchError))}，改为新会话执行`, "warning");
	await startWithFresh(d, leg, state, index, stop);
}

/** Continues in a fresh session (shared by the fallback path and resumes whose first task is "new"). */
async function startWithFresh(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	index: number,
	stop: StopHandle,
): Promise<void> {
	const res = await leg.ctx.newSession({
		name: `${state.batchTitle} · 任务${state.tasks[index]?.index ?? index + 1} ${state.tasks[index]?.title ?? ""}`.trimEnd(),
		withSession: async (fresh) => {
			await runFrom(d, fresh, state, index, stop);
		},
	});
	if (res.cancelled) {
		await finalizeBatch(d, leg, state, stop, "会话切换被取消");
	}
}

// ============================================================================
// Execution loop (advances through the callback chain)
// ============================================================================

/**
 * Executes starting from task i (0-based).
 *
 * On a "new session" task: newSession (with a session name) → inside the
 * callback, run this task first, then keep looping; once the callback
 * returns, the old leg simply ends (return — no further advancing, no
 * finalization; finalization is done by the deepest leg).
 * "Continue" tasks (and a first task marked continue): send in the current
 * session directly.
 */
async function runFrom(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	startIndex: number,
	stop: StopHandle,
): Promise<void> {
	let i = startIndex;
	while (i < state.tasks.length) {
		if (stop.stopFlag === "gentle") break; // Gentle stop: do not advance further

		const record = state.tasks[i]!;
		if (record.mode === "new") {
			progress.saveProgress(state);
			const res = await leg.ctx.newSession({
				name: `${state.batchTitle} · 任务${record.index} ${record.title}`,
				withSession: async (fresh) => {
					// This task runs in the brand-new session; subsequent tasks keep advancing inside the same callback chain
					const action = await runTask(d, fresh, state, i, stop);
					if (action === "advance") {
						await runFrom(d, fresh, state, i + 1, stop);
					} else {
						await finalizeBatch(d, fresh, state, stop);
					}
				},
			});
			if (res.cancelled) {
				await finalizeBatch(d, leg, state, stop, "会话切换被取消");
			}
			return; // Control has been handed to the fresh callback
		}

		const action = await runTask(d, leg, state, i, stop);
		if (action === "advance") {
			i++;
			continue;
		}
		break; // stop / terminate → finalize
	}
	await finalizeBatch(d, leg, state, stop);
}

// ============================================================================
// Single task execution: attempt loop + retries + pause prompt
// ============================================================================

/** What the caller should do after a task's attempt loop returns. */
type TaskAction = "advance" | "stop" | "terminate";

/**
 * Runs one task through its full attempt loop: retries, pause prompts on
 * user abort, and exhaustion handling driven by state.onExhaust.
 *
 * @returns The action the execution loop should take next.
 */
async function runTask(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	i: number,
	stop: StopHandle,
): Promise<TaskAction> {
	const record = state.tasks[i]!;
	let lastStatusAt = 0;

	for (;;) {
		if (stop.stopFlag === "gentle") return "stop";
		debug(`runTask task=${record.index} attempt=${record.attempts} stop=${stop.stopFlag}`);

		if (record.status === "pending") {
			// First start (including tasks reset for resume); manual retries do not reset the count
			record.status = "running";
			record.attempts = 0;
			record.startedAt = d.now();
			record.endedAt = undefined;
			record.sessionFile = leg.ctx.sessionManager.getSessionFile() ?? record.sessionFile;
			progress.saveProgress(state);
		}
		record.attempts++;
		progress.saveProgress(state);
		leg.ctx.ui.setStatus("batch", report.statusText(state, d.now()));

		const result = await attemptOnce(d, leg, state, record, () => {
			const nowMs = d.now();
			if (nowMs - lastStatusAt >= 5_000) {
				lastStatusAt = nowMs;
				leg.ctx.ui.setStatus("batch", report.statusText(state, nowMs));
			}
		});
		debug(`runTask task=${record.index} outcome=${result.outcome}`);

		if (result.outcome === "ok") {
			record.status = "ok";
			record.endedAt = d.now();
			record.sessionFile = leg.ctx.sessionManager.getSessionFile() ?? record.sessionFile;
			record.error = undefined;
			progress.saveProgress(state);
			leg.ctx.ui.setStatus("batch", report.statusText(state, d.now()));
			return "advance";
		}

		if (result.outcome === "aborted") {
			record.error = "用户中断（Esc）";
			progress.saveProgress(state);
			if (stop.stopFlag === "now") {
				// stop --now: explicit stop intent — no prompting, terminate the whole batch
				record.status = "failed";
				record.endedAt = d.now();
				record.error = "批次被停止（stop --now）";
				progress.saveProgress(state);
				return "terminate";
			}
			d.bell();
			const choice = await leg.ctx.ui.select(
				`任务 ${record.index} 被手动中断：${record.title}`,
				["重试本条", "跳过，继续下一条", "终止整批"],
			);
			if (choice === "重试本条") {
				await d.sleep(RETRY_DELAY_MS);
				continue;
			}
			if (choice === "跳过，继续下一条") {
				record.status = "skipped";
				record.endedAt = d.now();
				progress.saveProgress(state);
				return "advance";
			}
			record.status = "failed";
			record.endedAt = d.now();
			progress.saveProgress(state);
			return "terminate";
		}

		// error / send-failed: record the error and retry
		record.error = result.error;
		progress.saveProgress(state);

		if (record.attempts <= state.retries) {
			leg.ctx.ui.notify(
				`任务 ${record.index} 失败（第 ${record.attempts}/${state.retries + 1} 次）：${shortError(result.error)}，${Math.round(RETRY_DELAY_MS / 1000)}s 后重试…`,
				"warning",
			);
			await d.sleep(RETRY_DELAY_MS);
			continue;
		}

		// Retries exhausted
		record.status = "failed";
		record.endedAt = d.now();
		progress.saveProgress(state);

		if (state.onExhaust === "skip") return "advance";
		if (state.onExhaust === "abort") return "terminate";

		// pause: show a selection dialog (no timeout, waits for a human; Esc counts as terminate)
		d.bell();
		const choice = await leg.ctx.ui.select(
			`任务 ${record.index} 重试耗尽（已尝试 ${record.attempts} 次）：${record.title}\n${shortError(result.error)}`,
			["重试本条(同会话)", "跳过，继续下一条", "终止整批"],
		);
		if (choice === "重试本条(同会话)") {
			continue;
		}
		if (choice === "跳过，继续下一条") return "advance";
		return "terminate";
	}
}

// ============================================================================
// Single attempt: drain queue → subscribe → send → wait for settled → judge
// ============================================================================

/**
 * Performs a single send-and-wait attempt.
 *
 * Steps: drain pending messages → subscribe to settled → send → wait for
 * settled / send failure / watchdog → final waitForIdle → judge the outcome
 * from the last assistant message.
 */
async function attemptOnce(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	record: TaskRecord,
	onTick: () => void,
): Promise<AttemptResult> {
	// (0) If messages are queued or a run is in flight before sending, wait for it to drain (with a deadline to avoid waiting forever)
	const drainDeadline = d.now() + PENDING_DRAIN_TIMEOUT_MS;
	while (leg.ctx.hasPendingMessages()) {
		await leg.ctx.waitForIdle();
		if (!leg.ctx.hasPendingMessages()) break;
		if (d.now() > drainDeadline) {
			return { outcome: "send-failed", error: "等待既有排队消息消化超时（5 分钟），已放弃本次发送" };
		}
		await d.sleep(200);
	}
	await leg.ctx.waitForIdle(); // Make sure we are idle before sending

	// (1) Subscribe before sending (race safety: the settled listener must be attached before send)
	let settledEvent: { aborted: boolean } | undefined;
	let resolveSettled: () => void = () => {};
	const settledP = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});
	const off = d.settled.subscribe((e) => {
		debug(`settled received task=${record.index}`);
		settledEvent = e;
		resolveSettled();
	});

	// (2) Send the prompt (expandPromptTemplates: true, matching manual input behavior)
	let sendPromise: Promise<void> | undefined;
	try {
		const ret: void | Promise<void> = leg.send(record.prompt, { expandPromptTemplates: true });
		debug(`send task=${record.index} promise=${ret instanceof Object ? "yes" : "void"}`);
		if (ret && typeof (ret as Promise<void>).then === "function") {
			sendPromise = ret as Promise<void>;
		}
	} catch (e) {
		off();
		return { outcome: "send-failed", error: `发送失败：${shortError(msgOf(e))}` };
	}

	let sendResolved = false;
	let sendError: unknown;
	const sendP = sendPromise
		? sendPromise.then(
				() => {
					sendResolved = true;
				},
				(e: unknown) => {
					sendError = e;
				},
			)
		: undefined;

	// (3) Wait for settled / send failure / watchdog
	const startedAt = d.now();
	const timeoutMs = d.sendFailTimeoutMs ?? 10_000;
	try {
		for (;;) {
			const racers: Promise<"settled" | "send" | "tick">[] = [
				settledP.then(() => "settled" as const),
				d.sleep(500).then(() => "tick" as const),
			];
			// Do not re-enqueue sendP once settled: avoids a tight no-backoff loop when the send branch resolves early
			if (sendP && !sendResolved && sendError === undefined) racers.push(sendP.then(() => "send" as const));
			const winner = await Promise.race(racers);

			if (winner === "settled") break;
			if (winner === "send") {
				if (sendError !== undefined) {
					return { outcome: "send-failed", error: `发送失败：${shortError(msgOf(sendError))}` };
				}
				if (!settledEvent) {
					debug(`early-send-resolve task=${record.index}`);
					// Extreme cases (message queued/delayed): the send promise resolved
					// early but the turn has not settled yet; back off and keep waiting
					// (sendP is no longer enqueued; ticks drive the loop from here on)
					await d.sleep(250);
					continue;
				}
				break;
			}
			// tick: refresh the status bar + send-failure watchdog
			onTick();
			if (!settledEvent && d.now() - startedAt > timeoutMs && leg.ctx.isIdle() && (!sendP || sendResolved)) {
				return {
					outcome: "send-failed",
					error: `发送后 ${Math.round(timeoutMs / 1000)}s 内未开始任何运行（请检查模型与认证配置）`,
				};
			}
		}
	} finally {
		off();
	}

	// (4) Second check: waitForIdle after settled (normally returns immediately; new messages queued meanwhile wait for their own completion)
	await leg.ctx.waitForIdle();

	// (5) Judge the outcome
	if (settledEvent?.aborted) return { outcome: "aborted" };
	const last = lastAssistantMessage(leg.ctx);
	if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
		return {
			outcome: "error",
			error: last.errorMessage || `模型停止原因：${last.stopReason}`,
		};
	}
	return { outcome: "ok" };
}

/** Last assistant message on the current branch (with stopReason / errorMessage). */
export function lastAssistantMessage(ctx: BatchContext): { stopReason?: string; errorMessage?: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let k = branch.length - 1; k >= 0; k--) {
		const entry = branch[k]!;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			return entry.message;
		}
	}
	return undefined;
}

// ============================================================================
// Finalization
// ============================================================================

/** Finalizes the batch: notify + widget + report.md + progress rename + state cleanup. Idempotent. */
export async function finalizeBatch(
	d: Required<Pick<EngineDeps, "now" | "sleep" | "bell">> & EngineDeps,
	leg: BatchLeg,
	state: BatchState,
	stop: StopHandle,
	reasonNote?: string,
): Promise<void> {
	if (stop.finalized) return;
	stop.finalized = true;

	const endedAt = d.now();

	// Defensive: no task should be left "running" here
	for (const t of state.tasks) {
		if (t.status === "running") {
			t.status = "pending";
			t.endedAt = endedAt;
			t.error = t.error ?? "批次提前结束";
		}
	}
	progress.saveProgress(state);

	const counts = report.countTasks(state);
	const line = reasonNote ? `${report.summaryLine(state)}（${reasonNote}）` : report.summaryLine(state);
	try {
		d.bell();
		leg.ctx.ui.notify(line, counts.failed > 0 ? "warning" : "info");
		leg.ctx.ui.setWidget("batch-summary", report.widgetLines(state, endedAt));
	} catch (e) {
		// UI unavailable: best effort, the report is still written below
	}

	try {
		progress.writeReport(state.listFile, report.renderReportMarkdown(state, endedAt));
	} catch (e) {
		try {
			leg.ctx.ui.notify(`汇总报告写入失败：${shortError(msgOf(e))}`, "warning");
		} catch {
			// ignore
		}
	}
	try {
		progress.finishProgress(state.listFile);
	} catch {
		// Rename failure: keep the original progress file
	}
	try {
		leg.ctx.ui.setStatus("batch", undefined);
	} catch {
		// ignore
	}
	d.onBatchEnd?.();
}
