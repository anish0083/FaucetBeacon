-- Run AFTER schema.sql and BEFORE the first configured bot startup.
-- Refuses an initialized database. Test records are rolled back; no chain calls occur.
-- Run the complete file in one SQL Editor execution.
begin;
set local plpgsql.check_asserts = on;
select pg_advisory_xact_lock(19042026, 70421);
do $$ begin
  if exists(select 1 from public.faucet_settings) or exists(select 1 from public.faucet_payouts) then
    raise exception 'Verification needs an uninitialized test database. Use a separate test database once your bot has started.';
  end if;
end $$;

create function pg_temp.faucet_expect_error(action text, payload jsonb, expected text) returns void
language plpgsql as $$
declare actual text;
begin
  begin
    perform public.faucet_write(action,payload);
  exception when others then
    get stacked diagnostics actual=message_text;
    if actual=expected then return; end if;
    raise exception 'Expected %, got % for %',expected,actual,action;
  end;
  raise exception 'Expected % but % succeeded',expected,action;
end $$;

do $tests$
declare
  a jsonb := '{"guildId":"100000000000000001","channelId":"200000000000000001","userId":"300000000000000001","isAdmin":true,"roleIds":[]}';
  u jsonb := '{"guildId":"100000000000000001","channelId":"200000000000000001","userId":"300000000000000002","isAdmin":false,"roleIds":[]}';
  m jsonb := '{"guildId":"100000000000000001","channelId":"200000000000000001","userId":"300000000000000003","isAdmin":false,"roleIds":["400000000000000001"]}';
  u2 jsonb; settings jsonb; p jsonb; q jsonb; draft jsonb; batch jsonb;
  lease1 jsonb; lease2 jsonb; prepared jsonb; version bigint; cooldown bigint;
  addr1 text := '0x1111111111111111111111111111111111111111';
  addr2 text := '0x2222222222222222222222222222222222222222';
  addr3 text := '0x3333333333333333333333333333333333333333';
  addr4 text := '0x4444444444444444444444444444444444444444';
  addr5 text := '0x5555555555555555555555555555555555555555';
  blocked boolean := false; item record;
begin
  u2:=u||'{"userId":"300000000000000004"}';
  settings:='{"enabled":true,"pauseReason":null,"amountWei":"1000000000000000000","cooldownMs":21600000,"autoClaim":true,"maxPayoutWei":"10000000000000000000","maxBatchTotalWei":"100000000000000000000","maxDailyTotalWei":"1000000000000000000000","maxBatchRows":100}';
  assert public.faucet_valid_settings(settings), 'Initial settings validation';
  assert not public.faucet_valid_settings(settings-'enabled'), 'Missing boolean settings must fail';
  assert not public.faucet_valid_settings(settings||'{"amountWei":"1.5"}'), 'Fractional wei must fail';
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u,'address',addr1,'requestKey','check:unregistered-server'),'WRONG_SERVER');
  perform pg_temp.faucet_expect_error('lease',jsonb_build_object('guildId',a->>'guildId','owner','11111111-1111-4111-8111-111111111111'),'DATABASE_NOT_INITIALIZED');
  perform public.faucet_write('initialize',jsonb_build_object('guildId',a->>'guildId','wallet','0x9999999999999999999999999999999999999999','chainId',19042026,'settings',settings));
  assert (public.faucet_read('settings')->>'enabled')::boolean=false, 'The first startup must be paused';
  perform pg_temp.faucet_expect_error('initialize',jsonb_build_object('guildId',a->>'guildId','wallet',addr1,'chainId',19042026,'settings',settings),'DATABASE_IDENTITY');

  -- Channel and role authorization.
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u,'address',addr1,'requestKey','check:no-channel'),'CHANNEL_NOT_APPROVED');
  perform pg_temp.faucet_expect_error('channel',jsonb_build_object('actor',m,'channelId',a->>'channelId','allowed',true),'ADMIN_REQUIRED');
  perform pg_temp.faucet_expect_error('settings',jsonb_build_object('actor',m,'patch','{"amountWei":"2"}'::jsonb),'ADMIN_REQUIRED');
  perform pg_temp.faucet_expect_error('role',jsonb_build_object('actor',m,'roleId','400000000000000001','capability','bulk','grant',true),'ADMIN_REQUIRED');
  perform pg_temp.faucet_expect_error('role',jsonb_build_object('actor',a,'roleId',a->>'guildId','capability','bulk','grant',true),'EVERYONE_ROLE');
  perform public.faucet_write('channel',jsonb_build_object('actor',a,'channelId',a->>'channelId','allowed',true));
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u,'address',addr1,'requestKey','check:paused'),'PAUSED');
  perform public.faucet_write('settings',jsonb_build_object('actor',a,'patch','{"enabled":true}'::jsonb));
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u||'{"channelId":"child-thread"}','address',addr1,'requestKey','check:thread'),'CHANNEL_NOT_APPROVED');
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u||'{"guildId":"other-server"}','address',addr1,'requestKey','check:other-guild'),'WRONG_SERVER');
  perform public.faucet_write('role',jsonb_build_object('actor',a,'roleId','400000000000000001','capability','blacklist','grant',true));
  perform pg_temp.faucet_expect_error('draft-create',jsonb_build_object('actor',m,'addresses',jsonb_build_array(addr3),'amountWei','1'),'PERMISSION_REQUIRED');
  perform pg_temp.faucet_expect_error('settings',jsonb_build_object('actor',m,'capability','cooldown','patch','{"cooldownMs":3600000}'::jsonb),'PERMISSION_REQUIRED');

  -- Timed blacklists and request/account/address deduplication.
  perform public.faucet_write('blacklist-add',jsonb_build_object('actor',m,'address',addr2,'durationMs',1800000,'reason','SQL verification'));
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2,'address',addr2,'requestKey','check:ban'),'BLACKLISTED');
  update public.faucet_blacklist set until_at=now()-interval '1 second' where address=addr2;
  q:=public.faucet_write('claim',jsonb_build_object('actor',u2,'address',addr2,'requestKey','check:expired-ban'));
  perform public.faucet_write('admin-cancel',jsonb_build_object('actor',a,'id',q->>'id'));
  p:=public.faucet_write('claim',jsonb_build_object('actor',u,'address',addr1,'requestKey','check:claim'));
  assert p->>'amountWei'='1000000000000000000', 'Exact amount must remain a string';
  assert p->>'id'=public.faucet_write('claim',jsonb_build_object('actor',u,'address',addr1,'requestKey','check:claim'))->>'id', 'A request ID must be idempotent';
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u,'address',addr2,'requestKey','check:user-reserved'),'ALREADY_PENDING');
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2,'address',addr1,'requestKey','check:wallet-reserved'),'ALREADY_PENDING');

  -- Lease fencing, durable signatures, single inflight index and confirmation cooldown.
  lease1:=public.faucet_write('lease','{"owner":"11111111-1111-4111-8111-111111111111"}');
  assert lease1 is not null, 'First worker must acquire the lease';
  assert public.faucet_write('lease','{"owner":"22222222-2222-4222-8222-222222222222"}') is null, 'Second worker must wait';
  prepared:=jsonb_build_object('rawTx','0x01','txHash','0x'||repeat('a',64),'nonce',0);
  p:=public.faucet_write('save-signed',jsonb_build_object('actor',u,'id',p->>'id','prepared',prepared,'lease',lease1));
  assert p->>'status'='signed' and p->>'rawTx'='0x01', 'Signature persistence';
  perform pg_temp.faucet_expect_error('admin-cancel',jsonb_build_object('actor',a,'id',p->>'id'),'NOT_QUEUED');
  begin
    insert into public.faucet_payouts(guild_id,request_key,kind,user_id,channel_id,address,amount_wei,cooldown_ms,status,raw_tx,tx_hash,nonce)
      values(a->>'guildId','check:second-signed','claim',u2->>'userId',a->>'channelId',addr5,1,21600000,'signed','0x02','0x'||repeat('b',64),1);
  exception when unique_violation then blocked:=true;
  end;
  assert blocked, 'Single inflight index must reject another signature';
  perform public.faucet_write('worker-mark',jsonb_build_object('id',p->>'id','status','broadcast','lease',lease1));
  perform public.faucet_write('finish',jsonb_build_object('id',p->>'id','txHash',p->>'txHash','success',true,'lease',lease1));
  assert public.faucet_read('payout',jsonb_build_object('id',p->>'id'))->>'status'='confirmed', 'Confirmation must persist';
  cooldown:=(public.faucet_read('cooldown',jsonb_build_object('kind','address','subject',addr1)))::bigint;
  assert cooldown>public.faucet_ms(clock_timestamp()+interval '5 hours 59 minutes'), 'Six-hour cooldown starts at confirmation';
  assert cooldown=(public.faucet_read('cooldown',jsonb_build_object('kind','user','subject',u->>'userId')))::bigint, 'Wallet and user cooldowns';
  perform public.faucet_write('finish',jsonb_build_object('id',p->>'id','txHash',p->>'txHash','success',true,'lease',lease1));
  assert cooldown=(public.faucet_read('cooldown',jsonb_build_object('kind','address','subject',addr1)))::bigint, 'Repeating confirmation cannot extend cooldown';
  perform public.faucet_write('blacklist-add',jsonb_build_object('actor',m,'address',addr1,'durationMs',3600000));
  perform public.faucet_write('blacklist-remove',jsonb_build_object('actor',m,'address',addr1));
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2,'address',addr1,'requestKey','check:ban-removal'),'COOLDOWN');
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u,'address',addr2,'requestKey','check:user-cooldown'),'COOLDOWN');
  update public.faucet_worker_lease set expires_at=clock_timestamp()-interval '1 second';
  lease2:=public.faucet_write('lease','{"owner":"22222222-2222-4222-8222-222222222222"}');
  assert (lease2->>'generation')::bigint>(lease1->>'generation')::bigint, 'Lease takeover must advance fencing generation';
  perform pg_temp.faucet_expect_error('worker-pause',jsonb_build_object('code','old-worker','lease',lease1),'LEASE_LOST');

  -- Stale start requests cannot override a newer stop.
  version:=(public.faucet_read('control-version'))::bigint;
  perform public.faucet_write('settings',jsonb_build_object('actor',a,'patch','{"enabled":false}'::jsonb));
  perform pg_temp.faucet_expect_error('settings',jsonb_build_object('actor',a,'patch','{"enabled":true}'::jsonb,'expectedVersion',version),'CONTROL_CHANGED');
  perform public.faucet_write('settings',jsonb_build_object('actor',a,'patch','{"enabled":true}'::jsonb));

  -- CSV preview, independent delegated permissions and atomic confirmation.
  perform public.faucet_write('role',jsonb_build_object('actor',a,'roleId','400000000000000001','capability','bulk','grant',true));
  perform pg_temp.faucet_expect_error('draft-create',jsonb_build_object('actor',m,'addresses',jsonb_build_array(addr3,addr4),'amountWei','500000000000000000','cooldownMs',3600000),'PERMISSION_REQUIRED');
  perform public.faucet_write('role',jsonb_build_object('actor',a,'roleId','400000000000000001','capability','cooldown','grant',true));
  perform pg_temp.faucet_expect_error('settings',jsonb_build_object('actor',m,'capability','cooldown','patch','{"enabled":true}'::jsonb),'PERMISSION_REQUIRED');
  draft:=public.faucet_write('draft-create',jsonb_build_object('actor',m,'addresses',jsonb_build_array(addr3,addr4,addr3),'amountWei','500000000000000000','cooldownMs',3600000));
  assert jsonb_array_length(draft->'addresses')=2, 'CSV deduplication';
  assert (public.faucet_read('pending-count'))::integer=0, 'CSV preview must not queue transfers';
  perform pg_temp.faucet_expect_error('draft-confirm',jsonb_build_object('actor',a,'id',draft->>'id'),'DRAFT_OWNER');
  perform public.faucet_write('role',jsonb_build_object('actor',a,'roleId','400000000000000001','capability','cooldown','grant',false));
  perform pg_temp.faucet_expect_error('draft-confirm',jsonb_build_object('actor',m,'id',draft->>'id'),'PERMISSION_REQUIRED');
  perform public.faucet_write('role',jsonb_build_object('actor',a,'roleId','400000000000000001','capability','cooldown','grant',true));
  perform public.faucet_write('blacklist-add',jsonb_build_object('actor',m,'address',addr4,'durationMs',3600000));
  perform pg_temp.faucet_expect_error('draft-confirm',jsonb_build_object('actor',m,'id',draft->>'id'),'BLACKLISTED');
  assert (public.faucet_read('pending-count'))::integer=0, 'A rejected batch must reserve zero recipients';
  assert public.faucet_read('draft',jsonb_build_object('id',draft->>'id'))->>'state'='open', 'A rejected preview remains open';
  perform public.faucet_write('blacklist-remove',jsonb_build_object('actor',m,'address',addr4));
  batch:=public.faucet_write('draft-confirm',jsonb_build_object('actor',m,'id',draft->>'id'));
  assert jsonb_array_length(batch)=2, 'CSV confirmation must queue every recipient';
  assert batch=public.faucet_write('draft-confirm',jsonb_build_object('actor',m,'id',draft->>'id')), 'Confirming twice cannot create more jobs';
  perform public.faucet_write('role',jsonb_build_object('actor',a,'roleId','400000000000000001','capability','bulk','grant',false));
  perform pg_temp.faucet_expect_error('save-signed',jsonb_build_object('actor',m,'id',batch->0->>'id','prepared',prepared,'lease',lease2),'PERMISSION_REQUIRED');
  perform public.faucet_write('role',jsonb_build_object('actor',a,'roleId','400000000000000001','capability','bulk','grant',true));
  perform public.faucet_write('channel',jsonb_build_object('actor',a,'channelId',a->>'channelId','allowed',false));
  perform pg_temp.faucet_expect_error('save-signed',jsonb_build_object('actor',m,'id',batch->0->>'id','prepared',prepared,'lease',lease2),'CHANNEL_NOT_APPROVED');
  perform public.faucet_write('channel',jsonb_build_object('actor',a,'channelId',a->>'channelId','allowed',true));

  -- Budgets include reservations and only release confirmed spend after 24 hours.
  assert public.faucet_spent()=2000000000000000000, 'Daily budget includes confirmed and queued amounts';
  perform public.faucet_write('settings',jsonb_build_object('actor',a,'patch','{"maxDailyTotalWei":"2000000000000000000"}'::jsonb));
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2,'address',addr5,'requestKey','check:daily-budget'),'DAILY_LIMIT');
  update public.faucet_payouts set confirmed_at=clock_timestamp()-interval '25 hours' where id=(p->>'id')::uuid;
  assert public.faucet_spent()=1000000000000000000, 'Old confirmation must leave the daily budget';
  perform public.faucet_write('settings',jsonb_build_object('actor',a,'patch','{"maxBatchTotalWei":"500000000000000000"}'::jsonb));
  perform pg_temp.faucet_expect_error('save-signed',jsonb_build_object('actor',m,'id',batch->0->>'id','prepared',prepared,'lease',lease2),'BATCH_LIMIT');
  perform public.faucet_write('settings',jsonb_build_object('actor',a,'patch','{"maxBatchTotalWei":"100000000000000000000"}'::jsonb));
  perform public.faucet_write('admin-cancel',jsonb_build_object('actor',a,'id',batch->0->>'id'));
  perform public.faucet_write('admin-cancel',jsonb_build_object('actor',a,'id',batch->1->>'id'));
  perform pg_temp.faucet_expect_error('save-signed',jsonb_build_object('actor',m,'id',batch->0->>'id','prepared',prepared,'lease',lease2),'QUEUE_CHANGED');

  -- Expired/cancelled previews, automatic mode, and one-wei amounts.
  draft:=public.faucet_write('draft-create',jsonb_build_object('actor',a,'addresses',jsonb_build_array(addr5),'amountWei','1'));
  update public.faucet_batches set expires_at=clock_timestamp()-interval '1 second' where id=(draft->>'id')::uuid;
  perform pg_temp.faucet_expect_error('draft-confirm',jsonb_build_object('actor',a,'id',draft->>'id'),'DRAFT_EXPIRED');
  draft:=public.faucet_write('draft-create',jsonb_build_object('actor',a,'addresses',jsonb_build_array(addr5),'amountWei','1'));
  perform public.faucet_write('draft-cancel',jsonb_build_object('actor',a,'id',draft->>'id'));
  perform pg_temp.faucet_expect_error('draft-confirm',jsonb_build_object('actor',a,'id',draft->>'id'),'DRAFT_EXPIRED');
  perform public.faucet_write('settings',jsonb_build_object('actor',a,'patch','{"autoClaim":false,"amountWei":"1"}'::jsonb));
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2,'address',addr5,'requestKey','check:auto-disabled','automatic',true),'AUTO_CLAIM_DISABLED');
  q:=public.faucet_write('claim',jsonb_build_object('actor',u2,'address',addr5,'requestKey','check:one-wei','automatic',false));
  assert q->>'amountWei'='1' and jsonb_typeof(q->'amountWei')='string', 'One wei must round-trip as a string';

  -- RLS and backend-only grants for every application object.
  for item in select c.oid,c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname like 'faucet\_%' escape '\' loop
    assert item.relrowsecurity, 'Every faucet table must enable RLS';
    assert not has_table_privilege('anon',item.oid,'SELECT'), 'Anon must not read faucet tables';
    assert not has_table_privilege('authenticated',item.oid,'INSERT,UPDATE,DELETE'), 'Users must not mutate faucet tables';
    assert has_table_privilege('service_role',item.oid,'SELECT,INSERT,UPDATE,DELETE'), 'Backend table grants';
  end loop;
  for item in select f.oid,f.prosecdef from pg_proc f join pg_namespace n on n.oid=f.pronamespace
    where n.nspname='public' and f.proname like 'faucet\_%' escape '\' loop
    assert not item.prosecdef, 'Faucet functions must use SECURITY INVOKER';
    assert not has_function_privilege('anon',item.oid,'EXECUTE'), 'Anon must not execute faucet RPCs';
    assert not has_function_privilege('authenticated',item.oid,'EXECUTE'), 'Users must not execute faucet RPCs';
    assert has_function_privilege('service_role',item.oid,'EXECUTE'), 'Backend function grants';
  end loop;
end $tests$;

do $multi_server$
declare
  a jsonb := '{"guildId":"100000000000000001","channelId":"200000000000000001","userId":"300000000000000001","isAdmin":true,"roleIds":[]}';
  a2 jsonb := '{"guildId":"100000000000000002","channelId":"200000000000000002","userId":"300000000000000001","isAdmin":true,"roleIds":[]}';
  u2 jsonb := '{"guildId":"100000000000000002","channelId":"200000000000000002","userId":"300000000000000006","isAdmin":false,"roleIds":["400000000000000001"]}';
  settings jsonb; job jsonb; draft jsonb; lease jsonb; prepared jsonb; queued jsonb;
  addr text := '0x6666666666666666666666666666666666666666';
begin
  settings:=public.faucet_read('settings',jsonb_build_object('guildId',a->>'guildId'));
  settings:=settings||'{"amountWei":"100000000000000000","autoClaim":true}';
  perform pg_temp.faucet_expect_error('initialize',jsonb_build_object('guildId',a2->>'guildId','wallet',addr,'chainId',19042026,'settings',settings),'DATABASE_IDENTITY');
  perform public.faucet_write('initialize',jsonb_build_object('guildId',a2->>'guildId','wallet','0x9999999999999999999999999999999999999999','chainId',19042026,'settings',settings));
  assert not (public.faucet_read('settings')->>'enabled')::boolean, 'Every new server starts paused';
  assert public.faucet_read('channels')='[]'::jsonb, 'New servers inherit no approved channels';
  assert public.faucet_read('roles')='[]'::jsonb, 'New servers inherit no role permissions';
  assert public.faucet_read('pending-count')='0'::jsonb, 'Pending counts are server scoped';
  perform pg_temp.faucet_expect_error('settings',jsonb_build_object('guildId',a->>'guildId','actor',a2,'patch','{"enabled":true}'::jsonb),'WRONG_SERVER');
  perform public.faucet_write('channel',jsonb_build_object('actor',a2,'channelId',a2->>'channelId','allowed',true));
  perform public.faucet_write('settings',jsonb_build_object('actor',a2,'patch','{"enabled":true}'::jsonb));
  assert public.faucet_read('settings')->>'amountWei'='100000000000000000', 'Second server keeps 0.1 tITL';
  assert public.faucet_read('settings',jsonb_build_object('guildId',a->>'guildId'))->>'amountWei'='1', 'First server keeps its own amount';
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2||jsonb_build_object('channelId',a->>'channelId'),'address',addr,'requestKey','multi:wrong-channel'),'CHANNEL_NOT_APPROVED');
  perform pg_temp.faucet_expect_error('draft-create',jsonb_build_object('actor',u2,'addresses',jsonb_build_array(addr),'amountWei','1'),'PERMISSION_REQUIRED');

  -- User cooldown, wallet cooldown, and unsigned reservations span every server.
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2||'{"userId":"300000000000000002"}','address',addr,'requestKey','multi:user-cooldown'),'COOLDOWN');
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2,'address','0x1111111111111111111111111111111111111111','requestKey','multi:wallet-cooldown'),'COOLDOWN');
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2,'address','0x5555555555555555555555555555555555555555','requestKey','multi:wallet-reserved'),'ALREADY_PENDING');
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2||'{"userId":"300000000000000004"}','address',addr,'requestKey','multi:user-reserved'),'ALREADY_PENDING');
  perform pg_temp.faucet_expect_error('claim',jsonb_build_object('actor',u2,'address',addr,'requestKey','check:one-wei'),'WRONG_SERVER');

  -- Blacklists, settings, batches and reports remain local to their server.
  perform public.faucet_write('blacklist-add',jsonb_build_object('actor',a,'address',addr,'durationMs',3600000));
  assert public.faucet_read('blacklist',jsonb_build_object('guildId',a2->>'guildId','address',addr)) is null, 'A server cannot read another blacklist';
  job:=public.faucet_write('claim',jsonb_build_object('actor',u2,'address',addr,'requestKey','multi:claim'));
  assert job->>'guildId'=a2->>'guildId' and job->>'amountWei'='100000000000000000', 'Payout carries its server and exact amount';
  assert public.faucet_read('payout',jsonb_build_object('guildId',a->>'guildId','id',job->>'id')) is null, 'Payout reads cannot cross servers';
  perform pg_temp.faucet_expect_error('admin-cancel',jsonb_build_object('actor',a,'id',job->>'id'),'NOT_QUEUED');
  draft:=public.faucet_write('draft-create',jsonb_build_object('actor',a2,'addresses','["0x7777777777777777777777777777777777777777"]'::jsonb,'amountWei','1'));
  assert public.faucet_read('draft',jsonb_build_object('guildId',a->>'guildId','id',draft->>'id')) is null, 'Draft reads cannot cross servers';
  perform pg_temp.faucet_expect_error('draft-confirm',jsonb_build_object('actor',a,'id',draft->>'id'),'DRAFT_OWNER');
  perform pg_temp.faucet_expect_error('draft-cancel',jsonb_build_object('actor',a,'id',draft->>'id'),'DRAFT_OWNER');
  perform public.faucet_write('draft-confirm',jsonb_build_object('actor',a2,'id',draft->>'id'));
  assert public.faucet_read('batch',jsonb_build_object('guildId',a->>'guildId','id',draft->>'id'))='[]'::jsonb, 'Batch reports cannot cross servers';
  perform public.faucet_write('settings',jsonb_build_object('actor',a,'patch','{"enabled":false}'::jsonb));
  queued:=public.faucet_read('next',jsonb_build_object('guildId',a->>'guildId','guildIds',jsonb_build_array(a->>'guildId',a2->>'guildId')));
  assert queued->>'id'=job->>'id', 'A paused first server does not block the second server queue';
  assert public.faucet_read('next',jsonb_build_object('guildIds',jsonb_build_array(a->>'guildId'))) is null, 'Worker obeys the configured server allowlist';

  -- One wallet means one global worker lease and one global signed transaction.
  lease:=public.faucet_write('lease',jsonb_build_object('guildId',a2->>'guildId','owner','22222222-2222-4222-8222-222222222222'));
  assert public.faucet_write('lease',jsonb_build_object('guildId',a->>'guildId','owner','33333333-3333-4333-8333-333333333333')) is null, 'Another server cannot acquire a separate wallet lease';
  prepared:=jsonb_build_object('rawTx','0x03','txHash','0x'||repeat('c',64),'nonce',1);
  perform public.faucet_write('save-signed',jsonb_build_object('actor',u2,'id',job->>'id','prepared',prepared,'lease',lease));
  assert public.faucet_read('inflight',jsonb_build_object('guildId',a->>'guildId'))->>'id'=job->>'id', 'Worker recovers signed transactions across servers';
  perform public.faucet_write('finish',jsonb_build_object('guildId',a->>'guildId','id',job->>'id','txHash',prepared->>'txHash','success',true,'lease',lease));
  assert (public.faucet_read('cooldown',jsonb_build_object('guildId',a->>'guildId','kind','address','subject',addr)))::bigint>public.faucet_ms(now()), 'Second-server confirmation creates a shared cooldown';
  assert exists(select 1 from public.faucet_audit where action='payout-confirmed' and target=job->>'id' and guild_id=a2->>'guildId'), 'Worker audit uses the payout server';
  perform public.faucet_write('worker-pause',jsonb_build_object('guildId',a->>'guildId','lease',lease,'code','LOW_BALANCE'));
  assert not exists(select 1 from public.faucet_settings where (value->>'enabled')::boolean), 'Wallet failures pause all servers';
end $multi_server$;

-- Exercise actual invoker privileges as the bot's database role.
set local role service_role;
select public.faucet_read('health') as backend_read_check;
select public.faucet_write('lease','{"owner":"22222222-2222-4222-8222-222222222222"}') as backend_write_check;
reset role;
select 'All database checks passed. Test records will now be rolled back; no transfers were sent.' as verification;
rollback;
