import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApplicationCommandRegistries,
  LogLevel,
  RegisterBehavior,
  SapphireClient,
} from '@sapphire/framework';
import { GatewayIntentBits, Partials } from 'discord.js';
import type { Env } from './config/env.js';

const logLevels: Record<Env['LOG_LEVEL'], LogLevel> = {
  trace: LogLevel.Trace,
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
  fatal: LogLevel.Fatal,
};

export function createClient(env: Env) {
  // Guild commands update instantly; global ones can take up to an hour to propagate.
  ApplicationCommandRegistries.setDefaultGuildIds(env.GUILD_ID ? [env.GUILD_ID] : null);
  ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.BulkOverwrite);

  const client = new SapphireClient({
    defaultPrefix: env.COMMAND_PREFIX,
    // Required for prefix commands: this loads the listeners that turn messages into command runs.
    loadMessageCommandListeners: true,
    logger: { level: logLevels[env.LOG_LEVEL] },
    // Never ping anyone by default; a command that needs to must opt in per message.
    allowedMentions: { parse: [], repliedUser: false },
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Privileged: must also be enabled in the Developer Portal (Bot -> Message Content Intent).
      GatewayIntentBits.MessageContent,
      // Privileged: enable in the Developer Portal (Bot -> Server Members Intent). Needed for joins, leaves and member fetches.
      GatewayIntentBits.GuildMembers,
    ],
    // So guildMemberRemove fires for members that were not cached (for example after a restart),
    // and messageDelete fires for a honeypot card that is not cached (for example after a restart).
    partials: [Partials.GuildMember, Partials.Message],
  });

  // Load commands/ and listeners/ relative to this file, so it works from both src/ (tsx) and dist/.
  client.stores.registerPath(dirname(fileURLToPath(import.meta.url)));

  return client;
}
