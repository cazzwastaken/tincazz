import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';
import { isAllowedHost } from '../imaging/urls.js';
import { accents, card, discordTime } from '../ui/index.js';
import { hallOfFame } from './config.js';
import {
  bodyHashParts,
  bodyIsEmpty,
  type HallImage,
  hideSpoilers,
  type MessageBody,
  quoteExcerpt,
  renderHash,
  spoilerPrefix,
  stableUrl,
  truncateText,
} from './content.js';
import { guardNotes } from './eligibility.js';
import type { EmojiCount } from './score.js';
import { tierFor } from './tiers.js';

/** Discord allows 4000 characters of text over a whole Components V2 message; stay clear of it. */
export const hallTextBudget = 3800;
/** Discord allows 40 components in a message; a hall card needs about 20 at most. */
export const hallComponentBudget = 40;

const maxNameLength = 32;
const maxUsernameLength = 32;
const maxFileNameLength = 60;
const maxButtonLabel = 80;
const maxUrlLength = 1000;
const maxStickerNotes = 5;

export interface HallCardAuthor {
  id: string;
  displayName: string;
  username: string;
  avatarUrl: string;
}

export interface HallCardSource {
  guildId: string;
  channelId: string;
  messageId: string;
  /** The channel (or thread) name, for the channel button. */
  channelName?: string | undefined;
  /** When the original message was sent, epoch milliseconds. */
  createdAt: number;
}

export interface HallCardReply {
  authorName: string;
  snippet: string;
}

export interface HallCardInput {
  author: HallCardAuthor;
  source: HallCardSource;
  body: MessageBody;
  /** The message this one replies to, when there is one. */
  reply?: HallCardReply | undefined;
  /** Distinct people (not the author, not bots) at the highest point. */
  peak: number;
  threshold: number;
  /** Emoji as rendered text (unicode or `<:name:id>`) with the people who used each. */
  breakdown: readonly EmojiCount[];
  /**
   * The file names (from `hallUploadName`) the runner managed to re-upload to the hall message. An
   * image whose upload failed is simply absent from the card.
   */
  uploaded: readonly string[];
}

/* ---------------------------------------------------------------- text safety */

/** Control characters, zero width and bidi marks (the zero width joiner stays for emoji). */
const invisibles = /[\p{Cc}\u00ad\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

/** Mentions and emoji are not resolvable here, so a snippet shows them as plain words. */
function plainTokens(text: string): string {
  return text
    .replace(/<a?:(\w+):\d+>/gu, ':$1:')
    .replace(/<@&\d+>/gu, '@role')
    .replace(/<@!?\d+>/gu, '@user')
    .replace(/<#\d+>/gu, '#channel')
    .replace(/<t:-?\d+(?::[a-zA-Z])?>/gu, 'a date')
    .replace(/<\/[\w -]+:\d+>/gu, '/command');
}

/** One line of text: tokens spelled out, invisible characters gone, whitespace collapsed, cut. */
export function plainLine(text: string, max: number): string {
  const flat = plainTokens(text).replace(invisibles, ' ').replace(/\s+/gu, ' ').trim();
  // The cut may close a code fence on a new line; everything is escaped here, so keep one line.
  return truncateText(flat, max).replace(/\s+/gu, ' ');
}

/**
 * One line of untrusted text made harmless inside our own markup: flattened to a single line,
 * invisible characters gone, cut to `max` characters, with markdown escaped, `<` `>` swapped so
 * nothing becomes a mention or link target, and `@` split so it can never read as @everyone.
 */
export function inlineText(text: string, max: number): string {
  return plainLine(text, max)
    .replace(/[\\*_~|`[\]()]/gu, '\\$&')
    .replace(/</gu, '‹')
    .replace(/>/gu, '›')
    .replace(/@/gu, '@\u200b');
}

function displayName(author: HallCardAuthor): string {
  return (
    inlineText(author.displayName, maxNameLength) ||
    inlineText(author.username, maxNameLength) ||
    'Unknown'
  );
}

const customEmoji = /^<a?:\w{1,32}:\d{1,25}>$/u;
const emojiChars =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[#*0-9]\ufe0f?\u20e3|\u200d|\ufe0f){1,16}$/u;
const emojiCore = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

/** Whether `emoji` is something the footer can print safely: a custom emoji or a unicode one. */
export function isRenderableEmoji(emoji: string): boolean {
  return customEmoji.test(emoji) || (emojiChars.test(emoji) && emojiCore.test(emoji));
}

function safeUrl(raw: string): string | undefined {
  if (raw.length > maxUrlLength) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    return isAllowedHost(url.hostname) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Ids are digits; anything else (a lone surrogate would even throw in `encodeURIComponent`) goes. */
const idPart = (id: string) => id.replace(/[^\w-]/gu, '').slice(0, 40) || '0';

/** The permanent link to the original message. */
export function jumpUrl(source: Pick<HallCardSource, 'guildId' | 'channelId' | 'messageId'>) {
  return `https://discord.com/channels/${idPart(source.guildId)}/${idPart(source.channelId)}/${idPart(source.messageId)}`;
}

function channelUrl(source: Pick<HallCardSource, 'guildId' | 'channelId'>) {
  return `https://discord.com/channels/${idPart(source.guildId)}/${idPart(source.channelId)}`;
}

/* ------------------------------------------------------------------- gallery */

/**
 * The name an image is re-uploaded under. It depends only on the image and its position in
 * `body.images`, never on the user's file name (spaces, unicode and duplicates), so the runner and
 * the card always agree. A spoiler keeps its `SPOILER_` prefix.
 */
export function hallUploadName(image: Pick<HallImage, 'name' | 'spoiler'>, index: number): string {
  const extension = /\.(png|jpe?g|gif|webp)$/iu.exec(image.name)?.[1]?.toLowerCase() ?? 'png';
  return `${image.spoiler ? spoilerPrefix : ''}hall-${index}.${extension}`;
}

interface GalleryItem {
  url: string;
  spoiler: boolean;
  description: string | undefined;
  /** The upload name when this item is a re-uploaded file. */
  attachment: string | undefined;
  /** The index in `body.stickers` when this item is a sticker. */
  sticker?: number;
}

function galleryItems(input: HallCardInput): GalleryItem[] {
  const uploaded = new Set(input.uploaded);
  const items: GalleryItem[] = [];
  input.body.images.forEach((image, index) => {
    const name = hallUploadName(image, index);
    if (!uploaded.has(name)) return;
    items.push({
      url: `attachment://${name}`,
      spoiler: image.spoiler,
      description: undefined,
      attachment: name,
    });
  });
  input.body.stickers.forEach((sticker, index) => {
    const url = sticker.url === undefined ? undefined : safeUrl(sticker.url);
    if (url === undefined) return;
    items.push({
      url,
      spoiler: false,
      description: inlineText(`Sticker: ${sticker.name}`, 100),
      attachment: undefined,
      sticker: index,
    });
  });
  for (const media of input.body.embedMedia) {
    const url = safeUrl(media.url);
    if (url === undefined) continue;
    items.push({
      url,
      spoiler: media.spoiler,
      description: media.gif ? 'GIF' : undefined,
      attachment: undefined,
    });
  }
  return items.slice(0, hallOfFame.maxImages);
}

/**
 * The `attachment://` names the card references, in order. The runner sends exactly these files with
 * the hall message, and again with every edit (an edit that leaves them out would drop the images).
 */
export function hallAttachmentNames(input: HallCardInput): string[] {
  return galleryItems(input).flatMap((item) => (item.attachment ? [item.attachment] : []));
}

/* ---------------------------------------------------------------------- card */

const separator = () =>
  new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const text = (content: string) => new TextDisplayBuilder().setContent(content);

function people(count: number): string {
  return `**${count.toLocaleString('en-US')}** ${count === 1 ? 'person' : 'people'}`;
}

function cleanCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function footerLine(input: HallCardInput, emoji: string): string {
  const parts = [`${emoji} ${people(cleanCount(input.peak))}`];
  const shown = input.breakdown
    .filter((entry) => entry.count > 0 && isRenderableEmoji(entry.emoji))
    .slice(0, hallOfFame.maxBreakdownEmojis);
  for (const entry of shown) parts.push(`${entry.emoji} ${cleanCount(entry.count)}`);
  return `-# ${parts.join(' · ')}`;
}

function replyLine(reply: HallCardReply): string {
  const name = inlineText(reply.authorName, maxNameLength) || 'someone';
  const snippet = inlineText(hideSpoilers(reply.snippet), hallOfFame.maxReplySnippetLength);
  return snippet === ''
    ? `-# ↩️ replying to **${name}**`
    : `-# ↩️ replying to **${name}**: ${snippet}`;
}

function fileLines(input: HallCardInput, skippedImages: number): string[] {
  const { body } = input;
  const lines = body.files
    .slice(0, hallOfFame.maxAttachmentNames)
    .map((name) => `📎 ${inlineText(name, maxFileNameLength) || 'file'}`);
  const more =
    Math.max(0, Math.floor(body.moreFiles)) + Math.max(0, body.files.length - lines.length);
  if (more > 0) lines.push(`-# +${more} more ${more === 1 ? 'file' : 'files'}`);
  if (skippedImages > 0) {
    lines.push(
      `-# 🖼️ ${skippedImages === 1 ? 'An image' : `${skippedImages} images`} couldn't be copied here, see the original`,
    );
  }
  return lines;
}

/**
 * The Hall of Fame card for one message. Plain data in, a Components V2 container out; the files
 * named by `hallAttachmentNames` must be sent along with it. Everything that came from a user is
 * made harmless (see `inlineText`) and the quoted text is trimmed so that the whole message stays
 * within `hallTextBudget` characters and `hallComponentBudget` components.
 */
export function hallCard(input: HallCardInput): ContainerBuilder {
  const { author, source, body } = input;
  const tier = tierFor(cleanCount(input.peak), input.threshold);
  const container = new ContainerBuilder().setAccentColor(tier.color);

  // Header and author.
  const header = '-# 🏛️ HALL OF FAME';
  const name = `**${displayName(author)}**`;
  const when = Number.isFinite(source.createdAt) ? ` · ${discordTime(source.createdAt)}` : '';
  const details = `-# @${inlineText(author.username, maxUsernameLength)} · in <#${idPart(source.channelId)}>${when}`;
  container.addTextDisplayComponents(text(header));
  const avatar = safeUrl(author.avatarUrl);
  if (avatar) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(text(name), text(details))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar)),
    );
  } else {
    container.addTextDisplayComponents(text(name), text(details));
  }
  container.addSeparatorComponents(separator());

  // Everything but the quote, so the quote gets what is left of the budget.
  const gallery = galleryItems(input);
  const skippedImages = body.images.length - gallery.filter((item) => item.attachment).length;
  const context: string[] = [];
  if (input.reply) context.push(replyLine(input.reply));
  if (body.forwarded) context.push('-# ↪️ Forwarded message');

  const notes: string[] = [];
  const note = body.note === undefined ? '' : inlineText(body.note, 260);
  if (note !== '') notes.push(note);
  const shownStickers = new Set(gallery.map((item) => item.sticker));
  body.stickers.slice(0, maxStickerNotes).forEach((sticker, index) => {
    if (!shownStickers.has(index)) {
      notes.push(`🏷️ Sticker: ${inlineText(sticker.name, maxFileNameLength)}`);
    }
  });
  const empty = bodyIsEmpty(body);
  if (empty) notes.push('-# Nothing to preview here, see the original message.');

  const files = fileLines(input, skippedImages);
  const footer = footerLine(input, tier.emoji);
  const others = [header, name, details, ...context, ...notes, ...files, footer];
  const room = Math.max(0, hallTextBudget - others.reduce((sum, line) => sum + line.length + 1, 0));

  // Context (reply, forwarded), then the quote, then notes.
  if (context.length > 0) {
    container.addTextDisplayComponents(text(context.join('\n')));
  }
  const quote =
    body.text.trim() === ''
      ? ''
      : quoteExcerpt(
          body.text,
          hallOfFame.maxTextLength,
          Math.min(hallOfFame.maxTextLength * 2, room),
        );
  if (quote !== '') container.addTextDisplayComponents(text(quote));
  if (notes.length > 0) container.addTextDisplayComponents(text(notes.join('\n')));

  if (gallery.length > 0) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        ...gallery.map((item) => {
          const builder = new MediaGalleryItemBuilder().setURL(item.url).setSpoiler(item.spoiler);
          return item.description === undefined
            ? builder
            : builder.setDescription(item.description);
        }),
      ),
    );
  }
  if (files.length > 0) container.addTextDisplayComponents(text(files.join('\n')));

  container.addSeparatorComponents(separator());
  container.addTextDisplayComponents(text(footer));

  const channelLabel = source.channelName
    ? `#${plainLine(source.channelName, maxButtonLabel - 1)}`
    : 'Channel';
  container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel('Jump to message')
        .setStyle(ButtonStyle.Link)
        .setURL(jumpUrl(source)),
      new ButtonBuilder()
        .setLabel(truncateText(channelLabel, maxButtonLabel))
        .setStyle(ButtonStyle.Link)
        .setURL(channelUrl(source)),
    ),
  );
  return container;
}

/**
 * Identifies what `hallCard` shows, so an unchanged card is not edited again (a message update for
 * an embed that resolved changes nothing here). Built from what the card prints and not from signed
 * CDN links, which differ on every fetch.
 */
export function hallRenderHash(input: HallCardInput): string {
  const { author, source } = input;
  return renderHash({
    body: bodyHashParts(input.body),
    author: [author.id, author.displayName, author.username, stableUrl(author.avatarUrl)],
    channel: [source.channelId, source.channelName ?? null, source.createdAt],
    reply: input.reply ? [input.reply.authorName, input.reply.snippet] : null,
    peak: cleanCount(input.peak),
    tier: tierFor(cleanCount(input.peak), input.threshold).emoji,
    breakdown: input.breakdown
      .filter((entry) => entry.count > 0 && isRenderableEmoji(entry.emoji))
      .slice(0, hallOfFame.maxBreakdownEmojis)
      .map((entry) => [entry.emoji, entry.count]),
    uploaded: hallAttachmentNames(input),
  });
}

/* --------------------------------------------------------------------- intro */

/** Guards that are about the channel being set up, not about a message, are left out of the intro. */
const introSkipped = new Set(['hall-disabled', 'hall-unavailable']);

/** The post that confirms a new hall channel and says how it works, silent skips included. */
export function hallIntroCard(
  channelId: string,
  threshold: number,
  actorId: string,
): ContainerBuilder {
  const safeThreshold = Math.max(1, Math.floor(threshold));
  const skips = guardNotes
    .filter((note) => !introSkipped.has(note.reason))
    .map((note) => `- **${note.title}**: ${note.text}`)
    .join('\n');
  return card(
    accents.gold,
    '## 🏛️ Hall of Fame',
    `<@${idPart(actorId)}> made <#${idPart(channelId)}> the Hall of Fame. A message that **${safeThreshold.toLocaleString('en-US')}** or more different people react to is posted here with its author, its pictures and a link back.`,
    `The count is **people**, not reactions: one person counts once however many emoji they use, and the author and bots never count. Messages from bots, apps and webhooks, this bot's own polls, giveaways and cards included, are never posted. The number on a card is its peak, so taking reactions off later does not remove it. Changing the threshold is not retroactive.`,
    `### What is never posted\n${skips}`,
    `-# Staff can change this with /settings halloffame.`,
  );
}
