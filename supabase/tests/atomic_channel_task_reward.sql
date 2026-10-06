-- Run only after atomic_channel_task_reward is applied.
-- No real user IDs, Telegram calls, Stars payments, or AI spending.
-- All fixture data and temporary task-quota settings roll back. The shared
-- promo configuration is locked until rollback, so run promptly in one call.
-- Identity sequences may advance even though fixture rows are rolled back.
begin;
set local statement_timeout='15s';

do $$
declare
  v_user bigint;
  v_duplicate_user bigint;
  v_repair_user bigint;
  v_fail_user bigint;
  v_overflow_user bigint;
  v_exhaust_user bigint;
  v_result jsonb;
  v_uses integer;
  v_failed boolean;
begin
  if has_function_privilege('anon','public.account_claim_channel_task(bigint)','execute')
    or has_function_privilege('authenticated','public.account_claim_channel_task(bigint)','execute')
    or not has_function_privilege('service_role','public.account_claim_channel_task(bigint)','execute') then
    raise exception 'channel task RPC permissions incorrect';
  end if;
  if exists(
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='account_claim_channel_task'
      and (p.prosecdef or not ('search_path=""'=any(p.proconfig)))
  ) then raise exception 'channel task RPC security settings incorrect'; end if;
  if exists(
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('promo_codes','promo_redemptions','balances','account_activity')
      and not c.relrowsecurity
  ) then raise exception 'channel task table without RLS'; end if;

  -- Generate an unused block of synthetic IDs outside Telegram's ID range.
  loop
    v_user:=9000000000000000000::bigint+floor(random()*1000000000)::bigint;
    exit when not exists(select 1 from public.balances where user_id between v_user and v_user+5)
      and not exists(select 1 from public.promo_redemptions where user_id between v_user and v_user+5)
      and not exists(select 1 from public.account_activity where user_id between v_user and v_user+5);
  end loop;
  v_duplicate_user:=v_user+1;
  v_repair_user:=v_user+2;
  v_fail_user:=v_user+3;
  v_overflow_user:=v_user+4;
  v_exhaust_user:=v_user+5;
  update public.promo_codes set max_uses=null
    where code='__task_channel_lordeuso';
  select coalesce(uses_count,0) into v_uses from public.promo_codes
    where code='__task_channel_lordeuso' for update;
  if not found then raise exception 'task promo configuration missing'; end if;

  v_result:=public.account_claim_channel_task(v_user);
  if v_result->>'applied' is distinct from 'true'
    or v_result->>'alreadyClaimed' is distinct from 'false'
    or v_result->>'claimed' is distinct from 'true'
    or (v_result->>'reward')::integer is distinct from 10
    or (v_result->>'balance')::integer is distinct from 25
    or (select balance from public.balances where user_id=v_user) is distinct from 25
    or (select count(*) from public.promo_redemptions where user_id=v_user and code='__task_channel_lordeuso') is distinct from 1::bigint
    or (select count(*) from public.account_activity where user_id=v_user and event_type='reward' and delta=10) is distinct from 1::bigint
    or (select uses_count from public.promo_codes where code='__task_channel_lordeuso') is distinct from v_uses+1 then
    raise exception 'first channel claim did not atomically apply expected reward';
  end if;
  v_result:=public.account_claim_channel_task(v_user);
  if v_result->>'applied' is distinct from 'false'
    or v_result->>'alreadyClaimed' is distinct from 'true'
    or v_result->>'claimed' is distinct from 'true'
    or (v_result->>'balance')::integer is distinct from 25
    or (select count(*) from public.account_activity where user_id=v_user) is distinct from 1::bigint
    or (select uses_count from public.promo_codes where code='__task_channel_lordeuso') is distinct from v_uses+1 then
    raise exception 'retry or duplicate channel claim rewarded twice';
  end if;

  -- Legacy reservations are authoritative even without historic journal data.
  insert into public.balances(user_id,balance) values(v_duplicate_user,18);
  insert into public.promo_redemptions(user_id,code)
    values(v_duplicate_user,'__task_channel_lordeuso');
  v_result:=public.account_claim_channel_task(v_duplicate_user);
  if v_result->>'alreadyClaimed' is distinct from 'true'
    or (v_result->>'balance')::integer is distinct from 18
    or exists(select 1 from public.account_activity where user_id=v_duplicate_user)
    or (select uses_count from public.promo_codes where code='__task_channel_lordeuso') is distinct from v_uses+1 then
    raise exception 'legacy claim issued another reward';
  end if;

  -- Simulate old HTTP credit committed but DELETE compensation lost the claim.
  insert into public.balances(user_id,balance) values(v_repair_user,25);
  insert into public.account_activity(user_id,event_type,delta,balance_after,description,metadata)
    values(v_repair_user,'reward',10,25,'Legacy channel task',
      '{"source":"channel_task","channel":"@Lordeuso"}'::jsonb);
  v_result:=public.account_claim_channel_task(v_repair_user);
  if v_result->>'alreadyClaimed' is distinct from 'true'
    or v_result->>'applied' is distinct from 'false'
    or (v_result->>'balance')::integer is distinct from 25
    or not exists(select 1 from public.promo_redemptions where user_id=v_repair_user and code='__task_channel_lordeuso')
    or (select count(*) from public.account_activity where user_id=v_repair_user) is distinct from 1::bigint then
    raise exception 'ambiguous legacy commit was credited again or not repaired';
  end if;
  select uses_count into v_uses from public.promo_codes where code='__task_channel_lordeuso';

  -- Force journal failure with an unrelated operation-key collision. No global
  -- trigger/function is installed. A PL/pgSQL exception block is a savepoint.
  insert into public.balances(user_id,balance) values(v_fail_user,15);
  insert into public.account_activity(user_id,event_type,delta,balance_after,description,metadata,operation_key)
    values(v_fail_user,'adjustment',0,15,'Fixture collision','{}'::jsonb,
      'channel_task:lordeuso:'||v_fail_user::text);
  v_failed:=false;
  begin
    perform public.account_claim_channel_task(v_fail_user);
  exception when unique_violation then v_failed:=true;
  end;
  if not v_failed
    or (select balance from public.balances where user_id=v_fail_user) is distinct from 15
    or exists(select 1 from public.promo_redemptions where user_id=v_fail_user and code='__task_channel_lordeuso')
    or (select count(*) from public.account_activity where user_id=v_fail_user) is distinct from 1::bigint
    or (select uses_count from public.promo_codes where code='__task_channel_lordeuso') is distinct from v_uses then
    raise exception 'journal failure did not roll claim/balance/quota back together';
  end if;

  insert into public.balances(user_id,balance) values(v_overflow_user,2147483647);
  v_failed:=false;
  begin
    perform public.account_claim_channel_task(v_overflow_user);
  exception when numeric_value_out_of_range then v_failed:=true;
  end;
  if not v_failed
    or exists(select 1 from public.promo_redemptions where user_id=v_overflow_user and code='__task_channel_lordeuso')
    or (select uses_count from public.promo_codes where code='__task_channel_lordeuso') is distinct from v_uses then
    raise exception 'balance overflow failed to roll claim/quota back';
  end if;

  update public.promo_codes set max_uses=v_uses where code='__task_channel_lordeuso';
  v_result:=public.account_claim_channel_task(v_exhaust_user);
  if v_result->>'code' is distinct from 'TASK_REWARD_EXHAUSTED'
    or v_result->>'applied' is distinct from 'false'
    or v_result->>'claimed' is distinct from 'false'
    or exists(select 1 from public.promo_redemptions where user_id=v_exhaust_user and code='__task_channel_lordeuso')
    or (select balance from public.balances where user_id=v_exhaust_user) is distinct from 15 then
    raise exception 'configured task quota was bypassed';
  end if;
  v_result:=public.account_claim_channel_task(v_user);
  if v_result->>'alreadyClaimed' is distinct from 'true'
    or v_result->>'claimed' is distinct from 'true' then
    raise exception 'existing claim ceased being claimed after quota exhaustion';
  end if;

  v_failed:=false;
  begin
    perform public.account_claim_channel_task(null);
  exception when invalid_parameter_value then v_failed:=true;
  end;
  if not v_failed then raise exception 'invalid channel claim user accepted'; end if;
end;
$$;

rollback;
