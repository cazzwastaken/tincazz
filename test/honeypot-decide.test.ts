import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AuthorFacts,
  type BanFacts,
  banProblem,
  classifyAuthor,
} from '../src/features/honeypot/index.js';

const none: AuthorFacts = {
  isBot: false,
  isWebhook: false,
  isSystem: false,
  isSelf: false,
  isStaff: false,
  isOwner: false,
};

describe('classifyAuthor', () => {
  it('softbans a plain member', () => expect(classifyAuthor(none)).toBe('softban'));
  it.each(Object.keys(none))('ignores when %s', (flag) =>
    expect(classifyAuthor({ ...none, [flag]: true })).toBe('ignore'),
  );
  it('ignores exactly when any exempt flag is set', () =>
    fc.assert(
      fc.property(
        fc.record({
          isBot: fc.boolean(),
          isWebhook: fc.boolean(),
          isSystem: fc.boolean(),
          isSelf: fc.boolean(),
          isStaff: fc.boolean(),
          isOwner: fc.boolean(),
        }),
        (f) => classifyAuthor(f) === (Object.values(f).some(Boolean) ? 'ignore' : 'softban'),
      ),
    ));
});

const ok: BanFacts = { botCanBan: true, targetIsOwner: false, targetHighest: 7, botHighest: 8 };

describe('banProblem', () => {
  it('explains why it cannot ban', () => {
    expect(banProblem({ ...ok, botCanBan: false })).toBe('I lack Ban Members');
    expect(banProblem({ ...ok, targetIsOwner: true })).toBe('they own the server');
    expect(banProblem({ ...ok, targetHighest: 8 })).toBe('their highest role is at or above mine');
    expect(banProblem({ ...ok, targetHighest: 9 })).toBe('their highest role is at or above mine');
    expect(banProblem(ok)).toBeUndefined();
    expect(banProblem({ ...ok, targetHighest: undefined })).toBeUndefined();
  });
  it('bans only below the bot, never the owner, only with Ban Members', () =>
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.integer({ min: 0, max: 250 }), { nil: undefined }),
        fc.integer({ min: 0, max: 250 }),
        (botCanBan, targetIsOwner, targetHighest, botHighest) =>
          (banProblem({ botCanBan, targetIsOwner, targetHighest, botHighest }) === undefined) ===
          (botCanBan &&
            !targetIsOwner &&
            (targetHighest === undefined || targetHighest < botHighest)),
      ),
    ));
});
