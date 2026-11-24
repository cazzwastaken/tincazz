export const leaderboardCategories = [
  'coins',
  'biggest-win',
  'jackpots',
  'profit',
  'spins',
  'coinflip',
  'dice',
] as const;

export type LeaderboardCategory = (typeof leaderboardCategories)[number];

export const categoryLabels: Record<LeaderboardCategory, string> = {
  coins: 'Coins',
  'biggest-win': 'Biggest win',
  jackpots: 'Jackpots',
  profit: 'Profit',
  spins: 'Spins',
  coinflip: 'Coinflip net (vs bot)',
  dice: 'Dice net',
};

export const leaderboardPageSize = 10;

export function isLeaderboardCategory(value: string): value is LeaderboardCategory {
  return (leaderboardCategories as readonly string[]).includes(value);
}
