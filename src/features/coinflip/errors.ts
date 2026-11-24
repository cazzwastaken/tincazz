import { EconomyError } from '../economy/errors.js';

// No parameter properties: Node's strip-only TypeScript loader (used for pieces in tests) rejects them.
export class CoinflipError extends EconomyError {}

/** One side of a flip cannot cover the stake. */
export class ShortStakeError extends CoinflipError {
  public readonly who: 'challenger' | 'acceptor';
  public readonly userId: string;
  public readonly balance: number;
  public readonly needed: number;

  public constructor(
    who: 'challenger' | 'acceptor',
    userId: string,
    balance: number,
    needed: number,
  ) {
    super(`${who} ${userId} has ${balance} coins, needs ${needed}`);
    this.who = who;
    this.userId = userId;
    this.balance = balance;
    this.needed = needed;
  }
}

/** The challenger already has the most live challenges allowed in the guild. */
export class ChallengeLimitError extends CoinflipError {
  public readonly limit: number;

  public constructor(limit: number) {
    super(`Challenger already has ${limit} live challenges`);
    this.limit = limit;
  }
}

/** A challenge message was already settled. */
export class ChallengeTakenError extends CoinflipError {
  public constructor() {
    super('Challenge already taken');
  }
}
