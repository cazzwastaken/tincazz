import type { ContainerBuilder } from 'discord.js';
import { accents, card } from '../ui/index.js';
import { honeypotConfig, honeypotCopy } from './config.js';

const { emoji } = honeypotConfig;

export function honeypotWarningCard(kicks: number): ContainerBuilder {
  return card(
    accents.error,
    `## ${emoji} ${honeypotCopy.heading}`,
    honeypotCopy.body,
    `${emoji} Kicks: ${kicks.toLocaleString('en-US')}`,
  );
}

export function honeypotDm(guildName: string): string {
  return `You were softbanned from **${guildName}** because your account sent a message in a channel that catches spam bots. Your account may be compromised: change your password and turn on two-factor authentication. You may rejoin the server afterwards.`;
}
