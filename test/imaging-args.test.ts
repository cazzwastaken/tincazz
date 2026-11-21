import { describe, expect, it } from 'vitest';
import {
  bubbleUsage,
  captionUsage,
  commandRemainder,
  parseBubbleArgs,
  parseCaptionArgs,
} from '../src/features/imaging/index.js';

describe('parseBubbleArgs', () => {
  it('defaults when empty', () => {
    expect(parseBubbleArgs('')).toEqual({ style: 'transparent', tail: 'left' });
  });

  it('parses style and tail in any case and order', () => {
    expect(parseBubbleArgs('WHITE right')).toEqual({ style: 'white', tail: 'right' });
    expect(parseBubbleArgs('Right transparent')).toEqual({ style: 'transparent', tail: 'right' });
  });

  it('parses user mentions and snowflakes', () => {
    expect(parseBubbleArgs('right <@!123456789012345678>')).toEqual({
      style: 'transparent',
      tail: 'right',
      userId: '123456789012345678',
    });
    expect(parseBubbleArgs('<@123456789012345678>')).toMatchObject({
      userId: '123456789012345678',
    });
    expect(parseBubbleArgs('123456789012345678')).toMatchObject({ userId: '123456789012345678' });
  });

  it('parses urls with or without angle brackets', () => {
    expect(parseBubbleArgs('https://media.tenor.com/a.gif white')).toEqual({
      style: 'white',
      tail: 'left',
      url: 'https://media.tenor.com/a.gif',
    });
    expect(parseBubbleArgs('<https://media.tenor.com/a.gif>')).toMatchObject({
      url: 'https://media.tenor.com/a.gif',
    });
  });

  it('rejects repeats and unknown tokens', () => {
    expect(parseBubbleArgs('white white')).toEqual({ error: 'usage' });
    expect(parseBubbleArgs('white transparent')).toEqual({ error: 'usage' });
    expect(parseBubbleArgs('banana')).toEqual({ error: 'usage' });
    expect(parseBubbleArgs('12345')).toEqual({ error: 'usage' });
    expect(parseBubbleArgs('https://a.com/x https://b.com/y')).toEqual({ error: 'usage' });
  });
});

describe('parseCaptionArgs', () => {
  it('takes a leading url as the source', () => {
    expect(parseCaptionArgs('https://media.tenor.com/a.gif when it works')).toEqual({
      url: 'https://media.tenor.com/a.gif',
      text: 'when it works',
    });
    expect(parseCaptionArgs('<https://media.tenor.com/a.gif> hi')).toEqual({
      url: 'https://media.tenor.com/a.gif',
      text: 'hi',
    });
  });

  it('never takes mentions as sources and keeps newlines', () => {
    expect(parseCaptionArgs('<@1> when\nthe build passes')).toEqual({
      text: '<@1> when\nthe build passes',
    });
  });

  it('does not take a later url', () => {
    expect(parseCaptionArgs('look https://media.tenor.com/a.gif').url).toBeUndefined();
  });
});

describe('commandRemainder', () => {
  it('keeps newlines after the invoked name', () => {
    expect(commandRemainder('?Caption  top\nbottom', '?', 'caption')).toBe('top\nbottom');
  });

  it('requires a word boundary and the prefix', () => {
    expect(commandRemainder('?captionx hi', '?', 'caption')).toBe('');
    expect(commandRemainder('caption hi', '?', 'caption')).toBe('');
    expect(commandRemainder('?caption', '?', 'caption')).toBe('');
  });

  it('works with alias and multi-character prefixes', () => {
    expect(commandRemainder('!!bub white', '!!', 'bub')).toBe('white');
  });
});

describe('usage', () => {
  it('mentions the prefix', () => {
    expect(bubbleUsage('?')).toBe(
      'Usage: `?bubble [white|transparent] [left|right] [link | @user]`, with an image attached or as a reply to an image or a message (a message with text becomes a screenshot). Or use `/bubble`, or right-click a message > Apps > Bubble message.',
    );
    expect(captionUsage('?')).toBe(
      'Usage: `?caption <text>`, with an image attached or as a reply to one. Or use `/caption`.',
    );
  });
});
