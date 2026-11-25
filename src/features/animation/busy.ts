import { container } from '@sapphire/framework';

declare module '@sapphire/pieces' {
  interface Container {
    /** Cards with an update in flight. Lost on restart. */
    animationBusy?: Set<string>;
  }
}

// Held on the container so every loaded copy of this module (pieces included) shares one state.
const busy = (): Set<string> => {
  container.animationBusy ??= new Set();
  return container.animationBusy;
};

/** Claims the card for an update: true only for the first caller until `end`. */
export function tryBegin(messageId: string): boolean {
  const cards = busy();
  if (cards.has(messageId)) {
    return false;
  }
  cards.add(messageId);
  return true;
}

export function end(messageId: string): void {
  busy().delete(messageId);
}

export function clearBusy(): void {
  busy().clear();
}

/** Ephemeral text for a click on a card that is already being updated. */
export const stillRolling = 'This card is still updating. Try again in a moment.';
