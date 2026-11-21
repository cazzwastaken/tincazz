import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import {
  clearHoneypot,
  clearHoneypotChannelEverywhere,
  honeypot,
  honeypotGuilds,
  incrementKicks,
  isHoneypotChannel,
  setHoneypot,
  setHoneypotMessage,
} from '../src/features/honeypot/store.js';
import { logChannelId, setLogChannel } from '../src/features/settings/store.js';

describe('honeypot store', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('reads an unset guild as no channel and zero kicks', () => {
    expect(honeypot(db, '1')).toEqual({ channelId: undefined, messageId: undefined, kicks: 0 });
  });

  it('sets a honeypot and returns the previous state', () => {
    expect(setHoneypot(db, '1', '70', 'm1', 1)).toEqual({
      channelId: undefined,
      messageId: undefined,
      kicks: 0,
    });
    expect(honeypot(db, '1')).toEqual({ channelId: '70', messageId: 'm1', kicks: 0 });
  });

  it('keeps kicks when the honeypot moves', () => {
    setHoneypot(db, '1', '70', 'm1', 1);
    incrementKicks(db, '1', 2);
    incrementKicks(db, '1', 2);
    expect(setHoneypot(db, '1', '71', 'm2', 3)).toEqual({
      channelId: '70',
      messageId: 'm1',
      kicks: 2,
    });
    expect(honeypot(db, '1').kicks).toBe(2);
  });

  it('keeps kicks when cleared', () => {
    setHoneypot(db, '1', '70', 'm1', 1);
    incrementKicks(db, '1', 2);
    incrementKicks(db, '1', 2);
    expect(clearHoneypot(db, '1', 3)).toEqual({ channelId: '70', messageId: 'm1', kicks: 2 });
    expect(honeypot(db, '1')).toEqual({ channelId: undefined, messageId: undefined, kicks: 2 });
  });

  it('increments atomically and returns the new total', () => {
    expect(incrementKicks(db, '1', 1)).toBe(1);
    expect(incrementKicks(db, '1', 2)).toBe(2);
    expect(incrementKicks(db, '2', 3)).toBe(1);
  });

  it('stores a re-posted card only while the channel still matches', () => {
    setHoneypot(db, '1', '70', 'm1', 1);
    expect(setHoneypotMessage(db, '1', '70', 'm9', 2)).toBe(true);
    expect(setHoneypotMessage(db, '1', '71', 'm10', 3)).toBe(false);
    expect(honeypot(db, '1').messageId).toBe('m9');
  });

  it('clears a deleted channel everywhere and keeps kicks', () => {
    setHoneypot(db, '1', '70', 'm1', 1);
    setHoneypot(db, '2', '70', 'm2', 1);
    setHoneypot(db, '3', '71', 'm3', 1);
    incrementKicks(db, '1', 2);
    expect(clearHoneypotChannelEverywhere(db, '70', 5).sort()).toEqual(['1', '2']);
    expect(honeypot(db, '1')).toEqual({ channelId: undefined, messageId: undefined, kicks: 1 });
    expect(honeypot(db, '2').channelId).toBeUndefined();
    expect(honeypot(db, '3')).toEqual({ channelId: '71', messageId: 'm3', kicks: 0 });
  });

  it('knows the honeypot channel and lists guilds with one', () => {
    setHoneypot(db, '1', '70', 'm1', 1);
    setHoneypot(db, '2', '71', 'm2', 1);
    incrementKicks(db, '3', 1);
    expect(isHoneypotChannel(db, '1', '70')).toBe(true);
    expect(isHoneypotChannel(db, '1', '71')).toBe(false);
    expect(isHoneypotChannel(db, '9', '70')).toBe(false);
    expect(honeypotGuilds(db).sort((a, b) => a.guildId.localeCompare(b.guildId))).toEqual([
      { guildId: '1', channelId: '70' },
      { guildId: '2', channelId: '71' },
    ]);
  });

  it('leaves log channels alone and log changes leave kicks alone', () => {
    setLogChannel(db, '1', 'mod', '50', 1);
    setHoneypot(db, '1', '70', 'm1', 2);
    incrementKicks(db, '1', 3);
    setLogChannel(db, '1', 'mod', '51', 4);
    expect(logChannelId(db, '1', 'mod')).toBe('51');
    expect(honeypot(db, '1')).toEqual({ channelId: '70', messageId: 'm1', kicks: 1 });
  });
});
