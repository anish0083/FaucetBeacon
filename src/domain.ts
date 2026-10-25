import { getAddress, parseUnits, formatUnits, ZeroAddress } from 'ethers';

export const HOURS = 3_600_000;
export const DAY = 24 * HOURS;
export const CAPABILITIES = ['blacklist', 'bulk', 'cooldown'] as const;
export type Capability = typeof CAPABILITIES[number];
export type Actor = {
  guildId: string;
  channelId: string;
  userId: string;
  isAdmin: boolean;
  roleIds: string[];
};
export type Settings = {
  balanceAlerts?: BalanceAlertConfig;
  enabled: boolean;
  pauseReason: string | null;
  amountWei: string;
  cooldownMs: number;
  autoClaim: boolean;
  maxPayoutWei: string;
  maxBatchTotalWei: string;
  maxDailyTotalWei: string;
  maxBatchRows: number;
};
export type BalanceAlertConfig = {
  version:string;enabled:boolean;channelId:string|null;thresholdWei:string;
  userIds:string[];roleIds:string[];repeatMs:number;
};
export type BalanceAlertEvent = {id:string;createdAt:number;balanceWei:string};
export type BalanceAlertState = {configVersion:string;low:boolean;lastSentAt:number|null;pending:BalanceAlertEvent|null};
export type PayoutStatus = 'queued' | 'signed' | 'broadcast' | 'confirmed' | 'failed' | 'cancelled' | 'review';
export type Payout = {
  id: string;
  guildId: string;
  requestKey: string;
  batchId: string | null;
  kind: 'claim' | 'bulk';
  userId: string;
  channelId: string;
  address: string;
  amountWei: string;
  cooldownMs: number;
  status: PayoutStatus;
  rawTx: string | null;
  txHash: string | null;
  nonce: number | null;
  createdAt: number;
  updatedAt: number;
  confirmedAt: number | null;
  errorCode: string | null;
  noticeStatus: string | null;
  noticeAttempts: number;
  noticeAfter: number;
};
export type Draft = {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  addresses: string[];
  amountWei: string;
  cooldownMs: number;
  customCooldown: boolean;
  createdAt: number;
  expiresAt: number;
  state: 'open' | 'queued' | 'cancelled';
};

export class FaucetError extends Error {
  constructor(public code: string, message: string, public retryAt?: number) {
    super(message);
    this.name = 'FaucetError';
  }
}

export function addressKey(input: string): string {
  try {
    const address = getAddress(input.trim());
    if (address === ZeroAddress) throw new Error();
    return address.toLowerCase();
  } catch {
    throw new FaucetError('INVALID_ADDRESS', 'A valid, non-zero EVM wallet address is required.');
  }
}

export function amountWei(input: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(input.trim()) || input.length > 60) {
    throw new FaucetError('INVALID_AMOUNT', 'Use a positive decimal amount with at most 18 decimal places.');
  }
  const value = parseUnits(input.trim(), 18);
  if (value <= 0n) throw new FaucetError('INVALID_AMOUNT', 'The amount must be greater than zero.');
  return value.toString();
}

export function hoursMs(hours: number): number {
  if (!Number.isFinite(hours) || hours < 0.01 || hours > 8760) {
    throw new FaucetError('INVALID_HOURS', 'Hours must be between 0.01 and 8760 (one year).');
  }
  return Math.round(hours * HOURS);
}

export function tokens(value: string | bigint): string { return formatUnits(value, 18); }
export function shortAddress(value: string): string { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
export function txUrl(base: string, hash: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new FaucetError('INVALID_HASH', 'Invalid transaction hash.');
  return `${base.replace(/\/$/, '')}/tx/${hash}`;
}

export function safeError(error: unknown): string {
  if (error instanceof FaucetError) return `${error.code}: ${error.message}`;
  return 'UNEXPECTED_ERROR: An unexpected error occurred. Secrets and RPC payloads are omitted.';
}

export function extractAddresses(content: string): string[] {
  return [...new Set(content.match(/\b0x[a-fA-F0-9]{40}\b/g) ?? [])];
}
