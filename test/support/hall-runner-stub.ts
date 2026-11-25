import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import type { HallRunner } from '../../src/features/halloffame/index.js';

/** A runner whose every method is a spy. */
export const stubHallRunner = () => ({
  onReactionAdd: vi.fn(),
  onReactionChange: vi.fn(),
  onMessageUpdate: vi.fn(),
  onSourceMessagesDeleted: vi.fn(async () => undefined),
  onSourceChannelDeleted: vi.fn(async () => []),
  onHallMessagesDeleted: vi.fn(() => []),
  onHallChannelDeleted: vi.fn(() => []),
  recover: vi.fn(async () => undefined),
  forgetFailures: vi.fn(),
  idle: vi.fn(async () => undefined),
  stop: vi.fn(),
});

const nativeRequire = createRequire(import.meta.url);

/**
 * Sapphire loads the listeners with Node's own loader, so they hold their own copy of the runner
 * module. Load that same copy natively and install `runner` there; returns the uninstall function.
 */
export function installNativeHallRunner(runner: ReturnType<typeof stubHallRunner>): () => void {
  const native = nativeRequire(resolve('src/features/halloffame/index.ts')) as {
    installHallRunner(runner: HallRunner): () => void;
  };
  return native.installHallRunner(runner as unknown as HallRunner);
}
