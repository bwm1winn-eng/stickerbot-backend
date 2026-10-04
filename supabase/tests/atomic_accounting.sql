-- Run after the migration. Fixtures and history are rolled back automatically.
-- Sequential cases verify contracts; use separate sessions for concurrency below.
begin;
set local role service_role;

do $$
declare
  v_user bigint := 9223372036854775000;
  v_result jsonb;
  v_expiry timestamptz;
  v_balance integer;
  v_count integer;
begin
  if exists (select 1 from public.balances where user_id = v_user)
    or exists (select 1 from public.subscriptions where user_id = v_user)
    or exists (select 1 from public.account_activity where user_id = v_user) then
    raise exception 'Accounting test fixture already exists; choose another fixture ID';
  end if;
  if has_function_privilege('anon', 'public.account_adjust_balance(bigint,integer,text,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.account_adjust_balance(bigint,integer,text,text,jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.account_apply_daily_bonus(bigint,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.account_apply_daily_bonus(bigint,jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.account_apply_payment(bigint,text,text,integer,text,integer,integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.account_apply_payment(bigint,text,text,integer,text,integer,integer)', 'EXECUTE') then
    raise exception 'An accounting RPC is executable by a browser role';
  end if;
  if has_table_privilege('anon', 'public.account_activity', 'INSERT')
    or has_table_privilege('authenticated', 'public.account_activity', 'INSERT')
    or has_table_privilege('anon', 'public.account_activity', 'UPDATE')
    or has_table_privilege('authenticated', 'public.account_activity', 'UPDATE') then
    raise exception 'A browser role can poison the payment ledger';
  end if;

  v_balance := public.account_adjust_balance(v_user, -10, 'spend', 'Atomic accounting test debit');
  if v_balance <> 5 then raise exception 'First debit returned %', v_balance; end if;
  begin
    perform public.account_adjust_balance(v_user, -10, 'spend', 'Atomic accounting rejected test debit');
    raise exception 'Insufficient funds debit unexpectedly succeeded';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'insufficient balance' then raise; end if;
  end;
  select balance into v_balance from public.balances where user_id = v_user;
  select count(*) into v_count from public.account_activity where user_id = v_user;
  if v_balance <> 5 or v_count <> 1 then raise exception 'Rejected debit changed state/history'; end if;

  -- Existing event_type CHECK rejects this history insert after the balance UPDATE.
  -- The RPC transaction must roll back that UPDATE as well as the failed history.
  begin
    perform public.account_adjust_balance(v_user, 20, '__invalid_accounting_test_event');
    raise exception 'Invalid history event unexpectedly succeeded';
  exception when check_violation then null;
  end;
  select balance into v_balance from public.balances where user_id = v_user;
  select count(*) into v_count from public.account_activity where user_id = v_user;
  if v_balance <> 5 or v_count <> 1 then raise exception 'History failure did not roll back balance'; end if;

  v_result := public.account_apply_payment(v_user, 'atomic-test-topup', 'balance', 100, null, 12);
  if v_result ->> 'applied' <> 'true' or (v_result ->> 'balance')::integer <> 105 then
    raise exception 'Topup failed: %', v_result;
  end if;
  v_result := public.account_apply_payment(v_user, 'atomic-test-topup', 'balance', 100, null, 12);
  if v_result ->> 'applied' <> 'false' then raise exception 'Topup replay was applied'; end if;
  begin
    perform public.account_apply_payment(v_user, 'atomic-test-topup', 'balance', 101, null, 12);
    raise exception 'Conflicting charge replay unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
  select count(*) into v_count from public.account_activity
    where operation_key = 'telegram_payment:atomic-test-topup';
  if v_count <> 1 then raise exception 'Topup replay duplicated history'; end if;

  v_result := public.account_apply_payment(v_user, 'atomic-test-standard-a', 'subscription', null, 'standard', 19);
  v_expiry := (v_result ->> 'expiresAt')::timestamptz;
  if v_expiry <> now() + interval '720 hours' then raise exception 'First subscription expiry is wrong'; end if;
  v_result := public.account_apply_payment(v_user, 'atomic-test-standard-a', 'subscription', null, 'standard', 19);
  if v_result ->> 'applied' <> 'false' then raise exception 'Subscription replay was applied'; end if;
  v_result := public.account_apply_payment(v_user, 'atomic-test-standard-b', 'subscription', null, 'standard', 29);
  if (v_result ->> 'expiresAt')::timestamptz <> v_expiry + interval '720 hours' then
    raise exception 'Same-tier renewal failed to extend the existing subscription';
  end if;
  v_result := public.account_apply_payment(v_user, 'atomic-test-luxury', 'subscription', null, 'luxury', 52);
  if (v_result ->> 'expiresAt')::timestamptz <> now() + interval '720 hours' then
    raise exception 'Tier switch failed to start from now';
  end if;
  if public.account_apply_daily_bonus(v_user) <> 8 then raise exception 'Luxury bonus not applied'; end if;
  if public.account_apply_daily_bonus(v_user) <> 0 then raise exception 'Daily bonus replay applied'; end if;
  select balance into v_balance from public.balances where user_id = v_user;
  select count(*) into v_count from public.account_activity
    where user_id = v_user and metadata ->> 'source' = 'subscription_daily_bonus';
  if v_balance <> 113 or v_count <> 1 then raise exception 'Daily bonus duplicated state/history'; end if;

  begin
    perform public.account_adjust_balance(v_user, null);
    raise exception 'NULL delta unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.account_apply_payment(v_user, 'atomic-test-null-type', null, 100, null, 12);
    raise exception 'NULL payment type unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
  update public.subscriptions set last_bonus_date = null where user_id = v_user;
  begin
    perform public.account_apply_daily_bonus(v_user, '{"luxury":null}'::jsonb);
    raise exception 'NULL bonus configuration unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
  select balance into v_balance from public.balances where user_id = v_user;
  if v_balance <> 113 then raise exception 'Invalid arguments changed the balance'; end if;
  raise notice 'Accounting contract, grants, replay, subscription and bonus cases passed';
end;
$$;
rollback;

-- Parallel verification (parent runner uses independent DB sessions):
-- 1. Seed another unused fixture with balance15 and an active Standard subscription.
-- 2. Run two account_adjust_balance(fixture,-10) calls simultaneously:
--    exactly one succeeds; final balance5; exactly one -10 history event.
-- 3. Run two account_apply_daily_bonus(fixture) calls simultaneously:
--    results are3 and0; balance increases3; one bonus history event.
-- 4. Run two identical account_apply_payment charge calls simultaneously:
--    results applied=true/false; balance/expiry changes once; one history event.
-- 5. Run two different same-tier subscription charges simultaneously:
--    final expiry extends60 days; two subscription events.
-- 6. Run mixed adjustment/topup/bonus calls: final balance equals the sum of
--    successful deltas, with one history entry per successful mutation.
-- 7. In an isolated DB only, install a fixture-scoped BEFORE INSERT history trigger
--    that raises an error. Every RPC must roll back its balance/subscription/date
--    changes. Remove the trigger, retry the same charge, and observe one grant.
-- 8. Remove only the test fixture rows/history once parallel checks finish.

