import { createHash } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, type ChatInputCommandInteraction, type Client, type NewsChannel, type TextChannel } from 'discord.js';
import type { BalanceAlerts, BalanceAlertTransport } from '../balance-alerts.js';
import { amountWei, FaucetError, HOURS, tokens, type Actor, type BalanceAlertConfig, type BalanceAlertEvent } from '../domain.js';
import type { Config } from '../config.js';
import { card, colors } from './embeds.js';

const noMentions={parse:[] as [],repliedUser:false};
export async function alertChannel(client:Client,guildId:string,channelId:string):Promise<TextChannel|NewsChannel> {
  const fetched=await client.channels.fetch(channelId);
  if (!fetched || !('guildId' in fetched) || fetched.guildId!==guildId || ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(fetched.type)) throw new FaucetError('ALERT_CHANNEL','Choose a text or announcement channel in this server.');
  const channel=fetched as TextChannel|NewsChannel;
  const me=channel.guild.members.me??await channel.guild.members.fetchMe();
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ReadMessageHistory])) throw new FaucetError('BOT_PERMISSIONS','The alert channel needs View Channel, Send Messages, Embed Links and Read Message History permissions for the bot.');
  return channel;
}
async function validateRole(channel:TextChannel|NewsChannel,roleId:string):Promise<void> {
  const role=await channel.guild.roles.fetch(roleId);
  if (!role || role.id===channel.guildId || role.managed) throw new FaucetError('ALERT_ROLE','Choose a regular server role, not @everyone or an integration role.');
  const me=channel.guild.members.me??await channel.guild.members.fetchMe();
  if (!role.mentionable && !channel.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone)) throw new FaucetError('ALERT_ROLE_PERMISSIONS','Make that role mentionable, or grant the bot Mention @everyone, @here, and All Roles in the alert channel. The bot will ping only explicitly configured targets.');
}
export function balanceAlertPayload(settings:BalanceAlertConfig,event:BalanceAlertEvent,config:Pick<Config,'symbol'|'wallet'>,test=false) {
  const mentions=[...settings.userIds.map(id=>`<@${id}>`),...settings.roleIds.map(id=>`<@&${id}>`)];
  return {
    content:`${mentions.join(' ')} ${test?'🧪 Test alert':'⚠️ Faucet is low — please refill the funding wallet.'}`,
    embeds:[card(test?'Test · Faucet balance alert':'Faucet balance is low ⚠️',test?'This verifies the configured channel and recipient pings.':`The funding wallet is below your configured threshold. Add **${config.symbol}** to keep claims flowing.`,colors.warning)
      .addFields({name:'Wallet balance',value:`**${tokens(event.balanceWei)} ${config.symbol}**`,inline:true},{name:'Alert below',value:`${tokens(settings.thresholdWei)} ${config.symbol}`,inline:true},
        {name:'Funding wallet',value:`\`${config.wallet.address}\``},{name:'Reminders',value:settings.repeatMs?`Every ${settings.repeatMs/HOURS} hours while low`:'Once until the balance recovers'})
      .setTimestamp(event.createdAt).setFooter({text:`Balance alert · ${event.id}`})],
    allowedMentions:{...noMentions,users:settings.userIds,roles:settings.roleIds},
  };
}
export function createBalanceAlertTransport(client:Client,config:Config):BalanceAlertTransport {
  return {
    find:async(guildId,settings,event)=>{
      const channel=await alertChannel(client,guildId,settings.channelId!);
      const recent=await channel.messages.fetch({limit:100});
      const found=recent.find(message=>message.author.id===client.user?.id && message.embeds.some(embed=>embed.footer?.text===`Balance alert · ${event.id}`));
      return found?{channelId:found.channelId,messageId:found.id}:null;
    },
    send:async(guildId,settings,event,test)=>{
      const channel=await alertChannel(client,guildId,settings.channelId!);
      for (const roleId of settings.roleIds) await validateRole(channel,roleId);
      const nonce=createHash('sha256').update(`${guildId}:${event.id}`).digest('hex').slice(0,24);
      const message=await channel.send({...balanceAlertPayload(settings,event,config,test),nonce,enforceNonce:true});
      return {channelId:message.channelId,messageId:message.id};
    },
  };
}
export async function handleBalanceAlertCommand(i:ChatInputCommandInteraction,actor:Actor,alerts:BalanceAlerts,client:Client,symbol:string):Promise<void> {
  const action=i.options.getSubcommand();
  let settings=await alerts.config(actor.guildId);
  let notice='';
  if (action==='setup') {
    const selected=i.options.getChannel('channel',true);
    const channel=await alertChannel(client,actor.guildId,selected.id);
    for (const roleId of settings.roleIds) await validateRole(channel,roleId);
    const thresholdWei=amountWei(i.options.getString('below',true));
    const hours=i.options.getNumber('repeat-hours');
    settings=await alerts.configure(actor,current=>({...current,enabled:true,channelId:channel.id,thresholdWei,repeatMs:hours===null?current.repeatMs:Math.round(hours*HOURS)}));
    notice='Alert settings saved. Balance is checked once per minute, including while payouts are paused.';
  } else if (action==='target-add' || action==='target-remove') {
    const user=i.options.getUser('user');const role=i.options.getRole('role');
    if (!!user===!!role) throw new FaucetError('ALERT_TARGET','Choose exactly one user OR one role. Repeat this command to configure multiple recipients.');
    if (action==='target-add') {
      if (user) {
        const guild=await client.guilds.fetch(actor.guildId);const member=await guild.members.fetch(user.id);
        if (member.user.bot) throw new FaucetError('ALERT_TARGET','Choose a person in this server to receive the alert.');
      }
      if (role) {
        if (role.id===actor.guildId || role.managed) throw new FaucetError('ALERT_ROLE','Choose a regular server role, not @everyone or an integration role.');
        if (settings.channelId) await validateRole(await alertChannel(client,actor.guildId,settings.channelId),role.id);
      }
    }
    settings=await alerts.configure(actor,current=>{
      const key=user?'userIds':'roleIds';const id=user?.id??role!.id;
      return {...current,[key]:action==='target-add'?[...new Set([...current[key],id])]:current[key].filter(value=>value!==id)};
    });
    notice=action==='target-add'?'Alert recipient added.':'Alert recipient removed.';
  } else if (action==='targets-clear') {
    settings=await alerts.configure(actor,current=>({...current,userIds:[],roleIds:[]}));notice='All alert recipients cleared.';
  } else if (action==='disable') {
    settings=await alerts.configure(actor,current=>({...current,enabled:false}));notice='Automatic alerts disabled. Setup enables them again.';
  } else if (action==='test') {
    await alerts.test(actor,i.id);notice='Test alert sent to the configured channel with the selected pings.';
  }
  const ready=settings.enabled && settings.channelId && settings.userIds.length+settings.roleIds.length;
  const targets=[...settings.userIds.map(id=>`<@${id}>`),...settings.roleIds.map(id=>`<@&${id}>`)];
  await i.editReply({embeds:[card('Low-balance alerts',`${notice}${notice?'\n\n':''}**Status:** ${ready?'Enabled':settings.enabled?'Waiting for a channel and recipients':'Disabled'}\n**Channel:** ${settings.channelId?`<#${settings.channelId}>`:'Not set'}\n**Alert below:** ${tokens(settings.thresholdWei)} ${symbol}\n**Reminders:** ${settings.repeatMs?`${settings.repeatMs/HOURS} hours`:'Off — once per low-balance period'}\n**Notify:** ${targets.join(', ')||'No recipients yet — use alerts target-add.'}\n\nTargets receive notifications only; this does not grant faucet permissions.`)],allowedMentions:noMentions});
}
