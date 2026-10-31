import { type Args, Command } from '@sapphire/framework';
import {
  type ChatInputCommandInteraction,
  InteractionContextType,
  type Message,
  type User,
} from 'discord.js';
import {
  balanceCard,
  botsHaveNoWallets,
  coinsRank,
  findWallet,
  getOrCreateWallet,
} from '../../features/economy/index.js';
import { cardReply, errorReply } from '../../features/ui/index.js';

export class BalanceCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'balance',
      description: 'Shows how many coins you have',
      aliases: ['bal'],
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .setContexts(InteractionContextType.Guild)
        .addUserOption((option) =>
          option.setName('user').setDescription('Whose balance to show (default: you)'),
        ),
    );
  }

  public override async messageRun(message: Message, args: Args) {
    // Wallets are per guild, so there is nothing to show in a DM.
    if (!message.guildId) return;
    const target = (await args.pickResult('user')).unwrapOr(message.author);
    return message.reply(this.view(message.guildId as string, message.author, target));
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    return interaction.reply(this.view(interaction.guildId as string, interaction.user, target));
  }

  /** The balance reply, shared by `/balance` and `?balance`. Only the caller's wallet is created. */
  private view(guildId: string, caller: User, target: User) {
    const { db } = this.container;
    if (target.bot) {
      return errorReply(botsHaveNoWallets);
    }
    const wallet =
      target.id === caller.id
        ? getOrCreateWallet(db, guildId, target.id, Date.now())
        : findWallet(db, guildId, target.id);
    const rank = wallet ? coinsRank(db, guildId, target.id) : undefined;
    const summary = wallet && rank !== undefined ? { balance: wallet.balance, rank } : undefined;
    return cardReply(balanceCard(target.id, summary));
  }
}
