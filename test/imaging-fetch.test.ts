import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  checkUrl,
  downloadImage,
  type Fetcher,
  limits,
  messages,
  sniffImage,
  type UrlCheck,
} from '../src/features/imaging/index.js';

const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function ok(url: string): Extract<UrlCheck, { ok: true }> {
  const check = checkUrl(url);
  if (!check.ok) throw new Error('bad test url');
  return check;
}

const media = () => ok('https://cdn.discordapp.com/attachments/1/2/a.gif');

function stub(...responses: (Response | Error)[]) {
  return vi.fn<Fetcher>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
}

const bytes = (data: Uint8Array, init?: ResponseInit) => new Response(Buffer.from(data), init);

async function message(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (e: Error) => e.message,
  );
}

function hangingFetch() {
  return vi.fn<Fetcher>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason));
      }),
  );
}

describe('sniffImage', () => {
  it('recognises the supported formats', () => {
    expect(sniffImage(Buffer.from('GIF87a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImage(Buffer.from('RIFF\x01\x02\x03\x04WEBPVP8 '))).toBe('webp');
  });

  it('rejects everything else', () => {
    expect(sniffImage(Buffer.from('<html>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF88a'))).toBeNull();
    expect(sniffImage(Buffer.from('RIFF\x01\x02\x03\x04WAVEfmt '))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });

  it('never throws and only returns known formats', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), (data) => {
        expect([null, 'gif', 'png', 'jpeg', 'webp']).toContain(sniffImage(data));
      }),
    );
  });
});

describe('downloadImage', () => {
  it('returns the exact bytes of a direct image', async () => {
    const fetch = stub(bytes(GIF, { headers: { 'content-type': 'image/gif' } }));
    const result = await downloadImage(media(), { fetch });
    expect(result.equals(GIF)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://cdn.discordapp.com/attachments/1/2/a.gif');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('follows an allowlisted redirect', async () => {
    const fetch = stub(
      new Response(null, { status: 302, headers: { location: '/other.gif' } }),
      bytes(GIF),
    );
    await downloadImage(media(), { fetch });
    expect(fetch.mock.calls[1]?.[0]).toBe('https://cdn.discordapp.com/other.gif');
  });

  it('refuses a redirect off the allowlist', async () => {
    const fetch = stub(
      new Response(null, { status: 301, headers: { location: 'https://evil.com/x.gif' } }),
    );
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.notAllowed);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to a tenor page', async () => {
    const fetch = stub(
      new Response(null, { status: 307, headers: { location: 'https://tenor.com/view/x-1' } }),
    );
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.notAllowed);
  });

  it('gives up after too many redirects', async () => {
    const hop = () => new Response(null, { status: 308, headers: { location: '/next.gif' } });
    const fetch = stub(hop(), hop(), hop(), hop(), bytes(GIF));
    expect(limits.maxRedirects).toBe(3);
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.download);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('treats a redirect without location as a failed download', async () => {
    const fetch = stub(new Response(null, { status: 302 }));
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.download);
  });

  it('rejects an oversized content-length without reading the body', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel });
    const fetch = stub(
      new Response(body, { headers: { 'content-length': String(limits.downloadBytes + 1) } }),
    );
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.tooLarge);
    expect(cancel).toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalledTimes(2);
  });

  it('cancels a body that streams past the cap', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 ** 2).fill(1);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
        if (sent > 40) controller.close();
      },
      cancel,
    });
    const fetch = stub(new Response(body));
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.tooLarge);
    expect(cancel).toHaveBeenCalled();
  });

  it('maps non-2xx to a download error', async () => {
    const fetch = stub(new Response('nope', { status: 404 }));
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.download);
  });

  it('maps a network error to a download error', async () => {
    const fetch = stub(new TypeError('fetch failed'));
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.download);
  });

  it('maps its own timeout to a download error', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    try {
      const result = await message(downloadImage(media(), { fetch: hangingFetch() }));
      expect(result).toBe(messages.download);
      expect(timeout).toHaveBeenCalledWith(limits.downloadTimeoutMs);
    } finally {
      timeout.mockRestore();
    }
  });

  it('rethrows the caller abort as is', async () => {
    const controller = new AbortController();
    const reason = new Error('job timeout');
    const pending = downloadImage(media(), {
      fetch: hangingFetch(),
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('rejects video content types', async () => {
    const fetch = stub(bytes(GIF, { headers: { 'content-type': 'video/mp4' } }));
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.video);
  });

  it('rejects a tenor mp4 as video', async () => {
    const fetch = stub(bytes(new Uint8Array(8), { headers: { 'content-type': 'video/mp4' } }));
    const check = ok('https://media.tenor.com/abc/clip.mp4');
    expect(await message(downloadImage(check, { fetch }))).toBe(messages.video);
  });

  it('rejects non-image bytes even when the type claims png', async () => {
    const fetch = stub(bytes(Buffer.from('<html>'), { headers: { 'content-type': 'image/png' } }));
    expect(await message(downloadImage(media(), { fetch }))).toBe(messages.notImage);
  });

  describe('tenor pages', () => {
    const page = ok('https://tenor.com/view/cat-gif-123');
    const html = (tag: string) => new Response(`<html><head>${tag}</head></html>`);

    it('downloads the og:image of the page', async () => {
      const fetch = stub(
        html('<meta property="og:image" content="https://media.tenor.com/abc/cat.gif">'),
        bytes(GIF),
      );
      const result = await downloadImage(page, { fetch });
      expect(result.equals(GIF)).toBe(true);
      expect(fetch.mock.calls[0]?.[0]).toBe('https://tenor.com/view/cat-gif-123');
      expect(fetch.mock.calls[1]?.[0]).toBe('https://media.tenor.com/abc/cat.gif');
    });

    it('reads reversed attributes and decodes &amp;', async () => {
      const fetch = stub(
        html(
          '<meta content="https://media.tenor.com/abc/cat.gif?a=1&amp;b=2" property="og:image"/>',
        ),
        bytes(GIF),
      );
      await downloadImage(page, { fetch });
      expect(fetch.mock.calls[1]?.[0]).toBe('https://media.tenor.com/abc/cat.gif?a=1&b=2');
    });

    it('fails without og:image', async () => {
      const fetch = stub(html('<title>x</title>'));
      expect(await message(downloadImage(page, { fetch }))).toBe(messages.download);
    });

    it('refuses an og:image off the allowlist', async () => {
      const fetch = stub(html('<meta property="og:image" content="https://evil.com/x.gif">'));
      expect(await message(downloadImage(page, { fetch }))).toBe(messages.notAllowed);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('refuses an og:image that is another tenor page', async () => {
      const fetch = stub(html('<meta property="og:image" content="https://tenor.com/view/x-1">'));
      expect(await message(downloadImage(page, { fetch }))).toBe(messages.notAllowed);
    });
  });
});
