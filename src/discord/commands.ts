import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { CAPABILITIES } from '../domain.js';

const faucet=new SlashCommandBuilder().setName('faucet').setDescription('Claim tITL from Faucet Beacon')
  .addSubcommand(s=>s.setName('claim').setDescription('Request tITL for an EVM wallet in an approved channel').addStringOption(o=>o.setName('address').setDescription('Your 0x wallet address').setRequired(true).setMinLength(42).setMaxLength(42)))
  .addSubcommand(s=>s.setName('status').setDescription('View the faucet amount, cooldown and availability'))
  .addSubcommand(s=>s.setName('help').setDescription('Learn how to claim tITL'));

const admin=new SlashCommandBuilder().setName('faucet-admin').setDescription('Administrator controls for Faucet Beacon').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s=>s.setName('channel-add').setDescription('Approve an exact channel for automatic claims and payouts').addChannelOption(o=>o.setName('channel').setDescription('The channel to approve').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true)))
  .addSubcommand(s=>s.setName('channel-remove').setDescription('Remove a channel from the payout allowlist').addChannelOption(o=>o.setName('channel').setDescription('The channel to remove').setRequired(true)))
  .addSubcommand(s=>s.setName('channels').setDescription('List explicitly approved payout channels'))
  .addSubcommand(s=>s.setName('amount').setDescription('Change the tITL amount for future public claims').addStringOption(o=>o.setName('amount').setDescription('tITL per claim, e.g. 0.5 or 1').setRequired(true).setMaxLength(60)))
  .addSubcommand(s=>s.setName('cooldown').setDescription('Change the cooldown applied to future claims').addNumberOption(o=>o.setName('hours').setDescription('Hours, e.g. 6 or 0.5').setRequired(true).setMinValue(0.01).setMaxValue(8760)))
  .addSubcommand(s=>s.setName('start').setDescription('Verify the gateway and resume queued and new payouts'))
  .addSubcommand(s=>s.setName('stop').setDescription('Pause new payouts; already signed transactions continue to settle'))
  .addSubcommand(s=>s.setName('auto-claim').setDescription('Enable or disable automatic wallet-address detection').addBooleanOption(o=>o.setName('enabled').setDescription('Keep slash claims available in either mode').setRequired(true)))
  .addSubcommand(s=>s.setName('role-grant').setDescription('Give a moderator role one specific faucet permission').addRoleOption(o=>o.setName('role').setDescription('Moderator role').setRequired(true)).addStringOption(o=>o.setName('permission').setDescription('The function this role may use').setRequired(true).addChoices(...CAPABILITIES.map(c=>({name:c,value:c})))))
  .addSubcommand(s=>s.setName('role-revoke').setDescription('Revoke one faucet permission from a moderator role').addRoleOption(o=>o.setName('role').setDescription('Moderator role').setRequired(true)).addStringOption(o=>o.setName('permission').setDescription('The permission to remove').setRequired(true).addChoices(...CAPABILITIES.map(c=>({name:c,value:c})))))
  .addSubcommand(s=>s.setName('roles').setDescription('Show moderator roles and their delegated permissions'))
  .addSubcommand(s=>s.setName('limits').setDescription('View or update payout budgets').addStringOption(o=>o.setName('per-wallet').setDescription('Maximum tITL for one transfer').setMaxLength(60)).addStringOption(o=>o.setName('per-batch').setDescription('Maximum total tITL for one CSV').setMaxLength(60)).addStringOption(o=>o.setName('per-day').setDescription('Maximum total tITL in a rolling 24-hour period').setMaxLength(60)).addIntegerOption(o=>o.setName('batch-rows').setDescription('Maximum addresses per CSV').setMinValue(1).setMaxValue(1000)))
  .addSubcommand(s=>s.setName('wallet').setDescription('Show the funding wallet address and current tITL balance'))
  .addSubcommand(s=>s.setName('pending').setDescription('Inspect the queue, transaction hashes and transfers needing review'))
  .addSubcommand(s=>s.setName('recheck').setDescription('Reconnect to the gateway and check the original pending transaction'))
  .addSubcommand(s=>s.setName('cancel-queued').setDescription('Cancel one payout that has not been signed').addStringOption(o=>o.setName('payout-id').setDescription('Payout ID from the pending command').setRequired(true).setMaxLength(36)))
  .addSubcommandGroup(g=>g.setName('alerts').setDescription('Low-balance alerts for the shared funding wallet')
    .addSubcommand(s=>s.setName('setup').setDescription('Set the alert channel, tITL threshold and reminders')
      .addChannelOption(o=>o.setName('channel').setDescription('Where low-balance alerts should appear').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true))
      .addStringOption(o=>o.setName('below').setDescription('Alert when the balance is BELOW this tITL amount, e.g. 1').setRequired(true).setMaxLength(60))
      .addNumberOption(o=>o.setName('repeat-hours').setDescription('0 = one alert per low-balance period; otherwise 1–168 hours (default 6)').setMinValue(0).setMaxValue(168)))
    .addSubcommand(s=>s.setName('target-add').setDescription('Add one user OR role to low-balance pings; repeat to add more')
      .addUserOption(o=>o.setName('user').setDescription('Server member to notify'))
      .addRoleOption(o=>o.setName('role').setDescription('Server role to notify')))
    .addSubcommand(s=>s.setName('target-remove').setDescription('Remove one user OR role from low-balance pings')
      .addUserOption(o=>o.setName('user').setDescription('User to remove'))
      .addRoleOption(o=>o.setName('role').setDescription('Role to remove')))
    .addSubcommand(s=>s.setName('targets-clear').setDescription('Clear all alert recipients'))
    .addSubcommand(s=>s.setName('status').setDescription('Show alert channel, threshold and configured recipients'))
    .addSubcommand(s=>s.setName('disable').setDescription('Turn off automatic low-balance alerts'))
    .addSubcommand(s=>s.setName('test').setDescription('Post a test alert and ping the configured users/roles')));

const mod=new SlashCommandBuilder().setName('faucet-mod').setDescription('Delegated faucet moderation and CSV distribution')
  .addSubcommand(s=>s.setName('blacklist-add').setDescription('Temporarily block a wallet address').addStringOption(o=>o.setName('address').setDescription('Wallet address to blacklist').setRequired(true).setMinLength(42).setMaxLength(42)).addNumberOption(o=>o.setName('hours').setDescription('Blacklist duration in hours').setRequired(true).setMinValue(0.01).setMaxValue(8760)).addStringOption(o=>o.setName('reason').setDescription('Optional moderation reason').setMaxLength(300)))
  .addSubcommand(s=>s.setName('blacklist-remove').setDescription('Remove a wallet from the blacklist').addStringOption(o=>o.setName('address').setDescription('Wallet address to unblock').setRequired(true).setMinLength(42).setMaxLength(42)))
  .addSubcommand(s=>s.setName('blacklist-list').setDescription('Show up to 50 active timed blacklist entries'))
  .addSubcommand(s=>s.setName('cooldown').setDescription('Set the default cooldown for future claims; requires cooldown permission').addNumberOption(o=>o.setName('hours').setDescription('Cooldown hours').setRequired(true).setMinValue(0.01).setMaxValue(8760)))
  .addSubcommand(s=>s.setName('bulk').setDescription('Preview a CSV payout; confirm the exact total before sending').addAttachmentOption(o=>o.setName('csv').setDescription('UTF-8 CSV containing wallet addresses').setRequired(true)).addStringOption(o=>o.setName('amount').setDescription('tITL for EACH unique wallet').setRequired(true).setMaxLength(60)).addNumberOption(o=>o.setName('cooldown-hours').setDescription('Recipient cooldown for this batch; requires cooldown permission').setMinValue(0.01).setMaxValue(8760)))
  .addSubcommand(s=>s.setName('batch-status').setDescription('View a batch and download its payout report').addStringOption(o=>o.setName('batch-id').setDescription('Batch ID shown in the CSV confirmation').setRequired(true).setMaxLength(36)));

export const commands=[faucet,admin,mod];
export const commandData=commands.map(c=>c.toJSON());
