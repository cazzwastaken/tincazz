import { container } from '@sapphire/framework';

/** Most users tracked at once; the least recently used one is dropped beyond it. */
export const activeCardMax = 5_000;

declare module '@sapphire/pieces' {
  interface Container {
    /** The one gamba card per user whose buttons still work, by message ID. Lost on restart. */
    gambaCards?: Map<string, string>;
  }
}

// Held on the container so every loaded copy of this module (pieces included) shares one map.
const cards = () => {
  container.gambaCards ??= new Map();
  return container.gambaCards;
};

/** Stores the entry as the most recently used and drops the oldest beyond the cap. */
function remember(userId: string, messageId: string): void {
  const map = cards();
  map.delete(userId);
  map.set(userId, messageId);
  for (const key of map.keys()) {
    if (map.size <= activeCardMax) {
      break;
    }
    map.delete(key);
  }
}

export function setActiveCard(userId: string, messageId: string): void {
  const current = cards().get(userId);
  // A slower REST response can arrive after a newer card. Snowflakes sort numerically.
  if (
    current !== undefined &&
    (messageId.length < current.length ||
      (messageId.length === current.length && messageId < current))
  ) {
    return;
  }
  remember(userId, messageId);
}

/**
 * Whether `messageId` is the user's live card. A user with no tracked card (for example after a
 * restart or an eviction) adopts the clicked one, so cards sent before a deploy keep working until
 * a newer one supersedes them.
 */
export function isActiveCard(userId: string, messageId: string): boolean {
  const current = cards().get(userId);
  if (current === undefined) {
    remember(userId, messageId);
    return true;
  }
  return current === messageId;
}

export function activeCardCount(): number {
  return cards().size;
}

export function clearActiveCards(): void {
  cards().clear();
}
