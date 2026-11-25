import {
  type APIAttachment,
  type APIEmbed,
  type APIMessage,
  type APIReaction,
  type APIStickerItem,
  type Channel,
  ChannelType,
  type Client,
  DiscordAPIError,
  type Guild,
  MessageFlags,
  MessageType,
  OverwriteType,
  PermissionFlagsBits,
  type RESTGetAPIChannelMessageReactionUsersResult,
  type RESTGetAPIChannelMessagesResult,
  RESTJSONErrorCodes,
  ReactionType,
  type Role,
  Routes,
} from 'discord.js';
import { downloadImage } from '../imaging/fetch.js';
import { checkUrl } from '../imaging/urls.js';
import type { SnapshotFacts } from './content.js';
import type { ChannelFacts } from './eligibility.js';
import {
  type HallChannelInfo,
  type HallDiscord,
  HallDiscordError,
  type HallErrorKind,
  type HallPost,
  type HallReaction,
  type HallRecentMessage,
  type HallReply,
  type HallSourceMessage,
} from './port.js';
import type { Reactor } from './score.js';

const avatarOptions = { size: 128, extension: 'png', forceStatic: true } as const;

/** Maps what a Discord call threw to a kind the runner understands. */
export function classifyHallError(error: unknown): HallErrorKind {
  if (!(error instanceof DiscordAPIError)) return 'other';
  if (error.code === RESTJSONErrorCodes.UnknownMessage) return 'unknown-message';
  if (error.code === RESTJSONErrorCodes.UnknownChannel) return 'unknown-channel';
  if (
    error.status === 403 ||
    error.code === RESTJSONErrorCodes.MissingAccess ||
    error.code === RESTJSONErrorCodes.MissingPermissions
  ) {
    return 'forbidden';
  }
  if (error.status >= 400 && error.status < 500) return 'rejected';
  return 'other';
}

async function wrap<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HallDiscordError) throw error;
    const kind = classifyHallError(error);
    throw new HallDiscordError(kind, error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/** Every `url` string in a component tree (button links), for finding our own card again. */
export function collectLinks(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectLinks(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'url' && typeof item === 'string') found.push(item);
      else collectLinks(item, found);
    }
  }
  return found;
}

function attachmentFacts(attachment: APIAttachment) {
  return {
    id: attachment.id,
    name: attachment.filename,
    url: attachment.url,
    size: attachment.size,
    contentType: attachment.content_type ?? null,
    flags: attachment.flags ?? 0,
  };
}

function embedFacts(embed: APIEmbed) {
  return {
    type: embed.type ?? null,
    url: embed.url ?? null,
    image: embed.image ? { url: embed.image.url, proxyUrl: embed.image.proxy_url } : null,
    thumbnail: embed.thumbnail
      ? { url: embed.thumbnail.url, proxyUrl: embed.thumbnail.proxy_url }
      : null,
  };
}

function stickerFacts(sticker: APIStickerItem) {
  return { id: sticker.id, name: sticker.name, format: sticker.format_type as number };
}

function snapshotFacts(message: {
  content?: string | undefined;
  attachments?: APIAttachment[] | undefined;
  embeds?: APIEmbed[] | undefined;
  sticker_items?: APIStickerItem[] | undefined;
}): SnapshotFacts {
  return {
    content: message.content ?? '',
    attachments: (message.attachments ?? []).map(attachmentFacts),
    stickers: (message.sticker_items ?? []).map(stickerFacts),
    embeds: (message.embeds ?? []).map(embedFacts),
  };
}

function hasMedia(message: APIMessage): boolean {
  return (
    (message.attachments?.length ?? 0) > 0 ||
    (message.sticker_items?.length ?? 0) > 0 ||
    (message.embeds ?? []).some((embed) => Boolean(embed.image ?? embed.thumbnail))
  );
}

function pickDisplayName(user: { global_name?: string | null; username: string }): string {
  return user.global_name ?? user.username;
}

/** The reaction as the runner counts it, with custom emoji shown only when the guild has them. */
function mapReaction(reaction: APIReaction, guild: Guild | undefined): HallReaction {
  const { id, name, animated } = reaction.emoji;
  const normal = reaction.count_details?.normal ?? reaction.count;
  if (!id) {
    const unicode = name ?? '';
    return { emoji: unicode, key: unicode, normal };
  }
  const key = `${name ?? '_'}:${id}`;
  const usable = name !== null && guild?.emojis.cache.has(id) === true;
  return { emoji: usable ? `<${animated ? 'a' : ''}:${name}:${id}>` : key, key, normal };
}

/**
 * Who can view the channel and what its View Channel overwrites say (`ChannelFacts.audience` and
 * `overwrites`), or undefined for both when that cannot be worked out. Roles are judged on their
 * own permissions in the channel, so a server where @everyone is locked out everywhere and a
 * "Member" role gets in shows exactly that role. Discord combines the role overwrites of a member,
 * so a role is also judged by its denies: every role or member with a View Channel deny overwrite
 * is listed, for the guard to require the same deny on the hall. Roles with Administrator and the
 * bot's own role and member overwrite are left out. Members with an explicit allow overwrite are
 * listed in the audience by id.
 */
function viewAccess(
  guild: Guild,
  base: Channel | null,
  botId: string,
): Pick<ChannelFacts, 'audience' | 'overwrites' | 'everyoneId'> {
  const unknown = { audience: undefined, overwrites: undefined, everyoneId: undefined };
  if (base === null || base.isDMBased() || !('permissionsFor' in base)) return unknown;
  if (!('permissionOverwrites' in base) || guild.roles.cache.size === 0) return unknown;
  const hidden = (role: Role | undefined) =>
    role !== undefined &&
    (role.permissions.has(PermissionFlagsBits.Administrator) || role.tags?.botId === botId);
  const audience: string[] = [];
  for (const role of guild.roles.cache.values()) {
    if (hidden(role)) continue;
    const perms = base.permissionsFor(role, false);
    if (perms === null) return unknown;
    if (perms.has(PermissionFlagsBits.ViewChannel)) audience.push(role.id);
  }
  const denied: string[] = [];
  const deniedRoles: string[] = [];
  const allowedRoles: string[] = [];
  const allowedMembers: string[] = [];
  for (const overwrite of base.permissionOverwrites.cache.values()) {
    const allows = overwrite.allow.has(PermissionFlagsBits.ViewChannel);
    const denies = overwrite.deny.has(PermissionFlagsBits.ViewChannel);
    if (overwrite.type === OverwriteType.Member) {
      if (overwrite.id === botId) continue;
      if (allows) {
        audience.push(overwrite.id);
        allowedMembers.push(overwrite.id);
      }
      if (denies) denied.push(overwrite.id);
      continue;
    }
    // A role that was deleted from the cache is kept: not knowing it is not a reason to skip it.
    if (hidden(guild.roles.cache.get(overwrite.id))) continue;
    if (denies) {
      denied.push(overwrite.id);
      if (overwrite.id !== guild.id) deniedRoles.push(overwrite.id);
    }
    if (allows && overwrite.id !== guild.id) allowedRoles.push(overwrite.id);
  }
  return {
    audience,
    overwrites: { denied, deniedRoles, allowedRoles, allowedMembers },
    everyoneId: guild.id,
  };
}

function channelFacts(
  guild: Guild,
  channel: Channel,
  parent: Channel | null,
  botId: string,
): ChannelFacts {
  const isThread = channel.isThread();
  const base = isThread ? parent : channel;
  const nsfw = base !== null && 'nsfw' in base && base.nsfw === true;
  const categoryId = base !== null && 'parentId' in base ? (base.parentId ?? undefined) : undefined;
  return {
    id: channel.id,
    parentId: isThread ? (channel.parentId ?? undefined) : undefined,
    categoryId,
    isThread,
    isPrivateThread: channel.type === ChannelType.PrivateThread,
    nsfw,
    // An unresolved parent cannot be proven safe, so its audience stays unknown.
    ...viewAccess(guild, base, botId),
  };
}

/** The discord.js implementation of what the Hall of Fame needs from Discord. */
export function createHallDiscord(client: Client<true>): HallDiscord {
  // Like discord.js (`Emoji#identifier`): only a unicode name is encoded here. A custom emoji is
  // handed over as `name:id`, and `Routes` escapes it once (encoding it here would do it twice).
  const encode = (key: string) => (key.includes(':') ? key : encodeURIComponent(key));

  function peekChannel(guildId: string, channelId: string): ChannelFacts | undefined {
    const guild = client.guilds.cache.get(guildId);
    const channel = client.channels.cache.get(channelId);
    if (!guild || !channel || channel.isDMBased()) return undefined;
    const parent = channel.isThread() ? (channel.parent ?? null) : null;
    if (channel.isThread() && !parent) {
      // Unknown parent: only its own id is certain, which is what the cheap checks use.
      return {
        id: channel.id,
        parentId: channel.parentId ?? undefined,
        isThread: true,
        isPrivateThread: channel.type === ChannelType.PrivateThread,
        nsfw: false,
        audience: undefined,
        overwrites: undefined,
      };
    }
    return channelFacts(guild, channel, parent, client.user.id);
  }

  async function channel(guildId: string, channelId: string): Promise<HallChannelInfo> {
    return wrap(async () => {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
      const found = await client.channels.fetch(channelId);
      if (!found || found.isDMBased() || found.guildId !== guildId) {
        throw new HallDiscordError('unknown-channel');
      }
      let parent: Channel | null = null;
      if (found.isThread()) {
        parent =
          found.parent ?? (found.parentId ? await client.channels.fetch(found.parentId) : null);
      }
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const mine = found.permissionsFor(me);
      const has = (flag: bigint) => mine?.has(flag) ?? false;
      return {
        facts: channelFacts(guild, found, parent, client.user.id),
        name: found.name,
        can: {
          view: has(PermissionFlagsBits.ViewChannel),
          readHistory: has(PermissionFlagsBits.ReadMessageHistory),
          send: found.isThread()
            ? has(PermissionFlagsBits.SendMessagesInThreads)
            : has(PermissionFlagsBits.SendMessages),
          attachFiles: has(PermissionFlagsBits.AttachFiles),
        },
      };
    });
  }

  async function fetchMessage(
    guildId: string,
    channelId: string,
    messageId: string,
  ): Promise<HallSourceMessage> {
    return wrap(async () => {
      const api = (await client.rest.get(
        Routes.channelMessage(channelId, messageId),
      )) as APIMessage;
      const guild = client.guilds.cache.get(guildId);
      const { author } = api;
      const reference = api.type === MessageType.Reply ? api.referenced_message : undefined;
      const reply: HallReply | undefined = reference
        ? {
            authorName: pickDisplayName(reference.author),
            content: reference.content,
            hasMedia: hasMedia(reference),
          }
        : undefined;
      return {
        id: api.id,
        channelId: api.channel_id,
        createdAt: Date.parse(api.timestamp),
        type: api.type,
        author: {
          id: author.id,
          username: author.username,
          displayName: pickDisplayName(author),
          avatarUrl: author.avatar
            ? client.rest.cdn.avatar(author.id, author.avatar, avatarOptions)
            : client.rest.cdn.defaultAvatar(Number((BigInt(author.id) >> 22n) % 6n)),
          // An app's reply (a slash command or button response) has an application behind it even
          // when the author object says nothing, and a message copied into a channel by following
          // an announcement channel is a webhook post flagged as a crosspost.
          bot:
            author.bot === true ||
            author.id === client.user.id ||
            api.application_id !== undefined ||
            api.interaction !== undefined ||
            api.interaction_metadata !== undefined,
          webhook:
            api.webhook_id !== undefined ||
            ((api.flags ?? 0) & MessageFlags.IsCrosspost) === MessageFlags.IsCrosspost,
        },
        facts: {
          ...snapshotFacts(api),
          snapshots: (api.message_snapshots ?? []).map((snapshot) =>
            snapshotFacts(snapshot.message),
          ),
          pollQuestion: api.poll?.question.text ?? null,
        },
        reactions: (api.reactions ?? []).map((reaction) => mapReaction(reaction, guild)),
        reply,
      };
    });
  }

  async function fetchReactors(
    channelId: string,
    messageId: string,
    key: string,
    limit: number,
  ): Promise<Reactor[]> {
    return wrap(async () => {
      const query = new URLSearchParams({
        type: String(ReactionType.Normal),
        limit: String(limit),
      });
      const users = (await client.rest.get(
        Routes.channelMessageReaction(channelId, messageId, encode(key)),
        { query },
      )) as RESTGetAPIChannelMessageReactionUsersResult;
      return users.map((user) => ({ id: user.id, bot: user.bot === true }));
    });
  }

  async function profile(guildId: string, userId: string) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return undefined;
      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
      return {
        displayName: member.displayName,
        avatarUrl: member.displayAvatarURL(avatarOptions),
      };
    } catch {
      return undefined;
    }
  }

  const body = (post: HallPost) => ({
    components: [post.card.toJSON()],
    flags: MessageFlags.IsComponentsV2,
    allowed_mentions: { parse: [] },
    // Lists every file the card references, so an edit also drops attachments it no longer uses.
    attachments: post.files.map((file, id) => ({ id, filename: file.name })),
  });
  const rawFiles = (post: HallPost) =>
    post.files.map((file) => ({ name: file.name, data: file.data }));

  async function sendHall(channelId: string, post: HallPost): Promise<string> {
    return wrap(async () => {
      const sent = (await client.rest.post(Routes.channelMessages(channelId), {
        body: {
          ...body(post),
          ...(post.nonce ? { nonce: post.nonce, enforce_nonce: true } : {}),
        },
        files: rawFiles(post),
      })) as APIMessage;
      return sent.id;
    });
  }

  async function editHall(channelId: string, messageId: string, post: HallPost): Promise<void> {
    await wrap(() =>
      client.rest.patch(Routes.channelMessage(channelId, messageId), {
        body: body(post),
        files: rawFiles(post),
      }),
    );
  }

  async function deleteHall(channelId: string, messageId: string): Promise<void> {
    await wrap(() => client.rest.delete(Routes.channelMessage(channelId, messageId)));
  }

  async function fetchRecent(channelId: string, before?: string): Promise<HallRecentMessage[]> {
    return wrap(async () => {
      const query = new URLSearchParams({ limit: '100' });
      if (before) query.set('before', before);
      const messages = (await client.rest.get(Routes.channelMessages(channelId), {
        query,
      })) as RESTGetAPIChannelMessagesResult;
      return messages.map((message) => ({
        id: message.id,
        authorId: message.author.id,
        links: collectLinks(message.components ?? []),
      }));
    });
  }

  async function download(url: string): Promise<Buffer> {
    const check = checkUrl(url);
    if (!check.ok) throw new HallDiscordError('other', 'image host is not allowed');
    return downloadImage(check, { fetch });
  }

  /** From the caches only: users seen on the gateway (members included) carry the bot flag. */
  function isKnownBotUser(userId: string): boolean {
    return userId === client.user.id || client.users.cache.get(userId)?.bot === true;
  }

  return {
    botId: client.user.id,
    isKnownBotUser,
    peekChannel,
    channel,
    fetchMessage,
    fetchReactors,
    profile,
    sendHall,
    editHall,
    deleteHall,
    fetchRecent,
    download,
  };
}
