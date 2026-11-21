import { container } from '@sapphire/framework';
import { RESTJSONErrorCodes } from 'discord.js';
import { cardReply } from '../ui/index.js';
import { honeypotWarningCard } from './cards.js';
import { honeypotConfig } from './config.js';
import { honeypot, honeypotGuilds, setHoneypotMessage } from './store.js';

export type EnsureResult = 'unset' | 'edited' | 'reposted' | 'stale' | 'failed';

interface CardSyncState {
  timers: Map<string, NodeJS.Timeout>;
  chains: Map<string, Promise<EnsureResult>>;
}

declare module '@sapphire/pieces' {
  interface Container {
    /** Pending card refreshes and in-flight card syncs per guild. Lost on restart. */
    honeypotCardSync?: CardSyncState;
  }
}

// Held on the container so every loaded copy of this module (pieces included) shares one state.
const state = (): CardSyncState => {
  container.honeypotCardSync ??= { timers: new Map(), chains: new Map() };
  return container.honeypotCardSync;
};

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

async function sendableChannel(channelId: string) {
  const { channels } = container.client;
  const channel = channels.cache.get(channelId) ?? (await channels.fetch(channelId));
  return channel?.isSendable() ? channel : undefined;
}

async function run(guildId: string): Promise<EnsureResult> {
  try {
    const { channelId, messageId, kicks } = honeypot(container.db, guildId);
    if (channelId === undefined) {
      return 'unset';
    }
    const channel = await sendableChannel(channelId);
    if (!channel) {
      container.logger.warn(
        `Honeypot card: channel ${channelId} in guild ${guildId} is not sendable`,
      );
      return 'failed';
    }
    if (messageId !== undefined) {
      try {
        // No fetch first: the cache may still hold a message Discord already deleted.
        await channel.messages.edit(messageId, { components: [honeypotWarningCard(kicks)] });
        return 'edited';
      } catch (error) {
        if (errorCode(error) !== RESTJSONErrorCodes.UnknownMessage) {
          container.logger.warn(
            `Honeypot card: could not edit the card in guild ${guildId}`,
            error,
          );
          return 'failed';
        }
      }
    }
    const sent = await channel.send(cardReply(honeypotWarningCard(kicks)));
    if (!setHoneypotMessage(container.db, guildId, channelId, sent.id, Date.now())) {
      // The honeypot moved or was cleared while posting: drop the orphan.
      await deleteCard(channelId, sent.id);
      return 'stale';
    }
    return 'reposted';
  } catch (error) {
    container.logger.warn(`Honeypot card: could not sync the card in guild ${guildId}`, error);
    return 'failed';
  }
}

/**
 * Edits the stored card with the current kicks, or re-posts it (only on Unknown Message) and
 * stores the new ID. Serialized per guild; never throws.
 */
export function ensureCard(guildId: string): Promise<EnsureResult> {
  const { chains } = state();
  const prev = chains.get(guildId) ?? Promise.resolve<EnsureResult>('unset');
  const next = prev.catch(() => 'failed' as const).then(() => run(guildId));
  chains.set(guildId, next);
  const cleanup = () => {
    if (chains.get(guildId) === next) {
      chains.delete(guildId);
    }
  };
  // Both branches handled, so this derived promise can never reject unhandled.
  next.then(cleanup, cleanup);
  return next;
}

/** Trailing debounce per guild; the edit reads the latest count when it fires. */
export function scheduleCardRefresh(guildId: string): void {
  const { timers } = state();
  if (timers.has(guildId)) {
    return;
  }
  timers.set(
    guildId,
    setTimeout(() => {
      timers.delete(guildId);
      ensureCard(guildId).catch((error: unknown) => {
        container.logger.warn(`Honeypot card: refresh failed in guild ${guildId}`, error);
      });
    }, honeypotConfig.cardDebounceMs),
  );
}

/** Best-effort delete of a card; never throws. */
export async function deleteCard(channelId: string, messageId: string): Promise<boolean> {
  try {
    const channel = await sendableChannel(channelId);
    if (!channel) {
      return false;
    }
    await channel.messages.delete(messageId);
    return true;
  } catch (error) {
    container.logger.warn(`Honeypot card: could not delete card ${messageId}`, error);
    return false;
  }
}

/** ensureCard for each honeypot guild the client is in, `staggerMs` apart; errors logged. */
export async function ensureAllCards(
  staggerMs: number = honeypotConfig.readyStaggerMs,
): Promise<void> {
  try {
    const guilds = honeypotGuilds(container.db).filter(({ guildId }) =>
      container.client.guilds.cache.has(guildId),
    );
    for (const [index, { guildId }] of guilds.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, staggerMs));
      }
      const result = await ensureCard(guildId);
      if (result === 'failed') {
        container.logger.warn(`Honeypot card: startup sync failed in guild ${guildId}`);
      }
    }
  } catch (error) {
    container.logger.error('Honeypot card: startup sync failed', error);
  }
}

/** Re-posts when `message.id` is the currently stored card; returns whether it did. */
export async function onCardDeleted(message: {
  id: string;
  guildId: string | null;
}): Promise<boolean> {
  try {
    if (message.guildId === null) {
      return false;
    }
    if (honeypot(container.db, message.guildId).messageId !== message.id) {
      return false;
    }
    return (await ensureCard(message.guildId)) === 'reposted';
  } catch (error) {
    container.logger.warn('Honeypot card: could not re-post a deleted card', error);
    return false;
  }
}

/** onCardDeleted for a bulk delete: re-posts once when `ids` holds the stored card. */
export async function onCardsDeleted(guildId: string, ids: Iterable<string>): Promise<boolean> {
  try {
    const { messageId } = honeypot(container.db, guildId);
    if (messageId === undefined) {
      return false;
    }
    for (const id of ids) {
      if (id === messageId) {
        return await onCardDeleted({ id, guildId });
      }
    }
    return false;
  } catch (error) {
    container.logger.warn('Honeypot card: could not handle a bulk delete', error);
    return false;
  }
}

/** Clears pending timers and chains; for tests. */
export function resetCardSync(): void {
  const { timers, chains } = state();
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
  chains.clear();
}
