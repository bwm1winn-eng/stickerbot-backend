-- Backend accounting RPCs. Apply with a CLI-generated Supabase migration.
-- Every mutation locks balances before subscriptions and commits history with it.
-- Telegram charge IDs are globally unique; keep the ledger when rolling back code.

begin;

alter table public.account_activity add column if not exists operation_key text;
alter table public.account_activity enable row level security;
revoke all on public.account_activity from anon, authenticated;
create unique index if not exists account_activity_operation_key_uidx
  on public.account_activity (operation_key) where operation_key is not null;

create or replace function public.account_adjust_balance(
  p_user_id bigint,
  p_delta integer,
  p_event_type text default 'adjustment',
  p_description text default '',
  p_metadata jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
  v_next bigint;
begin
  if p_user_id is null or p_user_id <= 0 or p_delta is null then
    raise exception using errcode = '22023', message = 'invalid balance adjustment';
  end if;
  insert into public.balances (user_id, balance) values (p_user_id, 15)
    on conflict (user_id) do nothing;
  select coalesce(b.balance, 15) into v_balance
    from public.balances b where b.user_id = p_user_id for update;

  v_next := v_balance::bigint + p_delta::bigint;
  if v_next < 0 then
    raise exception using errcode = 'P0001', message = 'insufficient balance';
  end if;
  if v_next > 2147483647 then
    raise exception using errcode = '22003', message = 'balance exceeds integer range';
  end if;

  update public.balances set balance = v_next::integer where user_id = p_user_id;
  insert into public.account_activity
    (user_id, event_type, delta, balance_after, description, metadata)
  values
    (p_user_id, coalesce(nullif(p_event_type, ''), 'adjustment'), p_delta,
     v_next::integer, coalesce(p_description, ''), coalesce(p_metadata, '{}'::jsonb));
  return v_next::integer;
end;
$$;

create or replace function public.account_apply_daily_bonus(
  p_user_id bigint,
  p_bonus_by_tier jsonb default '{"standard":3,"luxury":8,"ultimate":35}'::jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
  v_sub public.subscriptions%rowtype;
  v_today date := (now() at time zone 'UTC')::date;
  v_bonus integer;
  v_next bigint;
begin
  if p_user_id is null or p_user_id <= 0 or p_bonus_by_tier is null
    or jsonb_typeof(p_bonus_by_tier) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid daily bonus request';
  end if;
  insert into public.balances (user_id, balance) values (p_user_id, 15)
    on conflict (user_id) do nothing;
  select coalesce(b.balance, 15) into v_balance
    from public.balances b where b.user_id = p_user_id for update;

  insert into public.subscriptions (user_id, active, first_purchase_done)
    values (p_user_id, false, false) on conflict (user_id) do nothing;
  select s.* into v_sub from public.subscriptions s
    where s.user_id = p_user_id for update;
  if v_sub.active is not true or v_sub.expires_at is null or v_sub.expires_at <= now()
    or v_sub.last_bonus_date >= v_today then
    return 0;
  end if;
  if v_sub.tier is null or not (p_bonus_by_tier ? v_sub.tier) then
    return 0;
  end if;
  if jsonb_typeof(p_bonus_by_tier -> v_sub.tier) is distinct from 'number'
    or not coalesce((p_bonus_by_tier ->> v_sub.tier) ~ '^[0-9]+$', false) then
    raise exception using errcode = '22023', message = 'invalid daily bonus amount';
  end if;
  v_bonus := (p_bonus_by_tier ->> v_sub.tier)::integer;
  if v_bonus = 0 then return 0; end if;
  v_next := v_balance::bigint + v_bonus::bigint;
  if v_next > 2147483647 then
    raise exception using errcode = '22003', message = 'balance exceeds integer range';
  end if;

  update public.balances set balance = v_next::integer where user_id = p_user_id;
  update public.subscriptions set last_bonus_date = v_today where user_id = p_user_id;
  insert into public.account_activity
    (user_id, event_type, delta, balance_after, description, metadata)
  values
    (p_user_id, 'reward', v_bonus, v_next::integer, 'Subscription daily coins',
     jsonb_build_object('source', 'subscription_daily_bonus', 'tier', v_sub.tier, 'day', v_today));
  return v_bonus;
end;
$$;

create or replace function public.account_apply_payment(
  p_user_id bigint,
  p_charge_id text,
  p_payment_type text,
  p_amount integer default null,
  p_tier text default null,
  p_stars integer default null,
  p_duration_days integer default 30
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
  v_next bigint;
  v_sub public.subscriptions%rowtype;
  v_existing public.account_activity%rowtype;
  v_key text;
  v_now timestamptz := now();
  v_expires_at timestamptz;
  v_metadata jsonb;
  v_constraint text;
begin
  if p_user_id is null or p_user_id <= 0 or p_charge_id is null or btrim(p_charge_id) = ''
    or p_payment_type is null or p_payment_type not in ('balance', 'subscription')
    or p_stars is null or p_stars <= 0 then
    raise exception using errcode = '22023', message = 'invalid Telegram payment';
  end if;
  if p_payment_type = 'balance' and (p_amount is null or p_amount <= 0 or p_tier is not null) then
    raise exception using errcode = '22023', message = 'invalid balance payment';
  end if;
  if p_payment_type = 'subscription' and (p_tier is null
    or p_tier not in ('standard', 'luxury', 'ultimate') or p_amount is not null
    or p_duration_days is null or p_duration_days < 1 or p_duration_days > 365) then
    raise exception using errcode = '22023', message = 'invalid subscription payment';
  end if;
  v_key := 'telegram_payment:' || p_charge_id;

  insert into public.balances (user_id, balance) values (p_user_id, 15)
    on conflict (user_id) do nothing;
  select coalesce(b.balance, 15) into v_balance
    from public.balances b where b.user_id = p_user_id for update;

  select a.* into v_existing from public.account_activity a where a.operation_key = v_key;
  if found then
    if v_existing.user_id <> p_user_id
      or (v_existing.metadata ->> 'paymentType') is distinct from p_payment_type
      or (v_existing.metadata ->> 'stars') is distinct from p_stars::text
      or (v_existing.metadata ->> 'coins') is distinct from p_amount::text
      or (v_existing.metadata ->> 'tier') is distinct from p_tier
      or (p_payment_type = 'subscription'
        and (v_existing.metadata ->> 'durationDays') is distinct from p_duration_days::text) then
      raise exception using errcode = '22023', message = 'payment charge already used with different details';
    end if;
    return jsonb_build_object('applied', false, 'balance', v_balance,
      'expiresAt', v_existing.metadata ->> 'expiresAt');
  end if;

  v_metadata := jsonb_build_object('paymentType', p_payment_type, 'chargeId', p_charge_id,
    'currency', 'XTR', 'stars', p_stars);
  if p_payment_type = 'balance' then
    v_next := v_balance::bigint + p_amount::bigint;
    if v_next > 2147483647 then
      raise exception using errcode = '22003', message = 'balance exceeds integer range';
    end if;
    update public.balances set balance = v_next::integer where user_id = p_user_id;
    v_balance := v_next::integer;
    v_metadata := v_metadata || jsonb_build_object('coins', p_amount);
    insert into public.account_activity
      (user_id, event_type, delta, balance_after, description, metadata, operation_key)
    values
      (p_user_id, 'topup', p_amount, v_balance, 'Coins purchased with Telegram Stars', v_metadata, v_key);
  else
    insert into public.subscriptions (user_id, active, first_purchase_done)
      values (p_user_id, false, false) on conflict (user_id) do nothing;
    select s.* into v_sub from public.subscriptions s
      where s.user_id = p_user_id for update;
    v_expires_at := case when v_sub.active is true and v_sub.tier = p_tier
      and v_sub.expires_at > v_now then v_sub.expires_at else v_now end
      + p_duration_days * interval '24 hours';
    update public.subscriptions set active = true, expires_at = v_expires_at,
      first_purchase_done = true, tier = p_tier where user_id = p_user_id;
    v_metadata := v_metadata || jsonb_build_object('tier', p_tier, 'expiresAt', v_expires_at,
      'durationDays', p_duration_days);
    insert into public.account_activity
      (user_id, event_type, delta, balance_after, description, metadata, operation_key)
    values
      (p_user_id, 'subscription', 0, v_balance, 'Premium subscription', v_metadata, v_key);
  end if;
  return jsonb_build_object('applied', true, 'balance', v_balance, 'expiresAt', v_expires_at);
exception when unique_violation then
  -- A charge replay with a different user can race the initial ledger lookup.
  -- This exception block rolls back the entire attempted grant before rejection.
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'account_activity_operation_key_uidx' then
    raise exception using errcode = '22023', message = 'payment charge already used with different details';
  end if;
  raise;
end;
$$;

revoke execute on function public.account_adjust_balance(bigint, integer, text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.account_apply_daily_bonus(bigint, jsonb)
  from public, anon, authenticated;
revoke execute on function public.account_apply_payment(bigint, text, text, integer, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.account_adjust_balance(bigint, integer, text, text, jsonb) to service_role;
grant execute on function public.account_apply_daily_bonus(bigint, jsonb) to service_role;
grant execute on function public.account_apply_payment(bigint, text, text, integer, text, integer, integer) to service_role;
grant select, insert, update on public.balances, public.subscriptions to service_role;
grant select, insert on public.account_activity to service_role;
do $$
declare v_sequence text := pg_get_serial_sequence('public.account_activity', 'id');
begin
  if v_sequence is not null then
    execute format('grant usage on sequence %s to service_role', v_sequence);
  end if;
end;
$$;

-- Event-trigger execution uses the owner; browser roles need no manual entrypoint.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;

