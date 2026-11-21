import { limits } from './config.js';

/** An expected failure whose message is safe to show the user as is. */
export class ImagingError extends Error {
  override name = 'ImagingError';
}

export const messages = {
  notAllowed: 'I can only fetch images from Discord, Tenor or Giphy links.',
  video: "That's a video. Use the Tenor or Giphy link for it instead.",
  notImage: "That doesn't look like a GIF, PNG, JPEG or WebP image.",
  tooLarge: 'That file is too big (over 25 MB).',
  download: "I couldn't download that image.",
  tooManyPixels: 'That image is too large to work with.',
  outputTooBig: 'The result is too big even after shrinking.',
  captionTooLong: 'That caption is too long for this image.',
  captionTooLongChars: `Keep the caption under ${limits.captionChars} characters.`,
  emptyCaption: 'Give the caption some text.',
  spoiler: 'That image is marked as a spoiler.',
  lottie: "I can't use that kind of sticker.",
  busyUser: 'You already have an image in progress.',
  busy: "I'm busy with other images, try again in a moment.",
  timeout: 'That took too long. Try a smaller image.',
  emptyMessage: 'That message has no text or image I can use.',
  messageNotFound: "I can't find that message.",
  noAttachFiles: 'I need the Attach Files permission in this channel.',
} as const;
