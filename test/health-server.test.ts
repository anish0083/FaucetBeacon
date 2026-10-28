import test from 'node:test';
import assert from 'node:assert/strict';
import { keepAliveIntervalMs, keepAliveTarget, startHealthServer, startKeepAlive, webPort } from '../src/health-server.js';
import { errorCode } from './helpers.js';
import { RuntimeHealth } from '../src/runtime-health.js';

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

test('HTTP distinguishes stalled startup, Discord reconnects and shutdown with unhealthy probes',async()=>{
  let ready=false;
  const health=new RuntimeHealth();
  const http=(await startHealthServer(0,()=>health.status(ready),'127.0.0.1'))!;
  const base=`http://127.0.0.1:${http.port}/healthz`;
  try {
    health.setStage('discord_login');
    const startup=await fetch(base);assert.equal(startup.status,503);
    assert.deepEqual(await startup.json(),{service:'FaucetBeacon',status:'starting',stage:'discord_login'});
    health.setStage('running');ready=true;
    assert.equal((await fetch(base)).status,200);
    ready=false;
    const reconnect=await fetch(base);assert.equal(reconnect.status,503);
    assert.deepEqual(await reconnect.json(),{service:'FaucetBeacon',status:'reconnecting',stage:'running'});
    assert.equal((await fetch(base,{method:'HEAD'})).status,503);
    ready=true;assert.equal((await fetch(base)).status,200);
    health.setStage('shutdown');
    const shutdown=await fetch(base);assert.equal(shutdown.status,503);
    assert.deepEqual(await shutdown.json(),{service:'FaucetBeacon',status:'stopping',stage:'shutdown'});
  } finally {await http.close();}
});

test('keep-alive uses the public Render URL and ignores localhost',()=>{
  assert.equal(keepAliveTarget({}),null);
  assert.equal(keepAliveTarget({RENDER_EXTERNAL_URL:'https://faucet-beacon.onrender.com'}), 'https://faucet-beacon.onrender.com/healthz');
  assert.equal(keepAliveTarget({KEEP_ALIVE_URL:'faucet-beacon.onrender.com/other'}),'https://faucet-beacon.onrender.com/healthz');
  assert.equal(keepAliveTarget({RENDER_EXTERNAL_URL:'http://127.0.0.1:10000'}),null);
  assert.equal(keepAliveTarget({KEEP_ALIVE_URL:'https://user:pass@example.com'}),null);
  assert.equal(keepAliveIntervalMs({}),8*60*1000);
  assert.equal(keepAliveIntervalMs({KEEP_ALIVE_MS:'300000'}),300000);
  assert.throws(()=>keepAliveIntervalMs({KEEP_ALIVE_MS:'1000'}),errorCode('CONFIG'));
});

test('keep-alive pings the public health URL on an interval',async()=>{
  const hits:string[]=[];
  assert.equal(startKeepAlive(null),null);
  const stop=startKeepAlive('https://faucet-beacon.onrender.com/healthz',20,async target=>{hits.push(target);})!;
  try {
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.ok(hits.length>=1);
    assert.equal(hits[0],'https://faucet-beacon.onrender.com/healthz');
  } finally {stop();}
});
