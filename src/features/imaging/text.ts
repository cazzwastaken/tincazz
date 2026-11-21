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
 * Mentions become `@name` / `#name` and custom emoji `:name:`. Each resolved mention goes through
 * `mark`, which lets the message renderer style it. Names are cleaned too, so a display name cannot
 * smuggle in a line break or an invisible character.
 */
function resolveMentions(
  text: string,
  names: MentionNames,
  mark: (mention: string) => string = (mention) => mention,
): string {
  const name = (found: string | undefined, fallback: string) =>
    found === undefined ? fallback : clean(found).replace(/\n/g, ' ');
  return text
    .replace(mentionPatterns.user, (_m, id: string) =>
      mark(`@${name(names.users.get(id), 'unknown-user')}`),
    )
    .replace(mentionPatterns.role, (_m, id: string) =>
      mark(`@${name(names.roles.get(id), 'unknown-role')}`),
    )
    .replace(mentionPatterns.channel, (_m, id: string) =>
      mark(`#${name(names.channels.get(id), 'unknown-channel')}`),
    )
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
}

/**
 * Turns raw user text into a plain caption: invisible characters go (first, so they cannot hide a
 * mention from the patterns), mentions and custom emoji become readable text, every line break
 * becomes `\n`, whitespace is normalised and the line count is capped. Does not escape markup,
 * see {@link escapeMarkup}. Throws when nothing is left.
 */
export function sanitizeCaption(raw: string, names: MentionNames): string {
  const lines = resolveMentions(clean(raw), names)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .slice(0, limits.captionLines);

  const result = lines.join('\n').trim();
  if (result.length === 0) throw new ImagingError(messages.emptyCaption);
  return result;
}

/** A piece of message text; mentions are styled like Discord's highlighted pills. */
export interface TextRun {
  text: string;
  mention?: true;
}

// Private use characters bracket mentions while the text is capped. Any in the input are dropped
// first, so only ours remain.
const mentionStart = '\u{E000}';
const mentionEnd = '\u{E001}';
const sentinels = /[\u{E000}\u{E001}]/gu;

/**
 * Discord markdown markers that only style text: they go and the text stays. Code fences (with
 * their language tag), backticks, bold, underline, strikethrough, spoilers, paired `*` / `_`
 * italics, masked links (the label stays), and quote, heading and subtext line prefixes.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```(?:[\w+#.-]*\n)?/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]\n]+)\]\(<?https?:\/\/[^\s)]+>?\)/g, '$1')
    .replace(/\*\*|__|~~|\|\|/g, '')
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '$1')
    .replace(/(^|\W)_(\S(?:[^_\n]*\S)?)_(?=\W|$)/g, '$1$2')
    .replace(/^(?:>>> |> |#{1,3} |-# )/gm, '');
}

/**
 * Turns the raw content of a Discord message into text runs for a screenshot: invisible characters
 * go, markdown markers are stripped, mentions resolve to names (as mention runs) and custom emoji
 * to `:name:`. Line breaks are kept (blank lines too, but not at the ends), tabs become spaces, and
 * the text is capped at `limits.messageLines` lines and `limits.messageChars` characters with an
 * ellipsis. Never throws; an empty array means there is no text. Does not escape markup.
 */
export function cleanMessageText(raw: string, names: MentionNames): TextRun[] {
  const marked = resolveMentions(
    stripMarkdown(clean(raw).replace(sentinels, '')),
    names,
    (mention) => `${mentionStart}${mention.replace(sentinels, '')}${mentionEnd}`,
  ).replace(/@(everyone|here)\b/g, `${mentionStart}@$1${mentionEnd}`);

  const all = marked
    .trim()
    .split('\n')
    .map((line) => line.replace(/\t/g, '    ').trimEnd());
  let cut = all.length > limits.messageLines;
  let text = all.slice(0, limits.messageLines).join('\n');
  const chars = [...text];
  if (chars.length > limits.messageChars) {
    text = chars.slice(0, limits.messageChars).join('').trimEnd();
    cut = true;
  }
  if (cut) text += '…';

  const runs: TextRun[] = [];
  for (const [index, part] of text.split(mentionStart).entries()) {
    const close = part.indexOf(mentionEnd);
    // Text before the first mention, or a mention cut off by the cap without its end.
    const [mention, rest] =
      index === 0
        ? ['', part]
        : close === -1
          ? [part, '']
          : [part.slice(0, close), part.slice(close + 1)];
    if (mention.length > 0) runs.push({ text: mention.replace(sentinels, ''), mention: true });
    const plain = rest.replace(sentinels, '');
    if (plain.length > 0) runs.push({ text: plain });
  }
  return runs;
}

/** The plain text of some runs. */
export function runsText(runs: readonly TextRun[]): string {
  return runs.map((run) => run.text).join('');
}

/** Escapes text for Pango markup. `&` goes first so the entities are not double escaped. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
