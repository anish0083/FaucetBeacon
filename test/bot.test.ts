import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, Events, type Client } from 'discord.js';
import { attachBot } from '../src/discord/bot.js';
import { PayoutMessages, type PayoutMessageBody } from '../src/discord/payout-messages.js';
import type { Config } from '../src/config.js';
import type { PayoutEngine } from '../src/engine.js';
import { FaucetService } from '../src/service.js';
import { FaucetError } from '../src/domain.js';
import { address, databaseStub, defaults, makePayout, user } from './helpers.js';

for (const source of ['message','slash']) test(`${source} claims never report rejection after accepted-payment metadata fails`,async()=>{
  const job=makePayout();const replies:PayoutMessageBody[]=[];let admissions=0;let saves=0;let deferred=false;
  const store=databaseStub({channels:async()=>[user.channelId],settings:async()=>defaults,
    claim:async()=>{if(source==='slash') assert.equal(deferred,true);admissions++;return job;},
    saveDiscordMessage:async()=>{saves++;throw new FaucetError('DATABASE_UNAVAILABLE','Lost metadata response');}});
  const service=new FaucetService(store,user.guildId,address(999));
  const config={symbol:'tITL',explorerUrl:'https://explorer.test-net.interlinklabs.ai',requests:{concurrency:8,queueLimit:100,waitMs:60000}} as Config;
  const messages=new PayoutMessages(()=>store,{send:async()=>{throw new Error('Unexpected worker send');},edit:async()=>{}},config,()=>job.createdAt,()=>{});
  const guild={members:{me:{},fetch:async()=>({permissions:{has:()=>false},roles:{cache:new Map()}})}};
  const channel={guildId:user.guildId,type:ChannelType.GuildText,guild,permissionsFor:()=>({has:()=>true})};
  const emitter=Object.assign(new EventEmitter(),{channels:{fetch:async()=>channel},guilds:{fetch:async()=>guild}});
  attachBot(emitter as unknown as Client,new Map([[user.guildId,service]]),{} as PayoutEngine,config,messages);
  const reply=async(body:PayoutMessageBody)=>{replies.push(body);return {channelId:user.channelId,id:'600000000000000001'};};
  if(source==='message') emitter.emit(Events.MessageCreate,{id:'700000000000000001',author:{id:user.userId,bot:false},guildId:user.guildId,channelId:user.channelId,content:job.address,reply});
  else emitter.emit(Events.InteractionCreate,{id:'700000000000000002',guildId:user.guildId,channelId:user.channelId,user:{id:user.userId},commandName:'faucet',
    isChatInputCommand:()=>true,isButton:()=>false,options:{getSubcommand:()=>'claim',getString:()=>job.address},
    deferReply:async(options:unknown)=>{assert.deepEqual(options,{});deferred=true;},editReply:reply,reply});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(admissions,1);assert.equal(saves,1);assert.equal(replies.length,1);
  assert.match(JSON.stringify(replies[0]!.embeds),/In progress/);assert.doesNotMatch(JSON.stringify(replies),/Request unavailable/);
});
