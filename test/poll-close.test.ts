import { container } from '@sapphire/framework';
import { Events, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { encodePollCloseId } from '../src/features/poll/index.js';
import {
  castVote,
  closePollEarly,
  getPoll,
  markPollMessagesDeleted,
} from '../src/features/poll/store.js';
import {
  notYourPoll,
  pollAlreadyOver,
  pollGone,
  pollWrongMessage,
} from '../src/interaction-handlers/poll-close.js';
import { testEnv } from './support/env.js';
import { makeButton } from './support/interaction.js';
import { openPoll } from './support/polls.js';

const hour = 3_600_000;

describe('Close poll button', () => {
  let client: ReturnType<typeof createClient>;
  let db: Db;
  const now = Date.now();

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(() => {
    db = openDatabase(':memory:');
    container.db = db;
    openPoll(db, { options: ['A', 'B'], endsAt: now + hour, now, hostId: '2' });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  async function press(
    userId: string,
    permissions = 0n,
    customId?: string,
    guildId = '10',
    messageId = '30',
  ) {
    const button = makeButton(client, {
      customId: customId ?? encodePollCloseId({ guildId: '10', pollId: 1 }),
      userId,
      guildId,
      messageId,
    });
    Object.assign(button, {
      memberPermissions: new PermissionsBitField(permissions),
      deferUpdate: vi.fn(async () => undefined),
    });
    client.emit(Events.InteractionCreate, button as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return button as typeof button & { deferUpdate: ReturnType<typeof vi.fn> };
  }

  const text = (button: { reply: { mock: { calls: unknown[][] } } }) =>
    JSON.stringify(button.reply.mock.calls[0]);

  it('lets the host close it, recording who and scheduling the final edit', async () => {
    castVote(db, '10', '30', '5', 0, now);
    const button = await press('2');
    expect(button.deferUpdate).toHaveBeenCalledTimes(1);
    expect(button.reply).not.toHaveBeenCalled();
    const row = getPoll(db, '10', 1);
    expect(row).toMatchObject({ status: 'closed', closedBy: '2' });
    expect(row?.nextSyncAt).not.toBeNull();
  });

  it('lets a member with Manage Messages close it', async () => {
    const button = await press('3', PermissionFlagsBits.ManageMessages);
    expect(button.deferUpdate).toHaveBeenCalledTimes(1);
    expect(getPoll(db, '10', 1)).toMatchObject({ status: 'closed', closedBy: '3' });
  });

  it('denies a stranger privately and leaves the poll open', async () => {
    const button = await press('4', PermissionFlagsBits.SendMessages);
    expect(text(button)).toContain(notYourPoll);
    expect(button.deferUpdate).not.toHaveBeenCalled();
    expect(getPoll(db, '10', 1)?.status).toBe('open');
  });

  it('tells the presser privately when the poll is already closed', async () => {
    closePollEarly(db, '10', 1, '2', now);
    const button = await press('2');
    expect(text(button)).toContain(pollAlreadyOver);
    expect(getPoll(db, '10', 1)?.closedBy).toBe('2');
  });

  it('tells the presser privately when the poll was deleted or is unknown', async () => {
    markPollMessagesDeleted(db, '10', ['30']);
    expect(text(await press('2'))).toContain(pollGone);
    const unknown = await press('2', 0n, encodePollCloseId({ guildId: '10', pollId: 77 }));
    expect(text(unknown)).toContain(pollGone);
  });

  it("ignores undecodable IDs and another server's buttons", async () => {
    for (const customId of ['poll:close:10', 'poll:close:10:x', 'poll:close:10:1:extra']) {
      const button = await press('2', PermissionsBitField.All, customId);
      expect(button.reply).not.toHaveBeenCalled();
      expect(button.deferUpdate).not.toHaveBeenCalled();
    }
    const other = await press('2', PermissionsBitField.All, undefined, '11');
    expect(other.reply).not.toHaveBeenCalled();
    expect(other.deferUpdate).not.toHaveBeenCalled();
    expect(getPoll(db, '10', 1)?.status).toBe('open');
  });

  it('ignores a button on a message that is not the poll message', async () => {
    const button = await press('2', 0n, undefined, '10', '999');
    expect(text(button)).toContain(pollWrongMessage);
    expect(getPoll(db, '10', 1)?.status).toBe('open');
  });
});
