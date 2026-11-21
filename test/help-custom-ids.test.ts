import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeHelpId,
  encodeHelpMenuId,
  encodeHelpPageId,
  helpPages,
} from '../src/features/help/index.js';

const snowflake = fc.stringMatching(/^[0-9]{1,20}$/);

describe('help custom IDs', () => {
  it('round trips pages and the menu', () => {
    expect(encodeHelpPageId('home', '42')).toBe('hp:home:42');
    expect(decodeHelpId('hp:gamba:42')).toEqual({ kind: 'page', page: 'gamba', ownerId: '42' });
    expect(decodeHelpId(encodeHelpMenuId('42'))).toEqual({ kind: 'menu', ownerId: '42' });
  });

  it('rejects what it cannot decode', () => {
    for (const id of [
      '',
      'hp',
      'hp:home',
      'hp:home:',
      'hp:nope:1',
      'hp:home:1:x',
      'lb:cat:1',
      'hp:home:-1',
      'hp:menu:1e3',
    ]) {
      expect(decodeHelpId(id), id).toBeUndefined();
    }
  });

  it('round trips every page for any owner', () => {
    fc.assert(
      fc.property(fc.constantFrom(...helpPages), snowflake, (page, ownerId) => {
        expect(decodeHelpId(encodeHelpPageId(page, ownerId))).toEqual({
          kind: 'page',
          page,
          ownerId,
        });
        expect(decodeHelpId(encodeHelpMenuId(ownerId))).toEqual({ kind: 'menu', ownerId });
      }),
    );
  });

  it('never throws on arbitrary strings, and anything it decodes re-encodes to itself', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.constant('hp:home:1')),
        (input) => {
          const id = decodeHelpId(input);
          if (id) {
            const again =
              id.kind === 'menu'
                ? encodeHelpMenuId(id.ownerId)
                : encodeHelpPageId(id.page, id.ownerId);
            expect(again).toBe(input);
          }
        },
      ),
    );
  });
});
