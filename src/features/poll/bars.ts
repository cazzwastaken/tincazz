import { poll } from './config.js';

const green = '🟩';
const red = '🟥';
const filled = '🟦';
const empty = '⬜';

/** Whole-number percentage of `count` in `total` (0 when there are no votes). */
export function percent(count: number, total: number): number {
  if (total <= 0 || count <= 0) return 0;
  return Math.min(100, Math.round((count / total) * 100));
}

/** Cells of `width` to fill for `count` of `total`: rounded, but never 0 for a non-zero share. */
function cells(count: number, total: number, width: number): number {
  if (total <= 0 || count <= 0) return 0;
  const raw = Math.round((count / total) * width);
  return Math.min(width, Math.max(1, raw));
}

/** One bar of exactly `width` cells split between yes (green) and no (red). */
export function splitBar(yes: number, no: number, width: number = poll.splitBarWidth): string {
  const total = yes + no;
  if (total <= 0) return empty.repeat(width);
  let left = cells(yes, total, width);
  if (no > 0 && left === width) left = width - 1;
  return green.repeat(left) + red.repeat(width - left);
}

/** A bar of exactly `width` cells for one option. */
export function optionBar(count: number, total: number, width: number = poll.optionBarWidth) {
  const full = cells(count, total, width);
  return filled.repeat(full) + empty.repeat(width - full);
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

export const voteCount = (count: number) => plural(count, 'vote', 'votes');

export type Outcome =
  | { kind: 'none' }
  | { kind: 'winner'; index: number; margin: number }
  | { kind: 'tie'; indexes: number[] };

export function outcome(counts: readonly number[]): Outcome {
  const top = Math.max(0, ...counts);
  if (top === 0) return { kind: 'none' };
  const indexes = counts.flatMap((count, index) => (count === top ? [index] : []));
  if (indexes.length > 1) return { kind: 'tie', indexes };
  const second = Math.max(0, ...counts.filter((count) => count !== top));
  return { kind: 'winner', index: indexes[0] ?? 0, margin: top - second };
}

/** The yes/no results: one split bar with a counts line. */
export function yesNoResults(counts: readonly number[]): string {
  const yes = counts[0] ?? 0;
  const no = counts[1] ?? 0;
  const total = yes + no;
  const yesPct = percent(yes, total);
  const noPct = total === 0 ? 0 : 100 - yesPct;
  return [
    splitBar(yes, no),
    `👍 **${yesPct}%** (${yes.toLocaleString('en-US')}) · 👎 **${noPct}%** (${no.toLocaleString('en-US')})`,
  ].join('\n');
}

/** One line per option with its bar, count and percentage; the leader (or tied leaders) get 👑. */
export function optionResults(
  options: readonly string[],
  emojis: readonly string[],
  counts: readonly number[],
  label: (option: string) => string = (option) => option,
): string {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const leaders = new Set(
    outcome(counts).kind === 'none'
      ? []
      : counts.flatMap((count, index) => (count === Math.max(...counts) ? [index] : [])),
  );
  return options
    .map((option, index) => {
      const count = counts[index] ?? 0;
      const crown = leaders.has(index) ? ' 👑' : '';
      return `${emojis[index] ?? ''} ${label(option)}${crown}\n${optionBar(count, total)} **${percent(count, total)}%** (${count.toLocaleString('en-US')})`;
    })
    .join('\n');
}
