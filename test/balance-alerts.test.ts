import test from 'node:test';
import assert from 'node:assert/strict';
import { BalanceAlerts, defaultBalanceAlerts, validateBalanceAlerts, type BalanceAlertTransport } from '../src/balance-alerts.js';
import { balanceAlertPayload, createBalanceAlertTransport } from '../src/discord/balance-alerts.js';
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import { FaucetService } from '../src/service.js';
import { FaucetError, HOURS, type BalanceAlertConfig, type BalanceAlertState, type Settings } from '../src/domain.js';
import type { Config } from '../src/config.js';
import type { DiscordMessageRef } from '../src/supabase-store.js';
import { admin, address, databaseStub, defaults, errorCode, user } from './helpers.js';

const lease={owner:'worker',generation:1,expiresAt:9_000_000_000_000};
function fixture() {
  let time=1_800_000_000_000;let balance=2n*10n**18n;let reads=0;let writes=0;let sends=0;
  let state:BalanceAlertState|null=null;
  let settings:Settings={...defaults,balanceAlerts:{...defaultBalanceAlerts(),version:'configured',enabled:true,channelId:user.channelId,userIds:[user.userId]}};
  const published=new Map<string,DiscordMessageRef>();
  const hooks:{balance?:()=>void;save?:(write:number)=>void;afterSave?:(write:number)=>void;send?:()=>void;verify?:()=>void}={};
  const store=databaseStub({settings:async()=>structuredClone(settings),
    changeSettings:async(_actor,patch)=>{settings={...settings,...patch};return structuredClone(settings);},
    balanceAlertState:async()=>structuredClone(state),
    saveBalanceAlertState:async value=>{writes++;hooks.save?.(writes);state=structuredClone(value);hooks.afterSave?.(writes);},
    verifyLease:async()=>{hooks.verify?.();}});
  const service=new FaucetService(store,user.guildId,address(999));
  const chain={balance:async()=>{reads++;hooks.balance?.();return balance;}};
  const transport:BalanceAlertTransport={find:async(_guild,_config,event)=>published.get(event.id)??null,
    send:async(_guild,_config,event)=>{sends++;const ref={channelId:user.channelId,messageId:String(600000000000000000n+BigInt(sends))};published.set(event.id,ref);hooks.send?.();return ref;}};
  const create=()=>new BalanceAlerts(new Map([[user.guildId,service]]),chain,transport,()=>time,()=>{});
  return {create,store,service,chain,transport,hooks,published,
    setBalance:(value:bigint)=>{balance=value;},advance:(ms=60000)=>{time+=ms;},
    counters:()=>({reads,writes,sends}),state:()=>state,settings:()=>settings};
}

test('alerts are disabled by default and reject broad pings, invalid thresholds and excessive recipients',()=>{
  assert.equal(defaultBalanceAlerts().enabled,false);
  const c={...defaultBalanceAlerts(),version:'config'};
  for(const bad of [{...c,roleIds:[user.guildId]},{...c,thresholdWei:'0'},{...c,repeatMs:1},{...c,userIds:Array(21).fill(user.userId)}]) {
    assert.throws(()=>validateBalanceAlerts(bad,user.guildId),errorCode('ALERT_CONFIG'));
  }
});

test('below is strict, stable low balance does not spam, reminders are timed, and a refill rearms the alert',async()=>{
  const f=fixture();const monitor=f.create();
  f.setBalance(10n**18n);await monitor.check(lease);assert.equal(f.counters().sends,0);
  f.advance();f.setBalance(5n*10n**17n);await monitor.check(lease);assert.equal(f.counters().sends,1);
  for(let i=0;i<100;i++) await monitor.check(lease);assert.equal(f.counters().reads,2);
  f.advance();await monitor.check(lease);assert.equal(f.counters().sends,1);
  f.advance(6*HOURS);await monitor.check(lease);assert.equal(f.counters().sends,2);
  f.advance();f.setBalance(10n**18n);await monitor.check(lease);assert.equal(f.state()?.low,false);
  f.advance();f.setBalance(1n);await monitor.check(lease);assert.equal(f.counters().sends,3);
});

test('no-repeat alerts survive restarts and continue monitoring while payouts are paused',async()=>{
  const f=fixture();let monitor=f.create();
  await f.store.changeSettings(admin,{enabled:false});
  await monitor.configure(admin,c=>({...c,repeatMs:0}));
  f.setBalance(1n);await monitor.check(lease);assert.equal(f.counters().sends,1);
  f.advance(72*HOURS);monitor=f.create();await monitor.check(lease);assert.equal(f.counters().sends,1);
  assert.equal(f.settings().enabled,false);
});

test('a failed balance read never sends a false low-balance alert',async()=>{
  const f=fixture();const monitor=f.create();f.hooks.balance=()=>{throw new Error('RPC outage');};
  await monitor.check(lease);assert.equal(f.counters().sends,0);assert.equal(f.counters().writes,0);
  f.hooks.balance=undefined;f.advance();f.setBalance(1n);await monitor.check(lease);assert.equal(f.counters().sends,1);
});

test('a persisted intent with a lost response is recovered before sending, and a lost delivery response is found after restart',async()=>{
  const f=fixture();let monitor=f.create();f.setBalance(1n);
  f.hooks.afterSave=n=>{if(n===1) throw new Error('Lost database response');};
  await monitor.check(lease);assert.equal(f.counters().sends,0);assert.ok(f.state()?.pending);
  f.hooks.afterSave=undefined;f.hooks.send=()=>{throw new Error('Lost Discord response after posting');};
  f.advance();await monitor.check(lease);assert.equal(f.counters().sends,1);
  f.hooks.send=undefined;f.advance();monitor=f.create();await monitor.check(lease);
  assert.equal(f.counters().sends,1);assert.equal(f.state()?.pending,null);
});

test('failed delivery bookkeeping does not post a second alert, including after restart',async()=>{
  const f=fixture();let monitor=f.create();f.setBalance(1n);
  f.hooks.save=n=>{if(n===2) throw new Error('Database offline before delivery acknowledgement');};
  await monitor.check(lease);assert.equal(f.counters().sends,1);assert.ok(f.state()?.pending);
  f.hooks.save=undefined;f.advance();monitor=f.create();await monitor.check(lease);assert.equal(f.counters().sends,1);
});

test('only admins configure alerts, target changes preserve payout settings, and disabling stops automatic reads',async()=>{
  const f=fixture();const monitor=f.create();
  await assert.rejects(monitor.configure(user,c=>({...c,enabled:false})),errorCode('ADMIN_REQUIRED'));
  await assert.rejects(monitor.test(user,'test'),errorCode('ADMIN_REQUIRED'));
  await assert.rejects(monitor.configure({...admin,guildId:'other'},c=>c),errorCode('WRONG_SERVER'));
  const c=await monitor.configure(admin,c=>({...c,roleIds:['400000000000000001']}));
  assert.deepEqual(c.userIds,[user.userId]);assert.equal(f.settings().amountWei,defaults.amountWei);
  assert.equal(f.settings().enabled,true);
  await monitor.configure(admin,c=>({...c,enabled:false}));await monitor.check(lease);
  assert.equal(f.counters().reads,0);assert.equal(f.counters().sends,0);
});

test('test alerts are explicit, do not consume the automatic alert state, and use a real current balance',async()=>{
  const f=fixture();const monitor=f.create();
  await monitor.test(admin,'interaction-1');assert.equal(f.counters().sends,1);assert.equal(f.counters().writes,0);
  await monitor.configure(admin,c=>({...c,userIds:[],roleIds:[]}));
  await assert.rejects(monitor.test(admin,'interaction-2'),errorCode('ALERT_SETUP'));
});

test('alerts share one balance lookup while using separate thresholds and recipients across servers',async()=>{
  const a=fixture();const b=fixture();const guildB='100000000000000099';
  const configB:BalanceAlertConfig={...defaultBalanceAlerts(),version:'b',enabled:true,channelId:'200000000000000099',thresholdWei:'10000000000000000',roleIds:['400000000000000099']};
  await b.store.changeSettings(admin,{balanceAlerts:configB});
  const serviceB=new FaucetService(b.store,guildB,address(999));const guilds:string[]=[];let reads=0;
  const monitor=new BalanceAlerts(new Map([[user.guildId,a.service],[guildB,serviceB]]),{balance:async()=>{reads++;return 5n*10n**17n;}},
    {find:async()=>null,send:async guildId=>{guilds.push(guildId);return {channelId:user.channelId,messageId:'600000000000000001'};}},Date.now,()=>{});
  await monitor.check(lease);assert.equal(reads,1);assert.deepEqual(guilds,[user.guildId]);
});

test('lease loss prevents a low-balance ping and payload mentions only selected users and roles',async()=>{
  const f=fixture();f.setBalance(1n);f.hooks.verify=()=>{throw new FaucetError('LEASE_LOST','Lost worker');};
  await f.create().check(lease);assert.equal(f.counters().sends,0);
  const config={...defaultBalanceAlerts(),userIds:[user.userId],roleIds:['400000000000000001']};
  const body=balanceAlertPayload(config,{id:'event',createdAt:Date.now(),balanceWei:'100000000000000000'},
    {symbol:'tITL',wallet:{address:address(999)}} as Pick<Config,'symbol'|'wallet'>);
  assert.deepEqual(body.allowedMentions,{parse:[],repliedUser:false,users:config.userIds,roles:config.roleIds});
  assert.match(body.content,new RegExp(`<@${user.userId}>`));assert.match(body.content,/<@&400000000000000001>/);
  assert.match(JSON.stringify(body.embeds),/0.1 tITL/);
});

test('a role must be mentionable or the bot must have the channel permission before an alert can ping it',async()=>{
  let sent=0;let mentionable=false;
  const channel={guildId:user.guildId,id:user.channelId,type:ChannelType.GuildText,
    guild:{members:{me:{}},roles:{fetch:async()=>({id:'400000000000000001',managed:false,get mentionable(){return mentionable;}})}},
    permissionsFor:()=>({has:(permission:unknown)=>permission!==PermissionFlagsBits.MentionEveryone}),
    send:async(body:{allowedMentions:unknown})=>{sent++;assert.deepEqual(body.allowedMentions,{parse:[],repliedUser:false,users:[],roles:['400000000000000001']});return {id:'600000000000000001',channelId:user.channelId};}};
  const client={channels:{fetch:async()=>channel}} as unknown as Client;
  const transport=createBalanceAlertTransport(client,{symbol:'tITL',wallet:{address:address(999)}} as Config);
  const config={...defaultBalanceAlerts(),channelId:user.channelId,roleIds:['400000000000000001']};
  const event={id:'event',createdAt:Date.now(),balanceWei:'1'};
  await assert.rejects(transport.send(user.guildId,config,event,false),errorCode('ALERT_ROLE_PERMISSIONS'));assert.equal(sent,0);
  mentionable=true;await transport.send(user.guildId,config,event,false);assert.equal(sent,1);
  await assert.rejects(transport.send('other-server',config,event,false),errorCode('ALERT_CHANNEL'));assert.equal(sent,1);
});
