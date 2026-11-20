import { limits } from './config.js';
import { ImagingError, messages } from './errors.js';

export interface MentionNames {
  users: ReadonlyMap<string, string>;
  roles: ReadonlyMap<string, string>;
  channels: ReadonlyMap<string, string>;
}

export const noMentionNames: MentionNames = {
  users: new Map(),
  roles: new Map(),
  channels: new Map(),
};

/** The one set of mention patterns. Global, but only used with `replace` and `matchAll`, which are safe with that. */
export const mentionPatterns = {
  user: /<@!?(\d+)>/g,
  role: /<@&(\d+)>/g,
  channel: /<#(\d+)>/g,
} as const;

/** Control characters other than newline and tab, and invisible format characters. */
const invisible = /[^\P{Cc}\n\t]|\p{Cf}/gu;

/**
 * Format characters that join emoji or letters and stay: ZWNJ (U+200C), ZWJ (U+200D) and the tag
 * characters of subdivision flags (U+E0020 to U+E007F).
 */
function joins(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code === 0x200c || code === 0x200d || (code >= 0xe0020 && code <= 0xe007f);
}

/** Every line break becomes `\n` and invisible characters go. */
const clean = (text: string) =>
  text
    .replace(/\r\n|[\r\u{0085}\u{2028}\u{2029}]/gu, '\n')
    .replace(invisible, (char) => (joins(char) ? char : ''));

/**
 * Turns raw user text into a plain caption: invisible characters go (first, so they cannot hide a
 * mention from the patterns), mentions and custom emoji become readable text, every line break
 * becomes `\n`, whitespace is normalised and the line count is capped. Does not escape markup,
 * see {@link escapeMarkup}. Throws when nothing is left.
 */
export function sanitizeCaption(raw: string, names: MentionNames): string {
  const name = (found: string | undefined, fallback: string) =>
    found === undefined ? fallback : clean(found);
  const text = clean(raw)
    .replace(
      mentionPatterns.user,
      (_m, id: string) => `@${name(names.users.get(id), 'unknown-user')}`,
    )
    .replace(
      mentionPatterns.role,
      (_m, id: string) => `@${name(names.roles.get(id), 'unknown-role')}`,
    )
    .replace(
      mentionPatterns.channel,
      (_m, id: string) => `#${name(names.channels.get(id), 'unknown-channel')}`,
    )
    .replace(/<a?:(\w+):\d+>/g, ':$1:');

  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, limits.captionLines);

  const result = lines.join('\n').trim();
  if (result.length === 0) throw new ImagingError(messages.emptyCaption);
  return result;
}

/** Escapes text for Pango markup. `&` goes first so the entities are not double escaped. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
