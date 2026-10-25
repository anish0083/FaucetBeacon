import 'dotenv/config';
import { isHexString, Wallet } from 'ethers';
import { amountWei, FaucetError, hoursMs, type Settings } from './domain.js';

export type Config = ReturnType<typeof loadConfig>;
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new FaucetError('CONFIG', `${key} is missing. Copy .env.example to .env and configure it locally.`);
  return value;
}
function number(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new FaucetError('CONFIG', `${key} is outside its supported range.`);
  return value;
}
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = number(env, key, fallback, min, max);
  if (!Number.isSafeInteger(value)) throw new FaucetError('CONFIG', `${key} must be an integer.`);
  return value;
}
function httpsUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  try {
    const url = new URL(env[key] || fallback);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/$/, '');
  } catch { throw new FaucetError('CONFIG', `${key} must be an HTTPS URL without credentials or query parameters.`); }
}
export function discordGuildIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawGuilds = env.DISCORD_GUILD_IDS?.trim() || required(env, 'DISCORD_GUILD_ID');
  const guildIds = [...new Set(rawGuilds.split(/[\s,]+/).filter(Boolean))];
  if (!guildIds.length || !guildIds.every(v => /^\d{17,20}$/.test(v))) throw new FaucetError('CONFIG', 'Set DISCORD_GUILD_IDS to a comma-separated allowlist of valid Discord server IDs.');
  return guildIds;
}
export function discordConfig(env: NodeJS.ProcessEnv = process.env) {
  const token = required(env, 'DISCORD_TOKEN');
  const clientId = required(env, 'DISCORD_CLIENT_ID');
  const guildIds = discordGuildIds(env);
  if (!/^\d{17,20}$/.test(clientId)) throw new FaucetError('CONFIG', 'DISCORD_CLIENT_ID must be a valid Discord application ID.');
  return { token, clientId, guildIds, guildId: guildIds[0]! };
}
export function supabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const key = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new FaucetError('CONFIG', 'Set SUPABASE_SECRET_KEY locally in .env using the FaucetBot server secret key.');
  return {
    url: httpsUrl(env, 'SUPABASE_URL', 'https://pypehbsuhuhnutxkphyf.supabase.co'), key,
    timeoutMs: integer(env, 'SUPABASE_TIMEOUT_MS', 15000, 1000, 30000),
  };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const privateKey = required(env, 'FAUCET_PRIVATE_KEY');
  if (!isHexString(privateKey, 32)) throw new FaucetError('CONFIG', 'FAUCET_PRIVATE_KEY must be a 32-byte hexadecimal private key.');
  let wallet: Wallet;
  try { wallet = new Wallet(privateKey); } catch { throw new FaucetError('CONFIG', 'FAUCET_PRIVATE_KEY is invalid.'); }
  const initialSettings: Settings = {
    enabled: false,
    pauseReason: 'First run: approve a channel, review the amount, then start the faucet.',
    amountWei: amountWei(env.DEFAULT_AMOUNT || '0.1'),
    cooldownMs: hoursMs(number(env, 'DEFAULT_COOLDOWN_HOURS', 6, 0.01, 8760)),
    autoClaim: (env.AUTO_CLAIM ?? 'true') === 'true',
    maxPayoutWei: amountWei(env.MAX_PAYOUT_AMOUNT || '10'),
    maxBatchTotalWei: amountWei(env.MAX_BATCH_TOTAL || '100'),
    maxDailyTotalWei: amountWei(env.MAX_DAILY_TOTAL || '1000'),
    maxBatchRows: integer(env, 'MAX_BATCH_ROWS', 100, 1, 1000),
  };
  if (BigInt(initialSettings.amountWei) > BigInt(initialSettings.maxPayoutWei)) throw new FaucetError('CONFIG', 'DEFAULT_AMOUNT exceeds MAX_PAYOUT_AMOUNT.');
  if (!/^[a-zA-Z0-9_-]{1,16}$/.test(env.TOKEN_SYMBOL || 'tITL')) throw new FaucetError('CONFIG', 'TOKEN_SYMBOL must be a short alphanumeric symbol.');
  return {
    discord: discordConfig(env), wallet, initialSettings, supabase: supabaseConfig(env),
    requests: {
      concurrency:integer(env,'REQUEST_CONCURRENCY',8,1,32),
      queueLimit:integer(env,'REQUEST_QUEUE_LIMIT',100,0,1000),
      waitMs:integer(env,'REQUEST_QUEUE_WAIT_MS',60000,1000,120000),
    },
    chainId: integer(env, 'CHAIN_ID', 19042026, 1, Number.MAX_SAFE_INTEGER),
    rpcBaseUrl: httpsUrl(env, 'RPC_BASE_URL', 'https://evm-rpc.test-net.interlinklabs.ai/v1'),
    explorerUrl: httpsUrl(env, 'EXPLORER_URL', 'https://explorer.test-net.interlinklabs.ai'),
    symbol: env.TOKEN_SYMBOL || 'tITL',
    siweDomain: env.SIWE_DOMAIN || 'interlinklabs.ai',
    confirmations: integer(env, 'CONFIRMATIONS', 3, 1, 12),
    maxFeePerGas: BigInt(amountWei(env.MAX_FEE_PER_GAS_GWEI || '100')) / 1_000_000_000n,
    maxGasLimit: BigInt(integer(env, 'MAX_GAS_LIMIT', 100000, 21000, 1000000)),
    rpcTimeoutMs: integer(env, 'RPC_TIMEOUT_MS', 15000, 1000, 60000),
    pollIntervalMs: integer(env, 'POLL_INTERVAL_MS', 5000, 2000, 60000),
  };
}
