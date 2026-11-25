import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ChannelFacts, eligibility } from '../src/features/halloffame/index.js';

const id = fc.constantFrom('a', 'b', 'c', 'hall', 'pot', 'cat');
const audienceIds = fc.constantFrom('everyone', 'member', 'staff', 'user:1');
const overwrites = fc.record({
  denied: fc.uniqueArray(audienceIds, { maxLength: 4 }),
  deniedRoles: fc.uniqueArray(audienceIds, { maxLength: 3 }),
  allowedRoles: fc.uniqueArray(audienceIds, { maxLength: 3 }),
});
const facts = fc.record({
  id,
  parentId: fc.option(id, { nil: undefined }),
  categoryId: fc.option(id, { nil: undefined }),
  isThread: fc.boolean(),
  isPrivateThread: fc.boolean(),
  nsfw: fc.boolean(),
  audience: fc.option(fc.array(audienceIds, { maxLength: 4 }), { nil: undefined }),
  overwrites: fc.option(overwrites, { nil: undefined }),
}) satisfies fc.Arbitrary<ChannelFacts>;

describe('fuzz: hall of fame eligibility', () => {
  it('never allows a wider audience, NSFW to SFW or a private thread', () => {
    fc.assert(
      fc.property(
        fc.option(id, { nil: undefined }),
        fc.array(id, { maxLength: 4 }),
        fc.option(id, { nil: undefined }),
        facts,
        fc.option(facts, { nil: undefined }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 30 }),
        (hallId, exempt, honeypot, source, hall, bot, webhook, type) => {
          const result = eligibility(
            { channelId: hallId },
            exempt,
            honeypot,
            source,
            hall,
            { bot, webhook },
            type,
          );
          if (!result.ok) return;
          expect(hall).toBeDefined();
          expect(hallId).toBeDefined();
          expect(source.isPrivateThread).toBe(false);
          if (source.nsfw) expect(hall?.nsfw).toBe(true);
          // Everyone who can see the hall could already see the source, and unknowns never pass.
          expect(source.audience).toBeDefined();
          expect(hall?.audience).toBeDefined();
          for (const who of hall?.audience ?? []) expect(source.audience).toContain(who);
          // Whoever the source hides itself from (a View deny) is hidden from the hall too.
          expect(source.overwrites).toBeDefined();
          expect(hall?.overwrites).toBeDefined();
          for (const who of source.overwrites?.denied ?? []) {
            expect(hall?.overwrites?.denied).toContain(who);
          }
          // A role allow overwrite on the hall must also exist on the source when it denies a role.
          if ((source.overwrites?.deniedRoles.length ?? 0) > 0) {
            for (const who of hall?.overwrites?.allowedRoles ?? []) {
              expect(source.overwrites?.allowedRoles).toContain(who);
            }
          }
          expect(bot || webhook).toBe(false);
          expect([0, 19]).toContain(type);
          expect(source.id).not.toBe(hallId);
          expect(source.parentId).not.toBe(hallId);
          for (const blocked of exempt) {
            expect([source.id, source.parentId, source.categoryId]).not.toContain(blocked);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
