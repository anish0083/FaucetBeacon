import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkQueue } from '../src/work-queue.js';
import { FaucetService } from '../src/service.js';
import { address, databaseStub, errorCode, makePayout, user } from './helpers.js';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

test('a simulated burst of 1,000 distinct users is bounded to 8 checks and 100 waiters, with no duplicate admission',async()=>{
  const queue=new WorkQueue(8,100);const hold=deferred();let active=0;let maximum=0;
  const admitted=new Set<string>();
  const service=new FaucetService(databaseStub({claim:async(actor,wallet,key)=>{
    active++;maximum=Math.max(maximum,active);await hold.promise;
    assert.ok(!admitted.has(key));admitted.add(key);active--;
    return makePayout({userId:actor.userId,address:wallet,requestKey:key});
  }}),user.guildId,address(9999));
  const results=Promise.allSettled(Array.from({length:1000},(_,i)=>queue.run(`user:${i}`,()=>service.claim({...user,userId:String(300000000000000000n+BigInt(i))},address(i+1),`message:${i}`))));
  assert.equal(queue.size,108);await Promise.resolve();assert.equal(active,8);hold.resolve();
  const done=await results;
  assert.equal(done.filter(r=>r.status==='fulfilled').length,108);
  const rejected=done.filter(r=>r.status==='rejected');assert.equal(rejected.length,892);
  assert.ok(rejected.every(r=>r.status==='rejected' && errorCode('BUSY')(r.reason)));
  assert.equal(maximum,8);assert.equal(admitted.size,108);assert.equal(queue.size,0);
});

test('100 simultaneous users within capacity all finish, and one failing request does not stop the queue',async()=>{
  const queue=new WorkQueue(8,100);let attempted=0;
  const done=await Promise.allSettled(Array.from({length:100},(_,i)=>queue.run(`user:${i}`,async()=>{attempted++;if(i===30) throw new Error('Temporary outage');return i;})));
  assert.equal(attempted,100);assert.equal(done.filter(r=>r.status==='fulfilled').length,99);assert.equal(queue.size,0);
  assert.equal(await queue.run('user:30',async()=>30),30);
});

test('a user cannot occupy multiple active or waiting slots and expired waiters never execute',async()=>{
  const queue=new WorkQueue(1,2,25);const hold=deferred();const active=queue.run('first',()=>hold.promise);
  await assert.rejects(queue.run('first',async()=>{}),errorCode('REQUEST_IN_PROGRESS'));
  let executed=false;
  const waiting=queue.run('second',async()=>{executed=true;});
  await assert.rejects(queue.run('second',async()=>{}),errorCode('REQUEST_IN_PROGRESS'));
  await assert.rejects(waiting,errorCode('BUSY'));assert.equal(executed,false);
  hold.resolve();await active;assert.equal(queue.size,0);
  await queue.run('second',async()=>{executed=true;});assert.equal(executed,true);
});
