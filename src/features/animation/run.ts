import { end, tryBegin } from './busy.js';

export interface AnimatedGame<T> {
  userId: string;
  /** Answers a user whose last game is still animating. */
  busy(): Promise<unknown>;
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
 * The shared flow of a wagered game: take the user's animation slot, settle, show, and always
 * release the slot. Only errors from `settle` are turned into text, so a failure while showing
 * the card is never mistaken for a bet problem.
 */
export async function runAnimatedGame<T>(game: AnimatedGame<T>): Promise<unknown> {
  if (!tryBegin(game.userId)) {
    return game.busy();
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
    end(game.userId);
  }
}
