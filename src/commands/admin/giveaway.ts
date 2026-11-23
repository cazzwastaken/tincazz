import { Command } from '@sapphire/framework';
import {
  ChannelType,
  type ChatInputCommandInteraction,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import {
  activeGiveaways,
  giveaway,
  giveawayDurationHint,
  giveawayList,
  parseGiveawayDuration,
  parseGiveawayPrize,
  queueGiveaway,
} from '../../features/giveaways/index.js';

const requiredBotPermissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
];

export class GiveawayCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'giveaway',
      description: 'Host a giveaway or see what is running in this server',
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .setContexts(InteractionContextType.Guild)
        .addSubcommand((sub) =>
          sub
            .setName('create')
            .setDescription('Post a giveaway and draw one winner when it ends')
            .addStringOption((option) =>
              option
                .setName('prize')
                .setDescription('What can people win?')
                .setMinLength(1)
                .setMaxLength(giveaway.maxPrizeLength)
                .setRequired(true),
            )
            .addStringOption((option) =>
              option
                .setName('duration')
                .setDescription('How long to run, for example 12 hours, 1 day, or 30m')
                .setMinLength(1)
                .setMaxLength(giveaway.maxDurationLength)
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('list')
            .setDescription('Show the current giveaways you can access in this server')
            .addIntegerOption((option) =>
              option.setName('page').setDescription('Page to show').setMinValue(1),
            ),
        ),
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    if (interaction.options.getSubcommand() === 'list') return this.list(interaction);
    return this.create(interaction);
  }

  private list(interaction: ChatInputCommandInteraction) {
    if (!interaction.inCachedGuild()) {
      return interaction.reply({
        content: 'Run this command in a server.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const rows = activeGiveaways(this.container.db, interaction.guildId).filter((row) => {
      const channel = interaction.guild.channels.cache.get(row.channelId);
      return channel
        ?.permissionsFor(interaction.member)
        .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
    });
    const page = interaction.options.getInteger('page') ?? 1;
    return interaction.reply({
      embeds: [giveawayList(rows, page, Date.now())],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async create(interaction: ChatInputCommandInteraction) {
    const reject = (content: string) =>
      interaction.reply({ content, flags: MessageFlags.Ephemeral });
    const { channel, guildId } = interaction;
    if (
      !guildId ||
      (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement)
    ) {
      return reject('Run this command in a server text or announcement channel.');
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      return reject('You need Manage Messages in this channel to host a giveaway.');
    }
    if (!interaction.appPermissions.has(requiredBotPermissions)) {
      return reject(
        'I need View Channel, Send Messages, Embed Links, Read Message History, and Add Reactions here.',
      );
    }

    const prize = parseGiveawayPrize(interaction.options.getString('prize', true));
    if (!prize) return reject(`Enter a prize between 1 and ${giveaway.maxPrizeLength} characters.`);
    const duration = parseGiveawayDuration(interaction.options.getString('duration', true));
    if (duration === null) return reject(giveawayDurationHint);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const row = queueGiveaway(
      this.container.db,
      {
        creationId: interaction.id,
        guildId,
        channelId: channel.id,
        hostId: interaction.user.id,
        prize,
        durationMs: duration,
      },
      Date.now(),
    );
    return interaction.editReply(`Giveaway #${row.id} queued. It will open in this channel.`);
  }
}
