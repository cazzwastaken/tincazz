import {
  Collection,
  GuildChannel,
  type OverwriteType,
  PermissionFlagsBits,
  PermissionOverwrites,
  PermissionsBitField,
} from 'discord.js';
import { createHallDiscord } from '../../src/features/halloffame/index.js';

/**
 * A guild and channels backed by discord.js' own permission code (`GuildChannel#memberPermissions`
 * and `rolePermissions`, real `PermissionOverwrites` and `PermissionsBitField`), so a test can ask
 * "can this member really open this channel?" and compare it with what the Hall of Fame decides.
 * Only the bits that are not about permissions (the client, the REST layer) are stubbed.
 */
export const view = PermissionFlagsBits.ViewChannel;
export const guildId = '10';
export const botId = '900';

export interface RoleSpec {
  /** Whether the role itself grants View Channel at guild level. */
  view: boolean;
  admin?: boolean;
}

export interface OverwriteSpec {
  id: string;
  type: OverwriteType;
  allow?: bigint;
  deny?: bigint;
}

export function realGuild(roleSpecs: Record<string, RoleSpec>) {
  const guild: Record<string, unknown> = { id: guildId, ownerId: 'owner' };
  const makeRole = (id: string, bits: bigint, tags?: { botId: string }) => ({
    id,
    guild,
    permissions: new PermissionsBitField(bits).freeze(),
    tags,
  });
  const roles = new Collection<string, ReturnType<typeof makeRole>>();
  for (const [id, spec] of Object.entries(roleSpecs)) {
    const bits = (spec.view ? view : 0n) | (spec.admin ? PermissionFlagsBits.Administrator : 0n);
    roles.set(id, makeRole(id, bits));
  }
  if (!roles.has(guildId)) roles.set(guildId, makeRole(guildId, 0n));
  // The bot holds an administrator role of its own, as a bot with Manage Roles usually does.
  roles.set('bot-role', makeRole('bot-role', PermissionFlagsBits.Administrator, { botId }));
  const member = (id: string, roleIds: string[]) => ({
    id,
    roles: {
      cache: new Collection(
        [guildId, ...roleIds].flatMap((r) => {
          const role = roles.get(r);
          return role ? [[r, role] as const] : [];
        }),
      ),
    },
  });
  const me = member(botId, ['bot-role']);
  Object.assign(guild, {
    roles: {
      cache: roles,
      everyone: roles.get(guildId),
      resolve: (x: string | { id: string }) => roles.get(typeof x === 'string' ? x : x.id) ?? null,
    },
    members: {
      me,
      resolve: (x: string | { id: string }) => {
        const id = typeof x === 'string' ? x : x.id;
        return id === botId ? me : null;
      },
    },
  });
  return { guild, member };
}

type RealGuild = ReturnType<typeof realGuild>;

// discord.js marks both as internal; the tests use them to run its real permission math.
const OverwriteClass = PermissionOverwrites as unknown as new (
  client: unknown,
  data: { id: string; type: OverwriteType; allow: string; deny: string },
  channel: GuildChannel,
) => PermissionOverwrites;

/** A text channel running the real GuildChannel permission methods. */
export function realChannel(
  { guild }: RealGuild,
  id: string,
  overwrites: OverwriteSpec[] = [],
  over: { parentId?: string; nsfw?: boolean } = {},
): GuildChannel {
  const channel = Object.create(GuildChannel.prototype) as GuildChannel;
  const client = {};
  const cache = new Collection<string, PermissionOverwrites>(
    overwrites.map((o) => [
      o.id,
      new OverwriteClass(
        client,
        { id: o.id, type: o.type, allow: String(o.allow ?? 0n), deny: String(o.deny ?? 0n) },
        channel,
      ),
    ]),
  );
  Object.assign(channel, {
    id,
    guild,
    guildId,
    type: 0,
    name: `channel-${id}`,
    nsfw: over.nsfw ?? false,
    parentId: over.parentId ?? null,
    permissionOverwrites: { cache },
    isDMBased: () => false,
    isThread: () => false,
  });
  return channel;
}

/** What discord.js says: can a member holding these roles (and @everyone) open the channel? */
export function canView(
  { member }: RealGuild,
  channel: GuildChannel,
  memberId: string,
  roleIds: string[],
): boolean {
  const internal = channel as unknown as {
    memberPermissions(who: unknown, checkAdmin: boolean): PermissionsBitField | null;
  };
  return (
    internal
      .memberPermissions(member(memberId, roleIds), true)
      ?.has(PermissionFlagsBits.ViewChannel) ?? false
  );
}

/** The facts the bot builds for each channel, through the real `createHallDiscord`. */
export async function channelFactsOf(
  { guild }: RealGuild,
  channels: Array<GuildChannel | Record<string, unknown>>,
  id: string,
) {
  const byId = new Map(channels.map((c) => [String(c.id), c]));
  const client = {
    user: { id: botId },
    guilds: { cache: new Map([[guildId, guild]]) },
    channels: { fetch: async (wanted: string) => byId.get(wanted) ?? null },
  };
  return (await createHallDiscord(client as never).channel(guildId, id)).facts;
}
