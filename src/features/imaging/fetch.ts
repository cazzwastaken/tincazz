import { limits } from './config.js';
import { ImagingError, messages } from './errors.js';
import { checkUrl, type UrlCheck } from './urls.js';

export type Fetcher = typeof fetch;
export type ImageFormat = 'gif' | 'png' | 'jpeg' | 'webp';
type Allowed = Extract<UrlCheck, { ok: true }>;

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function hasBytes(bytes: Uint8Array, expected: number[], offset = 0): boolean {
  return expected.every((byte, i) => bytes[offset + i] === byte);
}

export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  // "GIF87a" or "GIF89a"
  if (
    hasBytes(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'gif';
  }
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  // "RIFF" size "WEBP"
  if (hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }
  return null;
}

/** Release a body we will not read so the socket is not leaked. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // nothing to release if the stream is already gone
  }
}

async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await discard(response);
    throw new ImagingError(messages.tooLarge);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new ImagingError(messages.tooLarge);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * GET with manual redirects. Only the normalised `url.href` of an allowlisted check is ever
 * requested, and each hop goes back through `checkUrl`; hops of a kind not in `accept` are refused.
 */
async function get(
  start: Allowed,
  accept: Allowed['kind'],
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<Response> {
  let current = start;
  for (let hops = 0; ; hops++) {
    const response = await fetcher(current.url.href, { redirect: 'manual', signal });
    if (!redirectStatuses.has(response.status)) {
      if (!response.ok) {
        await discard(response);
        throw new ImagingError(messages.download);
      }
      return response;
    }

    await discard(response);
    const location = response.headers.get('location');
    if (!location || hops >= limits.maxRedirects) throw new ImagingError(messages.download);

    let target: string;
    try {
      target = new URL(location, current.url).href;
    } catch {
      throw new ImagingError(messages.download);
    }
    const next = checkUrl(target);
    if (!next.ok || next.kind !== accept) throw new ImagingError(messages.notAllowed);
    current = next;
  }
}

function decodeAmp(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&#38;', '&').replaceAll('&#x26;', '&');
}

function ogImage(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bproperty\s*=\s*["']og:image["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (value) return decodeAmp(value);
  }
  return null;
}

async function downloadMedia(
  check: Allowed,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<Buffer> {
  const response = await get(check, 'media', fetcher, signal);
  if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('video/')) {
    await discard(response);
    throw new ImagingError(messages.video);
  }
  const data = await readCapped(response, limits.downloadBytes);
  if (!sniffImage(data)) throw new ImagingError(messages.notImage);
  return data;
}

async function run(check: Allowed, fetcher: Fetcher, signal: AbortSignal): Promise<Buffer> {
  if (check.kind === 'media') return downloadMedia(check, fetcher, signal);

  const response = await get(check, 'tenorPage', fetcher, signal);
  const html = (await readCapped(response, limits.pageBytes)).toString('utf8');
  const image = ogImage(html);
  if (!image) throw new ImagingError(messages.download);
  const next = checkUrl(image);
  if (!next.ok || next.kind !== 'media') throw new ImagingError(messages.notAllowed);
  return downloadMedia(next, fetcher, signal);
}

/**
 * Downloads an allowlisted image (resolving a Tenor page to its og:image first). Failures are
 * `ImagingError`s with user-safe messages; an abort of the caller's own signal is rethrown as is.
 */
export async function downloadImage(
  check: Allowed,
  options: { fetch: Fetcher; signal?: AbortSignal },
): Promise<Buffer> {
  const timeout = AbortSignal.timeout(limits.downloadTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    return await run(check, options.fetch, signal);
  } catch (error) {
    if (error instanceof ImagingError) throw error;
    if (options.signal?.aborted) throw error;
    throw new ImagingError(messages.download);
  }
}
