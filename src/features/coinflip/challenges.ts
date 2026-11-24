import { container } from '@sapphire/framework';

/**
 * How long a closed key is remembered. Challenges live two minutes at most, so this only has to
 * cover a late or doubled click; after it, the database (settled flips, closed rows) still answers.
 */
export const closedTtlMs = 60 * 60_000;
/** Hard cap on remembered closed keys, so a burst cannot grow the map without bound. */
export const closedMax = 5_000;

interface ChallengeState {
  /** Closed message IDs (and `rematch:<id>` keys) with when they closed, oldest first. */
  closed: Map<string, number>;
  timers: Map<string, NodeJS.Timeout>;
  /** Expiry handlers of challenges whose timer is armed, by message ID. */
  handlers: Map<string, () => Promise<unknown>>;
  /** The handler of the challenge `tryClose` claimed last, so `reopen` can arm it again. */
  held?: { messageId: string; onExpire: () => Promise<unknown> };
}

declare module '@sapphire/pieces' {
  interface Container {
    /** Challenge messages already settled or closed, and their expiry timers. Lost on restart. */
    coinflipChallenges?: ChallengeState;
  }
}

// Held on the container so every loaded copy of this module (pieces included) shares one state.
const state = (): ChallengeState => {
  container.coinflipChallenges ??= { closed: new Map(), timers: new Map(), handlers: new Map() };
  return container.coinflipChallenges;
};

function clearTimer(messageId: string): void {
  const { timers } = state();
  const timer = timers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(messageId);
  }
}

/** Forgets closed keys past their TTL, then the oldest beyond the cap. Insertion order is age. */
function pruneClosed(now: number): void {
  const { closed } = state();
  for (const [key, closedAt] of closed) {
    if (now - closedAt < closedTtlMs && closed.size <= closedMax) {
      break;
    }
    closed.delete(key);
  }
}

/** Claims a challenge message: true only for the first caller. Also cancels its expiry timer. */
export function tryClose(messageId: string): boolean {
  const { closed } = state();
  const now = Date.now();
  if (closed.has(messageId)) {
    return false;
  }
  closed.set(messageId, now);
  pruneClosed(now);
  clearTimer(messageId);
  const { handlers } = state();
  const onExpire = handlers.get(messageId);
  handlers.delete(messageId);
  // Claiming and reopening happen in one synchronous flow, so one slot is enough.
  state().held = onExpire ? { messageId, onExpire } : undefined;
  return true;
}

/**
 * Gives a claimed message back (an acceptor who could not cover the stake). With `delayMs` it also
 * arms the challenge's original expiry handler again, if it had one.
 */
export function reopen(messageId: string, delayMs?: number): void {
  const current = state();
  current.closed.delete(messageId);
  const { held } = current;
  current.held = undefined;
  if (delayMs !== undefined && held?.messageId === messageId) {
    scheduleExpiry(messageId, delayMs, held.onExpire);
  }
}

/** Runs `onExpire` after `delayMs` unless the challenge was closed first. Never throws. */
export function scheduleExpiry(
  messageId: string,
  delayMs: number,
  onExpire: () => Promise<unknown>,
): void {
  clearTimer(messageId);
  state().handlers.set(messageId, onExpire);
  const timer = setTimeout(async () => {
    state().timers.delete(messageId);
    state().handlers.delete(messageId);
    if (!tryClose(messageId)) {
      return;
    }
    try {
      await onExpire();
    } catch (error) {
      container.logger.warn(
        `coinflip: could not expire challenge ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, delayMs);
  timer.unref();
  state().timers.set(messageId, timer);
}

/** How many closed keys are remembered (for tests). */
export function closedCount(): number {
  return state().closed.size;
}

export function clearChallenges(): void {
  for (const timer of state().timers.values()) {
    clearTimeout(timer);
  }
  state().timers.clear();
  state().handlers.clear();
  state().held = undefined;
  state().closed.clear();
}
