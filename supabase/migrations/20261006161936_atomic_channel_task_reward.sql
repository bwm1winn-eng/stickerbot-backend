-- Additive deployment prerequisite for /api/tasks/channel/claim.
-- Server-only RPC: call ONLY after Telegram definitely confirms membership.
-- The transaction atomically records the one-time claim, credits 10 coins,
-- updates any configured task quota, and writes history. Never compensate an
-- ambiguous HTTP response by deleting a claim: retry this RPC instead.

begin;

-- The old task implementation created redemptions without a promo_codes row.
-- Seed an unlimited task configuration and count historical claims once.
-- Preserve an existing owner's amount/quota configuration if already present;
-- this task's reward remains fixed at 10 independently of promo amount.
insert into public.promo_codes(code,amount,max_uses,uses_count)
  select '__task_channel_lordeuso',10,null,count(*)::integer
  from public.promo_redemptions where code='__task_channel_lordeuso'
on conflict(code) do nothing;

create or replace function public.account_claim_channel_task(p_user_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance integer;
  v_next bigint;
  v_promo public.promo_codes%rowtype;
  v_previously_credited boolean;
  v_claim_code constant text := '__task_channel_lordeuso';
  v_operation_key text;
begin
  if p_user_id is null or p_user_id<=0 then
    raise exception using errcode='22023',message='invalid channel task user';
  end if;
  v_operation_key := 'channel_task:lordeuso:' || p_user_id::text;

  -- Keep the same balance-first lock order as all other accounting RPCs.
  -- This row lock serializes two simultaneous claims for the same account.
  insert into public.balances(user_id,balance)
    values(p_user_id,15) on conflict(user_id) do nothing;
  select coalesce(balance,15) into v_balance
    from public.balances where user_id=p_user_id for update;

  perform 1 from public.promo_redemptions
    where user_id=p_user_id and code=v_claim_code for update;
  if found then
    return jsonb_build_object(
      'applied',false,'alreadyClaimed',true,'claimed',true,
      'balance',v_balance,'reward',10
    );
  end if;

  -- Old code deleted a claim if the credit HTTP response was lost. The ledger
  -- can prove that the reward already committed; repair the claim without
  -- granting a second reward. Existing legacy claims remain authoritative even
  -- if their historic journal entry is unavailable.
  select exists(
    select 1 from public.account_activity
    where user_id=p_user_id and event_type='reward' and delta=10
      and metadata->>'source'='channel_task'
      and (
        lower(metadata->>'channel')='@lordeuso'
        or metadata->>'claimCode'=v_claim_code
      )
  ) into v_previously_credited;

  -- Serializes the cross-account quota check and uses_count increment.
  select * into v_promo from public.promo_codes
    where code=v_claim_code for update;
  if not found then
    return jsonb_build_object(
      'applied',false,'alreadyClaimed',false,'claimed',false,
      'code','TASK_REWARD_UNAVAILABLE','balance',v_balance,'reward',10
    );
  end if;
  if not v_previously_credited and v_promo.max_uses is not null
    and coalesce(v_promo.uses_count,0)>=v_promo.max_uses then
    return jsonb_build_object(
      'applied',false,'alreadyClaimed',false,'claimed',false,
      'code','TASK_REWARD_EXHAUSTED','balance',v_balance,'reward',10
    );
  end if;

  insert into public.promo_redemptions(user_id,code)
    values(p_user_id,v_claim_code) on conflict(user_id,code) do nothing;
  if not found then
    return jsonb_build_object(
      'applied',false,'alreadyClaimed',true,'claimed',true,
      'balance',v_balance,'reward',10
    );
  end if;
  update public.promo_codes set uses_count=coalesce(uses_count,0)+1
    where code=v_claim_code;

  if v_previously_credited then
    return jsonb_build_object(
      'applied',false,'alreadyClaimed',true,'claimed',true,
      'balance',v_balance,'reward',10
    );
  end if;

  v_next := v_balance::bigint+10;
  if v_next>2147483647 then
    raise exception using errcode='22003',message='balance exceeds integer range';
  end if;
  update public.balances set balance=v_next::integer where user_id=p_user_id;
  insert into public.account_activity(
    user_id,event_type,delta,balance_after,description,metadata,operation_key
  ) values(
    p_user_id,'reward',10,v_next::integer,'Channel subscription task',
    jsonb_build_object(
      'source','channel_task','channel','@Lordeuso','claimCode',v_claim_code
    ),v_operation_key
  );
  return jsonb_build_object(
    'applied',true,'alreadyClaimed',false,'claimed',true,
    'balance',v_next::integer,'reward',10
  );
end;
$$;

revoke execute on function public.account_claim_channel_task(bigint)
  from public,anon,authenticated;
grant execute on function public.account_claim_channel_task(bigint) to service_role;

notify pgrst,'reload schema';
commit;
