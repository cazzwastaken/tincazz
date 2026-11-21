import { ApplicationCommandRegistries, RegisterBehavior } from '@sapphire/framework';
import { GatewayIntentBits, Partials } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createClient } from '../src/client.js';
import { testEnv } from './support/env.js';

describe('createClient', () => {
  it('registers the ping and gamba commands and ready listener', async () => {
    const client = createClient(testEnv);
    await client.stores.load();

    expect([...client.stores.get('commands').keys()]).toContain('ping');
    expect([...client.stores.get('commands').keys()]).toContain('gamba');
    expect([...client.stores.get('listeners').keys()]).toContain('ready');
  });

  it('loads both error listeners', async () => {
    const client = createClient(testEnv);
    await client.stores.load();

    const listeners = [...client.stores.get('listeners').keys()];
    expect(listeners).toContain('ChatInputCommandErrorReply');
    expect(listeners).toContain('InteractionHandlerErrorReply');
  });

  it('wires up prefix message commands', async () => {
    const client = createClient(testEnv);
    await client.stores.load();

    // Without loadMessageCommandListeners, Sapphire never turns messages into command runs.
    expect([...client.stores.get('listeners').keys()]).toContain('CoreMessageCreate');
  });

  it('requests the Server Members intent', () => {
    const client = createClient(testEnv);

    expect(client.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(true);
    expect(client.options.partials).toContain(Partials.GuildMember);
  });

  it('receives deletes of uncached messages', () => {
    expect(createClient(testEnv).options.partials).toContain(Partials.Message);
  });

  it('does not ping anyone by default', () => {
    const client = createClient(testEnv);

    expect(client.options.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('registers slash commands to GUILD_ID when set', () => {
    createClient({ ...testEnv, GUILD_ID: '123456789012345678' });

    expect(ApplicationCommandRegistries.getDefaultGuildIds()).toEqual(['123456789012345678']);
    expect(ApplicationCommandRegistries.getDefaultBehaviorWhenNotIdentical()).toBe(
      RegisterBehavior.BulkOverwrite,
    );
  });

  it('registers slash commands globally without GUILD_ID', () => {
    createClient({ ...testEnv, GUILD_ID: '123456789012345678' });
    createClient(testEnv);

    expect(ApplicationCommandRegistries.getDefaultGuildIds()).toBeFalsy();
  });
});
