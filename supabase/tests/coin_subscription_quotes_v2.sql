-- Run after phase 1 is applied. Uses only generated synthetic account IDs,
-- rolls all fixture data back, sends no Telegram/Stars/AI requests.
-- The legacy assertion adapts to phase 1 (old quote honored) or phase 2
-- (old entry point safely rejects), allowing verification at both milestones.
-- Identity sequences may advance even though fixture rows are rolled back.
begin;
set local statement_timeout = '15s';
set local timezone = 'UTC';

do $$
declare
  v_user bigint;
  v_price integer;
  v_old_price integer;
  v_tier text;
  v_result jsonb;
  v_before integer;
  v_after integer;
  v_expiry timestamptz;
  v_stored_expiry timestamptz;
  v_journal integer;
  v_valid boolean;
begin
  if has_function_privilege('anon', 'public.account_buy_coin_subscription_v2(bigint,text,integer)', 'execute')
    or has_function_privilege('authenticated', 'public.account_buy_coin_subscription_v2(bigint,text,integer)', 'execute')
    or not has_function_privilege('service_role', 'public.account_buy_coin_subscription_v2(bigint,text,integer)', 'execute') then
    raise exception 'v2 RPC permissions are incorrect';
  end if;
  if has_function_privilege('anon', 'public.account_buy_coin_subscription(bigint,text)', 'execute')
    or has_function_privilege('authenticated', 'public.account_buy_coin_subscription(bigint,text)', 'execute') then
    raise exception 'legacy RPC unexpectedly exposed to clients';
  end if;
  if exists(
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='account_buy_coin_subscription_v2'
      and (p.prosecdef or not ('search_path=""'=any(p.proconfig)) or not ('TimeZone=UTC'=any(p.proconfig)))
  ) then
    raise exception 'v2 RPC security or timezone settings are incorrect';
  end if;
  if exists(
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('balances','subscriptions','account_activity')
      and not c.relrowsecurity
  ) then
    raise exception 'an accounting table does not enable RLS';
  end if;

  if public.account_coin_subscription_next_date('2026-01-31 18:30:00+00'::timestamptz)
    is distinct from '2026-04-30 18:30:00+00'::timestamptz then
    raise exception 'cooldown is not three calendar months';
  end if;

  foreach v_tier in array array['standard','luxury','ultimate'] loop
    v_price := case v_tier when 'standard' then 640 when 'luxury' then 1980 else 8760 end;
    v_old_price := case v_tier when 'standard' then 580 when 'luxury' then 1580 else 7000 end;
    loop
      -- Far outside Telegram's supported identifier range; never reuse a row.
      v_user := 9000000000000000000::bigint + floor(random()*1000000000)::bigint;
      exit when not exists(select 1 from public.balances where user_id=v_user)
        and not exists(select 1 from public.subscriptions where user_id=v_user)
        and not exists(select 1 from public.account_activity where user_id=v_user);
    end loop;

    v_result := public.account_buy_coin_subscription_v2(v_user,v_tier);
    if v_result->>'code' is distinct from 'COIN_SUBSCRIPTION_PRICE_CHANGED'
      or (v_result->>'cost')::integer is distinct from v_price
      or v_result->>'applied' is distinct from 'false' then
      raise exception 'missing quote was not safely rejected for %',v_tier;
    end if;
    v_result := public.account_buy_coin_subscription_v2(v_user,v_tier,v_old_price);
    if v_result->>'code' is distinct from 'COIN_SUBSCRIPTION_PRICE_CHANGED'
      or exists(select 1 from public.balances where user_id=v_user)
      or exists(select 1 from public.subscriptions where user_id=v_user)
      or exists(select 1 from public.account_activity where user_id=v_user) then
      raise exception 'stale quote mutated account for %',v_tier;
    end if;

    insert into public.balances(user_id,balance) values(v_user,v_price-1);
    v_result := public.account_buy_coin_subscription_v2(v_user,v_tier,v_price);
    if v_result->>'code' is distinct from 'INSUFFICIENT_BALANCE'
      or (v_result->>'balance')::integer is distinct from v_price-1
      or exists(select 1 from public.account_activity where user_id=v_user) then
      raise exception 'insufficient balance check failed for %',v_tier;
    end if;
    update public.balances set balance=null where user_id=v_user;
    v_result := public.account_buy_coin_subscription_v2(v_user,v_tier,v_price);
    if v_result->>'code' is distinct from 'INSUFFICIENT_BALANCE'
      or (v_result->>'balance')::integer is distinct from 0 then
      raise exception 'NULL balance bypasses payment for %',v_tier;
    end if;

    v_before := v_price*3;
    update public.balances set balance=v_before where user_id=v_user;
    v_expiry := clock_timestamp()+interval '8 days';
    update public.subscriptions
      set active=true,tier=v_tier,expires_at=v_expiry,last_coin_purchase_at=null
      where user_id=v_user;
    v_result := public.account_buy_coin_subscription_v2(v_user,v_tier,v_price);
    select balance into v_after from public.balances where user_id=v_user;
    select expires_at into v_stored_expiry from public.subscriptions where user_id=v_user;
    if v_result->>'applied' is distinct from 'true'
      or v_after is distinct from v_before-v_price
      or (v_result->>'cost')::integer is distinct from v_price
      or v_stored_expiry is distinct from v_expiry+interval '30 days' then
      raise exception 'successful renewal charged/extended incorrectly for %',v_tier;
    end if;
    select count(*) into v_journal from public.account_activity
      where user_id=v_user and event_type='subscription'
        and delta=-v_price and balance_after=v_after
        and metadata->>'pricingVersion'='2' and metadata->>'tier'=v_tier;
    if v_journal is distinct from 1 then
      raise exception 'subscription ledger missing or duplicated for %',v_tier;
    end if;

    v_result := public.account_buy_coin_subscription_v2(v_user,v_tier,v_price);
    if v_result->>'code' is distinct from 'COIN_SUBSCRIPTION_COOLDOWN'
      or (select balance from public.balances where user_id=v_user) is distinct from v_after
      or (select count(*) from public.account_activity where user_id=v_user) is distinct from 1::bigint then
      raise exception 'retry charged twice for %',v_tier;
    end if;
    v_result := public.account_buy_coin_subscription_v2(v_user,'standard',640);
    if v_result->>'code' is distinct from 'COIN_SUBSCRIPTION_COOLDOWN' then
      raise exception 'cooldown is not shared across tiers';
    end if;

    update public.subscriptions
      set last_coin_purchase_at=clock_timestamp()-interval '3 months 1 second'
      where user_id=v_user;
    v_result := public.account_buy_coin_subscription_v2(v_user,v_tier,v_price);
    if v_result->>'applied' is distinct from 'true'
      or (select balance from public.balances where user_id=v_user) is distinct from v_before-v_price*2 then
      raise exception 'elapsed calendar cooldown did not permit renewal for %',v_tier;
    end if;

    -- Verify whichever rollout phase currently owns the legacy entry point.
    update public.subscriptions set last_coin_purchase_at=null where user_id=v_user;
    v_before := (select balance from public.balances where user_id=v_user);
    v_result := public.account_buy_coin_subscription(v_user,v_tier);
    if v_result->>'code'='COIN_SUBSCRIPTION_PRICE_CHANGED' then
      if (v_result->>'cost')::integer is distinct from v_price
        or (select balance from public.balances where user_id=v_user) is distinct from v_before then
        raise exception 'retired legacy RPC changed balance for %',v_tier;
      end if;
    elsif v_result->>'applied'='true' then
      if (select balance from public.balances where user_id=v_user) is distinct from v_before-v_old_price then
        raise exception 'phase 1 legacy RPC stopped honoring old quote for %',v_tier;
      end if;
    else
      raise exception 'unexpected legacy rollout response for %',v_tier;
    end if;
  end loop;

  v_valid:=false;
  begin
    perform public.account_buy_coin_subscription_v2(null,'standard',640);
  exception when raise_exception then v_valid:=true;
  end;
  if not v_valid then raise exception 'invalid user was accepted'; end if;
  v_valid:=false;
  begin
    perform public.account_buy_coin_subscription_v2(v_user,'unknown',640);
  exception when raise_exception then v_valid:=true;
  end;
  if not v_valid then raise exception 'unknown tier was accepted'; end if;
end;
$$;

rollback;
