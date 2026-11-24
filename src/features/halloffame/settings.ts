import {
  ChannelType,
  type ChatInputCommandInteraction,
  type GuildMember,
  PermissionFlagsBits,
  type PermissionsBitField,
} from 'discord.js';
import type { Db } from '../../db/index.js';
import { isHoneypotChannel } from '../honeypot/store.js';
import type { ModEvent } from '../logs/events.js';
import { logMod } from '../logs/send.js';
import { accents, card, cardReply, errorReply } from '../ui/index.js';
import { hallIntroCard } from './cards.js';
import { hallOfFame as config } from './config.js';
import { forgetHallFailures } from './runner.js';
import {
  addHallExempt,
  hallExemptChannels,
  hallSettings,
  removeHallExempt,
  setHallChannel,
  setHallThreshold,
} from './store.js';

/** What the handlers need from the bot, passed in by the command. */
export interface HallSettingsDeps {
  db: Db;
  logger: { warn(message: string, ...rest: unknown[]): void };
}

/** The hall channel must be somewhere the bot can post cards. */
export const hallChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

/**
 * Channels that can hold messages and so be exempt. Threads are left out: a thread counts as its
 * parent, so exempting the parent (or its category) covers them.
 */
export const hallExemptChannelTypes = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildCategory,
] as const;

interface HallChannelLike {
  id: string;
  type: ChannelType;
  permissionsFor(me: GuildMember): Readonly<PermissionsBitField> | null;
}

type SendableHallChannel = HallChannelLike & { send(options: unknown): Promise<unknown> };

const requiredPermissions = [
  ['View Channel', PermissionFlagsBits.ViewChannel],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Attach Files', PermissionFlagsBits.AttachFiles],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
] as const;

const joinList = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** Why the bot cannot run the Hall of Fame in this channel, or undefined when it can. */
export function hallChannelProblem(channel: HallChannelLike, me: GuildMember): string | undefined {
  if (!hallChannelTypes.some((type) => type === channel.type)) {
    return 'Pick a text or announcement channel.';
  }
  const permissions = channel.permissionsFor(me);
  const missing = requiredPermissions
    .filter(([, bit]) => !permissions?.has(bit))
    .map(([name]) => name);
  if (missing.length > 0) {
    return `I'm missing ${joinList(missing)} in <#${channel.id}>. The Hall of Fame needs View Channel, Send Messages, Attach Files and Read Message History there.`;
  }
  return undefined;
}

export const hallHoneypotTaken = (id: string) =>
  `<#${id}> is the honeypot channel, so it can't be the Hall of Fame channel.`;
export const hallIsHoneypot = (id: string) =>
  `<#${id}> is the honeypot channel, which the Hall of Fame always ignores anyway.`;
export const hallIsHall = (id: string) =>
  `<#${id}> is the Hall of Fame channel, which the Hall of Fame always ignores anyway.`;
export const hallAlreadySet = (id: string, threshold: number) =>
  `<#${id}> is already the Hall of Fame channel with a threshold of ${threshold} people.`;
export const hallNotSet = "The Hall of Fame isn't set.";
export const hallThresholdUnchanged = (threshold: number) =>
  `The Hall of Fame threshold is already ${threshold} people.`;
export const hallThresholdRange = `The threshold must be a whole number from ${config.minThreshold} to ${config.maxThreshold}.`;

const notRetroactive =
  'This is not retroactive: it applies from the next reaction, and posts already in the hall stay. It counts different people, not reactions, and never the author or bots.';

const peopleLabel = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;

/** The list shown after an exempt change. */
function exemptSummary(ids: string[]): string {
  return ids.length === 0
    ? 'No channels are exempt.'
    : `Exempt (${ids.length}/${config.maxExemptChannels}): ${ids.map((id) => `<#${id}>`).join(', ')}.`;
}

function validThreshold(value: number | null): value is number {
  return value !== null && Number.isInteger(value);
}

function inRange(value: number): boolean {
  return value >= config.minThreshold && value <= config.maxThreshold;
}

const ephemeral = (text: string) => cardReply(card(accents.brand, text), { ephemeral: true });

/** `/settings halloffame set channel [threshold]` */
export async function hallSetCommand(
  interaction: ChatInputCommandInteraction,
  deps: HallSettingsDeps,
) {
  const channel = interaction.options.getChannel('channel', true) as unknown as SendableHallChannel;
  const asked = interaction.options.getInteger('threshold');
  const guildId = interaction.guildId as string;
  const me = interaction.guild?.members.me as GuildMember;
  const { db } = deps;

  if (asked !== null && (!validThreshold(asked) || !inRange(asked))) {
    return interaction.reply(errorReply(hallThresholdRange));
  }
  if (isHoneypotChannel(db, guildId, channel.id)) {
    return interaction.reply(errorReply(hallHoneypotTaken(channel.id)));
  }
  const current = hallSettings(db, guildId);
  const threshold = asked ?? current.threshold;

  if (current.channelId === channel.id) {
    if (threshold === current.threshold) {
      return interaction.reply(errorReply(hallAlreadySet(channel.id, current.threshold)));
    }
    // Same channel: only the threshold differs, so there is nothing to post.
    return changeThreshold(interaction, deps, current.threshold, threshold);
  }

  const problem = hallChannelProblem(channel, me);
  if (problem) return interaction.reply(errorReply(problem));

  try {
    await channel.send(cardReply(hallIntroCard(channel.id, threshold, interaction.user.id)));
  } catch (error) {
    deps.logger.warn(`Could not confirm the Hall of Fame channel ${channel.id}`, error);
    return interaction.reply(
      errorReply(`I couldn't post in <#${channel.id}>, so nothing changed.`),
    );
  }

  const now = Date.now();
  const previous = db.transaction((tx) => {
    const before = setHallChannel(tx, guildId, channel.id, now);
    if (threshold !== before.threshold) setHallThreshold(tx, guildId, threshold, now);
    return before;
  });
  // A channel that failed before (missing permissions) may work now.
  forgetHallFailures(channel.id);

  const moved = previous.channelId ? ` Posts already in <#${previous.channelId}> stay there.` : '';
  await interaction.reply(
    ephemeral(
      `Set the Hall of Fame to <#${channel.id}>: a message needs ${peopleLabel(threshold)} to be posted there.${moved} ${notRetroactive}`,
    ),
  );

  const event: ModEvent = {
    type: 'hall_set',
    actorId: interaction.user.id,
    ...(previous.channelId ? { fromChannelId: previous.channelId } : {}),
    toChannelId: channel.id,
    threshold,
  };
  void logMod(guildId, event, now);
}

async function changeThreshold(
  interaction: ChatInputCommandInteraction,
  deps: HallSettingsDeps,
  from: number,
  to: number,
) {
  const guildId = interaction.guildId as string;
  const now = Date.now();
  const previous = setHallThreshold(deps.db, guildId, to, now);
  const hint = previous.channelId
    ? ''
    : ' There is no Hall of Fame channel yet, so nothing is posted until you pick one with `/settings halloffame set`.';
  await interaction.reply(
    ephemeral(`The Hall of Fame threshold is now ${peopleLabel(to)}.${hint} ${notRetroactive}`),
  );
  void logMod(guildId, { type: 'hall_threshold', actorId: interaction.user.id, from, to }, now);
}

/** `/settings halloffame threshold count` */
export async function hallThresholdCommand(
  interaction: ChatInputCommandInteraction,
  deps: HallSettingsDeps,
) {
  const count = interaction.options.getInteger('count', true);
  if (!validThreshold(count) || !inRange(count)) {
    return interaction.reply(errorReply(hallThresholdRange));
  }
  const current = hallSettings(deps.db, interaction.guildId as string);
  if (current.threshold === count) {
    return interaction.reply(errorReply(hallThresholdUnchanged(count)));
  }
  return changeThreshold(interaction, deps, current.threshold, count);
}

/** `/settings halloffame clear` */
export async function hallClearCommand(
  interaction: ChatInputCommandInteraction,
  deps: HallSettingsDeps,
) {
  const guildId = interaction.guildId as string;
  if (!hallSettings(deps.db, guildId).channelId) {
    return interaction.reply(errorReply(hallNotSet));
  }
  const now = Date.now();
  const previous = setHallChannel(deps.db, guildId, null, now);
  await interaction.reply(
    ephemeral(
      `Cleared the Hall of Fame: nothing new is posted. Existing posts stay in <#${previous.channelId}>.`,
    ),
  );
  void logMod(
    guildId,
    {
      type: 'hall_cleared',
      actorId: interaction.user.id,
      fromChannelId: previous.channelId as string,
    },
    now,
  );
}

/** `/settings halloffame exempt channel` */
export async function hallExemptCommand(
  interaction: ChatInputCommandInteraction,
  deps: HallSettingsDeps,
) {
  const channel = interaction.options.getChannel('channel', true);
  const guildId = interaction.guildId as string;
  const { db } = deps;

  if (hallSettings(db, guildId).channelId === channel.id) {
    return interaction.reply(errorReply(hallIsHall(channel.id)));
  }
  if (isHoneypotChannel(db, guildId, channel.id)) {
    return interaction.reply(errorReply(hallIsHoneypot(channel.id)));
  }
  const now = Date.now();
  const result = addHallExempt(db, guildId, channel.id, now);
  if (result === 'exists') {
    return interaction.reply(errorReply(`<#${channel.id}> is already exempt.`));
  }
  if (result === 'full') {
    return interaction.reply(
      errorReply(`You can exempt at most ${config.maxExemptChannels} channels.`),
    );
  }
  const covers =
    channel.type === ChannelType.GuildCategory
      ? ' Its channels and their threads are skipped too.'
      : ' Its threads are skipped too.';
  await interaction.reply(
    ephemeral(
      `<#${channel.id}> is exempt: nothing from it is posted to the Hall of Fame.${covers} ${exemptSummary(hallExemptChannels(db, guildId))}`,
    ),
  );
  void logMod(
    guildId,
    { type: 'hall_exempt_added', actorId: interaction.user.id, channelId: channel.id },
    now,
  );
}

/** `/settings halloffame unexempt channel` */
export async function hallUnexemptCommand(
  interaction: ChatInputCommandInteraction,
  deps: HallSettingsDeps,
) {
  const channel = interaction.options.getChannel('channel', true);
  const guildId = interaction.guildId as string;
  if (!removeHallExempt(deps.db, guildId, channel.id)) {
    return interaction.reply(errorReply(`<#${channel.id}> isn't exempt.`));
  }
  await interaction.reply(
    ephemeral(
      `<#${channel.id}> is no longer exempt. ${exemptSummary(hallExemptChannels(deps.db, guildId))}`,
    ),
  );
  void logMod(
    guildId,
    { type: 'hall_exempt_removed', actorId: interaction.user.id, channelId: channel.id },
    Date.now(),
  );
}
