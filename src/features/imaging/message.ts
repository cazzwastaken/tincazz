import sharp, { type OverlayOptions } from 'sharp';
import { limits } from './config.js';
import { sourceTooLarge } from './decode.js';
import { ImagingError, messages } from './errors.js';
import { downloadImage, type Fetcher } from './fetch.js';
import { ensureFonts, messageFont } from './fonts.js';
import type { ReplyData } from './source.js';
import { cleanMessageText, escapeMarkup, type MentionNames, type TextRun } from './text.js';
import { checkUrl, type UrlCheck } from './urls.js';

type Allowed = Extract<UrlCheck, { ok: true }>;

/** A Discord message as plain data, gathered by the adapters in `discord.ts`. */
export interface MessageSnapshot {
  author: {
    name: string;
    /** the member's display colour as `#rrggbb`, `null` for the default */
    color: string | null;
    /** a static PNG avatar URL; `null` (or a failed download) draws a grey circle */
    avatarUrl: string | null;
  };
  createdTimestamp: number;
  message: ReplyData;
  names: MentionNames;
}

/** Discord's dark theme. */
export const discordColors = {
  background: '#313338',
  name: '#f2f3f5',
  text: '#dbdee1',
  timestamp: '#949ba4',
  mention: '#c9cdfb',
  mentionBackground: '#5865f2',
  avatarFallback: '#4e5058',
  /** a spoiler's solid box, drawn as both background and text colour so nothing shows */
  spoiler: '#1e1f22',
} as const;

/** The cozy message layout, in pixels. */
export const screenshot = {
  width: 600,
  padding: 16,
  avatarSize: 40,
  /** where the name and text start: padding, avatar and a 16 px gap */
  contentLeft: 72,
  fontSize: 16,
  timestampSize: 12,
  imageGap: 6,
  imageMaxHeight: 350,
  imageRadius: 8,
  nameChars: 32,
} as const;

export const contentWidth = screenshot.width - screenshot.contentLeft - screenshot.padding;

const pad = (n: number) => String(n).padStart(2, '0');

/** Discord's full timestamp, `11/21/2026 2:32 PM`, always in UTC. */
export function formatTimestamp(ms: number): string {
  const date = new Date(Number.isFinite(ms) ? ms : 0);
  const hours = date.getUTCHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const day = `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()}`;
  return `${day} ${hour12}:${pad(date.getUTCMinutes())} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** The colour the name is drawn in: a valid `#rrggbb` other than black (no role colour), else the default. */
export function nameColor(hex: string | null): string {
  if (hex === null || !/^#[0-9a-f]{6}$/i.test(hex) || hex === '#000000') return discordColors.name;
  return hex.toLowerCase();
}

/** A display name on one line, without invisible characters, at most `screenshot.nameChars` long. */
export function cleanName(name: string): string {
  const flat = name
    .replace(/[^\P{Cc}]|\p{Cf}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...flat];
  const short = chars.length > screenshot.nameChars;
  const result = short ? `${chars.slice(0, screenshot.nameChars).join('').trimEnd()}…` : flat;
  return result.length > 0 ? result : 'unknown-user';
}

/** Scales `width` x `height` down (never up) to fit in `maxWidth` x `maxHeight`, aspect kept. */
export function fitImage(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScreenshotLayout {
  width: number;
  height: number;
  avatar: Box;
  text: Box;
  image: Box | null;
}

/**
 * Empty space to add above a message of `width` x `height` so a bubble cut into the result (see
 * `bubbleGeometry`) ends, tail tip included, above the message: the bubble then reads as the
 * author saying something instead of hiding their name and the first lines.
 */
export function bubbleHeadroom(width: number, height: number): number {
  return Math.ceil(Math.min((2 * height) / 3, 0.4 * width));
}

const shift = (box: Box, by: number): Box => ({ ...box, top: box.top + by });

/**
 * Where everything goes, given the rendered text block (header and body) and the scaled image.
 * The canvas is `screenshot.width` wide and as tall as its content plus padding (and the bubble
 * headroom when asked for); nothing is placed outside it.
 */
export function layoutScreenshot(
  text: { width: number; height: number },
  image: { width: number; height: number } | null,
  options: { headroom?: boolean } = {},
): ScreenshotLayout {
  const { padding, avatarSize, contentLeft, imageGap } = screenshot;
  const textBox = {
    left: contentLeft,
    top: padding,
    width: Math.min(text.width, contentWidth),
    height: text.height,
  };
  const imageBox = image
    ? {
        left: contentLeft,
        top: textBox.top + textBox.height + imageGap,
        width: Math.min(image.width, contentWidth),
        height: image.height,
      }
    : null;
  const bottom = imageBox ? imageBox.top + imageBox.height : textBox.top + textBox.height;
  const height = Math.max(bottom, padding + avatarSize) + padding;
  const top = options.headroom ? bubbleHeadroom(screenshot.width, height) : 0;
  return {
    width: screenshot.width,
    height: height + top,
    avatar: shift({ left: padding, top: padding, width: avatarSize, height: avatarSize }, top),
    text: shift(textBox, top),
    image: imageBox ? shift(imageBox, top) : null,
  };
}

/**
 * libvips crops rendered text to its ink, so a short name like "ace" would sit higher than "Ég".
 * An invisible tall strut at the end of the header and of the body keeps the crop at the full line
 * height; its negative letter spacing keeps it from taking room (and from wrapping a full line).
 */
const strut = '<span fgalpha="1" letter_spacing="-20000">Ég</span>';

/** Pango markup of the header (name and timestamp) and the message text. Escapes everything. */
export function messageMarkup(parts: {
  name: string;
  color: string;
  timestamp: string;
  runs: readonly TextRun[];
}): string {
  const header =
    `<span foreground="${parts.color}" weight="semibold">${escapeMarkup(parts.name)}</span>` +
    `  <span foreground="${discordColors.timestamp}" size="${screenshot.timestampSize * 1024}">${escapeMarkup(parts.timestamp)}</span>${strut}`;
  if (parts.runs.length === 0) return header;
  const body = parts.runs
    .map((run) =>
      run.spoiler
        ? `<span foreground="${discordColors.spoiler}" background="${discordColors.spoiler}">${escapeMarkup(run.text)}</span>`
        : run.mention
          ? `<span foreground="${discordColors.mention}" background="${discordColors.mentionBackground}" bgalpha="30%">${escapeMarkup(run.text)}</span>`
          : escapeMarkup(run.text),
    )
    .join('');
  return `${header}\n<span foreground="${discordColors.text}">${body}</span>${strut}`;
}

async function renderText(
  markup: string,
): Promise<{ data: Buffer; width: number; height: number }> {
  await ensureFonts();
  const { data, info } = await sharp({
    text: {
      text: markup,
      font: messageFont(screenshot.fontSize),
      width: contentWidth,
      wrap: 'word-char',
      rgba: true,
      dpi: 72,
    },
  })
    .timeout({ seconds: limits.jobTimeoutMs / 1000 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function circleMask(size: number): Buffer {
  const r = size / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`,
  );
}

function roundedMask(width: number, height: number, radius: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );
}

/** The avatar cut to a circle, or a plain grey circle when there is none or it cannot be decoded. */
export async function avatarCircle(input: Buffer | null): Promise<Buffer> {
  const size = screenshot.avatarSize;
  const mask = circleMask(size);
  if (input) {
    try {
      return await sharp(input, { limitInputPixels: limits.maxSourceSide ** 2 })
        .resize(size, size, { fit: 'cover' })
        .ensureAlpha()
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
        .toBuffer();
    } catch {
      // fall through to the placeholder
    }
  }
  return sharp({
    create: { width: size, height: size, channels: 4, background: discordColors.avatarFallback },
  })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * The first frame of an attached image, scaled to fit under the text with rounded corners. An
 * animated attachment is shown still: the screenshot is one frame.
 */
export async function attachmentPreview(
  input: Buffer,
): Promise<{ data: Buffer; width: number; height: number }> {
  try {
    const head = await sharp(input).metadata();
    const pages = head.pages ?? 1;
    const width = pages === 1 ? head.autoOrient.width : head.width;
    const pageHeight = pages === 1 ? head.autoOrient.height : (head.pageHeight ?? head.height);
    if (!width || !pageHeight) throw new ImagingError(messages.notImage);
    if (sourceTooLarge({ width, pageHeight, pages: 1 })) {
      throw new ImagingError(messages.tooManyPixels);
    }
    const size = fitImage(width, pageHeight, contentWidth, screenshot.imageMaxHeight);
    const data = await sharp(input, {
      page: 0,
      pages: 1,
      limitInputPixels: limits.maxSourceSide ** 2,
      autoOrient: pages === 1,
    })
      .timeout({ seconds: limits.jobTimeoutMs / 1000 })
      .resize(size.width, size.height, { fit: 'fill' })
      .ensureAlpha()
      .composite([
        {
          input: roundedMask(size.width, size.height, screenshot.imageRadius),
          blend: 'dest-in',
        },
      ])
      .png()
      .toBuffer();
    return { data, ...size };
  } catch (error) {
    if (error instanceof ImagingError) throw error;
    throw new ImagingError(messages.notImage);
  }
}

/** Everything a screenshot shows, already downloaded. `text` is raw message content. */
export interface ScreenshotParts {
  name: string;
  color: string | null;
  createdTimestamp: number;
  text: string;
  names: MentionNames;
  avatar: Buffer | null;
  image: Buffer | null;
}

/**
 * Draws the message as a PNG in Discord's dark theme. With `headroom` it leaves room above the
 * message for a speech bubble (see {@link bubbleHeadroom}).
 */
export async function composeScreenshot(
  parts: ScreenshotParts,
  options: { headroom?: boolean } = {},
): Promise<Buffer> {
  const markup = messageMarkup({
    name: cleanName(parts.name),
    color: nameColor(parts.color),
    timestamp: formatTimestamp(parts.createdTimestamp),
    runs: cleanMessageText(parts.text, parts.names),
  });
  const [text, avatar, image] = await Promise.all([
    renderText(markup),
    avatarCircle(parts.avatar),
    parts.image ? attachmentPreview(parts.image) : Promise.resolve(null),
  ]);
  const layout = layoutScreenshot(text, image, options);

  // The ink of a long word can stick out of the wrap width; cut it at the column.
  const textInput =
    text.width > layout.text.width
      ? await sharp(text.data, { raw: { width: text.width, height: text.height, channels: 4 } })
          .extract({ left: 0, top: 0, width: layout.text.width, height: text.height })
          .png()
          .toBuffer()
      : await sharp(text.data, { raw: { width: text.width, height: text.height, channels: 4 } })
          .png()
          .toBuffer();

  const layers: OverlayOptions[] = [
    { input: avatar, left: layout.avatar.left, top: layout.avatar.top },
    { input: textInput, left: layout.text.left, top: layout.text.top },
  ];
  if (image && layout.image) {
    layers.push({ input: image.data, left: layout.image.left, top: layout.image.top });
  }
  return sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 4,
      background: discordColors.background,
    },
  })
    .composite(layers)
    .png()
    .toBuffer();
}

/**
 * Downloads the avatar (best effort: a failure draws the placeholder) and the image (a failure is
 * the command's error), then draws the screenshot with room for the bubble. Both go through the allowlisted downloader with
 * the job's signal.
 */
export async function renderScreenshot(
  snapshot: MessageSnapshot,
  source: { text: string; image: Allowed | null },
  options: { fetch: Fetcher; signal?: AbortSignal },
): Promise<Buffer> {
  const avatarCheck = snapshot.author.avatarUrl ? checkUrl(snapshot.author.avatarUrl) : null;
  const [avatar, image] = await Promise.all([
    avatarCheck?.ok
      ? downloadImage(avatarCheck, options).catch((error: unknown) => {
          if (options.signal?.aborted) throw error;
          return null;
        })
      : Promise.resolve(null),
    source.image ? downloadImage(source.image, options) : Promise.resolve(null),
  ]);
  options.signal?.throwIfAborted();
  return composeScreenshot(
    {
      name: snapshot.author.name,
      color: snapshot.author.color,
      createdTimestamp: snapshot.createdTimestamp,
      text: source.text,
      names: snapshot.names,
      avatar,
      image,
    },
    { headroom: true },
  );
}
