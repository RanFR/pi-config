/**
 * `/review` command, ported from codex (prompts/src/review_request.rs +
 * review/rubric.md).
 *
 * Targets: uncommitted changes (default), a base branch, or a specific commit.
 * Sends a review prompt into the current session so the agent reviews the diff
 * with its tools and reports prioritized findings.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { commitTitle, defaultBranch, isGitRepo, localBranches, mergeBase } from './git.ts';

/** Review rubric appended to every review prompt (adapted from codex). */
const RUBRIC = `## Review guidelines

You are acting as a reviewer for a proposed code change made by another engineer.

General criteria for whether something is a bug and should be flagged:

1. It meaningfully impacts the accuracy, performance, security, or maintainability of the code.
2. The bug is discrete and actionable (not a general issue with the codebase or a combination of multiple issues).
3. Fixing the bug does not demand a level of rigor that is not present in the rest of the codebase.
4. The bug was introduced by these changes (pre-existing bugs should not be flagged).
5. The author of the original change would likely fix the issue if they were made aware of it.
6. The bug does not rely on unstated assumptions about the codebase or author's intent.
7. It is not enough to speculate that a change may disrupt another part of the codebase; identify the parts that are provably affected.
8. The bug is clearly not just an intentional change by the original author.

Comment style:

- Be clear about why the issue is a bug and communicate its severity accurately.
- Keep each finding to one paragraph; quote at most 3 lines of code (inline code or a code block).
- State the scenarios, environments, or inputs necessary for the bug to arise.
- Matter-of-fact tone, no flattery, no "Great job ..." filler.
- Ignore trivial style unless it obscures meaning or violates documented standards (AGENTS.md and similar files take precedence).

Output all findings the author would fix if they knew about them; prefer no findings over speculative ones. Deduplicate by changed location and defect.

## Output format

Report each finding as a Markdown section:

### [Pn] <short imperative title, max ~80 chars>

- **File**: <path>:<line range, as short as possible>
- **Confidence**: <0.0-1.0>
- one paragraph explaining why this is a problem, citing files/lines/functions

Priority tags: **[P0]** drop everything to fix (blocking) · **[P1]** urgent, next cycle · **[P2]** normal · **[P3]** low, nice to have.

End with a section "## Verdict" containing:
- **Overall**: "patch is correct" or "patch is incorrect" (correct implies existing code and tests will not break and no blocking bugs exist; ignore style/formatting/doc nits)
- **Explanation**: 1-3 sentences justifying the verdict.

Do not generate a fix for the findings.`;

/**
 * What to review: uncommitted changes, changes against a base branch, or the
 * changes introduced by a specific commit.
 */
type ReviewTarget =
  | { kind: 'uncommitted' }
  | { kind: 'base'; branch: string }
  | { kind: 'commit'; sha: string };

/** True when `value` looks like a git SHA (7-40 hex characters). */
function looksLikeSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(value);
}

/**
 * Resolves what to review from the command arguments.
 *
 * Accepted forms: "" (interactive picker), "base [branch]", "commit <sha>",
 * a bare branch name, or a bare commit SHA.
 *
 * @returns The resolved target, or undefined when the user cancels the picker.
 * @throws When the arguments do not match any accepted form.
 */
async function resolveTarget(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<ReviewTarget | undefined> {
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/);

  if (trimmed.length > 0) {
    if (parts[0] === 'base' && parts.length === 2 && parts[1])
      return { kind: 'base', branch: parts[1] };
    if (parts[0] === 'commit' && parts.length === 2 && parts[1])
      return { kind: 'commit', sha: parts[1] };
    if (parts.length === 1 && looksLikeSha(parts[0]!)) return { kind: 'commit', sha: parts[0] };
    if (parts.length === 1) return { kind: 'base', branch: parts[0] };
    throw new Error(
      `invalid /review arguments: ${trimmed} (expected "", "base [branch]", "commit <sha>", a branch name, or a commit SHA)`,
    );
  }

  const fallback: ReviewTarget = { kind: 'uncommitted' };
  if (!ctx.hasUI) return fallback;

  const base = await defaultBranch(pi.exec, ctx.cwd);
  const options = [
    'Uncommitted changes',
    ...(base ? [`Base branch (${base})`] : ['Base branch']),
    'Specific commit...',
  ];
  const choice = await ctx.ui.select('Review what?', options);
  if (!choice) return undefined;
  if (choice.startsWith('Uncommitted')) return fallback;
  if (choice.startsWith('Base branch')) {
    if (base) return { kind: 'base', branch: base };
    const branches = await localBranches(pi.exec, ctx.cwd);
    if (branches.length === 0) throw new Error('no local branches found');
    const branch = await ctx.ui.select('Base branch:', branches);
    if (!branch) return undefined;
    return { kind: 'base', branch };
  }
  const sha = await ctx.ui.input('Commit SHA:');
  if (!sha || sha.trim().length === 0) return undefined;
  return { kind: 'commit', sha: sha.trim() };
}

/**
 * Composes the review prompt: a task description for the target (enriched
 * with merge-base SHA or commit title when available) plus the shared
 * {@link RUBRIC}.
 */
async function buildPrompt(pi: ExtensionAPI, cwd: string, target: ReviewTarget): Promise<string> {
  let request: string;
  let hint: string;
  switch (target.kind) {
    case 'uncommitted':
      request =
        'Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings. Start with `git status` and the working-tree diff (tracked and untracked), then inspect the surrounding code as needed.';
      hint = 'uncommitted changes';
      break;
    case 'base': {
      const sha = await mergeBase(pi.exec, cwd, target.branch);
      request = sha
        ? `Review the code changes against the base branch '${target.branch}'. The merge base commit for this comparison is ${sha}. Run \`git diff ${sha}\` to inspect the changes relative to ${target.branch}. Provide prioritized, actionable findings.`
        : `Review the code changes against the base branch '${target.branch}'. Start by finding the merge diff between the current branch and ${target.branch}'s upstream (e.g. \`git merge-base HEAD "${target.branch}"\`), then run \`git diff\` against that SHA. Provide prioritized, actionable findings.`;
      hint = `changes vs ${target.branch}`;
      break;
    }
    case 'commit': {
      const title = await commitTitle(pi.exec, cwd, target.sha);
      request = title
        ? `Review the code changes introduced by commit ${target.sha} ("${title}"). Use \`git show ${target.sha}\` to see the change. Provide prioritized, actionable findings.`
        : `Review the code changes introduced by commit ${target.sha}. Use \`git show ${target.sha}\` to see the change. Provide prioritized, actionable findings.`;
      hint = `commit ${target.sha.slice(0, 12)}${title ? ` (${title})` : ''}`;
      break;
    }
  }
  return `Please review ${hint}.\n\n${request}\n\n${RUBRIC}`;
}

/**
 * Registers the `/review` command with argument autocompletion.
 *
 * Verifies the cwd is a git repository, resolves the review target, then
 * sends the composed prompt into the session (as a follow-up message when
 * the agent is still running).
 *
 * @param pi - Extension API used to register the command, run git, and send messages.
 */
export function registerReviewCommand(pi: ExtensionAPI): void {
  pi.registerCommand('review', {
    description: 'Review current changes and find issues (from codex)',
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = [
        { value: 'base', label: 'base <branch>' },
        { value: 'commit', label: 'commit <sha>' },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (!(await isGitRepo(pi.exec, ctx.cwd))) {
        if (ctx.hasUI) ctx.ui.notify('/review — not inside a git repository', 'error');
        return;
      }
      let target: ReviewTarget | undefined;
      try {
        target = await resolveTarget(pi, args, ctx);
      } catch (error) {
        if (ctx.hasUI)
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        return;
      }
      if (!target) return;

      const prompt = await buildPrompt(pi, ctx.cwd, target);
      pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
    },
  });
}
