import { randomUUID } from 'node:crypto';
import { FaucetError, HOURS, safeError, type Actor, type BalanceAlertConfig, type BalanceAlertEvent, type BalanceAlertState } from './domain.js';
import type { FaucetService } from './service.js';
import type { DiscordMessageRef, WorkerLease } from './supabase-store.js';

export interface BalanceAlertTransport {
  find(guildId:string,config:BalanceAlertConfig,event:BalanceAlertEvent):Promise<DiscordMessageRef|null>;
  send(guildId:string,config:BalanceAlertConfig,event:BalanceAlertEvent,test:boolean):Promise<DiscordMessageRef>;
}
export function defaultBalanceAlerts():BalanceAlertConfig {
  return {version:'unconfigured',enabled:false,channelId:null,thresholdWei:'1000000000000000000',userIds:[],roleIds:[],repeatMs:6*HOURS};
}
export function validateBalanceAlerts(config:BalanceAlertConfig,guildId:string):BalanceAlertConfig {
  const id=(value:unknown)=>typeof value==='string' && /^\d{17,20}$/.test(value);
  if (!config || typeof config.version!=='string' || config.version.length>64 || typeof config.enabled!=='boolean'
    || (config.channelId!==null && !id(config.channelId)) || typeof config.thresholdWei!=='string' || !/^[1-9][0-9]{0,77}$/.test(config.thresholdWei)
    || !Array.isArray(config.userIds) || !Array.isArray(config.roleIds) || !config.userIds.every(id) || !config.roleIds.every(id)
    || config.userIds.length+config.roleIds.length>20 || config.roleIds.includes(guildId)
    || !Number.isSafeInteger(config.repeatMs) || (config.repeatMs!==0 && (config.repeatMs<HOURS || config.repeatMs>168*HOURS))) {
    throw new FaucetError('ALERT_CONFIG','Choose a positive threshold, up to 20 user/role targets, and reminders of 0 (off) or 1–168 hours. @everyone is not allowed.');
  }
  return {...config,userIds:[...new Set(config.userIds)],roleIds:[...new Set(config.roleIds)]};
}
export class BalanceAlerts {
  private nextCheckAt=0;
  private readonly states=new Map<string,BalanceAlertState>();
  private readonly sent=new Map<string,DiscordMessageRef>();
  private readonly locks=new Map<string,Promise<unknown>>();
  private lastError='';
  constructor(private readonly services:ReadonlyMap<string,FaucetService>,
    private readonly chain:{balance():Promise<bigint>},private readonly transport:BalanceAlertTransport,
    private readonly now:()=>number=Date.now,private readonly log:(message:string)=>void=console.error) {}
  get due():boolean {return this.now()>=this.nextCheckAt;}
  private service(guildId:string):FaucetService {
    const service=this.services.get(guildId);
    if (!service) throw new FaucetError('WRONG_SERVER','This server is not enabled for the faucet.');
    return service;
  }
  private async exclusive<T>(guildId:string,work:()=>Promise<T>):Promise<T> {
    const running=(this.locks.get(guildId)??Promise.resolve()).catch(()=>{}).then(work);
    this.locks.set(guildId,running);
    try {return await running;} finally {if(this.locks.get(guildId)===running) this.locks.delete(guildId);}
  }
  async config(guildId:string):Promise<BalanceAlertConfig> {
    return validateBalanceAlerts((await this.service(guildId).store.settings()).balanceAlerts??defaultBalanceAlerts(),guildId);
  }
  async configure(actor:Actor,change:(current:BalanceAlertConfig)=>BalanceAlertConfig):Promise<BalanceAlertConfig> {
    const service=this.service(actor.guildId);service.assertAdmin(actor);
    return this.exclusive(actor.guildId,async()=>{
      const next=validateBalanceAlerts({...change(await this.config(actor.guildId)),version:randomUUID()},actor.guildId);
      await service.changeSettings(actor,{balanceAlerts:next});
      this.states.delete(actor.guildId);this.nextCheckAt=0;
      return next;
    });
  }
  async test(actor:Actor,requestId:string):Promise<void> {
    this.service(actor.guildId).assertAdmin(actor);
    const config=await this.config(actor.guildId);this.assertReady(config);
    const balance=await this.chain.balance();
    await this.transport.send(actor.guildId,config,{id:`test:${requestId}`,createdAt:this.now(),balanceWei:balance.toString()},true);
  }
  private assertReady(config:BalanceAlertConfig):void {
    if (!config.channelId || !(config.userIds.length+config.roleIds.length)) throw new FaucetError('ALERT_SETUP','Set an alert channel and add at least one user or role first.');
  }
  private async save(guildId:string,state:BalanceAlertState,lease:WorkerLease):Promise<void> {
    try {await this.service(guildId).store.saveBalanceAlertState(state,lease);this.states.set(guildId,state);}
    catch(error) {this.states.delete(guildId);throw error;}
  }
  private report(error:unknown):void {
    const message=`BALANCE_ALERT: ${safeError(error)}`;
    if (message!==this.lastError) {this.log(message);this.lastError=message;}
  }
  async check(lease:WorkerLease):Promise<void> {
    if (!this.due) return;
    this.nextCheckAt=this.now()+60000;
    const configs:{guildId:string;config:BalanceAlertConfig}[]=[];
    for (const guildId of this.services.keys()) {
      try {
        const config=await this.config(guildId);
        if (config.enabled && config.channelId && config.userIds.length+config.roleIds.length) configs.push({guildId,config});
      } catch(error) {this.report(error);}
    }
    if (!configs.length) return;
    let balance:bigint;
    try {balance=await this.chain.balance();if(balance<0n) throw new FaucetError('RPC_SCHEMA','The wallet balance is invalid.');}
    catch(error) {this.report(error);return;} // An RPC outage is never a zero balance.
    for (const {guildId,config} of configs) {
      try {await this.exclusive(guildId,async()=>{
        if ((await this.config(guildId)).version!==config.version) return;
        const store=this.service(guildId).store;
        let state=this.states.get(guildId)??await store.balanceAlertState();
        if (!state || state.configVersion!==config.version) state={configVersion:config.version,low:false,lastSentAt:null,pending:null};
        this.states.set(guildId,state);
        if (balance>=BigInt(config.thresholdWei)) {
          if (state.low || state.pending) await this.save(guildId,{...state,low:false,pending:null},lease);
          return;
        }
        if (state.low && !state.pending && (config.repeatMs===0 || (state.lastSentAt!==null && this.now()-state.lastSentAt<config.repeatMs))) return;
        const retry=!!state.pending;
        if (!state.pending) {
          state={...state,low:true,pending:{id:randomUUID(),createdAt:this.now(),balanceWei:balance.toString()}};
          await this.save(guildId,state,lease); // Persist the event ID before posting a ping.
        }
        const event=state.pending!;
        let ref=this.sent.get(event.id);
        if (!ref && retry) ref=await this.transport.find(guildId,config,event)??undefined;
        if (!ref) {
          await store.verifyLease(lease);
          ref=await this.transport.send(guildId,config,event,false);
        }
        this.sent.set(event.id,ref);
        if (this.sent.size>100) this.sent.delete(this.sent.keys().next().value!);
        await this.save(guildId,{...state,lastSentAt:this.now(),pending:null},lease);
        this.sent.delete(event.id);this.lastError='';
      });} catch(error) {this.report(error);}
    }
  }
}
