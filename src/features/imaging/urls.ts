/**
 * SSRF guard: only https URLs on a fixed host allowlist are ever fetched. Every redirect hop must
 * go back through `checkUrl`.
 */

export type UrlCheck =
  | { ok: true; url: URL; kind: 'media' | 'tenorPage' }
  | { ok: false; reason: 'invalid' | 'notAllowed' };

const exactHosts = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'media.tenor.com',
  'media1.tenor.com',
  'c.tenor.com',
  'i.giphy.com',
  'media.giphy.com',
  'tenor.com',
  'www.tenor.com',
  'giphy.com',
  'www.giphy.com',
]);

const hostPatterns = [/^images-ext-\d+\.discordapp\.net$/, /^media\d+\.giphy\.com$/];

const tenorPageHosts = new Set(['tenor.com', 'www.tenor.com']);
const giphyPageHosts = new Set(['giphy.com', 'www.giphy.com']);

const giphyPath = /^\/gifs\/(?:[^/]*-)?([A-Za-z0-9]+)\/?$/;
/** `/view/<slug>`, optionally under a locale such as `/de/` or `/en-GB/` */
const tenorPagePath = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?view\/./i;

export function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return exactHosts.has(host) || hostPatterns.some((p) => p.test(host));
}

const notAllowed = { ok: false, reason: 'notAllowed' } as const;

export function checkUrl(raw: string): UrlCheck {
  let text = raw.trim();
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1).trim();

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (url.protocol !== 'https:') return notAllowed;
  if (url.username !== '' || url.password !== '') return notAllowed;
  if (url.port !== '') return notAllowed;
  if (!isAllowedHost(url.hostname)) return notAllowed;

  if (tenorPageHosts.has(url.hostname)) {
    return tenorPagePath.test(url.pathname) ? { ok: true, url, kind: 'tenorPage' } : notAllowed;
  }

  if (giphyPageHosts.has(url.hostname)) {
    const id = giphyPath.exec(url.pathname)?.[1];
    return id
      ? { ok: true, url: new URL(`https://i.giphy.com/${id}.gif`), kind: 'media' }
      : notAllowed;
  }

  return { ok: true, url, kind: 'media' };
}

const closers: Record<string, string> = { ')': '(', ']': '[', '>': '<' };

const count = (text: string, char: string) => text.split(char).length - 1;

/** Drops sentence punctuation and closing brackets the url did not open from its end. */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1] ?? '';
    const head = url.slice(0, end);
    const opener = closers[last];
    if ('.,;:!?'.includes(last) || (opener && count(head, opener) < count(head, last))) {
      end--;
    } else {
      return head;
    }
  }
}

/** URLs in free text, in order, without trailing punctuation or an unbalanced closing bracket. */
export function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>]+/gi) ?? []).map(trimUrl);
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/**
 * Removes every occurrence of the link `target` (as {@link extractUrls} would find it, also inside
 * `<>`) from `text`, keeping the punctuation after it. Other text and links stay.
 */
export function removeUrl(text: string, target: string): string {
  return text.replace(
    /(<?)(https?:\/\/[^\s<>]+)(>?)/gi,
    (match, open: string, raw: string, close: string) => {
      if (open && close) return sameUrl(raw, target) ? '' : match;
      const url = trimUrl(raw);
      return sameUrl(url, target) ? `${open}${raw.slice(url.length)}${close}` : match;
    },
  );
}
