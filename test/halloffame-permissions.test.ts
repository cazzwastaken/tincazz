import { MessageType, OverwriteType } from 'discord.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { eligibility } from '../src/features/halloffame/index.js';
import {
  canView,
  channelFactsOf,
  guildId,
  type OverwriteSpec,
  realChannel,
  realGuild,
  view,
} from './support/hall-permissions.js';

const human = { bot: false, webhook: false };

async function verdict(
  setup: ReturnType<typeof realGuild>,
  source: OverwriteSpec[],
  hall: OverwriteSpec[],
) {
  const src = realChannel(setup, '20', source);
  const out = realChannel(setup, '30', hall);
  const facts = (id: string) => channelFactsOf(setup, [src, out], id);
  return eligibility(
    { channelId: '30' },
    [],
    undefined,
    await facts('20'),
    await facts('30'),
    human,
    MessageType.Default,
  );
}

const role = (id: string, over: Partial<OverwriteSpec> = {}): OverwriteSpec => ({
  id,
  type: OverwriteType.Role,
  ...over,
});
const person = (id: string, over: Partial<OverwriteSpec> = {}): OverwriteSpec => ({
  id,
  type: OverwriteType.Member,
  ...over,
});

describe('hall of fame guard with discord.js permission math', () => {
  it('refuses a member who is denied the source but can read a public hall', async () => {
    const setup = realGuild({ [guildId]: { view: true } });
    const banned = [person('5', { deny: view })];
    const source = realChannel(setup, '20', banned);
    const hall = realChannel(setup, '30');
    // The leak the guard exists to stop: user 5 cannot open #art but can open the hall.
    expect(canView(setup, source, '5', [])).toBe(false);
    expect(canView(setup, hall, '5', [])).toBe(true);
    expect(await verdict(setup, banned, [])).toEqual({ ok: false, reason: 'audience-mismatch' });
    // The same deny on the hall closes it.
    expect(await verdict(setup, banned, banned)).toEqual({ ok: true });
  });

  it('refuses a restricted role that only loses the source when combined with Member', async () => {
    // Gated server: @everyone sees nothing, Member grants View as a base permission, and the
    // source takes View away from Restricted.
    const setup = realGuild({
      [guildId]: { view: false },
      member: { view: true },
      restricted: { view: false },
    });
    const denyRestricted = [role('restricted', { deny: view })];
    const source = realChannel(setup, '20', denyRestricted);
    const hall = realChannel(setup, '30');
    expect(canView(setup, source, '5', ['member', 'restricted'])).toBe(false);
    expect(canView(setup, hall, '5', ['member', 'restricted'])).toBe(true);
    // Restricted alone is not in the hall's audience, so the allow-side check alone passes.
    const facts = await channelFactsOf(setup, [source, hall], '30');
    expect(facts.audience).toEqual(['member']);
    expect(await verdict(setup, denyRestricted, [])).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
    expect(await verdict(setup, denyRestricted, denyRestricted)).toEqual({ ok: true });
  });

  it('accepts a member allow on the hall in a default server, where everyone sees the source', async () => {
    const setup = realGuild({ [guildId]: { view: true } });
    const named = [person('5', { allow: view })];
    const source = realChannel(setup, '20');
    const hall = realChannel(setup, '30', named);
    expect(canView(setup, hall, '5', [])).toBe(true);
    expect(canView(setup, source, '5', [])).toBe(true);
    expect(await verdict(setup, [], named)).toEqual({ ok: true });
    // A source that grants the same member by name is just as fine.
    expect(await verdict(setup, named, named)).toEqual({ ok: true });
  });

  it('still refuses a member allow on the hall when the source is gated', async () => {
    const setup = realGuild({ [guildId]: { view: false }, member: { view: true } });
    const named = [person('5', { allow: view })];
    const source = realChannel(setup, '20');
    const hall = realChannel(setup, '30', named);
    expect(canView(setup, hall, '5', [])).toBe(true);
    expect(canView(setup, source, '5', [])).toBe(false);
    expect(await verdict(setup, [], named)).toEqual({ ok: false, reason: 'audience-mismatch' });
  });

  it('still refuses a member allow on the hall when the source denies a role or the member', async () => {
    const setup = realGuild({ [guildId]: { view: true }, restricted: { view: false } });
    const named = [person('5', { allow: view })];
    const denyRole = [role('restricted', { deny: view })];
    // The member holds the restricted role: locked out of the source, let into the hall by name.
    expect(canView(setup, realChannel(setup, '20', denyRole), '5', ['restricted'])).toBe(false);
    expect(
      canView(setup, realChannel(setup, '30', [...denyRole, ...named]), '5', ['restricted']),
    ).toBe(true);
    expect(await verdict(setup, denyRole, [...denyRole, ...named])).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
    const denyMember = [person('5', { deny: view })];
    expect(await verdict(setup, denyMember, named)).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
  });

  it('treats a deny on @everyone like any other', async () => {
    const setup = realGuild({ [guildId]: { view: true }, member: { view: false } });
    const hidden = [role(guildId, { deny: view }), role('member', { allow: view })];
    expect(await verdict(setup, hidden, [])).toEqual({ ok: false, reason: 'audience-mismatch' });
    expect(await verdict(setup, hidden, hidden)).toEqual({ ok: true });
  });

  it('refuses a role the hall allows by overwrite when the source denies another role', async () => {
    // A role allow beats a role deny, so Staff + Restricted opens the hall but not the source.
    const setup = realGuild({
      [guildId]: { view: false },
      staff: { view: true },
      restricted: { view: false },
    });
    const source = [role('restricted', { deny: view })];
    const hall = [role('restricted', { deny: view }), role('staff', { allow: view })];
    const real = {
      source: realChannel(setup, '20', source),
      hall: realChannel(setup, '30', hall),
    };
    expect(canView(setup, real.source, '5', ['staff', 'restricted'])).toBe(false);
    expect(canView(setup, real.hall, '5', ['staff', 'restricted'])).toBe(true);
    expect(await verdict(setup, source, hall)).toEqual({ ok: false, reason: 'audience-mismatch' });
    // Allowed on the source too: the same members open both.
    expect(await verdict(setup, [...source, role('staff', { allow: view })], hall)).toEqual({
      ok: true,
    });
  });

  it('takes the overwrites of the parent for a thread', async () => {
    const setup = realGuild({ [guildId]: { view: true } });
    const parent = realChannel(setup, '20', [person('5', { deny: view })]);
    const thread = {
      id: '21',
      guildId,
      type: 11,
      parentId: '20',
      parent,
      name: 'thread',
      isDMBased: () => false,
      isThread: () => true,
      permissionsFor: () => ({ has: () => true }),
    };
    const hall = realChannel(setup, '30');
    const facts = (id: string) => channelFactsOf(setup, [parent, thread, hall], id);
    const source = await facts('21');
    expect(source.overwrites?.denied).toEqual(['5']);
    expect(
      eligibility(
        { channelId: '30' },
        [],
        undefined,
        source,
        await facts('30'),
        human,
        MessageType.Default,
      ),
    ).toEqual({ ok: false, reason: 'audience-mismatch' });
  });

  it('leaves the bot and administrators out of the denies', async () => {
    const setup = realGuild({ [guildId]: { view: true }, boss: { view: false, admin: true } });
    const facts = await channelFactsOf(
      setup,
      [
        realChannel(setup, '20', [
          person('900', { deny: view }),
          role('boss', { deny: view }),
          role('bot-role', { deny: view }),
        ]),
      ],
      '20',
    );
    expect(facts.overwrites).toEqual({
      denied: [],
      deniedRoles: [],
      allowedRoles: [],
      allowedMembers: [],
    });
  });

  it('never lets anyone read the hall who cannot read the source (random overwrites)', async () => {
    const roleIds = ['member', 'restricted', 'staff'] as const;
    const target = fc.constantFrom('none', 'allow', 'deny');
    const overwriteSet = fc.record({
      [guildId]: target,
      member: target,
      restricted: target,
      staff: target,
      '5': target,
    });
    const toSpecs = (set: Record<string, string>): OverwriteSpec[] =>
      Object.entries(set).flatMap(([id, kind]) =>
        kind === 'none'
          ? []
          : [
              {
                id,
                type: id === '5' ? OverwriteType.Member : OverwriteType.Role,
                ...(kind === 'allow' ? { allow: view } : { deny: view }),
              },
            ],
      );
    const baseView = fc.record({
      [guildId]: fc.boolean(),
      member: fc.boolean(),
      restricted: fc.boolean(),
      staff: fc.boolean(),
    });
    const subsets = Array.from({ length: 8 }, (_, mask) =>
      roleIds.filter((_id, index) => (mask >> index) & 1),
    );

    await fc.assert(
      fc.asyncProperty(baseView, overwriteSet, overwriteSet, async (base, src, dst) => {
        const setup = realGuild(
          Object.fromEntries(Object.entries(base).map(([id, v]) => [id, { view: v }])),
        );
        const source = realChannel(setup, '20', toSpecs(src));
        const hall = realChannel(setup, '30', toSpecs(dst));
        const facts = (id: string) => channelFactsOf(setup, [source, hall], id);
        const result = eligibility(
          { channelId: '30' },
          [],
          undefined,
          await facts('20'),
          await facts('30'),
          human,
          MessageType.Default,
        );
        if (!result.ok) return;
        for (const roles of subsets) {
          for (const id of ['5', '6']) {
            if (canView(setup, hall, id, [...roles])) {
              expect(canView(setup, source, id, [...roles])).toBe(true);
            }
          }
        }
      }),
      { numRuns: 400 },
    );
  });
});
