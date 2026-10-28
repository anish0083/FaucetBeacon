import { DefaultRestOptions, Events, type Client } from 'discord.js';
import { FaucetError } from '../domain.js';
import type { StartupStage } from '../runtime-health.js';

const networkCodes = new Set(['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','AbortError']);

/** Keep useful failure categories without logging Discord request bodies or tokens. */
export function discordLoginError(error: unknown): FaucetError {
  const info = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  if (info?.status === 401 || info?.code === 'TokenInvalid') return new FaucetError('DISCORD_TOKEN','Discord rejected the bot token. Check DISCORD_TOKEN on the deployed service.');
  if (info?.status === 403) return new FaucetError('DISCORD_FORBIDDEN','Discord denied the gateway API request from this host. Check the deployed host network and Discord access.');
  if (info?.status === 429) return new FaucetError('DISCORD_RATE_LIMIT','Discord rate limited the gateway API request. Check the retry delay in DISCORD_API logs.');
  if (typeof info?.status === 'number' && info.status >= 500 && info.status < 600) return new FaucetError('DISCORD_UNAVAILABLE',`Discord gateway discovery returned HTTP ${info.status}.`);
  if (info?.message === 'Used disallowed intents' || info?.message === 'Used invalid intents') return new FaucetError('DISCORD_INTENTS','Discord rejected the requested gateway intents. Enable Message Content Intent in the developer portal.');
  if (typeof info?.message === 'string' && info.message.startsWith('Not enough sessions remaining to spawn ')) return new FaucetError('DISCORD_SESSION_LIMIT','Discord bot login sessions are exhausted. Wait for the session limit to reset before deploying again.');
  for (const code of [info?.code, info?.cause?.code, info?.name]) {
    if (typeof code === 'string' && networkCodes.has(code)) return new FaucetError('DISCORD_NETWORK',`Discord connection failed (${code}). Check the deployed host network and DNS.`);
  }
  return new FaucetError('DISCORD_LOGIN','Discord login failed. Check the preceding DISCORD_API and DISCORD_GATEWAY logs.');
}

/** Observe the existing REST transport; do not add requests or change rate-limit waits. */
export function discordGatewayRequest(log: (message: string) => void = console.log,
  request: typeof DefaultRestOptions.makeRequest = DefaultRestOptions.makeRequest): typeof request {
  return async (url, options) => {
    const target = new URL(url);
    const gateway = target.hostname === 'discord.com' && target.pathname === '/api/v10/gateway/bot';
    if (gateway) log('DISCORD_API: Requesting bot gateway information.');
    try {
      const response = await request(url, options);
      if (gateway) {
        const retry = response.headers.get('retry-after');
        const seconds = retry === null ? NaN : Number(retry);
        const wait = Number.isFinite(seconds) && seconds >= 0 ? ` Retry after ${Math.ceil(seconds)} seconds.` : '';
        log(`DISCORD_API: Gateway information returned HTTP ${response.status}.${wait}`);
        if (response.status === 429) log('DISCORD_RATE_LIMIT: Gateway discovery is waiting for Discord to allow requests from this host.');
      }
      return response;
    } catch (error) {
      if (gateway) { const failure = discordLoginError(error); log(`${failure.code}: ${failure.message}`); }
      throw error;
    }
  };
}

/** Emit fixed labels only. Raw discord.js debug output can contain credentials. */
export function attachDiscordStartupDiagnostics(client: Client, setStage: (stage: StartupStage) => void,
  log: (message: string) => void = console.log): () => void {
  const debug = (message: string) => {
    const text = /^\[WS => (?:Manager|Shard \d+)\] ([^\r\n]+)/.exec(message)?.[1];
    if (!text) return;
    if (text === 'Fetched Gateway Information') {
      setStage('discord_gateway');log('DISCORD_GATEWAY: Bot gateway information received.');
    } else if (text.startsWith('Connecting to ')) log('DISCORD_GATEWAY: Opening the gateway WebSocket.');
    else if (text.startsWith('Waiting for event hello ')) log('DISCORD_GATEWAY: Waiting for the gateway hello packet.');
    else if (text === 'Waiting for identify throttle') log('DISCORD_GATEWAY: Waiting for the login identification slot.');
    else if (text === 'Identifying') {setStage('discord_ready');log('DISCORD_GATEWAY: Sending bot identification; waiting for ready.');}
    else if (text === 'Failed to connect to the gateway URL specified due to a network error') log('DISCORD_GATEWAY: WebSocket connection failed with a network error.');
  };
  client.on(Events.Debug, debug);
  return () => client.removeListener(Events.Debug, debug);
}
