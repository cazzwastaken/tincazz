import type { Db } from '../../src/db/index.js';
import { queueGiveaway, updateGiveaway } from '../../src/features/giveaways/store.js';

export function openGiveaway(
  db: Db,
  guildId: string,
  channelId: string,
  messageId: string,
  prize: string,
  hostId: string,
  endsAt: number,
  now: number,
) {
  const row = queueGiveaway(
    db,
    { guildId, channelId, creationId: messageId, prize, hostId, durationMs: 60_000 },
    now,
  );
  const opened = updateGiveaway(db, row, { status: 'open', messageId, endsAt });
  if (!opened) throw new Error('Could not open test giveaway');
  return opened;
}
