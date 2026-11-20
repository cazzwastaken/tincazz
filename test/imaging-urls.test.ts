import { describe, expect, it } from 'vitest';
import { checkUrl, extractUrls, isAllowedHost } from '../src/features/imaging/index.js';

describe('checkUrl', () => {
  it('accepts discord cdn urls and preserves the query', () => {
    const r = checkUrl('https://cdn.discordapp.com/attachments/1/2/a.gif?ex=6a&is=6b&hm=abc&');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe('media');
      expect(r.url.search).toBe('?ex=6a&is=6b&hm=abc&');
    }
  });

  it('accepts pattern hosts', () => {
    expect(
      checkUrl('https://images-ext-1.discordapp.net/external/x/https/example.com/a.png').ok,
    ).toBe(true);
    expect(checkUrl('https://media1.tenor.com/m/abc/x.gif').ok).toBe(true);
    expect(checkUrl('https://media3.giphy.com/media/x/giphy.gif').ok).toBe(true);
  });

  it('classifies tenor pages', () => {
    for (const u of [
      'https://tenor.com/view/do-not-run-python-gif-123',
      'https://www.tenor.com/view/x-gif-1',
      'https://tenor.com/en-GB/view/x-gif-1',
      'https://tenor.com/de/view/x-gif-1',
      'https://www.tenor.com/pt-BR/view/x-gif-1',
    ]) {
      const r = checkUrl(u);
      expect(r.ok && r.kind).toBe('tenorPage');
    }
  });

  it('rejects tenor locale paths that are not a gif page', () => {
    for (const u of [
      'https://tenor.com/en-GB/view/',
      'https://tenor.com/en-GB/search/cat',
      'https://tenor.com/english/view/x-gif-1',
      'https://tenor.com/a/b/view/x-gif-1',
    ]) {
      expect(checkUrl(u)).toEqual({ ok: false, reason: 'notAllowed' });
    }
  });

  it('maps giphy pages to the direct gif', () => {
    for (const u of ['https://giphy.com/gifs/cat-funny-AbC123', 'https://giphy.com/gifs/AbC123']) {
      const r = checkUrl(u);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.kind).toBe('media');
        expect(r.url.href).toBe('https://i.giphy.com/AbC123.gif');
      }
    }
  });

  it('rejects other pages on tenor and giphy', () => {
    expect(checkUrl('https://tenor.com/search/cat')).toEqual({ ok: false, reason: 'notAllowed' });
    expect(checkUrl('https://giphy.com/search/cat').ok).toBe(false);
  });

  it('rejects disallowed urls', () => {
    for (const u of [
      'http://cdn.discordapp.com/a.png',
      'https://cdn.discordapp.com.evil.com/a.png',
      'https://cdn.discordapp.com./a.png',
      'https://CDN.DISCORDAPP.COM.evil.com/a.png',
      'https://evil.com/cdn.discordapp.com/a.png',
      'https://user@cdn.discordapp.com/a.png',
      'https://user:pw@cdn.discordapp.com/a.png',
      'https://cdn.discordapp.com:8443/a.png',
      'https://127.0.0.1/a.png',
      'https://[::1]/a.png',
      'https://localhost/a.png',
      'https://cdn.discordapp.com@evil.com/a.png',
      'https://xn--cdn-discordapp-xyz.com/a.png',
    ]) {
      expect(checkUrl(u).ok, u).toBe(false);
    }
    expect(checkUrl('http://cdn.discordapp.com/a.png')).toEqual({
      ok: false,
      reason: 'notAllowed',
    });
  });

  it('reports unparseable input as invalid', () => {
    expect(checkUrl('not a url')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkUrl('')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts uppercase hosts, whitespace and angle brackets', () => {
    expect(checkUrl('<https://media.tenor.com/a.gif>').ok).toBe(true);
    expect(checkUrl('  https://CDN.Discordapp.com/a.png ').ok).toBe(true);
    expect(checkUrl('https://cdn.discordapp.com:443/a.png').ok).toBe(true);
  });
});

describe('isAllowedHost', () => {
  it('is exact', () => {
    expect(isAllowedHost('cdn.discordapp.com')).toBe(true);
    expect(isAllowedHost('Cdn.Discordapp.com')).toBe(true);
    expect(isAllowedHost('cdn.discordapp.com.')).toBe(false);
    expect(isAllowedHost('images-ext-x.discordapp.net')).toBe(false);
    expect(isAllowedHost('media.giphy.com')).toBe(true);
  });
});

describe('extractUrls', () => {
  it('finds urls in order, including inside angle brackets', () => {
    expect(extractUrls('see <https://a.b/c> and https://d.e/f')).toEqual([
      'https://a.b/c',
      'https://d.e/f',
    ]);
    expect(extractUrls('nothing here')).toEqual([]);
  });

  it('drops trailing sentence punctuation', () => {
    for (const end of ['.', ',', ';', ':', '!', '?', '...', '?!']) {
      expect(extractUrls(`look https://media.tenor.com/a.gif${end} nice`)).toEqual([
        'https://media.tenor.com/a.gif',
      ]);
    }
  });

  it('drops an unbalanced closing bracket but keeps a balanced one', () => {
    expect(extractUrls('(see https://media.tenor.com/a.gif)')).toEqual([
      'https://media.tenor.com/a.gif',
    ]);
    expect(extractUrls('[https://media.tenor.com/a.gif].')).toEqual([
      'https://media.tenor.com/a.gif',
    ]);
    expect(extractUrls('(https://media.tenor.com/a.gif).')).toEqual([
      'https://media.tenor.com/a.gif',
    ]);
    expect(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
    expect(extractUrls('https://a.b/x[1]?q=a.b')).toEqual(['https://a.b/x[1]?q=a.b']);
  });
});
