import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, verifyMessage } from 'ethers';
import { InterlinkGateway, validateChallenge, GatewayError, type GatewayOptions } from '../src/chain/gateway.js';

const wallet=new Wallet(`0x${'1'.padStart(64,'0')}`);
const baseUrl='https://evm-rpc.test-net.interlinklabs.ai/v1';
const now=Date.parse('2026-10-24T13:00:00Z');
const challengeId='abcdef1234567890abcdef1234567890';
function message(at=now):string {
  return `interlinklabs.ai wants you to sign in with your Interlink account:\n${wallet.address}\n\nSign in to Interlink RPC\n\nURI: ${baseUrl}/auth/verify\nVersion: 1\nChain ID: 19042026\nNonce: ${challengeId}\nIssued At: ${new Date(at).toISOString()}\nExpiration Time: ${new Date(at+120000).toISOString()}\nRequest ID: ${challengeId}`;
}
const tokens=(access='access-1')=>({accessToken:access,refreshToken:`refresh-${access}`,accessTokenExpiresInSec:900,refreshTokenExpiresInSec:604800,walletAddress:wallet.address,tokenType:'Bearer'});
type Call={path:string;body:Record<string,any>;token:string|null};
function fixture(custom?:(call:Call,index:number)=>Response|undefined,extra:Partial<GatewayOptions>={}) {
  const calls:Call[]=[];
  const sleeps:number[]=[];
  const fetcher=(async (input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const path=new URL(String(input)).pathname.replace('/v1','');
    const body=JSON.parse(String(init?.body)) as Record<string,any>;
    const call={path,body,token:new Headers(init?.headers).get('Authorization')};calls.push(call);
    const override=custom?.(call,calls.length-1);if (override) return override;
    let result:unknown;
    if (path==='/auth/challenge') {assert.equal(body.chainId,'19042026');assert.equal(body.walletAddress,wallet.address);result={challengeId,messageToSign:message(),expiresAt:new Date(now+120000).toISOString()};}
    else if (path==='/auth/verify') {assert.equal(verifyMessage(message(),body.signature),wallet.address);assert.equal(body.challengeId,challengeId);result=tokens();}
    else if (path==='/auth/refresh') result=tokens('access-2');
    else result='0x1228eea';
    return Response.json({id:body.id??null,jsonrpc:'2.0',result});
  }) as typeof fetch;
  return {gateway:new InterlinkGateway({baseUrl,chainId:19042026,siweDomain:'interlinklabs.ai',wallet,timeoutMs:1000,fetch:fetcher,now:()=>now,sleep:async ms=>{sleeps.push(ms);},random:()=>0,...extra}),calls,sleeps};
}
test('verified live gateway schema signs original Interlink text and uses string chainId',async()=>{
  const {gateway,calls}=fixture();await gateway.initialize();
  assert.deepEqual(calls.map(c=>c.path),['/auth/challenge','/auth/verify','/rpc']);
  assert.equal(calls[2]?.token,'Bearer access-1');
});
test('SIWE validation rejects other domains, wallet addresses, chains, nonces and expired messages',()=>{
  const options={wallet,chainId:19042026,siweDomain:'interlinklabs.ai',baseUrl};
  validateChallenge(message(),challengeId,options,now);
  for (const invalid of [message().replace('interlinklabs.ai wants','evil.example wants'),message().replace(wallet.address,'0x1111111111111111111111111111111111111111'),message().replace('19042026','1'),message(now-200000),message().replace(`Request ID: ${challengeId}`,'Request ID: different'),message().replace('/auth/verify','/anything-else')]) {
    assert.throws(()=>validateChallenge(invalid,challengeId,options,now),error=>error instanceof GatewayError&&error.code==='AUTH_CHALLENGE');
  }
});
test('startup stops on the mismatched hex chain ID supplied in old documentation',async()=>{
  const {gateway}=fixture(call=>call.path==='/rpc'?Response.json({id:call.body.id,jsonrpc:'2.0',result:'0x1228aea'}):undefined);
  await assert.rejects(gateway.initialize(),error=>error instanceof GatewayError&&error.code==='CHAIN_ID');
});
test('a 401 rotates tokens and retries the same RPC once',async()=>{
  let rpcCount=0;
  const {gateway,calls}=fixture(call=>call.path==='/rpc'&&++rpcCount===1?Response.json({error:'expired'},{status:401}):undefined);
  await gateway.initialize();
  assert.equal(calls.filter(c=>c.path==='/auth/refresh').length,1);
  assert.equal(calls.at(-1)?.token,'Bearer access-2');
});
test('access tokens refresh before expiry and concurrent RPC calls share one refresh',async()=>{
  let time=now;
  const {gateway,calls}=fixture(undefined,{now:()=>time});await gateway.initialize();time+=841000;
  await Promise.all([gateway.rpc('eth_blockNumber',[]),gateway.rpc('eth_gasPrice',[]),gateway.rpc('eth_chainId',[])]);
  assert.equal(calls.filter(c=>c.path==='/auth/challenge').length,1);
  assert.equal(calls.filter(c=>c.path==='/auth/refresh').length,1);
});
test('concurrent initial requests share one SIWE login',async()=>{
  const {gateway,calls}=fixture();await Promise.all([gateway.initialize(),gateway.rpc('eth_blockNumber',[]),gateway.rpc('eth_gasPrice',[])]);
  assert.equal(calls.filter(c=>c.path==='/auth/challenge').length,1);assert.equal(calls.filter(c=>c.path==='/auth/verify').length,1);
});
test('refresh failure hard-logs-out without silently signing another challenge',async()=>{
  let expired=false;
  const {gateway,calls}=fixture(call=>{
    if (call.path==='/rpc'&&expired) return Response.json({error:'expired'},{status:401});
    if (call.path==='/auth/refresh') return Response.json({error:'bad refresh'},{status:401});
    return undefined;
  });await gateway.initialize();expired=true;
  await assert.rejects(gateway.rpc('eth_blockNumber',[]),error=>error instanceof GatewayError&&error.code==='AUTH_LOCKED');
  await assert.rejects(gateway.rpc('eth_blockNumber',[]));
  assert.equal(calls.filter(c=>c.path==='/auth/challenge').length,1);
  gateway.resetAuthentication();expired=false;await gateway.initialize();assert.equal(calls.filter(c=>c.path==='/auth/challenge').length,2);
});
test('HTTP 429 retries with exponential delay and honors Retry-After',async()=>{
  let attempts=0;
  const {gateway,sleeps}=fixture(call=>call.path==='/rpc'&&++attempts<3?new Response('',{status:429,headers:{'Retry-After':'2'}}):undefined);
  await gateway.initialize();assert.deepEqual(sleeps,[2000,2000]);assert.equal(attempts,3);
});
test('JSON-RPC RATE_LIMITED errors also back off',async()=>{
  let attempts=0;
  const {gateway,sleeps}=fixture(call=>call.path==='/rpc'&&++attempts<3?Response.json({id:call.body.id,jsonrpc:'2.0',error:{code:-32005,message:'RATE_LIMITED'}}):undefined);
  await gateway.initialize();assert.deepEqual(sleeps,[500,1000]);
});
test('wrong response IDs and potentially secret provider messages are not exposed',async()=>{
  const mismatch=fixture(call=>call.path==='/rpc'?Response.json({id:9999,jsonrpc:'2.0',result:'0x1228eea'}):undefined);
  await assert.rejects(mismatch.gateway.initialize(),error=>error instanceof GatewayError&&error.code==='RPC_SCHEMA');
  const rejected=fixture(call=>call.path==='/rpc'?Response.json({id:call.body.id,jsonrpc:'2.0',error:{code:-32000,message:'private-secret 0xsignedraw nonce too low'}}):undefined);
  await assert.rejects(rejected.gateway.initialize(),error=>error instanceof GatewayError&&error.nonceTooLow&&!error.message.includes('private-secret'));
});
