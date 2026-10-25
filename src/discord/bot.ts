import { AttachmentBuilder, ChannelType, Client, Events, MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type Interaction, type Message, type TextChannel, type NewsChannel } from 'discord.js';
import { getAddress } from 'ethers';
import { type Config } from '../config.js';
import { batchReport, downloadCsv, parseAddressCsv } from '../csv.js';
import { amountWei, extractAddresses, FaucetError, hoursMs, HOURS, safeError, shortAddress, tokens, txUrl, type Actor, type Capability, type Payout, type Settings } from '../domain.js';
import { PayoutEngine } from '../engine.js';
import { FaucetService } from '../service.js';
import { card, claimReplyOptions, colors, draftButtons, draftCard, errorCard, statusCard } from './embeds.js';
import type { PayoutMessages } from './payout-messages.js';
import { WorkQueue } from '../work-queue.js';
import type { BalanceAlerts } from '../balance-alerts.js';
import { handleBalanceAlertCommand } from './balance-alerts.js';

const noMentions={parse:[] as [],repliedUser:false};
export async function payoutChannel(client:Client,channelId:string,guildId:string):Promise<TextChannel|NewsChannel> {
  let channel;
  try {channel=await client.channels.fetch(channelId);} catch (error) {
    if (typeof error==='object' && error && 'code' in error && [10003,50001,50013].includes(Number(error.code))) throw new FaucetError('CHANNEL_UNAVAILABLE','The payout channel is unavailable or the bot lost access.');
    throw new FaucetError('DISCORD_TEMPORARY','Discord could not check the payout channel. Try again shortly.');
  }
  if (!channel || !('guildId' in channel) || channel.guildId!==guildId || ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type)) throw new FaucetError('CHANNEL_UNAVAILABLE','Only regular text and announcement channels in the configured server are supported.');
  const text=channel as TextChannel|NewsChannel;
  const me=text.guild.members.me??await text.guild.members.fetchMe();
  if (!text.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.AttachFiles])) throw new FaucetError('BOT_PERMISSIONS','The bot needs View Channel, Send Messages, Embed Links and Attach Files in this channel.');
  return text;
}
export async function resolveActor(client:Client,guildId:string,userId:string,channelId:string):Promise<Actor> {
  const guild=await client.guilds.fetch(guildId);
  let member;
  try {member=await guild.members.fetch({user:userId,force:true});}
  catch (error) {
    if (typeof error==='object' && error && 'code' in error && error.code===10007) throw new FaucetError('MEMBER_LEFT','The requester is no longer a member of this server.');
    throw new FaucetError('DISCORD_TEMPORARY','Discord could not verify current member permissions. Try again shortly.');
  }
  return {guildId,channelId,userId,isAdmin:member.permissions.has(PermissionFlagsBits.Administrator),roleIds:[...member.roles.cache.keys()]};
}

export function attachBot(client:Client,services:ReadonlyMap<string,FaucetService>,engine:PayoutEngine,config:Config,messages:PayoutMessages,alerts?:BalanceAlerts):void {
  const requests=new WorkQueue(config.requests.concurrency,config.requests.queueLimit,config.requests.waitMs);
  const controls=new WorkQueue(2,20,30000);
  const automaticChannels=new Map<string,{expires:number;value:Promise<string[]>;allowed?:string[]}>();
  const autoChannels=(service:FaucetService):Promise<string[]>=>{
    const cached=automaticChannels.get(service.guildId);
    if (cached && cached.expires>Date.now()) return cached.value;
    const entry:{expires:number;value:Promise<string[]>;allowed?:string[]}={expires:Infinity,value:Promise.resolve([]),allowed:cached?.allowed};
    // Share these filter reads during a burst. SQL still checks current settings on admission.
    entry.value=Promise.all([service.store.channels(),service.store.settings()]).then(([channels,settings])=>{
      entry.expires=Date.now()+2000;entry.allowed=settings.autoClaim?channels:[];return entry.allowed;
    }).catch(error=>{automaticChannels.delete(service.guildId);throw error;});
    automaticChannels.set(service.guildId,entry);return entry.value;
  };
  const failureReplies=new Map<string,number>();
  const canReply=(key:string):boolean=>{
    const now=Date.now();
    if ((failureReplies.get(key)??0)>now) return false;
    if (failureReplies.size>=10000) failureReplies.delete(failureReplies.keys().next().value!);
    failureReplies.set(key,now+15000);return true;
  };
  client.on(Events.InteractionCreate,(interaction)=>{void handleInteraction(interaction).catch(error=>console.error(safeError(error)));});
  client.on(Events.MessageCreate,(message)=>{void handleMessage(message).catch(error=>console.error(safeError(error)));});

  async function handleMessage(message:Message):Promise<void> {
    if (message.author.bot || message.webhookId || message.system || !message.guildId) return;
    const service=services.get(message.guildId);
    if (!service) return;
    const addresses=extractAddresses(message.content);
    if (!addresses.length) return;
    let replyAllowed=automaticChannels.get(service.guildId)?.allowed?.includes(message.channelId)??false;
    try {
      await requests.run(message.author.id,async()=>{
        // Admission to the memory queue precedes even the shared database filter read.
        if (!(await autoChannels(service)).includes(message.channelId)) {replyAllowed=false;return;}
        replyAllowed=true;
        if (addresses.length!==1) throw new FaucetError('ONE_ADDRESS','Post one wallet address per message, or use /faucet claim.');
        await payoutChannel(client,message.channelId,message.guildId!);
        const actor=await resolveActor(client,message.guildId!,message.author.id,message.channelId);
        const job=await service.claim(actor,addresses[0]!,`message:${message.id}`,true);
        await messages.acknowledge(job,async body=>{
          const reply=await message.reply({...body,nonce:message.id,enforceNonce:true});
          return {channelId:reply.channelId,messageId:reply.id};
        });
      });
    } catch (error) {
      if (!replyAllowed) return; // Do not post in channels whose approval is unknown.
      const key=error instanceof FaucetError && error.code==='BUSY'?`${message.channelId}:busy`:`${message.channelId}:${message.author.id}`;
      if (canReply(key)) await message.reply({embeds:[errorCard(error)],allowedMentions:noMentions}).catch(()=>undefined);
    }
  }

  async function handleInteraction(interaction:Interaction):Promise<void> {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    if (interaction.isButton() && !interaction.customId.startsWith('bulk:')) return;
    if (interaction.isChatInputCommand() && !['faucet','faucet-admin','faucet-mod'].includes(interaction.commandName)) return;
    const service=interaction.guildId ? services.get(interaction.guildId) : undefined;
    if (!service || !interaction.guildId || !interaction.channelId) {
      await interaction.reply({embeds:[errorCard(new FaucetError('WRONG_SERVER','Use this faucet inside its configured Discord server.'))],flags:MessageFlags.Ephemeral});return;
    }
    try {
      if (interaction.isButton()) await interaction.deferUpdate();
      else await interaction.deferReply(claimReplyOptions(interaction.commandName,interaction.options.getSubcommand()));
      const isClaim=interaction.isChatInputCommand() && interaction.commandName==='faucet' && interaction.options.getSubcommand()==='claim';
      await (isClaim?requests:controls).run(interaction.user.id,async()=>{
      const actor=await resolveActor(client,interaction.guildId!,interaction.user.id,interaction.channelId!);
      if (interaction.isButton()) {
        const [,action,id]=interaction.customId.split(':');
        if (!id) throw new FaucetError('DRAFT_EXPIRED','This CSV preview is invalid. Upload the file again.');
        if (action==='cancel') {await service.cancelBatch(actor,id);await interaction.editReply({embeds:[card('CSV cancelled','No payouts were queued from this preview.')],components:[]});return;}
        if (action!=='confirm') return;
        await payoutChannel(client,actor.channelId,actor.guildId);
        const jobs=await service.confirmBatch(actor,id);
        await interaction.editReply({embeds:[card('CSV payouts queued',`${jobs.length} wallets are queued. Confirmed transfers and explorer links will appear in this channel.\n\nUse \`/faucet-mod batch-status batch-id:${id}\` for the report.\nIf the wallet runs low, remaining payouts pause until it is funded and an admin resumes them.`,colors.success)],components:[]});
        return;
      }
      if (interaction.commandName==='faucet') await userCommand(interaction,actor,service);
      else if (interaction.commandName==='faucet-admin') {service.assertAdmin(actor);await adminCommand(interaction,actor,service);}
      else await modCommand(interaction,actor,service);
      });
    } catch (error) {
      if (!(error instanceof FaucetError)) console.error(safeError(error));
      const response={embeds:[errorCard(error)],allowedMentions:noMentions,...(interaction.isButton()?{components:[]}: {})};
      if (interaction.deferred || interaction.replied) await interaction.editReply(response).catch(()=>undefined);
      else await interaction.reply({...response,flags:MessageFlags.Ephemeral}).catch(()=>undefined);
    }
  }

  async function userCommand(i:ChatInputCommandInteraction,actor:Actor,service:FaucetService):Promise<void> {
    const sub=i.options.getSubcommand();
    if (sub==='claim') {
      await payoutChannel(client,actor.channelId,actor.guildId);
      const job=await service.claim(actor,i.options.getString('address',true),`interaction:${i.id}`);
      await messages.acknowledge(job,async body=>{
        const reply=await i.editReply(body);
        return {channelId:reply.channelId,messageId:reply.id};
      });
    } else if (sub==='status') {
      const [settings,pending]=await Promise.all([service.store.settings(),service.store.countPending()]);
      await i.editReply({embeds:[statusCard(settings,config.symbol,pending)]});
    } else {
      const [settings,channels]=await Promise.all([service.store.settings(),service.store.channels()]);
      await i.editReply({embeds:[card('A little gas. A lot of ambition.',`Post **one EVM wallet address** in an approved channel, or use \`/faucet claim address:0x…\`.\n\nEach claim: **${tokens(settings.amountWei)} ${config.symbol}**\nCooldown: **${settings.cooldownMs/HOURS} hours** per wallet AND Discord account across all faucet servers.\n${settings.autoClaim?'Automatic address detection is on.':'Automatic address detection is off; use the slash command.'}\n\nApproved channels: ${channels.length?channels.slice(0,20).map(c=>`<#${c}>`).join(', '):'An admin must approve a channel first.'}\n\nSuccessful payouts include an Interlink Explorer link. These are testnet tokens. Mods use \`/faucet-mod\`; admins use \`/faucet-admin\`.`)]});
    }
  }

  async function adminCommand(i:ChatInputCommandInteraction,actor:Actor,service:FaucetService):Promise<void> {
    if (i.options.getSubcommandGroup(false)==='alerts') {
      if (!alerts) throw new FaucetError('ALERT_SETUP','The balance alert monitor is unavailable.');
      await handleBalanceAlertCommand(i,actor,alerts,client,config.symbol);return;
    }
    const sub=i.options.getSubcommand();
    let text='';
    if (sub==='channel-add' || sub==='channel-remove') {
      const channel=i.options.getChannel('channel',true);
      if (sub==='channel-add') await payoutChannel(client,channel.id,actor.guildId);
      await service.channel(actor,channel.id,sub==='channel-add');
      text=`<#${channel.id}> ${sub==='channel-add'?'is approved for payouts.':'was removed from the payout allowlist.'} Threads do not inherit approval.`;
    } else if (sub==='channels') text=(await service.store.channels()).map(c=>`<#${c}>`).join('\n')||'No channels approved yet.';
    else if (sub==='amount') {
      const amount=amountWei(i.options.getString('amount',true));await service.changeSettings(actor,{amountWei:amount});text=`Future public claims receive **${tokens(amount)} ${config.symbol}**.`;
    } else if (sub==='cooldown') {
      const duration=hoursMs(i.options.getNumber('hours',true));await service.changeSettings(actor,{cooldownMs:duration});text=`Future claims use a **${duration/HOURS}-hour** cooldown. Existing cooldowns keep their original expiry.`;
    } else if (sub==='start') {await engine.start(actor);text='Faucet started. Queued payouts resume, and new claims are accepted in approved channels.';}
    else if (sub==='stop') {await engine.stop(actor);text='Faucet paused. New claims are disabled and unsigned payouts wait. Already signed transactions continue to settle.';}
    else if (sub==='auto-claim') {const enabled=i.options.getBoolean('enabled',true);await service.changeSettings(actor,{autoClaim:enabled});text=`Automatic wallet detection is **${enabled?'on':'off'}**. The slash claim command remains available in approved channels.`;}
    else if (sub==='role-grant' || sub==='role-revoke') {
      const role=i.options.getRole('role',true);
      if (role.managed) throw new FaucetError('MANAGED_ROLE','Choose a regular moderator role rather than an integration-managed role.');
      const capability=i.options.getString('permission',true) as Capability;
      await service.role(actor,role.id,capability,sub==='role-grant');
      text=`${sub==='role-grant'?'Granted':'Revoked'} **${capability}** ${sub==='role-grant'?'for':'from'} <@&${role.id}>.`;
    } else if (sub==='roles') text=(await service.store.rolePermissions()).map(p=>`<@&${p.roleId}> → **${p.capability}**`).join('\n')||'No moderator permissions delegated. Administrators can use all functions.';
    else if (sub==='limits') {
      const patch:Partial<Settings>={};
      const perWallet=i.options.getString('per-wallet');const perBatch=i.options.getString('per-batch');const perDay=i.options.getString('per-day');const rows=i.options.getInteger('batch-rows');
      if (perWallet) patch.maxPayoutWei=amountWei(perWallet);
      if (perBatch) patch.maxBatchTotalWei=amountWei(perBatch);
      if (perDay) patch.maxDailyTotalWei=amountWei(perDay);
      if (rows) patch.maxBatchRows=rows;
      const settings=await (Object.keys(patch).length?service.changeSettings(actor,patch):service.store.settings());
      text=`Per wallet: **${tokens(settings.maxPayoutWei)} ${config.symbol}**\nPer CSV: **${tokens(settings.maxBatchTotalWei)} ${config.symbol}**\nRolling 24 hours: **${tokens(settings.maxDailyTotalWei)} ${config.symbol}**\nMaximum CSV rows: **${settings.maxBatchRows}**\nCurrently spent or reserved: **${tokens(await service.store.spentAndReserved())} ${config.symbol}**`;
    } else if (sub==='wallet') {
      const balance=await engine.chain.balance();
      text=`Fund this wallet with native **${config.symbol}**:\n\`${config.wallet.address}\`\n\nBalance: **${tokens(balance)} ${config.symbol}**\nNetwork: **ITL Testnet (${config.chainId})**\nKeep some balance for gas. The bot never shows its private key.`;
    } else if (sub==='pending') {
      const [jobs,settings]=await Promise.all([service.store.pending(),service.store.settings()]);
      text=`Faucet: **${settings.enabled?'running':'paused'}**\n${settings.pauseReason??''}\n\n`+(jobs.length?jobs.slice(0,15).map(p=>`**${p.status}** · ${tokens(p.amountWei)} ${config.symbol} → \`${shortAddress(p.address)}\`\nID: \`${p.id}\`${p.txHash?` · [Explorer](${txUrl(config.explorerUrl,p.txHash)})`:''}${p.errorCode?` · ${p.errorCode}`:''}`).join('\n\n'):'No pending payouts.');
    } else if (sub==='recheck') {await engine.recheck(actor);text='Gateway reconnected and the original pending transaction was checked. Use /faucet-admin pending for its status; start the faucet when ready.';}
    else if (sub==='cancel-queued') {
      const id=i.options.getString('payout-id',true);
      await service.store.cancelQueued(actor,id);
      text=`Payout \`${id}\` was cancelled before signing.`;
    }
    await i.editReply({embeds:[card('Faucet controls',text.slice(0,4000)||'Done.')],allowedMentions:noMentions});
  }

  async function modCommand(i:ChatInputCommandInteraction,actor:Actor,service:FaucetService):Promise<void> {
    const sub=i.options.getSubcommand();
    if (sub==='blacklist-add') {
      const address=i.options.getString('address',true);
      const until=await service.setBlacklist(actor,address,i.options.getNumber('hours',true),i.options.getString('reason')??'');
      await i.editReply({embeds:[card('Wallet blacklisted',`\`${getAddress(address)}\` is blocked until <t:${Math.ceil(until/1000)}:f> (<t:${Math.ceil(until/1000)}:R>). Already signed transactions cannot be recalled.`,colors.warning)]});
    } else if (sub==='blacklist-remove') {
      const address=i.options.getString('address',true);await service.removeBlacklist(actor,address);
      await i.editReply({embeds:[card('Wallet unblocked',`The blacklist entry for \`${getAddress(address)}\` was removed. Any claim cooldown still applies.`)]});
    } else if (sub==='blacklist-list') {
      await service.assertCapability(actor,'blacklist');
      const entries=await service.store.blacklistEntries();
      const body=entries.slice(0,35).map(b=>`\`${shortAddress(b.address)}\` · expires <t:${Math.ceil(b.until/1000)}:R>`).join('\n');
      const report=entries.map(b=>`${b.address},${new Date(b.until).toISOString()}`).join('\n');
      await i.editReply({embeds:[card('Active blacklist',body||'No addresses are currently blacklisted.')],files:entries.length?[new AttachmentBuilder(Buffer.from(`address,expires_at\n${report}`)).setName('blacklist.csv')]:[]});
    } else if (sub==='cooldown') {
      const duration=hoursMs(i.options.getNumber('hours',true));await service.changeSettings(actor,{cooldownMs:duration},'cooldown');
      await i.editReply({embeds:[card('Cooldown updated',`Future claims use a **${duration/HOURS}-hour** cooldown. Existing cooldowns keep their original expiry.`)]});
    } else if (sub==='bulk') {
      await service.assertCapability(actor,'bulk');await service.assertChannel(actor);await service.assertEnabled();
      await payoutChannel(client,actor.channelId,actor.guildId);
      const attachment=i.options.getAttachment('csv',true);
      const parsed=parseAddressCsv(await downloadCsv(attachment),(await service.store.settings()).maxBatchRows);
      const draft=await service.createBatch(actor,parsed.addresses,i.options.getString('amount',true),i.options.getNumber('cooldown-hours')??undefined);
      await i.editReply({embeds:[draftCard(draft,config.symbol,parsed.duplicateCount)],components:[draftButtons(draft.id)]});
    } else if (sub==='batch-status') {
      await service.assertCapability(actor,'bulk');
      const id=i.options.getString('batch-id',true);
      const jobs=await service.store.batch(id);
      if (!jobs.length) throw new FaucetError('BATCH_NOT_FOUND','No confirmed CSV submission exists with that batch ID.');
      const counts=new Map<string,number>();for (const job of jobs) counts.set(job.status,(counts.get(job.status)??0)+1);
      await i.editReply({embeds:[card('CSV distribution report',`Batch: \`${id}\`\n\n${[...counts].map(([status,count])=>`**${status}:** ${count}`).join('\n')}\n\nThe attached CSV contains every wallet, amount, status and explorer link.`)],files:[new AttachmentBuilder(batchReport(jobs,config.explorerUrl)).setName(`faucet-batch-${id}.csv`)]});
    }
  }
}
