import { createHash } from 'node:crypto';
import { AttachmentFlags, StickerFormatType } from 'discord.js';
import { isAllowedHost } from '../imaging/urls.js';
import { hallOfFame } from './config.js';

const ellipsis = '…';
const fence = '```';
/** Zero width space: keeps an empty quoted line from being trimmed away. */
const zeroWidthSpace = '​';
const quotedEllipsis = `> ${ellipsis}`;

/**
 * Mentions, custom emoji, timestamps and slash mentions: never cut in half, since a torn
 * `<@123` renders as junk and a torn `<:name:123` as plain text.
 */
const tokenPattern =
  /<(?:@[!&]?\d+|#\d+|a?:\w+:\d+|t:-?\d+(?::[a-zA-Z])?|\/[\w-]+(?: [\w-]+){0,2}:\d+|id:\w+)>/gu;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The largest cut point at or before `limit` that splits no surrogate pair and no token. */
function cutPoint(text: string, limit: number): number {
  let cut = Math.min(limit, text.length);
  if (cut > 0 && cut < text.length) {
    if (isHighSurrogate(text.charCodeAt(cut - 1)) && isLowSurrogate(text.charCodeAt(cut))) cut -= 1;
  }
  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index;
    if (start >= cut) break;
    if (cut < start + match[0].length) {
      cut = start;
      break;
    }
  }
  return cut;
}

function fenceCount(text: string): number {
  let count = 0;
  let from = text.indexOf(fence);
  while (from !== -1) {
    count += 1;
    from = text.indexOf(fence, from + fence.length);
  }
  return count;
}

/**
 * Where the `||` markers of `text` are: the string index of each, in order. A code fence (an
 * unclosed one runs to the end, since a cut closes it again) and an inline code span hide theirs,
 * and `\|` is not a marker. The one tokenizer behind truncation, `hideSpoilers` and embed media.
 */
function spoilerMarkerIndexes(text: string): number[] {
  const found: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(fence, i)) {
      const end = text.indexOf(fence, i + fence.length);
      i = end === -1 ? text.length : end + fence.length;
    } else if (text[i] === '`') {
      const run = text[i + 1] === '`' ? '``' : '`';
      const end = text.indexOf(run, i + run.length);
      i = end === -1 ? i + run.length : end + run.length;
    } else if (text[i] === '\\') {
      i += 2;
    } else if (text.startsWith('||', i)) {
      found.push(i);
      i += 2;
    } else {
      i += 1;
    }
  }
  return found;
}

/** How many `||` markers `text` has outside code. */
function spoilerMarkers(text: string): number {
  return spoilerMarkerIndexes(text).length;
}

/**
 * What a cut `kept` needs after its ellipsis so the rest of the card renders normally: the code
 * fence closed on its own line, then the spoiler closed (an open `||` would hide, or worse show,
 * everything that follows).
 */
function closersFor(kept: string): string {
  const closeFence = fenceCount(kept) % 2 === 1;
  const closeSpoiler = spoilerMarkers(kept) % 2 === 1;
  return (closeFence ? `\n${fence}` : '') + (closeSpoiler ? (closeFence ? '\n||' : '||') : '');
}

/**
 * Cuts `text` to at most `max` UTF-16 units (at least Discord's own count) and marks the cut with
 * an ellipsis. The cut is on a code point boundary, never inside a mention or custom emoji, and a
 * code fence or `||spoiler||` left open by the cut is closed again, so the rest of the card renders
 * normally.
 */
export function truncateText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;

  let room = max - ellipsis.length;
  for (;;) {
    const kept = text.slice(0, cutPoint(text, Math.max(0, room))).trimEnd();
    const closers = closersFor(kept);
    const excess = kept.length + ellipsis.length + closers.length - max;
    if (excess <= 0) return kept + ellipsis + closers;
    room = Math.min(room, kept.length) - excess;
  }
}

/**
 * Replaces every `||spoiler||` with a word, for a preview. Markers inside code and escaped ones
 * (`\|`) are not spoilers, as on Discord; an unclosed `||` hides everything after it.
 */
export function hideSpoilers(text: string): string {
  const markers = spoilerMarkerIndexes(text);
  if (markers.length === 0) return text;
  let out = '';
  let from = 0;
  for (let i = 0; i < markers.length; i += 2) {
    const open = markers[i] as number;
    const close = markers[i + 1];
    out += `${text.slice(from, open)}spoiler`;
    from = close === undefined ? text.length : close + 2;
  }
  return out + text.slice(from);
}

/**
 * Quotes every line with `> `, not one `>>> ` at the start. Discord joins consecutive `> ` lines
 * into one block quote (and a code fence inside it works), while `>>> ` swallows everything after
 * it in the same text, so a stray or user typed `>>>` could pull the rest of the card into the
 * quote. Per line stays inside our own text and costs only two characters a line. A blank line gets
 * a zero width space after the marker, because `> ` alone is not a quote line.
 */
export function quoteText(text: string): string {
  if (text === '') return '';
  return text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? `> ${zeroWidthSpace}` : `> ${line}`))
    .join('\n');
}

/**
 * The quoted, truncated message text. `max` bounds the source text; `maxQuoted` bounds the result
 * including the quote markers (a message of nothing but line breaks would otherwise triple).
 */
export function quoteExcerpt(
  text: string,
  max: number = hallOfFame.maxTextLength,
  maxQuoted: number = max * 2,
): string {
  let limit = Math.max(1, max);
  for (;;) {
    const quoted = quoteText(truncateText(text, limit));
    if (quoted.length <= maxQuoted) return quoted;
    if (limit <= 1) break;
    limit = Math.max(1, limit - (quoted.length - maxQuoted));
  }
  // Even one source character quotes to more than `maxQuoted` (line breaks cost three characters
  // a line): show a bare marker when it fits, nothing otherwise.
  return quotedEllipsis.length <= maxQuoted ? quotedEllipsis : '';
}

/**
 * A one line preview of the message a reply answers; empty when there is nothing to show. Spoilers
 * are hidden first, while code fences and escapes still tell which `||` count (stripping the fences
 * before would let a fenced `||` pair up with a real one), and before anything is cut or escaped
 * (an escaped `||` would print the secret).
 */
export function replySnippet(
  text: string,
  hasMedia = false,
  max: number = hallOfFame.maxReplySnippetLength,
): string {
  // A `||` left over sat in code (or in a spoiler's doubt): split it, so the card, which hides
  // spoilers again, never pairs it with anything.
  const flat = hideSpoilers(text)
    .replace(/`{3,}/gu, '')
    .replace(/\|(?=\|)/gu, '| ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (flat === '') return hasMedia ? '📎 attachment' : '';
  return truncateText(flat, max);
}

export interface AttachmentFacts {
  id: string;
  name: string;
  url: string;
  size: number;
  contentType?: string | null | undefined;
  /** Discord's attachment flags bitfield: `IsSpoiler` is set however the file is named. */
  flags?: number | null | undefined;
}

export interface StickerFacts {
  id: string;
  name: string;
  /** Discord's sticker format number (1 PNG, 2 APNG, 3 Lottie, 4 GIF). */
  format: number;
}

export interface EmbedMediaFacts {
  url?: string | null | undefined;
  proxyUrl?: string | null | undefined;
}

export interface EmbedFacts {
  type?: string | null | undefined;
  /** The link the embed was made from. */
  url?: string | null | undefined;
  image?: EmbedMediaFacts | null | undefined;
  thumbnail?: EmbedMediaFacts | null | undefined;
}

export interface SnapshotFacts {
  content: string;
  attachments: readonly AttachmentFacts[];
  stickers: readonly StickerFacts[];
  embeds: readonly EmbedFacts[];
}

export interface MessageFacts extends SnapshotFacts {
  /** The messages a forward carries; a forward has no content of its own. */
  snapshots: readonly SnapshotFacts[];
  /** The question of a native poll. */
  pollQuestion?: string | null | undefined;
}

export interface ContentCaps {
  maxImages: number;
  maxImageBytes: number;
  maxImageBytesTotal: number;
  maxAttachmentNames: number;
}

/** An image attachment that will be re-uploaded to the hall post. */
export interface HallImage {
  id: string;
  name: string;
  url: string;
  size: number;
  spoiler: boolean;
}

export interface HallSticker {
  name: string;
  /** Permanent image URL, or undefined for a sticker with no image (Lottie): shown by name. */
  url: string | undefined;
}

/** Media shown by URL (an embed's image or GIF); these hosts do not expire. */
export interface EmbedMedia {
  url: string;
  gif: boolean;
  spoiler: boolean;
}

/** Everything of a message the hall card shows, before any truncation or markup. */
export interface MessageBody {
  forwarded: boolean;
  text: string;
  /** A note standing in for what cannot be copied, such as a native poll. */
  note: string | undefined;
  images: HallImage[];
  stickers: HallSticker[];
  /** File names of everything not re-uploaded, capped. */
  files: string[];
  /** How many more files there were beyond `files`. */
  moreFiles: number;
  embedMedia: EmbedMedia[];
}

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const imageExtension = /\.(?:png|jpe?g|gif|webp)$/iu;

export const spoilerPrefix = 'SPOILER_';

export function isSpoilerName(name: string): boolean {
  return name.startsWith(spoilerPrefix);
}

/** A spoiler attachment: the `SPOILER_` file name prefix or Discord's `IsSpoiler` flag. */
export function isSpoilerAttachment(attachment: Pick<AttachmentFacts, 'name' | 'flags'>): boolean {
  return (
    isSpoilerName(attachment.name) ||
    ((attachment.flags ?? 0) & AttachmentFlags.IsSpoiler) === AttachmentFlags.IsSpoiler
  );
}

export function isImageAttachment(attachment: Pick<AttachmentFacts, 'name' | 'contentType'>) {
  const type = attachment.contentType?.split(';')[0]?.trim().toLowerCase();
  if (type) return imageTypes.has(type);
  return imageExtension.test(attachment.name);
}

/** A file name that is safe to print on one line: no control characters or backticks, short. */
export function safeFileName(name: string, max = 60): string {
  const clean = name
    .replace(/`/gu, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
  return truncateText(clean === '' ? 'file' : clean, max);
}

export interface AttachmentPlan {
  images: HallImage[];
  files: string[];
  moreFiles: number;
}

/**
 * Splits attachments into images to re-upload (within the count, per image and total size caps,
 * in message order) and everything else, which is listed by name. An image over a cap is listed too.
 */
export function planAttachments(
  attachments: readonly AttachmentFacts[],
  caps: ContentCaps = hallOfFame,
): AttachmentPlan {
  const images: HallImage[] = [];
  const names: string[] = [];
  let bytes = 0;
  for (const attachment of attachments) {
    const fits =
      isImageAttachment(attachment) &&
      images.length < caps.maxImages &&
      attachment.size <= caps.maxImageBytes &&
      bytes + attachment.size <= caps.maxImageBytesTotal;
    if (fits) {
      bytes += attachment.size;
      images.push({
        id: attachment.id,
        name: attachment.name,
        url: attachment.url,
        size: attachment.size,
        spoiler: isSpoilerAttachment(attachment),
      });
    } else {
      // A spoiler's name is hidden on Discord too (a file named SPOILER_plans.zip, or flagged).
      names.push(isSpoilerAttachment(attachment) ? 'spoiler file' : safeFileName(attachment.name));
    }
  }
  const files = names.slice(0, caps.maxAttachmentNames);
  return { images, files, moreFiles: names.length - files.length };
}

/** A sticker as an image URL (PNG, APNG, GIF), or by name only when it has no image (Lottie). */
export function classifySticker(sticker: StickerFacts): HallSticker {
  const name = safeFileName(sticker.name);
  switch (sticker.format) {
    case StickerFormatType.PNG:
    case StickerFormatType.APNG:
      return { name, url: `https://cdn.discordapp.com/stickers/${sticker.id}.png` };
    case StickerFormatType.GIF:
      // The plain CDN serves a GIF sticker's first frame at best: the media proxy plays it.
      return { name, url: `https://media.discordapp.net/stickers/${sticker.id}.gif` };
    default:
      return { name, url: undefined };
  }
}

/**
 * Whether the media of an embed may sit inside a `||spoiler||` of `content`: true when any `||`
 * marker (outside code, not escaped) comes before the link, the last mention of it counting. That
 * also covers a span that closed earlier, which blurs a picture that was not hidden; a leaked
 * spoiler is worse. When the link cannot be found in the text at all (Discord rewrote it), any
 * marker in the message counts.
 */
function afterSpoilerMarker(
  content: string,
  links: readonly (string | null | undefined)[],
): boolean {
  const first = spoilerMarkerIndexes(content)[0];
  if (first === undefined) return false;
  const positions = links.flatMap((link) => {
    const at = link ? content.lastIndexOf(link) : -1;
    return at === -1 ? [] : [at];
  });
  return positions.length === 0 || first < Math.max(...positions);
}

function allowedMedia(media: EmbedMediaFacts | null | undefined): string | undefined {
  const raw = media?.proxyUrl ?? media?.url;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    return isAllowedHost(url.hostname) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The images and GIFs of link embeds, by URL, up to `limit`. Only hosts from the imaging allowlist
 * are kept (the proxied URL when there is one), so a hall post never points at a page that can
 * change after the fact. A GIF embed (Tenor, Giphy) contributes its thumbnail. A link inside a
 * `||spoiler||` stays a spoiler (see `afterSpoilerMarker`).
 */
export function pickEmbedMedia(
  embeds: readonly EmbedFacts[],
  content: string,
  limit: number,
): EmbedMedia[] {
  const picked: EmbedMedia[] = [];
  const seen = new Set<string>();
  for (const embed of embeds) {
    if (picked.length >= limit) break;
    const gifv = embed.type === 'gifv';
    const media =
      embed.image?.url || embed.image?.proxyUrl ? embed.image : gifv ? embed.thumbnail : undefined;
    const url = allowedMedia(media);
    if (!url || seen.has(stableUrl(url))) continue;
    seen.add(stableUrl(url));
    picked.push({
      url,
      gif: gifv || /\.gif$/iu.test(new URL(url).pathname),
      spoiler: afterSpoilerMarker(content, [embed.url, media?.url, media?.proxyUrl]),
    });
  }
  return picked;
}

/** A native poll as a text note, since its votes cannot be copied. */
export function pollNote(question: string): string {
  const flat = question.replace(/\s+/gu, ' ').trim();
  return flat === '' ? '📊 Poll' : `📊 Poll: ${truncateText(flat, 200)}`;
}

/**
 * What the hall card shows of a message. A forward shows its first snapshot (and says it was
 * forwarded); otherwise the message itself. Media share `maxImages` slots: attachments first, then
 * sticker images, then embed media. A sticker with no room is shown by name only.
 */
export function describeMessage(
  message: MessageFacts,
  caps: ContentCaps = hallOfFame,
): MessageBody {
  const snapshot = message.snapshots[0];
  const forwarded = snapshot !== undefined;
  const source: SnapshotFacts = snapshot ?? message;

  const plan = planAttachments(source.attachments, caps);
  let room = Math.max(0, caps.maxImages - plan.images.length);

  const stickers = source.stickers.map((sticker): HallSticker => {
    const classified = classifySticker(sticker);
    if (classified.url === undefined) return classified;
    if (room <= 0) return { name: classified.name, url: undefined };
    room -= 1;
    return classified;
  });

  const embedMedia = pickEmbedMedia(source.embeds, source.content, room);

  const question = message.pollQuestion;
  return {
    forwarded,
    text: source.content,
    note: question === undefined || question === null ? undefined : pollNote(question),
    images: plan.images,
    stickers,
    files: plan.files,
    moreFiles: plan.moreFiles,
    embedMedia,
  };
}

/** True when there is nothing to show at all (the card then says so). */
export function bodyIsEmpty(body: MessageBody): boolean {
  return (
    body.text.trim() === '' &&
    body.note === undefined &&
    body.images.length === 0 &&
    body.stickers.length === 0 &&
    body.files.length === 0 &&
    body.moreFiles === 0 &&
    body.embedMedia.length === 0
  );
}

/** A URL without query or fragment: Discord's signed CDN links change on every fetch. */
export function stableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The parts of a body that decide what the card looks like, without anything that is signed. */
export function bodyHashParts(body: MessageBody): unknown {
  return {
    forwarded: body.forwarded,
    text: body.text,
    note: body.note ?? null,
    images: body.images.map((i) => [i.id, i.name, i.size, i.spoiler]),
    stickers: body.stickers.map((s) => [s.name, s.url ?? null]),
    files: body.files,
    moreFiles: body.moreFiles,
    embedMedia: body.embedMedia.map((m) => [stableUrl(m.url), m.gif, m.spoiler]),
  };
}

/** JSON with sorted keys, so equal values always give the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Hash of what a rendered card shows (build the input from `bodyHashParts` plus the author, peak,
 * breakdown...). A re-render whose hash equals the stored one needs no edit, which keeps embed
 * resolution updates from editing the post.
 */
export function renderHash(parts: unknown): string {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex');
}
