import { describe, expect, it } from 'vitest';
import { messageLinkUrl, parseMessageLink } from '../src/features/imaging/index.js';

const g = '111111111111111111';
const c = '222222222222222222';
const m = '333333333333333333';

describe('parseMessageLink', () => {
  it.each([
    `https://discord.com/channels/${g}/${c}/${m}`,
    `https://ptb.discord.com/channels/${g}/${c}/${m}`,
    `https://canary.discord.com/channels/${g}/${c}/${m}`,
    `https://discordapp.com/channels/${g}/${c}/${m}`,
    `https://canary.discordapp.com/channels/${g}/${c}/${m}/`,
    `<https://discord.com/channels/${g}/${c}/${m}>`,
    `  https://discord.com/channels/${g}/${c}/${m}?x=1  `,
  ])('reads %s', (link) => {
    expect(parseMessageLink(link)).toEqual({ guildId: g, channelId: c, messageId: m });
  });

  it('reads a bare ID as a message in the current channel', () => {
    expect(parseMessageLink(m)).toEqual({ guildId: null, channelId: null, messageId: m });
  });

  it('reads a channel-message ID pair', () => {
    expect(parseMessageLink(`${c}-${m}`)).toEqual({ guildId: null, channelId: c, messageId: m });
  });

  it.each([
    '',
    'hello',
    '123',
    `http://discord.com/channels/${g}/${c}/${m}`,
    `https://discord.com/channels/@me/${c}/${m}`,
    `https://discord.com/channels/${g}/${c}`,
    `https://evil.com/channels/${g}/${c}/${m}`,
    `https://discord.com.evil.com/channels/${g}/${c}/${m}`,
    `https://discord.com/channels/${g}/${c}/${m}/extra`,
    `${m} ${m}`,
  ])('refuses %j', (raw) => {
    expect(parseMessageLink(raw)).toBeNull();
  });

  it('round trips the canonical link', () => {
    expect(parseMessageLink(messageLinkUrl(g, c, m))).toEqual({
      guildId: g,
      channelId: c,
      messageId: m,
    });
  });
});
