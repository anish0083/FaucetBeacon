import { createHash } from 'node:crypto';
import type { MessageCreateOptions } from 'discord.js';
import type { Config } from '../config.js';
import { safeError, tokens, type Payout } from '../domain.js';
import type { DiscordMessageRef, DiscordNoticeKind, FaucetDatabase } from '../supabase-store.js';
import { card, colors, explorerButton, progressFiles, progressStage, queuedCard, successCard } from './embeds.js';

export type PayoutMessageBody=Pick<MessageCreateOptions,'content'|'embeds'|'components'|'files'|'allowedMentions'>;
export interface PayoutMessageTransport {
  send(job:Payout,body:PayoutMessageBody,nonce:string):Promise<DiscordMessageRef>;
  edit(job:Payout,ref:DiscordMessageRef,body:PayoutMessageBody):Promise<void>;
}
const noMentions={parse:[] as [],repliedUser:false};

export function payoutResult(job:Payout,config:Pick<Config,'symbol'|'explorerUrl'>):PayoutMessageBody {
  const success=job.status==='confirmed';
  const mention=success && job.kind==='claim';
  const embed=success ? successCard(job,config.symbol,config.explorerUrl)
    : card(job.status==='review'?'Payout awaiting verification':'Payout did not complete',
      job.status==='review'?'The original transfer is still being checked. We’ll update you here once its outcome is confirmed.'
        : `This payout is **${job.status}**. Reason: **${job.errorCode??'unavailable'}**.`,colors.warning)
      .addFields({name:'Wallet',value:`\`${job.address}\``}).setFooter({text:`ITL Testnet · Payout ${job.id}`});
  return {content:mention?`<@${job.userId}> ✅ Your **${tokens(job.amountWei)} ${config.symbol}** has arrived!`:'',
    embeds:[embed],components:job.txHash?[explorerButton(config.explorerUrl,job.txHash)]:[],
    allowedMentions:mention?{...noMentions,users:[job.userId]}:noMentions};
}

/** Discord delivery never controls signing or releases payout reservations. */
export class PayoutMessages {
  private readonly locks=new Map<string,Promise<void>>();
  private readonly stages=new Map<string,string>();
  private readonly references=new Map<string,{ref:DiscordMessageRef;persisted:boolean}>();
  constructor(private readonly storeFor:(job:Payout)=>FaucetDatabase,
    private readonly transport:PayoutMessageTransport,
    private readonly config:Pick<Config,'symbol'|'explorerUrl'>,
    private readonly now:()=>number=Date.now,
    private readonly log:(message:string)=>void=console.error) {}

  private async exclusive(job:Payout,work:()=>Promise<void>):Promise<void> {
    const running=(this.locks.get(job.id)??Promise.resolve()).catch(()=>{}).then(work);
    this.locks.set(job.id,running);
    try {await running;} finally {if (this.locks.get(job.id)===running) this.locks.delete(job.id);}
  }
  private nonce(job:Payout,kind:string):string {
    return createHash('sha256').update(`${job.guildId}:${job.id}:${kind}`).digest('hex').slice(0,24);
  }
  private key(job:Payout,kind:DiscordNoticeKind):string {return `${job.guildId}:${job.id}:${kind}`;}
  private remember(job:Payout,kind:DiscordNoticeKind,ref:DiscordMessageRef,persisted:boolean) {
    const key=this.key(job,kind);
    if (!this.references.has(key) && this.references.size>=2000) this.references.delete(this.references.keys().next().value!);
    const entry={ref,persisted};this.references.set(key,entry);return entry;
  }
  private async reference(job:Payout,kind:DiscordNoticeKind) {
    const cached=this.references.get(this.key(job,kind));
    if (cached) return cached;
    const ref=await this.storeFor(job).discordMessage(job,kind);
    return ref?this.remember(job,kind,ref,true):null;
  }
  private async persist(job:Payout,kind:DiscordNoticeKind,entry:{ref:DiscordMessageRef;persisted:boolean}):Promise<void> {
    if (entry.persisted) return;
    await this.storeFor(job).saveDiscordMessage(job,kind,entry.ref);
    entry.persisted=true;
  }
  async acknowledge(job:Payout,initial:(body:PayoutMessageBody)=>Promise<DiscordMessageRef>):Promise<void> {
    // Claim admission has already committed. A display failure cannot reject it.
    try {await this.progress(job,initial);}
    catch (error) {this.log(`CLAIM_ACCEPTED_NOTICE_RETRY: ${job.id} · ${safeError(error)}`);}
  }
  progress(job:Payout,initial?:(body:PayoutMessageBody)=>Promise<DiscordMessageRef>):Promise<void> {
    return this.exclusive(job,async()=>{
      if (job.kind!=='claim') return;
      const stage=progressStage(job,this.now());
      const cached=this.references.get(this.key(job,'progress'));
      if (!initial && cached) await this.persist(job,'progress',cached);
      // Worker snapshots are authoritative; unchanged cards need no per-payout reads.
      if (!initial && this.stages.get(job.id)===stage) return;
      const pending=['queued','signed','broadcast','review'].includes(job.status);
      const body:PayoutMessageBody=pending
        ? {embeds:[queuedCard(job,this.config.symbol,this.now())],files:progressFiles(),allowedMentions:noMentions}
        : {embeds:[card(job.status==='confirmed'?'Payment completed ✅':'Request closed',
          job.status==='confirmed'?`**${tokens(job.amountWei)} ${this.config.symbol}** delivered. Your receipt is below.`:`This payout is **${job.status}**.`,
          job.status==='confirmed'?colors.success:colors.warning)],files:[],components:job.txHash?[explorerButton(this.config.explorerUrl,job.txHash)]:[],allowedMentions:noMentions};
      if (initial) {
        if (cached) {
          await initial({content:`Your payout is being tracked [here](https://discord.com/channels/${job.guildId}/${cached.ref.channelId}/${cached.ref.messageId}).`,embeds:[],files:[],allowedMentions:noMentions});
          return;
        }
        // Show acceptance before optional message-reference writes or extra reads.
        const ref=await initial(body);
        const entry=this.remember(job,'progress',ref,false);
        if (this.stages.size>=2000) this.stages.delete(this.stages.keys().next().value!);
        this.stages.set(job.id,stage);
        await this.persist(job,'progress',entry);
        return;
      }
      let entry=await this.reference(job,'progress');
      let ref=entry?.ref??null;
      if (ref) {
        try {
          await this.transport.edit(job,ref,body);
        }
        catch (error) {
          if (!(typeof error==='object' && error && 'code' in error && Number(error.code)===10008)) throw error;
          ref=null; // A deleted message is recreated; transient errors are retried in place.
        }
      }
      if (!ref) {
        ref=await this.transport.send(job,body,this.nonce(job,'progress'));
        entry=this.remember(job,'progress',ref,false);
      }
      await this.persist(job,'progress',entry!);
      if (this.stages.size>=2000) this.stages.delete(this.stages.keys().next().value!);
      this.stages.set(job.id,stage);
    });
  }
  async deliver(job:Payout):Promise<void> {
    // Edit the animated card before posting the notification so it never stays loading.
    await this.progress(job);
    await this.exclusive(job,async()=>{
      const kind=job.status as DiscordNoticeKind;
      let entry=await this.reference(job,kind);
      if (!entry) {
        const ref=await this.transport.send(job,payoutResult(job,this.config),this.nonce(job,kind));
        entry=this.remember(job,kind,ref,false);
      }
      await this.persist(job,kind,entry);
      this.stages.delete(job.id);
    });
  }
}
