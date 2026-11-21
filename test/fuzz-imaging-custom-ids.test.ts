import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeCaptionModalId, encodeCaptionModalId } from '../src/features/imaging/index.js';

const snowflake = fc.stringMatching(/^[0-9]{17,20}$/);

describe('caption modal custom IDs', () => {
  it('round-trips every valid message ID', () => {
    fc.assert(
      fc.property(snowflake, (id) => {
        expect(decodeCaptionModalId(encodeCaptionModalId(id))).toBe(id);
      }),
    );
  });

  it('never throws and returns a snowflake or null for any string', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const decoded = decodeCaptionModalId(raw);
        expect(decoded === null || /^[0-9]{17,20}$/.test(decoded)).toBe(true);
      }),
    );
  });

  it('decodes only what it encodes', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const decoded = decodeCaptionModalId(raw);
        if (decoded !== null) expect(encodeCaptionModalId(decoded)).toBe(raw);
      }),
    );
  });

  it('refuses near misses', () => {
    for (const raw of [
      '',
      'cap:',
      'cap:1234567890123456',
      'cap:123456789012345678901',
      'cap:40000000000000000a',
      'cap:400000000000000000:1',
      'hp:400000000000000000',
      'CAP:400000000000000000',
      ' cap:400000000000000000',
      'cap:٤٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠',
    ]) {
      expect(decodeCaptionModalId(raw)).toBeNull();
    }
  });
});
