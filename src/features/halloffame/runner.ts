import { container } from '@sapphire/framework';
import { type Client, MessageType } from 'discord.js';
import type { Db } from '../../db/index.js';
import { honeypot } from '../honeypot/store.js';
import {
  type HallCardInput,
  hallAttachmentNames,
  hallCard,
  hallRenderHash,
  hallUploadName,
  isRenderableEmoji,
  jumpUrl,
} from './cards.js';
import { hallOfFame as config } from './config.js';
import { describeMessage, type HallImage, replySnippet } from './content.js';
import { createHallDiscord } from './discord.js';
import { type ChannelFacts, channelEligibility, eligibility } from './eligibility.js';
import {
  type HallDiscord,
  type HallFile,
  type HallLogger,
  type HallPost,
  type HallSourceMessage,
  hallErrorKind,
} from './port.js';
import { Debouncer, JobQueue, KeyedLock, TtlLru } from './queue.js';
import {
  countdown,
  type EmojiCount,
  emojisToFetch,
  mightQualify,
  normalReactionTotal,
  ReactorTally,
  reactionsNeeded,
  topBreakdown,
} from './score.js';
import {
  abandonedHallClaims,
  bumpHallPeak,
  claimHallEntry,
  deleteHallEntriesByHallChannel,
  deleteHallEntriesBySourceChannel,
  deleteHallEntry,
  getHallEntry,
  type HallEntry,
  hallExemptChannels,
  hallSettings,
  markHallMessagesRemoved,
  markHallPosted,
  releaseHallClaim,
  setHallRenderedHash,
} from './store.js';

/** One piece of work for a message: what changed since the card was last drawn. */
export interface HallJob {
  guildId: string;
  channelId: string;
  messageId: string;
  /** A reaction was added: look for a new peak (and induct a message not yet in the hall). */
  reaction: boolean;
  /** The source message was edited: draw the card again. */
  edit: boolean;
  /** A reaction was removed: only refreshes an inducted message. */
  refresh: boolean;
}

export interface HallReactionAdd {
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  /** From the raw payload (`message_author_id`), when Discord sends it. */
  messageAuthorId?: string | undefined;
  isBot: boolean;
  burst: boolean;
  emoji?: { id: string | null; name: string | null } | undefined;
}

export interface HallRunnerDeps {
  db: Db;
  discord: HallDiscord;
  logger: HallLogger;
  now?: () => number;
}

export interface HallRunner {
  onReactionAdd(event: HallReactionAdd): void;
  /** A reaction was removed (or all or one emoji cleared) on a message. */
  onReactionChange(event: { guildId: string; channelId: string; messageId: string }): void;
  onMessageUpdate(guildId: string, messageId: string): void;
  onSourceMessagesDeleted(guildId: string, messageIds: readonly string[]): Promise<void>;
  onSourceChannelDeleted(channelId: string): Promise<HallEntry[]>;
  /** Hall posts that were deleted become tombstones; returns the entries that were posted. */
  onHallMessagesDeleted(guildId: string, hallMessageIds: readonly string[]): HallEntry[];
  /** Deletes the entries that lived in a deleted hall channel and returns them. */
  onHallChannelDeleted(channelId: string): HallEntry[];
  /** Adopts or releases claims left `publishing`. With `all` even a fresh claim counts. */
  recover(options?: { all?: boolean }): Promise<void>;
  /** Forgets that channels were unreadable, such as after staff fixed permissions. */
  forgetFailures(channelId?: string): void;
  /** Resolves when the queue is empty and nothing is running (debounce timers excluded). */
  idle(): Promise<void>;
  stop(): void;
}

const keyOf = (guildId: string, messageId: string) => `${guildId}:${messageId}`;

const mergeJobs = (a: HallJob, b: HallJob): HallJob => ({
  ...b,
  reaction: a.reaction || b.reaction,
  edit: a.edit || b.edit,
  refresh: a.refresh || b.refresh,
});

interface Counter {
  remaining: number;
  threshold: number;
}

interface Tallied {
  tally: ReactorTally;
  /** Counting stopped at the threshold, so the count is a lower bound. */
  early: boolean;
  /** Some emoji or users were not fetched, so the count may be low. */
  truncated: boolean;
}

export function createHallRunner(deps: HallRunnerDeps): HallRunner {
  const { db, discord, logger } = deps;
  const now = deps.now ?? Date.now;
  const lock = new KeyedLock();
  const counters = new TtlLru<Counter>(config.counterCacheSize, config.counterTtlMs, now);
  const lastSync = new TtlLru<number>(config.counterCacheSize, config.counterTtlMs, now);
  const failures = new Map<string, number>();
  let stopped = false;

  /* ------------------------------------------------------------ failure memory */

  const noteFailure = (channelId: string) => {
    if (failures.size >= 1000) {
      for (const [id, until] of failures) if (until <= now()) failures.delete(id);
    }
    failures.set(channelId, now() + config.failureMemoryMs);
  };
  const isFailing = (channelId: string) => {
    const until = failures.get(channelId);
    if (until === undefined) return false;
    if (until <= now()) {
      failures.delete(channelId);
      return false;
    }
    return true;
  };

  /* -------------------------------------------------------------- queue plumbing */

  const queue = new JobQueue<HallJob>({
    concurrency: config.queueConcurrency,
    cap: config.queueCap,
    key: (job) => keyOf(job.guildId, job.messageId),
    merge: mergeJobs,
    run: (job) => processJob(job),
    onError: (job, error) =>
      logger.warn(`Hall of Fame job for message ${job.messageId} in ${job.guildId} failed`, error),
  });

  const debouncer = new Debouncer<HallJob>({
    delayMs: config.debounceMs,
    maxWaitMs: config.maxWaitMs,
    merge: mergeJobs,
    now,
    fire: (key, job) => {
      if (stopped) return;
      if (queue.push(job) === 'dropped') {
        // The next reaction triggers it again, so nothing may keep it from being counted.
        counters.delete(key);
        logger.debug(`Hall of Fame queue is full, dropped message ${job.messageId}`);
      }
    },
  });

  const forget = (key: string) => {
    debouncer.cancel(key);
    counters.delete(key);
    lastSync.delete(key);
  };

  /* ----------------------------------------------------------------- Discord I/O */

  async function channelInfo(guildId: string, channelId: string) {
    try {
      return await discord.channel(guildId, channelId);
    } catch (error) {
      const kind = hallErrorKind(error);
      if (kind === 'unknown-channel' || kind === 'forbidden') {
        noteFailure(channelId);
        logger.debug(`Hall of Fame cannot see channel ${channelId} (${kind})`);
      } else {
        logger.warn(`Hall of Fame could not look up channel ${channelId}`, error);
      }
      return undefined;
    }
  }

  async function discardHallMessage(entry: Pick<HallEntry, 'hallChannelId' | 'hallMessageId'>) {
    if (entry.hallMessageId === null) return;
    try {
      await discord.deleteHall(entry.hallChannelId, entry.hallMessageId);
    } catch (error) {
      if (hallErrorKind(error) !== 'unknown-message') {
        logger.warn(`Hall of Fame could not delete hall message ${entry.hallMessageId}`, error);
      }
    }
  }

  /** Counts distinct people over the emoji of a message; throws if a fetch fails. */
  async function tallyReactors(
    message: HallSourceMessage,
    stopAt: number | undefined,
  ): Promise<Tallied> {
    const tally = new ReactorTally(message.author.id);
    const byEmoji = new Map(message.reactions.map((reaction) => [reaction.emoji, reaction]));
    const withReactors = message.reactions.filter((reaction) => reaction.normal > 0);
    const picked = emojisToFetch(message.reactions);
    let early = false;
    let truncated = withReactors.length > picked.length;
    for (const entry of picked) {
      if (stopAt !== undefined && tally.enough(stopAt)) {
        early = true;
        break;
      }
      const reaction = byEmoji.get(entry.emoji);
      if (!reaction) continue;
      const users = await discord.fetchReactors(
        message.channelId,
        message.id,
        reaction.key,
        config.reactorPageSize,
      );
      if (users.length >= config.reactorPageSize) truncated = true;
      tally.add(reaction.emoji, users);
    }
    return { tally, early, truncated };
  }

  /* ---------------------------------------------------------------------- cards */

  async function cardInput(
    message: HallSourceMessage,
    options: {
      guildId: string;
      peak: number;
      threshold: number;
      perEmoji: readonly EmojiCount[];
      channelName: string | undefined;
    },
  ): Promise<HallCardInput> {
    const { author } = message;
    let profile: { displayName: string; avatarUrl: string } | undefined;
    try {
      profile = await discord.profile(options.guildId, author.id);
    } catch {
      profile = undefined;
    }
    const body = describeMessage(message.facts);
    return {
      author: {
        id: author.id,
        displayName: profile?.displayName ?? author.displayName,
        username: author.username,
        avatarUrl: profile?.avatarUrl ?? author.avatarUrl,
      },
      source: {
        guildId: options.guildId,
        channelId: message.channelId,
        messageId: message.id,
        channelName: options.channelName,
        createdAt: message.createdAt,
      },
      body,
      reply: message.reply
        ? {
            authorName: message.reply.authorName,
            snippet: replySnippet(message.reply.content, message.reply.hasMedia),
          }
        : undefined,
      peak: options.peak,
      threshold: options.threshold,
      breakdown: topBreakdown(options.perEmoji, undefined, isRenderableEmoji),
      // Planned: every image. `attachImages` narrows it to what was actually uploaded.
      uploaded: body.images.map((image, index) => hallUploadName(image, index)),
    };
  }

  /** Downloads the images, skipping any that fail or break the size caps; never throws. */
  async function downloadImages(images: readonly HallImage[]): Promise<HallFile[]> {
    const results = await Promise.allSettled(images.map((image) => discord.download(image.url)));
    const files: HallFile[] = [];
    let total = 0;
    results.forEach((result, index) => {
      const image = images[index];
      if (!image || result.status !== 'fulfilled') return;
      const size = result.value.length;
      if (size === 0 || size > config.maxImageBytes || total + size > config.maxImageBytesTotal) {
        return;
      }
      total += size;
      files.push({ name: hallUploadName(image, index), data: result.value });
    });
    return files;
  }

  /** Narrows `input.uploaded` to the files and returns exactly those the card references. */
  function attachImages(input: HallCardInput, files: readonly HallFile[]): HallFile[] {
    input.uploaded = files.map((file) => file.name);
    const referenced = new Set(hallAttachmentNames(input));
    return files.filter((file) => referenced.has(file.name));
  }

  /* ---------------------------------------------------------------------- induct */

  /**
   * After a send that may or may not have reached Discord: the id of our card in the hall when it
   * did. Otherwise undefined, and the claim stays `publishing` for the hourly recovery (which
   * checks again once the claim is stale) so a retry cannot post twice.
   */
  async function adoptAfterAmbiguousSend(claim: HallEntry): Promise<string | undefined> {
    try {
      const found = await findPostedCard(claim);
      if (found === undefined) {
        logger.warn(
          `Hall of Fame cannot tell whether the card of ${claim.messageId} was sent, keeping the claim`,
        );
      }
      return found;
    } catch (error) {
      logger.warn(`Hall of Fame could not look for the card of ${claim.messageId}`, error);
      return undefined;
    }
  }

  async function induct(job: HallJob): Promise<void> {
    const { guildId, channelId, messageId } = job;
    const key = keyOf(guildId, messageId);
    const settings = hallSettings(db, guildId);
    const hallChannelId = settings.channelId;
    if (hallChannelId === undefined) return;
    if (isFailing(channelId) || isFailing(hallChannelId)) return;

    const source = await channelInfo(guildId, channelId);
    const hall = await channelInfo(guildId, hallChannelId);
    if (!source || !hall) return;

    const exempt = hallExemptChannels(db, guildId);
    const potId = honeypot(db, guildId).channelId;
    const before = eligibility(
      settings,
      exempt,
      potId,
      source.facts,
      hall.facts,
      { bot: false, webhook: false },
      MessageType.Default,
    );
    if (!before.ok) return;
    if (!source.can.view || !source.can.readHistory) {
      noteFailure(channelId);
      return;
    }
    if (!hall.can.view || !hall.can.send || !hall.can.attachFiles) {
      noteFailure(hallChannelId);
      logger.warn(
        `Hall of Fame channel ${hallChannelId} needs View Channel, Send Messages and Attach Files`,
      );
      return;
    }

    let message: HallSourceMessage;
    try {
      message = await discord.fetchMessage(guildId, channelId, messageId);
    } catch (error) {
      const kind = hallErrorKind(error);
      // A deleted message says nothing about the channel.
      if (kind === 'unknown-channel' || kind === 'forbidden') noteFailure(channelId);
      else if (kind === 'other' || kind === 'rejected') {
        logger.warn(`Hall of Fame could not fetch ${messageId}`, error);
      }
      return;
    }

    const after = eligibility(
      settings,
      exempt,
      potId,
      source.facts,
      hall.facts,
      { bot: message.author.bot, webhook: message.author.webhook },
      message.type,
    );
    if (!after.ok) {
      // This message can never qualify (a bot's reaction roles, a system message): stop refetching.
      if (['bot-author', 'webhook-author', 'message-type'].includes(after.reason)) {
        counters.set(key, { remaining: Number.POSITIVE_INFINITY, threshold: settings.threshold });
      }
      return;
    }

    const { threshold } = settings;
    const notEnough = (distinct: number, truncated: boolean) => {
      counters.set(key, {
        remaining: truncated ? 1 : reactionsNeeded(threshold, distinct),
        threshold,
      });
    };
    if (!mightQualify(message.reactions, threshold)) {
      notEnough(normalReactionTotal(message.reactions), false);
      return;
    }
    let tallied: Tallied;
    try {
      tallied = await tallyReactors(message, threshold);
    } catch (error) {
      logger.warn(`Hall of Fame could not count the reactions on ${messageId}`, error);
      return;
    }
    const { tally } = tallied;
    if (!tally.enough(threshold)) {
      notEnough(tally.distinct, tallied.truncated);
      return;
    }

    const claim = claimHallEntry(
      db,
      {
        guildId,
        messageId,
        channelId,
        parentChannelId: source.facts.parentId,
        authorId: message.author.id,
        hallChannelId,
      },
      now(),
    );
    if (claim.kind !== 'claimed') return;

    let input: HallCardInput;
    let post: HallPost;
    try {
      input = await cardInput(message, {
        guildId,
        peak: tally.distinct,
        threshold,
        perEmoji: tally.score().perEmoji,
        channelName: source.name,
      });
      const files = attachImages(input, await downloadImages(input.body.images));
      post = { card: hallCard(input), files, nonce: messageId.slice(0, 25) };
    } catch (error) {
      // Nothing was sent yet, so the claim can go.
      releaseHallClaim(db, guildId, messageId);
      logger.warn(`Hall of Fame could not post message ${messageId}`, error);
      return;
    }

    let hallMessageId: string;
    try {
      hallMessageId = await discord.sendHall(hallChannelId, post);
    } catch (error) {
      const kind = hallErrorKind(error);
      if (kind === 'forbidden') noteFailure(hallChannelId);
      logger.warn(`Hall of Fame could not post message ${messageId}`, error);
      if (kind === 'forbidden' || kind === 'unknown-channel' || kind === 'rejected') {
        // Discord answered with a refusal: no message exists, so the next reaction may retry.
        releaseHallClaim(db, guildId, messageId);
        return;
      }
      // A timeout, reset or server error: Discord may have created the card. Keep the claim (a
      // second post could be a duplicate) and look for our own card right away.
      const found = await adoptAfterAmbiguousSend(claim.entry);
      if (found === undefined) return;
      hallMessageId = found;
    }

    try {
      const posted = markHallPosted(
        db,
        guildId,
        messageId,
        { hallMessageId, peakCount: tally.distinct, renderedHash: hallRenderHash(input) },
        now(),
      );
      if (!posted) {
        // Discarded mid-post (the source was deleted): nothing records this message.
        await discardHallMessage({ hallChannelId, hallMessageId });
        return;
      }
    } catch (error) {
      await discardHallMessage({ hallChannelId, hallMessageId });
      releaseHallClaim(db, guildId, messageId);
      logger.warn(`Hall of Fame could not record message ${messageId}`, error);
      return;
    }

    lastSync.set(key, now());
    // An early exit counted only enough people to qualify: refine the count and breakdown later.
    if (tallied.early || tallied.truncated) {
      debouncer.schedule(
        key,
        { guildId, channelId, messageId, reaction: true, edit: false, refresh: false },
        config.peakCooldownMs,
      );
    }
  }

  /* ------------------------------------------------------------------------ sync */

  /** The source is gone: delete the row first, so our own delete event finds nothing to tombstone. */
  async function dropEntry(entry: HallEntry): Promise<void> {
    forget(keyOf(entry.guildId, entry.messageId));
    const removed = deleteHallEntry(db, entry.guildId, entry.messageId);
    if (removed?.status === 'posted') await discardHallMessage(removed);
  }

  async function sync(entry: HallEntry, job: HallJob): Promise<void> {
    const { guildId, messageId } = entry;
    const key = keyOf(guildId, messageId);
    if (entry.hallMessageId === null) return;
    const hallMessageId = entry.hallMessageId;

    // Reaction work waits out the cooldown (deferred, never dropped).
    const last = lastSync.get(key);
    const due = job.edit || last === undefined || now() - last >= config.peakCooldownMs;
    if (!due && last !== undefined) {
      debouncer.schedule(key, job, last + config.peakCooldownMs - now());
      return;
    }

    let message: HallSourceMessage;
    try {
      message = await discord.fetchMessage(guildId, entry.channelId, messageId);
    } catch (error) {
      const kind = hallErrorKind(error);
      if (kind === 'unknown-message' || kind === 'unknown-channel') {
        await dropEntry(entry);
      } else if (kind === 'forbidden') {
        noteFailure(entry.channelId);
        logger.debug(`Hall of Fame cannot read ${messageId} any more`);
      } else {
        logger.warn(`Hall of Fame could not refresh ${messageId}`, error);
      }
      return;
    }
    lastSync.set(key, now());

    // The channel may have changed since the induction (made private, age-restricted or exempt,
    // or the hall opened to the public): never copy a later edit out of it. The post stays as is.
    const source = await channelInfo(guildId, entry.channelId);
    const hall = await channelInfo(guildId, entry.hallChannelId);
    const verdict =
      source && hall
        ? eligibility(
            // The post lives where it was made, even when the hall channel changed since.
            { channelId: entry.hallChannelId },
            hallExemptChannels(db, guildId),
            honeypot(db, guildId).channelId,
            source.facts,
            hall.facts,
            { bot: message.author.bot, webhook: message.author.webhook },
            message.type,
          )
        : undefined;
    if (!source || !verdict?.ok) {
      logger.debug(
        `Hall of Fame leaves the post of ${messageId} as it is (${verdict && !verdict.ok ? verdict.reason : 'channel unavailable'})`,
      );
      return;
    }

    let tallied: Tallied;
    try {
      tallied = await tallyReactors(message, undefined);
    } catch (error) {
      // A partial count would change the breakdown and hash, so leave the card as it is.
      logger.warn(`Hall of Fame could not count the reactions on ${messageId}`, error);
      return;
    }

    // Peak only ever rises, whatever order syncs finish in.
    const row = bumpHallPeak(db, guildId, messageId, tallied.tally.distinct, now());
    if (!row?.hallMessageId) return;

    const input = await cardInput(message, {
      guildId,
      peak: row.peakCount,
      threshold: hallSettings(db, guildId).threshold,
      perEmoji: tallied.tally.score().perEmoji,
      channelName: source.name,
    });
    // An unchanged card (an embed that resolved, a reaction that changed nothing) is not edited.
    if (hallRenderHash(input) === row.lastRenderedHash) return;
    const files = attachImages(input, await downloadImages(input.body.images));
    const hash = hallRenderHash(input);
    if (hash === row.lastRenderedHash) return;

    try {
      await discord.editHall(row.hallChannelId, hallMessageId, { card: hallCard(input), files });
    } catch (error) {
      const kind = hallErrorKind(error);
      if (kind === 'unknown-message') {
        markHallMessagesRemoved(db, [hallMessageId], now());
        forget(key);
      } else if (kind === 'other' || kind === 'rejected') {
        logger.warn(`Hall of Fame could not edit hall message ${hallMessageId}`, error);
      } else {
        logger.debug(`Hall of Fame could not edit hall message ${hallMessageId} (${kind})`);
      }
      return;
    }
    setHallRenderedHash(db, guildId, messageId, hash, now());
  }

  async function processJob(job: HallJob): Promise<void> {
    if (stopped) return;
    const key = keyOf(job.guildId, job.messageId);
    await lock.run(key, async () => {
      if (stopped) return;
      const entry = getHallEntry(db, job.guildId, job.messageId);
      if (!entry) {
        if (job.reaction) await induct(job);
        return;
      }
      // `publishing` belongs to whoever claimed it; `removed` is a tombstone.
      if (entry.status === 'posted') await sync(entry, job);
    });
  }

  /* ---------------------------------------------------------------------- events */

  function onReactionAdd(event: HallReactionAdd): void {
    if (stopped) return;
    const { guildId, channelId, messageId } = event;
    if (event.burst || event.isBot || event.userId === discord.botId) return;
    if (event.messageAuthorId !== undefined) {
      // Self-reactions never count; reactions on our own cards (an old hall) are not worth a fetch.
      if (event.messageAuthorId === event.userId || event.messageAuthorId === discord.botId) return;
    }
    const settings = hallSettings(db, guildId);
    if (settings.channelId === undefined) return;
    if (isFailing(channelId) || isFailing(settings.channelId)) return;

    const facts: ChannelFacts = discord.peekChannel(guildId, channelId) ?? {
      id: channelId,
      isThread: false,
      isPrivateThread: false,
      nsfw: false,
      audience: undefined,
      overwrites: undefined,
    };
    const verdict = channelEligibility(
      settings,
      hallExemptChannels(db, guildId),
      honeypot(db, guildId).channelId,
      facts,
    );
    if (!verdict.ok) return;

    const key = keyOf(guildId, messageId);
    const entry = getHallEntry(db, guildId, messageId);
    if (entry && entry.status !== 'posted') return;
    if (!entry) {
      const counter = counters.get(key);
      if (counter && counter.threshold === settings.threshold) {
        const step = countdown(counter.remaining);
        if (!step.ready) {
          counters.set(key, { ...counter, remaining: step.remaining });
          return;
        }
      }
      counters.delete(key);
    }
    debouncer.schedule(key, {
      guildId,
      channelId,
      messageId,
      reaction: true,
      edit: false,
      refresh: false,
    });
  }

  function onReactionChange(event: { guildId: string; channelId: string; messageId: string }) {
    if (stopped || isFailing(event.channelId)) return;
    const entry = getHallEntry(db, event.guildId, event.messageId);
    if (entry?.status !== 'posted') return;
    debouncer.schedule(keyOf(event.guildId, event.messageId), {
      guildId: event.guildId,
      channelId: entry.channelId,
      messageId: event.messageId,
      reaction: false,
      edit: false,
      refresh: true,
    });
  }

  function onMessageUpdate(guildId: string, messageId: string) {
    if (stopped) return;
    const entry = getHallEntry(db, guildId, messageId);
    if (entry?.status !== 'posted') return;
    debouncer.schedule(keyOf(guildId, messageId), {
      guildId,
      channelId: entry.channelId,
      messageId,
      reaction: false,
      edit: true,
      refresh: false,
    });
  }

  async function onSourceMessagesDeleted(guildId: string, messageIds: readonly string[]) {
    for (const messageId of messageIds) {
      const key = keyOf(guildId, messageId);
      forget(key);
      if (!getHallEntry(db, guildId, messageId)) continue;
      await lock.run(key, async () => {
        // Row first, then the hall message, so the hall message's own delete event is a no-op.
        const removed = deleteHallEntry(db, guildId, messageId);
        if (removed?.status === 'posted') await discardHallMessage(removed);
      });
    }
  }

  async function onSourceChannelDeleted(channelId: string) {
    failures.delete(channelId);
    const rows = deleteHallEntriesBySourceChannel(db, channelId);
    for (const row of rows) {
      forget(keyOf(row.guildId, row.messageId));
      if (row.status === 'posted') await discardHallMessage(row);
    }
    return rows;
  }

  function onHallMessagesDeleted(guildId: string, hallMessageIds: readonly string[]) {
    const rows = markHallMessagesRemoved(db, [...hallMessageIds], now());
    for (const row of rows) forget(keyOf(row.guildId, row.messageId));
    return rows.filter((row) => row.guildId === guildId);
  }

  function onHallChannelDeleted(channelId: string) {
    failures.delete(channelId);
    const rows = deleteHallEntriesByHallChannel(db, channelId);
    for (const row of rows) forget(keyOf(row.guildId, row.messageId));
    return rows;
  }

  /* -------------------------------------------------------------------- recovery */

  /** Looks for our own card for this source in the hall channel's recent messages. */
  async function findPostedCard(entry: HallEntry): Promise<string | undefined> {
    const url = jumpUrl(entry);
    let before: string | undefined;
    for (let page = 0; page < config.recoveryScanPages; page++) {
      const recent = await discord.fetchRecent(entry.hallChannelId, before);
      const found = recent.find(
        (message) => message.authorId === discord.botId && message.links.includes(url),
      );
      if (found) return found.id;
      const oldest = recent[recent.length - 1];
      if (recent.length < 100 || !oldest) return undefined;
      before = oldest.id;
    }
    return undefined;
  }

  async function recoverClaim(claim: HallEntry, all: boolean) {
    const { guildId, messageId } = claim;
    const key = keyOf(guildId, messageId);
    await lock.run(key, async () => {
      const entry = getHallEntry(db, guildId, messageId);
      if (entry?.status !== 'publishing') return;
      if (!all && entry.createdAt >= now() - config.publishStaleMs) return;
      let found: string | undefined;
      try {
        found = await findPostedCard(entry);
      } catch (error) {
        const kind = hallErrorKind(error);
        if (kind === 'unknown-channel') {
          releaseHallClaim(db, guildId, messageId);
        } else {
          // Cannot tell whether it was sent: keep the claim so a retry cannot double post.
          logger.warn(`Hall of Fame could not look for the card of ${messageId}`, error);
        }
        return;
      }
      if (found === undefined) {
        releaseHallClaim(db, guildId, messageId);
        return;
      }
      const adopted = markHallPosted(
        db,
        guildId,
        messageId,
        { hallMessageId: found, peakCount: 0, renderedHash: '' },
        now(),
      );
      if (adopted) {
        // The real count and a fresh card follow.
        debouncer.schedule(key, {
          guildId,
          channelId: entry.channelId,
          messageId,
          reaction: false,
          edit: true,
          refresh: false,
        });
      }
    });
  }

  async function recover(options: { all?: boolean } = {}) {
    const claims = abandonedHallClaims(db, options.all ? now() + 1 : now() - config.publishStaleMs);
    for (const claim of claims) {
      if (stopped) return;
      try {
        await recoverClaim(claim, options.all === true);
      } catch (error) {
        logger.warn(`Hall of Fame recovery of ${claim.messageId} failed`, error);
      }
    }
  }

  return {
    onReactionAdd,
    onReactionChange,
    onMessageUpdate,
    onSourceMessagesDeleted,
    onSourceChannelDeleted,
    onHallMessagesDeleted,
    onHallChannelDeleted,
    recover,
    forgetFailures: (channelId) => {
      if (channelId === undefined) failures.clear();
      else failures.delete(channelId);
    },
    idle: () => queue.idle(),
    stop: () => {
      stopped = true;
      debouncer.clear();
      queue.clear();
    },
  };
}

/* ------------------------------------------------------------ the running instance */

let current: HallRunner | undefined;

/**
 * Starts the Hall of Fame runner (call from the ready listener). Claims left `publishing` by a
 * previous run are adopted or released at once, and again every hour. Returns a stop function.
 */
export function startHallOfFame(client: Client<true>): () => void {
  const { db, logger } = container;
  const runner = createHallRunner({ db, discord: createHallDiscord(client), logger });
  const uninstall = installHallRunner(runner);
  const recover = (all: boolean) =>
    void runner
      .recover({ all })
      .catch((error) => logger.warn('Hall of Fame recovery failed', error));
  recover(true);
  const timer = setInterval(() => recover(false), config.recoveryIntervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    uninstall();
  };
}

/**
 * Makes `runner` the one the listeners feed, stopping the previous one. Returns a function that
 * stops it and uninstalls it. `startHallOfFame` uses this; tests install a stub.
 */
export function installHallRunner(runner: HallRunner): () => void {
  current?.stop();
  current = runner;
  return () => {
    runner.stop();
    if (current === runner) current = undefined;
  };
}

/** A reaction was added (a no-op until `startHallOfFame` ran). */
export function onReactionAdd(event: HallReactionAdd): void {
  current?.onReactionAdd(event);
}

/** A reaction was removed, or all of a message's (or one emoji's) reactions were cleared. */
export function onReactionChange(event: {
  guildId: string;
  channelId: string;
  messageId: string;
}): void {
  current?.onReactionChange(event);
}

export function onMessageUpdate(guildId: string, messageId: string): void {
  current?.onMessageUpdate(guildId, messageId);
}

export async function onSourceMessagesDeleted(
  guildId: string,
  messageIds: readonly string[],
): Promise<void> {
  await current?.onSourceMessagesDeleted(guildId, messageIds);
}

export async function onSourceChannelDeleted(channelId: string): Promise<HallEntry[]> {
  return (await current?.onSourceChannelDeleted(channelId)) ?? [];
}

export function onHallMessagesDeleted(
  guildId: string,
  hallMessageIds: readonly string[],
): HallEntry[] {
  return current?.onHallMessagesDeleted(guildId, hallMessageIds) ?? [];
}

export function onHallChannelDeleted(channelId: string): HallEntry[] {
  return current?.onHallChannelDeleted(channelId) ?? [];
}

/** Forgets channels remembered as unreadable (after staff changed the hall channel or permissions). */
export function forgetHallFailures(channelId?: string): void {
  current?.forgetFailures(channelId);
}
