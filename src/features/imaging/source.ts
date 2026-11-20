import { messages } from './errors.js';
import { checkUrl, extractUrls, type UrlCheck } from './urls.js';

export interface AttachmentData {
  url: string;
  contentType: string | null;
}

export interface EmbedData {
  url: string | null;
  provider: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
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
  return allowed(e.imageUrl) ?? allowed(e.thumbnailUrl);
}

function pickReply(reply: ReplyData): SourcePick {
  let sawVideo = false;
  for (const a of reply.attachments) {
    if (a.contentType?.startsWith('video/')) {
      sawVideo = true;
    } else if (a.contentType === null || a.contentType.startsWith('image/')) {
      const check = allowed(a.url);
      if (check) return { ok: true, check };
    }
  }

  for (const e of reply.embeds) {
    const check = pickEmbed(e);
    if (check) return { ok: true, check };
  }

  const sticker = reply.stickers.find((s) => s.format !== 'lottie');
  if (sticker) {
    const check = allowed(sticker.url);
    if (check) return { ok: true, check };
  }

  for (const raw of extractUrls(reply.content)) {
    const check = allowed(raw);
    if (check) return { ok: true, check };
  }

  if (reply.stickers.some((s) => s.format === 'lottie')) return fail(messages.lottie);
  return fail(sawVideo ? messages.video : messages.notImage);
}

/** Precedence: attachment, then url, then avatar, then the replied-to message. */
export function pickSource(inputs: SourceInputs): SourcePick {
  if (inputs.attachment) return pickAttachment(inputs.attachment);
  if (inputs.url !== undefined) return pickDirect(inputs.url);
  if (inputs.avatarUrl !== undefined) return pickDirect(inputs.avatarUrl);
  if (inputs.reply) return pickReply(inputs.reply);
  return fail(null);
}
