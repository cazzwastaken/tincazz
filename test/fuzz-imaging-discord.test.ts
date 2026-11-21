import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { interactionMentionNames } from '../src/features/imaging/index.js';

type Interaction = Parameters<typeof interactionMentionNames>[0];

const ids = ['1', '22', '333', '4444', '55555'];

const viewer = { id: 'v' };
const canView = { has: () => true };

const interaction = {
  guildId: 'g',
  user: { id: 'v' },
  guild: {
    members: {
      cache: new Map([...ids.map((id) => [id, { displayName: `m${id}` }]), ['v', viewer]] as [
        string,
        object,
      ][]),
    },
    roles: { cache: new Map(ids.map((id) => [id, { name: `r${id}` }])) },
    channels: {
      cache: new Map(
        ids.map((id) => [id, { name: `c${id}`, guildId: 'g', permissionsFor: () => canView }]),
      ),
    },
  },
  client: { users: { cache: new Map(ids.map((id) => [id, { globalName: null, username: id }])) } },
} as unknown as Interaction;

const fragment = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc
    .constantFrom(...ids, '0', '999')
    .chain((id) =>
      fc.constantFrom(
        `<@${id}>`,
        `<@!${id}>`,
        `<@&${id}>`,
        `<#${id}>`,
        `<@${id}`,
        `@${id}>`,
        `<@&`,
      ),
    ),
);
const texts = fc.array(fragment, { maxLength: 12 }).map((parts) => parts.join(''));

describe('interactionMentionNames properties', () => {
  it('never throws, whatever the text', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), texts), (text) => {
        interactionMentionNames(interaction, text);
      }),
    );
  });

  it('only returns ids that appear in the text', () => {
    fc.assert(
      fc.property(texts, (text) => {
        const names = interactionMentionNames(interaction, text);
        for (const map of [names.users, names.roles, names.channels]) {
          for (const id of map.keys()) expect(text).toContain(id);
        }
        for (const id of names.users.keys()) expect(text).toMatch(new RegExp(`<@!?${id}>`));
        for (const id of names.roles.keys()) expect(text).toContain(`<@&${id}>`);
        for (const id of names.channels.keys()) expect(text).toContain(`<#${id}>`);
      }),
    );
  });

  it('finds every known mention in the text', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ids), (id) => {
        const names = interactionMentionNames(interaction, `<@${id}> <@&${id}> <#${id}>`);
        expect(names.users.get(id)).toBe(`m${id}`);
        expect(names.roles.get(id)).toBe(`r${id}`);
        expect(names.channels.get(id)).toBe(`c${id}`);
      }),
    );
  });

  it('names no channel when the invoker cannot see any', () => {
    const blind = {
      ...interaction,
      guild: {
        ...(interaction as unknown as { guild: object }).guild,
        channels: {
          cache: new Map(
            ids.map((id) => [
              id,
              { name: `c${id}`, guildId: 'g', permissionsFor: () => ({ has: () => false }) },
            ]),
          ),
        },
      },
    } as unknown as Interaction;
    fc.assert(
      fc.property(texts, (text) => {
        expect(interactionMentionNames(blind, text).channels.size).toBe(0);
      }),
    );
  });
});
