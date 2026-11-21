import { type APIEmbed, type ContainerBuilder, escapeMarkdown } from 'discord.js';
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

function honeypotDmEmbed(guildName: string, description: string): APIEmbed {
  return {
    title: 'Honeypot Triggered',
    color: 0xffd400,
    description,
    thumbnail: {
      url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f36f.png',
    },
    footer: {
      text: `Automated message sent on behalf of ${guildName}. Replies are not monitored.`,
    },
  };
}

export function honeypotExemptDm(guildName: string): APIEmbed {
  return honeypotDmEmbed(
    guildName,
    `You posted in the honeypot channel in **${escapeMarkdown(guildName)}**, but you **weren't kicked** because of your server permissions.`,
  );
}

export function honeypotDm(guildName: string): APIEmbed {
  return honeypotDmEmbed(
    guildName,
    `You were **softbanned** from **${escapeMarkdown(guildName)}** for sending a message in the honeypot channel.\n\nYour account may be compromised. [Recover your account](https://support.discord.com/hc/en-us/articles/218410947-My-Discord-Account-was-Hacked-or-Compromised), change your password, enable two-factor authentication, and scan your device for malware. You may rejoin the server afterwards.`,
  );
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
