import { describe, expect, it } from 'vitest';
import {
  optionBar,
  optionResults,
  outcome,
  percent,
  splitBar,
  yesNoResults,
} from '../src/features/poll/bars.js';

const cells = (text: string) => [...text.matchAll(/🟩|🟥|🟦|⬜/gu)].length;

describe('poll bars', () => {
  it('draws an empty split bar with no votes', () => {
    expect(splitBar(0, 0, 4)).toBe('⬜⬜⬜⬜');
  });

  it('splits green and red proportionally', () => {
    expect(splitBar(3, 1, 4)).toBe('🟩🟩🟩🟥');
    expect(splitBar(1, 1, 4)).toBe('🟩🟩🟥🟥');
    expect(splitBar(5, 0, 4)).toBe('🟩🟩🟩🟩');
  });

  it('always keeps a sliver of a non-zero share', () => {
    expect(splitBar(1, 1000, 8)).toBe('🟩🟥🟥🟥🟥🟥🟥🟥');
    expect(splitBar(1000, 1, 8)).toBe('🟩🟩🟩🟩🟩🟩🟩🟥');
  });

  it('draws option bars', () => {
    expect(optionBar(0, 0, 4)).toBe('⬜⬜⬜⬜');
    expect(optionBar(2, 4, 4)).toBe('🟦🟦⬜⬜');
    expect(cells(optionBar(1, 3))).toBe(10);
  });

  it('computes percentages', () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(0, 0)).toBe(0);
    expect(percent(5, 5)).toBe(100);
  });

  it('shows yes/no percentages that add up to 100', () => {
    expect(yesNoResults([1, 2])).toContain('**33%** (1)');
    expect(yesNoResults([1, 2])).toContain('**67%** (2)');
    expect(yesNoResults([0, 0])).toContain('**0%** (0)');
  });

  it('crowns the leader, all tied leaders, and nobody at zero', () => {
    const emojis = ['1️⃣', '2️⃣', '3️⃣'];
    const crowns = (counts: number[]) =>
      (optionResults(['a', 'b', 'c'], emojis, counts).match(/👑/g) ?? []).length;
    expect(crowns([3, 1, 0])).toBe(1);
    expect(crowns([2, 2, 0])).toBe(2);
    expect(crowns([0, 0, 0])).toBe(0);
  });

  it('reports the outcome', () => {
    expect(outcome([0, 0])).toEqual({ kind: 'none' });
    expect(outcome([4, 1, 2])).toEqual({ kind: 'winner', index: 0, margin: 2 });
    expect(outcome([2, 2, 1])).toEqual({ kind: 'tie', indexes: [0, 1] });
  });
});
