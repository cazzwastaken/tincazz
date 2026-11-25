import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { container } from '@sapphire/framework';
import { Events, MessageFlags } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { rolls } from '../src/db/schema.js';
import {
  clearBudgets,
  clearBusy,
  setFrameDelay,
  stillRolling,
  tryBegin,
} from '../src/features/animation/index.js';
import {
  defaultCall,
  diceErrorText,
  encodeCallSelectId,
  encodeDoubleId,
  encodeRollAgainId,
  notYourRoll,
  type Roll,
  rollFrames,
  rollResult,
} from '../src/features/dice/index.js';
import {
  adminAdjust,
  debit,
  findWallet,
  getOrCreateWallet,
  InsufficientFundsError,
  startingBalance,
} from '../src/features/economy/index.js';
import { setLogChannel } from '../src/features/settings/store.js';
import { testEnv } from './support/env.js';
import { makeButton, makeSelect } from './support/interaction.js';

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

/** Edits after the update: one per remaining frame plus the result. */
const editCount = (await rollFrames('1', { bet: 10, call: defaultCall, die1: 1 })).length;

describe('dice buttons', () => {
  // Sapphire keeps global state, so a second client in the same process loses its built-in
  // preconditions. Share one client across the tests in this file.
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(() => {
    container.db = openDatabase(':memory:');
    setFrameDelay(0);
    clearBusy();
    clearBudgets();
  });

  afterEach(() => {
    clearBusy();
    setFrameDelay(undefined);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  const rollRows = () => container.db.select().from(rolls).all();
  const balance = (userId: string) => findWallet(container.db, '2', userId)?.balance;

  async function click(customId: string, userId: string) {
    const interaction = makeButton(client, { customId, userId });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(
      () =>
        expect(interaction.reply.mock.calls.length + interaction.update.mock.calls.length).toBe(1),
      { timeout: 2000 },
    );
    return interaction;
  }

  const again = encodeRollAgainId({ userId: '1', bet: 50, call: { kind: 'exact', target: 12 } });

  it('Roll again by the owner settles again with the same bet and call', async () => {
    mockRandomInt(5);
    const interaction = await click(again, '1');

    expect(rollRows()).toMatchObject([{ bet: 50, call: 'exact', target: 12, won: 1 }]);
    expect(json(interaction.update.mock.calls[0])).toContain('tumbling');
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledTimes(editCount));
    const result = json(interaction.editReply.mock.calls.at(-1));
    expect(result).toContain('EXACT 12');
    expect(result).toContain('+1,732');
    // The result card offers the same terms again.
    expect(result).toContain(again);
    expect(balance('1')).toBe(startingBalance - 50 + 1_782);
    await vi.waitFor(() => expect(tryBegin('m1')).toBe(true));
  });

  it('keeps a 5,000 Roll again out of the economy log', async () => {
    const send = vi.fn(async () => ({}));
    client.channels.cache.set('50', { id: '50', isSendable: () => true, send } as never);
    setLogChannel(container.db, '2', 'economy', '50', 1);
    adminAdjust(container.db, {
      guildId: '2',
      userId: '1',
      actorId: '9',
      action: 'give',
      amount: 5_000,
      reason: 'setup',
      now: 1,
    });
    mockRandomInt(0);
    await click(encodeRollAgainId({ userId: '1', bet: 5_000, call: { kind: 'low' } }), '1');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
  });

  it('tells another user it is not their roll', async () => {
    const interaction = await click(again, '5');

    const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
    expect(json(options)).toContain(json(notYourRoll).slice(1, -1));
    expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(rollRows()).toHaveLength(0);
    expect(balance('5')).toBeUndefined();
  });

  it('a Roll again click while the same card is being updated gets the busy text and settles nothing', async () => {
    tryBegin('m1');
    const interaction = await click(again, '1');

    const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
    expect(json(options)).toContain(stillRolling);
    expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(rollRows()).toHaveLength(0);
    expect(balance('1')).toBeUndefined();
  });

  it('repeated Roll again clicks during an animation settle one bet and queue no edits', async () => {
    // Long enough frames that both repeats land while the first roll is still animating.
    setFrameDelay(100);
    mockRandomInt(0);
    const first = makeButton(client, { customId: again, userId: '1' });
    client.emit(Events.InteractionCreate, first as never);
    await vi.waitFor(() => expect(first.update).toHaveBeenCalledTimes(1), { timeout: 2000 });

    const repeats = await Promise.all([click(again, '1'), click(again, '1')]);
    expect(first.editReply.mock.calls.length).toBeLessThan(editCount);
    for (const repeat of repeats) {
      expect(json(repeat.reply.mock.calls[0])).toContain(stillRolling);
      expect(repeat.update).not.toHaveBeenCalled();
      expect(repeat.editReply).not.toHaveBeenCalled();
    }
    expect(rollRows()).toHaveLength(1);

    await vi.waitFor(() => expect(first.editReply).toHaveBeenCalledTimes(editCount), {
      timeout: 2000,
    });
    expect(rollRows()).toHaveLength(1);
    expect(balance('1')).toBe(startingBalance - 50);
  });

  it('refuses with the funds error when the balance fell below the bet', async () => {
    getOrCreateWallet(container.db, '2', '1', 1);
    debit(container.db, {
      guildId: '2',
      userId: '1',
      amount: startingBalance - 20,
      reason: 'bet',
      now: 2,
    });
    const interaction = await click(again, '1');

    const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
    expect(json(options)).toContain(diceErrorText(new InsufficientFundsError(20, 50)));
    expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(rollRows()).toHaveLength(0);
    await vi.waitFor(() => expect(tryBegin('m1')).toBe(true));
  });

  it.each([
    ['an undecodable dc: id', 'dc:again:1:999999:h'],
    ['a dc: id with a bad call', 'dc:again:1:50:e7'],
    ['a foreign id', 'other:thing'],
  ])('ignores %s', async (_name, customId) => {
    const interaction = makeButton(client, { customId, userId: '1' });
    client.emit(Events.InteractionCreate, interaction as never);
    await wait(100);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
    expect(rollRows()).toHaveLength(0);
  });

  it('Double rolls the doubled bet from its id on the same card', async () => {
    mockRandomInt(0);
    const interaction = await click(
      encodeDoubleId({ userId: '1', bet: 200, call: { kind: 'low' } }),
      '1',
    );

    expect(rollRows()).toMatchObject([{ bet: 200, call: 'low', won: 1 }]);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledTimes(editCount));
    const result = json(interaction.editReply.mock.calls.at(-1));
    // The next controls keep the doubled bet and the call.
    expect(result).toContain('dc:again:1:200:l');
    expect(result).toContain('dc:double:1:400:l');
    await vi.waitFor(() => expect(tryBegin('m1')).toBe(true));
  });

  it('refuses a Double the balance cannot cover with the funds error', async () => {
    getOrCreateWallet(container.db, '2', '1', 1);
    debit(container.db, {
      guildId: '2',
      userId: '1',
      amount: startingBalance - 150,
      reason: 'bet',
      now: 2,
    });
    const interaction = await click(
      encodeDoubleId({ userId: '1', bet: 200, call: { kind: 'high' } }),
      '1',
    );

    expect(json(interaction.reply.mock.calls[0])).toContain(
      diceErrorText(new InsufficientFundsError(150, 200)),
    );
    expect(rollRows()).toHaveLength(0);
  });

  describe('Change call', () => {
    const roll: Roll = {
      bet: 50,
      call: { kind: 'high' },
      die1: 6,
      die2: 2,
      total: 8,
      won: true,
      payout: 118,
      edge: 1,
      balance: 1_068,
      pot: 10_001,
      rollId: 1,
    };
    const menuId = encodeCallSelectId({ userId: '1', bet: 50, call: { kind: 'high' } });

    async function pick(userId: string, values: string[], customId = menuId) {
      const card = await rollResult('1', roll);
      const interaction = makeSelect(client, { customId, userId, values });
      (interaction.message as { components?: unknown }).components = [
        { toJSON: () => card.toJSON() },
      ];
      client.emit(Events.InteractionCreate, interaction as never);
      return interaction;
    }

    it('updates only the card: new Next line and ids, nothing rolled or charged', async () => {
      const interaction = await pick('1', ['e12']);
      await vi.waitFor(() => expect(interaction.update).toHaveBeenCalledTimes(1));

      const shown = json(interaction.update.mock.calls[0]);
      expect(shown).toContain('Next: **Exact 12** · 50');
      expect(shown).toContain('dc:again:1:50:e12');
      expect(shown).toContain('dc:double:1:100:e12');
      expect(shown).toContain('dc:call:1:50:e12');
      // The roll that was shown stays.
      expect(shown).toContain('# 8 · HIGH ✓');
      expect(rollRows()).toHaveLength(0);
      expect(balance('1')).toBeUndefined();
      await vi.waitFor(() => expect(tryBegin('m1')).toBe(true));
    });

    it('tells another user it is not their roll and changes nothing', async () => {
      const interaction = await pick('5', ['l']);
      await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1));

      expect(json(interaction.reply.mock.calls[0])).toContain(json(notYourRoll).slice(1, -1));
      expect(interaction.update).not.toHaveBeenCalled();
    });

    it('says the card is stale when the message has no card', async () => {
      const interaction = makeSelect(client, { customId: menuId, userId: '1', values: ['l'] });
      (interaction.message as { components?: unknown }).components = [];
      client.emit(Events.InteractionCreate, interaction as never);
      await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1));
      expect(interaction.update).not.toHaveBeenCalled();
    });

    it('is refused while the card is being updated', async () => {
      tryBegin('m1');
      const interaction = await pick('1', ['l']);
      await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1));
      expect(json(interaction.reply.mock.calls[0])).toContain(stillRolling);
      expect(interaction.update).not.toHaveBeenCalled();
    });

    it.each([
      ['an undecodable call value', menuId, ['e7']],
      ['no value', menuId, []],
      ['a button id on a menu', 'dc:again:1:50:h', ['l']],
      ['a bad bet', 'dc:call:1:5:h', ['l']],
      ['a foreign id', 'other:thing', ['l']],
    ])('ignores %s', async (_name, customId, values) => {
      const interaction = await pick('1', values, customId);
      await wait(100);
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.update).not.toHaveBeenCalled();
    });

    it('is not handled by the button handler', async () => {
      const interaction = makeButton(client, { customId: menuId, userId: '1' });
      client.emit(Events.InteractionCreate, interaction as never);
      await wait(100);
      expect(interaction.update).not.toHaveBeenCalled();
      expect(rollRows()).toHaveLength(0);
    });
  });
});
