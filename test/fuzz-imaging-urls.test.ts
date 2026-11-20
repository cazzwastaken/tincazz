import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkUrl, isAllowedHost } from '../src/features/imaging/index.js';

describe('checkUrl properties', () => {
  it('never throws and only approves https on allowed hosts', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.webUrl(), fc.string({ unit: 'binary' })), (s) => {
        const r = checkUrl(s);
        if (r.ok) {
          expect(r.url.protocol).toBe('https:');
          expect(isAllowedHost(r.url.hostname)).toBe(true);
          expect(r.url.username).toBe('');
          expect(r.url.port).toBe('');
        }
      }),
    );
  });

  it('rejects web urls whose host is not allowed', () => {
    fc.assert(
      fc.property(
        fc.webUrl().filter((u) => !isAllowedHost(new URL(u).hostname)),
        (u) => {
          expect(checkUrl(u).ok).toBe(false);
        },
      ),
    );
  });
});
