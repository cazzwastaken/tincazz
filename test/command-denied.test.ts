import { container, Events, UserError } from '@sapphire/framework';
import { beforeAll, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { errorReply } from '../src/features/ui/index.js';
import { testEnv } from './support/env.js';

// Sapphire keeps global state: share one client across the tests in this file.
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

const denied = (context?: unknown) =>
  new UserError({ identifier: 'preconditionCooldown', message: 'Wait 5s', context });

function interactionStub(state: { replied?: boolean; deferred?: boolean } = {}) {
  return {
    id: '42',
    replied: state.replied ?? false,
    deferred: state.deferred ?? false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
}

const emitSlash = (error: UserError, interaction: ReturnType<typeof interactionStub>) =>
  client.emit(Events.ChatInputCommandDenied, error, { interaction } as never);

it('replies ephemerally to a denied slash command', async () => {
  const interaction = interactionStub();
  emitSlash(denied(), interaction);
  await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1));
  expect(interaction.reply).toHaveBeenCalledWith(errorReply('Wait 5s'));
  expect(interaction.followUp).not.toHaveBeenCalled();
});

it('follows up when the denied interaction was deferred', async () => {
  const interaction = interactionStub({ deferred: true });
  emitSlash(denied(), interaction);
  await vi.waitFor(() => expect(interaction.followUp).toHaveBeenCalledTimes(1));
  expect(interaction.followUp).toHaveBeenCalledWith(errorReply('Wait 5s'));
  expect(interaction.reply).not.toHaveBeenCalled();
});

it('replies to a denied prefix command', async () => {
  const message = { id: '7', reply: vi.fn(async () => undefined) };
  client.emit(Events.MessageCommandDenied, denied(), { message } as never);
  await vi.waitFor(() => expect(message.reply).toHaveBeenCalledWith('Wait 5s'));
});

it('sends nothing for a silent denial', async () => {
  const interaction = interactionStub();
  const message = { id: '7', reply: vi.fn(async () => undefined) };
  emitSlash(denied({ silent: true }), interaction);
  client.emit(Events.MessageCommandDenied, denied({ silent: true }), { message } as never);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(interaction.reply).not.toHaveBeenCalled();
  expect(message.reply).not.toHaveBeenCalled();
});

it('logs a failing reply instead of throwing', async () => {
  const warn = vi.spyOn(container.logger, 'warn').mockImplementation(() => undefined);
  const interaction = interactionStub();
  interaction.reply.mockRejectedValue(new Error('Unknown interaction'));
  const message = { id: '7', reply: vi.fn().mockRejectedValue(new Error('Missing access')) };
  emitSlash(denied(), interaction);
  client.emit(Events.MessageCommandDenied, denied(), { message } as never);
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
});

it('replies ephemerally to a denied context menu command', async () => {
  const interaction = interactionStub();
  client.emit(Events.ContextMenuCommandDenied, denied(), { interaction } as never);
  await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1));
  expect(interaction.reply).toHaveBeenCalledWith(errorReply('Wait 5s'));
});
