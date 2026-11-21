import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { honeypotConfig, honeypotDm, honeypotWarningCard } from '../src/features/honeypot/index.js';

describe('honeypot copy', () => {
  it('pins the spec values', () => {
    expect(honeypotConfig.deleteMessageSeconds).toBe(3600);
    expect(honeypotConfig.cooldownMs).toBe(60_000);
    expect(honeypotConfig.cardDebounceMs).toBe(3_000);
    expect(honeypotConfig.staffPermission).toBe(PermissionFlagsBits.ManageMessages);
  });
  it('shows the warning copy and kick count', () => {
    const out = JSON.stringify(honeypotWarningCard(1234));
    expect(out).toContain('DO NOT SEND MESSAGES IN THIS CHANNEL');
    expect(out).toContain(
      'This channel is used to catch spam bots. Any messages sent here will result in a **softban**.',
    );
    expect(out).toContain('🍯 Kicks: 1,234');
  });
  it('names the server in the DM', () => {
    const text = honeypotDm('Cazz');
    for (const needle of ['**Cazz**', 'compromised', 'password', 'rejoin']) {
      expect(text).toContain(needle);
    }
  });
});
