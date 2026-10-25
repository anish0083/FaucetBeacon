-- Schema version 3: multiple servers, one shared wallet and global cooldowns.
-- Run this complete script in the FaucetBot Supabase SQL Editor. Safe to re-run.
-- All endpoints are server-only SECURITY INVOKER functions. No public user access.

begin;
select pg_advisory_xact_lock(19042026, 70421);

create or replace function public.faucet_fail(code text, message text, retry_at bigint default null)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = code,
    detail = jsonb_build_object('message', message, 'retryAt', retry_at)::text;
end $$;

create or replace function public.faucet_valid_settings(s jsonb) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare k text;
begin
  if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(s->'enabled') is distinct from 'boolean'
    or jsonb_typeof(s->'autoClaim') is distinct from 'boolean' then return false; end if;
  foreach k in array array['amountWei','maxPayoutWei','maxBatchTotalWei','maxDailyTotalWei'] loop
    if coalesce(s->>k, '') !~ '^[1-9][0-9]{0,77}$' then return false; end if;
  end loop;
  if coalesce(s->>'cooldownMs','') !~ '^[0-9]+$' or coalesce(s->>'maxBatchRows','') !~ '^[0-9]+$' then return false; end if;
  return coalesce((s->>'amountWei')::numeric <= (s->>'maxPayoutWei')::numeric
    and (s->>'cooldownMs')::bigint between 36000 and 31536000000
    and (s->>'maxBatchRows')::integer between 1 and 1000, false);
exception when others then return false;
end $$;

create table if not exists public.faucet_settings (
  id smallint not null default 1 check (id = 1),
  guild_id text primary key,
  funding_address text not null check (funding_address ~ '^0x[0-9a-f]{40}$'),
  chain_id bigint not null check (chain_id > 0),
  value jsonb not null check (public.faucet_valid_settings(value)),
  control_version bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.faucet_channels (id text primary key);
create table if not exists public.faucet_role_permissions (
  role_id text not null,
  capability text not null check (capability in ('blacklist','bulk','cooldown')),
  primary key (role_id, capability)
);
create table if not exists public.faucet_blacklist (
  address text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  until_at timestamptz not null,
  reason text not null default '' check (length(reason) <= 300),
  actor_id text not null
);
create table if not exists public.faucet_cooldowns (
  kind text not null check (kind in ('address','user')),
  subject text not null,
  until_at timestamptz not null,
  primary key (kind, subject)
);
create table if not exists public.faucet_batches (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  channel_id text not null,
  addresses jsonb not null check (jsonb_typeof(addresses) = 'array' and jsonb_array_length(addresses) between 1 and 1000),
  amount_wei numeric(78,0) not null check (amount_wei > 0),
  cooldown_ms bigint not null check (cooldown_ms between 36000 and 31536000000),
  custom_cooldown boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  state text not null default 'open' check (state in ('open','queued','cancelled'))
);
create table if not exists public.faucet_payouts (
  id uuid primary key default gen_random_uuid(),
  queue_order bigint generated always as identity unique,
  request_key text not null unique,
  batch_id uuid references public.faucet_batches(id),
  kind text not null check (kind in ('claim','bulk')),
  user_id text not null,
  channel_id text not null,
  address text not null check (address ~ '^0x[0-9a-f]{40}$' and address <> '0x0000000000000000000000000000000000000000'),
  amount_wei numeric(78,0) not null check (amount_wei > 0),
  cooldown_ms bigint not null check (cooldown_ms between 36000 and 31536000000),
  status text not null default 'queued' check (status in ('queued','signed','broadcast','confirmed','failed','cancelled','review')),
  raw_tx text,
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  nonce bigint check (nonce is null or nonce between 0 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  error_code text,
  notice_status text,
  notice_attempts integer not null default 0,
  notice_after timestamptz not null default now(),
  check (status not in ('signed','broadcast','review','confirmed') or (raw_tx is not null and tx_hash is not null and nonce is not null)),
  check (status <> 'confirmed' or confirmed_at is not null)
);
create unique index if not exists faucet_one_active_address on public.faucet_payouts(address)
  where status in ('queued','signed','broadcast','review');
create unique index if not exists faucet_one_active_user on public.faucet_payouts(user_id)
  where kind = 'claim' and status in ('queued','signed','broadcast','review');
create unique index if not exists faucet_one_inflight on public.faucet_payouts((true))
  where status in ('signed','broadcast','review');
create index if not exists faucet_queue_idx on public.faucet_payouts(queue_order) where status = 'queued';
create index if not exists faucet_batch_idx on public.faucet_payouts(batch_id, queue_order);
create index if not exists faucet_recent_payments_idx on public.faucet_payouts(confirmed_at) include (amount_wei) where status = 'confirmed';
create index if not exists faucet_active_budget_idx on public.faucet_payouts(status) include (amount_wei) where status in ('queued','signed','broadcast','review');
create index if not exists faucet_notice_idx on public.faucet_payouts(notice_after, updated_at)
  where status in ('confirmed','failed','cancelled','review') and notice_status is distinct from status;
create table if not exists public.faucet_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id text not null,
  action text not null,
  target text not null,
  details jsonb not null default '{}'::jsonb
);
create index if not exists faucet_audit_time_idx on public.faucet_audit(at desc);
create table if not exists public.faucet_worker_lease (
  id smallint primary key check (id = 1),
  owner uuid not null,
  generation bigint not null default 1,
  expires_at timestamptz not null
);

-- Upgrade the original single-server schema without deleting payout history.
do $upgrade$
declare tab text; legacy_guild text;
begin
  if exists(select 1 from information_schema.key_column_usage where table_schema='public' and table_name='faucet_settings' and constraint_name='faucet_settings_pkey' and column_name='id') then
    alter table public.faucet_settings drop constraint faucet_settings_pkey;
    alter table public.faucet_settings add primary key(guild_id);
  end if;
  select guild_id into legacy_guild from public.faucet_settings order by guild_id limit 1;
  foreach tab in array array['faucet_channels','faucet_role_permissions','faucet_blacklist','faucet_batches','faucet_payouts','faucet_audit'] loop
    if not exists(select 1 from information_schema.columns where table_schema='public' and table_name=tab and column_name='guild_id') then
      execute format('alter table public.%I add column guild_id text',tab);
      execute format('update public.%I set guild_id=$1',tab) using legacy_guild;
      if tab<>'faucet_audit' then execute format('alter table public.%I alter column guild_id set not null',tab); end if;
      execute format('alter table public.%I add constraint %I foreign key(guild_id) references public.faucet_settings(guild_id)',tab,tab||'_guild_fk');
    end if;
  end loop;
  if not exists(select 1 from information_schema.key_column_usage where table_schema='public' and constraint_name='faucet_blacklist_pkey' and column_name='guild_id') then
    alter table public.faucet_blacklist drop constraint faucet_blacklist_pkey;
    alter table public.faucet_blacklist add primary key(guild_id,address);
  end if;
  if not exists(select 1 from information_schema.key_column_usage where table_schema='public' and constraint_name='faucet_role_permissions_pkey' and column_name='guild_id') then
    alter table public.faucet_role_permissions drop constraint faucet_role_permissions_pkey;
    alter table public.faucet_role_permissions add primary key(guild_id,role_id,capability);
  end if;
end $upgrade$;
create index if not exists faucet_channels_guild_idx on public.faucet_channels(guild_id);
create index if not exists faucet_payouts_guild_queue_idx on public.faucet_payouts(guild_id,queue_order);
create index if not exists faucet_payouts_guild_spent_idx on public.faucet_payouts(guild_id,confirmed_at) include(amount_wei,status);
create index if not exists faucet_batches_guild_idx on public.faucet_batches(guild_id);
create index if not exists faucet_audit_guild_time_idx on public.faucet_audit(guild_id,at desc);

-- Scope lasts only for the current database transaction. Nested RPC helpers retain it.
create or replace function public.faucet_guild() returns text
language sql stable security invoker set search_path = '' as $$
  select nullif(current_setting('faucet.guild_id',true),'')
$$;
create or replace function public.faucet_scope(payload jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare target text := coalesce(payload->>'guildId',payload->'actor'->>'guildId');
begin
  if payload->>'guildId' is not null and payload->'actor'->>'guildId' is not null
     and payload->>'guildId' <> payload->'actor'->>'guildId' then
    perform public.faucet_fail('WRONG_SERVER','The operation belongs to another Discord server.');
  end if;
  if target is not null then perform set_config('faucet.guild_id',target,true); end if;
end $$;

create or replace function public.faucet_ms(t timestamptz) returns bigint
language sql immutable security invoker set search_path = '' as $$
  select floor(extract(epoch from t) * 1000)::bigint
$$;
create or replace function public.faucet_payout_json(p public.faucet_payouts) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select case when p.id is null then null else jsonb_build_object(
    'id',p.id,'guildId',p.guild_id,'requestKey',p.request_key,'batchId',p.batch_id,'kind',p.kind,
    'userId',p.user_id,'channelId',p.channel_id,'address',p.address,'amountWei',p.amount_wei::text,
    'cooldownMs',p.cooldown_ms,'status',p.status,'rawTx',p.raw_tx,'txHash',p.tx_hash,'nonce',p.nonce,
    'createdAt',public.faucet_ms(p.created_at),'updatedAt',public.faucet_ms(p.updated_at),
    'confirmedAt',public.faucet_ms(p.confirmed_at),'errorCode',p.error_code,'noticeStatus',p.notice_status,
    'noticeAttempts',p.notice_attempts,'noticeAfter',public.faucet_ms(p.notice_after)) end
$$;
create or replace function public.faucet_batch_json(b public.faucet_batches) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select case when b.id is null then null else jsonb_build_object(
    'id',b.id,'guildId',b.guild_id,'userId',b.user_id,'channelId',b.channel_id,'addresses',b.addresses,'amountWei',b.amount_wei::text,
    'cooldownMs',b.cooldown_ms,'customCooldown',b.custom_cooldown,'createdAt',public.faucet_ms(b.created_at),
    'expiresAt',public.faucet_ms(b.expires_at),'state',b.state) end
$$;
create or replace function public.faucet_spent() returns numeric
language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(amount_wei),0) from public.faucet_payouts
  where guild_id=public.faucet_guild() and (status in ('queued','signed','broadcast','review')
     or (status='confirmed' and confirmed_at >= now()-interval '24 hours'))
$$;
create or replace function public.faucet_actor(a jsonb, capability text default null, admin_only boolean default false)
returns void language plpgsql stable security invoker set search_path = '' as $$
declare guild text;
begin
  select guild_id into guild from public.faucet_settings where guild_id=public.faucet_guild();
  if guild is null or coalesce(a->>'guildId','') <> guild then
    perform public.faucet_fail('WRONG_SERVER','This faucet belongs to another Discord server.');
  end if;
  if coalesce((a->>'isAdmin')::boolean,false) then return; end if;
  if admin_only then perform public.faucet_fail('ADMIN_REQUIRED','Administrator permission is required.'); end if;
  if capability is not null and not exists (
    select 1 from public.faucet_role_permissions r
    where r.guild_id=public.faucet_guild() and r.capability=faucet_actor.capability and r.role_id in (select jsonb_array_elements_text(coalesce(a->'roleIds','[]')))
  ) then perform public.faucet_fail('PERMISSION_REQUIRED','An admin must delegate this moderator permission first.'); end if;
end $$;
create or replace function public.faucet_channel(a jsonb) returns void
language plpgsql stable security invoker set search_path = '' as $$
begin
  perform public.faucet_actor(a);
  if not exists (select 1 from public.faucet_channels where guild_id=public.faucet_guild() and id=a->>'channelId') then
    perform public.faucet_fail('CHANNEL_NOT_APPROVED','Claims work only in an admin-approved channel.');
  end if;
end $$;
create or replace function public.faucet_recipient(addr text, user_id text default null, ignore_job uuid default null)
returns void language plpgsql stable security invoker set search_path = '' as $$
declare until_time timestamptz;
begin
  if addr is null or addr !~ '^0x[0-9a-f]{40}$' or addr='0x0000000000000000000000000000000000000000' then
    perform public.faucet_fail('INVALID_ADDRESS','A valid non-zero EVM address is required.');
  end if;
  if exists (select 1 from public.faucet_settings where funding_address=addr) then
    perform public.faucet_fail('SELF_TRANSFER','The funding wallet cannot claim from itself.');
  end if;
  select until_at into until_time from public.faucet_blacklist where guild_id=public.faucet_guild() and address=addr and until_at>now();
  if found then perform public.faucet_fail('BLACKLISTED','This wallet is temporarily blacklisted.',public.faucet_ms(until_time)); end if;
  select max(until_at) into until_time from public.faucet_cooldowns
  where (kind='address' and subject=addr) or (kind='user' and subject=user_id);
  if until_time>now() then perform public.faucet_fail('COOLDOWN','A previous claim is still on cooldown.',public.faucet_ms(until_time)); end if;
  if exists (select 1 from public.faucet_payouts p where p.id is distinct from ignore_job
      and p.status in ('queued','signed','broadcast','review')
      and (p.address=addr or (p.kind='claim' and p.user_id=faucet_recipient.user_id))) then
    perform public.faucet_fail('ALREADY_PENDING','A payout for this wallet or account is already in progress.');
  end if;
end $$;
create or replace function public.faucet_budget(amount numeric, recipients integer, bulk boolean, already_reserved boolean default false)
returns void language plpgsql stable security invoker set search_path = '' as $$
declare s jsonb;
begin
  select value into s from public.faucet_settings where guild_id=public.faucet_guild();
  if not coalesce((s->>'enabled')::boolean,false) then perform public.faucet_fail('PAUSED','The faucet is paused.'); end if;
  if amount is null or amount<=0 or amount>(s->>'maxPayoutWei')::numeric then
    perform public.faucet_fail('PAYOUT_LIMIT','The amount exceeds the per-wallet limit.'); end if;
  if recipients is null or recipients<1 or recipients>(s->>'maxBatchRows')::integer then
    perform public.faucet_fail('BATCH_SIZE','The CSV exceeds the current recipient limit.'); end if;
  if bulk and amount*recipients>(s->>'maxBatchTotalWei')::numeric then
    perform public.faucet_fail('BATCH_LIMIT','The CSV exceeds the batch total limit.'); end if;
  if public.faucet_spent() + (case when already_reserved then 0 else amount * recipients end) > (s->>'maxDailyTotalWei')::numeric then
    perform public.faucet_fail('DAILY_LIMIT','The rolling 24-hour budget, including reservations, is exhausted.'); end if;
end $$;
create or replace function public.faucet_eligible(job uuid, a jsonb) returns void
language plpgsql stable security invoker set search_path = '' as $$
declare p public.faucet_payouts; b public.faucet_batches;
begin
  select * into p from public.faucet_payouts where id=job;
  if not found or p.status<>'queued' then perform public.faucet_fail('QUEUE_CHANGED','This payout is no longer queued.'); end if;
  if p.guild_id is distinct from a->>'guildId' or p.user_id is distinct from a->>'userId' or p.channel_id is distinct from a->>'channelId' then
    perform public.faucet_fail('PERMISSION_REQUIRED','The queued requester could not be verified.'); end if;
  perform public.faucet_channel(a);
  if p.kind='bulk' then
    perform public.faucet_actor(a,'bulk');
    select * into b from public.faucet_batches where id=p.batch_id;
    if b.custom_cooldown then perform public.faucet_actor(a,'cooldown'); end if;
    perform public.faucet_budget(p.amount_wei,jsonb_array_length(b.addresses),true,true);
  else perform public.faucet_budget(p.amount_wei,1,false,true); end if;
  perform public.faucet_recipient(p.address,case when p.kind='claim' then p.user_id else null end,p.id);
end $$;
create or replace function public.faucet_check_lease(l jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.faucet_worker_lease where id=1
      and owner=(l->>'owner')::uuid and generation=(l->>'generation')::bigint and expires_at>clock_timestamp()) then
    perform public.faucet_fail('LEASE_LOST','Another worker owns the payout queue. This worker will not submit a transaction.');
  end if;
end $$;

create or replace function public.faucet_read(p_action text, p_payload jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb; p public.faucet_payouts; b public.faucet_batches;
begin
  perform public.faucet_scope(p_payload);
  case p_action
    when 'health' then return jsonb_build_object('schemaVersion',3,'initialized',exists(select 1 from public.faucet_settings where public.faucet_guild() is null or guild_id=public.faucet_guild()),'serverTime',public.faucet_ms(now()));
    when 'settings' then select value into result from public.faucet_settings where guild_id=public.faucet_guild();
    when 'control-version' then select to_jsonb(control_version) into result from public.faucet_settings where guild_id=public.faucet_guild();
    when 'channels' then select coalesce(jsonb_agg(id order by id),'[]') into result from public.faucet_channels where guild_id=public.faucet_guild();
    when 'channel-allowed' then return to_jsonb(exists(select 1 from public.faucet_channels where guild_id=public.faucet_guild() and id=p_payload->>'id'));
    when 'roles' then select coalesce(jsonb_agg(jsonb_build_object('roleId',role_id,'capability',capability) order by role_id,capability),'[]') into result from public.faucet_role_permissions where guild_id=public.faucet_guild();
    when 'has-permission' then return to_jsonb(exists(select 1 from public.faucet_role_permissions where guild_id=public.faucet_guild() and capability=p_payload->>'capability' and role_id in (select jsonb_array_elements_text(p_payload->'roleIds'))));
    when 'blacklist' then select jsonb_build_object('address',address,'until',public.faucet_ms(until_at),'reason',reason,'actorId',actor_id) into result from public.faucet_blacklist where guild_id=public.faucet_guild() and address=p_payload->>'address' and until_at>now();
    when 'blacklist-list' then select coalesce(jsonb_agg(jsonb_build_object('address',address,'until',public.faucet_ms(until_at),'reason',reason,'actorId',actor_id)),'[]') into result from (select * from public.faucet_blacklist where guild_id=public.faucet_guild() and until_at>now() order by until_at limit 50) q;
    when 'cooldown' then select to_jsonb(public.faucet_ms(until_at)) into result from public.faucet_cooldowns where kind=p_payload->>'kind' and subject=p_payload->>'subject'; return coalesce(result,'0');
    when 'payout' then select * into p from public.faucet_payouts where guild_id=public.faucet_guild() and id=(p_payload->>'id')::uuid; return public.faucet_payout_json(p);
    when 'request' then select * into p from public.faucet_payouts where guild_id=public.faucet_guild() and request_key=p_payload->>'key'; return public.faucet_payout_json(p);
    when 'next' then select item.* into p from public.faucet_payouts item join public.faucet_settings gs on gs.guild_id=item.guild_id where item.status='queued' and (gs.value->>'enabled')::boolean and item.guild_id in (select jsonb_array_elements_text(coalesce(p_payload->'guildIds',jsonb_build_array(public.faucet_guild())))) order by item.queue_order limit 1; return public.faucet_payout_json(p);
    when 'inflight' then select * into p from public.faucet_payouts where status in ('signed','broadcast','review') limit 1; return public.faucet_payout_json(p);
    when 'pending' then select coalesce(jsonb_agg(q.payload),'[]') into result from (select public.faucet_payout_json(item) payload from public.faucet_payouts item where item.guild_id=public.faucet_guild() and status in ('queued','signed','broadcast','review') order by queue_order limit 20) q;
    when 'pending-count' then select to_jsonb(count(*)) into result from public.faucet_payouts where guild_id=public.faucet_guild() and status in ('queued','signed','broadcast','review');
    when 'spent' then return to_jsonb(public.faucet_spent()::text);
    when 'draft' then select * into b from public.faucet_batches where guild_id=public.faucet_guild() and id=(p_payload->>'id')::uuid; return public.faucet_batch_json(b);
    when 'batch' then select coalesce(jsonb_agg(public.faucet_payout_json(item) order by item.queue_order),'[]') into result from public.faucet_payouts item where item.guild_id=public.faucet_guild() and batch_id=(p_payload->>'id')::uuid;
    when 'eligible' then perform public.faucet_eligible((p_payload->>'id')::uuid,p_payload->'actor'); return 'true';
    when 'lease-valid' then perform public.faucet_check_lease(p_payload->'lease'); return 'true';
    when 'notifications' then
      perform public.faucet_check_lease(p_payload->'lease');
      select coalesce(jsonb_agg(q.payload),'[]') into result from
        (select public.faucet_payout_json(item) payload from public.faucet_payouts item where status in ('confirmed','failed','cancelled','review')
          and notice_status is distinct from status and notice_after<=now() order by updated_at limit 5) q;
    else perform public.faucet_fail('DATABASE_ACTION','Unknown database read operation.');
  end case;
  return result;
end $$;

create or replace function public.faucet_write(p_action text, p_payload jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a jsonb := p_payload->'actor'; s jsonb; result jsonb; addr text;
  p public.faucet_payouts; b public.faucet_batches; cfg public.faucet_settings;
  lease public.faucet_worker_lease; amount numeric; duration bigint; addresses jsonb;
  t timestamptz := clock_timestamp(); new_state text; patch jsonb;
begin
  -- All admission, configuration and ledger changes serialize in Postgres.
  perform pg_advisory_xact_lock(19042026, 70421);
  t:=clock_timestamp();
  perform public.faucet_scope(p_payload);
  if p_action='initialize' then
    s:=p_payload->'settings';
    if coalesce(public.faucet_guild(),'') !~ '^[0-9]{17,20}$' then perform public.faucet_fail('CONFIG','A valid Discord server ID is required.'); end if;
    if exists(select 1 from public.faucet_settings where funding_address is distinct from p_payload->>'wallet' or chain_id is distinct from (p_payload->>'chainId')::bigint) then
      perform public.faucet_fail('DATABASE_IDENTITY','Every server must share the same funding wallet and chain.'); end if;
    if not public.faucet_valid_settings(s) then perform public.faucet_fail('CONFIG','Invalid initial faucet settings.'); end if;
    select * into cfg from public.faucet_settings where guild_id=public.faucet_guild();
    if found then
      if cfg.guild_id is distinct from p_payload->>'guildId' or cfg.funding_address is distinct from p_payload->>'wallet' or cfg.chain_id is distinct from (p_payload->>'chainId')::bigint then
        perform public.faucet_fail('DATABASE_IDENTITY','FaucetBot is bound to a different Discord server, chain or funding wallet.'); end if;
    else
      insert into public.faucet_settings(id,guild_id,funding_address,chain_id,value)
        values(1,p_payload->>'guildId',p_payload->>'wallet',(p_payload->>'chainId')::bigint,s||'{"enabled":false}');
    end if;
    return 'true';
  end if;
  -- Validate a Discord request's server before reporting worker setup errors.
  -- Background worker calls have no actor and retain DATABASE_NOT_INITIALIZED.
  if a is not null then perform public.faucet_actor(a); end if;
  select * into cfg from public.faucet_settings where guild_id=public.faucet_guild(); s:=cfg.value;
  if cfg.id is null then perform public.faucet_fail('DATABASE_NOT_INITIALIZED','Start the configured bot once to initialize FaucetBot.'); end if;
  case p_action
    when 'claim' then
      perform public.faucet_channel(a);
      select * into p from public.faucet_payouts where request_key=p_payload->>'requestKey';
      if p.id is not null and p.guild_id is distinct from public.faucet_guild() then
        perform public.faucet_fail('WRONG_SERVER','The request belongs to another Discord server.'); end if;
      if found then return public.faucet_payout_json(p); end if;
      if coalesce((p_payload->>'automatic')::boolean,false) and not (s->>'autoClaim')::boolean then
        perform public.faucet_fail('AUTO_CLAIM_DISABLED','Automatic claims are disabled. Use /faucet claim.'); end if;
      addr:=p_payload->>'address';
      perform public.faucet_recipient(addr,a->>'userId');
      perform public.faucet_budget((s->>'amountWei')::numeric,1,false);
      insert into public.faucet_payouts(guild_id,request_key,kind,user_id,channel_id,address,amount_wei,cooldown_ms)
        values(public.faucet_guild(),p_payload->>'requestKey','claim',a->>'userId',a->>'channelId',addr,(s->>'amountWei')::numeric,(s->>'cooldownMs')::bigint) returning * into p;
      insert into public.faucet_audit(guild_id,actor_id,action,target,details) values(public.faucet_guild(),a->>'userId','claim-queued',p.id::text,jsonb_build_object('address',addr));
      return public.faucet_payout_json(p);
    when 'draft-create' then
      perform public.faucet_actor(a,'bulk'); perform public.faucet_channel(a);
      duration:=coalesce((p_payload->>'cooldownMs')::bigint,(s->>'cooldownMs')::bigint);
      if p_payload->>'cooldownMs' is not null then perform public.faucet_actor(a,'cooldown'); end if;
      select jsonb_agg(x.addr order by x.first_row) into addresses from
        (select v.addr,min(v.ordinality) first_row from jsonb_array_elements_text(p_payload->'addresses') with ordinality v(addr,ordinality) group by v.addr) x;
      amount:=(p_payload->>'amountWei')::numeric;
      perform public.faucet_budget(amount,jsonb_array_length(addresses),true);
      for addr in select jsonb_array_elements_text(addresses) loop perform public.faucet_recipient(addr); end loop;
      insert into public.faucet_batches(guild_id,user_id,channel_id,addresses,amount_wei,cooldown_ms,custom_cooldown,expires_at)
        values(public.faucet_guild(),a->>'userId',a->>'channelId',addresses,amount,duration,p_payload->>'cooldownMs' is not null,t+interval '10 minutes') returning * into b;
      return public.faucet_batch_json(b);
    when 'draft-confirm' then
      perform public.faucet_actor(a,'bulk'); perform public.faucet_channel(a);
      select * into b from public.faucet_batches where guild_id=public.faucet_guild() and id=(p_payload->>'id')::uuid;
      if b.id is null or b.user_id is distinct from a->>'userId' or b.channel_id is distinct from a->>'channelId' then
        perform public.faucet_fail('DRAFT_OWNER','Only the uploading moderator can confirm this preview in its original channel.'); end if;
      if b.state='queued' then return public.faucet_read('batch',jsonb_build_object('id',b.id)); end if;
      if b.state<>'open' or b.expires_at<=t then perform public.faucet_fail('DRAFT_EXPIRED','This preview expired or was cancelled.'); end if;
      if b.custom_cooldown then perform public.faucet_actor(a,'cooldown'); end if;
      perform public.faucet_budget(b.amount_wei,jsonb_array_length(b.addresses),true);
      for addr in select jsonb_array_elements_text(b.addresses) loop perform public.faucet_recipient(addr); end loop;
      insert into public.faucet_payouts(guild_id,request_key,batch_id,kind,user_id,channel_id,address,amount_wei,cooldown_ms)
        select public.faucet_guild(),'batch:'||b.id||':'||(v.ordinality-1),b.id,'bulk',b.user_id,b.channel_id,v.addr,b.amount_wei,b.cooldown_ms
        from jsonb_array_elements_text(b.addresses) with ordinality v(addr,ordinality);
      update public.faucet_batches set state='queued' where faucet_batches.id=b.id;
      insert into public.faucet_audit(guild_id,actor_id,action,target,details) values(public.faucet_guild(),a->>'userId','batch-queued',b.id::text,jsonb_build_object('count',jsonb_array_length(b.addresses),'amountWei',b.amount_wei::text));
      return public.faucet_read('batch',jsonb_build_object('id',b.id));
    when 'draft-cancel' then
      perform public.faucet_actor(a);
      select * into b from public.faucet_batches where guild_id=public.faucet_guild() and faucet_batches.id=(p_payload->>'id')::uuid;
      if b.id is null or b.user_id is distinct from a->>'userId' then perform public.faucet_fail('DRAFT_OWNER','Only the uploader can cancel this preview.'); end if;
      if b.state<>'open' then perform public.faucet_fail('DRAFT_CLOSED','This preview is no longer open.'); end if;
      update public.faucet_batches set state='cancelled' where faucet_batches.id=b.id;
    when 'settings' then
      patch:=p_payload->'patch';
      if p_payload->>'capability'='cooldown' then
        perform public.faucet_actor(a,'cooldown');
        if patch-'cooldownMs'<>'{}'::jsonb then perform public.faucet_fail('PERMISSION_REQUIRED','Only the delegated cooldown setting can be changed.'); end if;
      else perform public.faucet_actor(a,null,true); end if;
      if p_payload->>'expectedVersion' is not null and cfg.control_version<>(p_payload->>'expectedVersion')::bigint then
        perform public.faucet_fail('CONTROL_CHANGED','A newer admin control superseded this start request.'); end if;
      if not public.faucet_valid_settings(s||patch) then perform public.faucet_fail('PAYOUT_LIMIT','Check the amount, cooldown and limits; the claim must fit within the per-wallet ceiling.'); end if;
      if patch->>'enabled'='true' then
        if not exists(select 1 from public.faucet_channels where guild_id=public.faucet_guild()) then perform public.faucet_fail('NO_CHANNELS','Approve at least one channel before starting the faucet.'); end if;
        if exists(select 1 from public.faucet_payouts where status='review') then perform public.faucet_fail('PENDING_REVIEW','Recheck the original pending transaction before starting the faucet.'); end if;
      end if;
      update public.faucet_settings set value=value||patch,updated_at=t,
        control_version=control_version+case when patch?'enabled' then 1 else 0 end where faucet_settings.guild_id=public.faucet_guild() returning value into result;
      insert into public.faucet_audit(guild_id,actor_id,action,target,details) values(public.faucet_guild(),a->>'userId','settings-updated','faucet',patch);
      return result;
    when 'channel' then
      perform public.faucet_actor(a,null,true);
      if (p_payload->>'allowed')::boolean then insert into public.faucet_channels(id,guild_id) values(p_payload->>'channelId',public.faucet_guild()) on conflict do nothing;
      else delete from public.faucet_channels where guild_id=public.faucet_guild() and faucet_channels.id=p_payload->>'channelId'; end if;
      insert into public.faucet_audit(guild_id,actor_id,action,target,details) values(public.faucet_guild(),a->>'userId','channel-updated',p_payload->>'channelId',jsonb_build_object('allowed',p_payload->'allowed'));
    when 'role' then
      perform public.faucet_actor(a,null,true);
      if p_payload->>'roleId'=cfg.guild_id then perform public.faucet_fail('EVERYONE_ROLE','Do not delegate faucet moderation to @everyone.'); end if;
      if (p_payload->>'grant')::boolean then insert into public.faucet_role_permissions(guild_id,role_id,capability) values(public.faucet_guild(),p_payload->>'roleId',p_payload->>'capability') on conflict do nothing;
      else delete from public.faucet_role_permissions where guild_id=public.faucet_guild() and role_id=p_payload->>'roleId' and capability=p_payload->>'capability'; end if;
      insert into public.faucet_audit(guild_id,actor_id,action,target,details) values(public.faucet_guild(),a->>'userId','role-updated',p_payload->>'roleId',p_payload-'actor');
    when 'blacklist-add' then
      perform public.faucet_actor(a,'blacklist'); duration:=(p_payload->>'durationMs')::bigint;
      if duration not between 36000 and 31536000000 then perform public.faucet_fail('INVALID_HOURS','Choose between 0.01 and 8760 hours.'); end if;
      insert into public.faucet_blacklist(guild_id,address,until_at,reason,actor_id)
        values(public.faucet_guild(),p_payload->>'address',t+duration*interval '1 millisecond',left(coalesce(p_payload->>'reason',''),300),a->>'userId')
        on conflict(guild_id,address) do update set until_at=excluded.until_at,reason=excluded.reason,actor_id=excluded.actor_id;
      insert into public.faucet_audit(guild_id,actor_id,action,target,details) values(public.faucet_guild(),a->>'userId','blacklist-add',p_payload->>'address',p_payload-'actor');
      return to_jsonb(public.faucet_ms(t+duration*interval '1 millisecond'));
    when 'blacklist-remove' then
      perform public.faucet_actor(a,'blacklist'); delete from public.faucet_blacklist where guild_id=public.faucet_guild() and address=p_payload->>'address';
      insert into public.faucet_audit(guild_id,actor_id,action,target) values(public.faucet_guild(),a->>'userId','blacklist-remove',p_payload->>'address');
    when 'admin-cancel' then
      perform public.faucet_actor(a,null,true);
      update public.faucet_payouts set status='cancelled',error_code='ADMIN_CANCELLED',updated_at=t where guild_id=public.faucet_guild() and faucet_payouts.id=(p_payload->>'id')::uuid and status='queued';
      if not found then perform public.faucet_fail('NOT_QUEUED','Only an unsigned queued payout can be cancelled.'); end if;
      insert into public.faucet_audit(guild_id,actor_id,action,target) values(public.faucet_guild(),a->>'userId','payout-cancelled',p_payload->>'id');
    when 'lease' then
      select * into lease from public.faucet_worker_lease where faucet_worker_lease.id=1;
      if lease.id is not null and lease.owner<>(p_payload->>'owner')::uuid and lease.expires_at>t then return null; end if;
      insert into public.faucet_worker_lease(id,owner,generation,expires_at) values(1,(p_payload->>'owner')::uuid,1,t+interval '3 minutes')
        on conflict(id) do update set owner=excluded.owner,expires_at=excluded.expires_at,
          generation=faucet_worker_lease.generation+case when faucet_worker_lease.owner=excluded.owner and faucet_worker_lease.expires_at>t then 0 else 1 end returning * into lease;
      return jsonb_build_object('owner',lease.owner,'generation',lease.generation,'expiresAt',public.faucet_ms(lease.expires_at));
    when 'lease-release' then
      update public.faucet_worker_lease set expires_at=t where owner=(p_payload->'lease'->>'owner')::uuid and generation=(p_payload->'lease'->>'generation')::bigint;
    when 'save-signed' then
      perform public.faucet_check_lease(p_payload->'lease');
      perform public.faucet_eligible((p_payload->>'id')::uuid,a);
      if exists(select 1 from public.faucet_payouts where status in ('signed','broadcast','review')) then perform public.faucet_fail('ALREADY_PENDING','Another transaction is already being settled.'); end if;
      if coalesce(p_payload->'prepared'->>'rawTx','') !~ '^0x[0-9a-fA-F]+$' then perform public.faucet_fail('SIGNING','Invalid signed tranasaction.'); end if;
      update public.faucet_payouts set status='signed',raw_tx=p_payload->'prepared'->>'rawTx',tx_hash=p_payload->'prepared'->>'txHash',nonce=(p_payload->'prepared'->>'nonce')::bigint,updated_at=t
        where faucet_payouts.id=(p_payload->>'id')::uuid returning * into p;
      return public.faucet_payout_json(p);
    when 'worker-cancel' then
      perform public.faucet_check_lease(p_payload->'lease');
      update public.faucet_payouts set status=case when (p_payload->>'failed')::boolean then 'failed' else 'cancelled' end,error_code=p_payload->>'code',updated_at=t
        where faucet_payouts.id=(p_payload->>'id')::uuid and status='queued';
    when 'worker-pause' then
      perform public.faucet_check_lease(p_payload->'lease');
      if exists(select 1 from public.faucet_settings where (value->>'enabled')::boolean or value->>'pauseReason' is distinct from p_payload->>'code') then
        update public.faucet_settings set value=value||jsonb_build_object('enabled',false,'pauseReason',p_payload->>'code'),control_version=control_version+1,updated_at=t where (value->>'enabled')::boolean or value->>'pauseReason' is distinct from p_payload->>'code';
        insert into public.faucet_audit(guild_id,actor_id,action,target,details) values(public.faucet_guild(),'system','faucet-paused','faucet',jsonb_build_object('code',p_payload->>'code'));
      end if;
    when 'worker-mark' then
      perform public.faucet_check_lease(p_payload->'lease');
      new_state:=p_payload->>'status';
      if new_state not in ('broadcast','review') then perform public.faucet_fail('QUEUE_CHANGED','Invalid payout transition.'); end if;
      update public.faucet_payouts set status=new_state,error_code=p_payload->>'code',updated_at=t
        where faucet_payouts.id=(p_payload->>'id')::uuid and status in ('signed','broadcast','review');
      -- A review state and its pause must commit together, even if the HTTP response is lost.
      if found and new_state='review' then
        if exists(select 1 from public.faucet_settings where (value->>'enabled')::boolean or value->>'pauseReason' is distinct from p_payload->>'code') then
          update public.faucet_settings set value=value||jsonb_build_object('enabled',false,'pauseReason',p_payload->>'code'),control_version=control_version+1,updated_at=t where (value->>'enabled')::boolean or value->>'pauseReason' is distinct from p_payload->>'code';
          insert into public.faucet_audit(guild_id,actor_id,action,target,details) values(public.faucet_guild(),'system','faucet-paused','faucet',jsonb_build_object('code',p_payload->>'code'));
        end if;
      end if;
    when 'finish' then
      perform public.faucet_check_lease(p_payload->'lease');
      select * into p from public.faucet_payouts where faucet_payouts.id=(p_payload->>'id')::uuid;
      if p.status='confirmed' then return 'true'; end if;
      if p.id is null or p.status not in ('signed','broadcast','review') or p.tx_hash is distinct from p_payload->>'txHash' then
        perform public.faucet_fail('QUEUE_CHANGED','The receipt does not match the reserved payout.'); end if;
      perform set_config('faucet.guild_id',p.guild_id,true);
      if (p_payload->>'success')::boolean then
        update public.faucet_payouts set status='confirmed',confirmed_at=t,updated_at=t,error_code=null where faucet_payouts.id=p.id;
        insert into public.faucet_cooldowns(kind,subject,until_at) values('address',p.address,t+p.cooldown_ms*interval '1 millisecond')
          on conflict(kind,subject) do update set until_at=greatest(faucet_cooldowns.until_at,excluded.until_at);
        if p.kind='claim' then insert into public.faucet_cooldowns(kind,subject,until_at) values('user',p.user_id,t+p.cooldown_ms*interval '1 millisecond')
          on conflict(kind,subject) do update set until_at=greatest(faucet_cooldowns.until_at,excluded.until_at); end if;
        insert into public.faucet_audit(guild_id,actor_id,action,target,details) values(public.faucet_guild(),'system','payout-confirmed',p.id::text,jsonb_build_object('txHash',p.tx_hash));
      else update public.faucet_payouts set status='failed',error_code='TX_REVERTED',updated_at=t where faucet_payouts.id=p.id; end if;
    when 'notice' then
      perform public.faucet_check_lease(p_payload->'lease');
      if (p_payload->>'delivered')::boolean then
        update public.faucet_payouts set notice_status=p_payload->>'status',notice_attempts=0,notice_after=t where faucet_payouts.id=(p_payload->>'id')::uuid and status=p_payload->>'status';
      else
        update public.faucet_payouts set notice_attempts=notice_attempts+1,
          notice_after=t+least(3600000,5000*power(2,least(notice_attempts+1,10)))*interval '1 millisecond' where faucet_payouts.id=(p_payload->>'id')::uuid and status=p_payload->>'status';
      end if;
    else perform public.faucet_fail('DATABASE_ACTION','Unknown database write operation.');
  end case;
  return 'true';
end $$;

-- Restrict only this application's objects; leave unrelated project permissions alone.
do $$ declare r record; begin
  for r in select tablename from pg_tables where schemaname='public' and tablename like 'faucet\_%' escape '\' loop
    execute format('alter table public.%I enable row level security',r.tablename);
    execute format('revoke all on table public.%I from public, anon, authenticated',r.tablename);
    execute format('grant select, insert, update, delete on table public.%I to service_role',r.tablename);
    if not exists(select 1 from pg_policies where schemaname='public' and tablename=r.tablename and policyname='faucet_backend_only') then
      execute format('create policy faucet_backend_only on public.%I for all to service_role using (true) with check (true)',r.tablename);
    end if;
  end loop;
  for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'faucet\_%' escape '\' loop
    execute format('revoke all on function %s from public, anon, authenticated',r.signature);
    execute format('grant execute on function %s to service_role',r.signature);
  end loop;
end $$;
grant usage, select on sequence public.faucet_payouts_queue_order_seq, public.faucet_audit_id_seq to service_role;
revoke all on sequence public.faucet_payouts_queue_order_seq, public.faucet_audit_id_seq from public, anon, authenticated;
notify pgrst, 'reload schema';

commit;

-- Expected: schemaVersion 3, initialized false until the bot's first startup.
select public.faucet_read('health', '{}'::jsonb) as faucet_database_status;
