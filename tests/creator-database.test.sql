-- Run only in an isolated local/staging database after both creator migrations.
-- No production SQL, real Telegram identities, provider calls, or payments.
-- All synthetic rows and changes roll back. Identity sequences can still advance.
-- The global admission lock is exercised, so keep this transaction short.
begin;
set local statement_timeout='15s';
set local timezone='UTC';

do $$
declare
  v_base bigint; v_user bigint; v_job uuid; v_other_job uuid; v_legacy_job uuid;
  v_tier text; v_unit integer; v_cap integer; v_index integer:=0; v_i integer;
  v_payload jsonb; v_result jsonb; v_images jsonb; v_balance integer;
  v_failed boolean; v_signature text; v_table text;
  v_day date:=(now() at time zone 'UTC')::date;
  v_pack text; v_hash1 text; v_hash2 text; v_hash3 text; v_hash4 text;
begin
  -- Avoid affecting an unrelated queue if the file is pointed at the wrong DB.
  if exists(select 1 from public.creator_jobs where state in ('queued','running')) then
    raise exception 'creator fixture requires an isolated empty active queue';
  end if;
  foreach v_signature in array array[
    'public.creator_job_start(bigint,uuid,jsonb,integer)',
    'public.creator_job_finish(uuid,text,text,text)',
    'public.creator_job_claim()',
    'public.creator_job_expire(uuid)',
    'public.creator_invite_create(bigint,text,text)',
    'public.creator_invite_create_v2(bigint,text,text,boolean)',
    'public.creator_invite_join(bigint,text)',
    'public.creator_member_remove(bigint,text,bigint)'
  ] loop
    if has_function_privilege('anon',v_signature,'execute')
      or has_function_privilege('authenticated',v_signature,'execute')
      or not has_function_privilege('service_role',v_signature,'execute') then
      raise exception 'creator RPC permissions incorrect: %',v_signature;
    end if;
    if exists(select 1 from pg_proc where oid=v_signature::regprocedure
      and (prosecdef or not coalesce('search_path=""'=any(proconfig),false))) then
      raise exception 'creator RPC security settings incorrect: %',v_signature;
    end if;
  end loop;
  foreach v_table in array array['creator_jobs','creator_assets','creator_pack_operations','sticker_pack_invites','sticker_pack_members'] loop
    if exists(select 1 from pg_class where oid=('public.'||v_table)::regclass and not relrowsecurity)
      or has_table_privilege('anon','public.'||v_table,'select,insert,update,delete')
      or has_table_privilege('authenticated','public.'||v_table,'select,insert,update,delete') then
      raise exception 'creator table access incorrect: %',v_table;
    end if;
  end loop;

  -- Synthetic IDs are far outside Telegram's supported identifier range.
  loop
    v_base:=9000000000000000000::bigint+floor(random()*1000000000)::bigint;
    exit when not exists(select 1 from public.balances where user_id between v_base and v_base+127)
      and not exists(select 1 from public.subscriptions where user_id between v_base and v_base+127)
      and not exists(select 1 from public.promo_redemptions where user_id between v_base and v_base+127)
      and not exists(select 1 from public.account_activity where user_id between v_base and v_base+127)
      and not exists(select 1 from public.creator_jobs where user_id between v_base and v_base+127)
      and not exists(select 1 from public.sticker_packs where user_id between v_base and v_base+127)
      and not exists(select 1 from public.sticker_pack_members where user_id between v_base and v_base+127)
      and not exists(select 1 from public.app_user_moderation where user_id between v_base and v_base+127);
  end loop;

  -- Every tier's largest batch uses its own price. Quotes/caps fail atomically.
  foreach v_tier in array array['free','standard','luxury','ultimate'] loop
    v_user:=v_base+v_index; v_index:=v_index+1;
    v_unit:=case v_tier when 'ultimate' then 2 when 'luxury' then 3 when 'standard' then 4 else 5 end;
    v_cap:=case v_tier when 'ultimate' then 36 when 'luxury' then 10 when 'standard' then 6 else 8 end;
    v_job:=md5(v_user::text||':tier')::uuid;
    v_payload:=jsonb_build_object('prompt','fixture character','title','Fixture emotions','style','vector','background','white','count',v_cap,'owner',false);
    insert into public.balances(user_id,balance) values(v_user,1000);
    if v_tier<>'free' then
      insert into public.subscriptions(user_id,active,tier,expires_at,first_purchase_done)
        values(v_user,true,v_tier,now()+interval '30 days',true);
    end if;
    v_failed:=false;
    begin
      perform public.creator_job_start(v_user,v_job,v_payload,v_cap*v_unit+1);
    exception when invalid_parameter_value then
      if sqlerrm<>'price changed' then raise; end if; v_failed:=true;
    end;
    if not v_failed or (select balance from public.balances where user_id=v_user)<>1000
      or exists(select 1 from public.creator_jobs where id=v_job)
      or exists(select 1 from public.account_activity where user_id=v_user)
      or exists(select 1 from public.promo_redemptions where user_id=v_user) then
      raise exception 'stale quote mutated state for %',v_tier;
    end if;
    v_failed:=false;
    begin
      perform public.creator_job_start(v_user,v_job,jsonb_set(v_payload,'{count}',to_jsonb(v_cap+1)),(v_cap+1)*v_unit);
    exception when invalid_parameter_value then
      if sqlerrm<>'emotion count limit' then raise; end if; v_failed:=true;
    end;
    if not v_failed or exists(select 1 from public.creator_jobs where id=v_job) then raise exception 'tier cap bypassed for %',v_tier; end if;
    v_result:=public.creator_job_start(v_user,v_job,v_payload,v_cap*v_unit);
    if (v_result->>'cost')::integer is distinct from v_cap*v_unit
      or (v_result->>'total')::integer is distinct from v_cap
      or (v_result->>'balance')::integer is distinct from 1000-v_cap*v_unit
      or not exists(select 1 from public.creator_jobs where id=v_job and total=v_cap and unit_price=v_unit) then
      raise exception 'tier pricing/count incorrect for %',v_tier;
    end if;
    v_result:=public.creator_job_start(v_user,v_job,v_payload,v_cap*v_unit);
    if (select balance from public.balances where user_id=v_user)<>1000-v_cap*v_unit
      or (select count(*) from public.account_activity where operation_key='creator:debit:'||v_job)<>1 then
      raise exception 'retry charged twice for %',v_tier;
    end if;
    v_failed:=false;
    begin
      perform public.creator_job_start(v_user,v_job,jsonb_set(v_payload,'{prompt}','"changed fixture"'),v_cap*v_unit);
    exception when invalid_parameter_value then
      if sqlerrm<>'request reused' then raise; end if; v_failed:=true;
    end;
    if not v_failed then raise exception 'changed request ID accepted for %',v_tier; end if;
    select jsonb_agg(jsonb_build_object('id',g)) into v_images from generate_series(1,v_cap) g;
    update public.creator_jobs set images=v_images,attempted=v_cap where id=v_job;
    v_result:=public.creator_job_finish(v_job,'completed');
    if (v_result->>'refund')::integer<>0 or (select balance from public.balances where user_id=v_user)<>1000-v_cap*v_unit then
      raise exception 'completed images refund incorrectly for %',v_tier;
    end if;
    if v_tier='free' then
      if (select count(*) from public.promo_redemptions where user_id=v_user and code like '__free_image_'||v_day||'_%')<>8
        or not exists(select 1 from public.promo_redemptions where user_id=v_user and code='__free_emotions_'||v_day) then
        raise exception 'free full batch quota missing';
      end if;
    elsif exists(select 1 from public.promo_redemptions where user_id=v_user) then
      raise exception 'paid job consumed free quota for %',v_tier;
    end if;
  end loop;

  -- Partial success bills only created images and keeps the once-per-day marker.
  v_user:=v_base+10; v_job:=md5(v_user::text||':partial')::uuid;
  v_payload:=jsonb_build_object('prompt','fixture','title','Partial fixture','style','vector','count',4,'owner',false);
  insert into public.balances(user_id,balance) values(v_user,1000);
  perform public.creator_job_start(v_user,v_job,v_payload,20);
  update public.creator_jobs set images='[{"id":"one"},{"id":"two"}]',attempted=4 where id=v_job;
  v_result:=public.creator_job_finish(v_job,'completed');
  if (v_result->>'refund')::integer<>10 or (select balance from public.balances where user_id=v_user)<>990
    or (select count(*) from public.promo_redemptions where user_id=v_user)<>3 then raise exception 'partial refund/quota incorrect'; end if;
  v_result:=public.creator_job_finish(v_job,'completed');
  if (v_result->>'refund')::integer<>0 or (select balance from public.balances where user_id=v_user)<>990
    or (select count(*) from public.account_activity where operation_key='creator:refund:'||v_job)<>1 then raise exception 'finish retry refunded twice'; end if;
  v_failed:=false;
  begin
    perform public.creator_job_start(v_user,md5(v_user::text||':second')::uuid,jsonb_set(v_payload,'{count}','2'),10);
  exception when raise_exception then
    if sqlerrm<>'free emotion limit' then raise; end if; v_failed:=true;
  end;
  if not v_failed or (select balance from public.balances where user_id=v_user)<>990 then raise exception 'free once-per-day limit bypassed'; end if;

  -- Zero success and queued cancellation restore balance, image slots and run.
  for v_i in 11..12 loop
    v_user:=v_base+v_i; v_job:=md5(v_user::text||':empty')::uuid;
    insert into public.balances(user_id,balance) values(v_user,1000);
    perform public.creator_job_start(v_user,v_job,v_payload,20);
    v_result:=public.creator_job_finish(v_job,case when v_i=11 then 'interrupted' else 'cancelled' end);
    if (v_result->>'refund')::integer<>20 or (select balance from public.balances where user_id=v_user)<>1000
      or exists(select 1 from public.promo_redemptions where user_id=v_user) then raise exception 'empty/cancelled job failed to restore quota'; end if;
    v_other_job:=md5(v_user::text||':retry')::uuid;
    perform public.creator_job_start(v_user,v_other_job,v_payload,20);
    perform public.creator_job_finish(v_other_job,'cancelled');
  end loop;

  -- Running cancellation is rejected; interruption then refunds the unused work.
  v_user:=v_base+13; v_job:=md5(v_user::text||':running')::uuid;
  insert into public.balances(user_id,balance) values(v_user,1000);
  perform public.creator_job_start(v_user,v_job,v_payload,20);
  update public.creator_jobs set state='running',lease_until=now()+interval '1 minute' where id=v_job;
  v_failed:=false;
  begin perform public.creator_job_finish(v_job,'cancelled');
  exception when raise_exception then if sqlerrm<>'job already running' then raise; end if; v_failed:=true; end;
  if not v_failed or (select balance from public.balances where user_id=v_user)<>980 then raise exception 'running cancellation changed accounting'; end if;
  perform public.creator_job_finish(v_job,'interrupted');

  -- Insufficient remaining daily slots rolls back the tentative run and new slot.
  v_user:=v_base+14; v_job:=md5(v_user::text||':daily')::uuid;
  insert into public.balances(user_id,balance) values(v_user,1000);
  insert into public.promo_redemptions(user_id,code) select v_user,'__free_image_'||v_day||'_'||g from generate_series(1,7) g;
  v_failed:=false;
  begin perform public.creator_job_start(v_user,v_job,jsonb_set(v_payload,'{count}','2'),10);
  exception when raise_exception then if sqlerrm<>'daily free limit' then raise; end if; v_failed:=true; end;
  if not v_failed or (select count(*) from public.promo_redemptions where user_id=v_user)<>7
    or (select balance from public.balances where user_id=v_user)<>1000
    or exists(select 1 from public.creator_jobs where id=v_job)
    or exists(select 1 from public.account_activity where user_id=v_user) then raise exception 'rejected daily reservation leaked accounting/quota'; end if;

  -- Nullable/insufficient balances cannot admit a paid request without its debit.
  v_user:=v_base+15; v_job:=md5(v_user::text||':balance')::uuid;
  insert into public.balances(user_id,balance) values(v_user,null);
  v_failed:=false;
  begin perform public.creator_job_start(v_user,v_job,jsonb_set(v_payload,'{count}','2'),10);
  exception when raise_exception then if sqlerrm<>'insufficient balance' then raise; end if; v_failed:=true; end;
  if not v_failed or exists(select 1 from public.creator_jobs where id=v_job)
    or exists(select 1 from public.promo_redemptions where user_id=v_user) then raise exception 'NULL balance admitted unpaid job'; end if;
  update public.balances set balance=9 where user_id=v_user;
  v_failed:=false;
  begin perform public.creator_job_start(v_user,v_job,jsonb_set(v_payload,'{count}','2'),10);
  exception when raise_exception then if sqlerrm<>'insufficient balance' then raise; end if; v_failed:=true; end;
  if not v_failed or (select balance from public.balances where user_id=v_user)<>9 then raise exception 'insufficient balance mutated'; end if;

  -- Backend-trusted owner flag exempts daily quota; banned accounts still fail.
  v_user:=v_base+16; v_job:=md5(v_user::text||':owner')::uuid;
  insert into public.balances(user_id,balance) values(v_user,1000);
  perform public.creator_job_start(v_user,v_job,jsonb_set(v_payload,'{owner}','true'),20);
  if exists(select 1 from public.promo_redemptions where user_id=v_user) then raise exception 'owner consumed daily quota'; end if;
  perform public.creator_job_finish(v_job,'cancelled');
  insert into public.app_user_moderation(user_id,banned) values(v_user,true);
  v_failed:=false;
  begin perform public.creator_job_start(v_user,md5(v_user::text||':banned')::uuid,v_payload,20);
  exception when insufficient_privilege then if sqlerrm<>'account banned' then raise; end if; v_failed:=true; end;
  if not v_failed or (select balance from public.balances where user_id=v_user)<>1000 then raise exception 'banned account admitted a job'; end if;

  -- A migrated legacy row retains 24/2 defaults and its original 48-coin quote.
  v_user:=v_base+20; v_legacy_job:=md5(v_user::text||':legacy')::uuid;
  v_payload:=jsonb_build_object('prompt','legacy fixture','title','Legacy fixture','style','vector','background','white');
  insert into public.balances(user_id,balance) values(v_user,952);
  insert into public.creator_jobs(id,user_id,payload,cost) values(v_legacy_job,v_user,v_payload,48);
  insert into public.account_activity(user_id,event_type,delta,balance_after,description,operation_key)
    values(v_user,'generation',-48,952,'Legacy fixture','creator:debit:'||v_legacy_job);
  v_result:=public.creator_job_start(v_user,v_legacy_job,v_payload||'{"count":24,"owner":false}'::jsonb,48);
  if (v_result->>'total')::integer<>24 or (v_result->>'cost')::integer<>48
    or not exists(select 1 from public.creator_jobs where id=v_legacy_job and total=24 and unit_price=2)
    or (select balance from public.balances where user_id=v_user)<>952 then raise exception 'legacy replay defaults/price changed'; end if;
  select jsonb_agg(jsonb_build_object('id',g)) into v_images from generate_series(1,5) g;
  update public.creator_jobs set images=v_images,attempted=24 where id=v_legacy_job;
  v_result:=public.creator_job_finish(v_legacy_job,'interrupted');
  if (v_result->>'refund')::integer<>38 or (select balance from public.balances where user_id=v_user)<>990 then raise exception 'legacy refund lost original unit price'; end if;

  -- Expiry rechecks current eligibility: renewed leases survive, stale jobs refund.
  v_user:=v_base+21; v_job:=md5(v_user::text||':lease')::uuid;
  v_payload:=jsonb_build_object('prompt','lease fixture','title','Lease fixture','style','vector','count',2,'owner',false);
  insert into public.balances(user_id,balance) values(v_user,1000);
  insert into public.subscriptions(user_id,active,tier,expires_at,first_purchase_done) values(v_user,true,'ultimate',now()+interval '30 days',true);
  perform public.creator_job_start(v_user,v_job,v_payload,4);
  update public.creator_jobs set state='running',lease_until=now()+interval '1 minute' where id=v_job;
  perform public.creator_job_expire(v_job);
  if (select state from public.creator_jobs where id=v_job)<>'running'
    or (select balance from public.balances where user_id=v_user)<>996 then raise exception 'fresh lease was interrupted'; end if;
  update public.creator_jobs set lease_until=now()-interval '1 minute' where id=v_job;
  perform public.creator_job_expire(v_job);
  if (select state from public.creator_jobs where id=v_job)<>'interrupted'
    or (select balance from public.balances where user_id=v_user)<>1000 then raise exception 'expired lease failed to refund'; end if;
  v_other_job:=md5(v_user::text||':oldqueue')::uuid;
  perform public.creator_job_start(v_user,v_other_job,v_payload,4);
  update public.creator_jobs set created_at=now()-interval '3 hours' where id=v_other_job;
  perform public.creator_job_expire(v_other_job);
  if (select state from public.creator_jobs where id=v_other_job)<>'interrupted'
    or (select balance from public.balances where user_id=v_user)<>1000 then raise exception 'stale queued job failed to refund'; end if;

  -- Both old and new invitation entry points preserve existing links by default.
  v_user:=v_base+30; v_pack:='creator_fixture_'||md5(v_base::text);
  v_hash1:=md5(v_pack||':1')||md5(v_pack||':one'); v_hash2:=md5(v_pack||':2')||md5(v_pack||':two');
  v_hash3:=md5(v_pack||':3')||md5(v_pack||':three'); v_hash4:=md5(v_pack||':4')||md5(v_pack||':four');
  insert into public.sticker_packs(short_name,user_id,title) values(v_pack,v_user,'Creator fixture');
  perform public.creator_invite_create(v_user,v_pack,v_hash1);
  perform public.creator_invite_create_v2(v_user,v_pack,v_hash2);
  perform public.creator_invite_create(v_user,v_pack,v_hash3);
  if (select count(*) from public.sticker_pack_invites where pack_short_name=v_pack and revoked_at is null)<>3 then raise exception 'default invitation creation revoked an old link'; end if;
  v_result:=public.creator_invite_join(v_base+31,v_hash1);
  if v_result->>'role'<>'contributor' or not exists(select 1 from public.sticker_pack_members where pack_short_name=v_pack and user_id=v_base+31 and removed_at is null) then raise exception 'old invitation no longer joins'; end if;
  perform public.creator_invite_create_v2(v_user,v_pack,v_hash4,true);
  if (select count(*) from public.sticker_pack_invites where pack_short_name=v_pack and revoked_at is null)<>1
    or not exists(select 1 from public.sticker_pack_invites where token_hash=v_hash4 and revoked_at is null) then raise exception 'explicit invitation rotation failed'; end if;
  v_failed:=false;
  begin perform public.creator_invite_join(v_base+32,v_hash1);
  exception when raise_exception then if sqlerrm<>'invite unavailable' then raise; end if; v_failed:=true; end;
  if not v_failed then raise exception 'rotated old invitation still joins'; end if;
  v_result:=public.creator_invite_join(v_base+32,v_hash4);
  if v_result->>'role'<>'contributor' then raise exception 'rotated new invitation does not join'; end if;
  v_failed:=false;
  begin perform public.creator_invite_create_v2(v_base+32,v_pack,md5(v_pack||':bad')||md5(v_pack||':bad2'));
  exception when insufficient_privilege then if sqlerrm<>'pack not owned' then raise; end if; v_failed:=true; end;
  if not v_failed then raise exception 'contributor created an owner invitation'; end if;

  -- Global cap: admission cannot create job 21 or persist its tentative account.
  insert into public.balances(user_id,balance) select v_base+100+g,1000 from generate_series(1,20) g;
  insert into public.creator_jobs(id,user_id,payload,cost,total,unit_price)
    select md5(v_base::text||':queue:'||g)::uuid,v_base+100+g,'{"count":2,"owner":true}'::jsonb,10,2,5 from generate_series(1,20) g;
  v_user:=v_base+121; v_job:=md5(v_user::text||':fullqueue')::uuid;
  v_failed:=false;
  begin perform public.creator_job_start(v_user,v_job,v_payload,10);
  exception when raise_exception then if sqlerrm<>'queue full' then raise; end if; v_failed:=true; end;
  if not v_failed or exists(select 1 from public.balances where user_id=v_user)
    or exists(select 1 from public.creator_jobs where id=v_job)
    or exists(select 1 from public.account_activity where user_id=v_user)
    or (select count(*) from public.creator_jobs where state in ('queued','running'))<>20 then raise exception 'global queue admission cap leaked state'; end if;

  raise notice 'creator database fixtures passed; all rows will roll back';
end $$;

rollback;

-- Separate local two-session checks are required to exercise actual waits:
-- 1. Same-user start replay: both return one job, one debit, one daily claim.
-- 2. At 19 active jobs, concurrent different-user starts admit exactly one.
-- 3. Concurrent expiry sweeps use the same user/id ordering and never deadlock.
-- 4. Pause expiry behind a balance lock, renew its lease, then release the lock:
--    creator_job_expire must leave that running job and its balance untouched.
