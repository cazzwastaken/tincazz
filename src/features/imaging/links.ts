/** Where a message given to `/bubble message:` lives. `null` IDs mean the current guild/channel. */
export interface MessageLink {
  guildId: string | null;
  channelId: string | null;
  messageId: string;
}

const snowflake = '(\\d{17,20})';
const messageUrl = new RegExp(
  `^https://(?:(?:ptb|canary)\\.)?discord(?:app)?\\.com/channels/${snowflake}/${snowflake}/${snowflake}/?(?:[?#]\\S*)?$`,
  'i',
);
const bareId = new RegExp(`^${snowflake}$`);
/** What Discord's "Copy Message ID" gives with Shift held: `<channel>-<message>`. */
const channelAndId = new RegExp(`^${snowflake}-${snowflake}$`);

/**
 * Parses a message link (`https://discord.com/channels/<guild>/<channel>/<message>`, also on
 * `ptb.`, `canary.` and `discordapp.com`, optionally in `<>`), a `<channel>-<message>` pair or a
 * bare message ID. DM links (`@me`) and anything else give `null`. Never throws.
 */
export function parseMessageLink(raw: string): MessageLink | null {
  let text = raw.trim();
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1).trim();

  const url = messageUrl.exec(text);
  if (url?.[1] && url[2] && url[3]) {
    return { guildId: url[1], channelId: url[2], messageId: url[3] };
  }
  const pair = channelAndId.exec(text);
  if (pair?.[1] && pair[2]) return { guildId: null, channelId: pair[1], messageId: pair[2] };
  const id = bareId.exec(text);
  if (id?.[1]) return { guildId: null, channelId: null, messageId: id[1] };
  return null;
}

/** The canonical link to a message. */
export function messageLinkUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
