/**
 * /commit: write a Conventional Commits message for the current changes with one
 * model call and commit it. The diff goes to the model directly and nothing is
 * written to the session, so repeated use cannot mix older changes into the
 * message. A session that only ran /commit therefore never gets a file: pi
 * creates one when the first conversation message is saved.
 *
 * The footer shows what /commit is doing and for how long. A model call that fails
 * on a transient error, a dropped connection for example, is retried with the budget
 * and backoff of a conversation turn; the interrupt key (Escape by default) cancels
 * the call.
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

import {
  DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
  retryAssistantCall,
  uuidv7,
  type RetryPolicy,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Container, Spacer, Text } from '@earendil-works/pi-tui';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import {
  commit,
  isSecretPath,
  pendingPaths,
  type CommitResult,
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
import { listenForInterrupt, startStatus } from './progress.ts';

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

/** The user cancelled the model call. Nothing was committed. */
class CancelledError extends Error {}

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
 *
 * A call that fails on a transient error is tried again under the turn's retry
 * policy, with the countdown in the footer. The interrupt key cancels the whole call,
 * between two attempts as well.
 *
 * @throws {CancelledError} When the user cancelled the call.
 */
async function generateMessage(
  ctx: ExtensionCommandContext,
  input: CommitInput,
  turn: Turn,
  revision?: Revision,
): Promise<string> {
  const model = ctx.model;
  if (!model) throw new Error('no model selected');

  const label = revision ? 'revising commit message' : 'generating commit message';
  const status = startStatus(ctx, 'waiting for the model', { cancellable: true });
  const controller = new AbortController();
  const stopListening = listenForInterrupt(ctx, () => controller.abort());
  let attempts = 0;
  try {
    const response = await retryAssistantCall(
      async () => {
        attempts++;
        status.phase('waiting for the model');
        const stream = ctx.modelRegistry.streamSimple(
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
          {
            reasoning: 'low',
            cacheRetention: 'none',
            sessionId: uuidv7(),
            signal: controller.signal,
            ...turn.request,
          },
        );
        // Following the answer is what shows that the model is still working.
        let received = 0;
        for await (const event of stream) {
          if (event.type !== 'text_delta' && event.type !== 'thinking_delta') continue;
          if (received === 0) status.phase(label);
          received += event.delta.length;
          status.detail(`${received} chars`);
        }
        return stream.result();
      },
      turn.policy,
      controller.signal,
      {
        onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) =>
          status.retry(attempt, maxAttempts, delayMs, errorMessage),
      },
    );
    if (controller.signal.aborted || response.stopReason === 'aborted')
      throw new CancelledError(`cancelled after ${status.elapsed()}`);
    if (response.stopReason !== 'stop')
      throw new Error(
        `no commit message${
          attempts > 1 ? ` after ${attempts} attempts in ${status.elapsed()}` : ''
        }: ${response.errorMessage ?? `model stopped: ${response.stopReason}`}`,
      );
    return parseMessage(
      response.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    );
  } finally {
    stopListening();
    status.stop();
  }
}

/** How pi sends a conversation turn and retries it; /commit shares both. */
interface Turn {
  /** Retry of a turn that failed on a transient error. */
  policy: RetryPolicy;
  /** Request options pi adds for the agent loop. */
  request: Pick<SimpleStreamOptions, 'maxRetries' | 'maxRetryDelayMs' | 'timeoutMs'>;
}

/** pi's defaults, for the `httpIdleTimeoutMs` setting and for a delay the server asks for. */
const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * Reads from the settings how pi sends a conversation turn and retries it, so /commit
 * waits as long as a turn does and gives up when a turn would. pi adds the request
 * options for the agent loop only; an extension call has to pass them itself.
 */
function conversationTurn(settings: ReturnType<ExtensionAPI['getSettings']>): Turn {
  const retry = settings.retry;
  const idle = settings.httpIdleTimeoutMs;
  const httpIdleTimeoutMs =
    typeof idle === 'number' ? idle : idle === 'disabled' ? 0 : DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  return {
    policy: {
      enabled: retry?.enabled ?? true,
      maxRetries: retry?.maxRetries ?? 3,
      baseDelayMs: retry?.baseDelayMs ?? 2000,
      maxAgentDelayMs: retry?.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
    },
    request: {
      timeoutMs:
        retry?.provider?.timeoutMs ?? (httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs),
      // pi retries a turn itself, so the SDK stays at 0 unless `retry.provider.maxRetries` says otherwise.
      maxRetries: retry?.provider?.maxRetries,
      maxRetryDelayMs: retry?.provider?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
    },
  };
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
  turn: Turn,
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
        message = await generateMessage(ctx, input, turn, {
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
async function runCommit(
  exec: ExecFn,
  args: string,
  ctx: ExtensionCommandContext,
  turn: Turn,
): Promise<void> {
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

  let message = await generateMessage(ctx, input, turn);
  if (review) {
    const approved = await reviewMessage(ctx, files, skipped, input, turn, message);
    if (approved === undefined) return;
    message = approved;
  }

  // Hooks can run for minutes, so the footer says that git is busy and for how long.
  const status = startStatus(ctx, 'running git commit');
  let result: CommitResult;
  try {
    result = await commit(exec, root, message);
  } finally {
    status.stop();
  }
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
        await runCommit(pi.exec, args, ctx, conversationTurn(pi.getSettings()));
      } catch (error) {
        if (error instanceof CancelledError) {
          notify(ctx, `Commit ${error.message}`, 'info');
          return;
        }
        notify(
          ctx,
          `/commit failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });
}
