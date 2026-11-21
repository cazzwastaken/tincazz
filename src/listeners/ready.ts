import { Listener } from '@sapphire/framework';
import type { Client } from 'discord.js';
import { parseEnv } from '../config/env.js';
import { ensureAllCards } from '../features/honeypot/index.js';
import { createMemberReconcileJob } from '../features/members/job.js';
import { startPresence } from '../features/presence/index.js';
import { startJobs } from '../features/scheduler/index.js';

export class ReadyListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { once: true, event: 'clientReady' });
  }

  public override run(client: Client<true>) {
    this.container.logger.info(
      `Logged in as ${client.user.tag} (${client.guilds.cache.size} guilds)`,
    );
    const env = parseEnv(process.env);
    startPresence(client, env.GUILD_ID);
    startJobs(client, [createMemberReconcileJob(env.GUILD_ID)]);
    void ensureAllCards();
  }
}
