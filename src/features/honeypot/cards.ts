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

export const honeypotTaken = (id: string, use: 'a log channel' | 'a game channel') =>
  `<#${id}> is the honeypot channel, so it can't be ${use}.`;
export const honeypotAlreadySet = (id: string) => `<#${id}> is already the honeypot.`;
export const honeypotReposted = (id: string) => `Re-posted the honeypot card in <#${id}>.`;
export const honeypotCardCheckFailed = (id: string) =>
  `I couldn't check or re-post the honeypot card in <#${id}>. Make sure I can view, send and manage messages there.`;
export const honeypotSetReply = (id: string) =>
  `Set the honeypot to <#${id}>. Anyone without Manage Messages who posts there is softbanned.`;
export const honeypotClearedReply = 'Cleared the honeypot. The kick total is kept.';
export const honeypotNotSet = "The honeypot isn't set.";
export const honeypotPostFailed = (id: string) =>
  `I couldn't post in <#${id}>, so nothing changed.`;
