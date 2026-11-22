import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { container } from '@sapphire/framework';
import { ComponentType, Events, MessageFlags } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { flips, pots } from '../src/db/schema.js';
import {
  clearBudgets,
  clearBusy,
  end,
  setFrameDelay,
  stillRolling,
  tryBegin,
} from '../src/features/animation/index.js';
import {
  challengeResultCard,
  clearChallenges,
  encodeChallengeId,
  encodeFlipAgainId,
  encodeRematchId,
  flipAnimation,
  notYourChallenge,
  notYourFlip,
  rematchTaken,
  restoreChallengeCards,
  scheduleExpiry,
  settleChallenge,
  trackChallengeCard,
} from '../src/features/coinflip/index.js';
import {
  adminAdjust,
  debit,
  findWallet,
  getOrCreateWallet,
  startingBalance,
} from '../src/features/economy/index.js';
import { pot } from '../src/features/gamba/config.js';
import { setLogChannel } from '../src/features/settings/store.js';
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

/** The result card, shown by the last edit once the flip frames have played. */
async function flipResult(interaction: { editReply: { mock: { calls: unknown[][] } } }) {
  await vi.waitFor(() =>
    expect(interaction.editReply.mock.calls).toHaveLength(flipAnimation.stages.length),
  );
  return json(interaction.editReply.mock.calls.at(-1));
}

describe('coinflip buttons', () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(() => {
    container.db = openDatabase(':memory:');
    clearChallenges();
    setFrameDelay(0);
    clearBusy();
    clearBudgets();
  });

  afterEach(() => {
    clearChallenges();
    clearBusy();
    setFrameDelay(undefined);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  const flipCount = () => container.db.select().from(flips).all().length;
  const balance = (userId: string) => findWallet(container.db, '2', userId)?.balance;
  const potAmount = () => container.db.select().from(pots).get()?.amount;

  const challengeId = (
    action: 'accept' | 'decline' | 'cancel',
    extra: { opponentId?: string; expiresAt?: number; bet?: number } = {},
  ) =>
    encodeChallengeId({
      action,
      challengerId: '1',
      opponentId: 'opponentId' in extra ? extra.opponentId : '3',
      bet: extra.bet ?? 100,
      side: 'heads',
      expiresAt: extra.expiresAt ?? Date.now() + 60_000,
    });

  async function click(customId: string, userId: string, messageId = 'm1') {
    const interaction = makeButton(client, { customId, userId, messageId });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(
      () =>
        expect(interaction.reply.mock.calls.length + interaction.update.mock.calls.length).toBe(1),
      { timeout: 2000 },
    );
    return interaction;
  }

  const drain = (userId: string, leave: number) => {
    getOrCreateWallet(container.db, '2', userId, 1);
    debit(container.db, {
      guildId: '2',
      userId,
      amount: startingBalance - leave,
      reason: 'bet',
      now: 2,
    });
  };

  describe('economy log', () => {
    it('keeps an accepted 5,000 challenge out of the log', async () => {
      const send = vi.fn(async () => ({}));
      client.channels.cache.set('50', { id: '50', isSendable: () => true, send } as never);
      setLogChannel(container.db, '2', 'economy', '50', 1);
      for (const userId of ['1', '3']) {
        adminAdjust(container.db, {
          guildId: '2',
          userId,
          actorId: '9',
          action: 'give',
          amount: 5_000,
          reason: 'setup',
          now: 1,
        });
      }
      mockRandomInt(1);
      await click(challengeId('accept', { bet: 5_000 }), '3');
      await wait(50);
      expect(send).not.toHaveBeenCalled();
    });

    it('keeps a 5,000 flip again out of the log', async () => {
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
      await click(encodeFlipAgainId({ userId: '1', bet: 5_000, side: 'heads' }), '1');
      await wait(50);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('flip again', () => {
    const again = encodeFlipAgainId({ userId: '1', bet: 100, side: 'heads' });

    it('flips again for the owner', async () => {
      mockRandomInt(0);
      const interaction = await click(again, '1');

      expect(json(interaction.update.mock.calls[0])).toContain('tossed');
      expect(await flipResult(interaction)).toContain('+94');
      expect(flipCount()).toBe(1);
    });

    it('tells another user it is not their flip', async () => {
      const interaction = await click(again, '5');

      expect(json(interaction.reply.mock.calls[0])).toContain(notYourFlip);
      expect(flipCount()).toBe(0);
    });

    it('a Flip again click while the same user is animating gets the busy text and settles nothing', async () => {
      tryBegin('1');
      const interaction = await click(again, '1');

      const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
      expect(json(options)).toContain(stillRolling);
      expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
      expect(interaction.update).not.toHaveBeenCalled();
      expect(flipCount()).toBe(0);
      expect(balance('1')).toBeUndefined();
    });

    it('refuses with a funds error when the balance fell below the bet', async () => {
      drain('1', 50);
      const interaction = await click(again, '1');

      const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
      expect(json(options)).toContain('You have 50 coins');
      expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
      expect(interaction.update).not.toHaveBeenCalled();
      expect(flipCount()).toBe(0);
    });
  });

  describe('accept', () => {
    it('settles a targeted challenge for the opponent', async () => {
      mockRandomInt(1);
      getOrCreateWallet(container.db, '2', '1', 1);
      const interaction = await click(challengeId('accept'), '3');

      expect(json(interaction.update.mock.calls[0])).toContain('<@1> vs <@3> · 100 each');
      expect(await flipResult(interaction)).toContain('<@3> wins **194**');
      expect(balance('1')).toBe(startingBalance - 100);
      expect(balance('3')).toBe(startingBalance + 94);
      expect(potAmount()).toBe(pot.seed + 6);
      expect(flipCount()).toBe(1);
    });

    it('keeps the challenge live when a busy acceptor clicks, and settles a later accept', async () => {
      mockRandomInt(1);
      getOrCreateWallet(container.db, '2', '1', 1);
      getOrCreateWallet(container.db, '2', '3', 1);
      tryBegin('3');
      const busy = await click(challengeId('accept'), '3');

      const [options] = busy.reply.mock.calls[0] as unknown as [{ flags: number }];
      expect(json(options)).toContain(stillRolling);
      expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
      expect(busy.update).not.toHaveBeenCalled();
      expect(flipCount()).toBe(0);
      expect(balance('1')).toBe(startingBalance);
      expect(balance('3')).toBe(startingBalance);

      end('3');
      const interaction = await click(challengeId('accept'), '3');
      expect(json(interaction.update.mock.calls[0])).toContain('<@1> vs <@3> · 100 each');
      expect(await flipResult(interaction)).toContain('<@3> wins **194**');
      expect(flipCount()).toBe(1);
    });

    it('sends a third user away from a targeted challenge', async () => {
      const interaction = await click(challengeId('accept'), '4');

      expect(json(interaction.reply.mock.calls[0])).toContain(notYourChallenge);
      expect(flipCount()).toBe(0);
    });

    it('stops the challenger from accepting their own open challenge', async () => {
      const interaction = await click(challengeId('accept', { opponentId: undefined }), '1');

      expect(json(interaction.reply.mock.calls[0])).toContain(notYourChallenge);
      expect(flipCount()).toBe(0);
    });

    it('lets only the first of two acceptors take an open challenge', async () => {
      mockRandomInt(0);
      const id = challengeId('accept', { opponentId: undefined });
      await click(id, '3');
      const second = await click(id, '4');

      expect(json(second.reply.mock.calls[0])).toContain('Someone already took this challenge.');
      expect(flipCount()).toBe(1);
    });

    it('answers "already taken" after a restart and moves no coins', async () => {
      mockRandomInt(0);
      const id = challengeId('accept');
      await click(id, '3');
      const before = [balance('1'), balance('3'), potAmount()];
      clearChallenges();
      const again = await click(id, '3');

      expect(json(again.reply.mock.calls[0])).toContain('Someone already took this challenge.');
      expect([balance('1'), balance('3'), potAmount()]).toEqual(before);
      expect(flipCount()).toBe(1);
    });

    it('closes a challenge accepted past its expiry', async () => {
      const interaction = await click(
        challengeId('accept', { expiresAt: Date.now() - 5_000 }),
        '3',
      );

      expect(json(interaction.update.mock.calls[0])).toContain('Challenge expired.');
      expect(flipCount()).toBe(0);
    });

    it('keeps the challenge open when the acceptor cannot cover the stake', async () => {
      mockRandomInt(0);
      drain('3', 5);
      const id = challengeId('accept', { opponentId: undefined });
      const short = await click(id, '3');

      expect(json(short.reply.mock.calls[0])).toContain(
        'You need 100 coins to accept. You have 5.',
      );
      expect(short.update).not.toHaveBeenCalled();

      const funded = await click(id, '4');
      expect(await flipResult(funded)).toContain('wins');
      expect(flipCount()).toBe(1);
    });

    it('still expires the card with the original handler after a short acceptor', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        drain('3', 5);
        const onExpire = vi.fn(async () => undefined);
        scheduleExpiry('m1', 600_000, onExpire);
        await click(challengeId('accept', { opponentId: undefined }), '3');
        // The id rounds the expiry up to the next whole second.
        await vi.advanceTimersByTimeAsync(61_000);

        expect(onExpire).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes the card when the challenger can no longer cover the bet', async () => {
      drain('1', 50);
      const interaction = await click(challengeId('accept'), '3');

      expect(json(interaction.update.mock.calls[0])).toContain("can't cover the bet");
      expect(flipCount()).toBe(0);
    });

    it('does not overwrite an accepted challenge when the expiry timer fires', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        mockRandomInt(0);
        const onExpire = vi.fn(async () => undefined);
        scheduleExpiry('m1', 60_000, onExpire);
        await click(challengeId('accept'), '3');
        await vi.advanceTimersByTimeAsync(60_000);

        expect(onExpire).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('after a restart or a failed card update', () => {
    it('shows the result in a message edit when the card update fails', async () => {
      mockRandomInt(0);
      const interaction = makeButton(client, { customId: challengeId('accept'), userId: '3' });
      interaction.update.mockRejectedValueOnce(new Error('Service Unavailable'));
      const edit = vi.fn(async (_options: unknown) => ({}));
      interaction.message.edit = edit;
      const error = vi.spyOn(container.logger, 'error').mockImplementation(() => undefined);
      client.emit(Events.InteractionCreate, interaction as never);
      await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1), { timeout: 2000 });

      expect(json(edit.mock.calls[0])).toContain('wins');
      expect(error).toHaveBeenCalled();
      expect(flipCount()).toBe(1);
    });

    it('shows a flip again result in a message edit when the card update fails', async () => {
      mockRandomInt(0);
      const interaction = makeButton(client, {
        customId: encodeFlipAgainId({ userId: '1', bet: 100, side: 'heads' }),
        userId: '1',
      });
      interaction.update.mockRejectedValueOnce(new Error('Service Unavailable'));
      const edit = vi.fn(async (_options: unknown) => ({}));
      interaction.message.edit = edit;
      vi.spyOn(container.logger, 'error').mockImplementation(() => undefined);
      client.emit(Events.InteractionCreate, interaction as never);
      await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1), { timeout: 2000 });

      expect(json(edit.mock.calls[0])).toContain('Heads');
    });

    it('shows the result in a message edit when the final edit fails', async () => {
      mockRandomInt(0);
      const interaction = makeButton(client, { customId: challengeId('accept'), userId: '3' });
      interaction.editReply.mockImplementation(async (options: unknown) => {
        if (!json(options).includes('tossed')) throw new Error('Unknown Webhook');
      });
      const edit = vi.fn(async (_options: unknown) => ({}));
      interaction.message.edit = edit;
      vi.spyOn(container.logger, 'error').mockImplementation(() => undefined);
      client.emit(Events.InteractionCreate, interaction as never);
      await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1), { timeout: 2000 });

      expect(json(edit.mock.calls[0])).toContain('wins');
      expect(flipCount()).toBe(1);
    });

    it('does not let a cancel or decline overwrite a settled challenge after a restart', async () => {
      mockRandomInt(0);
      await click(challengeId('accept'), '3');
      clearChallenges();
      const cancel = await click(challengeId('cancel'), '1');
      clearChallenges();
      const decline = await click(challengeId('decline'), '3');

      for (const interaction of [cancel, decline]) {
        expect(json(interaction.reply.mock.calls[0])).toContain('Someone already took this');
        expect(interaction.update).not.toHaveBeenCalled();
      }
    });

    it('does not rewrite a settled challenge as expired after a restart', async () => {
      mockRandomInt(0);
      const expiresAt = Date.now() + 60_000;
      await click(challengeId('accept', { expiresAt }), '3');
      clearChallenges();
      const late = await click(challengeId('accept', { expiresAt: Date.now() - 5_000 }), '3');

      expect(json(late.reply.mock.calls[0])).toContain('Someone already took this');
      expect(late.update).not.toHaveBeenCalled();
    });

    it('restores a failed cancellation without letting anyone accept it after restart', async () => {
      const expiresAt = Date.now() + 60_000;
      trackChallengeCard(
        '3',
        'm1',
        { challengerId: '1', opponentId: '3', bet: 100, side: 'heads', expiresAt },
        vi.fn(),
      );
      const cancel = makeButton(client, {
        customId: challengeId('cancel', { expiresAt }),
        userId: '1',
      });
      cancel.update.mockRejectedValueOnce(new Error('Service Unavailable'));
      const error = vi.spyOn(container.logger, 'error').mockImplementation(() => undefined);
      client.emit(Events.InteractionCreate, cancel as never);
      await vi.waitFor(() => expect(error).toHaveBeenCalled());

      clearChallenges();
      const accept = await click(challengeId('accept', { expiresAt }), '3');
      expect(json(accept.reply.mock.calls[0])).toContain('Someone already took this');
      expect(flipCount()).toBe(0);

      const edit = vi.fn(async (_messageId: string, _options: unknown) => ({}));
      vi.spyOn(client.channels, 'fetch').mockResolvedValue({
        isSendable: () => true,
        messages: { edit },
      } as never);
      restoreChallengeCards(client);
      await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
      expect(json(edit.mock.calls[0])).toContain('<@1> cancelled.');
      expect(json(edit.mock.calls[0])).not.toContain('cf:accept');
    });

    it('retires stale challenge buttons without replacing a displayed result', async () => {
      const now = Date.now();
      for (const messageId of ['stale', 'result']) {
        trackChallengeCard(
          '3',
          messageId,
          { challengerId: '1', opponentId: '3', bet: 100, side: 'heads', expiresAt: now + 60_000 },
          vi.fn(),
        );
        settleChallenge(
          container.db,
          {
            guildId: '2',
            mode: 'challenge',
            messageId,
            challengerId: '1',
            acceptorId: '3',
            bet: 100,
            challengerSide: 'heads',
          },
          now,
          () => 0,
        );
      }
      clearChallenges();
      const fetch = vi.fn(async ({ message }: { message: string }) => ({
        components: [
          {
            type: ComponentType.Container,
            components: [
              {
                type: ComponentType.ActionRow,
                components: [
                  {
                    type: ComponentType.Button,
                    customId:
                      message === 'stale'
                        ? challengeId('accept')
                        : encodeRematchId({
                            challengerId: '1',
                            acceptorId: '3',
                            bet: 100,
                            challengerSide: 'heads',
                          }),
                  },
                ],
              },
            ],
          },
        ],
      }));
      const edit = vi.fn(async (_messageId: string, _options: unknown) => ({}));
      vi.spyOn(client.channels, 'fetch').mockResolvedValue({
        isSendable: () => true,
        messages: { edit, fetch },
      } as never);
      restoreChallengeCards(client);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(edit).toHaveBeenCalledExactlyOnceWith('stale', expect.anything());
      expect(json(edit.mock.calls[0])).toContain('Challenge already settled.');
      expect(json(edit.mock.calls[0])).not.toContain('cf:accept');
      expect(flipCount()).toBe(2);
    });
  });

  describe('decline and cancel', () => {
    it('lets the opponent decline, then refuses an accept', async () => {
      const declined = await click(challengeId('decline'), '3');
      expect(json(declined.update.mock.calls[0])).toContain('<@3> declined.');

      const accepted = await click(challengeId('accept'), '3');
      expect(json(accepted.reply.mock.calls[0])).toContain('Someone already took this challenge.');
      expect(flipCount()).toBe(0);
    });

    it('lets the challenger cancel, then refuses an accept', async () => {
      const cancelled = await click(challengeId('cancel'), '1');
      expect(json(cancelled.update.mock.calls[0])).toContain('<@1> cancelled.');

      const accepted = await click(challengeId('accept'), '3');
      expect(json(accepted.reply.mock.calls[0])).toContain('Someone already took this challenge.');
    });

    it('does not let the wrong user decline or cancel', async () => {
      const decline = await click(challengeId('decline'), '1');
      expect(json(decline.reply.mock.calls[0])).toContain(notYourChallenge);
      const cancel = await click(challengeId('cancel'), '3', 'm2');
      expect(json(cancel.reply.mock.calls[0])).toContain(notYourChallenge);
    });
  });

  describe('rematch', () => {
    // Challenger 1 called heads and won; acceptor 3 held tails and lost.
    const rematchId = encodeRematchId({
      challengerId: '1',
      acceptorId: '3',
      bet: 100,
      challengerSide: 'heads',
    });
    const resultCard = () =>
      challengeResultCard(
        { challengerId: '1', opponentId: '3', bet: 100, side: 'heads', expiresAt: 0 },
        {
          result: 'heads',
          winnerId: '1',
          loserId: '3',
          rake: 6,
          credited: 194,
          challengerBalance: 1_094,
          acceptorBalance: 900,
          pot: 10_006,
          flipId: 1,
        },
      );

    /** Presses Rematch on result message `r1`; the reply it sends becomes message `r2`. */
    function press(userId: string) {
      const interaction = makeButton(client, { customId: rematchId, userId, messageId: 'r1' });
      const sent = { id: 'r2', edit: vi.fn(async (_options: unknown) => ({})) };
      interaction.announce.mockResolvedValue(sent);
      Object.assign(interaction.message, { components: [resultCard()] });
      client.emit(Events.InteractionCreate, interaction as never);
      return { interaction, sent };
    }

    const answered = (interaction: ReturnType<typeof makeButton>) =>
      vi.waitFor(
        () =>
          expect(interaction.reply.mock.calls.length + interaction.update.mock.calls.length).toBe(
            1,
          ),
        { timeout: 2000 },
      );

    const ephemeral = (interaction: ReturnType<typeof makeButton>) =>
      (interaction.reply.mock.calls[0] as unknown as [{ flags: number }])[0].flags &
      MessageFlags.Ephemeral;

    const buttonIds = (value: unknown) =>
      [...json(value).matchAll(/"custom_id":"([^"]+)"/g)].map((match) => match[1] as string);

    it('a stranger pressing Rematch gets notYourChallenge', async () => {
      const { interaction } = press('4');
      await answered(interaction);

      expect(json(interaction.reply.mock.calls[0])).toContain(notYourChallenge);
      expect(ephemeral(interaction)).toBeTruthy();
      expect(interaction.update).not.toHaveBeenCalled();
      expect(interaction.announce).not.toHaveBeenCalled();

      // The stranger's press does not use the rematch up.
      const { interaction: player } = press('3');
      await vi.waitFor(() => expect(player.announce).toHaveBeenCalledTimes(1));
    });

    it('the loser pressing Rematch strips the button from the result and replies with a challenge from them to the winner, keeping their side, pinging only the winner', async () => {
      const { interaction } = press('3');
      await vi.waitFor(() => expect(interaction.announce).toHaveBeenCalledTimes(1));

      const [update] = interaction.update.mock.calls[0] as unknown as [{ flags: number }];
      expect(json(update)).toContain('<@1> wins **194**');
      expect(buttonIds(update)).toEqual([]);
      expect(update.flags & MessageFlags.IsComponentsV2).toBeTruthy();

      const [reply] = interaction.announce.mock.calls[0] as unknown as [
        { allowedMentions: unknown; flags: number },
      ];
      expect(json(reply)).toContain('<@3> bets **100** on tails');
      expect(json(reply)).toContain('<@1> can accept.');
      expect(reply.allowedMentions).toEqual({ users: ['1'] });
      expect(reply.flags & MessageFlags.Ephemeral).toBeFalsy();
      const ids = buttonIds(reply);
      expect(ids.map((id) => id.split(':').slice(0, 6).join(':'))).toEqual([
        'cf:accept:3:1:100:tails',
        'cf:decline:3:1:100:tails',
        'cf:cancel:3:1:100:tails',
      ]);
      expect(flipCount()).toBe(0);
    });

    it('the winner pressing Rematch challenges the loser on the side the winner held', async () => {
      const { interaction } = press('1');
      await vi.waitFor(() => expect(interaction.announce).toHaveBeenCalledTimes(1));

      const [reply] = interaction.announce.mock.calls[0] as unknown as [
        { allowedMentions: unknown },
      ];
      expect(json(reply)).toContain('<@1> bets **100** on heads');
      expect(reply.allowedMentions).toEqual({ users: ['3'] });
      expect(buttonIds(reply)[0]).toMatch(/^cf:accept:1:3:100:heads:/);
    });

    it('a second press (either player) gets rematchTaken and sends nothing', async () => {
      const first = press('3');
      await vi.waitFor(() => expect(first.interaction.announce).toHaveBeenCalledTimes(1));

      for (const userId of ['3', '1']) {
        const { interaction } = press(userId);
        await answered(interaction);
        expect(json(interaction.reply.mock.calls[0])).toContain(rematchTaken);
        expect(ephemeral(interaction)).toBeTruthy();
        expect(interaction.update).not.toHaveBeenCalled();
        expect(interaction.announce).not.toHaveBeenCalled();
      }
    });

    it('both players pressing at once start exactly one rematch', async () => {
      const presses = [press('3'), press('1'), press('3')];
      for (const { interaction } of presses) await answered(interaction);
      await wait(50);

      const sends = presses.flatMap(({ interaction }) => interaction.announce.mock.calls);
      expect(sends).toHaveLength(1);
      const refused = presses.filter(({ interaction }) => interaction.reply.mock.calls.length);
      expect(refused).toHaveLength(2);
      for (const { interaction } of refused) {
        expect(json(interaction.reply.mock.calls[0])).toContain(rematchTaken);
        expect(ephemeral(interaction)).toBeTruthy();
      }
    });

    it('re-arms the rematch card after restart without extending its deadline', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      try {
        const { interaction, sent } = press('3');
        await vi.waitFor(() => expect(interaction.announce).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(20_000);
        clearChallenges();
        const edit = vi.fn(async (_messageId: string, _options: unknown) => ({}));
        vi.spyOn(client.channels, 'fetch').mockResolvedValue({
          isSendable: () => true,
          messages: { edit },
        } as never);
        restoreChallengeCards(client);
        await vi.advanceTimersByTimeAsync(39_000);
        expect(edit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(edit).toHaveBeenCalledExactlyOnceWith('r2', expect.anything());
        expect(json(edit.mock.calls[0])).toContain('Challenge expired.');
        expect(buttonIds(edit.mock.calls[0])).toEqual([]);
        expect(sent.edit).not.toHaveBeenCalled();
        expect(interaction.message.edit).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('accepting the rematch settles as a normal challenge', async () => {
      const { interaction } = press('3');
      await vi.waitFor(() => expect(interaction.announce).toHaveBeenCalledTimes(1));
      const accept = buttonIds(interaction.announce.mock.calls[0])[0] as string;

      // Tails: the rematch challenger (3) wins.
      mockRandomInt(1);
      const accepted = await click(accept, '1', 'r2');

      expect(json(accepted.update.mock.calls[0])).toContain('<@3> vs <@1> · 100 each');
      const result = await flipResult(accepted);
      expect(result).toContain('<@3> wins **194**');
      expect(buttonIds(accepted.editReply.mock.calls.at(-1))).toEqual(['cf:rematch:3:1:100:tails']);
      expect(balance('3')).toBe(startingBalance + 94);
      expect(balance('1')).toBe(startingBalance - 100);
      expect(potAmount()).toBe(pot.seed + 6);
      expect(flipCount()).toBe(1);
    });

    it('logs a failed rematch reply at error and leaves the result card stripped', async () => {
      const error = vi.spyOn(container.logger, 'error').mockImplementation(() => undefined);
      const { interaction } = press('3');
      interaction.announce.mockRejectedValueOnce(new Error('Missing Permissions'));
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

      expect(String(error.mock.calls[0]?.[0])).toContain('Missing Permissions');
      expect(buttonIds(interaction.update.mock.calls[0])).toEqual([]);
      expect(interaction.reply).not.toHaveBeenCalled();
    });

    it('a stake check happens at accept time, not when the rematch is sent', async () => {
      drain('3', 50);
      const { interaction } = press('3');
      await vi.waitFor(() => expect(interaction.announce).toHaveBeenCalledTimes(1));
      const accept = buttonIds(interaction.announce.mock.calls[0])[0] as string;

      const accepted = await click(accept, '1', 'r2');
      expect(json(accepted.update.mock.calls[0])).toContain("<@3> can't cover the bet anymore.");
      expect(flipCount()).toBe(0);
    });
  });

  it('ignores ids it cannot decode', async () => {
    const interaction = makeButton(client, { customId: 'cf:accept:garbage', userId: '1' });
    client.emit(Events.InteractionCreate, interaction as never);
    await wait(100);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
  });
});
