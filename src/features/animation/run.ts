import { end, stillRolling, tryBegin } from './busy.js';

export interface AnimatedGame<T> {
  /** Set when editing an existing card to prevent overlapping updates to that message. */
  messageId?: string;
  /** Settles the game: coins move here, before the first frame. */
  settle(): T | Promise<T>;
  /** Explains a settle error to the player (a bet or funds problem); undefined rethrows it. */
  errorText(error: unknown): string | undefined;
  /** Sends that explanation privately, leaving any card as it was. */
  reject(text: string): Promise<unknown>;
  /** Animates and shows the settled game. Its errors propagate. */
  show(settled: T): Promise<unknown>;
}

/**
 * Settle and show each wager, reserving the message only when updating an existing card.
 * Only errors from `settle` are turned into text, so a failure while showing
 * the card is never mistaken for a bet problem.
 */
export async function runAnimatedGame<T>(game: AnimatedGame<T>): Promise<unknown> {
  const { messageId } = game;
  if (messageId !== undefined && !tryBegin(messageId)) {
    return game.reject(stillRolling);
  }
  try {
    let settled: T;
    try {
      settled = await game.settle();
    } catch (error) {
      const text = game.errorText(error);
      if (text === undefined) {
        throw error;
      }
      return await game.reject(text);
    }
    return await game.show(settled);
  } finally {
    if (messageId !== undefined) {
      end(messageId);
    }
  }
}
