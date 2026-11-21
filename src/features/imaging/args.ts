export type BubbleStyle = 'transparent' | 'white';
export type TailSide = 'left' | 'right';

export interface BubbleArgs {
  style: BubbleStyle;
  tail: TailSide;
  url?: string;
  userId?: string;
}

const urlToken = /^<?(https?:\/\/[^\s<>]+)>?$/i;
const userToken = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/;

/**
 * Parses the words after `?bubble`: style, tail side and an optional source (link or user) in
 * any order. A repeated kind or an unknown word is a usage error.
 */
export function parseBubbleArgs(rest: string): BubbleArgs | { error: 'usage' } {
  let style: BubbleStyle | undefined;
  let tail: TailSide | undefined;
  let url: string | undefined;
  let userId: string | undefined;

  for (const token of rest.split(/\s+/).filter((t) => t.length > 0)) {
    const lower = token.toLowerCase();
    const urlMatch = urlToken.exec(token);
    const userMatch = userToken.exec(token);
    if (lower === 'white' || lower === 'transparent') {
      if (style) return { error: 'usage' };
      style = lower;
    } else if (lower === 'left' || lower === 'right') {
      if (tail) return { error: 'usage' };
      tail = lower;
    } else if (urlMatch?.[1]) {
      if (url) return { error: 'usage' };
      url = urlMatch[1];
    } else if (userMatch) {
      if (userId) return { error: 'usage' };
      userId = userMatch[1] ?? userMatch[2];
    } else {
      return { error: 'usage' };
    }
  }

  const args: BubbleArgs = { style: style ?? 'transparent', tail: tail ?? 'left' };
  if (url) args.url = url;
  if (userId) args.userId = userId;
  return args;
}

/**
 * Parses the words after `?caption`: an optional leading link, then the caption (newlines kept).
 * The allowlist check happens later, when the source is picked.
 */
export function parseCaptionArgs(rest: string): { url?: string; text: string } {
  const trimmed = rest.trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const urlMatch = match?.[1] ? urlToken.exec(match[1]) : null;
  if (urlMatch?.[1]) return { url: urlMatch[1], text: (match?.[2] ?? '').trim() };
  return { text: trimmed };
}

/**
 * The text after the prefix and the invoked command name or alias, newlines preserved (Sapphire's
 * lexer drops them). Empty when the content is not that command.
 */
export function commandRemainder(content: string, prefix: string, commandName: string): string {
  if (!content.toLowerCase().startsWith((prefix + commandName).toLowerCase())) return '';
  const after = content.slice(prefix.length + commandName.length);
  if (after.length > 0 && !/^\s/.test(after)) return '';
  return after.trim();
}

export function bubbleUsage(prefix: string): string {
  return `Usage: \`${prefix}bubble [white|transparent] [left|right] [link | @user]\`, with an image attached or as a reply to one. Or use \`/bubble\`.`;
}

export function captionUsage(prefix: string): string {
  return `Usage: \`${prefix}caption <text>\`, with an image attached or as a reply to one. Or use \`/caption\`.`;
}
