import { container, Events } from '@sapphire/framework';
import { type Interaction, MessageFlags } from 'discord.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { replyWithGenericError } from '../src/listeners/interaction-errors.js';
import { testEnv } from './support/env.js';

const ephemeral = {
  content: 'Something went wrong running that. It has been logged.',
  flags: MessageFlags.Ephemeral,
};

function stub(state: { replied?: boolean; deferred?: boolean; repliable?: boolean }) {
  return {
    id: '42',
    replied: state.replied ?? false,
    deferred: state.deferred ?? false,
    isRepliable: () => state.repliable ?? true,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
}

const run = (interaction: ReturnType<typeof stub>) =>
  replyWithGenericError(interaction as unknown as Interaction);

describe('replyWithGenericError', () => {
  beforeAll(() => {
    // Creating the client is what sets container.logger.
    createClient(testEnv);
  });

  it('replies ephemerally when nothing was sent yet', async () => {
    const i = stub({});
    await run(i);

    expect(i.reply).toHaveBeenCalledWith(ephemeral);
    expect(i.followUp).not.toHaveBeenCalled();
  });

  it('follows up when the interaction already replied', async () => {
    const i = stub({ replied: true });
    await run(i);

    expect(i.followUp).toHaveBeenCalledWith(ephemeral);
    expect(i.reply).not.toHaveBeenCalled();
  });

  it('follows up when the interaction was deferred', async () => {
    const i = stub({ deferred: true });
    await run(i);

    expect(i.followUp).toHaveBeenCalledWith(ephemeral);
    expect(i.reply).not.toHaveBeenCalled();
  });

  it('does nothing for non-repliable interactions', async () => {
    const i = stub({ repliable: false });
    await run(i);

    expect(i.reply).not.toHaveBeenCalled();
    expect(i.followUp).not.toHaveBeenCalled();
  });

  it('swallows and logs a failing error reply', async () => {
    const i = stub({});
    i.reply.mockRejectedValue(new Error('Unknown interaction'));
    const warn = vi.spyOn(container.logger, 'warn').mockImplementation(() => undefined);

    await expect(run(i)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('ContextMenuCommandErrorReply', () => {
  it('follows up on a deferred context menu command that threw', async () => {
    const client = createClient(testEnv);
    await client.stores.load();
    const i = stub({ deferred: true });
    client.emit(Events.ContextMenuCommandError, new Error('boom'), { interaction: i } as never);
    await vi.waitFor(() => expect(i.followUp).toHaveBeenCalledWith(ephemeral));
  });
});
