-- Phase 1: apply before deploying the quoted-price backend.
-- This additive migration preserves account_buy_coin_subscription(bigint,text),
-- so the old backend still honors its old 580/1580/7000 quotes during rollout.
-- New backend contract:
--   RPC account_buy_coin_subscription_v2
--   { p_user_id, p_tier, p_expected_price: 640 | 1980 | 8760 }
-- Pass the amount explicitly accepted by the user; never substitute a new price
-- for a missing/stale browser quote. A mismatch does not create account rows,
-- deduct coins, change a subscription, or write an activity event.
-- Apply the separate retire_unquoted_coin_subscriptions migration ONLY AFTER
-- the new backend is live and the new frontend is published.

begin;

create or replace function public.account_buy_coin_subscription_v2(
  p_user_id bigint,
  p_tier text,
  p_expected_price integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_cost integer;
  v_balance integer;
  v_sub public.subscriptions%rowtype;
  v_now timestamptz;
  v_expires timestamptz;
begin
  if p_user_id is null or p_user_id <= 0 then
    raise exception 'invalid user';
  end if;
  v_cost := case p_tier
    when 'standard' then 640
    when 'luxury' then 1980
    when 'ultimate' then 8760
  end;
  if v_cost is null then
    raise exception 'unknown subscription tier';
  end if;

  if p_expected_price is distinct from v_cost then
    return jsonb_build_object(
      'applied', false,
      'code', 'COIN_SUBSCRIPTION_PRICE_CHANGED',
      'cost', v_cost,
      'quoteRequired', true
    );
  end if;

  -- Match the existing accounting lock order: balance, then subscription.
  insert into public.balances(user_id, balance)
    values(p_user_id, 15) on conflict(user_id) do nothing;
  select balance into v_balance
    from public.balances where user_id = p_user_id for update;
  v_balance := coalesce(v_balance, 0);

  insert into public.subscriptions(user_id, active, first_purchase_done)
    values(p_user_id, false, false) on conflict(user_id) do nothing;
  select * into v_sub
    from public.subscriptions where user_id = p_user_id for update;
  v_now := clock_timestamp();

  if v_sub.last_coin_purchase_at is not null
    and public.account_coin_subscription_next_date(v_sub.last_coin_purchase_at) > v_now then
    return jsonb_build_object(
      'applied', false,
      'code', 'COIN_SUBSCRIPTION_COOLDOWN',
      'nextAvailableAt', public.account_coin_subscription_next_date(v_sub.last_coin_purchase_at)
    );
  end if;
  if v_balance < v_cost then
    return jsonb_build_object(
      'applied', false,
      'code', 'INSUFFICIENT_BALANCE',
      'balance', v_balance,
      'cost', v_cost
    );
  end if;

  v_expires := case
    when v_sub.active and v_sub.tier = p_tier and v_sub.expires_at > v_now
      then v_sub.expires_at
    else v_now
  end + interval '30 days';

  update public.balances set balance = v_balance - v_cost
    where user_id = p_user_id returning balance into v_balance;
  update public.subscriptions
    set active = true, tier = p_tier, expires_at = v_expires,
      first_purchase_done = true, last_coin_purchase_at = v_now
    where user_id = p_user_id;
  insert into public.account_activity(
    user_id, event_type, delta, balance_after, description, metadata
  ) values(
    p_user_id, 'subscription', -v_cost, v_balance,
    'Premium subscription purchased with coins',
    jsonb_build_object(
      'tier', p_tier,
      'paymentMethod', 'coins',
      'coins', v_cost,
      'pricingVersion', 2,
      'durationDays', 30,
      'expiresAt', v_expires
    )
  );
  return jsonb_build_object(
    'applied', true, 'active', true, 'tier', p_tier,
    'balance', v_balance, 'cost', v_cost,
    'expiresAt', v_expires,
    'nextAvailableAt', public.account_coin_subscription_next_date(v_now)
  );
end;
$$;

revoke execute on function public.account_buy_coin_subscription_v2(bigint, text, integer)
  from public, anon, authenticated;
grant execute on function public.account_buy_coin_subscription_v2(bigint, text, integer)
  to service_role;

notify pgrst, 'reload schema';
commit;
