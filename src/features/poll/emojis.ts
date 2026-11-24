import { optionEmojis, yesNoEmojis } from './config.js';

interface EmojiPoll {
  yesNo: boolean;
  options: readonly string[];
}

/** The reaction emoji for each option of a poll, in option order. */
export function pollEmojis(poll: EmojiPoll): string[] {
  return poll.yesNo ? [...yesNoEmojis] : optionEmojis.slice(0, poll.options.length);
}

// Keycaps arrive with or without the variation selector depending on the client.
const normalize = (emoji: string) => emoji.replace(/️/g, '');

/** The option a reaction emoji votes for, or undefined when it is not one of the poll's emoji. */
export function optionIndexOf(poll: EmojiPoll, emoji: string): number | undefined {
  const target = normalize(emoji);
  const index = pollEmojis(poll).findIndex((candidate) => normalize(candidate) === target);
  return index === -1 ? undefined : index;
}
