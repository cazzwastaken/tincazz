import { describe, expect, it } from 'vitest';
import { pollCard, pollCardHash } from '../src/features/poll/cards.js';
import type { Poll } from '../src/features/poll/types.js';

const base: Poll = {
  id: 3,
  guildId: '111111111111111111',
  channelId: '2',
  messageId: '3',
  creationId: 'c',
  hostId: '222222222222222222',
  question: 'Dinner?',
  options: ['Tacos', 'Pizza'],
  yesNo: false,
  anonymous: false,
  endsAt: 1_800_000_000_000,
  status: 'open',
  closedBy: null,
  closedAt: null,
  nextSyncAt: null,
  accessFailures: 0,
  lastRenderedHash: null,
  lastRecountAt: null,
};

const text = (poll: Poll, counts: number[]) => JSON.stringify(pollCard(poll, counts).toJSON());

describe('poll cards', () => {
  it('shows an open card with the Close poll button', () => {
    const json = text(base, [2, 1]);
    expect(json).toContain('<@222222222222222222> asks');
    expect(json).toContain('Dinner?');
    expect(json).toContain('poll:close:111111111111111111:3');
    expect(json).toContain('3 votes');
    expect(json).toContain('closes <t:1800000000:R>');
    expect(json).toContain('👑');
  });

  it('renders yes/no with the split bar', () => {
    const json = text({ ...base, yesNo: true, options: ['Yes', 'No'] }, [3, 1]);
    expect(json).toContain('🟩');
    expect(json).toContain('🟥');
    expect(json).not.toContain('1️⃣');
  });

  it('marks anonymous polls', () => {
    expect(text({ ...base, anonymous: true }, [0, 0])).toContain('voter names are never shown');
    expect(text(base, [0, 0])).not.toContain('voter names');
  });

  it('closes with a winner banner and no button', () => {
    const closed = {
      ...base,
      status: 'closed' as const,
      closedAt: 1_700_000_000_000,
      closedBy: '9',
    };
    const json = text(closed, [4, 1]);
    expect(json).toContain('Poll closed');
    expect(json).toContain('**Tacos** wins by 3');
    expect(json).toContain('closed <t:1700000000:R> by <@9>');
    expect(json).not.toContain('poll:close');
  });

  it('reports ties and empty polls', () => {
    const closed = { ...base, status: 'closed' as const };
    expect(text(closed, [2, 2])).toContain('tie');
    expect(text(closed, [0, 0])).toContain('No votes were cast');
  });

  it('escapes markdown in the question', () => {
    expect(text({ ...base, question: '**hi**' }, [0, 0])).toContain('\\\\*\\\\*hi');
  });

  it('hashes by what the card shows', () => {
    expect(pollCardHash(base, [1, 2])).toBe(pollCardHash(base, [1, 2]));
    expect(pollCardHash(base, [1, 2])).not.toBe(pollCardHash(base, [2, 1]));
    expect(pollCardHash(base, [1, 2])).not.toBe(
      pollCardHash({ ...base, status: 'closed' }, [1, 2]),
    );
  });
});
