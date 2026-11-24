import { container } from '@sapphire/framework';
import type { Message, RepliableInteraction } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBudgets,
  messageDisplay,
  play,
  replyDisplay,
  setFrameDelay,
} from '../src/features/animation/index.js';
import { card } from '../src/features/ui/index.js';

const json = (value: unknown) => JSON.stringify(value);
const frames = [card(0, 'one'), card(0, 'two')];
const result = card(0, 'the result');
const options = { channelId: 'c' };

describe('display fallbacks', () => {
  beforeEach(() => {
    setFrameDelay(0);
    clearBudgets();
    container.logger = { warn: vi.fn(), error: vi.fn() } as unknown as typeof container.logger;
  });
  afterEach(() => {
    setFrameDelay(undefined);
    clearBudgets();
  });

  it('follows up with the result when every edit of a slash reply fails', async () => {
    const interaction = {
      replied: true,
      deferred: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => {
        throw new Error('unknown webhook');
      }),
      followUp: vi.fn(async () => undefined),
    };

    await play(
      replyDisplay(interaction as unknown as RepliableInteraction),
      frames,
      result,
      options,
    );

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(json(interaction.followUp.mock.calls[0])).toContain('the result');
  });

  it('replies normally when the very first slash reply failed', async () => {
    const interaction = {
      replied: false,
      deferred: false,
      reply: vi.fn(async () => undefined).mockRejectedValueOnce(new Error('boom')),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    await play(
      replyDisplay(interaction as unknown as RepliableInteraction),
      frames,
      result,
      options,
    );

    expect(interaction.reply).toHaveBeenCalledTimes(2);
    expect(json(interaction.reply.mock.calls[1])).toContain('the result');
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('posts the result as a new reply when the edits of a prefix reply fail', async () => {
    const sent = {
      edit: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    };
    const message = {
      reply: vi.fn(async (_options: unknown) => sent),
    };

    await play(messageDisplay(message as unknown as Message), frames, result, options);

    expect(message.reply).toHaveBeenCalledTimes(2);
    expect(json(message.reply.mock.calls[1])).toContain('the result');
    expect(message.reply.mock.calls[1]?.[0]).toMatchObject({ failIfNotExists: false });
  });

  it('does not use the fallback when the edits work', async () => {
    const followUp = vi.fn(async () => undefined);
    const interaction = {
      replied: true,
      deferred: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp,
    };

    await play(
      replyDisplay(interaction as unknown as RepliableInteraction),
      frames,
      result,
      options,
    );

    expect(followUp).not.toHaveBeenCalled();
  });
});
