import { randomUUID } from 'node:crypto';
import { amountWei, FaucetError, HOURS, type Actor, type Payout, type Settings } from '../src/domain.js';
import type { FaucetDatabase, WorkerLease } from '../src/supabase-store.js';
import { FaucetService } from '../src/service.js';

export const address = (n: number) => `0x${n.toString(16).padStart(40,'0')}`;
export const defaults: Settings = {enabled:true,pauseReason:null,amountWei:amountWei('1'),cooldownMs:6*HOURS,autoClaim:true,maxPayoutWei:amountWei('10'),maxBatchTotalWei:amountWei('100'),maxDailyTotalWei:amountWei('1000'),maxBatchRows:100};
export const admin: Actor = {guildId:'100000000000000001',channelId:'200000000000000001',userId:'300000000000000001',isAdmin:true,roleIds:[]};
export const user: Actor = {...admin,userId:'300000000000000002',isAdmin:false};
export const mod: Actor = {...admin,userId:'300000000000000003',isAdmin:false,roleIds:['400000000000000001']};
export const errorCode = (expected: string) => (error: unknown) => error instanceof FaucetError && error.code === expected;

export function makePayout(patch: Partial<Payout> = {}): Payout {
  return {id:randomUUID(),guildId:user.guildId,requestKey:randomUUID(),batchId:null,kind:'claim',userId:user.userId,channelId:user.channelId,
    address:address(1),amountWei:defaults.amountWei,cooldownMs:defaults.cooldownMs,status:'queued',rawTx:null,txHash:null,
    nonce:null,createdAt:1_800_000_000_000,updatedAt:1_800_000_000_000,confirmedAt:null,errorCode:null,
    noticeStatus:null,noticeAttempts:0,noticeAfter:0,...patch};
}
export function databaseStub(handlers: Partial<FaucetDatabase> = {}): FaucetDatabase {
  return new Proxy(handlers as FaucetDatabase, {get(target,property) {
    if (property in target) return Reflect.get(target,property);
    return async () => { throw new Error(`Unexpected database call: ${String(property)}`); };
  }});
}

/** Worker protocol double only. Real SQL admission/permissions are tested by supabase/verify.sql. */
export function workerFixture(patch: Partial<Settings> = {}) {
  let time = 1_800_000_000_000;
  let settings = {...defaults,...patch};
  let lease: WorkerLease | null = null;
  let generation = 0;
  let version = 0;
  const jobs = new Map<string,Payout>();
  const cooldowns = new Map<string,number>();
  const hooks: {eligibility?: () => Promise<void>; beforeSave?: () => Promise<void>; afterSave?: () => Promise<void>;
    verify?: () => Promise<void>; finish?: () => Promise<void>; mark?: () => Promise<void>; afterMark?: () => Promise<void>} = {};
  const checkLease = (candidate: WorkerLease) => {
    if (!lease || lease.owner !== candidate.owner || lease.generation !== candidate.generation || lease.expiresAt <= time) {
      throw new FaucetError('LEASE_LOST','Lease lost.');
    }
  };
  const eligible = async (id: string) => {
    await hooks.eligibility?.();
    if (jobs.get(id)?.status !== 'queued') throw new FaucetError('QUEUE_CHANGED','Queue changed.');
    if (!settings.enabled) throw new FaucetError('PAUSED','Paused.');
  };
  const copy = (job: Payout | undefined): Payout | null => job ? {...job} : null;
  const store = databaseStub({
    settings: async () => ({...settings}), controlVersion: async () => version, channels: async () => [admin.channelId],
    changeSettings: async (_actor, update, _capability, expected) => {
      if (expected !== undefined && expected !== version) throw new FaucetError('CONTROL_CHANGED','Controls changed.');
      settings = {...settings,...update}; if ('enabled' in update) version++;
      return {...settings};
    },
    acquireLease: async owner => {
      if (lease && lease.expiresAt > time && lease.owner !== owner) return null;
      if (!lease || lease.owner !== owner || lease.expiresAt <= time) generation++;
      lease = {owner,generation,expiresAt:time+180_000}; return {...lease};
    },
    releaseLease: async candidate => { if (lease?.owner === candidate.owner && lease.generation === candidate.generation) lease.expiresAt = time; },
    verifyLease: async candidate => { await hooks.verify?.(); checkLease(candidate); },
    payout: async id => copy(jobs.get(id)),
    nextQueued: async () => copy([...jobs.values()].find(job => job.status === 'queued')),
    inFlight: async () => copy([...jobs.values()].find(job => ['signed','broadcast','review'].includes(job.status))),
    countPending: async () => [...jobs.values()].filter(job => ['queued','signed','broadcast','review'].includes(job.status)).length,
    pending: async () => [...jobs.values()].filter(job => ['queued','signed','broadcast','review'].includes(job.status)).map(job=>({...job})),
    assertQueuedEligible: eligible,
    saveSigned: async (id,prepared,_actor,candidate) => {
      await hooks.beforeSave?.(); checkLease(candidate); await eligible(id);
      if ([...jobs.values()].some(job => ['signed','broadcast','review'].includes(job.status))) throw new FaucetError('ALREADY_PENDING','Already pending.');
      const job = jobs.get(id)!; Object.assign(job,prepared,{status:'signed',updatedAt:time});
      await hooks.afterSave?.(); return {...job};
    },
    cancelQueued: async (_actor,id) => {
      const job = jobs.get(id); if (job?.status !== 'queued') throw new FaucetError('NOT_QUEUED','Not queued.');
      Object.assign(job,{status:'cancelled',errorCode:'ADMIN_CANCELLED',updatedAt:time});
    },
    cancelIneligible: async (id,code,failed,candidate) => {
      checkLease(candidate); const job = jobs.get(id);
      if (job?.status === 'queued') Object.assign(job,{status:failed?'failed':'cancelled',errorCode:code,updatedAt:time});
    },
    pause: async (code,candidate) => { checkLease(candidate); settings = {...settings,enabled:false,pauseReason:code}; version++; },
    markPayout: async (id,status,code,candidate) => {
      await hooks.mark?.(); checkLease(candidate); const job = jobs.get(id)!;
      if (['signed','broadcast','review'].includes(job.status)) {
        Object.assign(job,{status,errorCode:code,updatedAt:time});
        if (status === 'review') { settings = {...settings,enabled:false,pauseReason:code}; version++; }
      }
      await hooks.afterMark?.();
    },
    finishPayout: async (payout,success,candidate) => {
      await hooks.finish?.(); checkLease(candidate); const job = jobs.get(payout.id)!;
      if (job.status === 'confirmed') return;
      Object.assign(job,{status:success?'confirmed':'failed',errorCode:success?null:'TX_REVERTED',updatedAt:time});
      if (success) {
        job.confirmedAt = time; cooldowns.set(`address:${job.address}`,time+job.cooldownMs);
        if (job.kind === 'claim') cooldowns.set(`user:${job.userId}`,time+job.cooldownMs);
      }
    },
    cooldown: async (kind,subject) => cooldowns.get(`${kind}:${subject}`) ?? 0,
    notifications: async candidate => {
      checkLease(candidate);
      return [...jobs.values()].filter(job => ['confirmed','failed','cancelled','review'].includes(job.status) && job.noticeStatus !== job.status && job.noticeAfter <= time).map(job => ({...job}));
    },
    markNotice: async (payout,delivered,candidate) => {
      checkLease(candidate); const job = jobs.get(payout.id)!;
      if (job.status !== payout.status) return;
      if (delivered) Object.assign(job,{noticeStatus:job.status,noticeAttempts:0,noticeAfter:time});
      else { job.noticeAttempts++; job.noticeAfter = time+Math.min(3600000,5000*2**Math.min(job.noticeAttempts,10)); }
    },
  });
  const service = new FaucetService(store,admin.guildId,address(999));
  return {store,service,hooks,jobs,now:() => time,advance:(ms: number) => { time += ms; },queue:(p: Partial<Payout> = {}) => {
    const job = makePayout({...p,createdAt:time,updatedAt:time}); jobs.set(job.id,job); return {...job};
  }};
}
