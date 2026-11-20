import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isAllowedHost, pickSource, type SourceInputs } from '../src/features/imaging/index.js';

const urlish = fc.oneof(
  fc.string(),
  fc.webUrl(),
  fc.constantFrom(
    'https://cdn.discordapp.com/a.png',
    'https://tenor.com/view/x-gif-1',
    'https://giphy.com/gifs/x-AbC1',
    'http://cdn.discordapp.com/a.png',
    'https://cdn.discordapp.com.evil.example/a.png',
    'https://user@cdn.discordapp.com/a.png',
    '<https://media.tenor.com/a.gif>',
  ),
);
const attachment = fc.record({
  url: urlish,
  contentType: fc.option(fc.constantFrom('image/png', 'video/mp4', 'text/html', ''), {
    nil: null,
  }),
});
const reply = fc.record({
  attachments: fc.array(attachment, { maxLength: 3 }),
  embeds: fc.array(
    fc.record({
      url: fc.option(urlish, { nil: null }),
      provider: fc.option(fc.string(), { nil: null }),
      imageUrl: fc.option(urlish, { nil: null }),
      imageProxyUrl: fc.option(urlish, { nil: null }),
      thumbnailUrl: fc.option(urlish, { nil: null }),
      thumbnailProxyUrl: fc.option(urlish, { nil: null }),
      hasVideo: fc.boolean(),
    }),
    { maxLength: 3 },
  ),
  stickers: fc.array(
    fc.record({
      url: urlish,
      format: fc.constantFrom('png' as const, 'apng' as const, 'gif' as const, 'lottie' as const),
    }),
    { maxLength: 3 },
  ),
  content: fc.array(urlish, { maxLength: 4 }).map((parts) => parts.join(' ')),
});
const inputs: fc.Arbitrary<SourceInputs> = fc.record(
  { attachment, url: urlish, avatarUrl: urlish, reply },
  { requiredKeys: [] },
);

describe('pickSource properties', () => {
  it('never throws, and ok results are https on an allowed host', () => {
    fc.assert(
      fc.property(inputs, (i) => {
        const r = pickSource(i);
        if (r.ok) {
          expect(r.check.url.protocol).toBe('https:');
          expect(isAllowedHost(r.check.url.hostname)).toBe(true);
        }
      }),
    );
  });

  it('a bad url or avatar never yields ok, whatever is below it', () => {
    const bad = fc.oneof(
      fc.string({ minLength: 1 }).map((s) => `https://evil.example/${s}`),
      fc.constant('http://cdn.discordapp.com/a.png'),
      fc.constant('not a url'),
    );
    fc.assert(
      fc.property(bad, reply, fc.boolean(), (b, rep, viaUrl) => {
        const r = pickSource(
          viaUrl
            ? { url: b, avatarUrl: 'https://cdn.discordapp.com/a.png', reply: rep }
            : { avatarUrl: b, reply: rep },
        );
        expect(r.ok).toBe(false);
      }),
    );
  });
});
