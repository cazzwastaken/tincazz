import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import {
  addAutoRole,
  autoRoles,
  clearChannelEverywhere,
  clearJackpotRoleIf,
  jackpotRoleId,
  logChannelId,
  removeAutoRole,
  removeRoleEverywhere,
  setJackpotRole,
  setLogChannel,
} from '../src/features/settings/store.js';

describe('settings store: log channels', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('reads back a channel that was set', () => {
    expect(logChannelId(db, '1', 'economy')).toBeUndefined();
    setLogChannel(db, '1', 'economy', '50', 1);
    expect(logChannelId(db, '1', 'economy')).toBe('50');
  });

  it('returns the previous channel ID', () => {
    expect(setLogChannel(db, '1', 'mod', '50', 1)).toBeUndefined();
    expect(setLogChannel(db, '1', 'mod', '51', 2)).toBe('50');
    expect(logChannelId(db, '1', 'mod')).toBe('51');
  });

  it('clears a channel when set to null', () => {
    setLogChannel(db, '1', 'mod', '50', 1);
    expect(setLogChannel(db, '1', 'mod', null, 2)).toBe('50');
    expect(logChannelId(db, '1', 'mod')).toBeUndefined();
  });

  it('keeps kinds independent', () => {
    setLogChannel(db, '1', 'economy', '50', 1);
    setLogChannel(db, '1', 'mod', '51', 1);
    setLogChannel(db, '1', 'economy', null, 2);
    expect(logChannelId(db, '1', 'mod')).toBe('51');
  });

  it('clears a channel everywhere and reports each place', () => {
    setLogChannel(db, '1', 'economy', '50', 1);
    setLogChannel(db, '1', 'mod', '50', 1);
    setLogChannel(db, '2', 'mod', '50', 1);
    setLogChannel(db, '2', 'economy', '60', 1);
    const cleared = clearChannelEverywhere(db, '50', 5);
    expect(cleared).toHaveLength(3);
    expect(cleared).toEqual(
      expect.arrayContaining([
        { guildId: '1', kind: 'economy' },
        { guildId: '1', kind: 'mod' },
        { guildId: '2', kind: 'mod' },
      ]),
    );
    expect(logChannelId(db, '2', 'economy')).toBe('60');
    expect(logChannelId(db, '1', 'mod')).toBeUndefined();
    expect(clearChannelEverywhere(db, '50', 6)).toEqual([]);
  });
});

describe('settings store: auto-roles', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('adds once, then reports exists', () => {
    expect(addAutoRole(db, '1', '10', 'member', 1)).toBe('added');
    expect(addAutoRole(db, '1', '10', 'member', 2)).toBe('exists');
    expect(autoRoles(db, '1', 'member')).toEqual(['10']);
  });

  it('caps a target at ten roles', () => {
    for (let i = 0; i < 10; i++)
      expect(addAutoRole(db, '1', `${100 + i}`, 'member', i)).toBe('added');
    expect(addAutoRole(db, '1', '999', 'member', 50)).toBe('full');
    expect(addAutoRole(db, '1', '999', 'bot', 50)).toBe('added');
  });

  it('orders by creation time then role id', () => {
    addAutoRole(db, '1', '30', 'member', 2);
    addAutoRole(db, '1', '20', 'member', 2);
    addAutoRole(db, '1', '40', 'member', 1);
    expect(autoRoles(db, '1', 'member')).toEqual(['40', '20', '30']);
  });

  it('removes a role from one target', () => {
    addAutoRole(db, '1', '10', 'member', 1);
    expect(removeAutoRole(db, '1', '10', 'bot')).toBe(false);
    expect(removeAutoRole(db, '1', '10', 'member')).toBe(true);
    expect(autoRoles(db, '1', 'member')).toEqual([]);
  });

  it('allows the same role in both lists and removes it from both', () => {
    addAutoRole(db, '1', '5', 'member', 1);
    addAutoRole(db, '1', '5', 'bot', 1);
    expect(removeRoleEverywhere(db, '1', '5').sort()).toEqual(['bot', 'member']);
    expect(autoRoles(db, '1', 'member')).toEqual([]);
    expect(autoRoles(db, '1', 'bot')).toEqual([]);
  });
});

describe('settings store: jackpot role', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('is unset by default and reads back what was set', () => {
    expect(jackpotRoleId(db, '1')).toBeUndefined();
    expect(setJackpotRole(db, '1', '5', 1)).toBeUndefined();
    expect(jackpotRoleId(db, '1')).toBe('5');
    expect(setJackpotRole(db, '1', '6', 2)).toBe('5');
  });

  it('clears with null without touching the log channels', () => {
    setLogChannel(db, '1', 'mod', '50', 1);
    setJackpotRole(db, '1', '5', 1);
    expect(setJackpotRole(db, '1', null, 2)).toBe('5');
    expect(jackpotRoleId(db, '1')).toBeUndefined();
    expect(logChannelId(db, '1', 'mod')).toBe('50');
  });

  it('clears only when the deleted role is the jackpot role', () => {
    setJackpotRole(db, '1', '5', 1);
    expect(clearJackpotRoleIf(db, '1', '6', 2)).toBe(false);
    expect(jackpotRoleId(db, '1')).toBe('5');
    expect(clearJackpotRoleIf(db, '1', '5', 2)).toBe(true);
    expect(jackpotRoleId(db, '1')).toBeUndefined();
  });
});
