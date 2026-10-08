-- Variable-size emotion collections. Access remains restricted to service_role.
alter table public.creator_jobs
  add column total integer not null default 24 check(total between 2 and 36),
  add column unit_price integer not null default 2 check(unit_price between 2 and 5),
  add column quota_day date,
  add column reserved_slots text[] not null default '{}';
alter table public.creator_jobs drop constraint creator_jobs_cost_check;
alter table public.creator_jobs drop constraint creator_jobs_attempted_check;
alter table public.creator_jobs
  add constraint creator_jobs_cost_check check(cost=total*unit_price),
  add constraint creator_jobs_attempted_check check(attempted between 0 and total),
  add constraint creator_jobs_images_check check(jsonb_typeof(images)='array' and jsonb_array_length(images)<=total);

-- Creating another invitation keeps previously shared links usable.
drop index public.sticker_pack_invites_active;
create index sticker_pack_invites_active on public.sticker_pack_invites(pack_short_name,created_at desc) where revoked_at is null;
create function public.creator_invite_create_v2(p_user_id bigint,p_pack text,p_hash text,p_rotate boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_owner bigint;
begin
  select user_id into v_owner from public.sticker_packs where short_name=p_pack for update;
  if v_owner is distinct from p_user_id then raise exception 'pack not owned' using errcode='42501'; end if;
  if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid invite hash' using errcode='22023'; end if;
  if p_rotate is true then
    update public.sticker_pack_invites set revoked_at=now() where pack_short_name=p_pack and revoked_at is null;
  end if;
  if (select count(*) from public.sticker_pack_invites where pack_short_name=p_pack and revoked_at is null and expires_at>now())>=20 then
    raise exception 'invite limit' using errcode='P0001';
  end if;
  insert into public.sticker_pack_invites(token_hash,pack_short_name,expires_at) values(p_hash,p_pack,now()+interval '7 days');
  return jsonb_build_object('expiresAt',now()+interval '7 days','maxUses',20);
end $$;
create or replace function public.creator_invite_create(p_user_id bigint,p_pack text,p_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  return public.creator_invite_create_v2(p_user_id,p_pack,p_hash,false);
end $$;

create or replace function public.creator_job_start(p_user_id bigint,p_id uuid,p_payload jsonb,p_expected_cost integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_balance integer; v_job public.creator_jobs; v_tier text; v_cap integer; v_unit integer;
  v_count integer; v_cost integer; v_day date := (now() at time zone 'UTC')::date;
  v_code text; v_slots text[] := '{}'; v_slot integer; v_claimed integer;
  v_owner boolean := coalesce(p_payload->>'owner','false')='true';
begin
  if p_user_id is null or p_user_id<=0 or p_id is null or p_payload is null then raise exception 'invalid job request' using errcode='22023'; end if;
  if p_payload ? 'count' and (jsonb_typeof(p_payload->'count')<>'number' or (p_payload->>'count') !~ '^[0-9]+$') then
    raise exception 'invalid count' using errcode='22023';
  end if;
  v_count := coalesce((p_payload->>'count')::integer,24);
  if v_count not between 2 and 36 then raise exception 'emotion count limit' using errcode='22023'; end if;
  insert into public.balances(user_id,balance) values(p_user_id,15) on conflict(user_id) do nothing;
  select coalesce(balance,0) into v_balance from public.balances where user_id=p_user_id for update;
  select * into v_job from public.creator_jobs where id=p_id for update;
  if found then
    if v_job.user_id<>p_user_id or v_job.total<>v_count or (v_job.payload-'count'-'owner')<>(p_payload-'count'-'owner') then
      raise exception 'request reused' using errcode='22023';
    end if;
    return jsonb_build_object('id',v_job.id,'state',v_job.state,'balance',v_balance,'cost',v_job.cost,'total',v_job.total);
  end if;
  if exists(select 1 from public.app_user_moderation where user_id=p_user_id and banned) then raise exception 'account banned' using errcode='42501'; end if;
  select tier into v_tier from public.subscriptions where user_id=p_user_id and active and expires_at>now() for update;
  v_cap := case v_tier when 'ultimate' then 36 when 'luxury' then 10 when 'standard' then 6 else 8 end;
  v_unit := case v_tier when 'ultimate' then 2 when 'luxury' then 3 when 'standard' then 4 else 5 end;
  if v_count>v_cap then raise exception 'emotion count limit' using errcode='22023'; end if;
  if coalesce(p_payload->>'style','vector')<>'vector' and coalesce(v_tier,'free') not in ('luxury','ultimate') then
    raise exception 'premium style required' using errcode='42501';
  end if;
  v_cost := v_count*v_unit;
  if p_expected_cost is distinct from v_cost then raise exception 'price changed' using errcode='22023'; end if;
  if exists(select 1 from public.creator_jobs where user_id=p_user_id and state in ('queued','running')) then raise exception 'job already active' using errcode='P0001'; end if;
  -- Serialize admission across accounts without holding job-row locks first.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('creator:queue:admission',0));
  if (select count(*) from public.creator_jobs where state in ('queued','running'))>=20 then raise exception 'queue full' using errcode='P0001'; end if;
  if v_balance<v_cost then raise exception 'insufficient balance' using errcode='P0001'; end if;
  if coalesce(v_tier,'free') not in ('standard','luxury','ultimate') and not v_owner then
    insert into public.promo_redemptions(user_id,code) values(p_user_id,'__free_emotions_'||v_day)
      on conflict(user_id,code) do nothing;
    get diagnostics v_claimed=row_count;
    if v_claimed=0 then raise exception 'free emotion limit' using errcode='P0001'; end if;
    for v_slot in 1..8 loop
      v_code := '__free_image_'||v_day||'_'||v_slot;
      insert into public.promo_redemptions(user_id,code) values(p_user_id,v_code) on conflict(user_id,code) do nothing;
      get diagnostics v_claimed=row_count;
      if v_claimed=1 then v_slots:=array_append(v_slots,v_code); end if;
      exit when cardinality(v_slots)=v_count;
    end loop;
    if cardinality(v_slots)<>v_count then raise exception 'daily free limit' using errcode='P0001'; end if;
  end if;
  update public.balances set balance=v_balance-v_cost where user_id=p_user_id returning balance into v_balance;
  insert into public.creator_jobs(id,user_id,payload,cost,total,unit_price,quota_day,reserved_slots)
    values(p_id,p_user_id,p_payload,v_cost,v_count,v_unit,case when cardinality(v_slots)>0 then v_day end,v_slots);
  insert into public.account_activity(user_id,event_type,delta,balance_after,description,metadata,operation_key)
    values(p_user_id,'generation',-v_cost,v_balance,'Emotion sticker pack',jsonb_build_object('count',v_count,'costPerImage',v_unit,'jobId',p_id),'creator:debit:'||p_id);
  return jsonb_build_object('id',p_id,'state','queued','balance',v_balance,'cost',v_cost,'total',v_count);
end $$;

create or replace function public.creator_job_finish(p_id uuid,p_state text,p_pack_link text default null,p_pack_error text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v public.creator_jobs; v_refund integer; v_balance integer; v_user bigint; v_success integer;
begin
  select user_id into v_user from public.creator_jobs where id=p_id;
  if not found then raise exception 'job unavailable' using errcode='P0001'; end if;
  -- Same lock order as job admission, balances before jobs.
  select coalesce(balance,0) into v_balance from public.balances where user_id=v_user for update;
  select * into v from public.creator_jobs where id=p_id for update;
  if not found then raise exception 'job unavailable' using errcode='P0001'; end if;
  if v.state not in ('queued','running') then return jsonb_build_object('state',v.state,'balance',v_balance,'refund',0); end if;
  if p_state is null or p_state not in ('completed','interrupted','cancelled') then raise exception 'invalid job state' using errcode='22023'; end if;
  if p_state='cancelled' and v.state='running' then raise exception 'job already running' using errcode='P0001'; end if;
  v_success := jsonb_array_length(v.images);
  v_refund := greatest(0,v.cost-v_success*v.unit_price);
  if v_refund>0 then
    update public.balances set balance=v_balance+v_refund where user_id=v.user_id returning balance into v_balance;
    insert into public.account_activity(user_id,event_type,delta,balance_after,description,metadata,operation_key)
      values(v.user_id,'refund',v_refund,v_balance,'Uncreated stickers refunded',jsonb_build_object('jobId',p_id),'creator:refund:'||p_id);
  end if;
  if v.quota_day is not null then
    delete from public.promo_redemptions where user_id=v.user_id and code=any(v.reserved_slots[(v_success+1):cardinality(v.reserved_slots)]);
    if v_success=0 then delete from public.promo_redemptions where user_id=v.user_id and code='__free_emotions_'||v.quota_day; end if;
  end if;
  update public.creator_jobs set state=p_state,finished_at=now(),pack_link=p_pack_link,pack_error=p_pack_error,lease_until=null where id=p_id;
  return jsonb_build_object('state',p_state,'balance',v_balance,'refund',v_refund);
end $$;

-- Recheck expiry after acquiring locks: another worker may have renewed the lease.
create function public.creator_job_expire(p_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare v public.creator_jobs; v_user bigint;
begin
  select user_id into v_user from public.creator_jobs where id=p_id;
  if not found then return; end if;
  perform 1 from public.balances where user_id=v_user for update;
  select * into v from public.creator_jobs where id=p_id for update;
  if (v.state='running' and v.lease_until<now()) or (v.state='queued' and v.created_at<now()-interval '2 hours') then
    perform public.creator_job_finish(p_id,'interrupted');
  end if;
end $$;

create or replace function public.creator_job_claim()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v public.creator_jobs; v_old uuid;
begin
  -- Finish reacquires balances then jobs; selecting IDs must not pre-lock jobs.
  for v_old in select id from public.creator_jobs where (state='running' and lease_until<now()) or (state='queued' and created_at<now()-interval '2 hours') order by user_id,id loop
    perform public.creator_job_expire(v_old);
  end loop;
  select * into v from public.creator_jobs where state='queued' order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.creator_jobs set state='running',lease_until=now()+interval '3 minutes' where id=v.id;
  return to_jsonb(v);
end $$;

revoke execute on function public.creator_invite_create_v2(bigint,text,text,boolean) from public,anon,authenticated;
grant execute on function public.creator_invite_create_v2(bigint,text,text,boolean) to service_role;
revoke execute on function public.creator_job_expire(uuid) from public,anon,authenticated;
grant execute on function public.creator_job_expire(uuid) to service_role;
-- Existing functions retain their private grants after CREATE OR REPLACE.
