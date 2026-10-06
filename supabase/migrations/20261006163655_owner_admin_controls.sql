begin;
create table public.app_user_moderation (
 user_id bigint primary key, banned boolean not null default false,
 reason text not null default '', updated_at timestamptz not null default now()
);
create table public.app_admin_audit (
 request_key text primary key, actor_id bigint not null, target_id bigint not null,
 action text not null, payload jsonb not null, result jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.app_user_moderation enable row level security;
alter table public.app_admin_audit enable row level security;
revoke all on public.app_user_moderation,public.app_admin_audit from public,anon,authenticated;
grant all on public.app_user_moderation,public.app_admin_audit to service_role;

create function public.account_admin_action(p_actor bigint,p_target bigint,p_action text,
 p_request_key text,p_amount integer default null,p_tier text default null,
 p_days integer default null,p_reason text default '') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 v_balance integer; v_sub public.subscriptions%rowtype; v_old public.app_admin_audit%rowtype;
 v_payload jsonb; v_result jsonb; v_expiry timestamptz; v_delta integer:=0;
begin
 if p_actor is null or p_actor<=0 or p_target is null or p_target<=0
  or p_request_key is null or p_request_key !~ '^[A-Za-z0-9-]{16,64}$'
  or p_action is null or p_action not in ('set-balance','grant-plan','revoke-plan','ban','unban')
  or coalesce(length(p_reason),0)>300 then
  raise exception using errcode='22023',message='invalid admin action';
 end if;
 if p_action='ban' and p_actor=p_target then
  raise exception using errcode='22023',message='owner cannot ban themselves';
 end if;
 if p_action='set-balance' and (p_amount is null or p_amount<0) then
  raise exception using errcode='22023',message='invalid balance';
 end if;
 if p_action='grant-plan' and (p_tier is null or p_tier not in ('standard','luxury','ultimate')
  or p_days is null or p_days<1 or p_days>3650) then
  raise exception using errcode='22023',message='invalid plan grant';
 end if;
 v_payload:=jsonb_build_object('amount',p_amount,'tier',p_tier,'days',p_days,'reason',coalesce(p_reason,''));
 insert into public.balances(user_id,balance) values(p_target,15) on conflict(user_id) do nothing;
 select coalesce(balance,15) into v_balance from public.balances where user_id=p_target for update;
 select * into v_old from public.app_admin_audit where request_key=p_request_key;
 if found then
  if v_old.actor_id<>p_actor or v_old.target_id<>p_target or v_old.action<>p_action or v_old.payload<>v_payload then
   raise exception using errcode='22023',message='request key reused for a different action';
  end if;
  return v_old.result || jsonb_build_object('replayed',true);
 end if;
 if p_action='set-balance' then
  v_delta:=p_amount-v_balance;
  update public.balances set balance=p_amount where user_id=p_target;
  v_balance:=p_amount;
 elsif p_action in ('grant-plan','revoke-plan') then
  insert into public.subscriptions(user_id,active,first_purchase_done,tier,expires_at)
   values(p_target,false,false,null,null) on conflict(user_id) do nothing;
  select * into v_sub from public.subscriptions where user_id=p_target for update;
  if p_action='grant-plan' then
   v_expiry:=(case when v_sub.active and v_sub.tier=p_tier and v_sub.expires_at>now()
     then v_sub.expires_at else now() end)+make_interval(days=>p_days);
   update public.subscriptions set active=true,tier=p_tier,expires_at=v_expiry where user_id=p_target;
  else
   v_expiry:=now();
   update public.subscriptions set active=false,tier=null,expires_at=v_expiry where user_id=p_target;
  end if;
 else
  insert into public.app_user_moderation(user_id,banned,reason,updated_at)
   values(p_target,p_action='ban',coalesce(p_reason,''),now())
   on conflict(user_id) do update set banned=excluded.banned,reason=excluded.reason,updated_at=excluded.updated_at;
 end if;
 insert into public.account_activity(user_id,event_type,delta,balance_after,description,metadata,operation_key)
  values(p_target,case when p_action in ('grant-plan','revoke-plan') then 'subscription' else 'adjustment' end,
   v_delta,v_balance,'Admin: '||p_action,jsonb_build_object('source','admin','action',p_action,'tier',p_tier,'days',p_days),
   'admin:'||p_request_key);
 v_result:=jsonb_build_object('ok',true,'targetUserId',p_target,'action',p_action,'balance',v_balance,'expiresAt',v_expiry,'replayed',false);
 insert into public.app_admin_audit(request_key,actor_id,target_id,action,payload,result)
  values(p_request_key,p_actor,p_target,p_action,v_payload,v_result);
 return v_result;
end;
$$;
revoke execute on function public.account_admin_action(bigint,bigint,text,text,integer,text,integer,text) from public,anon,authenticated;
grant execute on function public.account_admin_action(bigint,bigint,text,text,integer,text,integer,text) to service_role;
notify pgrst,'reload schema';
commit;
