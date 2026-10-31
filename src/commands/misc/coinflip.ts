import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import {
  type ChatInputCommandInteraction,
  type ContainerBuilder,
  InteractionContextType,
  type Message,
  type SlashCommandSubcommandBuilder,
} from 'discord.js';
import { type FlipSide, flipSides } from '../../db/schema.js';
import {
  type Display,
  end,
  messageDisplay,
  play,
  replyDisplay,
  stillRolling,
  tryBegin,
} from '../../features/animation/index.js';
import {
  botFlipCard,
  botFlipFrames,
  type ChallengeView,
  cannotChallengeBot,
  cannotChallengeSelf,
  challengeCard,
  challengeClosedCard,
  coinflip,
  flipErrorText,
  flipUsage,
  memberNotFound,
  parseFlipArgs,
  scheduleExpiry,
  settleBotFlip,
  wager,
} from '../../features/coinflip/index.js';
import { getOrCreateWallet } from '../../features/economy/index.js';
import { parseBet } from '../../features/gamba/index.js';
import { gameChannelDenied } from '../../features/settings/index.js';
import { cardReply, errorReply } from '../../features/ui/index.js';

/** Where a flip came from: a slash interaction or a prefix message. Both run the same bodies. */
interface FlipSurface {
  channelId: string;
  userId: string;
  guildId: string;
  /**
   * Posts a card. Mentions stay suppressed except for `mentions`, the only users it may ping.
   * Resolves to the posted message when it is known.
   */
  reply(card: ContainerBuilder, mentions?: string[]): Promise<Message | undefined>;
  /** Replaces the card posted by `reply`. */
  edit(card: ContainerBuilder): Promise<unknown>;
  /** Shows an animated game: the first card, then edits of it. */
  display: Display;
  /** Answers with an error: ephemeral for slash, plain text for prefix. */
  error(text: string): Promise<unknown>;
}

type Opponent = { id: string; bot: boolean } | null;

const mentionOnly = (mentions?: string[]) =>
  mentions ? { allowedMentions: { users: mentions } } : {};

export class CoinflipCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'coinflip',
      description: 'Flip a coin for coins',
      aliases: ['cf', 'flip'],
      runIn: CommandOptionsRunTypeEnum.GuildAny,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    const withOptions = (sub: SlashCommandSubcommandBuilder) =>
      sub
        .addStringOption((option) =>
          option
            .setName('bet')
            .setDescription('Coins to bet: 10 to 10,000, all, half or 2.5k (default: 10)'),
        )
        .addStringOption((option) =>
          option
            .setName('side')
            .setDescription('Your call (default: heads)')
            .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }),
        );

    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .setContexts(InteractionContextType.Guild)
        .addSubcommand((sub) =>
          withOptions(sub.setName('bot').setDescription('Flip against the bot')),
        )
        .addSubcommand((sub) =>
          withOptions(
            sub
              .setName('challenge')
              .setDescription('Challenge a member to a coinflip')
              .addUserOption((option) =>
                option.setName('opponent').setDescription('Who to challenge').setRequired(true),
              ),
          ),
        )
        .addSubcommand((sub) =>
          withOptions(sub.setName('open').setDescription('Open a coinflip anyone can accept')),
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
    const rest = (await args.restResult('string')).unwrapOr('');
    const surface = this.messageSurface(message);
    const parsed = parseFlipArgs(rest.split(/\s+/));
    if (parsed === undefined) {
      return surface.error(flipUsage);
    }

    try {
      if (parsed.mode === 'bot') {
        return await this.flipBot(surface, parsed.bet, parsed.side);
      }
      let opponent: Opponent = null;
      if (parsed.opponentId !== undefined) {
        // Only a member of this guild can be challenged: anyone else is never pinged.
        const member = message.guild
          ? await message.guild.members.fetch(parsed.opponentId).catch(() => null)
          : null;
        if (!member) {
          return surface.error(memberNotFound);
        }
        opponent = { id: member.id, bot: member.user.bot };
      }
      return await this.challenge(surface, parsed.mode, opponent, parsed.bet, parsed.side);
    } catch (error) {
      const text = flipErrorText(error);
      if (text === undefined) {
        throw error;
      }
      return surface.error(text);
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
    const requested = interaction.options.getString('side');
    const side: FlipSide = flipSides.find((value) => value === requested) ?? 'heads';
    const surface = this.interactionSurface(interaction);

    try {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'bot') {
        return await this.flipBot(surface, bet, side);
      }
      const mode = subcommand === 'open' ? 'open' : 'challenge';
      const user = mode === 'challenge' ? interaction.options.getUser('opponent', true) : null;
      const opponent: Opponent = user ? { id: user.id, bot: user.bot } : null;
      return await this.challenge(surface, mode, opponent, bet, side);
    } catch (error) {
      const text = flipErrorText(error);
      if (text === undefined) {
        throw error;
      }
      return surface.error(text);
    }
  }

  private interactionSurface(interaction: ChatInputCommandInteraction): FlipSurface {
    return {
      channelId: interaction.channelId,
      userId: interaction.user.id,
      guildId: interaction.guildId as string,
      reply: async (card, mentions) => {
        const { resource } = await interaction.reply({
          ...cardReply(card),
          ...mentionOnly(mentions),
          withResponse: true,
        });
        return resource?.message ?? undefined;
      },
      edit: (card) => interaction.editReply(cardReply(card)),
      display: replyDisplay(interaction),
      error: (text) => interaction.reply(errorReply(text)),
    };
  }

  private messageSurface(message: Message): FlipSurface {
    let sent: Message | undefined;
    return {
      channelId: message.channel.id,
      userId: message.author.id,
      guildId: message.guildId as string,
      reply: async (card, mentions) => {
        sent = await message.reply({ ...cardReply(card), ...mentionOnly(mentions) });
        return sent;
      },
      edit: async (card) => {
        if (!sent) {
          throw new Error('no reply to edit');
        }
        return sent.edit(cardReply(card));
      },
      display: messageDisplay(message),
      error: (text) => message.reply(text),
    };
  }

  private async flipBot(surface: FlipSurface, bet: string | undefined, side: FlipSide) {
    const { userId, guildId } = surface;
    if (!tryBegin(userId)) {
      return surface.error(stillRolling);
    }
    try {
      const flip = settleBotFlip(this.container.db, { guildId, userId, bet, side }, Date.now());
      return await play(surface.display, botFlipFrames(userId, flip), botFlipCard(userId, flip), {
        channelId: surface.channelId,
      });
    } finally {
      end(userId);
    }
  }

  private async challenge(
    surface: FlipSurface,
    mode: 'challenge' | 'open',
    opponent: Opponent,
    bet: string | undefined,
    side: FlipSide,
  ) {
    const challengerId = surface.userId;
    if (opponent?.id === challengerId) {
      return surface.error(cannotChallengeSelf);
    }
    if (opponent?.bot) {
      return surface.error(cannotChallengeBot);
    }

    // Nothing is escrowed: the stake is only checked here and debited when someone accepts.
    const now = Date.now();
    const wallet = getOrCreateWallet(this.container.db, surface.guildId, challengerId, now);
    const amount = parseBet(bet?.trim() || String(wager.defaultBet), wallet.balance, wager);
    const view: ChallengeView = {
      challengerId,
      opponentId: opponent?.id,
      bet: amount,
      side,
      expiresAt: now + coinflip.expiryMs[mode],
    };

    // Only a named opponent is pinged; an open challenge pings nobody.
    const sent = await surface.reply(challengeCard(view), opponent ? [opponent.id] : undefined);
    if (sent?.id) {
      scheduleExpiry(sent.id, view.expiresAt - now, () =>
        surface.edit(challengeClosedCard(view, 'expired')),
      );
    }
  }
}
