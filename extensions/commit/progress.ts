/**
 * Progress reporting for the long steps of /commit: the footer says what is running
 * and for how long, so a slow or stalled model shows as such instead of as silence.
 *
 * The footer redraws only when an extension status changes, so the status is refreshed
 * on a timer: the spinner turns and the elapsed time counts up. RPC mode receives every
 * status change as a message, so there only a change of phase is reported. Print and
 * JSON modes have no UI; a status there only keeps the time.
 *
 * @module
 */

import { type ExtensionCommandContext, keyText } from '@earendil-works/pi-coding-agent';
import { getKeybindings, isKeyRelease, type Keybinding } from '@earendil-works/pi-tui';

/** The key that cancels a step. It interrupts a running agent turn as well. */
const INTERRUPT: Keybinding = 'app.interrupt';
/** Every step of /commit reports through the same footer status. */
const STATUS_KEY = 'commit';
/** The frames and the pace of pi's own working indicator. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;
/** The footer line is shared with other extensions, so a reason is cut to this length. */
const MAX_REASON_CHARS = 60;

/** What a long step reports while it runs. */
export interface StepStatus {
  /** A new phase of the step, shown until the next one, for example `waiting for the model`. */
  phase(text: string): void;
  /**
   * How far the current phase has progressed, for example `214 chars`. It changes with
   * every event, so it is shown only where the status animates.
   */
  detail(text: string): void;
  /** A failed attempt; the step is tried again in `delayMs`. */
  retry(attempt: number, maxAttempts: number, delayMs: number, reason: string): void;
  /** Time since the step started, for example `12s` or `2m05s`. */
  elapsed(): string;
  /** Removes the status. A status that was stopped stays removed. */
  stop(): void;
}

/**
 * Shows `text` in the footer from now on and starts the clock of the returned status.
 *
 * @param options.cancellable Whether the interrupt key cancels the step; the status then says so.
 */
export function startStatus(
  ctx: ExtensionCommandContext,
  text: string,
  options?: { cancellable?: boolean },
): StepStatus {
  const startedAt = Date.now();
  // Only an interactive terminal redraws often enough for an animation.
  const animated = ctx.hasUI && ctx.mode === 'tui';
  const paint = animated ? ctx.ui.theme : undefined;
  const hint =
    paint && options?.cancellable ? paint.fg('dim', ` (${keyText(INTERRUPT)} to cancel)`) : '';

  let phaseText = text;
  let detailText = '';
  let countdown:
    | {
        attempt: number;
        maxAttempts: number;
        until: number;
        reason: string;
      }
    | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let shown: string | undefined;

  const elapsed = (): string => formatDuration(Date.now() - startedAt);

  const body = (): string => {
    if (!countdown) return detailText ? `${phaseText}, ${detailText}` : phaseText;
    const seconds = Math.max(1, Math.ceil((countdown.until - Date.now()) / 1000));
    return `retry ${countdown.attempt}/${countdown.maxAttempts} in ${seconds}s: ${countdown.reason}`;
  };

  const show = (): void => {
    if (stopped || !ctx.hasUI) return;
    let line = `commit: ${body()}`;
    if (paint) {
      const spinner = paint.fg('accent', FRAMES[frame % FRAMES.length] ?? '');
      line = `${spinner} ${paint.fg('muted', 'commit:')} ${body()} ${paint.fg('dim', `(${elapsed()})`)}${hint}`;
    }
    if (line === shown) return;
    shown = line;
    ctx.ui.setStatus(STATUS_KEY, line);
  };

  const status: StepStatus = {
    phase(text) {
      countdown = undefined;
      detailText = '';
      phaseText = text;
      show();
    },
    detail(text) {
      if (!animated) return;
      detailText = text;
      show();
    },
    retry(attempt, maxAttempts, delayMs, reason) {
      countdown = { attempt, maxAttempts, until: Date.now() + delayMs, reason: shorten(reason) };
      show();
    },
    elapsed,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    },
  };
  show();
  if (animated) {
    timer = setInterval(() => {
      frame++;
      show();
    }, FRAME_MS);
  }
  return status;
}

/**
 * Calls `onInterrupt` when the user presses the interrupt key, which is then swallowed.
 * Other keys, and the interrupt key once the listening has ended, are left alone.
 *
 * @returns What ends the listening. A listener that outlived its step would keep
 *   swallowing the key.
 */
export function listenForInterrupt(
  ctx: ExtensionCommandContext,
  onInterrupt: () => void,
): () => void {
  // Only a terminal has a key to press.
  if (ctx.mode !== 'tui') return () => {};
  let listening = true;
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (!listening || isKeyRelease(data) || !getKeybindings().matches(data, INTERRUPT))
      return undefined;
    onInterrupt();
    return { consume: true };
  });
  return () => {
    listening = false;
    unsubscribe?.();
  };
}

/** `12s`, and from a minute on `2m05s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** The first line of `text`, on one line and cut to the room the footer has. */
function shorten(text: string): string {
  const firstLine =
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? '';
  return firstLine.length > MAX_REASON_CHARS
    ? `${firstLine.slice(0, MAX_REASON_CHARS - 3)}...`
    : firstLine;
}
