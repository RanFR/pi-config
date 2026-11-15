/**
 * Shared git helpers for the codex-tools commands.
 *
 * Mirrors codex's `get_git_diff` behavior: tracked + untracked changes, with
 * hook execution and external diff/textconv drivers disabled.
 *
 * @module
 */

/** Outcome of a single {@link runGit} invocation. */
export interface GitResult {
	/** Standard output of the git command. */
	stdout: string;
	/** Standard error of the git command. */
	stderr: string;
	/** Exit code (0 = success). */
	code: number;
}

/** Outcome of a process execution as reported by the injected {@link ExecFn}. */
export interface ExecResult {
	/** Standard output of the command. */
	stdout: string;
	/** Standard error of the command. */
	stderr: string;
	/** Exit code (0 = success). */
	code: number;
	/** True when the process was terminated early (e.g. timed out). */
	killed: boolean;
	/** True when output was truncated because it exceeded `maxBuffer`. */
	truncated: boolean;
}

/**
 * Process executor signature (typically `pi.exec`), injected so the git
 * helpers can be exercised in tests without spawning real processes.
 */
export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

/** Wall-clock limit (in milliseconds) for each git invocation. */
const GIT_TIMEOUT_MS = 30_000;
/** Diffs can be huge; cap well below pi.exec's 256 MiB default. */
const DIFF_MAX_BUFFER = 8 * 1024 * 1024;

/** Hooks are disabled so /diff and /review never execute repo-local scripts. */
const BASE_ARGS = ["-c", "core.hooksPath=/dev/null"];

/**
 * Runs one git command with the shared timeout and hook-disable flags.
 *
 * @param exec - Injected process executor.
 * @param cwd - Working directory the command runs in.
 * @param args - Git arguments (subcommand and flags, without the binary name).
 * @returns Stdout, stderr, and exit code of the invocation.
 */
export async function runGit(exec: ExecFn, cwd: string, args: string[]): Promise<GitResult> {
	const result = await exec("git", [...BASE_ARGS, ...args], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	});
	return { stdout: result.stdout, stderr: result.stderr, code: result.code };
}

export async function isGitRepo(exec: ExecFn, cwd: string): Promise<boolean> {
	const result = await runGit(exec, cwd, ["rev-parse", "--is-inside-work-tree"]);
	return result.code === 0 && result.stdout.trim() === "true";
}

/** Normalizing flags applied to every `git diff` invocation. */
const DIFF_FLAGS = ["--no-color", "--no-textconv", "--no-ext-diff", "--submodule=short", "--ignore-submodules=dirty"];

/**
 * Best-effort default branch detection: origin's HEAD first, then local
 * `main`/`master`.
 *
 * @returns The branch name, or undefined when no candidate resolves.
 */
export async function defaultBranch(exec: ExecFn, cwd: string): Promise<string | undefined> {
	const remote = await runGit(exec, cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	const remoteName = remote.stdout.trim();
	if (remote.code === 0 && remoteName) return remoteName;
	for (const candidate of ["main", "master"]) {
		const check = await runGit(exec, cwd, ["rev-parse", "--verify", "--quiet", candidate]);
		if (check.code === 0) return candidate;
	}
	return undefined;
}

/**
 * Lists local branch names (short format), excluding the "HEAD" pseudo-branch.
 *
 * @returns Branch names; empty when git fails.
 */
export async function localBranches(exec: ExecFn, cwd: string): Promise<string[]> {
	const result = await runGit(exec, cwd, ["branch", "--format=%(refname:short)"]);
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && line !== "HEAD");
}

/**
 * Resolves the merge base between HEAD and `branch`.
 *
 * @returns The merge-base SHA, or undefined when git cannot compute one.
 */
export async function mergeBase(exec: ExecFn, cwd: string, branch: string): Promise<string | undefined> {
	const result = await runGit(exec, cwd, ["merge-base", "HEAD", branch]);
	const sha = result.stdout.trim();
	return result.code === 0 && sha ? sha : undefined;
}

/**
 * Reads the subject line (first line of the message) of a commit.
 *
 * @returns The commit title, or undefined when the commit cannot be read.
 */
export async function commitTitle(exec: ExecFn, cwd: string, sha: string): Promise<string | undefined> {
	const result = await runGit(exec, cwd, ["log", "-1", "--format=%s", sha]);
	const title = result.stdout.trim();
	return result.code === 0 ? (title || undefined) : undefined;
}

/**
 * Builds the full working-tree diff: tracked changes (staged + unstaged vs
 * HEAD) plus untracked files rendered as additions against /dev/null.
 *
 * @param exec - Injected process executor.
 * @param cwd - Repository working directory.
 * @returns The combined diff, or an error message when any git step fails.
 */
export async function getWorkingTreeDiff(
	exec: ExecFn,
	cwd: string,
): Promise<{ ok: true; diff: string } | { ok: false; error: string }> {
	if (!(await isGitRepo(exec, cwd))) {
		return { ok: false, error: "not inside a git repository" };
	}

	let tracked: string;
	const head = await exec(
		"git",
		[...BASE_ARGS, "diff", "HEAD", ...DIFF_FLAGS],
		{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER },
	);
	if (head.code === 0 || head.code === 1) {
		tracked = head.stdout;
	} else {
		// Unborn HEAD (fresh repo): fall back to index + worktree diff.
		const staged = await exec(
			"git",
			[...BASE_ARGS, "diff", "--cached", ...DIFF_FLAGS],
			{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER },
		);
		const unstaged = await exec(
			"git",
			[...BASE_ARGS, "diff", ...DIFF_FLAGS],
			{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER },
		);
		if (staged.code !== 0 && staged.code !== 1) {
			return { ok: false, error: `git diff --cached failed: ${staged.stderr.trim()}` };
		}
		if (unstaged.code !== 0 && unstaged.code !== 1) {
			return { ok: false, error: `git diff failed: ${unstaged.stderr.trim()}` };
		}
		tracked = staged.stdout + unstaged.stdout;
	}

	const untrackedList = await runGit(exec, cwd, ["ls-files", "--others", "--exclude-standard"]);
	if (untrackedList.code !== 0) {
		return { ok: false, error: `git ls-files failed: ${untrackedList.stderr.trim()}` };
	}
	const untrackedFiles = untrackedList.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	let untrackedDiff = "";
	for (const file of untrackedFiles) {
		// git diff --no-index exits 1 when differences exist; that is success here.
		const result = await exec(
			"git",
			[...BASE_ARGS, "diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", file],
			{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: DIFF_MAX_BUFFER },
		);
		if (result.code === 0 || result.code === 1) {
			untrackedDiff += result.stdout;
		}
	}

	return { ok: true, diff: tracked + untrackedDiff };
}
