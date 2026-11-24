export const outcomeKeys = [
  'head',
  'cry',
  'grr',
  'nails',
  'raa',
  'spooked',
  'python',
  'cpp',
] as const;

export type OutcomeKey = (typeof outcomeKeys)[number];

export interface GambaOutcome {
  key: OutcomeKey;
  emoji: string;
  weight: number;
}

// Weights sum to 21: six yt emojis at 3 each, python at 2, cpp at 1.
export const gambaOutcomes: readonly GambaOutcome[] = [
  { key: 'head', emoji: '<:gamba4Head:1202741378161840239>', weight: 3 },
  { key: 'cry', emoji: '<:gambaCry:1083000042547322930>', weight: 3 },
  { key: 'grr', emoji: '<:gambaGrr:1098212404640358463>', weight: 3 },
  { key: 'nails', emoji: '<:gambaNails:1082999569291423815>', weight: 3 },
  { key: 'raa', emoji: '<:gambaRaa:1098212756810907729>', weight: 3 },
  { key: 'spooked', emoji: '<:gambaSpooked:1083000047051997264>', weight: 3 },
  { key: 'python', emoji: '<:python:1226479453039759410>', weight: 2 },
  { key: 'cpp', emoji: '<:cpp:1226477956541448194>', weight: 1 },
];

export function outcomeEmoji(key: OutcomeKey): string {
  const outcome = gambaOutcomes.find((candidate) => candidate.key === key);
  if (!outcome) {
    throw new Error(`Unknown outcome key: ${key}`);
  }
  return outcome.emoji;
}
