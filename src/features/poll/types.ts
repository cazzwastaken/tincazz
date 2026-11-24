import type { polls } from '../../db/schema.js';

export type Poll = typeof polls.$inferSelect;
