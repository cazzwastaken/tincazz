/** Hard limits for the image commands. Every guard in the pipeline reads from here. */
export const limits = {
  downloadBytes: 25 * 1024 ** 2,
  pageBytes: 2 * 1024 ** 2,
  downloadTimeoutMs: 10_000,
  maxRedirects: 3,
  maxSourceSide: 4096,
  maxSourcePages: 1000,
  /** width x page height x pages a source may decode to, before any resize */
  maxSourcePixels: 250_000_000,
  maxFrames: 100,
  maxStripPixels: 512 * 1024 * 100,
  /** tallest working frame: a tall narrow source shrinks below `minWidth` to stay under it */
  maxPageHeight: 2048,
  /** narrowest working frame; a source that would end up narrower is rejected */
  minPageWidth: 16,
  maxWidth: 512,
  minWidth: 256,
  outputBytes: 10 * 1024 ** 2,
  captionChars: 200,
  captionLines: 5,
  /** a message screenshot keeps this many lines and characters of text, then an ellipsis */
  messageLines: 12,
  messageChars: 600,
  jobTimeoutMs: 20_000,
  concurrency: 2,
  queueSize: 10,
  cooldownMs: 10_000,
} as const;
