import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearBusy, runAnimatedGame, tryBegin } from '../src/features/animation/index.js';

afterEach(() => clearBusy());

function game(overrides: Partial<Parameters<typeof runAnimatedGame<number>>[0]> = {}) {
  const calls = {
    busy: vi.fn(async () => 'busy'),
    reject: vi.fn(async (text: string) => `rejected:${text}`),
    show: vi.fn(async (value: number) => `shown:${value}`),
  };
  return {
    calls,
    options: {
      userId: 'u',
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
    expect(calls.busy).not.toHaveBeenCalled();
    expect(tryBegin('u')).toBe(true);
  });

  it('answers busy without settling while the user is animating', async () => {
    tryBegin('u');
    const settle = vi.fn(() => 1);
    const { calls, options } = game({ settle });
    expect(await runAnimatedGame(options)).toBe('busy');
    expect(settle).not.toHaveBeenCalled();
    expect(calls.show).not.toHaveBeenCalled();
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
    expect(tryBegin('u')).toBe(true);
  });

  it('rethrows an unexplained settle error and frees the slot', async () => {
    const { options } = game({
      settle: () => {
        throw new Error('boom');
      },
    });
    await expect(runAnimatedGame(options)).rejects.toThrow('boom');
    expect(tryBegin('u')).toBe(true);
  });

  it('does not explain an error thrown while showing', async () => {
    const errorText = vi.fn(() => 'text');
    const { calls, options } = game({ errorText });
    calls.show.mockRejectedValueOnce(new Error('discord'));
    await expect(runAnimatedGame(options)).rejects.toThrow('discord');
    expect(errorText).not.toHaveBeenCalled();
    expect(tryBegin('u')).toBe(true);
  });
});
