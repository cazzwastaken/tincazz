import {
  type APIContainerComponent,
  type AttachmentBuilder,
  ComponentType,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from 'discord.js';

export const accents = {
  loss: 0x95a5a6,
  win: 0x2ecc71,
  gold: 0xf1c40f,
  error: 0xe74c3c,
  brand: 0x5865f2,
} as const;

/** A Components V2 container with one text display per text. */
export function card(accent: number, ...texts: string[]): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(...texts.map((text) => new TextDisplayBuilder().setContent(text)));
}

/** A copy of a sent card without its buttons and selects, e.g. to retire a single-use button. */
export function withoutActionRows(container: APIContainerComponent): ContainerBuilder {
  return new ContainerBuilder({
    ...container,
    components: container.components.filter(
      (component) => component.type !== ComponentType.ActionRow,
    ),
  });
}

const attached = new WeakMap<ContainerBuilder, AttachmentBuilder[]>();

/** Files a card shows (`attachment://` media); `cardReply` sends them with the card. */
export function withFiles(container: ContainerBuilder, ...files: AttachmentBuilder[]) {
  attached.set(container, files);
  return container;
}

export function cardReply(container: ContainerBuilder, options: { ephemeral?: boolean } = {}) {
  const flags = options.ephemeral
    ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    : MessageFlags.IsComponentsV2;
  const files = attached.get(container);
  return { components: [container], flags, ...(files ? { files } : {}) } as {
    components: [ContainerBuilder];
    flags: typeof flags;
    files?: AttachmentBuilder[];
  };
}

export function errorReply(text: string) {
  return cardReply(card(accents.error, text), { ephemeral: true });
}

export function coins(amount: number): string {
  return amount.toLocaleString('en-US');
}

export function discordTime(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}
