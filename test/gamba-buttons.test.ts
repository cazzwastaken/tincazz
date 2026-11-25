import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { container } from '@sapphire/framework';
import { Events, MessageFlags } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { spins } from '../src/db/schema.js';
import {
  clearBudgets,
  clearBusy,
  end,
  setFrameDelay,
  stillRolling,
  tryBegin,
} from '../src/features/animation/index.js';
import { debit, findWallet, getOrCreateWallet } from '../src/features/economy/index.js';
import {
  clearActiveCards,
  expiredSpin,
  notYourSpin,
  setActiveCard,
} from '../src/features/gamba/index.js';
import { testEnv } from './support/env.js';
import { makeButton } from './support/interaction.js';

// See gamba-command.test.ts: patch the real crypto.randomInt for natively loaded pieces.
function mockRandomInt(...values: number[]) {
  const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(values.at(-1) as never);
  for (const value of values.slice(0, -1).reverse()) {
    spy.mockReturnValueOnce(value as never);
  }
  syncBuiltinESMExports();
}

const json = (value: unknown) => JSON.stringify(value);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('gamba buttons', () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(() => {
    container.db = openDatabase(':memory:');
    clearActiveCards();
    setFrameDelay(0);
    clearBusy();
    clearBudgets();
  });

  afterEach(() => {
    setFrameDelay(undefined);
    clearBusy();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  const spinCount = () => container.db.select().from(spins).all().length;

  async function click(customId: string, userId = '1', messageId = 'm1') {
    const interaction = makeButton(client, { customId, userId, messageId });
    client.emit(Events.InteractionCreate, interaction as never);
    // Either a private refusal, or the animation through its last edit and the card update finished.
    await vi.waitFor(
      () => {
        const landed =
          interaction.update.mock.calls.length === 1 &&
          interaction.editReply.mock.calls.length >= 2;
        expect(interaction.reply.mock.calls.length === 1 || landed).toBe(true);
      },
      { timeout: 2000 },
    );
    await vi.waitFor(() => {
      expect(tryBegin(interaction.message.id)).toBe(true);
    });
    end(interaction.message.id);
    return interaction;
  }

  const finalCard = (interaction: Awaited<ReturnType<typeof click>>) =>
    json(interaction.editReply.mock.calls.at(-1));

  it('ignores an old free-spin button', async () => {
    const interaction = makeButton(client, { customId: 'gamba:again:1:0', userId: '1' });
    client.emit(Events.InteractionCreate, interaction as never);
    await wait(50);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(spinCount()).toBe(0);
  });

  it('plays the same bet again and announces a triple with a ping', async () => {
    mockRandomInt(0);
    const interaction = await click('gamba:again:1:100');

    expect(finalCard(interaction)).toContain('Bet 100 → 1,000');
    await vi.waitFor(() => expect(interaction.announce).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    expect(interaction.announce.mock.calls[0]?.[0]).toMatchObject({
      allowedMentions: { users: ['1'] },
    });
  });

  it('plays a doubled bet', async () => {
    mockRandomInt(0, 3, 6);
    const interaction = await click('gamba:double:1:200');

    expect(finalCard(interaction)).toContain('Bet 200 → 0 (-200)');
  });

  it('tells another user it is not their spin', async () => {
    mockRandomInt(0, 3, 6);
    const interaction = await click('gamba:again:1:100', '5');

    expect(json(interaction.reply.mock.calls[0])).toContain(notYourSpin);
    expect((interaction.reply.mock.calls[0] as unknown as [{ flags: number }])[0].flags).toBe(
      MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    );
    expect(interaction.update).not.toHaveBeenCalled();
    expect(findWallet(container.db, '2', '5')).toBeUndefined();
    expect(spinCount()).toBe(0);
  });

  it('rejects a stale button when the balance dropped below the bet', async () => {
    getOrCreateWallet(container.db, '2', '1', 1000);
    debit(container.db, { guildId: '2', userId: '1', amount: 950, reason: 'bet', now: 1000 });
    const interaction = await click('gamba:again:1:100');

    expect(json(interaction.reply.mock.calls[0])).toContain(
      'You have 50 coins. Try a smaller bet.',
    );
    expect(interaction.update).not.toHaveBeenCalled();
    expect(spinCount()).toBe(0);
  });

  it('expires the buttons on a card that is not the latest', async () => {
    setActiveCard('1', 'm2');
    const interaction = await click('gamba:again:1:10', '1', 'm1');

    expect(json(interaction.reply.mock.calls[0])).toContain(expiredSpin);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(spinCount()).toBe(0);
  });

  it('keeps the latest card live across clicks', async () => {
    setActiveCard('1', 'm2');
    await click('gamba:again:1:10', '1', 'm2');
    await click('gamba:again:1:10', '1', 'm2');

    expect(spinCount()).toBe(2);
  });

  it('adopts the first clicked card when none is tracked, then expires others', async () => {
    await click('gamba:again:1:10', '1', 'm1');
    const other = await click('gamba:again:1:10', '1', 'm9');

    expect(json(other.reply.mock.calls[0])).toContain(expiredSpin);
    expect(spinCount()).toBe(1);
  });

  it('ignores tampered and foreign custom ids', async () => {
    const tampered = makeButton(client, { customId: 'gamba:again:1:999999', userId: '1' });
    const foreign = makeButton(client, { customId: 'other:thing', userId: '1' });
    client.emit(Events.InteractionCreate, tampered as never);
    client.emit(Events.InteractionCreate, foreign as never);
    await wait(100);

    for (const interaction of [tampered, foreign]) {
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.update).not.toHaveBeenCalled();
    }
    expect(spinCount()).toBe(0);
  });

  it('logs an announcement failure and does not rethrow', async () => {
    mockRandomInt(0);
    const error = vi.spyOn(container.logger, 'error').mockImplementation(() => undefined);
    const interaction = makeButton(client, { customId: 'gamba:again:1:100', userId: '1' });
    interaction.announce.mockRejectedValue(new Error('boom') as never);
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(error).toHaveBeenCalled(), { timeout: 2000 });

    expect(interaction.update).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('refuses a press while the same card is being updated and settles nothing', async () => {
    tryBegin('m1');
    const interaction = makeButton(client, { customId: 'gamba:again:1:100', userId: '1' });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });

    expect(json(interaction.reply.mock.calls[0])).toContain(stillRolling);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(spinCount()).toBe(0);
  });

  it('rejects the second of two simultaneous presses and lands the first result', async () => {
    setFrameDelay(40);
    mockRandomInt(0, 3, 6);
    const first = makeButton(client, { customId: 'gamba:again:1:100', userId: '1' });
    const second = makeButton(client, { customId: 'gamba:double:1:200', userId: '1' });
    client.emit(Events.InteractionCreate, first as never);
    client.emit(Events.InteractionCreate, second as never);
    await vi.waitFor(() => expect(first.editReply).toHaveBeenCalledTimes(2), { timeout: 2000 });

    expect(json(second.reply.mock.calls[0])).toContain(stillRolling);
    expect(second.update).not.toHaveBeenCalled();
    expect(spinCount()).toBe(1);
    expect(findWallet(container.db, '2', '1')?.balance).toBe(900);
    expect(json(first.editReply.mock.calls.at(-1))).toContain('Bet 100 → 0 (-100)');
    expect(json(first.editReply.mock.calls.at(-1))).toContain('balance 900');
  });

  it('shows frames without buttons or the result before the settled card', async () => {
    mockRandomInt(0, 3, 6);
    const interaction = await click('gamba:again:1:100');

    const shown = [interaction.update.mock.calls[0], ...interaction.editReply.mock.calls];
    for (const frame of shown.slice(0, -1)) {
      expect(json(frame)).toContain('spinning');
      expect(json(frame)).not.toContain('gamba:again');
      expect(json(frame)).not.toContain('Bet 100 →');
    }
    expect(json(shown.at(-1))).toContain('gamba:again:1:100');
  });

  it('lets the next press through once the roll has landed', async () => {
    await click('gamba:again:1:10', '1', 'm1');
    await click('gamba:again:1:10', '1', 'm1');
    expect(spinCount()).toBe(2);
  });
});
