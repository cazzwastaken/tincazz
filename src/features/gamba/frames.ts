import type { ContainerBuilder } from 'discord.js';
import { accents, card, coins } from '../ui/index.js';
import { gambaOutcomes } from './outcomes.js';

const randomReel = () =>
  gambaOutcomes[Math.floor(Math.random() * gambaOutcomes.length)]?.emoji ?? '';

/**
 * The reel frames shown before a settled spin's result card: random emotes, no buttons. They take
 * only the player and the bet, never the reels, so they cannot reveal the outcome early. The
 * randomness is cosmetic and kept off the crypto draw that decides the spin.
 */
export function spinFrames(userId: string, bet: number): ContainerBuilder[] {
  const spinning = () =>
    card(
      accents.brand,
      `# ${randomReel()} ${randomReel()} ${randomReel()}`,
      `Bet ${coins(bet)}`,
      `-# <@${userId}> · spinning`,
    );
  return [spinning(), spinning()];
}
