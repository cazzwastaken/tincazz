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

/**
 * Turns raw user text into a plain caption: mentions and custom emoji become readable text,
 * invisible characters go, whitespace is normalised and the line count is capped. Does not
 * escape markup, see {@link escapeMarkup}. Throws when nothing is left.
 */
export function sanitizeCaption(raw: string, names: MentionNames): string {
  const text = raw
    .replace(mentionPatterns.user, (_m, id: string) => `@${names.users.get(id) ?? 'unknown-user'}`)
    .replace(mentionPatterns.role, (_m, id: string) => `@${names.roles.get(id) ?? 'unknown-role'}`)
    .replace(
      mentionPatterns.channel,
      (_m, id: string) => `#${names.channels.get(id) ?? 'unknown-channel'}`,
    )
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\r\n/g, '\n')
    .replace(/[^\P{Cc}\n\t]|[^\P{Cf}‍]/gu, '');

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
