import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import {
  type ChatInputCommandInteraction,
  type ContainerBuilder,
  InteractionContextType,
  type Message,
} from 'discord.js';
import { end, play, stillRolling, tryBegin } from '../../features/animation/index.js';
import {
  assignJackpotRole,
  formatGambaFollowUp,
  formatGambaReply,
  type JackpotMember,
  setActiveCard,
  settleSpin,
  spin,
  spinErrorText,
  spinFrames,
} from '../../features/gamba/index.js';
import { spinLogEvent } from '../../features/logs/economy.js';
import { logEconomy } from '../../features/logs/send.js';
import { gameChannelDenied } from '../../features/settings/index.js';
import { cardReply, errorReply } from '../../features/ui/index.js';

export class GambaCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'gamba',
      description: 'Spin the gamba slot machine',
      runIn: CommandOptionsRunTypeEnum.GuildAny,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .setContexts(InteractionContextType.Guild)
        .addStringOption((option) =>
          option
            .setName('bet')
            .setDescription('Coins to bet: 1 to 10,000, all, half or 2.5k (default: 1)'),
        ),
    );
  }

  public override async messageRun(message: Message, args: Args) {
    const denied = gameChannelDenied(
      this.container.db,
      message.guildId as string,
      message.channelId,
      message.channel,
    );
    if (denied) return message.reply(denied);
    const bet = (await args.restResult('string')).unwrapOr(undefined);
    const userId = message.author.id;
    if (!tryBegin(userId)) return message.reply(stillRolling);
    try {
      const { played, roleAssigned, jackpotRoleId } = await settleSpin(
        this.container.db,
        { guildId: message.guildId as string, userId, bet },
        Date.now(),
        { assignJackpotRole: (roleId) => assignJackpotRole(message.member, userId, roleId) },
      );
      const sent = await message.reply({
        content: formatGambaReply(played),
        allowedMentions: { repliedUser: true },
      });
      const event = spinLogEvent(userId, played, roleAssigned);
      if (event) void logEconomy(message.guildId as string, event);
      const followUp = formatGambaFollowUp(
        message.author.toString(),
        played,
        roleAssigned,
        jackpotRoleId,
      );
      await this.announce(userId, followUp !== undefined, () =>
        sent.reply({ content: followUp, allowedMentions: { users: [userId] } }),
      );
    } catch (error) {
      const text = spinErrorText(error);
      if (text === undefined) {
        throw error;
      }
      await message.reply(text);
    } finally {
      end(userId);
    }
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    const denied = gameChannelDenied(
      this.container.db,
      interaction.guildId as string,
      interaction.channelId,
      interaction.channel,
    );
    if (denied) return interaction.reply(errorReply(denied));
    const bet = interaction.options.getString('bet') ?? undefined;
    const userId = interaction.user.id;
    const member: JackpotMember | null = interaction.inCachedGuild() ? interaction.member : null;
    if (!tryBegin(userId)) return interaction.reply(errorReply(stillRolling));
    try {
      let messages: Awaited<ReturnType<typeof spin>>;
      try {
        // Settled before the first frame: the reels below only dress up a result already decided.
        messages = await spin(
          this.container.db,
          { guildId: interaction.guildId as string, userId, bet },
          Date.now(),
          { assignJackpotRole: (roleId) => assignJackpotRole(member, userId, roleId) },
        );
      } catch (error) {
        const text = spinErrorText(error);
        if (text === undefined) {
          throw error;
        }
        return interaction.reply(errorReply(text));
      }

      let shown: Message | undefined;
      await play(
        {
          first: async (reply) => {
            const { resource } = await interaction.reply({ ...reply, withResponse: true });
            shown = resource?.message ?? undefined;
            if (shown) {
              setActiveCard(userId, shown.id);
            }
            return resource;
          },
          next: (reply) => interaction.editReply(reply),
        },
        spinFrames(userId, messages.bet),
        messages.card,
        { channelId: interaction.channelId },
      );
      const { announcement } = messages;
      await this.announce(userId, announcement !== undefined, async () => {
        await shown?.reply({
          ...cardReply(announcement as ContainerBuilder),
          allowedMentions: { users: [userId] },
        });
      });
    } finally {
      end(userId);
    }
  }

  /** Sends the announcement on its own: a failure is logged and never undoes the sent card. */
  private async announce(userId: string, hasAnnouncement: boolean, send: () => Promise<unknown>) {
    if (!hasAnnouncement) {
      return;
    }
    try {
      await send();
    } catch (error) {
      this.container.logger.error(
        `gamba: could not send the announcement for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
