# Image commands (`/bubble`, `/meme`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/bubble` and `/meme` (slash and prefix), which turn an attachment, link, avatar or
replied-to image into a GIF with a speech bubble or a white caption bar.

**Architecture:** All logic in `src/features/imaging/`, pure where possible (URL checks, source
picking, text sanitising, argument parsing, frame sampling), with a sharp pipeline over raw RGBA
frame strips (decode → bubble | caption → encode with a size ladder), a job queue, and thin
Discord adapters. Two thin commands in `src/commands/image/`, plus listeners that answer
precondition denials (cooldowns).

**Tech Stack:** TypeScript strict ESM, Node 24, Sapphire + discord.js 14, sharp 0.35 (libvips
8.18), Vitest, fast-check, Biome.

**Spec:** `docs/superpowers/specs/2026-11-20-image-commands-design.md` (read it first; its
"Engine notes" hold the verified sharp techniques). Spike reference implementation (throwaway, do
not copy wholesale, but the techniques are proven):
`/tmp/claude-1000/-data-Coding-cazzwastaken-tincazz/fea149ff-35e3-47d1-a7fd-a6bb380013d4/scratchpad/spike/lib.mjs`.

## Global Constraints

- Every commit passes `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Conventional
  Commits, imperative lower-case summary ≤ 72 chars, body ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `.js` extensions on relative imports, `import type` for types. No `console`: log through
  `container.logger`. No `process.env` reads. Dependencies only via `pnpm add`.
- Every function that parses user input gets fast-check property tests next to example tests.
- No network in tests: `fetch` is always injected. Test images are generated in-test with sharp.
- Only https URLs whose host is on the allowlist are ever fetched (SSRF guard), including every
  redirect hop.
- Caption text is Pango markup: escape `&` (first), `<`, `>` as the very last sanitising step.
- Limits (all in `src/features/imaging/config.ts`, exact values): download 25 MiB, page fetch
  2 MiB, download timeout 10 s, max redirects 3, source frame ≤ 4096×4096, source pages ≤ 1000,
  output frames ≤ 100, strip pixels ≤ 512×1024×100, working width 256–512, output ≤ 10 MiB,
  caption ≤ 200 chars and 5 lines, job timeout 20 s, concurrency 2, queue 10, cooldown 10 s.
- Output is always a `.gif` named `bubble.gif` / `meme.gif`.
- Fonts: only OFL (or similarly licensed) fonts, each committed with its licence file.

## Review Focus

1. Discord CDN attachment URLs carry signed query strings (`?ex=…&is=…&hm=…`); they must pass the
   allowlist unchanged and be fetched with the query intact. Test owned by Task 2.
2. A replied-to message whose only media is a Tenor/Giphy **gifv** embed (embed has `video` mp4
   and a page `url`) must resolve through the page URL, not be rejected as video. Test owned by
   Task 6.
3. Static input (JPEG, PNG with alpha, single-frame WebP) must yield a valid one-frame GIF, and a
   tiny input (32×32) must be upscaled to the 256 px minimum so the caption is readable. Tests
   owned by Tasks 7 and 9.
4. A GIF with more than 100 frames must keep its total duration (delays summed per sampled
   group) and its loop count. Test owned by Task 7.
5. A caption made only of a mention or emoji (`?meme <@1>`, `?meme 😂`) is not "empty" and
   renders; a caption made only of zero-width characters is empty. Test owned by Task 4.

---

## File map

| File                                                                                                                                             | Responsibility                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `assets/fonts/BarlowCondensed-Black.ttf`, `assets/fonts/NotoEmoji.ttf`, `assets/fonts/OFL-BarlowCondensed.txt`, `assets/fonts/OFL-NotoEmoji.txt` | Bundled fonts + licences                                             |
| `src/features/imaging/config.ts`                                                                                                                 | All limits and tunables                                              |
| `src/features/imaging/errors.ts`                                                                                                                 | `ImagingError` and the user-facing message copy                      |
| `src/features/imaging/fonts.ts`                                                                                                                  | Font paths, family string, one-time emoji registration               |
| `src/features/imaging/urls.ts`                                                                                                                   | Allowlist, URL classification, URL extraction                        |
| `src/features/imaging/fetch.ts`                                                                                                                  | Safe download, Tenor page resolution, magic bytes                    |
| `src/features/imaging/text.ts`                                                                                                                   | Caption sanitising and markup escaping                               |
| `src/features/imaging/args.ts`                                                                                                                   | Prefix argument parsing for `?bubble` / `?meme`                      |
| `src/features/imaging/source.ts`                                                                                                                 | Pick the image source from plain input data                          |
| `src/features/imaging/frames.ts`                                                                                                                 | `Frames` type, frame sampling, raw ↔ sharp helpers                   |
| `src/features/imaging/decode.ts`                                                                                                                 | Probe, sample, resize, to raw RGBA frames                            |
| `src/features/imaging/encode.ts`                                                                                                                 | GIF encode with tuning                                               |
| `src/features/imaging/bubble.ts`                                                                                                                 | Bubble SVG and per-frame application                                 |
| `src/features/imaging/caption.ts`                                                                                                                | Caption text render, bar, per-frame application                      |
| `src/features/imaging/render.ts`                                                                                                                 | `renderImage`: pipeline + size ladder                                |
| `src/features/imaging/jobs.ts`                                                                                                                   | Per-user lock, concurrency, queue, timeout                           |
| `src/features/imaging/discord.ts`                                                                                                                | Gather inputs / mention names from discord.js objects; reply helpers |
| `src/features/imaging/index.ts`                                                                                                                  | Public surface                                                       |
| `src/listeners/command-denied.ts`                                                                                                                | Reply to precondition denials (cooldown)                             |
| `src/commands/image/bubble.ts`, `meme.ts`                                                                                                        | Thin commands                                                        |

---

### Task 1: Foundation — sharp, fonts, config, errors, Docker

**Files:**

- Create: `assets/fonts/*` (4 files above), `src/features/imaging/{config,errors,fonts,index}.ts`
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add sharp`), `Dockerfile`
- Test: `test/imaging-fonts.test.ts`

**Interfaces:**

- Produces:
  - `config.ts`: `export const limits = { downloadBytes: 25 * 1024 ** 2, pageBytes: 2 * 1024 ** 2, downloadTimeoutMs: 10_000, maxRedirects: 3, maxSourceSide: 4096, maxSourcePages: 1000, maxFrames: 100, maxStripPixels: 512 * 1024 * 100, maxWidth: 512, minWidth: 256, outputBytes: 10 * 1024 ** 2, captionChars: 200, captionLines: 5, jobTimeoutMs: 20_000, concurrency: 2, queueSize: 10, cooldownMs: 10_000 } as const`.
  - `errors.ts`: `class ImagingError extends Error` (`name = 'ImagingError'`, message is the user-facing text) and `export const messages` with exactly these keys/copy:
    `notAllowed: 'I can only fetch images from Discord, Tenor or Giphy links.'`,
    `video: "That's a video. Use the Tenor or Giphy link for it instead."`,
    `notImage: "That doesn't look like a GIF, PNG, JPEG or WebP image."`,
    `tooLarge: 'That file is too big (over 25 MB).'`,
    `download: "I couldn't download that image."`,
    `tooManyPixels: 'That image is too large to work with.'`,
    `outputTooBig: 'The result is too big even after shrinking.'`,
    `captionTooLong: 'That caption is too long for this image.'`,
    `emptyCaption: 'Give the meme some text.'`,
    `lottie: "I can't use that kind of sticker."`,
    `busyUser: 'You already have an image in progress.'`,
    `busy: "I'm busy with other images, try again in a moment."`,
    `timeout: 'That took too long. Try a smaller image.'`,
    `noAttachFiles: 'I need the Attach Files permission in this channel.'`.
  - `fonts.ts`: `captionFontFile: string`, `emojiFontFile: string` (absolute paths via `fileURLToPath(new URL('../../../assets/fonts/<file>', import.meta.url))`), `captionFont(sizePx: number): string` returning `` `Barlow Condensed, Noto Emoji, Black ${sizePx}` ``, and `ensureFonts(): Promise<void>` which once per process renders a tiny `sharp({ text: { text: '😀', fontfile: emojiFontFile, … } })` so fontconfig registers Noto Emoji (memoised promise).
  - `index.ts`: re-exports the public surface; each later task adds its exports.

- [ ] **Step 1:** `pnpm add sharp`. Confirm `pnpm-workspace.yaml` `allowBuilds` is unchanged and `node -e "require('sharp')"` works.
- [ ] **Step 2:** Download into `assets/fonts/` from `https://github.com/google/fonts/raw/main/`: `ofl/barlowcondensed/BarlowCondensed-Black.ttf`, `ofl/barlowcondensed/OFL.txt` (→ `OFL-BarlowCondensed.txt`), `ofl/notoemoji/NotoEmoji[wght].ttf` (→ `NotoEmoji.ttf`), `ofl/notoemoji/OFL.txt` (→ `OFL-NotoEmoji.txt`). Check each licence file names the right project. Add `assets/` to Biome ignores if Biome would scan it.
- [ ] **Step 3: Failing test** `test/imaging-fonts.test.ts`:
  - `font files exist`: `existsSync(captionFontFile)` and `existsSync(emojiFontFile)` are true.
  - `captionFont uses the comma form`: `captionFont(40) === 'Barlow Condensed, Noto Emoji, Black 40'`.
  - `renders caption text with the bundled font`: after `await ensureFonts()`, `sharp({ text: { text: 'HELLO', font: captionFont(40), fontfile: captionFontFile, rgba: true, dpi: 72 } }).png().toBuffer({ resolveWithObject: true })` has `info.height` between 30 and 70 and `info.width > 60`.
  - `ensureFonts is idempotent`: two calls resolve to the same promise.
- [ ] **Step 4:** Implement config, errors, fonts, index. Run `pnpm vitest run test/imaging-fonts.test.ts` → PASS.
- [ ] **Step 5:** Dockerfile runtime stage: `RUN apk add --no-cache fontconfig` before `USER node`, and `COPY --chown=node:node assets ./assets`. Verify with `docker build -t tincazz-imaging-test .` then `docker run --rm --entrypoint node tincazz-imaging-test -e "import('sharp').then(async ({default:s})=>{const r=await s({text:{text:'OK 😀',fontfile:'/app/assets/fonts/NotoEmoji.ttf',rgba:true}}).png().toBuffer();console.log(r.length)})"` prints a number and no fontconfig error. (If Docker is unavailable, say so in the report; do not skip silently.)
- [ ] **Step 6:** Full check, then commit: `build(imaging): add sharp, bundled ofl fonts and imaging config`.

---

### Task 2: URL allowlist (`urls.ts`)

**Files:** Create `src/features/imaging/urls.ts`; Test `test/imaging-urls.test.ts`, `test/fuzz-imaging-urls.test.ts`

**Interfaces:**

- Produces:
  - `type UrlCheck = { ok: true; url: URL; kind: 'media' | 'tenorPage' } | { ok: false; reason: 'invalid' | 'notAllowed' }`
  - `isAllowedHost(hostname: string): boolean` — exact: `cdn.discordapp.com`, `media.discordapp.net`, `media.tenor.com`, `media1.tenor.com`, `c.tenor.com`, `i.giphy.com`, `media.giphy.com`, `tenor.com`, `www.tenor.com`, `giphy.com`, `www.giphy.com`; patterns: `/^images-ext-\d+\.discordapp\.net$/`, `/^media\d+\.giphy\.com$/`. Lower-cased compare; no trailing-dot or userinfo tricks pass.
  - `checkUrl(raw: string): UrlCheck` — trims, strips surrounding `<…>` (Discord's no-embed syntax), requires `https:`, no credentials, default port only, allowed host. `tenor.com/view/...` (and `www.`) → `kind: 'tenorPage'`. `giphy.com/gifs/<slug>-<id>` or `/gifs/<id>` → `{ ok: true, kind: 'media', url: https://i.giphy.com/<id>.gif }`. Other pages on `tenor.com`/`giphy.com` → `notAllowed`. Never throws.
  - `extractUrls(text: string): string[]` — every `https?://` token (also inside `<…>`), in order.

- [ ] **Step 1: Failing tests** (examples): accepts `https://cdn.discordapp.com/attachments/1/2/a.gif?ex=6a&is=6b&hm=abc&` with `url.search` preserved; accepts `https://images-ext-1.discordapp.net/external/x/https/example.com/a.png`; accepts `https://media1.tenor.com/m/abc/x.gif`; `https://tenor.com/view/do-not-run-python-gif-123` → `tenorPage`; `https://giphy.com/gifs/cat-funny-AbC123` → media `https://i.giphy.com/AbC123.gif`; rejects `http://cdn.discordapp.com/a.png` (invalid or notAllowed — assert `ok: false`), `https://cdn.discordapp.com.evil.com/a.png`, `https://evil.com/cdn.discordapp.com/a.png`, `https://user@cdn.discordapp.com/a.png`, `https://cdn.discordapp.com:8443/a.png`, `https://127.0.0.1/a.png`, `https://localhost/a.png`, `https://tenor.com/search/cat`, `not a url` (`reason: 'invalid'`); `<https://media.tenor.com/a.gif>` accepted; `extractUrls('see <https://a.b/c> and https://d.e/f')` → both.
- [ ] **Step 2: Fuzz** (`fuzz-imaging-urls.test.ts`): for `fc.string()` and `fc.webUrl()`, `checkUrl` never throws; any `ok: true` result has `url.protocol === 'https:'` and `isAllowedHost(url.hostname)`; for `fc.webUrl()` with a host not on the list (filter), result is `ok: false`.
- [ ] **Step 3:** Run → FAIL; implement; run → PASS; full check.
- [ ] **Step 4:** Commit `feat(imaging): add url allowlist for image sources`.

---

### Task 3: Safe download (`fetch.ts`)

**Files:** Create `src/features/imaging/fetch.ts`; Test `test/imaging-fetch.test.ts`

**Interfaces:**

- Consumes: `checkUrl`, `isAllowedHost` (Task 2); `limits`, `ImagingError`, `messages` (Task 1).
- Produces:
  - `type Fetcher = typeof fetch`
  - `type ImageFormat = 'gif' | 'png' | 'jpeg' | 'webp'`
  - `sniffImage(bytes: Uint8Array): ImageFormat | null` — magic bytes: `GIF87a`/`GIF89a`, `\x89PNG\r\n\x1a\n`, `FF D8 FF`, `RIFF????WEBP`.
  - `downloadImage(check: Extract<UrlCheck, { ok: true }>, options: { fetch: Fetcher; signal?: AbortSignal }): Promise<Buffer>` — for `tenorPage`, first downloads the page (text, ≤ `pageBytes`), reads `og:image` (either attribute order: `property="og:image" content="…"` or reversed, HTML-entity `&amp;` decoded), runs `checkUrl` on it (must be `ok` and `media`, else `messages.notAllowed`), then downloads that.
- Behaviour (each its own test, using a stub `fetch` returning `new Response(...)`):
  - `fetch` is called with `{ redirect: 'manual', signal }`; a 301/302/303/307/308 with `location` is resolved against the current URL and re-checked with `checkUrl`; a non-allowlisted hop → `messages.notAllowed`; more than `maxRedirects` hops → `messages.download`.
  - `content-length` over the cap → `messages.tooLarge` without reading the body; a body that streams past the cap (no content-length) → `messages.tooLarge` and the reader is cancelled.
  - Non-2xx → `messages.download`. Network error → `messages.download`. Timeout: signal combined with `AbortSignal.timeout(limits.downloadTimeoutMs)` via `AbortSignal.any`; an aborted fetch → `messages.download` when the timeout fired, rethrown as-is when the caller's signal aborted (so the job layer reports its own timeout).
  - `content-type` `video/*` → `messages.video`. Bytes whose `sniffImage` is null → `messages.notImage` (also when the content type claims `image/png`). A `.mp4` URL on Tenor that returns `video/mp4` → `messages.video`.
  - Tenor page without `og:image` → `messages.download`; `og:image` pointing to `https://evil.com/x.gif` → `messages.notAllowed`.
- [ ] **Step 1:** Write the failing tests above (`describe('downloadImage')`, `describe('sniffImage')`, one `it` per bullet; plus happy paths: direct GIF returns the exact bytes; Tenor page → media GIF, asserting the second fetch URL).
- [ ] **Step 2:** Run → FAIL; implement (stream with `response.body.getReader()`); run → PASS; full check.
- [ ] **Step 3:** Commit `feat(imaging): add allowlisted image download with size and type checks`.

---

### Task 4: Caption text (`text.ts`)

**Files:** Create `src/features/imaging/text.ts`; Test `test/imaging-text.test.ts`, `test/fuzz-imaging-text.test.ts`

**Interfaces:**

- Produces:
  - `interface MentionNames { users: ReadonlyMap<string, string>; roles: ReadonlyMap<string, string>; channels: ReadonlyMap<string, string> }` and `const noMentionNames: MentionNames` (empty maps).
  - `sanitizeCaption(raw: string, names: MentionNames): string` — steps in order: `<@id>`/`<@!id>` → `@name` (unknown → `@unknown-user`); `<@&id>` → `@rolename` (unknown → `@unknown-role`); `<#id>` → `#channel` (unknown → `#unknown-channel`); `<:name:id>`/`<a:name:id>` → `:name:`; remove `\p{Cc}` except `\n`, and `\p{Cf}` except U+200D (ZWJ, keeps emoji sequences); `\r\n` → `\n`; collapse runs of spaces/tabs to one space; trim each line; drop empty lines; keep at most `limits.captionLines` lines; trim. Throws `ImagingError(messages.emptyCaption)` when the result is empty. Does **not** escape.
  - `escapeMarkup(text: string): string` — `&`→`&amp;` first, then `<`→`&lt;`, `>`→`&gt;`.
- [ ] **Step 1: Failing examples:** mention with name map → `@bob`; `<@!1>` same; unknown → `@unknown-user`; role, channel; `<a:party:123>` → `:party:`; `'a​b'` → `'ab'`; `'👨‍👩‍👧'` unchanged (ZWJ kept); `'a   b'` → `'a b'`; 7 lines → 5; `'​​'` throws emptyCaption; `'<@1>'` alone with unknown → `@unknown-user` (not empty); `'😂'` → `'😂'`; `escapeMarkup('<span size="999999">&')` → `'&lt;span size="999999"&gt;&amp;'`.
- [ ] **Step 2: Fuzz:** for `fc.string()` (and `fc.fullUnicodeString()`), `sanitizeCaption` either throws `ImagingError` or returns text with ≤ 5 lines, no `\p{Cc}` except `\n`, no leading/trailing whitespace; `escapeMarkup(x)` contains no `<` or `>` and every `&` starts `&amp;`, `&lt;` or `&gt;`; `sanitizeCaption(sanitizeCaption(x)) === sanitizeCaption(x)` when the first call succeeds.
- [ ] **Step 3:** FAIL → implement → PASS → full check → commit `feat(imaging): add caption sanitising and markup escaping`.

---

### Task 5: Prefix arguments (`args.ts`)

**Files:** Create `src/features/imaging/args.ts`; Test `test/imaging-args.test.ts`, `test/fuzz-imaging-args.test.ts`

**Interfaces:**

- Produces:
  - `type BubbleStyle = 'transparent' | 'white'`, `type TailSide = 'left' | 'right'`
  - `interface BubbleArgs { style: BubbleStyle; tail: TailSide; url?: string; userId?: string }`
  - `parseBubbleArgs(rest: string): BubbleArgs | { error: 'usage' }` — whitespace tokens, any order, case-insensitive: `white`/`transparent`, `left`/`right`, an `http(s)` token (with or without `<>`) → `url`, `<@id>`/`<@!id>` or a 17–20 digit snowflake → `userId`. A repeated kind (two styles, two URLs…) or any other token → `{ error: 'usage' }`. Empty → defaults `transparent`, `left`.
  - `parseMemeArgs(rest: string): { url?: string; text: string }` — if the first whitespace token is an `http(s)` URL (optionally in `<>`), it becomes `url` and is removed; `text` is the remainder with its newlines kept, trimmed. Mentions are never taken as sources.
  - `commandRemainder(content: string, prefix: string, commandName: string): string` — the text after the prefix and the invoked name/alias (case-insensitive), preserving newlines; used because Sapphire's lexer drops them.
  - `bubbleUsage(prefix: string): string` and `memeUsage(prefix: string): string` — e.g. ``Usage: `?bubble [white|transparent] [left|right] [link | @user]`, with an image attached or as a reply to one. Or use `/bubble`.`` and ``Usage: `?meme <text>`, with an image attached or as a reply to one. Or use `/meme`.``
- [ ] **Step 1: Failing examples:** `''` → defaults; `'WHITE right'`; `'right <@!123456789012345678>'` → userId; `'123456789012345678'` → userId; `'https://media.tenor.com/a.gif white'`; `'white white'` → usage; `'banana'` → usage; `parseMemeArgs('https://media.tenor.com/a.gif when it works')` → url + `'when it works'`; `parseMemeArgs('<@1> when\nthe build passes')` → no url, text `'<@1> when\nthe build passes'`; `commandRemainder('?Meme  top\nbottom', '?', 'meme')` → `'top\nbottom'`.
- [ ] **Step 2: Fuzz:** `parseBubbleArgs` and `parseMemeArgs` never throw for any string; a successful `parseBubbleArgs` result's `style`/`tail` are always valid literals; reassembling generated valid token permutations (`fc.shuffledSubarray` of one token per kind) always parses to those values.
- [ ] **Step 3:** FAIL → implement → PASS → full check → commit `feat(imaging): add prefix argument parsing for bubble and meme`.

---

### Task 6: Source picking (`source.ts`)

**Files:** Create `src/features/imaging/source.ts`; Test `test/imaging-source.test.ts`

**Interfaces:**

- Consumes: `checkUrl`, `extractUrls`, `UrlCheck` (Task 2); `messages` (Task 1).
- Produces:
  - `interface AttachmentData { url: string; contentType: string | null }`
  - `interface EmbedData { url: string | null; provider: string | null; imageUrl: string | null; thumbnailUrl: string | null; hasVideo: boolean }`
  - `interface StickerData { url: string; format: 'png' | 'apng' | 'gif' | 'lottie' }`
  - `interface ReplyData { attachments: AttachmentData[]; embeds: EmbedData[]; stickers: StickerData[]; content: string }`
  - `interface SourceInputs { attachment?: AttachmentData; url?: string; avatarUrl?: string; reply?: ReplyData }`
  - `type SourcePick = { ok: true; check: Extract<UrlCheck, { ok: true }> } | { ok: false; message: string | null }` — `message: null` means "nothing given", so the command shows its usage text.
  - `pickSource(inputs: SourceInputs): SourcePick`
- Rules: precedence attachment > url > avatarUrl > reply. An attachment whose `contentType` starts with `video/` → `messages.video`; other non-`image/` types → `messages.notImage`. A given `url` that fails `checkUrl` → `messages.notAllowed` (no fallback to lower sources). Reply: first `image/*` attachment (a `video/*` one is skipped, remembered for the error); then each embed: if its `url` passes `checkUrl` and the host is Tenor or Giphy → that (gifv case); else `imageUrl`, then `thumbnailUrl`, if allowed; then the first non-Lottie sticker (a Lottie-only reply → `messages.lottie`); then the first allowed URL in `content`; nothing usable → `messages.video` if a video was seen, else `messages.notImage`.
- [ ] **Step 1: Failing tests:** one `it` per precedence pair (attachment beats url, url beats avatar, avatar beats reply); bad url does not fall back; video attachment; empty inputs → `{ ok: false, message: null }`; reply cases: image attachment; Tenor gifv embed `{ url: 'https://tenor.com/view/x-gif-1', provider: 'Tenor', imageUrl: null, thumbnailUrl: 'https://media.tenor.com/t.png', hasVideo: true }` → `tenorPage`; Giphy gifv embed → `i.giphy.com` media; generic embed with `imageUrl` on `images-ext-1.discordapp.net`; PNG sticker; Lottie-only → lottie; URL in content; only a video attachment → video.
- [ ] **Step 2:** FAIL → implement → PASS → full check → commit `feat(imaging): pick the image source by precedence`.

---

### Task 7: Frames, decode and encode (`frames.ts`, `decode.ts`, `encode.ts`)

**Files:** Create the three files; Test `test/imaging-frames.test.ts`, `test/imaging-decode.test.ts`, `test/fuzz-imaging-frames.test.ts`, helper `test/support/images.ts`

**Interfaces:**

- Consumes: `limits`, `ImagingError`, `messages`.
- Produces:
  - `frames.ts`: `interface Frames { data: Buffer; width: number; pageHeight: number; pages: number; delay: number[] /* ms, length = pages */; loop: number }`; `sampleGroups(total: number, cap: number): number[][]` — consecutive groups of source page indices, `min(total, cap)` groups, covering `0..total-1` exactly once in order, sizes differing by at most 1; `toSharp(frames: Frames): sharp.Sharp` (raw input with `pageHeight`); `fromSharp(img: sharp.Sharp, meta: Pick<Frames, 'delay' | 'loop'>): Promise<Frames>`; `halveFrames(frames: Frames): Frames` — merges pairs (keep the first frame of each pair, sum both delays; odd last frame kept).
  - `decode.ts`: `decodeFrames(input: Buffer, options: { maxWidth: number }): Promise<Frames>`.
  - `encode.ts`: `interface GifTuning { interFrameMaxError?: number; dither?: number }`; `encodeGif(frames: Frames, tuning?: GifTuning): Promise<Buffer>` — `toSharp(frames).gif({ loop, delay, effort: 7, ...tuning })`, single-frame input omits `delay`.
  - `test/support/images.ts`: `makeGif({ width, height, frames, delay, loop, colors? }): Promise<Buffer>` (each frame a distinct flat colour so tests can identify frames), `makePng({ width, height, alpha? })`, `makeJpeg({ width, height })`.
- Decode algorithm (`decodeFrames`):
  1. `const head = await sharp(input).metadata()`; reject (`messages.tooManyPixels`) if `width` or `pageHeight ?? height` > `maxSourceSide`, or `pages ?? 1` > `maxSourcePages`.
  2. Working width `w = clamp(head.width, limits.minWidth, options.maxWidth)`; scaled page height `h = round(srcPageHeight * w / head.width)`; cap = `min(limits.maxFrames, floor(limits.maxStripPixels / (w * h)))`; cap < 1 → `messages.tooManyPixels`.
  3. `groups = sampleGroups(totalPages, cap)`. Decode in chunks of ≤ 25 consecutive source pages: `sharp(input, { page: start, pages: n, limitInputPixels: maxSourceSide ** 2 * 25 }).resize({ width: w, height: h, fit: 'fill' }).ensureAlpha().raw()` (resize is per page on decoded multi-page input), and copy out only the first page of each group. Delay of a group = sum of its source delays (missing delays count as 100 ms; static input → `[0]`). `loop = head.loop ?? 0`.
  4. Wrap sharp errors (corrupt input) as `ImagingError(messages.notImage)`.
- [ ] **Step 1: Failing tests:**
  - `sampleGroups(10, 100)` = ten singletons; `sampleGroups(250, 100)` has 100 groups covering 0..249; fuzz over `total ∈ [1,2000]`, `cap ∈ [1,200]` for the covering/size properties.
  - `halveFrames` on 5 frames with delays `[10,20,30,40,50]` → 3 frames, delays `[30,70,50]`, first-of-pair pixels kept.
  - decode an animated 300×200 GIF with 6 frames, delays `[50,100,150,50,100,150]`, loop 3 → `width 300, pageHeight 200, pages 6`, delays equal, `loop 3`.
  - decode 1000×500 GIF with `maxWidth: 512` → width 512, pageHeight 256; with `maxWidth: 256` → 256.
  - 32×32 PNG → width 256, pageHeight 256, pages 1 (Review Focus 3); JPEG and PNG with alpha decode to 1 frame with 4 channels.
  - 150-frame GIF (each 20 ms) → 100 frames, total delay 3000 ms (Review Focus 4), loop kept.
  - 5000×10 PNG → `tooManyPixels`; random bytes → `notImage`.
  - round trip: `decodeFrames(await encodeGif(frames))` keeps pages, delays (rounded to 10 ms), loop; a 1-frame encode is a valid GIF (`sniffImage` 'gif').
- [ ] **Step 2:** FAIL → implement → PASS → full check → commit `feat(imaging): decode and encode frame strips with even frame sampling`.

---

### Task 8: Bubble (`bubble.ts`)

**Files:** Create `src/features/imaging/bubble.ts`; Test `test/imaging-bubble.test.ts`

**Interfaces:**

- Consumes: `Frames`, `toSharp`, `fromSharp` (Task 7); `BubbleStyle`, `TailSide` (Task 5).
- Produces: `bubbleGeometry(width: number, height: number): { curveY: number; edgeY: number; tailBaseFrom: number; tailBaseTo: number; tipX: number; tipY: number }` (left-tail coordinates); `bubbleSvg(width: number, height: number, tail: TailSide, fill: string): Buffer`; `applyBubble(frames: Frames, options: { style: BubbleStyle; tail: TailSide }): Promise<Frames>`.
- Geometry (pinned): `curveY = round(min(0.2 * w, 0.2 * h))` (lowest point of the curve), `edgeY = round(curveY * 0.55)` (where the curve meets the sides), quadratic control y = `2 * curveY - edgeY`; tail base from `0.25 * w` to `0.35 * w` at `edgeY`; `tipX = 0.22 * w`, `tipY = round(min(0.4 * w, 0.4 * h))`. Body path starts at `-2,-2` so the top edge is fully covered. Right tail: wrap in `<g transform="translate(w,0) scale(-1,1)">`. Apply: one overlay of exactly one frame, `composite([{ input: svg, tile: true, gravity: 'northwest', blend: style === 'white' ? 'over' : 'dest-out' }])` on `toSharp(frames)`; SVG fill black for `dest-out`, white for `over`.
- [ ] **Step 1: Failing tests** (300×200, 3 frames, opaque colours): transparent → pixel `(150, 2)` alpha 0 on **every** frame, `(150, 190)` alpha 255; tail left → `(round(0.3w), round((edgeY + tipY) / 2) - 2)` alpha 0 and its mirror `(w - that x)` alpha 255; tail right → the reverse; white → `(150, 2)` is `255,255,255,255` on every frame; tall 200×800 frame → `curveY` 40 (width-bound), wide 800×100 → `curveY` 20 (height-bound); pages/delays/loop unchanged.
- [ ] **Step 2:** FAIL → implement → PASS → full check.
- [ ] **Step 3:** Render `bubble-transparent-left.gif`, `bubble-white-right.gif` from a sample (e.g. the spike's `inputs/` Tenor GIF) into the scratchpad `renders/` folder and list their paths in the report (for user approval; not committed).
- [ ] **Step 4:** Commit `feat(imaging): add the speech bubble overlay`.

---

### Task 9: Caption (`caption.ts`)

**Files:** Create `src/features/imaging/caption.ts`; Test `test/imaging-caption.test.ts`

**Interfaces:**

- Consumes: `Frames`, `toSharp`, `fromSharp`; `captionFont`, `captionFontFile`, `ensureFonts`; `escapeMarkup`; `ImagingError`, `messages`.
- Produces:
  - `captionLayout(width: number): { size: number; padding: number }` — `size = clamp(round(width / 10), 16, 64)`, `padding = round(size / 2)`.
  - `renderCaptionText(text: string, width: number, size: number): Promise<{ data: Buffer; width: number; height: number }>` — raw RGBA of black text: `sharp({ text: { text: '<span foreground="black">' + escapeMarkup(text) + '</span>', font: captionFont(size), fontfile: captionFontFile, width: width - 2 * padding, align: 'centre', wrap: 'word-char', rgba: true, dpi: 72 } })`. Takes the **sanitised, unescaped** text.
  - `applyCaption(frames: Frames, text: string): Promise<Frames>` — awaits `ensureFonts()`; starting at `captionLayout(frames.width).size`, renders; while text height > `frames.pageHeight` shrink `size = floor(size * 0.85)` (padding recomputed) until `size < 12` → `ImagingError(messages.captionTooLong)`. `barHeight = textHeight + 2 * padding`. Builds a new raw buffer where each frame is `barHeight` rows of opaque white followed by the frame's rows (plain Buffer copies, no sharp), then composites one frame-sized transparent overlay with the text centred horizontally at `top = padding` using `tile: true, gravity: 'northwest'`.
- [ ] **Step 1: Failing tests:** 300×200 3-frame input + `'when the code works'` → `pageHeight === 200 + barHeight`, `barHeight > 2 * padding`; row 1 of every frame is white opaque; some pixel in the bar is dark (`r < 64`) on every frame; the original frame's colour sits at `(150, barHeight + 100)`; delays/loop/pages unchanged; markup-looking text `'<span size="99999">x</span> & y'` renders without throwing and its bar is less than 3× the bar height for `'x'` (escaping works, no giant span); an 800-char text (bypassing sanitising) on a 256×64 frame → `captionTooLong`; 32×32 PNG decoded (256 wide) + caption → `size === 26` in `captionLayout(256)` and renders (Review Focus 3); emoji `'😂'` renders a bar with dark pixels.
- [ ] **Step 2:** FAIL → implement → PASS → full check.
- [ ] **Step 3:** Render `meme-short.gif` (`do not run python`) and `meme-long.gif` (a 3-line caption) from the sample GIF into the scratchpad `renders/` and list the paths.
- [ ] **Step 4:** Commit `feat(imaging): add the white caption bar`.

---

### Task 10: Render pipeline and size ladder (`render.ts`)

**Files:** Create `src/features/imaging/render.ts`; Test `test/imaging-render.test.ts`

**Interfaces:**

- Consumes: `decodeFrames`, `encodeGif`, `halveFrames`, `applyBubble`, `applyCaption`.
- Produces:
  - `type ImageOperation = { kind: 'bubble'; style: BubbleStyle; tail: TailSide } | { kind: 'meme'; text: string }`
  - `interface RenderResult { gif: Buffer; width: number; pages: number; step: number }`
  - `renderImage(input: Buffer, op: ImageOperation, options?: { maxBytes?: number }): Promise<RenderResult>` (`maxBytes` defaults to `limits.outputBytes`).
- Ladder (in order, `step` is the index): `{ maxWidth: 512 }`, `{ maxWidth: 512, tuning: { interFrameMaxError: 16 } }`, `{ maxWidth: 512, tuning: { dither: 0, interFrameMaxError: 32 } }`, `{ maxWidth: 384, same tuning }`, `{ maxWidth: 256, same tuning }`, `{ maxWidth: 256, same tuning, halve: true }`. Decode once per distinct `maxWidth` and apply the operation once per decode (reuse the result across tuning steps). Over the limit after the last step → `ImagingError(messages.outputTooBig)`.
- [ ] **Step 1: Failing tests:** small GIF → `step 0`, output sniffs as GIF; a noisy 40-frame 600×400 GIF with `maxBytes` set just below its step-0 size → `step > 0` and `gif.length <= maxBytes`; `maxBytes: 100` → `outputTooBig`; meme op output is taller than bubble op output for the same input.
- [ ] **Step 2:** FAIL → implement → PASS → full check → commit `feat(imaging): add render pipeline with output size ladder`.

---

### Task 11: Job queue (`jobs.ts`)

**Files:** Create `src/features/imaging/jobs.ts`; Test `test/imaging-jobs.test.ts`

**Interfaces:**

- Produces: `class ImageJobs { constructor(options?: { concurrency?: number; queueSize?: number; timeoutMs?: number }); run<T>(userId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>; get active(): number; get queued(): number }` and a shared `export const imageJobs = new ImageJobs()` (defaults from `limits`).
- Behaviour: a user with a job running or queued → reject `ImagingError(messages.busyUser)` immediately; queue full (`queued === queueSize`) → `messages.busy`; at most `concurrency` tasks run; FIFO; timeout counts from when the task **starts**, aborts the signal and rejects with `messages.timeout` (a task that ignores the signal still frees its slot only when it settles — document this; the slot is held until settle so concurrency stays honest); the user lock is released in `finally`, also after errors.
- [ ] **Step 1: Failing tests** with deferred promises and `vi.useFakeTimers()`: same user twice → busyUser; third task waits while two run, starts after one settles; with `queueSize: 1` the fourth distinct user → busy; timeout aborts the signal and rejects with `messages.timeout`; lock released after a rejected task.
- [ ] **Step 2:** FAIL → implement → PASS → full check → commit `feat(imaging): add per-user image job queue with timeout`.

---

### Task 12: Discord adapters (`discord.ts`) and the shared run flow

**Files:** Create `src/features/imaging/discord.ts`; Modify `src/features/imaging/index.ts`; Test `test/imaging-discord.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces:
  - `attachmentData(a: { url: string; contentType: string | null }): AttachmentData`
  - `replyData(message: Message): ReplyData` — attachments, embeds (`embed.url`, `embed.provider?.name`, `embed.image?.url`, `embed.thumbnail?.url`, `Boolean(embed.video)`), stickers (`sticker.url`, format from `StickerFormatType`: PNG→png, APNG→apng, GIF→gif, Lottie→lottie), content.
  - `avatarUrl(user: User, member: GuildMember | APIInteractionGuildMember | null): string` — guild member avatar when it is a `GuildMember` with an avatar, else `user.displayAvatarURL({ size: 512, extension: 'png', forceStatic: false })`.
  - `messageInputs(message: Message, args: { url?: string; userId?: string }): Promise<SourceInputs>` — own first attachment; `url`; `userId` → `message.guild.members.fetch(userId)` (fall back to `client.users.fetch`; not found → no avatar, and the source falls through); reply via `message.fetchReference()` only when `message.reference?.messageId` is set (fetch failure → no reply data).
  - `interactionInputs(interaction: ChatInputCommandInteraction): SourceInputs` — `getAttachment('image')`, `getString('url')`, `getUser('user')` with `getMember('user')`.
  - `messageMentionNames(message: Message): MentionNames` (from `message.mentions.users/members/roles/channels`, members' `displayName` first) and `interactionMentionNames(interaction): MentionNames` (from `interaction.guild` caches and `interaction.client.users.cache`).
  - `produceImage(inputs: SourceInputs, op: ImageOperation, userId: string, deps?: { fetch?: Fetcher; jobs?: ImageJobs }): Promise<{ file: AttachmentBuilder } | { error: string | null }>` — `pickSource`; `jobs.run(userId, signal => downloadImage(...).then(renderImage))`; returns `new AttachmentBuilder(gif, { name: op.kind === 'bubble' ? 'bubble.gif' : 'meme.gif' })`. `ImagingError` → `{ error: message }`; `null` error = nothing given (usage). Other errors are rethrown. Logs `debug` with duration, input bytes, output bytes, ladder step.
- [ ] **Step 1: Failing tests** with plain object stubs cast to the discord.js types: `replyData` maps a Tenor gifv embed and a Lottie sticker; `avatarUrl` prefers the guild avatar; `messageInputs` with a reply fetches the reference, without `reference` never calls `fetchReference`; `produceImage` with a stub `fetch` serving a generated GIF returns an attachment named `bubble.gif`; a not-allowed URL returns `{ error: messages.notAllowed }` without calling `fetch`; no inputs → `{ error: null }`; an unexpected `TypeError` from the stub fetch path is rethrown (not swallowed).
- [ ] **Step 2:** FAIL → implement → PASS → full check → commit `feat(imaging): add discord adapters and the shared image flow`.

---

### Task 13: Precondition denial listeners

**Files:** Create `src/listeners/command-denied.ts`; Test `test/command-denied.test.ts`

**Interfaces:**

- Produces: `ChatInputCommandDeniedListener` (`Events.ChatInputCommandDenied`) and `MessageCommandDeniedListener` (`Events.MessageCommandDenied`). Both skip when `Reflect.get(Object(error.context), 'silent')` is true. Slash: `errorReply(error.message)` via `interaction.reply` (or `followUp` if already replied/deferred). Prefix: `message.reply(error.message)`. Reply failures are logged at `warn`, never thrown.
- [ ] **Step 1: Failing tests:** emit `Events.ChatInputCommandDenied` / `Events.MessageCommandDenied` on a loaded client with a `UserError({ identifier: 'preconditionCooldown', message: 'Wait 5s' })` and stub payloads; assert the ephemeral reply / message reply with `'Wait 5s'`; a `silent: true` context sends nothing.
- [ ] **Step 2:** Check existing command tests still pass (other commands' denials, e.g. `runIn` in DMs, now get a reply; that is intended — mention it in the commit body).
- [ ] **Step 3:** FAIL → implement → PASS → full check → commit `feat(listeners): reply when a command precondition denies a run`.

---

### Task 14: `/bubble` and `?bubble`

**Files:** Create `src/commands/image/bubble.ts`; Test `test/bubble-command.test.ts`

**Interfaces:**

- Consumes: `parseBubbleArgs`, `commandRemainder`, `bubbleUsage`, `messageInputs`, `interactionInputs`, `produceImage`, `messages`, `limits` from `features/imaging/index.js`; `errorReply` from `features/ui`.
- Command: `name: 'bubble'`, description `'Put a speech bubble on an image or GIF'`, `runIn: CommandOptionsRunTypeEnum.GuildAny`, `cooldownDelay: limits.cooldownMs`. Slash options (all optional): `image` attachment, `url` string, `user` user, `style` choices Transparent/`transparent`, White/`white`, `tail` choices Left/`left`, Right/`right`; `setContexts(InteractionContextType.Guild)`.
- Slash flow: `deferReply()`; `produceImage(interactionInputs(i), { kind: 'bubble', style, tail }, i.user.id)`; file → `editReply({ files: [file] })`; error → `deleteReply()` then `followUp(errorReply(error ?? usage))` (ephemeral). Slash usage text: `'Give me an image: attach one, paste a link, or pick a user.'`.
- Prefix flow: Attach Files check first (`channel.permissionsFor(guild.members.me).has(PermissionFlagsBits.AttachFiles)`), else plain reply `messages.noAttachFiles`; parse `commandRemainder(message.content, prefix, args.commandContext.commandName)`; usage error → reply `bubbleUsage(prefix)`; `channel.sendTyping()` (ignore failure); `produceImage(await messageInputs(message, parsed), …)`; reply `{ files: [file] }` or the error text (null → usage).
- [ ] **Step 1: Failing e2e tests** (style of `test/ping.test.ts`; stub `fetch` via `vi.stubGlobal('fetch', …)` serving a generated GIF; use a fresh `ImageJobs` or the shared one): `/bubble url:<tenor media>` defers then `editReply` with one file named `bubble.gif`; `/bubble url:https://evil.com/a.gif` deletes the deferred reply and follows up ephemerally with `messages.notAllowed`; `/bubble` with nothing → ephemeral usage; `?bubble white` with an attachment replies with a file; `?bubble banana` replies with usage; `?bubble` in a channel without Attach Files replies `messages.noAttachFiles`; a second `?bubble` by the same user within 10 s gets the cooldown reply via Task 13.
- [ ] **Step 2:** FAIL → implement → PASS → full check → commit `feat(image): add the bubble command`.

---

### Task 15: `/meme` and `?meme`

**Files:** Create `src/commands/image/meme.ts`; Test `test/meme-command.test.ts`

**Interfaces:** As Task 14, plus `parseMemeArgs`, `memeUsage`, `sanitizeCaption`, `messageMentionNames`, `interactionMentionNames`.

- Command: `name: 'meme'`, description `'Add a white caption bar above an image or GIF'`, same `runIn`/cooldown. Slash: `text` string **required**, `setMaxLength(limits.captionChars)`; `image`, `url`, `user` as in `/bubble`.
- Text: `sanitizeCaption(text, mentionNames)` before any download (empty → `messages.emptyCaption`, shown like other errors; slash checks before `deferReply` so it can reply ephemerally directly). Prefix text over `limits.captionChars` (after sanitising) → `messages.captionTooLong`. Prefix with no text at all → `memeUsage(prefix)`.
- [ ] **Step 1: Failing e2e tests:** `/meme text:"do not run python" url:<tenor media>` → `meme.gif`; `/meme text:"​"` → ephemeral `emptyCaption` and no `deferReply`; `?meme <@1> when it works` replying to a message with an image attachment (mentions map `1` → `bob`) → a `meme.gif` file (the name mapping itself is unit-tested in Tasks 4 and 12); `?meme https://media.tenor.com/a.gif hello` uses the URL as the source; `?meme` alone → usage.
- [ ] **Step 2:** FAIL → implement → PASS → full check → commit `feat(image): add the meme command`.

---

### Task 16: Help card and docs

**Files:** Modify `src/features/help/cards.ts`, `test/help.test.ts`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md` (only if it lists commands)

- [ ] **Step 1: Failing test** in `test/help.test.ts`: the card has `## Fun` and contains `/bubble`, `?bubble`, `/meme`, `?meme`; plus "lists every image command" mirroring the misc check (category `image`).
- [ ] **Step 2:** Add the section after `## Games`: ``\`/bubble\` & \`${prefix}bubble\`: put a speech bubble on an image or GIF, e.g. reply to one with \`${prefix}bubble white\` `` and ``\`/meme\` & \`${prefix}meme\`: add a caption bar, e.g. \`${prefix}meme when the build passes\` ``.
- [ ] **Step 3:** AGENTS.md: layout entries for `commands/image/`, `features/imaging/` and `assets/fonts/`; conventions: image sources are fetched only from the allowlist in `urls.ts` (never widen it to arbitrary hosts), only OFL-style fonts with their licence file, the runtime image needs `fontconfig`. Mirror the convention lines in CONTRIBUTING.md.
- [ ] **Step 4:** Full check → commit `docs(imaging): document image commands, allowlist and font rules` (help card change may be its own `feat(help): list image commands` commit).

---

## Execution notes for the orchestrator

- Tasks 2–6 are independent of each other once Task 1 lands; 7 → 8/9 → 10; 11 is independent; 12 needs 2–11; 13 is independent; 14 needs 12–13; 15 needs 14; 16 last.
- After Tasks 8 and 9, show the user the scratchpad renders before continuing past Task 10.
- Final: whole-branch review, `docker build`, then PR.
