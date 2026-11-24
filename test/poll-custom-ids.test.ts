import { describe, expect, it } from 'vitest';
import { decodePollCloseId, encodePollCloseId } from '../src/features/poll/custom-ids.js';

describe('poll custom ids', () => {
  it('round-trips', () => {
    const id = encodePollCloseId({ guildId: '123456789012345678', pollId: 7 });
    expect(id).toBe('poll:close:123456789012345678:7');
    expect(decodePollCloseId(id)).toEqual({ guildId: '123456789012345678', pollId: 7 });
  });

  it('ignores other and malformed ids', () => {
    for (const id of [
      '',
      'cf:again:1:2',
      'poll:close',
      'poll:close:1',
      'poll:close:x:1',
      'poll:close:1:0',
      'poll:close:1:1:1',
      'poll:open:1:1',
      'poll:close:1:-1',
    ]) {
      expect(decodePollCloseId(id), id).toBeUndefined();
    }
  });
});
