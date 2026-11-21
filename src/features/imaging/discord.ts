import { container } from '@sapphire/framework';
import {
  type APIInteractionDataResolvedGuildMember,
  type APIInteractionGuildMember,
  AttachmentBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  type CommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  MessageReferenceType,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  StickerFormatType,
  type User,
} from 'discord.js';
import { errorReply } from '../ui/index.js';
import { ImagingError } from './errors.js';
import { downloadImage, type Fetcher } from './fetch.js';
import { type ImageJobs, imageJobs } from './jobs.js';
import { parseMessageLink } from './links.js';
import { type MessageSnapshot, renderScreenshot } from './message.js';
import { type ImageOperation, renderImage } from './render.js';
import {
  type AttachmentData,
  messageSource,
  pickSource,
  type ReplyData,
  type SourceInputs,
  type StickerData,
} from './source.js';
import { type MentionNames, mentionPatterns } from './text.js';

const avatarOptions = { size: 512, extension: 'png', forceStatic: false } as const;

export function attachmentData(a: {
  url: string;
  contentType: string | null;
  spoiler?: boolean;
}): AttachmentData {
  return { url: a.url, contentType: a.contentType, spoiler: a.spoiler === true };
}

const stickerFormats: Partial<Record<StickerFormatType, StickerData['format']>> = {
  [StickerFormatType.PNG]: 'png',
  [StickerFormatType.APNG]: 'apng',
  [StickerFormatType.GIF]: 'gif',
  [StickerFormatType.Lottie]: 'lottie',
};

export function replyData(message: Message): ReplyData {
  const stickers: StickerData[] = [];
  for (const sticker of message.stickers.values()) {
    const format = stickerFormats[sticker.format];
    if (format) stickers.push({ url: sticker.url, format });
  }
  return {
    attachments: [...message.attachments.values()].map(attachmentData),
    embeds: message.embeds.map((embed) => ({
      url: embed.url ?? null,
      provider: embed.provider?.name ?? null,
      imageUrl: embed.image?.url ?? null,
      imageProxyUrl: embed.image?.proxyURL ?? null,
      thumbnailUrl: embed.thumbnail?.url ?? null,
      thumbnailProxyUrl: embed.thumbnail?.proxyURL ?? null,
      hasVideo: Boolean(embed.video),
    })),
    stickers,
    content: message.content,
  };
}

/** The guild avatar when the member is a full `GuildMember` (it falls back to the user's), else the user's. */
export function avatarUrl(
  user: User,
  member: GuildMember | APIInteractionGuildMember | APIInteractionDataResolvedGuildMember | null,
): string {
  if (member && typeof (member as GuildMember).displayAvatarURL === 'function') {
    return (member as GuildMember).displayAvatarURL(avatarOptions);
  }
  return user.displayAvatarURL(avatarOptions);
}

/**
 * Gathers the inputs of a prefix command. A user that cannot be found yields no avatar. With
 * `reply: false` the replied-to message is left out (`?bubble` handles it as a whole message).
 */
export async function messageInputs(
  message: Message,
  args: { url?: string; userId?: string },
  options: { reply?: boolean } = {},
): Promise<SourceInputs> {
  const inputs: SourceInputs = {};
  // The first image (or untyped) attachment; with none, the first one, so it gets its own error.
  const attachment =
    message.attachments.find((a) => a.contentType === null || a.contentType.startsWith('image/')) ??
    message.attachments.first();
  if (attachment) inputs.attachment = attachmentData(attachment);
  if (args.url !== undefined) inputs.url = args.url;

  if (args.userId !== undefined) {
    const member = await message.guild?.members.fetch(args.userId).catch(() => null);
    if (member) {
      inputs.avatarUrl = avatarUrl(member.user, member);
    } else {
      const user = await message.client.users.fetch(args.userId).catch(() => null);
      if (user) inputs.avatarUrl = avatarUrl(user, null);
    }
  }

  if (options.reply !== false && message.reference?.messageId) {
    const referenced = await message.fetchReference().catch(() => null);
    if (referenced) inputs.reply = replyData(referenced);
  }
  return inputs;
}

export function interactionInputs(interaction: ChatInputCommandInteraction): SourceInputs {
  const inputs: SourceInputs = {};
  const attachment = interaction.options.getAttachment('image');
  if (attachment) inputs.attachment = attachmentData(attachment);
  const url = interaction.options.getString('url');
  if (url !== null) inputs.url = url;
  const user = interaction.options.getUser('user');
  if (user) inputs.avatarUrl = avatarUrl(user, interaction.options.getMember('user'));
  return inputs;
}

/**
 * Whether `viewer` (whoever runs the command, not the message author) may see `channel`: it must
 * be in `guildId` and grant them View Channel. Without a viewer nothing is visible.
 */
function channelVisible(
  channel: object,
  guildId: string | null | undefined,
  viewer: GuildMember | null | undefined,
): boolean {
  const guildChannel = channel as Partial<GuildBasedChannel>;
  if (!viewer || !guildId || guildChannel.guildId !== guildId) return false;
  return guildChannel.permissionsFor?.(viewer)?.has(PermissionFlagsBits.ViewChannel) === true;
}

/** The guild member behind a user (fetched if uncached), or `null` when they are not in it. */
export async function invokerMember(
  guild: Guild | null,
  userId: string,
): Promise<GuildMember | null> {
  return (await guild?.members.fetch(userId).catch(() => null)) ?? null;
}

/**
 * Display names of everything mentioned in a prefix message. Channels are only named when they
 * are in this guild and `viewer`, who runs the command, can see them: a message may mention a
 * channel its reader cannot see, and its name would leak. The others render as unknown.
 */
export function messageMentionNames(
  message: Message,
  viewer: GuildMember | null | undefined,
): MentionNames {
  const users = new Map<string, string>();
  for (const user of message.mentions.users.values()) {
    users.set(user.id, user.globalName ?? user.username);
  }
  for (const member of message.mentions.members?.values() ?? []) {
    users.set(member.id, member.displayName);
  }
  const roles = new Map<string, string>();
  for (const role of message.mentions.roles.values()) roles.set(role.id, role.name);
  const channels = new Map<string, string>();
  for (const channel of message.mentions.channels.values()) {
    if ('name' in channel && channel.name && channelVisible(channel, message.guildId, viewer)) {
      channels.set(channel.id, channel.name);
    }
  }
  return { users, roles, channels };
}

/**
 * What the mention and message lookups need from an interaction: a slash command and a modal
 * submit both fit.
 */
export interface InteractionContext {
  readonly guild: Guild | null;
  readonly guildId: string | null;
  readonly channelId: string | null;
  readonly user: User;
  readonly client: Client;
}

/**
 * Discord does not resolve mentions typed into a string option (or a modal field), so the IDs found in `text` are
 * looked up in the caches. Only those IDs are looked up, nothing is copied wholesale. Channels
 * are named only when the invoker can see them.
 */
export function interactionMentionNames(
  interaction: InteractionContext,
  text: string,
): MentionNames {
  const users = new Map<string, string>();
  const roles = new Map<string, string>();
  const channels = new Map<string, string>();
  const viewer = interaction.guild?.members.cache.get(interaction.user.id);
  for (const [, id] of text.matchAll(mentionPatterns.user)) {
    if (!id) continue;
    const member = interaction.guild?.members.cache.get(id);
    const user = interaction.client.users.cache.get(id);
    const name = member?.displayName ?? (user ? (user.globalName ?? user.username) : undefined);
    if (name !== undefined) users.set(id, name);
  }
  for (const [, id] of text.matchAll(mentionPatterns.role)) {
    const role = id ? interaction.guild?.roles.cache.get(id) : undefined;
    if (id && role) roles.set(id, role.name);
  }
  for (const [, id] of text.matchAll(mentionPatterns.channel)) {
    const channel = id ? interaction.guild?.channels.cache.get(id) : undefined;
    if (id && channel && channelVisible(channel, interaction.guildId, viewer)) {
      channels.set(id, channel.name);
    }
  }
  return { users, roles, channels };
}

type Produced = { file: AttachmentBuilder } | { error: string | null };
type ProduceDeps = { fetch?: Fetcher; jobs?: ImageJobs };

/**
 * Builds the input image and renders it as one queued job, so the timeout, the concurrency limit
 * and the per-user lock cover the downloads too. `ImagingError`s become their user-safe message;
 * anything unexpected is rethrown.
 */
async function renderJob(
  prepare: (fetcher: Fetcher, signal: AbortSignal) => Promise<Buffer>,
  op: ImageOperation,
  userId: string,
  deps: ProduceDeps,
): Promise<Produced> {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const jobs = deps.jobs ?? imageJobs;
  try {
    const started = Date.now();
    const { rendered, inputBytes } = await jobs.run(userId, async (signal) => {
      const buffer = await prepare(fetcher, signal);
      const result = await renderImage(buffer, op, { signal });
      return { rendered: result, inputBytes: buffer.length };
    });
    container.logger?.debug(
      `imaging ${op.kind}: ${Date.now() - started}ms, ${inputBytes} bytes in, ${rendered.gif.length} bytes out, ladder step ${rendered.step}`,
    );
    return {
      file: new AttachmentBuilder(rendered.gif, {
        name: op.kind === 'bubble' ? 'bubble.gif' : 'caption.gif',
      }),
    };
  } catch (error) {
    if (error instanceof ImagingError) return { error: error.message };
    throw error;
  }
}

/**
 * The shared flow of /bubble and /caption: pick the source, then download and render it as one
 * queued job. `{ error: null }` means nothing was given (show usage); other errors carry a
 * user-safe message.
 */
export async function produceImage(
  inputs: SourceInputs,
  op: ImageOperation,
  userId: string,
  deps: ProduceDeps = {},
): Promise<Produced> {
  const pick = pickSource(inputs);
  if (!pick.ok) return { error: pick.message };
  return renderJob(
    (fetch, signal) => downloadImage(pick.check, { fetch, signal }),
    op,
    userId,
    deps,
  );
}

/**
 * Renders a whole message (see `messageSource`): its image alone, or a screenshot of it. The
 * avatar and image downloads and the drawing all run inside the one queued job.
 */
export async function produceMessageImage(
  snapshot: MessageSnapshot,
  op: ImageOperation,
  userId: string,
  deps: ProduceDeps = {},
): Promise<Produced> {
  const source = messageSource(snapshot.message);
  if (source.kind === 'error') return { error: source.message };
  if (source.kind === 'image') {
    return renderJob(
      (fetch, signal) => downloadImage(source.check, { fetch, signal }),
      op,
      userId,
      deps,
    );
  }
  // A bubble gets room above the screenshot and the bubble shaped for it; a caption needs neither.
  const bubble = op.kind === 'bubble';
  return renderJob(
    (fetch, signal) => renderScreenshot(snapshot, source, { fetch, signal, headroom: bubble }),
    bubble ? { ...op, shape: 'message' } : op,
    userId,
    deps,
  );
}

const messageAvatarOptions = { size: 128, extension: 'png', forceStatic: true } as const;

/**
 * A message as plain data for the screenshot: the member's display name, colour and avatar when
 * they are still in the guild (fetched if uncached), else the user's. `viewer` is who runs the
 * command; channels they cannot see stay unnamed.
 */
export async function messageSnapshot(
  message: Message,
  viewer: GuildMember | null,
): Promise<MessageSnapshot> {
  const member =
    message.member ??
    (message.webhookId
      ? null
      : await message.guild?.members.fetch(message.author.id).catch(() => null)) ??
    null;
  return {
    author: {
      name: member?.displayName ?? message.author.displayName,
      color: member?.displayHexColor ?? null,
      avatarUrl: (member ?? message.author).displayAvatarURL(messageAvatarOptions),
    },
    createdTimestamp: message.createdTimestamp,
    message: replyData(message),
    names: messageMentionNames(message, viewer),
  };
}

/**
 * The message a prefix command replies to, only when it is a plain reply in the same channel (a
 * forward can point into another channel or guild).
 */
export async function repliedMessage(message: Message): Promise<Message | null> {
  const reference = message.reference;
  if (!reference?.messageId) return null;
  if (reference.type !== undefined && reference.type !== MessageReferenceType.Default) return null;
  if (reference.channelId !== message.channelId) return null;
  if (reference.guildId !== undefined && reference.guildId !== message.guildId) return null;
  const referenced = await message.fetchReference().catch(() => null);
  return referenced?.guildId === message.guildId ? referenced : null;
}

const readPermissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;

/**
 * Whether `member` may read the history of `channel`. A thread takes its parent's permissions; a
 * private thread also needs membership (or Manage Threads).
 */
export async function canReadHistory(
  channel: GuildBasedChannel,
  member: GuildMember,
): Promise<boolean> {
  const permissions = channel.permissionsFor(member);
  if (!permissions?.has(readPermissions)) return false;
  if (
    channel.type === ChannelType.PrivateThread &&
    !permissions.has(PermissionFlagsBits.ManageThreads)
  ) {
    return Boolean(await channel.members.fetch({ member: member.id }).catch(() => null));
  }
  return true;
}

/**
 * Resolves `/bubble message:` (also `/caption message:` and the caption modal) to a message, or `null` for anything the invoker may not see: a bad
 * link, another guild, a channel outside this guild, a channel the invoker or the bot cannot read
 * the history of, or a missing message. The caller answers every `null` the same way, so the
 * reply never tells whether a message exists.
 */
export async function linkedMessage(
  interaction: InteractionContext,
  raw: string,
): Promise<Message | null> {
  const link = parseMessageLink(raw);
  const guild = interaction.guild;
  if (!link || !guild || interaction.guildId !== guild.id) return null;
  if (link.guildId !== null && link.guildId !== guild.id) return null;

  const channelId = link.channelId ?? interaction.channelId;
  if (!channelId) return null;
  const channel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel || channel.guildId !== guild.id || !channel.isTextBased()) return null;

  const [member, me] = await Promise.all([
    guild.members.fetch(interaction.user.id).catch(() => null),
    guild.members.me ?? guild.members.fetchMe().catch(() => null),
  ]);
  if (!member || !me) return null;
  if (!(await canReadHistory(channel, member)) || !(await canReadHistory(channel, me))) {
    return null;
  }

  const message = await channel.messages.fetch(link.messageId).catch(() => null);
  if (!message || message.guildId !== guild.id || message.channelId !== channel.id) return null;
  return message;
}

/** What a slash command answers when no image source was given. */
export const slashUsage = 'Give me an image: attach one, paste a link, or pick a user.';

/** Whether the bot may attach files in the channel of a prefix message (fetches itself if uncached). */
export async function canAttachFiles(message: Message): Promise<boolean> {
  const me = message.guild?.members.me ?? (await message.guild?.members.fetchMe());
  return Boolean(
    me &&
      message.guild &&
      message.channel.isSendable() &&
      'permissionsFor' in message.channel &&
      message.channel.permissionsFor(me)?.has(PermissionFlagsBits.AttachFiles),
  );
}

/** The configured command prefix (`COMMAND_PREFIX`), as set on the client. */
export function commandPrefix(client: Client): string {
  const configured = client.options.defaultPrefix;
  return (Array.isArray(configured) ? configured[0] : configured) ?? '?';
}

/**
 * Finishes a slash image command whose reply is already deferred (publicly): edits in the file, or
 * drops the public deferred reply and answers the error ephemerally. When `run` throws something
 * unexpected the deferred reply is dropped too (the first follow-up would otherwise replace the
 * public "thinking..." message and stay public) and the error is rethrown.
 */
export async function replyWithImage(
  interaction: CommandInteraction | ModalSubmitInteraction,
  run: () => Promise<Produced>,
): Promise<void> {
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (error) {
    await interaction.deleteReply().catch(() => undefined);
    throw error;
  }
  if ('file' in result) {
    await interaction.editReply({ files: [result.file] });
    return;
  }
  await interaction.deleteReply().catch(() => undefined);
  await interaction.followUp(errorReply(result.error ?? slashUsage));
}
