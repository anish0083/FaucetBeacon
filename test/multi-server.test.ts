import test from 'node:test';
import assert from 'node:assert/strict';
import { discordConfig, discordGuildIds, loadConfig } from '../src/config.js';
import { SupabaseStore } from '../src/supabase-store.js';
import { FaucetService } from '../src/service.js';
import { PayoutEngine } from '../src/engine.js';
import { amountWei, FaucetError } from '../src/domain.js';
import { admin, user, address, defaults, databaseStub, errorCode, makePayout, workerFixture } from './helpers.js';
import type { TransferChain } from '../src/chain/transfers.js';

const guild2='100000000000000002';
const secondAdmin={...admin,guildId:guild2,channelId:'200000000000000002'};

test('server allowlist accepts both configured guilds, deduplicates IDs and supports the old single ID',()=>{
  assert.deepEqual(discordGuildIds({DISCORD_GUILD_IDS:`${admin.guildId}, ${guild2},,${admin.guildId}`}),[admin.guildId,guild2]);
  assert.deepEqual(discordGuildIds({DISCORD_GUILD_ID:admin.guildId}),[admin.guildId]);
  assert.throws(()=>discordGuildIds({DISCORD_GUILD_IDS:'*'}),errorCode('CONFIG'));
  assert.throws(()=>discordGuildIds({DISCORD_GUILD_IDS:','}),errorCode('CONFIG'));
  assert.throws(()=>discordConfig({DISCORD_TOKEN:'example',DISCORD_CLIENT_ID:'bad',DISCORD_GUILD_IDS:guild2}),errorCode('CONFIG'));
});

test('0.1 tITL is kept exactly as the first-start amount for all configured servers',()=>{
  const config=loadConfig({DISCORD_TOKEN:'test',DISCORD_CLIENT_ID:admin.userId,DISCORD_GUILD_IDS:`${admin.guildId},${guild2}`,
    FAUCET_PRIVATE_KEY:`0x${'1'.repeat(64)}`,SUPABASE_SECRET_KEY:'sb_secret_test',DEFAULT_AMOUNT:'0.1'});
  assert.deepEqual(config.discord.guildIds,[admin.guildId,guild2]);
  assert.equal(config.initialSettings.amountWei,'100000000000000000');
  assert.equal(config.initialSettings.enabled,false);
});

test('database scopes reads, reports and mutations to the requesting server before transport',async()=>{
  const requests:Record<string,unknown>[]=[];
  const root=new SupabaseStore({url:'https://example.supabase.co',key:'sb_secret_test',guildIds:[admin.guildId,guild2],fetch:(async(_url,init)=>{
    requests.push(JSON.parse(String(init?.body)) as Record<string,unknown>);return Response.json([]);
  }) as typeof fetch});
  const first=root.forGuild(admin.guildId), second=root.forGuild(guild2);
  await first.settings();await second.batch('batch-id');await second.cancelQueued(secondAdmin,'payout-id');
  assert.deepEqual(requests.map(r=>(r.p_payload as Record<string,unknown>).guildId),[admin.guildId,guild2,guild2]);
  await assert.rejects(first.changeSettings(secondAdmin,{enabled:true}),errorCode('WRONG_SERVER'));
  await assert.rejects(first.write('initialize',{guildId:guild2}),errorCode('WRONG_SERVER'));
  assert.equal(requests.length,3);
  await first.nextQueued();assert.deepEqual((requests[3]!.p_payload as Record<string,unknown>).guildIds,[admin.guildId,guild2]);
});

test('a payout cannot be checked through another server service',()=>{
  const service=new FaucetService(databaseStub(),admin.guildId,address(999));
  assert.throws(()=>service.assertQueuedEligible(makePayout({guildId:guild2}),user),errorCode('WRONG_SERVER'));
});

function multiWorker() {
  const f=workerFixture({enabled:false});
  let secondSettings={...defaults,amountWei:amountWei('0.1')};
  let secondVersion=0;
  const scoped=databaseStub({
    ...f.store,
    settings:async()=>({...secondSettings}),controlVersion:async()=>secondVersion,channels:async()=>[secondAdmin.channelId],
    changeSettings:async(actor,patch,_cap,expected)=>{
      assert.equal(actor.guildId,guild2);
      if(expected!==undefined&&expected!==secondVersion) throw new FaucetError('CONTROL_CHANGED','New control');
      secondSettings={...secondSettings,...patch};if('enabled' in patch)secondVersion++;
      return {...secondSettings};
    },
    assertQueuedEligible:async(id,actor)=>{assert.equal((await f.store.payout(id))?.guildId,guild2);assert.equal(actor.guildId,guild2);},
    saveSigned:async(id,prepared,actor,lease)=>{
      assert.equal(actor.guildId,guild2);await f.store.verifyLease(lease);
      const job=await f.store.payout(id);assert.ok(job);
      Object.assign(f.jobs.get(id)!,prepared,{status:'signed'});return {...f.jobs.get(id)!};
    },
  });
  const second=new FaucetService(scoped,guild2,address(999));
  let prepared=0;const broadcasts:string[]=[];const resolutions:string[]=[];
  const chain:TransferChain={initialize:async()=>{},resetAuthentication:()=>{},balance:async()=>10n**18n,
    prepare:async()=>{prepared++;return {rawTx:'0x01',txHash:`0x${'a'.repeat(64)}`,nonce:0};},
    broadcast:async(raw)=>{broadcasts.push(raw);},receipt:async()=>null,blockNumber:async()=>1n,confirmedNonce:async()=>0};
  const services=new Map([[admin.guildId,f.service],[guild2,second]]);
  const engine=new PayoutEngine(f.service,chain,async(userId,channelId,guildId)=>{
    resolutions.push(guildId);return {...user,userId,channelId,guildId};
  },3,f.now,()=>{},services);
  return {...f,engine,second,chain,services,resolutions,broadcasts,prepared:()=>prepared};
}

test('one shared worker sends a second-server payout while the first server is paused',async()=>{
  const f=multiWorker();
  f.queue({guildId:guild2,channelId:secondAdmin.channelId,amountWei:amountWei('0.1')});
  await f.engine.tick();
  assert.deepEqual(f.resolutions,[guild2,guild2]);assert.deepEqual(f.broadcasts,['0x01']);
  assert.equal((await f.store.settings()).enabled,false);assert.equal(f.prepared(),1);
});

test('admin controls use the actor server and reject servers outside the allowlist',async()=>{
  const f=multiWorker();
  await f.engine.stop(secondAdmin);assert.equal((await f.second.store.settings()).enabled,false);
  await f.engine.start(secondAdmin);assert.equal((await f.second.store.settings()).enabled,true);
  assert.equal((await f.store.settings()).enabled,false);
  await assert.rejects(f.engine.stop({...admin,guildId:'100000000000000099'}),errorCode('WRONG_SERVER'));
});

test('concurrent ticks from multiple servers share one worker and one signed transaction',async()=>{
  const f=multiWorker();
  f.queue({guildId:guild2,channelId:secondAdmin.channelId});
  const other=new PayoutEngine(f.service,f.chain,async(userId,channelId,guildId)=>({...user,userId,channelId,guildId}),3,f.now,()=>{},f.services);
  await Promise.all([f.engine.tick(),f.engine.tick(),other.tick()]);
  assert.equal(f.prepared(),1);assert.equal(f.broadcasts.length,1);
});
