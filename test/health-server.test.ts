import test from 'node:test';
import assert from 'node:assert/strict';
import { startHealthServer, webPort } from '../src/health-server.js';
import { errorCode } from './helpers.js';

test('workers need no HTTP port and invalid configured ports fail clearly',async()=>{
  assert.equal(webPort({}),null);assert.equal(webPort({PORT:''}),null);assert.equal(webPort({PORT:'10000'}),10000);
  for(const value of ['0','-1','65536','10000x','1.5']) assert.throws(()=>webPort({PORT:value}),errorCode('CONFIG'));
  assert.equal(await startHealthServer(null,()=>true),null);
});

test('the HTTP endpoint reports startup/readiness and supports Render HEAD probes',async()=>{
  let ready=false;
  const http=(await startHealthServer(0,()=>ready,'127.0.0.1'))!;
  const base=`http://127.0.0.1:${http.port}`;
  try {
    const starting=await fetch(`${base}/healthz`);assert.equal(starting.status,503);
    assert.deepEqual(await starting.json(),{service:'FaucetBeacon',status:'starting'});
    ready=true;
    const running=await fetch(`${base}/healthz`);assert.equal(running.status,200);
    assert.deepEqual(await running.json(),{service:'FaucetBeacon',status:'ready'});
    assert.equal(running.headers.get('cache-control'),'no-store');
    const head=await fetch(base,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
    ready=false;assert.equal((await fetch(base)).status,503);
  } finally {await http.close();}
});

test('HTTP exposes no payout operations or configuration and rejects mutations',async()=>{
  const http=(await startHealthServer(0,()=>true,'127.0.0.1'))!;
  const base=`http://127.0.0.1:${http.port}`;
  try {
    for(const path of ['/claim','/.env','/admin','/balance']) assert.equal((await fetch(base+path)).status,404);
    const mutation=await fetch(`${base}/healthz`,{method:'POST',body:'{}'});
    assert.equal(mutation.status,405);assert.equal(mutation.headers.get('allow'),'GET, HEAD');
    const status=await (await fetch(base)).text();assert.doesNotMatch(status,/guild|wallet|token|secret|balance/i);
  } finally {await http.close();}
});
