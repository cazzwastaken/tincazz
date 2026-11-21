import { type HelpPage, isHelpPage } from './topics.js';

export type HelpId =
  | { kind: 'page'; page: HelpPage; ownerId: string }
  | { kind: 'menu'; ownerId: string };

const prefix = 'hp';
const owner = /^\d{1,20}$/;

/** The ID of a button that opens a page, `hp:<page>:<ownerId>`. */
export function encodeHelpPageId(page: HelpPage, ownerId: string): string {
  return `${prefix}:${page}:${ownerId}`;
}

/** The ID of the topic select menu; the chosen page arrives in the interaction's values. */
export function encodeHelpMenuId(ownerId: string): string {
  return `${prefix}:menu:${ownerId}`;
}

/** Decodes a help custom ID; undefined for anything else. Never throws. */
export function decodeHelpId(customId: string): HelpId | undefined {
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== prefix) {
    return undefined;
  }
  const [, page, ownerId] = parts as [string, string, string];
  if (!owner.test(ownerId)) {
    return undefined;
  }
  if (page === 'menu') {
    return { kind: 'menu', ownerId };
  }
  return isHelpPage(page) ? { kind: 'page', page, ownerId } : undefined;
}
