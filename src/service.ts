import { addressKey, amountWei, FaucetError, hoursMs, type Actor, type Capability, type Draft, type Payout, type Settings } from './domain.js';
import type { FaucetDatabase } from './supabase-store.js';

/** Discord identity is verified by the bot; atomic payout rules run in Postgres. */
export class FaucetService {
  constructor(readonly store: FaucetDatabase, readonly guildId: string, readonly fundingAddress: string) {}
  assertGuild(actor: Actor): void {
    if (actor.guildId !== this.guildId) throw new FaucetError('WRONG_SERVER', 'This faucet is configured for another Discord server.');
  }
  assertAdmin(actor: Actor): void {
    this.assertGuild(actor);
    if (!actor.isAdmin) throw new FaucetError('ADMIN_REQUIRED', 'Administrator permission is required.');
  }
  async assertCapability(actor: Actor, capability: Capability): Promise<void> {
    this.assertGuild(actor);
    if (!actor.isAdmin && !await this.store.hasPermission(actor.roleIds, capability)) {
      throw new FaucetError('PERMISSION_REQUIRED', `An admin must grant your role the ${capability} permission first.`);
    }
  }
  async assertChannel(actor: Actor): Promise<void> {
    this.assertGuild(actor);
    if (!await this.store.isChannelAllowed(actor.channelId)) throw new FaucetError('CHANNEL_NOT_APPROVED', 'Claims work only in admin-approved channels.');
  }
  async assertEnabled(): Promise<void> {
    if (!(await this.store.settings()).enabled) throw new FaucetError('PAUSED', 'The faucet is paused.');
  }
  claim(actor: Actor, rawAddress: string, requestKey: string, automatic = false): Promise<Payout> {
    this.assertGuild(actor);
    const address = addressKey(rawAddress);
    if (address === this.fundingAddress.toLowerCase()) throw new FaucetError('SELF_TRANSFER', 'The funding wallet cannot claim from itself.');
    return this.submitClaim(actor,address,requestKey,automatic);
  }
  private async submitClaim(actor:Actor,address:string,requestKey:string,automatic:boolean):Promise<Payout> {
    try {return await this.store.claim(actor, address, requestKey, automatic);}
    catch (error) {
      if (!(error instanceof FaucetError) || error.code!=='DATABASE_UNAVAILABLE') throw error;
      // Recover the outcome by the original Discord request ID; never create a new claim.
      try {
        const saved=await this.store.findRequest(requestKey);
        if (saved && saved.guildId===actor.guildId && saved.userId===actor.userId && saved.address===address && saved.requestKey===requestKey) return saved;
      } catch { /* A still-unknown write is not a confirmed rejection. */ }
      throw new FaucetError('CLAIM_UNCERTAIN','The database response was delayed, so we are checking this request. If it was accepted, its payment status will appear here automatically. Please do not resend it yet.');
    }
  }
  createBatch(actor: Actor, rawAddresses: string[], rawAmount: string, cooldownHours?: number): Promise<Draft> {
    this.assertGuild(actor);
    return this.store.createBatch(actor, [...new Set(rawAddresses.map(addressKey))], amountWei(rawAmount), cooldownHours === undefined ? undefined : hoursMs(cooldownHours));
  }
  confirmBatch(actor: Actor, id: string): Promise<Payout[]> { this.assertGuild(actor); return this.store.confirmBatch(actor, id); }
  cancelBatch(actor: Actor, id: string): Promise<void> { this.assertGuild(actor); return this.store.cancelBatch(actor, id); }
  assertQueuedEligible(payout: Payout, actor: Actor): Promise<void> {
    this.assertGuild(actor);
    if (payout.guildId !== this.guildId) throw new FaucetError('WRONG_SERVER', 'This payout belongs to another Discord server.');
    return this.store.assertQueuedEligible(payout.id, actor);
  }
  changeSettings(actor: Actor, patch: Partial<Settings>, capability?: 'cooldown', expectedVersion?: number): Promise<Settings> {
    this.assertGuild(actor);
    if (!capability) this.assertAdmin(actor);
    if (capability && Object.keys(patch).some(key => key !== 'cooldownMs')) throw new FaucetError('PERMISSION_REQUIRED', 'Only the delegated cooldown setting can be changed.');
    return this.store.changeSettings(actor, patch, capability, expectedVersion);
  }
  setBlacklist(actor: Actor, address: string, hours: number, reason: string): Promise<number> {
    this.assertGuild(actor);
    return this.store.setBlacklist(actor, addressKey(address), hoursMs(hours), reason.slice(0,300));
  }
  removeBlacklist(actor: Actor, address: string): Promise<void> { this.assertGuild(actor); return this.store.removeBlacklist(actor, addressKey(address)); }
  channel(actor: Actor, channelId: string, allowed: boolean): Promise<void> { this.assertAdmin(actor); return this.store.channel(actor, channelId, allowed); }
  role(actor: Actor, roleId: string, capability: Capability, grant: boolean): Promise<void> {
    this.assertAdmin(actor);
    if (roleId === this.guildId) throw new FaucetError('EVERYONE_ROLE', 'Choose a moderator role instead of @everyone.');
    return this.store.role(actor, roleId, capability, grant);
  }
}
