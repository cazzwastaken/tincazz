# Image commands: `/bubble` and `/meme`

Date: 2026-11-20. Status: approved design, pending spec review.

## Goal

Two fun commands for the community server that turn an image or GIF into a shareable, favouritable
GIF:

- **`/bubble`**: the "speech bubble" reaction template. A speech-bubble shape across the top of the
  image with a tail pointing down into it, so the image looks like it is speaking.
- **`/meme <text>`**: the caption template. A white bar added above the image with black, centred,
  wrapped text in a condensed heavy font (the esmBot / iFunny caption look).

Success: a member can point either command at an attachment, a link, a member's avatar or (prefix
form) a replied-to message, and gets a GIF back within a few seconds that keeps the source's
animation, timing and loop, fits Discord's upload limit and can be starred as a favourite GIF.

## Decisions (from the user)

| Topic        | Decision                                                                          |
| ------------ | --------------------------------------------------------------------------------- |
| Bubble style | Per use: `style: transparent \| white`, default `transparent`                     |
| Inputs       | Attachment, URL, user avatar, and prefix commands used with an attachment / reply |
| Cost         | Free, with a per-user cooldown                                                    |
| Font         | Closest OFL look-alike of Futura Condensed Extra Bold, bundled in the repo        |
| Workspace    | Branch `feat/image-commands` in a git worktree, merged through a PR               |

## Assumptions (stated to and approved by the user)

- **Output is always GIF** (`bubble.gif`, `meme.gif`), also for PNG/JPEG/WebP input. Only `.gif`
  files get Discord's favourite-GIF star, which is how these memes get reused.
- Bubble tail side is an option: `tail: left | right`, default `left`.
- These are not games: no game-channel gating, no coins, folder `src/commands/image/`.
- Engine: **sharp** (libvips). Rejected: `@napi-rs/canvas` + JS GIF codecs (slower, own
  quantisation, more code) and ffmpeg (large binary, string filter graphs, harder to test).

## Commands

### `/bubble`

Options (all optional): `image` (attachment), `url` (string), `user` (user), `style` (choice
`transparent` / `white`), `tail` (choice `left` / `right`).

Prefix: `?bubble [white|transparent] [left|right] [url | @mention | user id]`, tokens in any
order, plus an attachment on the message or a reply to a message with an image. Unknown tokens
give the usage text.

### `/meme`

Options: `text` (string, required, max 200 characters), `image`, `url`, `user` (as above).

Prefix: `?meme <text>`, the image from the message's attachment or the replied-to message. A
leading allowlisted URL token is taken as the source and removed from the text. Mentions in the
text are **never** sources for `?meme` (they are caption text, e.g. `?meme @bob when the build
passes`); use `/meme user:` for avatars.

### Source precedence

First match wins:

1. Attachment (slash `image` option, or the prefix message's own first image attachment)
2. URL (slash `url`, or prefix URL token)
3. User avatar (slash `user`, or `?bubble` mention / ID token): the guild avatar when set, else the
   user avatar, animated when available, 512px
4. Prefix only: the replied-to message: first image attachment, then embeds (Tenor / Giphy embeds
   via their page URL, other embeds via `image.url`, its `proxyURL`, `thumbnail.url`, its
   `proxyURL`: the first allowed wins), then a sticker in PNG, APNG or GIF format (Lottie stickers
   are rejected), then the first allowlisted URL in its content
5. Nothing: an error with the usage text

## Architecture

`src/features/imaging/` holds all logic, no Discord imports except in the thin adapters. Public
surface through `index.ts`.

| File         | Purpose                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`  | Every limit and tunable below, in one place                                                                                                     |
| `urls.ts`    | Parse and validate a URL against the host allowlist; Tenor / Giphy page URL to media URL                                                        |
| `fetch.ts`   | Download with an injected `fetch`: https only, manual redirects re-checked against the allowlist (max 3), byte cap, timeout, content type check |
| `source.ts`  | Pick a source from the gathered inputs (precedence above) as a pure function over plain data                                                    |
| `text.ts`    | Caption sanitising (mentions, emoji, control characters, whitespace) and Pango escaping                                                         |
| `decode.ts`  | Load into sharp: frame cap (even sampling, delays summed), resize to the working width, normalise to RGBA                                       |
| `bubble.ts`  | Bubble SVG for a frame size and tail side; apply as cut-out or white fill on every frame                                                        |
| `caption.ts` | Font size and padding from width; render text; extend every frame by the bar and composite the text                                             |
| `encode.ts`  | GIF encode keeping delays and loop; size ladder until the output fits the upload limit                                                          |
| `jobs.ts`    | Per-user lock (one image job at a time, separate from the game busy lock), global concurrency limit with a bounded queue, job timeout           |
| `discord.ts` | Adapters: gather inputs from an interaction or a message into the plain shape `source.ts` takes; resolve mentions for `text.ts`                 |
| `errors.ts`  | `ImagingError` with a user-facing message, so commands can tell expected failures from bugs                                                     |

Commands `src/commands/image/bubble.ts` and `src/commands/image/meme.ts` stay thin: gather inputs,
run the job, reply.

Fonts live in `assets/fonts/` (font file plus its `OFL.txt`) and are resolved with
`new URL('../../../assets/fonts/<file>', import.meta.url)`, which works from both `src/` (tsx) and
`dist/`. The Dockerfile copies `assets/` into the runtime image.

### Data flow

```
command -> discord.ts (gather inputs) -> source.ts (pick) -> jobs.ts (lock, queue, timeout)
  -> fetch.ts (download) -> decode.ts -> bubble.ts | caption.ts -> encode.ts -> reply with file
```

## Limits (`config.ts`)

| Limit            | Value                                               | Why                                             |
| ---------------- | --------------------------------------------------- | ----------------------------------------------- |
| Download size    | 25 MiB                                              | Covers big Tenor GIFs, bounds memory            |
| Download timeout | 10 s                                                |                                                 |
| Decoded pixels   | one frame ≤ 4096×4096 (probe), strip ≤ 512×1024×100 | Stops decompression bombs                       |
| Frames           | 100, evenly sampled above                           | Keeps duration (delays summed), bounds CPU      |
| Working width    | at most 512 px, at least 256                        | Small images upscaled so text stays readable    |
| Page height      | at most 2048 px                                     | A tall source narrows (down to 16 px) to fit    |
| Output size      | 10 MiB                                              | Discord's default upload limit for bots         |
| Caption length   | 200 characters, 5 lines                             |                                                 |
| Job timeout      | 20 s                                                | sharp `timeout` plus fetch abort                |
| Concurrent jobs  | 2, queue of 10                                      | Beyond the queue: "busy, try again in a moment" |
| Cooldown         | 10 s per user per command                           | Sapphire `cooldownDelay`                        |

Size ladder when the encoded GIF is over the limit: retry at width 384, then 256, then with half
the frames (delays doubled), then fail with "too big even after shrinking". Retries encode squeezed
(no dither, inter-frame error 32) at effort 4. After an encode over the limit, a rung is skipped
when 0.9 × its predicted size (last size × (width / last width)², halved for half the frames) is
still over, so a big animation does not spend the job timeout on encodes that cannot fit.

## Allowed URL hosts

https only. Exact hosts or listed suffixes:

- Discord: `cdn.discordapp.com`, `media.discordapp.net`, `images-ext-*.discordapp.net` (Discord's
  external image proxy)
- Tenor: `media.tenor.com`, `media1.tenor.com`, `c.tenor.com`; page links `tenor.com/view/...`
  are resolved to the GIF by reading the page's `og:image` meta tag (the page fetch is also
  allowlisted and capped at 2 MiB)
- Giphy: `media.giphy.com`, `media*.giphy.com`, `i.giphy.com`; page links
  `giphy.com/gifs/<slug>-<id>` map to `https://i.giphy.com/<id>.gif` without a fetch

Anything else: "I can only fetch images from Discord, Tenor or Giphy links." This prevents the bot
being used to reach internal addresses (SSRF). Accepted content: GIF, PNG, JPEG, WebP, checked by
both content type and magic bytes. Video (mp4/webm, e.g. Discord's gifv embeds) is rejected with a
hint to use the Tenor or Giphy link instead.

## Bubble

An SVG sized to the frame: a shape spanning the full width that starts above the top edge (so only
its curved bottom edge shows) and a triangular tail whose base sits about 25–35% of the width from
the chosen side. The vertical sizes scale with the **width**, not the height, so tall narrow GIFs
are not half covered: curve lowest point about 0.2 × width, tail tip about 0.4 × width, each capped
at 20% / 40% of the frame height. The right-hand tail mirrors the path
(`translate(w,0) scale(-1,1)`). `style: transparent` removes that area from every frame (alpha 0); `style: white`
paints it opaque white. Exact proportions are tuned against sample renders approved by the user.

## Caption

- Font size about width / 10 (clamped), padding about font size / 2, text box width = width minus
  two paddings, centred, wrapped by Pango.
- If the rendered text is taller than the image itself, shrink the font size step by step down to a
  minimum; if it still does not fit, error "that caption is too long for this image".
- Bar height = text height + 2 × padding; every frame is extended upward by the bar, filled white,
  with the text composited on top.

### Text sanitising (`text.ts`)

1. User mentions `<@id>` / `<@!id>` become `@display name` (from the interaction's resolved data or
   the message's mentions; unknown IDs become `@unknown-user`), roles become `@role name`, channels
   become `#channel-name`
2. Custom emoji `<:name:id>` / `<a:name:id>` become `:name:`
3. Control and zero-width characters are removed, except `\n`; runs of spaces collapse; at most 5
   lines; trim
4. Empty after sanitising: error "give the meme some text"
5. Escape `&`, `<`, `>` for Pango markup **last**, so user text can never inject markup

Unicode emoji: rendered in monochrome through the bundled Noto Emoji fallback (see "Engine notes").

## Replies and errors

- Slash: `deferReply()` first (processing can pass Discord's 3 s limit), then `editReply` with the
  file. On an expected error after deferring, delete the deferred reply and send the error as an
  ephemeral `followUp` with `errorReply`, so the error is not public.
- Prefix: `sendTyping()`, then `message.reply` with the file; errors are plain-text replies, as the
  other prefix commands do.
- Prefix in a channel where the bot lacks Attach Files: plain-text error naming the permission.
- Mentions stay suppressed (client default).
- Cooldowns: Sapphire's `cooldownDelay` precondition. The repo has no denied-command listener yet,
  so add `ChatInputCommandDenied` and `MessageCommandDenied` listeners that reply with the
  precondition's message (ephemeral for slash), ignoring `silent` denials.
- Unexpected errors are thrown, so the existing generic error listener answers and logs them.
- Job duration and sizes are logged at debug level through the container logger.

## Testing

No network: `fetch` is injected everywhere.

- `urls.ts`: allowlist examples and fast-check properties (random URLs never pass unless the host is
  allowlisted and the scheme is https; parsing never throws).
- `fetch.ts`: redirect to a non-allowlisted host is rejected, byte cap, timeout, bad content type,
  magic-byte mismatch.
- `source.ts`: precedence table, replied-message fallbacks, Lottie sticker rejected.
- `text.ts`: examples and fast-check (output never contains an unescaped `<` or `&`, never exceeds
  5 lines, sanitising is idempotent on already-clean text).
- Image pipeline with real sharp on tiny inputs generated in the test (animated GIF, PNG with
  alpha, JPEG): frame count and delays kept, loop kept, caption adds the bar height, bubble area
  alpha 0 (transparent) or white (white), tail side mirrored, frame cap samples evenly, size ladder
  shrinks.
- Commands end to end in the style of `test/ping.test.ts`: slash and prefix paths, defer then edit,
  error after defer goes ephemeral, cooldown denial replies.
- `help.test.ts`: the new `## Fun` section lists `/bubble`, `?bubble`, `/meme`, `?meme`.
- `jobs.ts`: per-user lock, concurrency limit, full queue rejects.

## Docs and packaging

- `pnpm add sharp`. No `allowBuilds` entry: sharp has no install scripts and ships prebuilt
  `@img/sharp-linuxmusl-x64` for Alpine.
- Dockerfile: copy `assets/` into the runtime stage and `apk add --no-cache fontconfig` there
  (without it libvips prints a fontconfig error on every text render).
- AGENTS.md: layout (`commands/image/`, `features/imaging/`, `assets/`), the allowlist rule, and the
  fonts' licence rule (only OFL or similarly licensed fonts). CONTRIBUTING.md mirrors the convention
  changes. Help card gets a `## Fun` section.

## Out of scope

Video input (mp4/webm), arbitrary URLs, custom emoji as image source, extra templates, top-and-bottom
Impact captions, per-guild toggles. Each can be added later on top of `features/imaging/`.

## Engine notes (verified by the spike)

sharp 0.35.5 / libvips 8.18.7, verified on the host and in `node:24-alpine`. Spike code (throwaway,
not committed) lived in the session scratchpad.

- **Load:** probe `metadata()` first (`pages`, `width`, `pageHeight`); reject a frame over
  4096×4096; then `sharp(input, { pages: Math.min(head.pages ?? 1, 100), limitInputPixels })`.
  `pages` larger than the real count throws "bad page number", so always clamp. Frame sampling
  above the cap picks pages with `page`/`pages` reads or from the raw strip, with delays summed.
- **Resize and bar:** `resize({ width })` and `extend({ top: barH, background: '#ffffff' })` work
  per page **only on the decoded animated input**, so both happen in the decode pipeline before
  `.ensureAlpha().raw()`. Once in a raw buffer, `extend` adds a single bar to the whole strip.
  The caption text is therefore rendered first (from the target width) to know `barH`.
- **Per-frame overlay:** a plain `composite` only changes page 0. Use an overlay exactly one frame
  in size with `tile: true, gravity: 'northwest'` over the raw strip
  (`raw: { width, height: pageHeight * pages, channels: 4, pageHeight }`). Bubble: `blend:
  'dest-out'` (transparent) or `'over'` (white). Caption: a transparent overlay of the full frame
  with the text in the bar.
- **Encode:** `.gif({ loop, delay, effort: 7 })` keeps pages, delays and loop (WebP loop counts
  carry over). Re-encoded GIFs grow (2.4 MB Tenor GIF → 3.4 MB), so the size ladder in "Limits"
  starts with encoder options: `interFrameMaxError: 16`, then `dither: 0` +
  `interFrameMaxError: 32`, then narrower widths, then halved frames. `colours` only matters at 16
  or fewer and is not used. GIF delays are centiseconds, so odd millisecond delays round.
- **Text:** `sharp({ text: { text, font: 'Barlow Condensed, Black <px>', fontfile, width, align:
  'centre', wrap: 'word-char', rgba: true, dpi: 72 } })`. At `dpi: 72` the point size equals pixels.
  The comma in the font name is required: without it Pango reads "Condensed" as a stretch and
  silently falls back to another font. The text is **always** Pango markup: unescaped `&` or `<`
  throws, and an unescaped `<span size=…>` can blow up the render size, which is why escaping is
  mandatory and tested.
- **Font:** Barlow Condensed Black (SIL OFL 1.1, The Barlow Project Authors), chosen out of 13 OFL
  candidates as closest to Futura Condensed Extra Bold. Source:
  `google/fonts/ofl/barlowcondensed/BarlowCondensed-Black.ttf` plus its `OFL.txt`.
- **Emoji:** Alpine has no system fonts, so emoji render as tofu boxes. `fontfile` takes one path,
  but each one is registered process-wide with fontconfig, so registering Noto Emoji
  (`google/fonts/ofl/notoemoji/NotoEmoji[wght].ttf`, OFL 1.1, ~2 MB) once at first use gives a
  monochrome emoji fallback; the family is `'Barlow Condensed, Noto Emoji, Black <px>'`.
- **Cost:** on the 89-frame 256×438 Tenor GIF: bubble 1.4–1.8 s, caption 2.4–3.9 s (Alpine
  slower), peak RSS 130–190 MB. Mostly GIF encoding. Fits the 20 s timeout and the 2-job limit.
