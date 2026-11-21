import { container } from '@sapphire/framework';
import { honeypotConfig } from './config.js';

export type GuardOutcome = 'softbanned' | 'failed';

export type GuardEntry =
  | { state: 'in-flight' }
  | { state: 'done'; outcome: GuardOutcome; until: number };

export type GuardResult = { begun: true } | { begun: false; blockedBy: 'in-flight' | GuardOutcome };

declare module '@sapphire/pieces' {
  interface Container {
    /** Honeypot handling per `guild:user`, in flight or cooling down. Lost on restart. */
    honeypotGuard?: Map<string, GuardEntry>;
  }
}

// Held on the container so every loaded copy of this module (pieces included) shares one state.
const guard = (): Map<string, GuardEntry> => {
  container.honeypotGuard ??= new Map();
  return container.honeypotGuard;
};

export function guardKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/**
 * Claims the account for one softban attempt. Blocks while an attempt is in flight and for
 * `cooldownMs` after it finishes, so a burst of messages yields one softban.
 */
export function tryBegin(key: string, now: number): GuardResult {
  const entries = guard();
  for (const [k, entry] of entries) {
    // In-flight entries are never pruned: the caller always calls `finish`.
    if (entry.state === 'done' && now >= entry.until) {
      entries.delete(k);
    }
  }
  const entry = entries.get(key);
  if (entry) {
    return { begun: false, blockedBy: entry.state === 'in-flight' ? 'in-flight' : entry.outcome };
  }
  entries.set(key, { state: 'in-flight' });
  return { begun: true };
}

/** Ends the attempt and starts the cooldown from `now`. */
export function finish(key: string, now: number, outcome: GuardOutcome): void {
  guard().set(key, { state: 'done', outcome, until: now + honeypotConfig.cooldownMs });
}

export function resetGuard(): void {
  guard().clear();
}
