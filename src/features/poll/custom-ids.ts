const prefix = 'poll:close';

export interface PollCloseId {
  guildId: string;
  pollId: number;
}

export function encodePollCloseId({ guildId, pollId }: PollCloseId): string {
  return `${prefix}:${guildId}:${pollId}`;
}

/** Returns undefined for anything that is not a well-formed Close poll button ID. */
export function decodePollCloseId(customId: string): PollCloseId | undefined {
  const parts = customId.split(':');
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== prefix) return undefined;
  const [, , guildId, id] = parts;
  if (!guildId || !id || !/^\d{1,20}$/.test(guildId) || !/^[1-9]\d{0,8}$/.test(id)) {
    return undefined;
  }
  return { guildId, pollId: Number(id) };
}
