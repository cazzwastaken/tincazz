import { Command } from '@sapphire/framework';
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type GuildMember,
  InteractionContextType,
  PermissionFlagsBits,
  type Role,
} from 'discord.js';
import type { AutoRoleTarget } from '../../db/schema.js';
import type { ModEvent } from '../../features/logs/events.js';
import { type LogKind, logKinds, logMod, modLogCard, sendLog } from '../../features/logs/index.js';
import {
  addGameChannel,
  clearGameChannels,
  gameChannels,
  removeGameChannel,
} from '../../features/settings/game-channels.js';
import {
  botCannotAssign,
  botFacts,
  logChannelAlreadySet,
  logChannelProblem,
  moderatorPermissionProblem,
  roleFacts,
  type SettingsView,
  settingsCard,
  settingsNeedsManageServer,
  validateAutoRole,
} from '../../features/settings/index.js';
import {
  addAutoRole,
  autoRoles,
  logChannelId,
  removeAutoRole,
  setLogChannel,
} from '../../features/settings/store.js';
import { accents, card, cardReply, errorReply } from '../../features/ui/index.js';

const targetLabel: Record<AutoRoleTarget, string> = { member: 'members', bot: 'bots' };

export class SettingsCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, { name: 'settings', description: 'Configure the bot (admins)' });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    const typeOption = (o: import('discord.js').SlashCommandStringOption) =>
      o
        .setName('type')
        .setDescription('Which log')
        .setRequired(true)
        .addChoices(...logKinds.map((k) => ({ name: k, value: k })));

    const gameChannelOption = (o: import('discord.js').SlashCommandChannelOption) =>
      o
        .setName('channel')
        .setDescription('The channel')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const roleOption = (o: import('discord.js').SlashCommandRoleOption) =>
      o.setName('role').setDescription('The role').setRequired(true);
    const targetOption = (o: import('discord.js').SlashCommandStringOption) =>
      o
        .setName('target')
        .setDescription('Who gets it (default: members)')
        .addChoices({ name: 'members', value: 'member' }, { name: 'bots', value: 'bot' });

    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .setContexts(InteractionContextType.Guild)
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) => sub.setName('show').setDescription('Show the current settings'))
        .addSubcommandGroup((group) =>
          group
            .setName('logs')
            .setDescription('Log channels')
            .addSubcommand((sub) =>
              sub
                .setName('set')
                .setDescription('Send a log to a channel')
                .addStringOption(typeOption)
                .addChannelOption((o) =>
                  o
                    .setName('channel')
                    .setDescription('The channel')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
                ),
            )
            .addSubcommand((sub) =>
              sub.setName('clear').setDescription('Stop sending a log').addStringOption(typeOption),
            ),
        )
        .addSubcommandGroup((group) =>
          group
            .setName('autorole')
            .setDescription('Roles given to new joiners')
            .addSubcommand((sub) =>
              sub
                .setName('add')
                .setDescription('Give a role to new joiners')
                .addRoleOption(roleOption)
                .addStringOption(targetOption),
            )
            .addSubcommand((sub) =>
              sub
                .setName('remove')
                .setDescription('Stop giving a role to new joiners')
                .addRoleOption(roleOption)
                .addStringOption(targetOption),
            ),
        )
        .addSubcommandGroup((group) =>
          group
            .setName('games')
            .setDescription('Where gamba, coinflip and dice can be played (default: everywhere)')
            .addSubcommand((sub) =>
              sub
                .setName('allow')
                .setDescription('Allow the games in a channel (limits them to the listed channels)')
                .addChannelOption(gameChannelOption),
            )
            .addSubcommand((sub) =>
              sub
                .setName('remove')
                .setDescription('Stop allowing the games in a channel')
                .addChannelOption(gameChannelOption),
            )
            .addSubcommand((sub) =>
              sub.setName('reset').setDescription('Allow the games in every channel again'),
            ),
        ),
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    // The default member permission can be widened in Server Settings -> Integrations.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply(errorReply(settingsNeedsManageServer));
    }
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (group === 'logs' && sub === 'set') return this.logsSet(interaction);
    if (group === 'logs' && sub === 'clear') return this.logsClear(interaction);
    if (group === 'autorole' && sub === 'add') return this.autoroleAdd(interaction);
    if (group === 'autorole' && sub === 'remove') return this.autoroleRemove(interaction);
    if (group === 'games' && sub === 'allow') return this.gamesAllow(interaction);
    if (group === 'games' && sub === 'remove') return this.gamesRemove(interaction);
    if (group === 'games' && sub === 'reset') return this.gamesReset(interaction);
    if (!group && sub === 'show') return this.show(interaction);
    return interaction.reply(errorReply('Unknown subcommand.'));
  }

  private async logsSet(interaction: ChatInputCommandInteraction) {
    const kind = interaction.options.getString('type', true) as LogKind;
    const channel = interaction.options.getChannel('channel', true) as unknown as Parameters<
      typeof logChannelProblem
    >[0] & { send(options: unknown): Promise<unknown> };
    const guildId = interaction.guildId as string;
    const me = interaction.guild?.members.me as GuildMember;

    if (logChannelId(this.container.db, guildId, kind) === channel.id) {
      return interaction.reply(errorReply(logChannelAlreadySet(kind, channel.id)));
    }
    const problem = logChannelProblem(channel, me);
    if (problem) return interaction.reply(errorReply(problem));

    try {
      await channel.send(
        cardReply(
          card(
            accents.brand,
            `This channel now receives ${kind} logs. Set by <@${interaction.user.id}>.`,
          ),
        ),
      );
    } catch (error) {
      this.container.logger.warn(`Could not confirm log channel ${channel.id}`, error);
      return interaction.reply(
        errorReply(`I couldn't post in <#${channel.id}>, so nothing changed.`),
      );
    }

    const now = Date.now();
    const previous = setLogChannel(this.container.db, guildId, kind, channel.id, now);
    await interaction.reply(
      cardReply(card(accents.brand, `Set the ${kind} log to <#${channel.id}>.`), {
        ephemeral: true,
      }),
    );

    const event: ModEvent = {
      type: 'log_channel_set',
      actorId: interaction.user.id,
      kind,
      fromChannelId: previous,
      toChannelId: channel.id,
    };
    void logMod(guildId, event, now);
    if (kind === 'mod' && previous) {
      void sendLog(previous, modLogCard(event, now));
    }
  }

  private async logsClear(interaction: ChatInputCommandInteraction) {
    const kind = interaction.options.getString('type', true) as LogKind;
    const guildId = interaction.guildId as string;
    const now = Date.now();
    if (!logChannelId(this.container.db, guildId, kind)) {
      return interaction.reply(errorReply(`The ${kind} log isn't set.`));
    }
    const previous = setLogChannel(this.container.db, guildId, kind, null, now) as string;
    await interaction.reply(
      cardReply(card(accents.brand, `Cleared the ${kind} log.`), { ephemeral: true }),
    );

    const event: ModEvent = {
      type: 'log_channel_cleared',
      actorId: interaction.user.id,
      kind,
      fromChannelId: previous,
    };
    if (kind === 'economy') {
      void logMod(guildId, event, now);
    } else {
      // The mod log is now unset, so logMod would find nothing: tell the old channel directly.
      void sendLog(previous, modLogCard(event, now));
    }
  }

  private autoroleArgs(interaction: ChatInputCommandInteraction) {
    const role = interaction.options.getRole('role', true) as Role;
    const target = (interaction.options.getString('target') ?? 'member') as AutoRoleTarget;
    return { role, target, label: targetLabel[target], guildId: interaction.guildId as string };
  }

  private async autoroleAdd(interaction: ChatInputCommandInteraction) {
    const { role, target, label, guildId } = this.autoroleArgs(interaction);
    const guild = interaction.guild as NonNullable<typeof interaction.guild>;
    const invoker = interaction.member as GuildMember;
    const problem = validateAutoRole(roleFacts(role), botFacts(guild), {
      highest: invoker.roles.highest.position,
      isOwner: guild.ownerId === interaction.user.id,
    });
    if (problem) return interaction.reply(errorReply(problem));

    const now = Date.now();
    const result = addAutoRole(this.container.db, guildId, role.id, target, now);
    if (result === 'exists') {
      return interaction.reply(errorReply(`<@&${role.id}> is already an auto-role for ${label}.`));
    }
    if (result === 'full') {
      return interaction.reply(errorReply(`You can have at most 10 auto-roles for ${label}.`));
    }
    await interaction.reply(
      cardReply(card(accents.brand, `New ${label} will get <@&${role.id}>.`), { ephemeral: true }),
    );
    void logMod(
      guildId,
      { type: 'autorole_added', actorId: interaction.user.id, roleId: role.id, target },
      now,
    );
  }

  private async autoroleRemove(interaction: ChatInputCommandInteraction) {
    const { role, target, label, guildId } = this.autoroleArgs(interaction);
    if (!removeAutoRole(this.container.db, guildId, role.id, target)) {
      return interaction.reply(errorReply(`<@&${role.id}> isn't an auto-role for ${label}.`));
    }
    await interaction.reply(
      cardReply(card(accents.brand, `<@&${role.id}> is no longer given to new ${label}.`), {
        ephemeral: true,
      }),
    );
    void logMod(
      guildId,
      { type: 'autorole_removed', actorId: interaction.user.id, roleId: role.id, target },
      Date.now(),
    );
  }

  private async gamesAllow(interaction: ChatInputCommandInteraction) {
    const channel = interaction.options.getChannel('channel', true);
    const guildId = interaction.guildId as string;
    const result = addGameChannel(this.container.db, guildId, channel.id, Date.now());
    if (result === 'exists') {
      return interaction.reply(errorReply(`<#${channel.id}> is already a game channel.`));
    }
    if (result === 'full') {
      return interaction.reply(errorReply('You can list at most 25 game channels.'));
    }
    return interaction.reply(
      cardReply(
        card(
          accents.brand,
          `Games are now limited to ${gameChannels(this.container.db, guildId)
            .map((id) => `<#${id}>`)
            .join(', ')}.`,
        ),
        { ephemeral: true },
      ),
    );
  }

  private async gamesRemove(interaction: ChatInputCommandInteraction) {
    const channel = interaction.options.getChannel('channel', true);
    const guildId = interaction.guildId as string;
    if (!removeGameChannel(this.container.db, guildId, channel.id)) {
      return interaction.reply(errorReply(`<#${channel.id}> isn't a game channel.`));
    }
    const left = gameChannels(this.container.db, guildId);
    const text =
      left.length === 0
        ? `Removed <#${channel.id}>. Games can be played in every channel again.`
        : `Removed <#${channel.id}>. Games are limited to ${left.map((id) => `<#${id}>`).join(', ')}.`;
    return interaction.reply(cardReply(card(accents.brand, text), { ephemeral: true }));
  }

  private async gamesReset(interaction: ChatInputCommandInteraction) {
    const removed = clearGameChannels(this.container.db, interaction.guildId as string);
    if (removed === 0) {
      return interaction.reply(errorReply('Games are already allowed in every channel.'));
    }
    return interaction.reply(
      cardReply(card(accents.brand, 'Games can be played in every channel again.'), {
        ephemeral: true,
      }),
    );
  }

  private async show(interaction: ChatInputCommandInteraction) {
    const guild = interaction.guild;
    const guildId = interaction.guildId as string;
    const logs = {} as SettingsView['logs'];
    for (const kind of logKinds) {
      const channelId = logChannelId(this.container.db, guildId, kind);
      let problem: string | undefined;
      if (channelId) {
        const channel = guild?.channels.cache.get(channelId);
        problem = channel
          ? logChannelProblem(channel as never, guild?.members.me as GuildMember)
          : 'channel no longer exists';
      }
      logs[kind] = { channelId, problem };
    }
    const bot = guild ? botFacts(guild) : { highest: -1, canManageRoles: false };
    const roleView = (target: AutoRoleTarget) =>
      autoRoles(this.container.db, guildId, target).map((roleId) => {
        const role = guild?.roles.cache.get(roleId);
        return {
          roleId,
          problem: role
            ? (botCannotAssign(roleFacts(role), bot) ?? moderatorPermissionProblem(roleFacts(role)))
            : 'role no longer exists',
        };
      });
    return interaction.reply(
      cardReply(
        settingsCard({
          autoRoles: { member: roleView('member'), bot: roleView('bot') },
          logs,
          gameChannels: gameChannels(this.container.db, guildId),
        }),
        {
          ephemeral: true,
        },
      ),
    );
  }
}
