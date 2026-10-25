import test from 'node:test';
import assert from 'node:assert/strict';
import { amountWei, FaucetError, HOURS, type Draft } from '../src/domain.js';
import { FaucetService } from '../src/service.js';
import { admin, address, databaseStub, defaults, errorCode, makePayout, mod, user } from './helpers.js';

test('another server and non-admin configuration are rejected before any database call', () => {
  const service = new FaucetService(databaseStub(),admin.guildId,address(999));
  assert.throws(() => service.claim({...user,guildId:'other'},address(1),'a'),errorCode('WRONG_SERVER'));
  assert.throws(() => service.channel(mod,'another',true),errorCode('ADMIN_REQUIRED'));
  assert.throws(() => service.changeSettings(mod,{amountWei:amountWei('2')}),errorCode('ADMIN_REQUIRED'));
  assert.throws(() => service.role(mod,mod.roleIds[0]!,'blacklist',true),errorCode('ADMIN_REQUIRED'));
  assert.throws(() => service.role(admin,admin.guildId,'bulk',true),errorCode('EVERYONE_ROLE'));
});
test('public claims normalize addresses and pass the Discord idempotency key and auto mode to the atomic RPC', async () => {
  const job = makePayout(); let seen: unknown[] = [];
  const store = databaseStub({claim: async (...args) => { seen = args; return job; }});
  const service = new FaucetService(store,admin.guildId,address(999));
  assert.equal(await service.claim(user,` ${address(1)} `,'message:123',true),job);
  assert.deepEqual(seen,[user,address(1),'message:123',true]);
  await service.claim(user,address(1),'interaction:123'); assert.equal(seen[3],false);
});
test('invalid recipients, self transfers and imprecise amounts fail before admission', () => {
  const service = new FaucetService(databaseStub(),admin.guildId,address(999));
  for (const invalid of ['not-wallet',address(0),`0x${'a'.repeat(64)}`]) assert.throws(() => service.claim(user,invalid,'a'),errorCode('INVALID_ADDRESS'));
  assert.throws(() => service.claim(user,address(999),'a'),errorCode('SELF_TRANSFER'));
  for (const amount of ['1e2','0','-1','0.0000000000000000001']) assert.throws(() => service.createBatch(admin,[address(1)],amount),errorCode('INVALID_AMOUNT'));
});
test('database permissions, channel approval and cooldown errors reach the caller with their retry time', async () => {
  const failure = new FaucetError('COOLDOWN','Wait for your claim.',1_800_000_000_000);
  const service = new FaucetService(databaseStub({claim:async () => { throw failure; },hasPermission:async () => false,isChannelAllowed:async () => false}),admin.guildId,address(999));
  await assert.rejects(service.claim(user,address(1),'claim'),error => error === failure);
  await assert.rejects(service.assertCapability(mod,'bulk'),errorCode('PERMISSION_REQUIRED'));
  await assert.rejects(service.assertChannel(user),errorCode('CHANNEL_NOT_APPROVED'));
});
test('delegated cooldown changes cannot change unrelated admin settings', async () => {
  let received: unknown[] = [];
  const service = new FaucetService(databaseStub({changeSettings:async (...args) => {received=args;return defaults;}}),admin.guildId,address(999));
  assert.throws(() => service.changeSettings(mod,{enabled:true},'cooldown'),errorCode('PERMISSION_REQUIRED'));
  await service.changeSettings(mod,{cooldownMs:HOURS},'cooldown');
  assert.deepEqual(received,[mod,{cooldownMs:HOURS},'cooldown',undefined]);
  await service.changeSettings(admin,{enabled:true},undefined,42); assert.equal(received[3],42);
});
test('CSV facade deduplicates wallets, preserves one wei, and converts custom hours', async () => {
  let received: unknown[] = [];
  const draft = {id:'draft'} as Draft;
  const service = new FaucetService(databaseStub({createBatch:async (...args) => {received=args;return draft;}}),admin.guildId,address(999));
  assert.equal(await service.createBatch(mod,[address(1),address(2),address(1)],'0.000000000000000001',0.5),draft);
  assert.deepEqual(received,[mod,[address(1),address(2)],'1',HOURS/2]);
  assert.throws(() => service.createBatch(mod,[address(1)],'1',0),errorCode('INVALID_HOURS'));
});
test('blacklist hours become a database duration and the reason is bounded', async () => {
  let received: unknown[] = [];
  const service = new FaucetService(databaseStub({setBlacklist:async (...args) => {received=args;return 123;}}),admin.guildId,address(999));
  assert.equal(await service.setBlacklist(mod,address(1),2.5,'r'.repeat(1000)),123);
  assert.deepEqual(received,[mod,address(1),2.5*HOURS,'r'.repeat(300)]);
  assert.throws(() => service.setBlacklist(admin,address(1),8761,''),errorCode('INVALID_HOURS'));
});
test('an unavailable database never falls back to a local claim or success response', async () => {
  let writes = 0;
  const service = new FaucetService(databaseStub({claim:async () => {writes++;throw new FaucetError('DATABASE_UNAVAILABLE','Unavailable.');}}),admin.guildId,address(999));
  await assert.rejects(service.claim(user,address(1),'a'),errorCode('CLAIM_UNCERTAIN'));
  assert.equal(writes,1);
});

test('a committed claim whose response was lost is recovered by the original request without another write',async()=>{
  const job=makePayout({requestKey:'message:lost'});let writes=0;let reads=0;
  const service=new FaucetService(databaseStub({claim:async()=>{writes++;throw new FaucetError('DATABASE_UNAVAILABLE','Lost response');},
    findRequest:async key=>{reads++;assert.equal(key,job.requestKey);return job;}}),user.guildId,address(999));
  assert.deepEqual(await service.claim(user,job.address,job.requestKey,true),job);
  assert.equal(writes,1);assert.equal(reads,1);
});

test('an unresolved admission remains uncertain and known validation failures are not retried',async()=>{
  for (const recovered of [null,makePayout({guildId:'other-server'})]) {
    let writes=0;
    const service=new FaucetService(databaseStub({claim:async()=>{writes++;throw new FaucetError('DATABASE_UNAVAILABLE','Lost response');},findRequest:async()=>recovered}),user.guildId,address(999));
    await assert.rejects(service.claim(user,address(1),'message:missing'),errorCode('CLAIM_UNCERTAIN'));assert.equal(writes,1);
  }
  let reads=0;
  const service=new FaucetService(databaseStub({claim:async()=>{throw new FaucetError('COOLDOWN','Wait');},findRequest:async()=>{reads++;return null;}}),user.guildId,address(999));
  await assert.rejects(service.claim(user,address(1),'message:cooldown'),errorCode('COOLDOWN'));assert.equal(reads,0);
});
