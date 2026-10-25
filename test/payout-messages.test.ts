import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { PayoutMessages, payoutResult, type PayoutMessageBody, type PayoutMessageTransport } from '../src/discord/payout-messages.js';
import { claimReplyOptions, queuedCard } from '../src/discord/embeds.js';
import { loadingGif } from '../src/content/loading.js';
import type { DiscordMessageRef } from '../src/supabase-store.js';
import { databaseStub, makePayout } from './helpers.js';

const config={symbol:'tITL',explorerUrl:'https://explorer.test-net.interlinklabs.ai'};
function fixture(){
  const job=makePayout();const refs=new Map<string,DiscordMessageRef>();
  const sent:{body:PayoutMessageBody;nonce:string}[]=[];const edited:PayoutMessageBody[]=[];
  let editError:unknown;
  const store=databaseStub({payout:async()=>({...job}),discordMessage:async(_job,kind)=>refs.get(kind)??null,
    saveDiscordMessage:async(_job,kind,ref)=>{refs.set(kind,ref);}});
  const transport:PayoutMessageTransport={send:async(_job,body,nonce)=>{
    sent.push({body,nonce});return {channelId:job.channelId,messageId:String(500000000000000000n+BigInt(sent.length))};
  },edit:async(_job,_ref,body)=>{if(editError) throw editError;edited.push(body);}};
  const create=()=>new PayoutMessages(()=>store,transport,config,()=>job.createdAt+1000,()=>{});
  return {job,refs,sent,edited,create,store,setEditError:(error:unknown)=>{editError=error;}};
}

test('claim acknowledgements are public, while admin and status replies remain private',()=>{
  assert.deepEqual(claimReplyOptions('faucet','claim'),{});
  for (const [command,sub] of [['faucet','status'],['faucet-admin','start'],['faucet-mod','bulk']]) {
    assert.equal(claimReplyOptions(command!,sub!).flags,MessageFlags.Ephemeral);
  }
});

test('accepted claims display before metadata writes and a lost write response never becomes a rejection or duplicate card',async()=>{
  const f=fixture();const messages=f.create();let saves=0;let acknowledgements=0;
  const save=f.store.saveDiscordMessage;
  f.store.saveDiscordMessage=async(...args)=>{
    saves++;await save(...args);
    if (saves===1) throw new Error('Response lost after commit');
  };
  f.store.discordMessage=async()=>{throw new Error('Acknowledgement must not need another read');};
  f.store.payout=async()=>{throw new Error('Acknowledgement must use the accepted claim');};
  await messages.acknowledge(f.job,async body=>{
    acknowledgements++;assert.equal(saves,0);assert.match(JSON.stringify(body.embeds),/In progress/);
    return {channelId:f.job.channelId,messageId:'600000000000000001'};
  });
  await messages.progress(f.job);
  assert.equal(acknowledgements,1);assert.equal(saves,2);assert.equal(f.sent.length,0);assert.equal(f.edited.length,0);
});

test('unchanged queued cards do not add per-payout database reads on every poll',async()=>{
  const f=fixture();const messages=f.create();await messages.progress(f.job);
  f.store.discordMessage=async()=>{throw new Error('Unnecessary read');};
  f.store.payout=async()=>{throw new Error('Unnecessary payout read');};
  for (let i=0;i<100;i++) await messages.progress(f.job);
  assert.equal(f.sent.length,1);assert.equal(f.edited.length,0);
});

test('a lost success-reference response retries persistence without another success ping',async()=>{
  const f=fixture();const messages=f.create();await messages.progress(f.job);
  Object.assign(f.job,{status:'confirmed',txHash:`0x${'a'.repeat(64)}`,confirmedAt:f.job.createdAt+5000});
  const save=f.store.saveDiscordMessage;let failed=false;
  f.store.saveDiscordMessage=async(...args)=>{
    await save(...args);
    if (args[1]==='confirmed' && !failed) {failed=true;throw new Error('Lost insert response');}
  };
  await assert.rejects(messages.deliver(f.job));await messages.deliver(f.job);
  assert.equal(f.sent.length,2);
});

test('the progress card references the bundled animated GIF and identifies the claimant',()=>{
  const job=makePayout();const embed=queuedCard(job,config.symbol,job.createdAt).toJSON();
  assert.match(embed.title!,/In progress/);assert.equal(embed.thumbnail?.url,'attachment://faucet-loading.gif');
  assert.ok(embed.description?.includes(`<@${job.userId}>`));
  assert.equal(loadingGif.subarray(0,6).toString(),'GIF89a');assert.ok(loadingGif.includes(Buffer.from('NETSCAPE2.0')));
});

test('success sends a real, single-user ping with quote and explorer, and bulk notices do not ping the operator',()=>{
  const job=makePayout({status:'confirmed',txHash:`0x${'a'.repeat(64)}`,confirmedAt:Date.now()});
  const body=payoutResult(job,config);
  assert.ok(body.content?.startsWith(`<@${job.userId}>`));assert.deepEqual(body.allowedMentions,{parse:[],repliedUser:false,users:[job.userId]});
  assert.match(JSON.stringify(body.embeds),/Payment successful/);assert.match(JSON.stringify(body.embeds),/> /);assert.ok(body.components?.length);
  assert.equal(payoutResult({...job,kind:'bulk'},config).content,'');
});

test('progress is updated in place, completes after confirmation and recovers without repeat success pings after restart',async()=>{
  const f=fixture();let messages=f.create();await messages.progress(f.job);await messages.progress(f.job);
  assert.equal(f.sent.length,1);assert.equal(f.edited.length,0);
  f.job.status='broadcast';await messages.progress(f.job);assert.equal(f.edited.length,1);
  Object.assign(f.job,{status:'confirmed',txHash:`0x${'b'.repeat(64)}`,confirmedAt:f.job.createdAt+5000});
  await messages.deliver(f.job);assert.equal(f.sent.length,2);
  assert.deepEqual(f.edited.at(-1)?.files,[]);assert.match(JSON.stringify(f.edited.at(-1)?.embeds),/Payment completed/);
  messages=f.create();await messages.deliver(f.job);assert.equal(f.sent.length,2);
});

test('a worker that beats the slash reply still completes the interaction and links the existing message',async()=>{
  const f=fixture();const messages=f.create();await messages.progress(f.job);let acknowledgement:PayoutMessageBody|undefined;
  await messages.progress(f.job,async body=>{acknowledgement=body;return {channelId:f.job.channelId,messageId:'600000000000000001'};});
  assert.match(acknowledgement?.content??'',/discord.com\/channels/);assert.equal(f.sent.length,1);
});

test('deleted progress is recreated but Discord outages do not create extra messages',async()=>{
  const f=fixture();await f.create().progress(f.job);
  f.setEditError(new Error('temporary network failure'));
  await assert.rejects(f.create().progress(f.job));assert.equal(f.sent.length,1);
  f.setEditError({code:10008});await f.create().progress(f.job);assert.equal(f.sent.length,2);
});
