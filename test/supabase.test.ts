import test from 'node:test';
import assert from 'node:assert/strict';
import { supabaseConfig } from '../src/config.js';
import { FaucetError, safeError } from '../src/domain.js';
import { SupabaseStore } from '../src/supabase-store.js';
import { admin, address, defaults, errorCode, makePayout, user } from './helpers.js';

const url='https://pypehbsuhuhnutxkphyf.supabase.co';
const key='sb_secret_test_fixture_only';
function client(reply:unknown=true,status=200) {
  const requests:{url:string;init:RequestInit;body:{p_action:string;p_payload:Record<string,unknown>}}[]=[];
  const fetcher=(async(input,init)=>{
    const request=init!;requests.push({url:String(input),init:request,body:JSON.parse(String(request.body))});
    return Response.json(reply,{status});
  }) as typeof fetch;
  return {store:new SupabaseStore({url,key,fetch:fetcher,sleep:async()=>{}}),requests};
}

test('modern Supabase secret keys use the API key header and JSON RPC without redirects',async()=>{
  const {store,requests}=client({schemaVersion:2,initialized:false,serverTime:1});
  assert.equal((await store.health()).schemaVersion,2);const request=requests[0]!;
  assert.equal(request.url,`${url}/rest/v1/rpc/faucet_read`);
  assert.deepEqual(request.body,{p_action:'health',p_payload:{}});
  assert.equal(new Headers(request.init.headers).get('apikey'),key);
  assert.equal(new Headers(request.init.headers).has('Authorization'),false);
  assert.equal(request.init.redirect,'error');assert.ok(request.init.signal instanceof AbortSignal);
});
test('legacy service-role JWT keys also include Bearer authorization',async()=>{
  let headers:Headers|undefined;
  const store=new SupabaseStore({url,key:'test.legacy.jwt',fetch:(async(_input,init)=>{headers=new Headers(init?.headers);return Response.json(true);}) as typeof fetch});
  await store.read('health');assert.equal(headers!.get('Authorization'),'Bearer test.legacy.jwt');assert.equal(headers!.get('apikey'),'test.legacy.jwt');
});
test('public keys and unsafe project URLs are rejected before a request',()=>{
  assert.throws(()=>new SupabaseStore({url,key:'sb_publishable_test'}),errorCode('DATABASE_AUTH'));
  assert.throws(()=>new SupabaseStore({url,key:''}),errorCode('DATABASE_AUTH'));
  for(const bad of ['http://example.com','https://user:password@example.com','https://example.com/path','https://example.com/?token=secret','https://example.com/#x']) {
    assert.throws(()=>new SupabaseStore({url:bad,key}),errorCode('CONFIG'));
  }
});
test('Supabase configuration works without Discord credentials and supports a legacy local key',()=>{
  assert.equal(supabaseConfig({SUPABASE_SECRET_KEY:key}).url,url);
  assert.equal(supabaseConfig({SUPABASE_SERVICE_ROLE_KEY:'legacy'}).key,'legacy');
  assert.throws(()=>supabaseConfig({}),errorCode('CONFIG'));
});
test('all monetary values preserve integer precision across JSON transport',async()=>{
  const amount='999999999999999999999999999999999999999999999999999999999999999999999999999999';
  const payout=makePayout({amountWei:amount});const c=client(payout);
  assert.equal((await c.store.claim(user,address(1),'interaction:1',false)).amountWei,amount);
  const spent=client(amount);assert.equal(await spent.store.spentAndReserved(),BigInt(amount));
});
test('initialization binds the expected server, wallet and chain without transmitting keys',async()=>{
  const {store,requests}=client();await store.initialize(admin.guildId,address(999),19042026,defaults);
  const request=requests[0]!;assert.equal(request.url,`${url}/rest/v1/rpc/faucet_write`);
  assert.deepEqual(request.body,{p_action:'initialize',p_payload:{guildId:admin.guildId,wallet:address(999),chainId:19042026,settings:defaults}});
  assert.equal(JSON.stringify(request.body).includes(key),false);
});
test('domain errors return only the controlled message and precise cooldown expiry',async()=>{
  const until=1_800_000_000_000;
  const {store}=client({code:'P0001',message:'COOLDOWN',details:JSON.stringify({message:'Wait for the next claim.',retryAt:until})},400);
  await assert.rejects(store.claim(user,address(1),'a',false),error=>error instanceof FaucetError&&error.code==='COOLDOWN'&&error.retryAt===until&&error.message==='Wait for the next claim.');
});
test('credential, missing schema, malformed and SQL errors are sanitized',async()=>{
  const cases:[number,unknown,string][]=[
    [401,{message:key},'DATABASE_AUTH'],[403,{message:key},'DATABASE_AUTH'],
    [404,{code:'PGRST202',message:key},'DATABASE_SCHEMA'],[400,{code:'42601',message:key,details:'raw signed bytes'},'DATABASE_QUERY'],
    [500,null,'DATABASE_UNAVAILABLE'],[400,{code:'P0001',message:'bad lowercase message',details:key},'DATABASE_QUERY'],
  ];
  for(const [status,body,expected] of cases) {
    await assert.rejects(client(body,status).store.health(),error=>{
      assert.ok(error instanceof FaucetError);assert.equal(error.code,expected);assert.equal(safeError(error).includes(key),false);return true;
    });
  }
});
test('a write whose response is lost is not automatically replayed',async()=>{
  let calls=0;
  const store=new SupabaseStore({url,key,fetch:(async()=>{calls++;throw new Error(`Network lost ${key}`);}) as typeof fetch});
  await assert.rejects(store.claim(user,address(1),'request:1',false),errorCode('DATABASE_UNAVAILABLE'));assert.equal(calls,1);
});
test('worker mutations carry their fencing generation and original transaction identity',async()=>{
  const {store,requests}=client(makePayout());const lease={owner:'9e2d056f-5158-41e5-a1f2-316f6ab622bd',generation:8,expiresAt:1_800_000_000_000};
  const prepared={rawTx:'0x01',txHash:`0x${'a'.repeat(64)}`,nonce:7};const payout=makePayout({...prepared,status:'signed'});
  await store.saveSigned(payout.id,prepared,user,lease);
  assert.deepEqual(requests[0]!.body,{p_action:'save-signed',p_payload:{id:payout.id,prepared,actor:user,lease}});
  await store.finishPayout(payout,true,lease);
  assert.deepEqual(requests[1]!.body,{p_action:'finish',p_payload:{id:payout.id,txHash:payout.txHash,success:true,lease}});
});
test('moderator settings and start controls include their permission and expected version',async()=>{
  const {store,requests}=client(defaults);
  await store.changeSettings(admin,{enabled:true},undefined,17);
  assert.equal(requests[0]!.body.p_payload.expectedVersion,17);
  await store.changeSettings(user,{cooldownMs:3600000},'cooldown');assert.equal(requests[1]!.body.p_payload.capability,'cooldown');
});

test('Discord message recovery uses server-scoped audit references and accepts an empty insert response',async()=>{
  const job=makePayout();const ref={channelId:job.channelId,messageId:'600000000000000001'};
  const requests:{url:URL;init:RequestInit}[]=[];
  const root=new SupabaseStore({url,key,fetch:(async(input,init)=>{
    requests.push({url:new URL(String(input)),init:init!});
    return init?.method==='POST'?new Response(null,{status:201}):Response.json([{details:ref}]);
  }) as typeof fetch});
  const store=root.forGuild(job.guildId);
  await store.saveDiscordMessage(job,'progress',ref);assert.deepEqual(await store.discordMessage(job,'progress'),ref);
  const row=JSON.parse(String(requests[0]!.init.body));
  assert.equal(row.guild_id,job.guildId);assert.equal(row.target,job.id);assert.equal(row.action,'discord-progress');assert.deepEqual(row.details,ref);
  const query=requests[1]!.url.searchParams;
  assert.equal(query.get('guild_id'),`eq.${job.guildId}`);assert.equal(query.get('target'),`eq.${job.id}`);assert.equal(query.get('limit'),'1');
  await assert.rejects(root.discordMessage(job,'progress'),errorCode('WRONG_SERVER'));
  await assert.rejects(root.forGuild('other-server').saveDiscordMessage(job,'confirmed',ref),errorCode('WRONG_SERVER'));
  await assert.rejects(store.saveDiscordMessage(job,'progress',{...ref,channelId:'other-channel'}),errorCode('DISCORD_DELIVERY'));
  assert.equal(requests.length,2);
});

test('empty successful audit inserts accept HTTP 200, 201 and 204 without treating them as outages',async()=>{
  const job=makePayout();
  for (const status of [200,201,204]) {
    let writes=0;
    const store=new SupabaseStore({url,key,fetch:(async()=>{writes++;return new Response(null,{status});}) as typeof fetch}).forGuild(job.guildId);
    await store.saveDiscordMessage(job,'progress',{channelId:job.channelId,messageId:'600000000000000001'});
    assert.equal(writes,1);
  }
});

test('transient reads retry with bounded backoff, while exhausted reads fail without leaking provider data',async()=>{
  for (const mode of ['network','503','429']) {
    let reads=0;let waits=0;
    const store=new SupabaseStore({url,key,sleep:async()=>{waits++;},fetch:(async()=>{
      reads++;
      if (reads===1) {
        if (mode==='network') throw new Error('provider secret');
        return new Response('',{status:Number(mode)});
      }
      return Response.json({schemaVersion:3});
    }) as typeof fetch});
    assert.equal((await store.health()).schemaVersion,3);assert.equal(reads,2);assert.equal(waits,1);
  }
  let reads=0;
  const down=new SupabaseStore({url,key,sleep:async()=>{},fetch:(async()=>{reads++;return new Response('secret',{status:503});}) as typeof fetch});
  await assert.rejects(down.health(),errorCode('DATABASE_UNAVAILABLE'));assert.equal(reads,3);
});

test('an empty RPC read is retried and never mistaken for a successful database value',async()=>{
  let reads=0;
  const store=new SupabaseStore({url,key,sleep:async()=>{},fetch:(async()=>{reads++;return new Response(null,{status:200});}) as typeof fetch});
  await assert.rejects(store.health(),errorCode('DATABASE_UNAVAILABLE'));assert.equal(reads,3);
});

test('alert state uses backend audit storage, server scope and a verified worker lease',async()=>{
  const requests:{url:URL;body:Record<string,unknown>}[]=[];
  const store=new SupabaseStore({url,key,fetch:(async(input,init)=>{
    const endpoint=new URL(String(input));const body=init?.body?JSON.parse(String(init.body)):{};requests.push({url:endpoint,body});
    return endpoint.pathname.includes('/rpc/')?Response.json(true):init?.method==='POST'?new Response(null,{status:201}):Response.json([]);
  }) as typeof fetch}).forGuild(user.guildId);
  const state={configVersion:'v1',low:true,lastSentAt:null,pending:{id:'event',createdAt:1000,balanceWei:'1'}};
  const lease={owner:'worker',generation:1,expiresAt:10000};
  await store.saveBalanceAlertState(state,lease);assert.equal(await store.balanceAlertState(),null);
  assert.equal(requests[0]!.body.p_action,'lease-valid');assert.equal(requests[1]!.body.guild_id,user.guildId);
  assert.deepEqual(requests[1]!.body.details,state);assert.equal(requests[1]!.body.action,'balance-alert-state');
  assert.equal(requests[2]!.url.searchParams.get('guild_id'),`eq.${user.guildId}`);
});
