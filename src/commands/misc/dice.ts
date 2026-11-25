import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import { type ChatInputCommandInteraction, InteractionContextType, type Message } from 'discord.js';
import {
  type GameSurface,
  interactionSurface,
  messageSurface,
  play,
  runAnimatedGame,
} from '../../features/animation/index.js';
import {
  type DiceCall,
  decodeCall,
  defaultCall,
  diceErrorText,
  diceUsage,
  parseDiceArgs,
  rollFrames,
  rollResult,
  settleRoll,
} from '../../features/dice/index.js';
import { gameChannelDenied } from '../../features/settings/index.js';
import { errorReply } from '../../features/ui/index.js';

/** The `on` choices: the label and the call code it stands for. */
const callChoices = [
  { name: 'High', value: 'h' },
  { name: 'Low', value: 'l' },
  { name: 'Seven', value: '7' },
  { name: 'Doubles', value: 'd' },
  ...[2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((total) => ({
    name: `Exact ${total}`,
    value: `e${total}`,
  })),
];

export class DiceCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'dice',
      description: 'Roll two dice for coins',
      aliases: ['roll'],
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
            .setDescription('Coins to bet: 10 to 10,000, all, half or 2.5k (default: 10)'),
        )
        .addStringOption((option) =>
          option
            .setName('on')
            .setDescription('Your call (default: high)')
            .addChoices(...callChoices),
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
    const surface = messageSurface(message);
    const parsed = parseDiceArgs(rest.split(/\s+/));
    if (parsed === undefined) {
      return surface.error(diceUsage);
    }
    return this.roll(surface, parsed.bet, parsed.call);
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
    const code = interaction.options.getString('on');
    const call = (code === null ? undefined : decodeCall(code)) ?? defaultCall;
    return this.roll(interactionSurface(interaction), bet, call);
  }

  /** Settles the roll (coins move before the first frame), then animates to the result. */
  private async roll(surface: GameSurface, bet: string | undefined, call: DiceCall) {
    const { userId, guildId } = surface;
    return runAnimatedGame({
      settle: () => settleRoll(this.container.db, { guildId, userId, bet, call }, Date.now()),
      errorText: diceErrorText,
      reject: (text) => surface.error(text),
      show: async (roll) =>
        play(surface.display, await rollFrames(userId, roll), await rollResult(userId, roll), {
          channelId: surface.channelId,
        }),
    });
  }
}
