import { container } from '@sapphire/framework';
import {
  type APIInteractionDataResolvedGuildMember,
  type APIInteractionGuildMember,
  AttachmentBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  StickerFormatType,
  type User,
} from 'discord.js';
import { ImagingError } from './errors.js';
import { downloadImage, type Fetcher } from './fetch.js';
import { type ImageJobs, imageJobs } from './jobs.js';
import { type ImageOperation, renderImage } from './render.js';
import {
  type AttachmentData,
  pickSource,
  type ReplyData,
  type SourceInputs,
  type StickerData,
} from './source.js';
import type { MentionNames } from './text.js';

const avatarOptions = { size: 512, extension: 'png', forceStatic: false } as const;

export function attachmentData(a: { url: string; contentType: string | null }): AttachmentData {
  return { url: a.url, contentType: a.contentType };
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
      thumbnailUrl: embed.thumbnail?.url ?? null,
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

/** Gathers the inputs of a prefix command. A user that cannot be found yields no avatar. */
export async function messageInputs(
  message: Message,
  args: { url?: string; userId?: string },
): Promise<SourceInputs> {
  const inputs: SourceInputs = {};
  const first = message.attachments.first();
  if (first) inputs.attachment = attachmentData(first);
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

  if (message.reference?.messageId) {
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

/** Display names of everything mentioned in a prefix message. */
export function messageMentionNames(message: Message): MentionNames {
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
    if ('name' in channel && channel.name) channels.set(channel.id, channel.name);
  }
  return { users, roles, channels };
}

/**
 * Discord does not resolve mentions typed into a string option, so the IDs found in `text` are
 * looked up in the caches. Only those IDs are looked up, nothing is copied wholesale.
 */
export function interactionMentionNames(
  interaction: ChatInputCommandInteraction,
  text: string,
): MentionNames {
  const users = new Map<string, string>();
  const roles = new Map<string, string>();
  const channels = new Map<string, string>();
  for (const [, id] of text.matchAll(/<@!?(\d+)>/g)) {
    if (!id) continue;
    const member = interaction.guild?.members.cache.get(id);
    const user = interaction.client.users.cache.get(id);
    const name = member?.displayName ?? (user ? (user.globalName ?? user.username) : undefined);
    if (name !== undefined) users.set(id, name);
  }
  for (const [, id] of text.matchAll(/<@&(\d+)>/g)) {
    const role = id ? interaction.guild?.roles.cache.get(id) : undefined;
    if (id && role) roles.set(id, role.name);
  }
  for (const [, id] of text.matchAll(/<#(\d+)>/g)) {
    const channel = id ? interaction.guild?.channels.cache.get(id) : undefined;
    if (id && channel) channels.set(id, channel.name);
  }
  return { users, roles, channels };
}

/**
 * The shared flow of /bubble and /meme: pick the source, then download and render it as one
 * queued job. `{ error: null }` means nothing was given (show usage); other `ImagingError`s carry
 * a user-safe message; anything unexpected is rethrown.
 */
export async function produceImage(
  inputs: SourceInputs,
  op: ImageOperation,
  userId: string,
  deps: { fetch?: Fetcher; jobs?: ImageJobs } = {},
): Promise<{ file: AttachmentBuilder } | { error: string | null }> {
  const pick = pickSource(inputs);
  if (!pick.ok) return { error: pick.message };
  const fetcher = deps.fetch ?? globalThis.fetch;
  const jobs = deps.jobs ?? imageJobs;
  try {
    const started = Date.now();
    const { rendered, inputBytes } = await jobs.run(userId, async (signal) => {
      const buffer = await downloadImage(pick.check, { fetch: fetcher, signal });
      const result = await renderImage(buffer, op, { signal });
      return { rendered: result, inputBytes: buffer.length };
    });
    container.logger?.debug(
      `imaging ${op.kind}: ${Date.now() - started}ms, ${inputBytes} bytes in, ${rendered.gif.length} bytes out, ladder step ${rendered.step}`,
    );
    return {
      file: new AttachmentBuilder(rendered.gif, {
        name: op.kind === 'bubble' ? 'bubble.gif' : 'meme.gif',
      }),
    };
  } catch (error) {
    if (error instanceof ImagingError) return { error: error.message };
    throw error;
  }
}
