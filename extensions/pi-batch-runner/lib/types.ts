/**
 * Shared types for the pi-batch-runner extension.
 *
 * This module contains pure data shapes and narrow interfaces only. It does
 * not depend on pi's types (every module under lib/ stays dependency-free,
 * using Node built-ins exclusively), so unit tests can drive the executor
 * with hand-written fakes. Real pi types are structurally adapted in the
 * index.ts entry point only.
 *
 * @module
 */

// ============================================================================
// Manifest parsing results
// ============================================================================

/** Session mode of a single task. */
export type TaskMode = "new" | "continue";

/** One task parsed from the manifest file. */
export interface BatchTask {
	/** 1-based position (order in the manifest). */
	index: number;
	/** Session mode: "new" = fresh session; "continue" = reuse the previous task's session. */
	mode: TaskMode;
	/** Task title (used for the status bar, progress, report, and session naming). */
	title: string;
	/** Prompt body (multi-line, trimmed at both ends). */
	prompt: string;
}

/** Thrown when manifest parsing fails. */
export class ManifestParseError extends Error {
	/**
	 * @param message - Human-readable failure description.
	 * @param line - 1-based manifest line associated with the failure, if known.
	 */
	constructor(
		message: string,
		public readonly line?: number,
	) {
		super(message);
		this.name = "ManifestParseError";
	}
}

// ============================================================================
// Batch state (in-memory object mirrored to the progress file on disk)
// ============================================================================

/** Lifecycle status of a task within the batch. */
export type TaskStatus = "pending" | "running" | "ok" | "failed" | "skipped";

/**
 * Execution record of a single task (mirrored in the progress file; the prompt
 * is kept too, so resuming is self-contained).
 */
export interface TaskRecord {
	/** 1-based position (order in the manifest). */
	index: number;
	/** Session mode of the task. */
	mode: TaskMode;
	/** Task title. */
	title: string;
	/** Prompt body (from manifest parsing). */
	prompt: string;
	/** Current lifecycle status. */
	status: TaskStatus;
	/** Attempts made so far (failed retries included; the successful attempt counts too). */
	attempts: number;
	/** Session file path of the most recent attempt. */
	sessionFile?: string;
	/** Error summary of the most recent failure. */
	error?: string;
	/** Epoch ms when the task first started. */
	startedAt?: number;
	/** Epoch ms when the task reached a terminal status. */
	endedAt?: number;
}

/** Behavior when a task exhausts its retries. */
export type OnExhaust = "pause" | "skip" | "abort";

/** Running state of a batch. The progress-file schema is this shape plus `schemaVersion`. */
export interface BatchState {
	/** Absolute path of the manifest file. */
	listFile: string;
	/** Batch title (manifest file name without extension). */
	batchTitle: string;
	/** Epoch ms when the batch started. */
	startedAt: number;
	/** Epoch ms of the last progress write. */
	updatedAt: number;
	/** Retry budget per task. */
	retries: number;
	/** Behavior when retries are exhausted. */
	onExhaust: OnExhaust;
	/** Per-task records, in manifest order. */
	tasks: TaskRecord[];
}

/** Content of the progress file (BatchState plus a schema version). */
export interface ProgressFile extends BatchState {
	schemaVersion: 1;
}

/** Progress file path: `<manifest>.progress.json`. */
export function progressPathFor(listFile: string): string {
	return `${listFile}.progress.json`;
}

/** Report file path: `<manifest>.report.md`. */
export function reportPathFor(listFile: string): string {
	return `${listFile}.report.md`;
}

/** True when the status is final ("ok", "failed", or "skipped"). */
export function isTerminalStatus(status: TaskStatus): boolean {
	return status === "ok" || status === "failed" || status === "skipped";
}

// ============================================================================
// Narrow context views required by the executor
//
// The real ExtensionCommandContext / ReplacedSessionContext are adapted into
// BatchContext in index.ts (exposing only the methods the executor uses);
// unit tests implement the same interface with plain objects.
// ============================================================================

/** UI operations used by the executor (subset of pi's extension UI). */
export interface BatchUi {
	/** Shows a selection dialog; resolves to undefined when dismissed. */
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Shows a transient notification. */
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Sets or clears a status-bar entry. */
	setStatus(key: string, text: string | undefined): void;
	/** Sets or clears a persistent widget above the editor. */
	setWidget(key: string, content: string[] | undefined): void;
}

/** Narrow read-only view of a session branch entry (used to judge outcomes). */
export interface BranchEntryView {
	/** Entry type (e.g. "message"). */
	type: string;
	/** Message fields inspected by the executor, when the entry is a message. */
	message?: {
		/** Message role (e.g. "assistant"). */
		role: string;
		/** Stop reason of the last model turn ("error"/"aborted" indicate failure). */
		stopReason?: string;
		/** Error detail when the turn failed. */
		errorMessage?: string;
	};
}

/**
 * Session context as the executor sees it (structural subset of
 * ExtensionCommandContext / ReplacedSessionContext).
 *
 * After a "new session" boundary, the context handed to the withSession
 * callback is adapted to this interface as well.
 */
export interface BatchContext {
	/** True when the agent has no run in flight. */
	isIdle(): boolean;
	/** True when messages are queued but have not started running yet. */
	hasPendingMessages(): boolean;
	/** Resolves once all in-flight runs have finished. */
	waitForIdle(): Promise<void>;
	/** Aborts the current run (equivalent to the user pressing Esc). */
	abort(): void;
	readonly sessionManager: {
		/** Session file path, or undefined for a brand-new session. */
		getSessionFile(): string | undefined;
		/** Entries of the active branch (oldest first). */
		getBranch(): readonly BranchEntryView[];
	};
	readonly ui: BatchUi;
	/**
	 * Starts a fresh session. The withSession callback receives a complete
	 * BatchLeg (new context + matching send function); the executor advances
	 * subsequent tasks inside the callback, and the old leg becomes invalid
	 * once the callback returns. `name` is the new session's display name,
	 * written via newSession's setup hook directly into the session manager
	 * (the old pi facade is stale after the replacement).
	 */
	newSession(options: {
		name?: string;
		withSession: (freshLeg: BatchLeg) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
	/**
	 * Switches to an existing session file. The withSession callback semantics
	 * match {@link BatchContext.newSession}.
	 */
	switchSession(
		sessionPath: string,
		options: { withSession: (freshLeg: BatchLeg) => Promise<void> },
	): Promise<{ cancelled: boolean }>;
}

/**
 * Prompt-sending function.
 *
 * - The first leg uses pi.sendUserMessage (returns void; errors are swallowed
 *   and reported by the pi runtime).
 * - After a session switch it uses ReplacedSessionContext.sendUserMessage
 *   (returns a Promise that resolves only when the run finishes).
 *
 * The executor tolerates both: a returned Promise is treated as an extra
 * completion signal.
 */
export interface BatchSend {
	(content: string, options?: { expandPromptTemplates?: boolean }): void | Promise<void>;
}

/** One execution leg: an active session context plus its send function. */
export interface BatchLeg {
	ctx: BatchContext;
	send: BatchSend;
}

// ============================================================================
// Executor dependencies (injectable for testing)
// ============================================================================

/**
 * Source of `agent_settled` events. index.ts subscribes once during the
 * factory phase and bridges to a module-level listener slot, so runtime
 * subscribe/unsubscribe never touch the pi facade (which goes stale after a
 * session replacement).
 */
export interface SettledBus {
	/** Registers a listener; returns its unsubscribe function. The event carries `aborted` (true when the user aborted). */
	subscribe(cb: (event: { aborted: boolean }) => void): () => void;
}

/** Dependencies injectable into the executor. */
export interface EngineDeps {
	/** Settled-event source (subscribing before sending is essential). */
	settled: SettledBus;
	/** Clock in milliseconds; defaults to Date.now. */
	now?: () => number;
	/** Sleep; defaults to setTimeout. Tests can inject an instantly-resolved version. */
	sleep?: (ms: number) => Promise<void>;
	/** Send-failure watchdog window in milliseconds; defaults to 10_000. Tests can shrink it. */
	sendFailTimeoutMs?: number;
	/** Terminal bell; defaults to process.stdout.write("\x07"). */
	bell?: () => void;
	/** Called after the batch is finalized (index.ts clears activeBatch here). */
	onBatchEnd?: () => void;
}

// ============================================================================
// Command configuration
// ============================================================================

/** /batch launch configuration (parsed CLI arguments plus defaults). */
export interface RunConfig {
	/** Retry budget per task (--retries). */
	retries: number;
	/** Behavior when retries are exhausted (--on-exhaust). */
	onExhaust: OnExhaust;
	/** 1-based first task to run (--start). */
	startAt: number;
	/** Preview only, no execution (--dry-run). */
	dryRun: boolean;
}

/** Default retry budget per task. */
export const DEFAULT_RETRIES = 3;
/** Default behavior when retries are exhausted. */
export const DEFAULT_ON_EXHAUST: OnExhaust = "pause";
/** Delay before an automatic retry (in milliseconds). */
export const RETRY_DELAY_MS = 2_000;
/** Max time to wait for queued messages to drain before sending (in milliseconds). */
export const PENDING_DRAIN_TIMEOUT_MS = 5 * 60_000;
