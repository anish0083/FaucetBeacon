import { Client, Events, GatewayIntentBits } from 'discord.js';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, type Config } from './config.js';
import { SupabaseStore } from './supabase-store.js';
import { FaucetService } from './service.js';
import { InterlinkGateway } from './chain/gateway.js';
import { NativeTransfers } from './chain/transfers.js';
import { PayoutEngine } from './engine.js';
import { attachBot, payoutChannel, resolveActor } from './discord/bot.js';
import { PayoutMessages } from './discord/payout-messages.js';
import { FaucetError, safeError } from './domain.js';
import { registerGuildCommands } from './discord/register.js';
import { BalanceAlerts } from './balance-alerts.js';
import { createBalanceAlertTransport } from './discord/balance-alerts.js';
import { keepAliveIntervalMs, keepAliveTarget, startHealthServer, startKeepAlive, webPort } from './health-server.js';
import { RuntimeHealth, startRuntimeWatchdog, type StartupStage } from './runtime-health.js';
import { attachDiscordStartupDiagnostics, discordGatewayRequest, discordLoginError } from './discord/connection.js';

async function main(): Promise<void> {
  const config = loadConfig();
  let ready=()=>false;
  const health=new RuntimeHealth();
  const http=await startHealthServer(webPort(),()=>health.status(ready()));
  if (http) console.log(`HTTP status listening on 0.0.0.0:${http.port}; health check: /healthz.`);
  const target=keepAliveTarget();
  const keepAlive=startKeepAlive(target,keepAliveIntervalMs());
  if (target) console.log(`Keep-alive pinging ${target} every ${Math.round(keepAliveIntervalMs()/60000)} minutes.`);
  const watchdog=startRuntimeWatchdog(health,()=>ready(),error=>{
    console.error(safeError(error));
    // Cleanup can also be blocked on the failed network. Durable payouts and the
    // expiring database lease let a replacement process recover safely.
    process.exit(1);
  });
  try {await runBot(config,check=>{ready=check;},stage=>{
    health.setStage(stage);
    console.log(`Bot stage: ${stage}.`);
  });}
  finally {watchdog();keepAlive?.();await http?.close();}
}

async function runBot(config:Config,setReady:(check:()=>boolean)=>void,setStage:(stage:StartupStage)=>void):Promise<void> {
  setStage('database');
  const store = new SupabaseStore({ ...config.supabase, guildIds: config.discord.guildIds });
  const health = await store.health();
  if (health.schemaVersion !== 3) throw new FaucetError('DATABASE_SCHEMA', 'Apply the current supabase/schema.sql (version 3, multiple servers) before starting the bot.');
  const services = new Map<string, FaucetService>();
  for (const guildId of config.discord.guildIds) {
    const scoped = store.forGuild(guildId);
    await scoped.initialize(guildId, config.wallet.address, config.chainId, config.initialSettings);
    services.set(guildId, new FaucetService(scoped, guildId, config.wallet.address));
  }
  const service = services.get(config.discord.guildId)!;
  const gateway = new InterlinkGateway({baseUrl:config.rpcBaseUrl,chainId:config.chainId,siweDomain:config.siweDomain,timeoutMs:config.rpcTimeoutMs,wallet:config.wallet});
  const chain = new NativeTransfers(gateway,{wallet:config.wallet,chainId:config.chainId,maxFeePerGas:config.maxFeePerGas,maxGasLimit:config.maxGasLimit});
  const client = new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],allowedMentions:{parse:[],repliedUser:false},rest:{makeRequest:discordGatewayRequest()}});
  const engine = new PayoutEngine(service,chain,async (userId,channelId,guildId) => {
    await payoutChannel(client,channelId,guildId);
    return resolveActor(client,guildId,userId,channelId);
  },config.confirmations,Date.now,console.error,services);
  const messages=new PayoutMessages(job=>{
    const scoped=services.get(job.guildId)?.store;
    if (!scoped) throw new FaucetError('WRONG_SERVER','This payout server is not active in the bot allowlist.');
    return scoped;
  },{
    send:async(job,body,nonce)=>{
      const channel=await payoutChannel(client,job.channelId,job.guildId);
      const sent=await channel.send({...body,nonce,enforceNonce:true});
      return {channelId:sent.channelId,messageId:sent.id};
    },
    edit:async(job,ref,body)=>{
      const channel=await payoutChannel(client,ref.channelId,job.guildId);
      await channel.messages.edit(ref.messageId,{...body,attachments:[]});
    },
  },config);
  const alerts=new BalanceAlerts(services,chain,createBalanceAlertTransport(client,config));
  attachBot(client,services,engine,config,messages,alerts);
  const register = async (guildId: string) => {
    if (!services.has(guildId)) return;
    await registerGuildCommands(client.rest,config.discord.clientId,guildId);
    console.log(`Commands ready in server ${guildId}.`);
  };
  client.on(Events.GuildCreate,guild => { void register(guild.id).catch(error => console.error(safeError(error))); });
  let stopping = false;
  let initialized = false;
  // Readiness does not wait for lease ownership: old instances can release it during deploys.
  setReady(()=>initialized && !stopping && client.isReady());
  const stop = () => { stopping = true;setStage('shutdown'); };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  client.on(Events.Error,() => console.error('DISCORD_CONNECTION: Discord reported a connection error.'));
  client.on(Events.ShardError,(_error,id) => console.error(`DISCORD_CONNECTION: Shard ${id} reported a connection error.`));
  client.on(Events.ShardDisconnect,(event,id) => console.error(`DISCORD_DISCONNECTED: Shard ${id} closed with code ${event.code}.`));
  client.on(Events.ShardReconnecting,id => console.log(`DISCORD_RECONNECTING: Shard ${id} is reconnecting.`));
  client.on(Events.ShardResume,id => console.log(`DISCORD_RESUMED: Shard ${id} resumed its connection.`));
  client.on(Events.ClientReady,() => console.log('DISCORD_READY: Discord connection is ready.'));
  const stopDiagnostics=attachDiscordStartupDiagnostics(client,setStage);
  try {
    setStage('discord_login');
    await client.login(config.discord.token).catch(error => {
      throw discordLoginError(error);
    });
    if (!client.isReady()) await new Promise<void>(resolve => client.once(Events.ClientReady,() => resolve()));
    stopDiagnostics();
    setStage('commands');
    for (const guildId of config.discord.guildIds) {
      if (client.guilds.cache.has(guildId)) await register(guildId);
      else console.log(`Awaiting an invite to allowlisted server ${guildId}.`);
    }
    // The chain client refuses both submissions and receipt reads until verified.
    setStage('chain');
    try { await chain.initialize(); } catch (error) { console.error(safeError(error)); }
    console.log(`Faucet Beacon connected as ${client.user?.tag}. Funding address: ${config.wallet.address}.`);
    setStage('settings');
    for (const [guildId, context] of services) {
      const [settings,channels] = await Promise.all([context.store.settings(),context.store.channels()]);
      console.log(`Server ${guildId}: faucet ${settings.enabled ? 'running' : 'paused'}; ${channels.length} approved channel(s).`);
    }
    initialized=true;
    setStage(stopping?'shutdown':'running');
    while (!stopping) {
      if (client.isReady()) {
        await engine.flushNotifications(job=>messages.deliver(job),job=>messages.progress(job));
        await engine.tick();
        if (alerts.due) await engine.maintain(lease=>alerts.check(lease));
      }
      if (!stopping) await delay(config.pollIntervalMs);
    }
  } finally {
    stopDiagnostics();
    setStage('shutdown');
    await engine.close();
    await client.destroy();
    process.removeListener('SIGINT',stop);
    process.removeListener('SIGTERM',stop);
  }
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
