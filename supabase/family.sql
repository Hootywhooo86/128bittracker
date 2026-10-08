-- 128bit family feed. Run once in Supabase → SQL Editor (safe to run again).
-- 128bitPlay's setup SQL already includes this block.
-- The 128bit family event feed: what you do in every 128bit app, for 128bit Tracker's timeline.
-- Same block as 128bitPlay's SETUP_SQL (app/src/lib/account.ts); keep them in step.
create table if not exists public.family_events (
  user_id uuid not null references auth.users on delete cascade,
  id text not null,
  app text not null,
  type text not null,
  at timestamptz not null,
  data jsonb not null default '{}',
  primary key (user_id, id)
);
create index if not exists family_events_at on public.family_events (user_id, at desc);
alter table public.family_events enable row level security;

-- Keys for apps without a sign-in (Zapier, Tasker, Shortcuts, scripts). Only a hash is kept.
create table if not exists public.family_keys (
  key_hash bytea primary key,
  user_id uuid not null references auth.users on delete cascade,
  label text not null default '',
  created_at timestamptz not null default now()
);
alter table public.family_keys enable row level security;

-- Whose feed this sign-in writes to: a TV paired in 128bitPlay posts to its owner's.
create or replace function public.family_owner() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare o uuid;
begin
  if to_regclass('public.tv_devices') is not null then
    execute 'select owner_id from tv_devices where device_id = $1 and owner_id is not null' into o using auth.uid();
  end if;
  return coalesce(o, auth.uid());
end $$;

-- Same id again replaces the event (a day's step count keeps going up). No id: a new event.
create or replace function public.family_insert(owner uuid, events jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if owner is null then raise exception 'Sign in first'; end if;
  if jsonb_typeof(events) <> 'array' or jsonb_array_length(events) > 500 then
    raise exception 'Send a list of at most 500 events';
  end if;
  insert into family_events (user_id, id, app, type, at, data)
  select owner, coalesce(left(e ->> 'id', 200), gen_random_uuid()::text), left(coalesce(e ->> 'app', 'custom'), 40), left(e ->> 'type', 80),
         coalesce(to_timestamp((e ->> 'at')::bigint / 1000.0), now()), coalesce(e -> 'data', '{}')
    from jsonb_array_elements(events) e
   where e ->> 'type' is not null
  on conflict (user_id, id) do update
    set app = excluded.app, type = excluded.type, at = excluded.at, data = excluded.data;
  get diagnostics n = row_count;
  return n;
end $$;

-- (log_events used to return nothing; the return type can only change by dropping it.)
drop function if exists public.log_events(jsonb);
create or replace function public.log_events(events jsonb) returns int
language sql security definer set search_path = public as $$
  select family_insert(family_owner(), events)
$$;

create or replace function public.log_events_with_key(ingest_key text, events jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  select user_id into owner from family_keys where key_hash = sha256(convert_to(ingest_key, 'UTF8'));
  if owner is null then raise exception 'Unknown key'; end if;
  return family_insert(owner, events);
end $$;

create or replace function public.delete_event(event_id text) returns void
language sql security definer set search_path = public as $$
  delete from family_events where user_id = family_owner() and id = event_id
$$;

-- Newest first; before_ms (ms since 1970) pages back.
create or replace function public.get_events(before_ms bigint default null, max_rows int default 200) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'app', app, 'type', type,
           'at', (extract(epoch from at) * 1000)::bigint, 'data', data) order by at desc), '[]')
    from (select * from family_events
           where user_id = family_owner() and (before_ms is null or at < to_timestamp(before_ms / 1000.0))
           order by at desc limit least(max_rows, 1000)) e
$$;

-- A new key, shown once. Only its hash is stored.
create or replace function public.create_family_key(key_label text default '') returns text
language plpgsql security definer set search_path = public as $$
declare k text := '128bit_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in first';
  end if;
  insert into family_keys (key_hash, user_id, label) values (sha256(convert_to(k, 'UTF8')), auth.uid(), coalesce(key_label, ''));
  return k;
end $$;

create or replace function public.list_family_keys() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', encode(key_hash, 'hex'), 'label', label,
           'created', (extract(epoch from created_at) * 1000)::bigint) order by created_at), '[]')
    from family_keys where user_id = auth.uid()
$$;

create or replace function public.delete_family_key(key_id text) returns void
language sql security definer set search_path = public as $$
  delete from family_keys where user_id = auth.uid() and key_hash = decode(key_id, 'hex')
$$;

-- Deletes the signed-in account and, through the cascades, everything it stored in every
-- 128bit app: settings, TVs, feed, keys. Required by Google Play and the App Store.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke all on function public.family_owner(), public.family_insert(uuid, jsonb), public.log_events(jsonb),
  public.log_events_with_key(text, jsonb), public.delete_event(text), public.get_events(bigint, int),
  public.create_family_key(text), public.list_family_keys(), public.delete_family_key(text),
  public.delete_my_account() from public, anon, authenticated;  -- Supabase grants new functions to everyone; family_insert must stay internal.
grant execute on function public.log_events(jsonb), public.delete_event(text), public.get_events(bigint, int),
  public.create_family_key(text), public.list_family_keys(), public.delete_family_key(text),
  public.delete_my_account() to authenticated;
-- The one call that works without a sign-in: it checks the key itself.
grant execute on function public.log_events_with_key(text, jsonb) to anon, authenticated;
-- End of the family block.
