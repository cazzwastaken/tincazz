import type { ContainerBuilder } from 'discord.js';
import type { HallCardInput, MessageBody } from '../../src/features/halloffame/index.js';

export const emptyBody = (over: Partial<MessageBody> = {}): MessageBody => ({
  forwarded: false,
  text: '',
  note: undefined,
  images: [],
  stickers: [],
  files: [],
  moreFiles: 0,
  embedMedia: [],
  ...over,
});

export const cardInput = (over: Partial<HallCardInput> = {}): HallCardInput => ({
  author: {
    id: '111111111111111111',
    displayName: 'Cazz',
    username: 'cazzwastaken',
    avatarUrl: 'https://cdn.discordapp.com/avatars/111111111111111111/abc.png?size=128',
  },
  source: {
    guildId: '222222222222222222',
    channelId: '333333333333333333',
    messageId: '444444444444444444',
    channelName: 'memes',
    createdAt: 1_700_000_000_000,
  },
  body: emptyBody({ text: 'hello world' }),
  peak: 6,
  threshold: 5,
  breakdown: [],
  uploaded: [],
  ...over,
});

interface Node {
  type: number;
  [key: string]: unknown;
}

/** Every component of a built card, depth first, including gallery items and accessories. */
export function walk(container: ContainerBuilder): Node[] {
  const found: Node[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (typeof node.type === 'number') found.push(node as Node);
    for (const key of ['components', 'items', 'accessory']) visit(node[key]);
  };
  visit(container.toJSON());
  return found;
}

const textDisplay = 10;
const mediaGallery = 12;

export function texts(container: ContainerBuilder): string[] {
  return walk(container)
    .filter((node) => node.type === textDisplay)
    .map((node) => String(node.content));
}

export const allText = (container: ContainerBuilder): string => texts(container).join('\n');

/** Components as Discord counts them: every node, and a gallery item counts as one. */
export function componentCount(container: ContainerBuilder): number {
  return walk(container).length + countGalleryItems(container);
}

function countGalleryItems(container: ContainerBuilder): number {
  return walk(container)
    .filter((node) => node.type === mediaGallery)
    .reduce((sum, node) => sum + (Array.isArray(node.items) ? node.items.length : 0), 0);
}

export function textLength(container: ContainerBuilder): number {
  return texts(container).reduce((sum, text) => sum + text.length, 0);
}

/** The `attachment://` names a card references, from its JSON. */
export function referencedAttachments(container: ContainerBuilder): string[] {
  const names: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === 'object') {
      for (const inner of Object.values(value)) visit(inner);
    } else if (typeof value === 'string' && value.startsWith('attachment://')) {
      names.push(value.slice('attachment://'.length));
    }
  };
  visit(container.toJSON());
  return names;
}

export function galleryUrls(container: ContainerBuilder): string[] {
  return walk(container)
    .filter((node) => node.type === mediaGallery)
    .flatMap((node) => (node.items as { media: { url: string } }[]).map((item) => item.media.url));
}

export function buttons(container: ContainerBuilder): { label: string; url: string }[] {
  return walk(container)
    .filter((node) => node.type === 2)
    .map((node) => ({ label: String(node.label), url: String(node.url) }));
}
