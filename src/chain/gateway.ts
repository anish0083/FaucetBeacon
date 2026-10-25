import { SiweMessage } from 'siwe';
import { getAddress, type Wallet } from 'ethers';
import { setTimeout as delay } from 'node:timers/promises';
import { FaucetError } from '../domain.js';

type JsonObject = Record<string, unknown>;
export type GatewayOptions = {
  baseUrl: string; chainId: number; siweDomain: string; timeoutMs: number;
  wallet: Pick<Wallet,'address'|'signMessage'>;
  fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number;
};
export class GatewayError extends FaucetError {
  constructor(code: string, message: string, public rpcCode?: number | string, public alreadyKnown = false, public nonceTooLow = false) { super(code,message); }
}
function object(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  throw new GatewayError('RPC_SCHEMA','The gateway returned an unexpected response format.');
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new GatewayError('RPC_SCHEMA',`The gateway response is missing ${field}.`);
  return value;
}
function unwrap(payload: unknown): unknown {
  const body = object(payload);
  return 'result' in body ? body.result : body;
}
export function validateChallenge(message: string, challengeId: string, options: Pick<GatewayOptions,'wallet'|'chainId'|'siweDomain'|'baseUrl'>, now: number): void {
  // Interlink's gateway uses "Interlink account" in the SIWE header.
  // Normalize ONLY for parsing/validation; sign the exact original bytes below.
  const prefix = `${options.siweDomain} wants you to sign in with your Interlink account:`;
  const normalized = message.startsWith(prefix) ? message.replace(prefix,`${options.siweDomain} wants you to sign in with your Ethereum account:`) : message;
  try {
    const parsed = new SiweMessage(normalized);
    const expiry = parsed.expirationTime ? Date.parse(parsed.expirationTime) : NaN;
    const issued = Date.parse(parsed.issuedAt??'');
    const expectedUri = `${options.baseUrl.replace(/\/$/,'')}/auth/verify`;
    if (parsed.domain !== options.siweDomain || getAddress(parsed.address) !== getAddress(options.wallet.address)
      || parsed.chainId !== options.chainId || parsed.version !== '1'
      || parsed.nonce !== challengeId || parsed.requestId !== challengeId || parsed.uri !== expectedUri
      || !Number.isFinite(expiry) || expiry <= now || expiry > now+10*60_000
      || !Number.isFinite(issued) || issued > now+30_000 || issued < now-5*60_000
      || (parsed.notBefore && Date.parse(parsed.notBefore)>now)) throw new Error();
  } catch { throw new GatewayError('AUTH_CHALLENGE','The SIWE challenge did not match this wallet, chain, domain or validity window. Nothing was signed.'); }
}

export class InterlinkGateway {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;
  private authPromise: Promise<void> | null = null;
  private authLocked = false;
  private id = 0;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms:number) => Promise<void>;
  private readonly random: () => number;
  constructor(private readonly options: GatewayOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (async ms => { await delay(ms); });
    this.random = options.random ?? Math.random;
  }
  private clearTokens(): void { this.accessToken=null; this.refreshToken=null; this.expiresAt=0; }
  resetAuthentication(): void {
    if (this.authPromise) throw new GatewayError('AUTH_BUSY','A gateway login is already in progress. Try again shortly.');
    this.clearTokens(); this.authLocked=false;
  }
  private async request(path: string, body: unknown, token?: string, requestId?: number): Promise<unknown> {
    for (let attempt=0; attempt<4; attempt++) {
      let response: Response;
      let payload: unknown;
      try {
        response = await this.fetcher(`${this.options.baseUrl.replace(/\/$/,'')}${path}`, {
          method:'POST', headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
          body:JSON.stringify(body),signal:AbortSignal.timeout(this.options.timeoutMs),redirect:'error',
        });
        if (response.status === 401) throw new GatewayError('AUTH_401','The gateway rejected the access token.');
        if (response.status === 429) {
          if (attempt === 3) throw new GatewayError('RATE_LIMITED','The gateway rate limit is still active. The queue will retry later.');
          const retryHeader = response.headers.get('retry-after');
          const retrySeconds = Number(retryHeader);
          const retryMs = retryHeader && Number.isFinite(retrySeconds) ? retrySeconds*1000 : 0;
          await response.body?.cancel();
          await this.sleep(Math.min(15000,Math.max(retryMs,500*2**attempt))+Math.floor(this.random()*400));
          continue;
        }
        payload = await response.json();
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError('RPC_NETWORK','The gateway could not be reached or returned unreadable data. No automatic replacement transaction will be created.');
      }
      const envelope = object(payload);
      if (envelope.error) {
        const error = object(envelope.error);
        const detail = error.data && typeof error.data === 'object' ? object(error.data) : {};
        const description = `${String(error.message ?? '')} ${String(detail.reason ?? '')} ${String(detail.key ?? '')}`.toLowerCase();
        if (/rate.?limit/.test(description) && attempt<3) { await this.sleep(500*2**attempt+Math.floor(this.random()*400)); continue; }
        if (/rate.?limit/.test(description)) throw new GatewayError('RATE_LIMITED','The gateway rate limit is still active. The queue will retry later.');
        // Do not expose raw provider messages: some providers echo signed transactions or headers.
        const code = typeof error.code==='number' || typeof error.code==='string' ? error.code : undefined;
        throw new GatewayError('RPC_REJECTED',`The gateway rejected the ${path === '/rpc' ? 'RPC' : 'authentication'} request.`,code,/already known|known transaction/.test(description),/nonce too low|nonce has already/.test(description));
      }
      if (!response.ok) throw new GatewayError(response.status>=500?'RPC_NETWORK':'RPC_HTTP',`The gateway returned HTTP ${response.status}.`);
      if (requestId !== undefined && (envelope.id !== requestId || envelope.jsonrpc !== '2.0' || !('result' in envelope))) throw new GatewayError('RPC_SCHEMA','The JSON-RPC response did not match the request.');
      return unwrap(payload);
    }
    throw new GatewayError('RATE_LIMITED','The gateway is busy.');
  }
  private acceptTokens(raw: unknown): void {
    const payload = object(raw);
    const accessToken = string(payload.accessToken,'accessToken');
    const refreshToken = string(payload.refreshToken,'refreshToken');
    const lifetime = Number(payload.accessTokenExpiresInSec);
    if (!Number.isFinite(lifetime) || lifetime<=0 || lifetime>86400) throw new GatewayError('AUTH_SCHEMA','The gateway returned an invalid access-token lifetime.');
    if (payload.walletAddress && String(payload.walletAddress).toLowerCase()!==this.options.wallet.address.toLowerCase()) throw new GatewayError('AUTH_WALLET','The gateway session belongs to a different wallet.');
    this.accessToken=accessToken; this.refreshToken=refreshToken;
    this.expiresAt=this.now()+lifetime*1000;
  }
  private async login(): Promise<void> {
    const payload = object(await this.request('/auth/challenge',{walletAddress:this.options.wallet.address,chainId:String(this.options.chainId)}));
    const message = string(payload.messageToSign,'messageToSign');
    const challengeId = string(payload.challengeId,'challengeId');
    validateChallenge(message,challengeId,this.options,this.now());
    const signature = await this.options.wallet.signMessage(message);
    this.acceptTokens(await this.request('/auth/verify',{walletAddress:this.options.wallet.address,challengeId,signature}));
  }
  private async authenticate(forceRefresh = false): Promise<void> {
    if (this.authLocked) throw new GatewayError('AUTH_LOCKED','Gateway authentication stopped after a failed refresh. An admin must restart the faucet to sign in again.');
    if (this.authPromise) return this.authPromise;
    if (!forceRefresh && this.accessToken && this.expiresAt>this.now()+60_000) return;
    this.authPromise=(async () => {
      try {
        if (this.refreshToken) this.acceptTokens(await this.request('/auth/refresh',{refreshToken:this.refreshToken}));
        else await this.login();
      } catch (error) {
        this.clearTokens(); this.authLocked=true;
        if (error instanceof GatewayError && error.code==='AUTH_CHALLENGE') throw error;
        throw new GatewayError('AUTH_LOCKED','Gateway authentication failed. Tokens were cleared; an admin must restart the faucet after checking the gateway.');
      }
    })();
    try { await this.authPromise; } finally { this.authPromise=null; }
  }
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    await this.authenticate();
    let token=this.accessToken!;
    for (let attempt=0; attempt<2; attempt++) {
      const id=++this.id;
      try { return await this.request('/rpc',{jsonrpc:'2.0',id,method,params},token,id) as T; }
      catch (error) {
        if (!(error instanceof GatewayError) || error.code!=='AUTH_401') throw error;
        if (attempt===1) { this.clearTokens(); this.authLocked=true; throw new GatewayError('AUTH_LOCKED','The refreshed gateway session was rejected. The faucet needs an admin restart.'); }
        if (token===this.accessToken) await this.authenticate(true);
        else await this.authenticate();
        token=this.accessToken!;
      }
    }
    throw new GatewayError('AUTH_LOCKED','Gateway authentication is unavailable.');
  }
  async initialize(): Promise<void> {
    const value = await this.rpc<string>('eth_chainId',[]);
    let chain: bigint;
    try { chain=BigInt(value); } catch { throw new GatewayError('CHAIN_ID','The gateway returned an invalid chain ID.'); }
    if (chain!==BigInt(this.options.chainId)) throw new GatewayError('CHAIN_ID',`Expected chain ${this.options.chainId}, but the gateway reports ${chain}. No transfers were signed.`);
  }
}
