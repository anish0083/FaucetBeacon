import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { getAddress } from 'ethers';
import { quotes } from '../content/quotes.js';
import { loadingGif } from '../content/loading.js';
import { FaucetError, HOURS, tokens, txUrl, type Draft, type Payout, type Settings } from '../domain.js';

export const colors={brand:0x5865f2,success:0x26c99a,warning:0xf4b860,error:0xef6461};
export function card(title: string, description: string, color: number=colors.brand): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setAuthor({name:'Faucet Beacon · ITL Testnet'}).setTitle(title).setDescription(description).setFooter({text:'Native tITL · Testnet tokens'}).setTimestamp();
}
export function errorCard(error: unknown): EmbedBuilder {
  if (!(error instanceof FaucetError)) return card('Something interrupted that request','Please try again shortly. If this keeps happening, ask an admin to check the bot logs.',colors.error);
  if (error.code==='CLAIM_UNCERTAIN') return card('Checking your request',error.message,colors.warning);
  if (['BUSY','REQUEST_IN_PROGRESS'].includes(error.code)) return card(error.code==='BUSY'?'The faucet is busy':'Your request is already being checked',error.message,colors.warning);
  const humorous=['COOLDOWN','ALREADY_PENDING'].includes(error.code);
  const message=humorous?`${quotes.cooldown.next()}\n\n${error.message}`:error.message;
  const embed=card(humorous?'Easy, future whale 🐳':'Request unavailable',message,error.code==='COOLDOWN'?colors.warning:colors.error);
  if (error.retryAt) embed.addFields({name:'Available again',value:`<t:${Math.ceil(error.retryAt/1000)}:R> · <t:${Math.ceil(error.retryAt/1000)}:f>`});
  return embed;
}
export function statusCard(settings: Settings, symbol: string, pending: number): EmbedBuilder {
  return card(settings.enabled?'The faucet is flowing 💧':'The faucet is paused',settings.enabled?'Post one wallet address or use `/faucet claim` in an approved channel.':settings.pauseReason??'An admin can restart distributions.',settings.enabled?colors.success:colors.warning)
    .addFields({name:'Each claim',value:`${tokens(settings.amountWei)} ${symbol}`,inline:true},{name:'Cooldown',value:`${settings.cooldownMs/HOURS} hours`,inline:true},{name:'Chat detection',value:settings.autoClaim?'On':'Off',inline:true},{name:'Payouts waiting',value:String(pending),inline:true});
}
export function claimReplyOptions(command:string,subcommand:string): {flags?:MessageFlags.Ephemeral} {
  return command==='faucet' && subcommand==='claim' ? {} : {flags:MessageFlags.Ephemeral};
}
export function progressStage(job:Payout,now=Date.now()):string {
  if (['confirmed','failed','cancelled','review'].includes(job.status)) return job.status;
  return now-job.createdAt>120_000 ? `${job.status}:delayed` : job.status;
}
export function progressFiles():AttachmentBuilder[] {
  return [new AttachmentBuilder(loadingGif).setName('faucet-loading.gif')];
}
export function queuedCard(job: Payout, symbol: string, now=Date.now()): EmbedBuilder {
  if (job.status==='confirmed') return card('Already paid','This request was already processed. Check the transaction posted in this channel.',colors.success);
  if (['failed','cancelled'].includes(job.status)) return card('Request already processed',`This request is ${job.status}. Use a fresh claim to try again if the faucet is available.`,colors.warning);
  const stages:Record<string,string>={queued:'Waiting for its turn',signed:'Submitting your transfer',broadcast:'Waiting for network confirmations',review:'Waiting for a chain check'};
  const delayed=now-job.createdAt>120_000;
  return card(job.status==='review'?'Payout awaiting verification':delayed?'In progress · Taking a little longer':'In progress · Your drip is on its way',
    `**${tokens(job.amountWei)} ${symbol}** for <@${job.userId}>\n\n${stages[job.status]??'Processing your request'}${delayed?' — the network is taking longer than usual.':''}\nWe’ll tag you here when the payment is confirmed.`,job.status==='review'?colors.warning:colors.brand)
    .setThumbnail('attachment://faucet-loading.gif')
    .addFields({name:'Wallet',value:`\`${getAddress(job.address)}\``})
    .setFooter({text:`ITL Testnet · Payout ${job.id}`});
}
export function successCard(job: Payout, symbol: string, explorer: string): EmbedBuilder {
  return card('Payment successful! 💧',`> ${quotes.success.next()}`,colors.success)
    .setURL(txUrl(explorer,job.txHash!))
    .addFields({name:'Sent',value:`**${tokens(job.amountWei)} ${symbol}**`,inline:true},{name:'Recipient',value:job.kind==='claim'?`<@${job.userId}>`:'CSV recipient',inline:true},{name:'Wallet',value:`\`${getAddress(job.address)}\``},{name:'Transaction',value:`[View on Interlink Explorer ↗](${txUrl(explorer,job.txHash!)})`},{name:'Next claim',value:`<t:${Math.ceil((job.confirmedAt!+job.cooldownMs)/1000)}:R>`,inline:true})
    .setFooter({text:`ITL Testnet · Payout ${job.id}`});
}
export function explorerButton(explorer:string,hash:string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View transaction').setURL(txUrl(explorer,hash)));
}
export function draftCard(draft:Draft,symbol:string,duplicateCount:number):EmbedBuilder {
  return card('Review this CSV payout',`Send the same amount to **${draft.addresses.length} unique wallets**.\nTransfers settle individually. Blacklists and cooldowns apply to every recipient.`)
    .addFields({name:'Each wallet',value:`${tokens(draft.amountWei)} ${symbol}`,inline:true},{name:'Total payout',value:`**${tokens(BigInt(draft.amountWei)*BigInt(draft.addresses.length))} ${symbol}** + gas`,inline:true},{name:'Recipient cooldown',value:`${draft.cooldownMs/HOURS} hours`,inline:true},{name:'Preview',value:draft.addresses.slice(0,5).map(a=>`\`${getAddress(a)}\``).join('\n')+(draft.addresses.length>5?`\n… and ${draft.addresses.length-5} more`:'' )},{name:'Duplicate rows removed',value:String(duplicateCount),inline:true},{name:'Confirm before',value:`<t:${Math.floor(draft.expiresAt/1000)}:R>`,inline:true},{name:'Batch ID',value:`\`${draft.id}\``});
}
export function draftButtons(id:string):ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`bulk:confirm:${id}`).setLabel('Confirm payouts').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`bulk:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
}
