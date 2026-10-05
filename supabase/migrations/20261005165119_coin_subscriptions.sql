begin;
alter table public.subscriptions add column if not exists last_coin_purchase_at timestamptz;
create or replace function public.account_coin_subscription_next_date(p_last_purchase timestamptz)
returns timestamptz language sql stable security invoker set search_path = '' set timezone = 'UTC'
as $$ select p_last_purchase + interval '3 months' $$;
revoke execute on function public.account_coin_subscription_next_date(timestamptz) from public, anon, authenticated;
grant execute on function public.account_coin_subscription_next_date(timestamptz) to service_role;
create or replace function public.account_buy_coin_subscription(p_user_id bigint, p_tier text)
returns jsonb language plpgsql security invoker set search_path = '' set timezone = 'UTC'
as $$
declare
  v_cost integer;
  v_balance integer;
  v_sub public.subscriptions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_expires timestamptz;
begin
  if p_user_id is null or p_user_id <= 0 then raise exception 'invalid user'; end if;
  v_cost := case p_tier when 'standard' then 580 when 'luxury' then 1580 when 'ultimate' then 7000 end;
  if v_cost is null then raise exception 'unknown subscription tier'; end if;
  insert into public.balances(user_id, balance) values(p_user_id, 15) on conflict(user_id) do nothing;
  select balance into v_balance from public.balances where user_id = p_user_id for update;
  insert into public.subscriptions(user_id, active, first_purchase_done) values(p_user_id, false, false) on conflict(user_id) do nothing;
  select * into v_sub from public.subscriptions where user_id = p_user_id for update;
  if v_sub.last_coin_purchase_at is not null and v_sub.last_coin_purchase_at + interval '3 months' > v_now then
    return jsonb_build_object('applied', false, 'code', 'COIN_SUBSCRIPTION_COOLDOWN', 'nextAvailableAt', v_sub.last_coin_purchase_at + interval '3 months');
  end if;
  if v_balance < v_cost then
    return jsonb_build_object('applied', false, 'code', 'INSUFFICIENT_BALANCE', 'balance', v_balance, 'cost', v_cost);
  end if;
  v_expires := case when v_sub.active and v_sub.tier = p_tier and v_sub.expires_at > v_now then v_sub.expires_at else v_now end + interval '30 days';
  update public.balances set balance = balance - v_cost where user_id = p_user_id returning balance into v_balance;
  update public.subscriptions set active = true, tier = p_tier, expires_at = v_expires,
    first_purchase_done = true, last_coin_purchase_at = v_now where user_id = p_user_id;
  insert into public.account_activity(user_id, event_type, delta, balance_after, description, metadata)
    values(p_user_id, 'subscription', -v_cost, v_balance, 'Premium subscription purchased with coins',
      jsonb_build_object('tier', p_tier, 'paymentMethod', 'coins', 'coins', v_cost, 'durationDays', 30, 'expiresAt', v_expires));
  return jsonb_build_object('applied', true, 'active', true, 'tier', p_tier, 'balance', v_balance,
    'expiresAt', v_expires, 'nextAvailableAt', v_now + interval '3 months');
end;
$$;
revoke execute on function public.account_buy_coin_subscription(bigint, text) from public, anon, authenticated;
grant execute on function public.account_buy_coin_subscription(bigint, text) to service_role;
notify pgrst, 'reload schema';
commit;