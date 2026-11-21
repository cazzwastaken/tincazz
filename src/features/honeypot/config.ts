import { PermissionFlagsBits } from 'discord.js';

export const honeypotConfig = {
  deleteMessageSeconds: 3600,
  staffPermission: PermissionFlagsBits.ManageMessages,
  cooldownMs: 60_000,
  cardDebounceMs: 3_000,
  dmTimeoutMs: 2_000,
  readyStaggerMs: 1_000,
  emoji: '🍯',
  banReason: 'Honeypot: posted in the honeypot channel',
  unbanReason: 'Honeypot: softban, unbanned right away',
} as const;

export const honeypotCopy = {
  heading: 'DO NOT SEND MESSAGES IN THIS CHANNEL',
  body: 'This channel is used to catch spam bots. Any messages sent here will result in a **softban**.',
} as const;
