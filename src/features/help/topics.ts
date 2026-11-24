export const helpPages = [
  'home',
  'games',
  'images',
  'coins',
  'gamba',
  'flipdice',
  'giveaways',
  'polls',
  'halloffame',
] as const;
export type HelpPage = (typeof helpPages)[number];

export function isHelpPage(value: string): value is HelpPage {
  return (helpPages as readonly string[]).includes(value);
}

/** The pages the select menu jumps to (everything but the home page). */
export const topicPages = helpPages.filter((page) => page !== 'home') as Exclude<
  HelpPage,
  'home'
>[];

export interface TopicInfo {
  emoji: string;
  label: string;
  /** Shown under the option in the select menu (max 100 characters). */
  description: string;
}

export const topicInfo: Record<Exclude<HelpPage, 'home'>, TopicInfo> = {
  games: { emoji: '🎰', label: 'Games', description: 'Gamba, coinflip and dice at a glance' },
  images: {
    emoji: '🖼️',
    label: 'Images',
    description: 'Speech bubbles, captions and GIF conversion',
  },
  coins: {
    emoji: '🪙',
    label: 'Coins',
    description: 'Daily, collect, bailout and where you stand',
  },
  gamba: { emoji: '🍒', label: 'Gamba', description: 'The payout table, the pot and the jackpot' },
  flipdice: {
    emoji: '🎲',
    label: 'Coinflip & dice',
    description: 'Modes, calls, payouts and rake',
  },
  giveaways: {
    emoji: '🎁',
    label: 'Giveaways',
    description: 'Enter, host, and find current giveaways',
  },
  polls: {
    emoji: '📊',
    label: 'Polls',
    description: 'Ask a question and vote with reactions',
  },
  halloffame: {
    emoji: '🏛️',
    label: 'Hall of Fame',
    description: 'Messages many people reacted to, kept in one channel',
  },
};

const aliases: Record<string, HelpPage> = {
  home: 'home',
  games: 'games',
  game: 'games',
  images: 'images',
  image: 'images',
  bubble: 'images',
  caption: 'images',
  gif: 'images',
  coins: 'coins',
  coin: 'coins',
  economy: 'coins',
  daily: 'coins',
  collect: 'coins',
  bailout: 'coins',
  gamba: 'gamba',
  pot: 'gamba',
  jackpot: 'gamba',
  coinflip: 'flipdice',
  cf: 'flipdice',
  flip: 'flipdice',
  dice: 'flipdice',
  roll: 'flipdice',
  flipdice: 'flipdice',
  giveaway: 'giveaways',
  giveaways: 'giveaways',
  poll: 'polls',
  polls: 'polls',
  vote: 'polls',
  halloffame: 'halloffame',
  'hall-of-fame': 'halloffame',
  hof: 'halloffame',
  hall: 'halloffame',
  fame: 'halloffame',
  starboard: 'halloffame',
  star: 'halloffame',
};

/** A forgiving topic lookup for `?help <topic>`; anything unknown opens the home page. */
export function parseTopic(input: string | undefined): HelpPage {
  const key = (input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[/?!.]+/, '');
  return Object.hasOwn(aliases, key) ? (aliases[key] as HelpPage) : 'home';
}
