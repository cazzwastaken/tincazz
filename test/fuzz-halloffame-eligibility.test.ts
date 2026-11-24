import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ChannelFacts, eligibility } from '../src/features/halloffame/index.js';

const id = fc.constantFrom('a', 'b', 'c', 'hall', 'pot', 'cat');
const facts = fc.record({
  id,
  parentId: fc.option(id, { nil: undefined }),
  categoryId: fc.option(id, { nil: undefined }),
  isThread: fc.boolean(),
  isPrivateThread: fc.boolean(),
  nsfw: fc.boolean(),
  everyoneCanView: fc.boolean(),
}) satisfies fc.Arbitrary<ChannelFacts>;

describe('fuzz: hall of fame eligibility', () => {
  it('never allows private to public, NSFW to SFW or a private thread', () => {
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
          if (hall?.everyoneCanView) expect(source.everyoneCanView).toBe(true);
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
