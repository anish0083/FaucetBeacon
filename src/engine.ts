import { randomUUID } from 'node:crypto';
import { FaucetError, safeError, type Actor, type Payout } from './domain.js';
import { FaucetService } from './service.js';
import type { WorkerLease } from './supabase-store.js';
import { GatewayError } from './chain/gateway.js';
import { receiptMatchesPayout, type TransferChain } from './chain/transfers.js';

const cancelCodes = new Set(['WRONG_SERVER','MEMBER_LEFT','CHANNEL_NOT_APPROVED','CHANNEL_UNAVAILABLE',
  'BOT_PERMISSIONS','PERMISSION_REQUIRED','BLACKLISTED','COOLDOWN','SELF_TRANSFER','INVALID_ADDRESS',
  'PAYOUT_LIMIT','BATCH_SIZE','BATCH_LIMIT','DAILY_LIMIT']);
const pauseCodes = new Set(['LOW_BALANCE','GAS_LIMIT','AUTH_LOCKED','AUTH_CHALLENGE','CHAIN_ID',
  'SIGNING','GAS_MODEL','TX_HASH_MISMATCH','RPC_SCHEMA']);

export class PayoutEngine {
  private readonly owner = randomUUID();
  private lease: WorkerLease | null = null;
  private ticking: Promise<void> | null = null;
  private serial: Promise<void> = Promise.resolve();
  private controlRevision = 0;
  private nextNetworkAttempt = 0;
  private lastLog = '';
  private closed = false;
  private progressCursor=0;
  constructor(readonly service: FaucetService, readonly chain: TransferChain,
    private readonly resolveActor: (userId: string, channelId: string, guildId: string) => Promise<Actor>,
    private readonly confirmations = 3, private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = console.error,
    private readonly services?: ReadonlyMap<string, FaucetService>) {}

  private guildService(guildId: string): FaucetService {
    const service = this.services ? this.services.get(guildId) : this.service.guildId === guildId ? this.service : undefined;
    if (!service) throw new FaucetError('WRONG_SERVER', 'This server is not in the operator allowlist.');
    return service;
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.exclusive(() => this.runTick()).finally(() => { this.ticking = null; });
    return this.ticking;
  }
  private exclusive(work: () => Promise<void>): Promise<void> {
    const result = this.serial.then(work);
    this.serial = result.catch(() => undefined);
    return result;
  }
  private async renewLease(): Promise<WorkerLease | null> {
    if (this.closed) return null;
    this.lease = await this.service.store.acquireLease(this.owner);
    return this.lease;
  }
  private report(error: unknown): void {
    const message = safeError(error);
    if (message !== this.lastLog) { this.log(message); this.lastLog = message; }
  }
  private async runTick(): Promise<void> {
    if (this.closed || this.now() < this.nextNetworkAttempt) return;
    const store = this.service.store;
    let lease: WorkerLease | null = null;
    let selectedJob: Payout | null = null;
    const revision = this.controlRevision;
    try {
      lease = await this.renewLease();
      if (!lease) return;
      const active = await store.inFlight();
      // Signed transactions keep settling even when new claims are paused.
      if (active) { await this.reconcile(active, lease); return; }
      selectedJob = await store.nextQueued();
      if (!selectedJob) return;
      const service = this.guildService(selectedJob.guildId);
      if (!(await service.store.settings()).enabled) return;
      let actor = await this.resolveActor(selectedJob.userId, selectedJob.channelId, selectedJob.guildId);
      await service.assertQueuedEligible(selectedJob, actor);
      const prepared = await this.chain.prepare(selectedJob.address, BigInt(selectedJob.amountWei));
      actor = await this.resolveActor(selectedJob.userId, selectedJob.channelId, selectedJob.guildId);
      if (revision !== this.controlRevision || this.closed) throw new FaucetError('PAUSED', 'Payout controls changed during preparation.');
      // Postgres rechecks current permissions, channel, bans and limits atomically.
      // An uncertain save response must never be followed by a broadcast here.
      const signed = await service.store.saveSigned(selectedJob.id, prepared, actor, lease);
      await this.reconcile(signed, lease);
      this.lastLog = '';
    } catch (error) {
      try {
        if (lease && error instanceof FaucetError) {
          if (pauseCodes.has(error.code)) await store.pause(error.code, lease);
          if (selectedJob && cancelCodes.has(error.code)) await store.cancelIneligible(selectedJob.id, error.code, false, lease);
          if (selectedJob && ['RECIPIENT_GAS','RECIPIENT_REJECTED'].includes(error.code)) {
            await store.cancelIneligible(selectedJob.id, error.code, true, lease);
          }
        }
      } catch (persistenceError) { this.report(persistenceError); }
      if (!(error instanceof FaucetError && ['PAUSED','QUEUE_CHANGED','LEASE_LOST'].includes(error.code))) this.report(error);
      this.nextNetworkAttempt = this.now() + 10_000;
    }
  }

  private async reconcile(job: Payout, lease: WorkerLease): Promise<void> {
    if (!job.txHash || !job.rawTx || job.nonce === null) throw new FaucetError('RPC_SCHEMA', 'An in-flight payout is missing its durable transaction data.');
    const store = this.service.store;
    const receipt = await this.chain.receipt(job.txHash);
    if (receipt) {
      if (!receiptMatchesPayout(receipt, job)) {
        await store.markPayout(job.id, 'review', 'RECEIPT_MISMATCH', lease);
        return;
      }
      const head = await this.chain.blockNumber();
      if (head - BigInt(receipt.blockNumber) + 1n < BigInt(this.confirmations)) return;
      await store.finishPayout(job, receipt.status === '0x1', lease);
      return;
    }
    // A consumed nonce is not proof that this recipient was paid. Keep the reservation.
    const nonce = await this.chain.confirmedNonce();
    if (nonce > job.nonce) {
      if (this.now() - job.updatedAt > 120_000 && job.status !== 'review') {
        await store.markPayout(job.id, 'review', 'NONCE_REVIEW', lease);
      }
      return;
    }
    if (job.status === 'review' || this.closed) return;
    if (job.status === 'broadcast' && this.now() - job.updatedAt < 60_000) return;
    await store.verifyLease(lease);
    try {
      await this.chain.broadcast(job.rawTx, job.txHash);
    } catch (error) {
      if (error instanceof GatewayError && error.alreadyKnown) {
        await store.markPayout(job.id, 'broadcast', null, lease);
        return;
      }
      if (error instanceof GatewayError && error.code === 'TX_HASH_MISMATCH') await store.markPayout(job.id, 'review', error.code, lease);
      // RPC timeouts and errors never release a signed transaction or create a replacement.
      throw error;
    }
    await store.markPayout(job.id, 'broadcast', null, lease);
  }

  start(actor: Actor): Promise<void> {
    const service = this.guildService(actor.guildId);
    service.assertAdmin(actor);
    const revision = ++this.controlRevision;
    return this.exclusive(async () => {
      const store = service.store;
      const expectedVersion = await store.controlVersion();
      if (!(await store.channels()).length) throw new FaucetError('NO_CHANNELS', 'Approve at least one channel before starting the faucet.');
      if ((await store.inFlight())?.status === 'review') throw new FaucetError('PENDING_REVIEW', 'A transfer is awaiting its original receipt. Use /faucet-admin recheck.');
      this.chain.resetAuthentication();
      await this.chain.initialize();
      const balance = await this.chain.balance();
      if (balance <= BigInt((await store.settings()).amountWei)) throw new FaucetError('LOW_BALANCE', 'Fund the faucet wallet with enough tITL for claims and gas before starting.');
      if (revision !== this.controlRevision || this.closed) throw new FaucetError('CONTROL_CHANGED', 'A newer admin control superseded this start request.');
      await service.changeSettings(actor, { enabled: true, pauseReason: null }, undefined, expectedVersion);
      this.nextNetworkAttempt = 0;
    });
  }
  async stop(actor: Actor): Promise<void> {
    const service = this.guildService(actor.guildId);
    service.assertAdmin(actor);
    this.controlRevision++;
    await service.changeSettings(actor, { enabled: false, pauseReason: 'Paused by an admin.' });
  }
  recheck(actor: Actor): Promise<void> {
    this.guildService(actor.guildId).assertAdmin(actor);
    return this.exclusive(async () => {
      const lease = await this.renewLease();
      if (!lease) throw new FaucetError('WORKER_BUSY', 'Another bot process owns the payout queue. Recheck on the active instance.');
      this.chain.resetAuthentication();
      await this.chain.initialize();
      const active = await this.service.store.inFlight();
      if (active) await this.reconcile(active, lease);
      this.nextNetworkAttempt = 0;
    });
  }
  flushNotifications(deliver: (payout: Payout) => Promise<void>,progress?: (payout:Payout)=>Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      try {
        const lease = await this.renewLease();
        if (!lease) return;
        const store = this.service.store;
        const deadline=this.now()+15000;
        for (const job of await store.notifications(lease)) {
          if (this.closed || this.now()>=deadline) return;
          await store.verifyLease(lease);
          try { await deliver(job); }
          catch {
            await store.markNotice(job, false, lease);
            if (job.noticeAttempts === 0 || job.noticeAttempts === 9) this.log(`DISCORD_DELIVERY: A ${job.status} notice for payout ${job.id} will be retried.`);
            continue;
          }
          // If this acknowledgement is lost, an embed may repeat, but no transfer repeats.
          await store.markNotice(job, true, lease);
        }
        if (progress && this.now()<deadline) {
          const pending:Payout[]=[];
          for (const context of this.services?.values()??[this.service]) pending.push(...await context.store.pending());
          // Rotate a small batch so a busy Discord channel cannot monopolize payout ticks.
          const count=Math.min(4,pending.length);
          for (let i=0;i<count;i++) {
            if (this.closed || this.now()>=deadline) return;
            const job=pending[this.progressCursor++%pending.length]!;
            await store.verifyLease(lease);
            try {await progress(job);} catch (error) {this.report(error);}
          }
          if (pending.length) this.progressCursor%=pending.length;
        }
      } catch (error) { this.report(error); }
    });
  }
  maintain(work:(lease:WorkerLease)=>Promise<void>):Promise<void> {
    return this.exclusive(async()=>{
      try {
        const lease=await this.renewLease();
        if (lease) {await this.service.store.verifyLease(lease);await work(lease);}
      } catch(error) {this.report(error);}
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controlRevision++;
    await this.serial;
    if (this.lease) {
      try { await this.service.store.releaseLease(this.lease); }
      catch (error) { this.report(error); }
      this.lease = null;
    }
  }
}
