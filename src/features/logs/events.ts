import type { AutoRoleTarget } from '../../db/schema.js';
import type { AdminAction } from '../economy/admin.js';
import type { LogKind } from './config.js';

export type EconomyEvent =
  | {
      type: 'admin_adjust';
      actorId: string;
      userId: string;
      action: AdminAction;
      amount: number;
      reason: string;
      balance: number;
    }
  | {
      type: 'jackpot';
      userId: string;
      bet: number;
      payout: number;
      potWon: number;
      roleAssigned: boolean;
    }
  | { type: 'member_departed'; userId: string; balance: number; purgeAt: number }
  | { type: 'member_restored'; userId: string; balance: number }
  | {
      type: 'reconcile_summary';
      departed: number;
      restored: number;
      purged: string[];
      coinsRemoved: number;
    };

export type ModEvent =
  | {
      type: 'autorole_added' | 'autorole_removed';
      actorId: string;
      roleId: string;
      target: AutoRoleTarget;
    }
  | {
      type: 'log_channel_set';
      actorId: string;
      kind: LogKind;
      fromChannelId?: string;
      toChannelId: string;
    }
  | { type: 'log_channel_cleared'; actorId: string; kind: LogKind; fromChannelId: string }
  | {
      type: 'setting_auto_cleared';
      setting:
        | 'autorole'
        | 'jackpot_role'
        | 'log_channel'
        | 'honeypot'
        | 'game_channel'
        | 'hall_of_fame'
        | 'hall_exempt';
      id: string;
      detail: string;
    }
  | { type: 'autorole_failed'; userId: string; failures: { roleId: string; reason: string }[] }
  | {
      type: 'honeypot_kick';
      userId: string;
      channelId: string;
      createdAt: number;
      joinedAt?: number;
      dmSent: boolean;
      unbanFailed: boolean;
    }
  | {
      type: 'honeypot_failed';
      userId: string;
      channelId: string;
      reason: string;
      messageDeleted: boolean;
    }
  | { type: 'honeypot_set'; actorId: string; fromChannelId?: string; toChannelId: string }
  | { type: 'honeypot_cleared'; actorId: string; fromChannelId: string }
  | {
      type: 'hall_set';
      actorId: string;
      fromChannelId?: string;
      toChannelId: string;
      threshold: number;
    }
  | { type: 'hall_cleared'; actorId: string; fromChannelId: string }
  | { type: 'hall_threshold'; actorId: string; from: number; to: number }
  | { type: 'hall_exempt_added' | 'hall_exempt_removed'; actorId: string; channelId: string };
