import { container } from '@sapphire/framework';
import { PermissionFlagsBits } from 'discord.js';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { assignAutoRoles } from '../src/features/settings/assign.js';
import { addAutoRole, setLogChannel } from '../src/features/settings/store.js';
import { testEnv } from './support/env.js';

let client: ReturnType<typeof createClient>;
let send: ReturnType<typeof vi.fn>;

beforeAll(() => {
  client = createClient(testEnv);
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
  container.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
  send = vi.fn(async () => ({}));
  client.channels.cache.set('50', { id: '50', isSendable: () => true, send } as never);
  setLogChannel(container.db, '2', 'mod', '50', 1);
});

function stubMember(isBot: boolean, add = vi.fn(async () => ({}))) {
  const roles = new Map([
    ['10', { id: '10', guild: { id: '2' }, position: 2, managed: false }],
    ['11', { id: '11', guild: { id: '2' }, position: 20, managed: false }],
    ['12', { id: '12', guild: { id: '2' }, position: 3, managed: false }],
    [
      '13',
      {
        id: '13',
        guild: { id: '2' },
        position: 3,
        managed: false,
        permissions: { bitfield: PermissionFlagsBits.BanMembers },
      },
    ],
  ]);
  for (const role of roles.values()) {
    (role as { permissions?: unknown }).permissions ??= { bitfield: 0n };
  }
  return {
    add,
    member: {
      user: { id: '7', bot: isBot },
      guild: {
        id: '2',
        roles: { cache: roles },
        members: {
          me: { roles: { highest: { position: 10 } }, permissions: { has: () => true } },
        },
      },
      roles: { add },
    } as never,
  };
}

it('gives humans the member list', async () => {
  addAutoRole(container.db, '2', '10', 'member', 1);
  addAutoRole(container.db, '2', '12', 'bot', 1);
  const { member, add } = stubMember(false);
  await assignAutoRoles(member);
  expect(add).toHaveBeenCalledWith(['10'], 'auto-role');
  expect(send).not.toHaveBeenCalled();
});

it('gives bots the bot list', async () => {
  addAutoRole(container.db, '2', '10', 'member', 1);
  addAutoRole(container.db, '2', '12', 'bot', 1);
  const { member, add } = stubMember(true);
  await assignAutoRoles(member);
  expect(add).toHaveBeenCalledWith(['12'], 'auto-role');
});

it('skips missing roles and roles above the bot, and reports them', async () => {
  addAutoRole(container.db, '2', '10', 'member', 1);
  addAutoRole(container.db, '2', '11', 'member', 2);
  addAutoRole(container.db, '2', '99', 'member', 3);
  const { member, add } = stubMember(false);
  await assignAutoRoles(member);
  expect(add).toHaveBeenCalledWith(['10'], 'auto-role');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(send).toHaveBeenCalledTimes(1);
  expect(container.logger.warn).toHaveBeenCalled();
});

it('resolves and reports every role when roles.add rejects', async () => {
  addAutoRole(container.db, '2', '10', 'member', 1);
  addAutoRole(container.db, '2', '12', 'member', 2);
  const { member } = stubMember(
    false,
    vi.fn(async () => {
      throw new Error('Missing Permissions');
    }),
  );
  await expect(assignAutoRoles(member)).resolves.toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(send).toHaveBeenCalledTimes(1);
});

it('never calls roles.add for an empty list', async () => {
  const { member, add } = stubMember(false);
  await assignAutoRoles(member);
  expect(add).not.toHaveBeenCalled();
});

it('skips an auto-role that has gained moderator permissions and reports it', async () => {
  addAutoRole(container.db, '2', '10', 'member', 1);
  addAutoRole(container.db, '2', '13', 'member', 2);
  const { member, add } = stubMember(false);
  await assignAutoRoles(member);
  expect(add).toHaveBeenCalledWith(['10'], 'auto-role');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(send.mock.calls[0])).toContain('role has moderator permissions');
});
