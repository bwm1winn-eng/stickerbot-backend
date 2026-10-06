-- Phase 2: apply ONLY after the quoted-price v2 backend is live and the new
-- frontend is published. The legacy function remains callable by service_role
-- for a harmless structured response, but can no longer buy at old prices.
-- Cached clients with no accepted price must refresh/reconfirm in the new UI.
-- Never restore old prices automatically or forward an unquoted call to v2.

begin;

create or replace function public.account_buy_coin_subscription(
  p_user_id bigint,
  p_tier text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_cost integer;
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
  return jsonb_build_object(
    'applied', false,
    'code', 'COIN_SUBSCRIPTION_PRICE_CHANGED',
    'cost', v_cost,
    'quoteRequired', true
  );
end;
$$;

revoke execute on function public.account_buy_coin_subscription(bigint, text)
  from public, anon, authenticated;
grant execute on function public.account_buy_coin_subscription(bigint, text)
  to service_role;

notify pgrst, 'reload schema';
commit;
