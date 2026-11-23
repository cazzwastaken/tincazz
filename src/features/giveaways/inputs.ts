import { giveaway } from './config.js';

const minutesByUnit = {
  m: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hour: 60,
  hours: 60,
  d: 1440,
  day: 1440,
  days: 1440,
} as const;

export function parseGiveawayDuration(input: string): number | null {
  if (input.length > giveaway.maxDurationLength) return null;
  const match = /^(\d+)[ \t]*(m|minutes?|h|hours?|d|days?)$/i.exec(input.trim());
  if (!match) return null;
  const unit = match[2]?.toLowerCase() as keyof typeof minutesByUnit;
  const durationMs = Number(match[1]) * minutesByUnit[unit] * 60_000;
  return durationMs >= giveaway.minDurationMs && durationMs <= giveaway.maxDurationMs
    ? durationMs
    : null;
}

export function parseGiveawayPrize(input: string): string | null {
  if (input.length > giveaway.maxPrizeLength) return null;
  const prize = input.replace(/\s+/gu, ' ').trim();
  return prize || null;
}
