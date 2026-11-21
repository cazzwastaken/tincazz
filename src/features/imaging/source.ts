import { messages } from './errors.js';
import { cleanMessageText, noMentionNames } from './text.js';
import { checkUrl, extractUrls, removeUrl, type UrlCheck } from './urls.js';

export interface AttachmentData {
  url: string;
  contentType: string | null;
  /** marked as a spoiler (`SPOILER_` file name); hidden in screenshots, refused as a source */
  spoiler?: boolean;
}

export interface EmbedData {
  url: string | null;
  provider: string | null;
  imageUrl: string | null;
  /** Discord's images-ext proxy of the image, allowed when the original host is not */
  imageProxyUrl: string | null;
  thumbnailUrl: string | null;
  thumbnailProxyUrl: string | null;
  hasVideo: boolean;
}

export interface StickerData {
  url: string;
  format: 'png' | 'apng' | 'gif' | 'lottie';
}

export interface ReplyData {
  attachments: AttachmentData[];
  embeds: EmbedData[];
  stickers: StickerData[];
  content: string;
}

export interface SourceInputs {
  attachment?: AttachmentData;
  url?: string;
  avatarUrl?: string;
  reply?: ReplyData;
}

type Allowed = Extract<UrlCheck, { ok: true }>;

/** `message: null` means nothing was given, so the command shows its usage text. */
export type SourcePick = { ok: true; check: Allowed } | { ok: false; message: string | null };

const fail = (message: string | null): SourcePick => ({ ok: false, message });

function allowed(raw: string | null): Allowed | null {
  if (raw === null) return null;
  const check = checkUrl(raw);
  return check.ok ? check : null;
}

function isTenorOrGiphy(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'tenor.com' ||
    host === 'www.tenor.com' ||
    host === 'media.tenor.com' ||
    host === 'media1.tenor.com' ||
    host === 'c.tenor.com' ||
    host === 'giphy.com' ||
    host === 'www.giphy.com' ||
    host === 'i.giphy.com' ||
    host === 'media.giphy.com' ||
    /^media\d+\.giphy\.com$/.test(host)
  );
}

function pickDirect(url: string): SourcePick {
  const check = checkUrl(url);
  return check.ok ? { ok: true, check } : fail(messages.notAllowed);
}

function pickAttachment(a: AttachmentData): SourcePick {
  if (a.contentType?.startsWith('video/')) return fail(messages.video);
  if (a.contentType !== null && !a.contentType.startsWith('image/')) return fail(messages.notImage);
  return pickDirect(a.url);
}

function pickEmbed(e: EmbedData): Allowed | null {
  const page = allowed(e.url);
  if (page && (page.kind === 'tenorPage' || isTenorOrGiphy(page.url.hostname))) return page;
  return (
    allowed(e.imageUrl) ??
    allowed(e.imageProxyUrl) ??
    allowed(e.thumbnailUrl) ??
    allowed(e.thumbnailProxyUrl)
  );
}

/** Whether `url` sits inside a `||spoiler||` span of `content`. */
function inSpoiler(content: string, url: string): boolean {
  for (const [, inner] of content.matchAll(/\|\|([\s\S]+?)\|\|/g)) {
    if (inner?.includes(url)) return true;
  }
  return false;
}

/**
 * A message's image and, when it came from a link in the content, that link. `spoiler` says the
 * image is hidden in Discord (a spoiler attachment, or a link or embed inside a spoiler span).
 */
function pickReplyLink(reply: ReplyData): {
  pick: SourcePick;
  link: string | null;
  spoiler: boolean;
} {
  const found = (check: Allowed, link: string | null = null, spoiler = false) => ({
    pick: { ok: true, check } as const,
    link,
    spoiler,
  });
  let sawVideo = false;
  for (const a of reply.attachments) {
    if (a.contentType?.startsWith('video/')) {
      sawVideo = true;
    } else if (a.contentType === null || a.contentType.startsWith('image/')) {
      const check = allowed(a.url);
      if (check) return found(check, null, a.spoiler === true);
    }
  }

  for (const e of reply.embeds) {
    const check = pickEmbed(e);
    if (check) return found(check, e.url, e.url !== null && inSpoiler(reply.content, e.url));
  }

  const sticker = reply.stickers.find((s) => s.format !== 'lottie');
  if (sticker) {
    const check = allowed(sticker.url);
    if (check) return found(check);
  }

  for (const raw of extractUrls(reply.content)) {
    const check = allowed(raw);
    if (check) return found(check, raw, inSpoiler(reply.content, raw));
  }

  if (reply.stickers.some((s) => s.format === 'lottie')) {
    return { pick: fail(messages.lottie), link: null, spoiler: false };
  }
  return { pick: fail(sawVideo ? messages.video : messages.notImage), link: null, spoiler: false };
}

/** The image of a replied-to message, unless it is a spoiler: that stays hidden. */
function pickReply(reply: ReplyData): SourcePick {
  const { pick, spoiler } = pickReplyLink(reply);
  return pick.ok && spoiler ? fail(messages.spoiler) : pick;
}

/** Precedence: attachment, then url, then avatar, then the replied-to message. */
export function pickSource(inputs: SourceInputs): SourcePick {
  if (inputs.attachment) return pickAttachment(inputs.attachment);
  if (inputs.url !== undefined) return pickDirect(inputs.url);
  if (inputs.avatarUrl !== undefined) return pickDirect(inputs.avatarUrl);
  if (inputs.reply) return pickReply(inputs.reply);
  return fail(null);
}

/** Whether an attachment, link or user was given, which wins over a replied or linked message. */
export function hasDirectSource(inputs: SourceInputs): boolean {
  return (
    inputs.attachment !== undefined || inputs.url !== undefined || inputs.avatarUrl !== undefined
  );
}

/**
 * What bubbling a whole message uses:
 * - an image and no other text: the image itself, exactly as a reply to it is picked (a spoiler
 *   image is an error: it would be shown in the clear)
 * - text: a screenshot of the message, with the image (if any) under the text, like Discord shows
 *   it; a spoiler image is drawn blurred
 * - neither: an error (`messages.emptyMessage`, or why the only media cannot be used)
 *
 * "Text" is the content left after removing the link the image was picked from, so a message that
 * is only a Tenor or Giphy link counts as image only. Markdown markers alone do not count as text.
 */
export type MessageSource =
  | { kind: 'image'; check: Allowed }
  | { kind: 'screenshot'; text: string; image: Allowed | null; imageSpoiler: boolean }
  | { kind: 'error'; message: string };

export function messageSource(message: ReplyData): MessageSource {
  const { pick, link, spoiler } = pickReplyLink(message);
  // A link that was the only thing in a spoiler leaves an empty `||||` behind.
  const text =
    link === null ? message.content : removeUrl(message.content, link).replace(/\|\|\s*\|\|/g, '');
  if (cleanMessageText(text, noMentionNames).length === 0) {
    if (pick.ok) {
      return spoiler
        ? { kind: 'error', message: messages.spoiler }
        : { kind: 'image', check: pick.check };
    }
    const reason = pick.message === messages.notImage ? null : pick.message;
    return { kind: 'error', message: reason ?? messages.emptyMessage };
  }
  return {
    kind: 'screenshot',
    text,
    image: pick.ok ? pick.check : null,
    imageSpoiler: pick.ok && spoiler,
  };
}
