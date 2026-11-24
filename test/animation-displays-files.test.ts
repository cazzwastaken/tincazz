import { AttachmentBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { replyDisplay, updateDisplay } from '../src/features/animation/index.js';
import { card, cardReply, withFiles } from '../src/features/ui/index.js';

const plain = cardReply(card(0, 'plain'));
const withPicture = cardReply(
  withFiles(card(0, 'picture'), new AttachmentBuilder(Buffer.from('x'), { name: 'a.png' })),
);

describe('cardReply files', () => {
  it('carries the files registered for the card and none otherwise', () => {
    expect(plain.files).toBeUndefined();
    expect(withPicture.files?.map((file) => file.name)).toEqual(['a.png']);
  });
});

describe('displays with files', () => {
  it('edits replace the previous attachments, the first reply does not', async () => {
    const interaction = { reply: vi.fn(), editReply: vi.fn() };
    const display = replyDisplay(interaction as never);
    await display.first(withPicture);
    await display.next(withPicture);
    expect(interaction.reply.mock.calls[0]?.[0]).not.toHaveProperty('attachments');
    expect(interaction.editReply.mock.calls[0]?.[0]).toMatchObject({ attachments: [] });
  });

  it('a button update, its edits and the fallback replace attachments too', async () => {
    const interaction = { update: vi.fn(), editReply: vi.fn(), message: { edit: vi.fn() } };
    const display = updateDisplay(interaction as never);
    await display.first(withPicture);
    await display.next(withPicture);
    await display.fallback?.(withPicture);
    expect(interaction.update.mock.calls[0]?.[0]).toMatchObject({ attachments: [] });
    expect(interaction.editReply.mock.calls[0]?.[0]).toMatchObject({ attachments: [] });
    expect(interaction.message.edit.mock.calls[0]?.[0]).toMatchObject({ attachments: [] });
  });

  it('leaves replies without files exactly as they were', async () => {
    const interaction = { update: vi.fn(), editReply: vi.fn(), message: { edit: vi.fn() } };
    const display = updateDisplay(interaction as never);
    await display.first(plain);
    await display.next(plain);
    expect(interaction.update).toHaveBeenCalledWith(plain);
    expect(interaction.editReply).toHaveBeenCalledWith(plain);
  });
});
