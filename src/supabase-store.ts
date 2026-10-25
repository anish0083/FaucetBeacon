import { FaucetError, type Actor, type BalanceAlertState, type Capability, type Draft, type Payout, type Settings } from './domain.js';
import type { PreparedTransfer } from './chain/transfers.js';
import { setTimeout as delay } from 'node:timers/promises';

export type WorkerLease = { owner: string; generation: number; expiresAt: number };
export type BlacklistEntry = { address: string; until: number; reason: string; actorId: string };
export type DiscordNoticeKind = 'progress' | 'confirmed' | 'failed' | 'cancelled' | 'review';
export type DiscordMessageRef = {channelId:string;messageId:string};
export type SupabaseOptions = { url: string; key: string; timeoutMs?: number; fetch?: typeof fetch; guildId?: string; guildIds?: string[]; sleep?:(ms:number)=>Promise<void> };

/** Supabase is authoritative. There is no local database or offline payout fallback. */
export class SupabaseStore {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  constructor(private readonly options: SupabaseOptions) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new FaucetError('CONFIG', 'SUPABASE_URL must be an HTTPS project URL without credentials, path or query parameters.');
    }
    if (!options.key || options.key.startsWith('sb_publishable_')) {
      throw new FaucetError('DATABASE_AUTH', 'Configure a server-only Supabase secret key or service_role key. Publishable keys cannot operate this faucet.');
    }
    this.baseUrl = url.origin;
    this.fetcher = options.fetch ?? fetch;
  }

  forGuild(guildId: string): SupabaseStore { return new SupabaseStore({ ...this.options, guildId }); }

  private async call<T>(operation: 'read' | 'write', action: string, payload: Record<string, unknown>): Promise<T> {
    const actor = payload.actor as Actor | undefined;
    if (this.options.guildId && ((actor && actor.guildId !== this.options.guildId) || (payload.guildId && payload.guildId !== this.options.guildId))) {
      throw new FaucetError('WRONG_SERVER', 'This operation belongs to another Discord server.');
    }
    const scopedPayload = this.options.guildId ? { ...payload, guildId: this.options.guildId } : payload;
    return this.request<T>(`rpc/faucet_${operation}`,'POST',{p_action:action,p_payload:scopedPayload},operation==='read');
  }

  private async request<T>(path:string,method:'GET'|'POST',body?:unknown,retryable=method==='GET'):Promise<T> {
    for (let attempt=0;;attempt++) {
      try {return await this.requestOnce<T>(path,method,body);}
      catch (error) {
        // Only reads can be replayed here. A failed write response may have committed.
        if (!retryable || attempt>=2 || !(error instanceof FaucetError) || error.code!=='DATABASE_UNAVAILABLE') throw error;
        await (this.options.sleep??delay)(200*2**attempt+Math.floor(Math.random()*100));
      }
    }
  }

  private async requestOnce<T>(path:string,method:'GET'|'POST',body?:unknown):Promise<T> {
    let response: Response;
    let data: unknown;
    try {
      response = await this.fetcher(`${this.baseUrl}/rest/v1/${path}`, {
        method,
        headers: {
          apikey: this.options.key,
          // Modern sb_secret keys are resolved by the API gateway, not JWTs.
          ...(this.options.key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${this.options.key}` }),
          'Content-Type': 'application/json',
          ...(!path.startsWith('rpc/') && method==='POST'?{Prefer:'return=minimal'}:{}),
        },
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000),
        redirect: 'error',
      });
      const bodyText=await response.text();
      // PostgREST INSERT with return=minimal succeeds with HTTP 201 and no body.
      // RPC reads, unlike these inserts, must still provide a JSON response.
      data = bodyText.trim() ? JSON.parse(bodyText) : undefined;
      if (response.ok && path.startsWith('rpc/') && data===undefined) throw new Error('Missing RPC response');
    } catch {
      // Writes may have committed before a network timeout. Do not replay them blindly.
      throw new FaucetError('DATABASE_UNAVAILABLE', 'Supabase is unavailable. Payouts wait for the database to recover.');
    }
    if (!response.ok) {
      if ([408,429,500,502,503,504].includes(response.status)) throw new FaucetError('DATABASE_UNAVAILABLE','The database is temporarily busy. Saved payouts will resume automatically.');
      const error = (data && typeof data === 'object' ? data : {}) as { code?: string; message?: string; details?: string };
      if (response.status === 401 || response.status === 403) {
        throw new FaucetError('DATABASE_AUTH', 'Supabase rejected the server credential. Check the local secret/service_role key and database grants.');
      }
      if (error.code === 'PGRST202') {
        throw new FaucetError('DATABASE_SCHEMA', 'The FaucetBot schema is not installed. Apply supabase/schema.sql before starting the bot.');
      }
      if (error.code === 'P0001' && error.message && /^[A-Z][A-Z_]{1,60}$/.test(error.message)) {
        let details: { message?: unknown; retryAt?: unknown } = {};
        try { details = JSON.parse(error.details ?? '{}') as typeof details; } catch { /* No raw SQL errors in Discord. */ }
        throw new FaucetError(error.message,
          typeof details.message === 'string' ? details.message.slice(0,500) : 'The database declined this operation.',
          typeof details.retryAt === 'number' && Number.isSafeInteger(details.retryAt) ? details.retryAt : undefined);
      }
      throw new FaucetError('DATABASE_QUERY', 'The database rejected an operation. Check the FaucetBot schema and database logs.');
    }
    return data as T;
  }

  read<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> { return this.call('read', action, payload); }
  write<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> { return this.call('write', action, payload); }
  health(): Promise<{ schemaVersion: number; initialized: boolean; serverTime: number }> { return this.read('health'); }
  initialize(guildId: string, wallet: string, chainId: number, settings: Settings): Promise<void> {
    return this.write('initialize', { guildId, wallet: wallet.toLowerCase(), chainId, settings });
  }
  settings(): Promise<Settings> { return this.read('settings'); }
  controlVersion(): Promise<number> { return this.read('control-version'); }
  channels(): Promise<string[]> { return this.read('channels'); }
  isChannelAllowed(id: string): Promise<boolean> { return this.read('channel-allowed', { id }); }
  rolePermissions(): Promise<{ roleId: string; capability: Capability }[]> { return this.read('roles'); }
  hasPermission(roleIds: string[], capability: Capability): Promise<boolean> { return this.read('has-permission', { roleIds, capability }); }
  blacklist(address: string): Promise<BlacklistEntry | null> { return this.read('blacklist', { address }); }
  blacklistEntries(): Promise<BlacklistEntry[]> { return this.read('blacklist-list'); }
  cooldown(kind: 'address' | 'user', subject: string): Promise<number> { return this.read('cooldown', { kind, subject }); }
  payout(id: string): Promise<Payout | null> { return this.read('payout', { id }); }
  findRequest(key: string): Promise<Payout | null> { return this.read('request', { key }); }
  nextQueued(): Promise<Payout | null> { return this.read('next', this.options.guildIds ? { guildIds: this.options.guildIds } : {}); }
  inFlight(): Promise<Payout | null> { return this.read('inflight'); }
  pending(): Promise<Payout[]> { return this.read('pending'); }
  countPending(): Promise<number> { return this.read('pending-count'); }
  async spentAndReserved(): Promise<bigint> { return BigInt(await this.read<string>('spent')); }
  draft(id: string): Promise<Draft | null> { return this.read('draft', { id }); }
  batch(id: string): Promise<Payout[]> { return this.read('batch', { id }); }
  assertQueuedEligible(id: string, actor: Actor): Promise<void> { return this.read('eligible', { id, actor }); }

  claim(actor: Actor, address: string, requestKey: string, automatic: boolean): Promise<Payout> {
    return this.write('claim', { actor, address, requestKey, automatic });
  }
  createBatch(actor: Actor, addresses: string[], amountWei: string, cooldownMs?: number): Promise<Draft> {
    return this.write('draft-create', { actor, addresses, amountWei, cooldownMs });
  }
  confirmBatch(actor: Actor, id: string): Promise<Payout[]> { return this.write('draft-confirm', { actor, id }); }
  cancelBatch(actor: Actor, id: string): Promise<void> { return this.write('draft-cancel', { actor, id }); }
  changeSettings(actor: Actor, patch: Partial<Settings>, capability?: 'cooldown', expectedVersion?: number): Promise<Settings> {
    return this.write('settings', { actor, patch, capability, expectedVersion });
  }
  channel(actor: Actor, channelId: string, allowed: boolean): Promise<void> { return this.write('channel', { actor, channelId, allowed }); }
  role(actor: Actor, roleId: string, capability: Capability, grant: boolean): Promise<void> { return this.write('role', { actor, roleId, capability, grant }); }
  setBlacklist(actor: Actor, address: string, durationMs: number, reason: string): Promise<number> {
    return this.write('blacklist-add', { actor, address, durationMs, reason });
  }
  removeBlacklist(actor: Actor, address: string): Promise<void> { return this.write('blacklist-remove', { actor, address }); }
  cancelQueued(actor: Actor, id: string): Promise<void> { return this.write('admin-cancel', { actor, id }); }

  acquireLease(owner: string): Promise<WorkerLease | null> { return this.write('lease', { owner }); }
  releaseLease(lease: WorkerLease): Promise<void> { return this.write('lease-release', { lease }); }
  verifyLease(lease: WorkerLease): Promise<void> { return this.read('lease-valid', { lease }); }
  saveSigned(id: string, prepared: PreparedTransfer, actor: Actor, lease: WorkerLease): Promise<Payout> {
    return this.write('save-signed', { id, prepared, actor, lease });
  }
  cancelIneligible(id: string, code: string, failed: boolean, lease: WorkerLease): Promise<void> {
    return this.write('worker-cancel', { id, code, failed, lease });
  }
  pause(code: string, lease: WorkerLease): Promise<void> { return this.write('worker-pause', { code, lease }); }
  markPayout(id: string, status: 'broadcast' | 'review', code: string | null, lease: WorkerLease): Promise<void> {
    return this.write('worker-mark', { id, status, code, lease });
  }
  finishPayout(payout: Payout, success: boolean, lease: WorkerLease): Promise<void> {
    return this.write('finish', { id: payout.id, txHash: payout.txHash, success, lease });
  }
  notifications(lease: WorkerLease): Promise<Payout[]> { return this.read('notifications', { lease }); }
  markNotice(payout: Payout, delivered: boolean, lease: WorkerLease): Promise<void> {
    return this.write('notice', { id: payout.id, status: payout.status, delivered, lease });
  }

  private assertMessageScope(job:Payout):void {
    if (!this.options.guildId || this.options.guildId!==job.guildId) throw new FaucetError('WRONG_SERVER','Discord message references require the payout’s server scope.');
  }
  async discordMessage(job:Payout,kind:DiscordNoticeKind):Promise<DiscordMessageRef|null> {
    this.assertMessageScope(job);
    const query=new URLSearchParams({select:'details',guild_id:`eq.${job.guildId}`,target:`eq.${job.id}`,action:`eq.discord-${kind}`,order:'id.desc',limit:'1'});
    const rows=await this.request<{details:DiscordMessageRef}[]>(`faucet_audit?${query}`,'GET');
    const ref=rows[0]?.details;
    if (!ref) return null;
    if (ref.channelId!==job.channelId || !/^\d{17,20}$/.test(ref.messageId)) throw new FaucetError('DATABASE_QUERY','The saved Discord message does not match this payout channel.');
    return ref;
  }
  async saveDiscordMessage(job:Payout,kind:DiscordNoticeKind,ref:DiscordMessageRef):Promise<void> {
    this.assertMessageScope(job);
    if (ref.channelId!==job.channelId || !/^\d{17,20}$/.test(ref.messageId)) throw new FaucetError('DISCORD_DELIVERY','Invalid payout message reference.');
    // Existing backend-only audit storage keeps message recovery durable across restarts.
    await this.request('faucet_audit','POST',{guild_id:job.guildId,actor_id:'system',action:`discord-${kind}`,target:job.id,details:ref});
  }
  async balanceAlertState():Promise<BalanceAlertState|null> {
    if (!this.options.guildId) throw new FaucetError('WRONG_SERVER','Balance alerts require a server scope.');
    const query=new URLSearchParams({select:'details',guild_id:`eq.${this.options.guildId}`,action:'eq.balance-alert-state',target:'eq.funding-wallet',order:'id.desc',limit:'1'});
    const rows=await this.request<{details:BalanceAlertState}[]>(`faucet_audit?${query}`,'GET');
    return rows[0]?.details??null;
  }
  async saveBalanceAlertState(state:BalanceAlertState,lease:WorkerLease):Promise<void> {
    if (!this.options.guildId) throw new FaucetError('WRONG_SERVER','Balance alerts require a server scope.');
    await this.verifyLease(lease);
    await this.request('faucet_audit','POST',{guild_id:this.options.guildId,actor_id:'system',action:'balance-alert-state',target:'funding-wallet',details:state});
  }
}

export type FaucetDatabase = Pick<SupabaseStore, keyof SupabaseStore>;
