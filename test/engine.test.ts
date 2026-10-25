import test from 'node:test';
import assert from 'node:assert/strict';
import { FaucetError, HOURS } from '../src/domain.js';
import { GatewayError } from '../src/chain/gateway.js';
import type { PreparedTransfer, Receipt, TransferChain } from '../src/chain/transfers.js';
import { PayoutEngine } from '../src/engine.js';
import { admin, address, errorCode, user, workerFixture } from './helpers.js';

class FakeChain implements TransferChain {
  prepared=0; broadcasts:string[]=[]; receipts=new Map<string,Receipt>(); head=12n; nonce=0;
  beforePrepare?:()=>Promise<void>; beforeBroadcast?:()=>Promise<void>; initializeHook?:()=>Promise<void>;
  async initialize(){await this.initializeHook?.();}
  resetAuthentication(){}
  async balance(){return 1000n*10n**18n;}
  async prepare():Promise<PreparedTransfer>{await this.beforePrepare?.();this.prepared++;return {rawTx:`0x${this.prepared.toString(16).padStart(2,'0')}`,txHash:`0x${String(this.prepared).padStart(64,'0')}`,nonce:this.nonce};}
  async broadcast(raw:string){this.broadcasts.push(raw);await this.beforeBroadcast?.();}
  async receipt(hash:string){return this.receipts.get(hash)??null;}
  async blockNumber(){return this.head;}
  async confirmedNonce(){return this.nonce;}
}
function receipt(hash:string,to:string,status='0x1'):Receipt{return {transactionHash:hash,blockNumber:'0xa',status,from:address(999),to};}
function fixture() {
  const f=workerFixture();const chain=new FakeChain();
  const engine=new PayoutEngine(f.service,chain,async()=>user,3,f.now,()=>{});
  return {...f,chain,engine};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

test('broadcast waits for the completed Supabase signature write; success waits for three confirmations',async()=>{
  const {queue,store,hooks,chain,engine,now}=fixture();const job=queue();
  const entered=deferred();const release=deferred();
  hooks.beforeSave=async()=>{entered.resolve();await release.promise;};
  chain.beforeBroadcast=async()=>{assert.equal((await store.payout(job.id))?.status,'signed');assert.ok((await store.payout(job.id))?.rawTx);};
  const tick=engine.tick();await entered.promise;assert.equal(chain.broadcasts.length,0);release.resolve();await tick;
  const hash=(await store.payout(job.id))!.txHash!;chain.receipts.set(hash,receipt(hash,job.address));chain.head=11n;
  await engine.tick();assert.equal((await store.payout(job.id))?.status,'broadcast');assert.equal(await store.cooldown('address',job.address),0);
  chain.head=12n;await engine.tick();assert.equal((await store.payout(job.id))?.status,'confirmed');assert.equal(await store.cooldown('user',user.userId),now()+6*HOURS);
});
test('an uncertain database save never broadcasts; a restarted worker recovers the same saved signature',async()=>{
  const {queue,store,hooks,chain,engine,service,now}=fixture();const job=queue();
  hooks.afterSave=async()=>{throw new FaucetError('DATABASE_UNAVAILABLE','Response lost after commit.');};
  await engine.tick();assert.equal(chain.broadcasts.length,0);assert.equal((await store.payout(job.id))?.status,'signed');
  hooks.afterSave=undefined;await engine.close();
  await new PayoutEngine(service,chain,async()=>user,3,now,()=>{}).tick();
  assert.deepEqual(chain.broadcasts,['0x01']);assert.equal(chain.prepared,1);
});
test('a failed database save preserves the unsigned reservation and sends nothing',async()=>{
  const {queue,store,hooks,chain,engine}=fixture();const job=queue();
  hooks.beforeSave=async()=>{throw new FaucetError('DATABASE_UNAVAILABLE','Offline.');};await engine.tick();
  assert.equal((await store.payout(job.id))?.status,'queued');assert.equal(chain.broadcasts.length,0);
});
test('ambiguous broadcast timeout and restart confirm the original transaction without signing again',async()=>{
  const {queue,store,chain,engine,service,now}=fixture();const job=queue();
  chain.beforeBroadcast=async()=>{const hash=(await store.payout(job.id))!.txHash!;chain.receipts.set(hash,receipt(hash,job.address));throw new GatewayError('RPC_NETWORK','timeout');};
  await engine.tick();assert.equal((await store.payout(job.id))?.status,'signed');await engine.close();
  await new PayoutEngine(service,chain,async()=>user,3,now,()=>{}).tick();
  assert.equal((await store.payout(job.id))?.status,'confirmed');assert.equal(chain.prepared,1);assert.equal(chain.broadcasts.length,1);
});
test('uncertain submission retries only the identical signed bytes',async()=>{
  const {queue,store,chain,engine,advance}=fixture();queue();chain.beforeBroadcast=async()=>{throw new GatewayError('RPC_NETWORK','timeout');};
  await engine.tick();advance(10001);await engine.tick();
  assert.equal(chain.prepared,1);assert.deepEqual(chain.broadcasts,['0x01','0x01']);assert.equal(await store.countPending(),1);
});
test('parallel ticks and two worker instances cannot prepare two transfers',async()=>{
  const {queue,chain,engine,service,now}=fixture();queue();
  const second=new PayoutEngine(service,chain,async()=>user,3,now,()=>{});
  await Promise.all([engine.tick(),engine.tick(),second.tick()]);assert.equal(chain.prepared,1);assert.equal(chain.broadcasts.length,1);
});
test('an expired lease cannot save or broadcast a prepared transaction',async()=>{
  const {queue,store,chain,engine,advance}=fixture();const job=queue();chain.beforePrepare=async()=>{advance(180001);};
  await engine.tick();assert.equal((await store.payout(job.id))?.status,'queued');assert.equal(chain.broadcasts.length,0);
});
test('lease loss after saving a signature stops its broadcast',async()=>{
  const {queue,store,hooks,chain,engine,advance}=fixture();const job=queue();hooks.verify=async()=>{advance(180001);};
  await engine.tick();assert.equal((await store.payout(job.id))?.status,'signed');assert.equal(chain.broadcasts.length,0);
});
test('database admission rejection cancels an unsigned payout before any preparation',async()=>{
  for(const reason of ['BLACKLISTED','CHANNEL_NOT_APPROVED','PERMISSION_REQUIRED']) {
    const {queue,store,hooks,chain,engine}=fixture();const job=queue();hooks.eligibility=async()=>{throw new FaucetError(reason,'Rejected.');};
    await engine.tick();assert.equal((await store.payout(job.id))?.status,'cancelled');assert.equal((await store.payout(job.id))?.errorCode,reason);assert.equal(chain.prepared,0);
  }
});
test('database and Discord lookup outages retain the reservation',async()=>{
  const {queue,store,hooks,chain,engine}=fixture();const job=queue();hooks.eligibility=async()=>{throw new FaucetError('DATABASE_UNAVAILABLE','Offline.');};
  await engine.tick();assert.equal((await store.payout(job.id))?.status,'queued');assert.equal(chain.prepared,0);
  const other=fixture();const second=other.queue();
  await new PayoutEngine(other.service,other.chain,async()=>{throw new FaucetError('DISCORD_TEMPORARY','Offline.');},3,other.now,()=>{}).tick();
  assert.equal((await other.store.payout(second.id))?.status,'queued');
});
test('admin cancellation during preparation cannot be resurrected or overwritten',async()=>{
  const {queue,store,chain,engine}=fixture();const job=queue();chain.beforePrepare=async()=>store.cancelQueued(admin,job.id);
  await engine.tick();assert.equal((await store.payout(job.id))?.status,'cancelled');assert.equal((await store.payout(job.id))?.errorCode,'ADMIN_CANCELLED');assert.equal(chain.broadcasts.length,0);
});
test('stop during preparation prevents sending; signed payouts still settle while paused',async()=>{
  const {queue,store,chain,engine}=fixture();const job=queue();chain.beforePrepare=async()=>engine.stop(admin);
  await engine.tick();assert.equal(chain.broadcasts.length,0);assert.equal((await store.payout(job.id))?.status,'queued');
  chain.beforePrepare=undefined;await engine.start(admin);await engine.tick();await engine.stop(admin);
  const hash=(await store.payout(job.id))!.txHash!;chain.receipts.set(hash,receipt(hash,job.address));await engine.tick();
  assert.equal((await store.payout(job.id))?.status,'confirmed');assert.equal((await store.settings()).enabled,false);
});
test('newer local and remote stop controls supersede an in-progress start',async()=>{
  for(const remote of [false,true]) {
    const {store,service,chain,engine}=fixture();
    chain.initializeHook=async()=>{if(remote) await service.changeSettings(admin,{enabled:false});else await engine.stop(admin);};
    await assert.rejects(engine.start(admin),errorCode('CONTROL_CHANGED'));assert.equal((await store.settings()).enabled,false);
  }
});
test('low funding pauses without discarding the queued claim',async()=>{
  const {queue,store,chain,engine}=fixture();const job=queue();chain.beforePrepare=async()=>{throw new FaucetError('LOW_BALANCE','empty');};
  await engine.tick();assert.equal((await store.settings()).enabled,false);assert.equal((await store.payout(job.id))?.status,'queued');assert.equal(chain.broadcasts.length,0);
});
test('recipient gas rejection fails only the unsigned job and leaves other jobs queued',async()=>{
  const {queue,store,chain,engine}=fixture();const job=queue();const next=queue({address:address(2),userId:admin.userId});
  chain.beforePrepare=async()=>{throw new FaucetError('RECIPIENT_GAS','too expensive');};await engine.tick();
  assert.equal((await store.payout(job.id))?.status,'failed');assert.equal((await store.payout(next.id))?.status,'queued');assert.equal((await store.settings()).enabled,true);
});
test('consumed nonce without the original receipt pauses for review and retains reservations',async()=>{
  const {queue,store,chain,engine,advance}=fixture();const job=queue();await engine.tick();chain.nonce=1;advance(120001);await engine.tick();
  assert.equal((await store.payout(job.id))?.status,'review');assert.equal((await store.settings()).enabled,false);assert.equal(chain.prepared,1);
  const hash=(await store.payout(job.id))!.txHash!;chain.receipts.set(hash,receipt(hash,job.address));await engine.recheck(admin);
  assert.equal((await store.payout(job.id))?.status,'confirmed');assert.equal((await store.settings()).enabled,false);
});
test('receipt recipient mismatch requires review and never grants a cooldown',async()=>{
  const {queue,store,chain,engine}=fixture();const job=queue();await engine.tick();
  const hash=(await store.payout(job.id))!.txHash!;chain.receipts.set(hash,receipt(hash,address(2)));await engine.tick();
  assert.equal((await store.payout(job.id))?.status,'review');assert.equal(await store.cooldown('user',user.userId),0);assert.equal((await store.settings()).enabled,false);
});
test('review and pause remain committed together when the database acknowledgement is lost',async()=>{
  const {queue,store,hooks,chain,engine}=fixture();const job=queue();await engine.tick();
  const hash=(await store.payout(job.id))!.txHash!;chain.receipts.set(hash,receipt(hash,address(2)));
  hooks.afterMark=async()=>{throw new FaucetError('DATABASE_UNAVAILABLE','Response lost.');};await engine.tick();
  assert.equal((await store.payout(job.id))?.status,'review');assert.equal((await store.settings()).enabled,false);
  assert.equal(chain.broadcasts.length,1);
});
test('reverted transfers release reservations without creating cooldowns',async()=>{
  const {queue,store,chain,engine}=fixture();const job=queue();await engine.tick();
  const hash=(await store.payout(job.id))!.txHash!;chain.receipts.set(hash,receipt(hash,job.address,'0x0'));await engine.tick();
  assert.equal((await store.payout(job.id))?.status,'failed');assert.equal(await store.cooldown('user',user.userId),0);assert.equal(await store.countPending(),0);
});
test('confirmation persistence failure rechecks the same receipt without another payment',async()=>{
  const {queue,store,hooks,chain,engine,advance}=fixture();const job=queue();await engine.tick();
  const hash=(await store.payout(job.id))!.txHash!;chain.receipts.set(hash,receipt(hash,job.address));hooks.finish=async()=>{throw new FaucetError('DATABASE_UNAVAILABLE','Offline.');};
  await engine.tick();assert.equal((await store.payout(job.id))?.status,'broadcast');assert.equal(await store.cooldown('user',user.userId),0);
  hooks.finish=undefined;advance(10001);await engine.tick();assert.equal((await store.payout(job.id))?.status,'confirmed');assert.equal(chain.broadcasts.length,1);
});
test('broadcast acknowledgement loss reuses the stored transaction on the next tick',async()=>{
  const {queue,store,hooks,chain,engine,advance}=fixture();const job=queue();hooks.mark=async()=>{throw new FaucetError('DATABASE_UNAVAILABLE','Offline.');};
  await engine.tick();assert.equal((await store.payout(job.id))?.status,'signed');hooks.mark=undefined;advance(10001);await engine.tick();
  assert.deepEqual(chain.broadcasts,['0x01','0x01']);assert.equal(chain.prepared,1);
});
test('notification retries are independent of payout submission',async()=>{
  const {queue,chain,engine,advance}=fixture();queue({status:'confirmed',txHash:`0x${'a'.repeat(64)}`,confirmedAt:1_800_000_000_000});let attempts=0;
  await engine.flushNotifications(async()=>{attempts++;throw new Error('Discord down');});assert.equal(attempts,1);
  await engine.flushNotifications(async()=>{attempts++;});assert.equal(attempts,1);advance(10001);
  await engine.flushNotifications(async()=>{attempts++;});await engine.flushNotifications(async()=>{attempts++;});assert.equal(attempts,2);assert.equal(chain.prepared,0);
});

test('progress delivery is fenced to one worker and its failure does not block completed payout notices',async()=>{
  const {queue,chain,engine,service,now}=fixture();queue();queue({status:'confirmed',txHash:`0x${'a'.repeat(64)}`,confirmedAt:now()});
  let progress=0;let delivered=0;
  const report=async()=>{progress++;throw new Error('Discord unavailable');};
  const second=new PayoutEngine(service,chain,async()=>user,3,now,()=>{});
  await engine.flushNotifications(async()=>{delivered++;},report);
  await second.flushNotifications(async()=>{delivered++;},report);
  assert.equal(progress,1);assert.equal(delivered,1);assert.equal(chain.broadcasts.length,0);
});
test('shutdown during preparation releases the lease and leaves the claim unsigned',async()=>{
  const {queue,store,chain,engine,service,now}=fixture();const job=queue();const entered=deferred();const release=deferred();
  chain.beforePrepare=async()=>{entered.resolve();await release.promise;};const tick=engine.tick();await entered.promise;
  const closing=engine.close();release.resolve();await Promise.all([tick,closing]);assert.equal(chain.broadcasts.length,0);assert.equal((await store.payout(job.id))?.status,'queued');
  chain.beforePrepare=undefined;await new PayoutEngine(service,chain,async()=>user,3,now,()=>{}).tick();assert.equal(chain.broadcasts.length,1);
});

test('100 queued users settle through the shared wallet exactly once, despite one failed notification',async()=>{
  const {queue,store,chain,engine}=fixture();
  const jobs=Array.from({length:100},(_,i)=>queue({address:address(i+1),userId:String(300000000000000000n+BigInt(i))}));
  let notices=0;
  for (const job of jobs) {
    await engine.tick();const active=await store.inFlight();assert.equal(active?.id,job.id);
    chain.receipts.set(active!.txHash!,receipt(active!.txHash!,job.address));
    await engine.tick();assert.equal((await store.payout(job.id))?.status,'confirmed');
    await engine.flushNotifications(async()=>{if(++notices===1) throw new Error('Temporary Discord outage');});
  }
  assert.equal(chain.prepared,100);assert.equal(new Set(chain.broadcasts).size,100);assert.equal(chain.broadcasts.length,100);
  assert.equal(await store.countPending(),0);
});

test('large progress batches rotate and yield back to the payout worker',async()=>{
  const {queue,engine,advance}=fixture();for(let i=0;i<20;i++) queue({address:address(i+1)});
  const seen=new Set<string>();
  for(let i=0;i<5;i++) await engine.flushNotifications(async()=>{},async job=>{seen.add(job.id);});
  assert.equal(seen.size,20);
  let attempted=0;
  await engine.flushNotifications(async()=>{},async()=>{attempted++;advance(16000);});
  assert.equal(attempted,1);
});

test('balance-alert maintenance shares the worker lease and its failures do not stop payouts',async()=>{
  const {engine,service,chain,now,queue}=fixture();queue();let callbacks=0;
  await engine.maintain(async()=>{callbacks++;throw new Error('Alert channel unavailable');});
  const standby=new PayoutEngine(service,chain,async()=>user,3,now,()=>{});
  await standby.maintain(async()=>{callbacks++;});assert.equal(callbacks,1);
  await engine.tick();assert.equal(chain.broadcasts.length,1);
});
