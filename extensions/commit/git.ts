/**
 * Git operations for the /commit command: read the index and working tree,
 * stage everything except files that look like secrets, and commit.
 *
 * Every command runs at the repository root, so /commit behaves the same from
 * any subdirectory.
 *
 * @module
 */

import type { ExecOptions, ExecResult } from '@earendil-works/pi-coding-agent';

/** pi.exec, injected so these helpers can be exercised outside pi. */
export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** Read-only commands must not hang. */
const READ_TIMEOUT_MS = 30_000;
/** Hooks can run for minutes: pi's own pre-commit runs the whole check. */
const COMMIT_TIMEOUT_MS = 10 * 60_000;
/** Diffs can be huge; cap well below pi.exec's 256 MiB default. */
const DIFF_MAX_BUFFER = 32 * 1024 * 1024;
/** Commit output (hook logs) rarely exceeds this. */
const COMMIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Unquoted paths keep non-ASCII file names readable. */
const GIT_ARGS = ['-c', 'core.quotePath=false'];
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv'];

/** One staged file. */
export interface FileChange {
  /** Status letter as git reports it: A, C, D, M, R, T, ... */
  status: string;
  /** The path, or "old -> new" for a rename or copy. */
  path: string;
  /** Both paths of a rename or copy; otherwise the one path. */
  paths: string[];
}

/** Outcome of `git commit`. */
export type CommitResult = { ok: true; hash: string } | { ok: false; output: string };

/** Runs git at the repository root. */
async function git(
  exec: ExecFn,
  root: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return exec('git', [...GIT_ARGS, ...args], {
    cwd: root,
    timeout: READ_TIMEOUT_MS,
    ...options,
  });
}

/** Runs git and returns its stdout; a nonzero exit is reported with git's stderr. */
async function must(
  exec: ExecFn,
  root: string,
  args: string[],
  options?: ExecOptions,
): Promise<string> {
  const result = await git(exec, root, args, options);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Non-empty lines of git output. */
function lines(output: string): string[] {
  return output.split('\n').filter((line) => line.length > 0);
}

/** Root of the repository containing `cwd`, or undefined outside a repository. */
export async function repoRoot(exec: ExecFn, cwd: string): Promise<string | undefined> {
  const result = await exec('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    timeout: READ_TIMEOUT_MS,
  });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

/** Staged files. An empty result means the index matches HEAD. */
export async function stagedFiles(exec: ExecFn, root: string): Promise<FileChange[]> {
  return parseNameStatus(await must(exec, root, ['diff', '--cached', '--name-status']));
}

/** Parses `--name-status` output: `X<TAB>path`, and `R100<TAB>old<TAB>new` for renames and copies. */
function parseNameStatus(output: string): FileChange[] {
  return lines(output).map((line) => {
    const [code, ...paths] = line.split('\t');
    const status = code?.charAt(0) ?? '';
    const renamedOrCopied = (status === 'R' || status === 'C') && paths.length === 2;
    return {
      status,
      path: renamedOrCopied ? `${paths[0]} -> ${paths[1]}` : (paths[0] ?? ''),
      paths,
    };
  });
}

/** Paths changed but not staged: modifications, deletions and untracked files. */
export async function pendingPaths(exec: ExecFn, root: string): Promise<string[]> {
  const [unstaged, untracked] = await Promise.all([
    must(exec, root, ['diff', '--name-only', '--no-renames']),
    must(exec, root, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...new Set([...lines(unstaged), ...lines(untracked)])];
}

/** Stages the whole working tree, then unstages `skip`. */
export async function stageAll(exec: ExecFn, root: string, skip: readonly string[]): Promise<void> {
  await must(exec, root, ['add', '--all', '--', '.']);
  if (skip.length > 0) await must(exec, root, ['reset', '--quiet', '--', ...skip]);
}

/** Files that must never be staged or committed by a command: a leaked one stays in history. */
const SECRET_FILE =
  /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|\.htpasswd|credentials\.(?:json|ya?ml|toml|ini|db|sqlite|txt))$/;
const SECRET_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/;
/** dotenv files (.env, .env.local, prod.env), except the ones that only list variable names */
const ENV_FILE = /(?:^|\.)env(\..*)?$/;
const ENV_TEMPLATE = /^(?:.*\.)?env\.(?:example|sample|template|dist)$/;

/** True for a path whose file name marks it as a secret. */
export function isSecretPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  if (ENV_TEMPLATE.test(name)) return false;
  return (
    SECRET_FILE.test(name) || SECRET_EXTENSION.test(name) || (name !== 'env' && ENV_FILE.test(name))
  );
}

/** The staged diff and its stat. */
export async function readStagedDiff(
  exec: ExecFn,
  root: string,
): Promise<{ stat: string; diff: string }> {
  const options: ExecOptions = { maxBuffer: DIFF_MAX_BUFFER };
  const [stat, diff] = await Promise.all([
    must(exec, root, ['diff', '--cached', '--stat=200'], options),
    git(exec, root, ['diff', '--cached', ...DIFF_FLAGS], options),
  ]);
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  return {
    stat,
    diff: diff.truncated ? `${diff.stdout}\n[diff truncated: size limit reached]` : diff.stdout,
  };
}

/** Subjects of the newest commits. Empty in a repository without commits. */
export async function recentSubjects(exec: ExecFn, root: string, limit: number): Promise<string[]> {
  const result = await git(exec, root, ['log', '--max-count', String(limit), '--format=%s']);
  return result.code === 0 ? lines(result.stdout) : [];
}

/** Commits the index with `message`. Hooks run; their output comes back on failure. */
export async function commit(exec: ExecFn, root: string, message: string): Promise<CommitResult> {
  const result = await git(exec, root, ['commit', '--message', message], {
    timeout: COMMIT_TIMEOUT_MS,
    maxBuffer: COMMIT_MAX_BUFFER,
  });
  if (result.code !== 0) {
    const output = [result.stdout, result.stderr].join('\n').trim();
    const killed = result.killed
      ? `\n[git commit was terminated after ${COMMIT_TIMEOUT_MS / 60_000} minutes]`
      : '';
    return { ok: false, output: `${output}${killed}` };
  }
  return {
    ok: true,
    hash: (await must(exec, root, ['rev-parse', '--short', 'HEAD'])).trim(),
  };
}
