import { container } from '@sapphire/framework';
import { type Client, ComponentType, type ContainerBuilder, RESTJSONErrorCodes } from 'discord.js';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { pendingCoinflipChallenges } from '../../db/schema.js';
import { accents, card, cardReply } from '../ui/index.js';
import { type ChallengeClosedReason, type ChallengeView, challengeClosedCard } from './cards.js';
import { scheduleExpiry } from './challenges.js';
import { coinflip } from './config.js';
import { decodeCoinflipId } from './custom-ids.js';
import { ChallengeLimitError } from './errors.js';
import { isChallengeSettled } from './play.js';

type EditCard = (card: ContainerBuilder) => Promise<unknown>;

const byMessage = (messageId: string) => eq(pendingCoinflipChallenges.messageId, messageId);

export function forgetChallengeCard(messageId: string): void {
  container.db.delete(pendingCoinflipChallenges).where(byMessage(messageId)).run();
}

export function isChallengeCardClosed(messageId: string): boolean {
  return (
    container.db
      .select({ messageId: pendingCoinflipChallenges.messageId })
      .from(pendingCoinflipChallenges)
      .where(and(byMessage(messageId), isNotNull(pendingCoinflipChallenges.closedReason)))
      .get() !== undefined
  );
}

/** Save the outcome before editing Discord, so a failed edit cannot reopen the challenge. */
export async function closeChallengeCard(
  messageId: string,
  view: ChallengeView,
  reason: ChallengeClosedReason,
  edit: EditCard,
): Promise<unknown> {
  container.db
    .update(pendingCoinflipChallenges)
    .set({ closedReason: reason })
    .where(byMessage(messageId))
    .run();
  const result = await edit(challengeClosedCard(view, reason));
  forgetChallengeCard(messageId);
  return result;
}

async function discardIfGone(messageId: string, sync: () => Promise<unknown>): Promise<void> {
  try {
    await sync();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== RESTJSONErrorCodes.UnknownChannel && code !== RESTJSONErrorCodes.UnknownMessage) {
      throw error;
    }
    forgetChallengeCard(messageId);
  }
}

/** How many challenges a player has live (not yet closed) in a guild. */
export function liveChallengeCount(guildId: string, challengerId: string): number {
  return (
    container.db
      .select({ count: sql<number>`count(*)` })
      .from(pendingCoinflipChallenges)
      .where(
        and(
          eq(pendingCoinflipChallenges.guildId, guildId),
          eq(pendingCoinflipChallenges.challengerId, challengerId),
          isNull(pendingCoinflipChallenges.closedReason),
        ),
      )
      .get()?.count ?? 0
  );
}

/** Slots claimed by challenges that are being posted: no row exists until the card is sent. */
const reservations = new Map<string, number>();

const reservationKey = (guildId: string, challengerId: string) => `${guildId}:${challengerId}`;

/** Throws a `ChallengeLimitError` when the player cannot post another challenge in the guild. */
export function assertChallengeCapacity(guildId: string, challengerId: string): void {
  const inFlight = reservations.get(reservationKey(guildId, challengerId)) ?? 0;
  if (liveChallengeCount(guildId, challengerId) + inFlight >= coinflip.maxLiveChallenges) {
    throw new ChallengeLimitError(coinflip.maxLiveChallenges);
  }
}

/**
 * Checks the cap and claims a slot in one synchronous step, so concurrent challenge starts (which
 * only get a row once their card is sent) cannot all pass the check. Call the returned function
 * in a `finally`, after `trackChallengeCard` has inserted the row or the post has failed.
 */
export function reserveChallengeSlot(guildId: string, challengerId: string): () => void {
  assertChallengeCapacity(guildId, challengerId);
  const key = reservationKey(guildId, challengerId);
  reservations.set(key, (reservations.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const left = (reservations.get(key) ?? 1) - 1;
    if (left > 0) {
      reservations.set(key, left);
    } else {
      reservations.delete(key);
    }
  };
}

export function trackChallengeCard(
  guildId: string,
  channelId: string,
  messageId: string,
  view: ChallengeView,
  edit: EditCard,
): void {
  container.db
    .insert(pendingCoinflipChallenges)
    .values({ ...view, guildId, channelId, messageId })
    .run();
  scheduleExpiry(messageId, Math.max(0, view.expiresAt - Date.now()), () =>
    discardIfGone(messageId, () => closeChallengeCard(messageId, view, 'expired', edit)),
  );
}

/** Re-arm live cards; queue an immediate edit for cards that closed or expired while offline. */
export function restoreChallengeCards(client: Client): void {
  for (const row of container.db.select().from(pendingCoinflipChallenges).all()) {
    const { messageId, guildId: _guildId, channelId, closedReason, opponentId, ...fields } = row;
    const view = { ...fields, opponentId: opponentId ?? undefined };
    const settled = isChallengeSettled(container.db, messageId);
    const delay = closedReason || settled ? 0 : Math.max(0, view.expiresAt - Date.now());
    scheduleExpiry(messageId, delay, () =>
      discardIfGone(messageId, async () => {
        const channel =
          client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
        if (!channel?.isSendable()) {
          forgetChallengeCard(messageId);
          return;
        }
        if (settled) {
          // Settlement committed, but the bot may have stopped before replacing the buttons.
          // Never replace a result card that has already been shown.
          const message = await channel.messages.fetch({ message: messageId, force: true });
          const hasChallengeButtons = message.components.some(
            (component) =>
              component.type === ComponentType.Container &&
              component.components.some(
                (child) =>
                  child.type === ComponentType.ActionRow &&
                  child.components.some(
                    (button) =>
                      button.type === ComponentType.Button &&
                      button.customId !== null &&
                      decodeCoinflipId(button.customId)?.kind === 'challenge',
                  ),
              ),
          );
          if (hasChallengeButtons) {
            await channel.messages.edit(
              messageId,
              cardReply(card(accents.brand, 'Challenge already settled.')),
            );
          }
          forgetChallengeCard(messageId);
          return;
        }
        await closeChallengeCard(messageId, view, closedReason ?? 'expired', (closed) =>
          channel.messages.edit(messageId, cardReply(closed)),
        );
      }),
    );
  }
}
