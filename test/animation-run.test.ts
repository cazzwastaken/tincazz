import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearBusy,
  runAnimatedGame,
  stillRolling,
  tryBegin,
} from '../src/features/animation/index.js';

afterEach(() => clearBusy());

function game(overrides: Partial<Parameters<typeof runAnimatedGame<number>>[0]> = {}) {
  const calls = {
    reject: vi.fn(async (text: string) => `rejected:${text}`),
    show: vi.fn(async (value: number) => `shown:${value}`),
  };
  return {
    calls,
    options: {
      messageId: 'm1',
      settle: () => 5,
      errorText: () => undefined,
      ...calls,
      ...overrides,
    },
  };
}

describe('runAnimatedGame', () => {
  it('settles, shows the settled value and frees the slot', async () => {
    const { calls, options } = game();
    expect(await runAnimatedGame(options)).toBe('shown:5');
    expect(calls.reject).not.toHaveBeenCalled();
    expect(tryBegin('m1')).toBe(true);
  });

  it('answers busy without settling while the same card is being updated', async () => {
    tryBegin('m1');
    const settle = vi.fn(() => 1);
    const { calls, options } = game({ settle });
    expect(await runAnimatedGame(options)).toBe(`rejected:${stillRolling}`);
    expect(settle).not.toHaveBeenCalled();
    expect(calls.show).not.toHaveBeenCalled();
  });

  it('settles new plays and updates other cards while a card update is pending', async () => {
    tryBegin('m1');
    expect(await runAnimatedGame(game({ messageId: undefined }).options)).toBe('shown:5');
    expect(await runAnimatedGame(game({ messageId: 'm2' }).options)).toBe('shown:5');
  });

  it('rejects an explained settle error without showing, and frees the slot', async () => {
    const { calls, options } = game({
      settle: () => {
        throw new Error('poor');
      },
      errorText: (error) => (error as Error).message,
    });
    expect(await runAnimatedGame(options)).toBe('rejected:poor');
    expect(calls.show).not.toHaveBeenCalled();
    expect(tryBegin('m1')).toBe(true);
  });

  it('rethrows an unexplained settle error and frees the slot', async () => {
    const { options } = game({
      settle: () => {
        throw new Error('boom');
      },
    });
    await expect(runAnimatedGame(options)).rejects.toThrow('boom');
    expect(tryBegin('m1')).toBe(true);
  });

  it('does not explain an error thrown while showing', async () => {
    const errorText = vi.fn(() => 'text');
    const { calls, options } = game({ errorText });
    calls.show.mockRejectedValueOnce(new Error('discord'));
    await expect(runAnimatedGame(options)).rejects.toThrow('discord');
    expect(errorText).not.toHaveBeenCalled();
    expect(tryBegin('m1')).toBe(true);
  });
});
