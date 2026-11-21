const prefix = 'cap';
const snowflake = /^\d{17,20}$/;

/** The custom ID of the "Caption message" modal, `cap:<messageId>`. */
export function encodeCaptionModalId(messageId: string): string {
  return `${prefix}:${messageId}`;
}

/**
 * The message ID carried by a caption modal ID; null for anything else. Never throws. The ID comes
 * back from the client, so the message it names is checked again before it is used.
 */
export function decodeCaptionModalId(customId: string): string | null {
  const parts = customId.split(':');
  if (parts.length !== 2 || parts[0] !== prefix) return null;
  const [, messageId] = parts as [string, string];
  return snowflake.test(messageId) ? messageId : null;
}

/** The custom ID of the caption text field inside the modal. */
export const captionModalTextId = 'text';
