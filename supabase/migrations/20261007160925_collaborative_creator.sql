-- Telegram identities are authenticated by the backend; clients have no direct table/RPC access.
create table public.sticker_pack_members (
  pack_short_name text not null references public.sticker_packs(short_name) on delete cascade,
  user_id bigint not null check (user_id > 0), joined_at timestamptz not null default now(),
  removed_at timestamptz, primary key(pack_short_name,user_id)
);
create index sticker_pack_members_user on public.sticker_pack_members(user_id) where removed_at is null;
create table public.sticker_pack_invites (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  pack_short_name text not null references public.sticker_packs(short_name) on delete cascade,
  created_at timestamptz not null default now(), expires_at timestamptz not null,
  revoked_at timestamptz, use_count integer not null default 0,
  max_uses integer not null default 20 check(max_uses between 1 and 50)
);
create unique index sticker_pack_invites_active on public.sticker_pack_invites(pack_short_name) where revoked_at is null;
create table public.creator_assets (
  id text primary key check(id ~ '^[a-f0-9]{48}$'), user_id bigint not null check(user_id > 0),
  image_data text not null check(length(image_data) <= 900000),
  expires_at timestamptz not null, created_at timestamptz not null default now()
);
create index creator_assets_expiry on public.creator_assets(expires_at);
create index creator_assets_user_time on public.creator_assets(user_id,created_at);
create table public.creator_jobs (
  id uuid primary key, user_id bigint not null check(user_id > 0), payload jsonb not null,
  state text not null default 'queued' check(state in ('queued','running','completed','interrupted','cancelled')),
  cost integer not null check(cost=48), images jsonb not null default '[]',
  attempted integer not null default 0 check(attempted between 0 and 24),
  pack_link text, pack_error text, lease_until timestamptz,
  created_at timestamptz not null default now(), finished_at timestamptz
);
create unique index creator_jobs_active_user on public.creator_jobs(user_id) where state in ('queued','running');
create index creator_jobs_queue on public.creator_jobs(created_at) where state='queued';
create table public.creator_pack_operations (
  request_key uuid primary key, user_id bigint not null, payload jsonb not null,
  state text not null default 'running', result jsonb, created_at timestamptz not null default now()
);

alter table public.sticker_pack_members enable row level security;
alter table public.sticker_pack_invites enable row level security;
alter table public.creator_assets enable row level security;
alter table public.creator_jobs enable row level security;
alter table public.creator_pack_operations enable row level security;
revoke all on public.sticker_pack_members,public.sticker_pack_invites,public.creator_assets,public.creator_jobs,public.creator_pack_operations from public,anon,authenticated;
grant all on public.sticker_pack_members,public.sticker_pack_invites,public.creator_assets,public.creator_jobs,public.creator_pack_operations to service_role;

create function public.creator_invite_create(p_user_id bigint,p_pack text,p_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_owner bigint;
begin
  select user_id into v_owner from public.sticker_packs where short_name=p_pack for update;
  if v_owner is distinct from p_user_id then raise exception 'pack not owned' using errcode='42501'; end if;
  update public.sticker_pack_invites set revoked_at=now() where pack_short_name=p_pack and revoked_at is null;
  insert into public.sticker_pack_invites(token_hash,pack_short_name,expires_at) values(p_hash,p_pack,now()+interval '7 days');
  return jsonb_build_object('expiresAt',now()+interval '7 days','maxUses',20);
end $$;

create function public.creator_invite_join(p_user_id bigint,p_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v public.sticker_pack_invites; v_owner bigint; v_removed timestamptz; v_title text;
begin
  -- Pack row first is also the lock order used by link rotation/member removal.
  select * into v from public.sticker_pack_invites where token_hash=p_hash;
  if not found then raise exception 'invite unavailable' using errcode='P0001'; end if;
  select user_id,title into v_owner,v_title from public.sticker_packs where short_name=v.pack_short_name for update;
  select * into v from public.sticker_pack_invites where token_hash=p_hash for update;
  if v.revoked_at is not null or v.expires_at<=now() then raise exception 'invite unavailable' using errcode='P0001'; end if;
  if v_owner=p_user_id then return jsonb_build_object('shortName',v.pack_short_name,'title',v_title,'role','owner'); end if;
  select removed_at into v_removed from public.sticker_pack_members where pack_short_name=v.pack_short_name and user_id=p_user_id;
  if found and v_removed is null then return jsonb_build_object('shortName',v.pack_short_name,'title',v_title,'role','contributor'); end if;
  if v_removed is not null and v_removed>=v.created_at then raise exception 'invite unavailable' using errcode='P0001'; end if;
  if v.use_count>=v.max_uses or (select count(*) from public.sticker_pack_members where pack_short_name=v.pack_short_name and removed_at is null)>=50 then
    raise exception 'invite full' using errcode='P0001';
  end if;
  insert into public.sticker_pack_members(pack_short_name,user_id) values(v.pack_short_name,p_user_id)
    on conflict(pack_short_name,user_id) do update set joined_at=now(),removed_at=null;
  update public.sticker_pack_invites set use_count=use_count+1 where token_hash=p_hash;
  return jsonb_build_object('shortName',v.pack_short_name,'title',v_title,'role','contributor');
end $$;

create function public.creator_member_remove(p_user_id bigint,p_pack text,p_member bigint)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_owner bigint;
begin
  select user_id into v_owner from public.sticker_packs where short_name=p_pack for update;
  if v_owner is null or (v_owner<>p_user_id and p_user_id<>p_member) or v_owner=p_member then
    raise exception 'membership action denied' using errcode='42501';
  end if;
  update public.sticker_pack_members set removed_at=now() where pack_short_name=p_pack and user_id=p_member;
  return found;
end $$;

create function public.creator_job_start(p_user_id bigint,p_id uuid,p_payload jsonb,p_expected_cost integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_balance integer; v_job public.creator_jobs;
begin
  insert into public.balances(user_id,balance) values(p_user_id,15) on conflict(user_id) do nothing;
  select balance into v_balance from public.balances where user_id=p_user_id for update;
  select * into v_job from public.creator_jobs where id=p_id;
  if found then
    if v_job.user_id<>p_user_id or v_job.payload<>p_payload then raise exception 'request reused' using errcode='22023'; end if;
    return jsonb_build_object('id',v_job.id,'state',v_job.state,'balance',v_balance,'cost',v_job.cost);
  end if;
  if p_expected_cost is distinct from 48 then raise exception 'price changed' using errcode='22023'; end if;
  if not exists(select 1 from public.subscriptions where user_id=p_user_id and active and tier='ultimate' and expires_at>now()) then
    raise exception 'Ultimate required' using errcode='42501';
  end if;
  if exists(select 1 from public.creator_jobs where user_id=p_user_id and state in ('queued','running')) then raise exception 'job already active' using errcode='P0001'; end if;
  if (select count(*) from public.creator_jobs where state in ('queued','running'))>=20 then raise exception 'queue full' using errcode='P0001'; end if;
  if v_balance<48 then raise exception 'insufficient balance' using errcode='P0001'; end if;
  update public.balances set balance=balance-48 where user_id=p_user_id returning balance into v_balance;
  insert into public.creator_jobs(id,user_id,payload,cost) values(p_id,p_user_id,p_payload,48);
  insert into public.account_activity(user_id,event_type,delta,balance_after,description,metadata,operation_key)
    values(p_user_id,'generation',-48,v_balance,'24-emotion sticker pack',jsonb_build_object('count',24,'costPerImage',2,'jobId',p_id),'creator:debit:'||p_id);
  return jsonb_build_object('id',p_id,'state','queued','balance',v_balance,'cost',48);
end $$;

create function public.creator_job_finish(p_id uuid,p_state text,p_pack_link text default null,p_pack_error text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v public.creator_jobs; v_refund integer; v_balance integer;
begin
  select * into v from public.creator_jobs where id=p_id for update;
  if not found then raise exception 'job unavailable'; end if;
  if v.state not in ('queued','running') then return jsonb_build_object('state',v.state); end if;
  if p_state not in ('completed','interrupted','cancelled') then raise exception 'invalid job state'; end if;
  if p_state='cancelled' and v.state='running' then raise exception 'job already running' using errcode='P0001'; end if;
  v_refund := greatest(0,48-jsonb_array_length(v.images)*2);
  select balance into v_balance from public.balances where user_id=v.user_id for update;
  if v_refund>0 then
    update public.balances set balance=balance+v_refund where user_id=v.user_id returning balance into v_balance;
    insert into public.account_activity(user_id,event_type,delta,balance_after,description,metadata,operation_key)
      values(v.user_id,'refund',v_refund,v_balance,'Uncreated stickers refunded',jsonb_build_object('jobId',p_id),'creator:refund:'||p_id);
  end if;
  update public.creator_jobs set state=p_state,finished_at=now(),pack_link=p_pack_link,pack_error=p_pack_error,lease_until=null where id=p_id;
  return jsonb_build_object('state',p_state,'balance',v_balance,'refund',v_refund);
end $$;

create function public.creator_job_claim()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v public.creator_jobs; v_old uuid;
begin
  -- A crashed attempt is refunded, never blindly repeated against a paid provider.
  for v_old in select id from public.creator_jobs where (state='running' and lease_until<now()) or (state='queued' and created_at<now()-interval '2 hours') for update skip locked loop
    perform public.creator_job_finish(v_old,'interrupted');
  end loop;
  select * into v from public.creator_jobs where state='queued' order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.creator_jobs set state='running',lease_until=now()+interval '3 minutes' where id=v.id;
  return to_jsonb(v);
end $$;

create function public.creator_pack_begin(p_user_id bigint,p_key uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v public.creator_pack_operations;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_key::text,0));
  select * into v from public.creator_pack_operations where request_key=p_key;
  if found then
    if v.user_id<>p_user_id or v.payload<>p_payload then raise exception 'request reused' using errcode='22023'; end if;
    if v.state='failed' or (v.state='running' and v.created_at<now()-interval '10 minutes') then
      update public.creator_pack_operations set state='running',created_at=now() where request_key=p_key;
      return jsonb_build_object('claimed',true);
    end if;
    return jsonb_build_object('claimed',false,'state',v.state,'result',v.result);
  end if;
  insert into public.creator_pack_operations(request_key,user_id,payload) values(p_key,p_user_id,p_payload);
  return jsonb_build_object('claimed',true);
end $$;

revoke execute on function public.creator_invite_create(bigint,text,text),public.creator_invite_join(bigint,text),public.creator_member_remove(bigint,text,bigint),public.creator_job_start(bigint,uuid,jsonb,integer),public.creator_job_finish(uuid,text,text,text),public.creator_job_claim(),public.creator_pack_begin(bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.creator_invite_create(bigint,text,text),public.creator_invite_join(bigint,text),public.creator_member_remove(bigint,text,bigint),public.creator_job_start(bigint,uuid,jsonb,integer),public.creator_job_finish(uuid,text,text,text),public.creator_job_claim(),public.creator_pack_begin(bigint,uuid,jsonb) to service_role;
