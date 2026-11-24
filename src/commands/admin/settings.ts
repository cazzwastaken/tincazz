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
import {
  clearHoneypot,
  deleteCard,
  ensureCard,
  honeypot,
  honeypotAlreadySet,
  honeypotCardCheckFailed,
  honeypotChannelProblem,
  honeypotClearedReply,
  honeypotConflict,
  honeypotNotSet,
  honeypotPostFailed,
  honeypotReposted,
  honeypotSetReply,
  honeypotTaken,
  honeypotWarningCard,
  isHoneypotChannel,
  setHoneypot,
} from '../../features/honeypot/index.js';
import type { ModEvent } from '../../features/logs/events.js';
import { type LogKind, logKinds, logMod, modLogCard, sendLog } from '../../features/logs/index.js';
import {
  addGameChannel,
  areGameChannelsRestricted,
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
  jackpotRoleId,
  logChannelId,
  removeAutoRole,
  setJackpotRole,
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
            .setName('jackpot')
            .setDescription('The role a gamba jackpot gives')
            .addSubcommand((sub) =>
              sub
                .setName('set')
                .setDescription('Give this role to gamba jackpot winners')
                .addRoleOption(roleOption),
            )
            .addSubcommand((sub) =>
              sub.setName('clear').setDescription('Stop giving a role for gamba jackpots'),
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
                .setDescription('Remove an allowed game channel (removing the last pauses games)')
                .addChannelOption(gameChannelOption),
            )
            .addSubcommand((sub) =>
              sub.setName('reset').setDescription('Allow the games in every channel again'),
            ),
        )
        .addSubcommandGroup((group) =>
          group
            .setName('honeypot')
            .setDescription('The channel that softbans spam bots')
            .addSubcommand((sub) =>
              sub
                .setName('set')
                .setDescription('Make a channel the honeypot (posts the warning card there)')
                .addChannelOption(gameChannelOption),
            )
            .addSubcommand((sub) =>
              sub.setName('clear').setDescription('Stop using a honeypot channel'),
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
    if (group === 'jackpot' && sub === 'set') return this.jackpotSet(interaction);
    if (group === 'jackpot' && sub === 'clear') return this.jackpotClear(interaction);
    if (group === 'games' && sub === 'allow') return this.gamesAllow(interaction);
    if (group === 'games' && sub === 'remove') return this.gamesRemove(interaction);
    if (group === 'games' && sub === 'reset') return this.gamesReset(interaction);
    if (group === 'honeypot' && sub === 'set') return this.honeypotSet(interaction);
    if (group === 'honeypot' && sub === 'clear') return this.honeypotClear(interaction);
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

    if (isHoneypotChannel(this.container.db, guildId, channel.id)) {
      return interaction.reply(errorReply(honeypotTaken(channel.id, 'a log channel')));
    }
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

  private async jackpotSet(interaction: ChatInputCommandInteraction) {
    const role = interaction.options.getRole('role', true) as Role;
    const guildId = interaction.guildId as string;
    const guild = interaction.guild as NonNullable<typeof interaction.guild>;
    const invoker = interaction.member as GuildMember;
    const problem = validateAutoRole(roleFacts(role), botFacts(guild), {
      highest: invoker.roles.highest.position,
      isOwner: guild.ownerId === interaction.user.id,
    });
    if (problem) return interaction.reply(errorReply(problem));
    if (jackpotRoleId(this.container.db, guildId) === role.id) {
      return interaction.reply(errorReply(`<@&${role.id}> is already the jackpot role.`));
    }
    setJackpotRole(this.container.db, guildId, role.id, Date.now());
    return interaction.reply(
      cardReply(card(accents.brand, `Gamba jackpot winners will get <@&${role.id}>.`), {
        ephemeral: true,
      }),
    );
  }

  private async jackpotClear(interaction: ChatInputCommandInteraction) {
    const previous = setJackpotRole(
      this.container.db,
      interaction.guildId as string,
      null,
      Date.now(),
    );
    if (previous === undefined) {
      return interaction.reply(errorReply("The jackpot role isn't set."));
    }
    return interaction.reply(
      cardReply(card(accents.brand, 'Gamba jackpots no longer give a role.'), { ephemeral: true }),
    );
  }

  private async gamesAllow(interaction: ChatInputCommandInteraction) {
    const channel = interaction.options.getChannel('channel', true);
    const guildId = interaction.guildId as string;
    if (isHoneypotChannel(this.container.db, guildId, channel.id)) {
      return interaction.reply(errorReply(honeypotTaken(channel.id, 'a game channel')));
    }
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
        ? `Removed <#${channel.id}>. Games are paused until you allow a channel or use \`/settings games reset\`.`
        : `Removed <#${channel.id}>. Games are limited to ${left.map((id) => `<#${id}>`).join(', ')}.`;
    return interaction.reply(cardReply(card(accents.brand, text), { ephemeral: true }));
  }

  private async gamesReset(interaction: ChatInputCommandInteraction) {
    if (!clearGameChannels(this.container.db, interaction.guildId as string, Date.now())) {
      return interaction.reply(errorReply('Games are already allowed in every channel.'));
    }
    return interaction.reply(
      cardReply(card(accents.brand, 'Games can be played in every channel again.'), {
        ephemeral: true,
      }),
    );
  }

  private async honeypotSet(interaction: ChatInputCommandInteraction) {
    const channel = interaction.options.getChannel('channel', true) as unknown as Parameters<
      typeof honeypotChannelProblem
    >[0] & { send(options: unknown): Promise<{ id: string }> };
    const guildId = interaction.guildId as string;
    const me = interaction.guild?.members.me as GuildMember;
    const db = this.container.db;

    const conflict = honeypotConflict(db, guildId, channel.id);
    if (conflict) return interaction.reply(errorReply(conflict));
    const problem = honeypotChannelProblem(channel, me);
    if (problem) return interaction.reply(errorReply(problem));

    const current = honeypot(db, guildId);
    if (current.channelId === channel.id) {
      // Through ensureCard so the re-post is serialized with the other card refreshes.
      const result = await ensureCard(guildId);
      if (result === 'reposted') {
        return interaction.reply(
          cardReply(card(accents.brand, honeypotReposted(channel.id)), { ephemeral: true }),
        );
      }
      return interaction.reply(
        errorReply(
          result === 'failed'
            ? honeypotCardCheckFailed(channel.id)
            : honeypotAlreadySet(channel.id),
        ),
      );
    }

    let sent: { id: string };
    try {
      sent = await channel.send(cardReply(honeypotWarningCard(current.kicks)));
    } catch (error) {
      this.container.logger.warn(`Could not post the honeypot card in ${channel.id}`, error);
      return interaction.reply(errorReply(honeypotPostFailed(channel.id)));
    }

    const now = Date.now();
    const previous = setHoneypot(db, guildId, channel.id, sent.id, now);
    // After the write, so the message delete listener sees a card that is no longer stored.
    // Before the reply, so a failed reply (an expired interaction) cannot orphan the old card.
    if (previous.channelId && previous.messageId) {
      void deleteCard(previous.channelId, previous.messageId);
    }
    void logMod(
      guildId,
      {
        type: 'honeypot_set',
        actorId: interaction.user.id,
        fromChannelId: previous.channelId,
        toChannelId: channel.id,
      },
      now,
    );
    await interaction.reply(
      cardReply(card(accents.brand, honeypotSetReply(channel.id)), { ephemeral: true }),
    );
  }

  private async honeypotClear(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId as string;
    const db = this.container.db;
    if (!honeypot(db, guildId).channelId) {
      return interaction.reply(errorReply(honeypotNotSet));
    }
    const now = Date.now();
    const previous = clearHoneypot(db, guildId, now);
    if (previous.channelId && previous.messageId) {
      void deleteCard(previous.channelId, previous.messageId);
    }
    if (previous.channelId) {
      void logMod(
        guildId,
        {
          type: 'honeypot_cleared',
          actorId: interaction.user.id,
          fromChannelId: previous.channelId,
        },
        now,
      );
    }
    await interaction.reply(
      cardReply(card(accents.brand, honeypotClearedReply), { ephemeral: true }),
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
    const jackpotRole = jackpotRoleId(this.container.db, guildId);
    const jackpotRoleObject = jackpotRole ? guild?.roles.cache.get(jackpotRole) : undefined;
    const pot = honeypot(this.container.db, guildId);
    let potProblem: string | undefined;
    if (pot.channelId) {
      const channel = guild?.channels.cache.get(pot.channelId);
      potProblem = channel
        ? honeypotChannelProblem(channel as never, guild?.members.me as GuildMember)
        : 'channel no longer exists';
    }
    return interaction.reply(
      cardReply(
        settingsCard({
          jackpotRole: {
            roleId: jackpotRole,
            problem: jackpotRole
              ? jackpotRoleObject
                ? (botCannotAssign(roleFacts(jackpotRoleObject), bot) ??
                  moderatorPermissionProblem(roleFacts(jackpotRoleObject)))
                : 'role no longer exists'
              : undefined,
          },
          honeypot: { channelId: pot.channelId, kicks: pot.kicks, problem: potProblem },
          autoRoles: { member: roleView('member'), bot: roleView('bot') },
          logs,
          gameChannels: areGameChannelsRestricted(this.container.db, guildId)
            ? gameChannels(this.container.db, guildId)
            : undefined,
        }),
        {
          ephemeral: true,
        },
      ),
    );
  }
}
