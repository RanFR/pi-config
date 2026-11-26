/**
 * /commit: write a Conventional Commits message for the current changes with one
 * model call and commit it. The diff goes to the model directly and nothing is
 * written to the session, so repeated use cannot mix older changes into the
 * message. A session that only ran /commit therefore never gets a file: pi
 * creates one when the first conversation message is saved.
 *
 * Usage:
 *   /commit [instructions]        generate the message and commit
 *   /commit check [instructions]  review it first: commit, edit, revise with feedback, or cancel
 *
 * Already staged files are committed as they are. When nothing is staged, every
 * change is staged except files that look like secrets; files that look like
 * secrets are never committed.
 *
 * @module
 */

import { uuidv7 } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Container, Spacer, Text } from '@earendil-works/pi-tui';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import {
  commit,
  isSecretPath,
  pendingPaths,
  readStagedDiff,
  recentSubjects,
  repoRoot,
  stageAll,
  stagedFiles,
  type ExecFn,
  type FileChange,
} from './git.ts';
import {
  buildUserPrompt,
  fitDiff,
  parseMessage,
  SYSTEM_PROMPT,
  type CommitInput,
  type Revision,
} from './message.ts';

/** Recent commits shown to the model so it matches scope names, language and level of detail. */
const RECENT_COMMITS = 15;
/** More files than this are summed up in the review; the model still sees all of them. */
const MAX_REVIEWED_FILES = 20;

const REVIEW_CHOICES = [
  'Yes, commit',
  'Edit message',
  'Revise with feedback',
  'No, cancel',
] as const;
const WIDGET_KEY = 'commit-proposal';

/** Reports through a notification, or on stderr where there is no UI (print and JSON modes). */
function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: 'info' | 'warning' | 'error',
): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.error(message);
}

/** `/commit check ...` reviews the message first; any other arguments are instructions for the model. */
function parseArgs(args: string): { review: boolean; instructions: string } {
  const trimmed = args.trim();
  const review = trimmed === 'check' || trimmed.startsWith('check ');
  return {
    review,
    instructions: review ? trimmed.slice('check'.length).trim() : trimmed,
  };
}

/** Names the files that were left out because they look like secrets; empty when there are none. */
function secretNote(skipped: readonly string[]): string {
  return skipped.length > 0
    ? `Left uncommitted, they look like secrets: ${skipped.join(', ')}`
    : '';
}

/**
 * One model call at low reasoning: the message for `input`, or a rewrite of
 * `revision.previous` that applies the feedback.
 */
async function generateMessage(
  ctx: ExtensionCommandContext,
  input: CommitInput,
  revision?: Revision,
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error('no model selected');
  ctx.ui.setStatus(
    'commit',
    revision ? 'Revising commit message...' : 'Generating commit message...',
  );
  try {
    const response = await ctx.modelRegistry
      .streamSimple(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: buildUserPrompt(input, revision) }],
              timestamp: Date.now(),
            },
          ],
        },
        // A fresh session id and no cache retention keep this call apart from the conversation's provider state.
        { reasoning: 'low', cacheRetention: 'none', sessionId: uuidv7() },
      )
      .result();
    if (response.stopReason !== 'stop')
      throw new Error(response.errorMessage ?? `model stopped: ${response.stopReason}`);
    return parseMessage(
      response.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    );
  } finally {
    ctx.ui.setStatus('commit', undefined);
  }
}

/** Shows the files and the proposed message above the editor, where they stay visible during the review dialog. */
function showProposal(
  ctx: ExtensionCommandContext,
  files: readonly FileChange[],
  skipped: readonly string[],
  message: string,
): void {
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
    const widget = new Container();
    const line = (text: string) => widget.addChild(new Text(text, 1, 0));
    line(theme.fg('muted', `Files to commit (${files.length}):`));
    for (const file of files.slice(0, MAX_REVIEWED_FILES))
      line(theme.fg('dim', `${file.status}  ${file.path}`));
    if (files.length > MAX_REVIEWED_FILES)
      line(theme.fg('dim', `... and ${files.length - MAX_REVIEWED_FILES} more`));
    const note = secretNote(skipped);
    if (note) line(theme.fg('warning', note));
    widget.addChild(new Spacer(1));
    line(theme.fg('accent', 'Proposed commit message:'));
    for (const text of message.split('\n')) {
      if (text === '') widget.addChild(new Spacer(1));
      else line(text);
    }
    return widget;
  });
}

/**
 * The review loop: commit as is, edit by hand, rewrite from feedback, or
 * cancel. Each round shows the current message.
 *
 * @returns The message the user approved, or undefined when they cancelled.
 */
async function reviewMessage(
  ctx: ExtensionCommandContext,
  files: readonly FileChange[],
  skipped: readonly string[],
  input: CommitInput,
  initial: string,
): Promise<string | undefined> {
  let message = initial;
  const show = () => showProposal(ctx, files, skipped, message);
  show();
  try {
    for (;;) {
      const choice = await ctx.ui.select('Commit with this message?', [...REVIEW_CHOICES], {
        blockedKind: 'permission',
      });
      if (choice === REVIEW_CHOICES[0]) return message;
      if (choice === REVIEW_CHOICES[1]) {
        const edited = await ctx.ui.editor('Commit message', message);
        if (edited === undefined) continue;
        try {
          message = parseMessage(edited);
        } catch (error) {
          notify(ctx, error instanceof Error ? error.message : String(error), 'error');
        }
        show();
      } else if (choice === REVIEW_CHOICES[2]) {
        const feedback = (await ctx.ui.input('What should change in the message?'))?.trim();
        if (!feedback) continue;
        message = await generateMessage(ctx, input, {
          previous: message,
          feedback,
        });
        show();
      } else {
        notify(ctx, 'Commit cancelled', 'info');
        return undefined;
      }
    }
  } finally {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
}

/** The whole command: stage, generate, optionally review, commit, report. */
async function runCommit(exec: ExecFn, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { review, instructions } = parseArgs(args);
  if (review && !ctx.hasUI) throw new Error('/commit check needs an interactive session');

  const root = await repoRoot(exec, ctx.cwd);
  if (!root) throw new Error('not inside a git repository');

  // An index with content is committed as it is; only an empty one is filled from the whole working tree.
  let skipped: string[] = [];
  if ((await stagedFiles(exec, root)).length === 0) {
    skipped = (await pendingPaths(exec, root)).filter(isSecretPath);
    await stageAll(exec, root, skipped);
  }
  const files = await stagedFiles(exec, root);
  if (files.length === 0) {
    const note = secretNote(skipped);
    notify(ctx, note ? `Nothing to commit\n${note}` : 'Nothing to commit', 'info');
    return;
  }

  const secrets = files.flatMap((file) => file.paths).filter(isSecretPath);
  if (secrets.length > 0)
    throw new Error(
      `staged files look like secrets, commit them yourself if that is intended: ${secrets.join(', ')}`,
    );

  const [{ stat, diff }, subjects] = await Promise.all([
    readStagedDiff(exec, root),
    recentSubjects(exec, root, RECENT_COMMITS),
  ]);
  const input: CommitInput = {
    files: files.map((file) => `${file.status}\t${file.path}`),
    stat,
    diff: fitDiff(diff),
    recentSubjects: subjects,
    instructions,
  };

  let message = await generateMessage(ctx, input);
  if (review) {
    const approved = await reviewMessage(ctx, files, skipped, input, message);
    if (approved === undefined) return;
    message = approved;
  }

  const result = await commit(exec, root, message);
  if (!result.ok) throw new Error(`git commit failed:\n${result.output}`);
  const lines = [
    `Committed ${result.hash}: ${message.split('\n')[0] ?? message}`,
    secretNote(skipped),
  ];
  notify(ctx, lines.filter(Boolean).join('\n'), 'info');
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('commit', {
    description: 'Generate a Conventional Commits message and commit (check: review it first)',
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      if (!'check'.startsWith(prefix)) return null;
      return [
        {
          value: 'check',
          label: 'check',
          description: 'Review and revise the message before committing',
        },
      ];
    },
    handler: async (args, ctx) => {
      try {
        await runCommit(pi.exec, args, ctx);
      } catch (error) {
        notify(
          ctx,
          `/commit failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });
}
