-- 128bit Tracker in the cloud. Run once in Supabase → SQL Editor, after family.sql (safe to run again).
-- Every row belongs to one account (user_id) and is only reachable through the functions below,
-- which always act for the signed-in account (family_owner(): a TV paired in 128bitPlay acts for
-- its owner). The tables have row level security on and no policies, so the Data API can't
-- touch them directly. Deleting an account deletes all of it (on delete cascade).

create table if not exists public.tracker_items (
  user_id uuid not null references auth.users on delete cascade,
  id text not null,
  type text not null,
  title text not null,
  creator text,
  year int,
  cover_url text,
  backdrop_url text,
  status text not null default 'planned',
  progress numeric not null default 0,
  progress_total numeric,
  rating int,
  season int,
  ids jsonb not null default '{}',
  meta jsonb not null default '{}',
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists tracker_items_synced on public.tracker_items (user_id, synced_at);
create index if not exists tracker_items_ids on public.tracker_items using gin (ids);

create table if not exists public.tracker_lists (
  user_id uuid not null references auth.users on delete cascade,
  id text not null,
  name text not null,
  description text,
  kind text not null default 'mixed',
  show_in_play boolean not null default false,
  is_public boolean not null default false,
  share_id text unique,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.tracker_list_items (
  user_id uuid not null references auth.users on delete cascade,
  list_id text not null,
  item_id text not null,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (user_id, list_id, item_id)
);

create table if not exists public.tracker_trophies (
  user_id uuid not null references auth.users on delete cascade,
  id text not null,
  kind text not null,
  title text not null,
  item_id text,
  earned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Coming up (next episodes, releases): worked out by the Tracker app, stored for 128bitPlay.
create table if not exists public.tracker_calendar (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  kind text not null,
  title text not null,
  detail text,
  item_id text,
  data jsonb not null default '{}'
);
create index if not exists tracker_calendar_day on public.tracker_calendar (user_id, day);

create table if not exists public.tracker_profiles (
  user_id uuid primary key references auth.users on delete cascade,
  handle text unique,
  display_name text,
  is_public boolean not null default false,
  updated_at timestamptz not null default now()
);

-- AniList / Trakt / MAL sign-ins made with the Connect buttons. Only the connect Edge Function
-- (service role) reads or writes these; no function below ever returns a token.
create table if not exists public.tracker_connections (
  user_id uuid not null references auth.users on delete cascade,
  service text not null,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  account jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, service)
);

-- OAuth sign-ins in progress (state → who started it). Edge Function only.
create table if not exists public.tracker_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users on delete cascade,
  service text not null,
  verifier text,
  redirect text,
  created_at timestamptz not null default now()
);

-- Per-account daily use of 128bit's shared API keys (TMDB, Steam, IGDB, Last.fm). Edge Function only.
create table if not exists public.tracker_proxy_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null default current_date,
  service text not null,
  count int not null default 0,
  primary key (user_id, day, service)
);

alter table public.tracker_items enable row level security;
alter table public.tracker_lists enable row level security;
alter table public.tracker_list_items enable row level security;
alter table public.tracker_trophies enable row level security;
alter table public.tracker_calendar enable row level security;
alter table public.tracker_profiles enable row level security;
alter table public.tracker_connections enable row level security;
alter table public.tracker_oauth_states enable row level security;
alter table public.tracker_proxy_usage enable row level security;

-- One item as every app sees it.
create or replace function public.tracker_item_json(i public.tracker_items) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object('id', i.id, 'type', i.type, 'title', i.title, 'creator', i.creator, 'year', i.year,
    'poster', i.cover_url, 'backdrop', i.backdrop_url, 'status', i.status, 'progress', i.progress,
    'progress_total', i.progress_total, 'rating', i.rating, 'season', i.season, 'ids', i.ids,
    'pct', i.meta -> 'pct', 'now', i.meta -> 'now',
    'started_at', i.started_at, 'finished_at', i.finished_at, 'updated_at', i.updated_at)
$$;

create or replace function public.tracker_me() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare o uuid := family_owner();
begin
  if o is null then raise exception 'Sign in first'; end if;
  return o;
end $$;

-- ---------- Sync for the Tracker app (last writer wins on updated_at) ----------

create or replace function public.tracker_push(payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := tracker_me();
  n int := 0;
  c int;
begin
  if jsonb_typeof(payload) <> 'object' then raise exception 'Send an object'; end if;
  if coalesce(jsonb_array_length(payload -> 'items'), 0) + coalesce(jsonb_array_length(payload -> 'lists'), 0)
     + coalesce(jsonb_array_length(payload -> 'list_items'), 0) + coalesce(jsonb_array_length(payload -> 'trophies'), 0) > 2000 then
    raise exception 'Send at most 2000 rows at a time';
  end if;

  insert into tracker_items as t (user_id, id, type, title, creator, year, cover_url, backdrop_url, status, progress,
      progress_total, rating, season, ids, meta, started_at, finished_at, updated_at, deleted, synced_at)
  select me, left(r ->> 'id', 80), left(coalesce(r ->> 'type', 'other'), 24), left(coalesce(r ->> 'title', '?'), 200),
      left(r ->> 'creator', 120), (r ->> 'year')::int, left(r ->> 'cover_url', 1000), left(r ->> 'backdrop_url', 1000),
      coalesce(r ->> 'status', 'planned'), coalesce((r ->> 'progress')::numeric, 0), (r ->> 'progress_total')::numeric,
      (r ->> 'rating')::int, (r ->> 'season')::int, coalesce(r -> 'ids', '{}'), coalesce(r -> 'meta', '{}'),
      (r ->> 'started_at')::timestamptz, (r ->> 'finished_at')::timestamptz,
      coalesce((r ->> 'updated_at')::timestamptz, now()), coalesce((r ->> 'deleted')::boolean, false), now()
    from jsonb_array_elements(coalesce(payload -> 'items', '[]')) r
   where r ->> 'id' is not null
  on conflict (user_id, id) do update set
      type = excluded.type, title = excluded.title, creator = excluded.creator, year = excluded.year,
      cover_url = excluded.cover_url, backdrop_url = excluded.backdrop_url, status = excluded.status,
      progress = excluded.progress, progress_total = excluded.progress_total, rating = excluded.rating,
      season = excluded.season, ids = excluded.ids, meta = excluded.meta, started_at = excluded.started_at,
      finished_at = excluded.finished_at, updated_at = excluded.updated_at, deleted = excluded.deleted, synced_at = now()
    where excluded.updated_at > t.updated_at;
  get diagnostics c = row_count; n := n + c;

  insert into tracker_lists as t (user_id, id, name, description, kind, show_in_play, is_public, share_id, position, updated_at, deleted, synced_at)
  select me, left(r ->> 'id', 80), left(coalesce(r ->> 'name', 'List'), 120), left(r ->> 'description', 1000),
      left(coalesce(r ->> 'kind', 'mixed'), 24), coalesce((r ->> 'show_in_play')::boolean, false),
      coalesce((r ->> 'is_public')::boolean, false),
      case when coalesce((r ->> 'is_public')::boolean, false) then coalesce(r ->> 'share_id', replace(gen_random_uuid()::text, '-', '')) end,
      coalesce((r ->> 'position')::int, 0), coalesce((r ->> 'updated_at')::timestamptz, now()),
      coalesce((r ->> 'deleted')::boolean, false), now()
    from jsonb_array_elements(coalesce(payload -> 'lists', '[]')) r
   where r ->> 'id' is not null
  on conflict (user_id, id) do update set
      name = excluded.name, description = excluded.description, kind = excluded.kind, show_in_play = excluded.show_in_play,
      is_public = excluded.is_public, share_id = case when excluded.is_public then coalesce(t.share_id, excluded.share_id) end,
      position = excluded.position, updated_at = excluded.updated_at, deleted = excluded.deleted, synced_at = now()
    where excluded.updated_at > t.updated_at;
  get diagnostics c = row_count; n := n + c;

  insert into tracker_list_items as t (user_id, list_id, item_id, position, updated_at, deleted, synced_at)
  select me, left(r ->> 'list_id', 80), left(r ->> 'item_id', 80), coalesce((r ->> 'position')::int, 0),
      coalesce((r ->> 'updated_at')::timestamptz, now()), coalesce((r ->> 'deleted')::boolean, false), now()
    from jsonb_array_elements(coalesce(payload -> 'list_items', '[]')) r
   where r ->> 'list_id' is not null and r ->> 'item_id' is not null
  on conflict (user_id, list_id, item_id) do update set
      position = excluded.position, updated_at = excluded.updated_at, deleted = excluded.deleted, synced_at = now()
    where excluded.updated_at > t.updated_at;
  get diagnostics c = row_count; n := n + c;

  insert into tracker_trophies as t (user_id, id, kind, title, item_id, earned_at, updated_at, deleted, synced_at)
  select me, left(r ->> 'id', 80), left(r ->> 'kind', 24), left(coalesce(r ->> 'title', '?'), 200), left(r ->> 'item_id', 80),
      coalesce((r ->> 'earned_at')::timestamptz, now()), coalesce((r ->> 'updated_at')::timestamptz, now()),
      coalesce((r ->> 'deleted')::boolean, false), now()
    from jsonb_array_elements(coalesce(payload -> 'trophies', '[]')) r
   where r ->> 'id' is not null and r ->> 'kind' is not null
  on conflict (user_id, id) do update set
      kind = excluded.kind, title = excluded.title, item_id = excluded.item_id, earned_at = excluded.earned_at,
      updated_at = excluded.updated_at, deleted = excluded.deleted, synced_at = now()
    where excluded.updated_at > t.updated_at;
  get diagnostics c = row_count; n := n + c;

  -- The calendar is worked out fresh each time: replace it.
  if payload ? 'calendar' then
    delete from tracker_calendar where user_id = me;
    insert into tracker_calendar (user_id, day, kind, title, detail, item_id, data)
    select me, (r ->> 'date')::date, left(coalesce(r ->> 'kind', 'release'), 24), left(coalesce(r ->> 'title', '?'), 200),
        left(r ->> 'detail', 300), left(r ->> 'item_id', 80), coalesce(r -> 'data', '{}')
      from jsonb_array_elements(payload -> 'calendar') r
     where r ->> 'date' is not null
     limit 500;
  end if;

  return jsonb_build_object('stored', n, 'at', now());
end $$;

-- Rows changed since the last pull (by any app on this account). Pass back `at` next time.
create or replace function public.tracker_pull(since timestamptz default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'at', now(),
    'items', coalesce((select jsonb_agg(to_jsonb(t) - 'user_id' - 'synced_at') from tracker_items t
                        where user_id = tracker_me() and (since is null or synced_at > since)), '[]'),
    'lists', coalesce((select jsonb_agg(to_jsonb(t) - 'user_id' - 'synced_at') from tracker_lists t
                        where user_id = tracker_me() and (since is null or synced_at > since)), '[]'),
    'list_items', coalesce((select jsonb_agg(to_jsonb(t) - 'user_id' - 'synced_at') from tracker_list_items t
                        where user_id = tracker_me() and (since is null or synced_at > since)), '[]'),
    'trophies', coalesce((select jsonb_agg(to_jsonb(t) - 'user_id' - 'synced_at') from tracker_trophies t
                        where user_id = tracker_me() and (since is null or synced_at > since)), '[]'))
$$;

-- ---------- What 128bitPlay (and any 128bit app) reads: API v1 ----------

-- kind: movie | show | anime | book | game | mixed, or null for all. play_only: lists marked "Show in 128bitPlay".
create or replace function public.get_lists(kind text default null, play_only boolean default false) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'description', l.description, 'kind', l.kind,
           'show_in_play', l.show_in_play, 'is_public', l.is_public, 'share_id', l.share_id,
           'item_count', (select count(*) from tracker_list_items li join tracker_items i on i.user_id = li.user_id and i.id = li.item_id
                           where li.user_id = l.user_id and li.list_id = l.id and not li.deleted and not i.deleted))
         order by l.position, l.name), '[]')
    from tracker_lists l
   where l.user_id = tracker_me() and not l.deleted
     and (get_lists.kind is null or l.kind = get_lists.kind or l.kind = 'mixed')
     and (not play_only or l.show_in_play)
$$;

create or replace function public.get_list_items(list_id text, page int default 1, per_page int default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(tracker_item_json(i) || jsonb_build_object('position', li.position) order by li.position, li.updated_at), '[]')
    from (select * from tracker_list_items x
           where x.user_id = tracker_me() and x.list_id = get_list_items.list_id and not x.deleted
           order by x.position, x.updated_at
           limit least(greatest(per_page, 1), 200) offset (greatest(page, 1) - 1) * least(greatest(per_page, 1), 200)) li
    join tracker_items i on i.user_id = li.user_id and i.id = li.item_id and not i.deleted
$$;

-- Want to watch / read / play: everything planned.
create or replace function public.get_watchlist(kind text default null, max_rows int default 200) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(tracker_item_json(i) order by i.updated_at desc), '[]')
    from (select * from tracker_items t
           where t.user_id = tracker_me() and not t.deleted and t.status = 'planned'
             and (get_watchlist.kind is null or t.type = get_watchlist.kind)
           order by t.updated_at desc limit least(max_rows, 1000)) i
$$;

-- Continue watching: shows and anime in progress, with the next episode, most recent first.
create or replace function public.get_up_next(max_rows int default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(tracker_item_json(i) || jsonb_build_object(
           'next', jsonb_build_object('season', coalesce(i.season, 1), 'number', floor(i.progress)::int + 1),
           'last_watched_at', i.updated_at) order by i.updated_at desc), '[]')
    from (select * from tracker_items t
           where t.user_id = tracker_me() and not t.deleted and t.status = 'active' and t.type in ('show', 'anime')
             and (t.progress_total is null or t.progress < t.progress_total)
           order by t.updated_at desc limit least(max_rows, 200)) i
$$;

-- "Today" where the person is (an IANA zone like America/Edmonton from the phone), not UTC.
create or replace function public.tracker_today(tz text default null) returns date
language plpgsql stable set search_path = public as $$
begin
  return (now() at time zone coalesce(nullif(tz, ''), 'UTC'))::date;
exception when others then return current_date;
end $$;

-- Same, from the person's own day: tz is the phone's IANA zone (e.g. America/Edmonton).
create or replace function public.get_calendar_local(days int default 30, tz text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('date', c.day, 'kind', c.kind, 'title', c.title, 'detail', c.detail,
           'item', case when i.id is null then null else tracker_item_json(i) end) || c.data order by c.day, c.title), '[]')
    from tracker_calendar c
    left join tracker_items i on i.user_id = c.user_id and i.id = c.item_id
   where c.user_id = tracker_me()
     and c.day between tracker_today(tz) and tracker_today(tz) + least(greatest(days, 1), 366)
$$;

create or replace function public.get_calendar(days int default 30) returns jsonb
language sql stable security definer set search_path = public as $$ select public.get_calendar_local(days, null) $$;


-- Watched / read / finished, newest first, from every 128bit app.
create or replace function public.get_history(before_ms bigint default null, max_rows int default 100) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'app', app, 'type', type,
           'at', (extract(epoch from at) * 1000)::bigint, 'data', data) order by at desc), '[]')
    from (select * from family_events
           where user_id = tracker_me()
             and type in ('movie.watched', 'episode.watched', 'book.finished', 'chapter.read', 'item.completed', 'game.completed')
             and (before_ms is null or at < to_timestamp(before_ms / 1000.0))
           order by at desc limit least(max_rows, 500)) e
$$;

-- Progress for a title, matched by any id another app knows it by, e.g. {"tmdb": 95396} or {"imdb": "tt11280740"}.
-- Shows come back one row per season.
create or replace function public.get_item_progress(ids jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(tracker_item_json(i) order by i.season nulls first), '[]')
    from tracker_items i, jsonb_each(get_item_progress.ids) k
   where i.user_id = tracker_me() and not i.deleted and i.ids -> k.key = k.value
$$;

create or replace function public.create_list(name text, kind text default 'mixed', show_in_play boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := tracker_me(); lid text := 'l-' || replace(gen_random_uuid()::text, '-', '');
begin
  if coalesce(trim(name), '') = '' then raise exception 'Give the list a name'; end if;
  insert into tracker_lists (user_id, id, name, kind, show_in_play, position)
  values (me, lid, left(trim(name), 120), left(coalesce(kind, 'mixed'), 24), coalesce(show_in_play, true),
          coalesce((select max(position) + 1 from tracker_lists where user_id = me), 0));
  return jsonb_build_object('id', lid);
end $$;

-- Everyone's five lists: Movies, Shows, Anime, Audiobooks, Comics. Reuses a list you already
-- have (by name, e.g. "Amine" or "Audiobboks", else by kind) and fixes its kind; makes the
-- missing ones. Returns their ids: {movie, show, anime, audiobooks, comic}. Safe to call often.
create or replace function public.starter_lists() returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  me uuid := tracker_me();
  t record;
  lid text;
  out jsonb := '{}';
begin
  for t in select * from (values
      ('movie', 'movie', 'Movies', '^(movie|film)'),
      ('show', 'show', 'Shows', '(show|tv|series)'),
      ('anime', 'anime', 'Anime', '(anim|amine)'),
      ('audiobooks', 'book', 'Audiobooks', '(audio|book)'),
      ('comic', 'comic', 'Comics', '(comic|manga|manhwa)')) v(key, kind, name, pat)
  loop
    lid := null;
    -- by name first (also when its kind is off), then any list of that kind
    select id into lid from tracker_lists
     where user_id = me and not deleted and lower(name) ~ t.pat
       and not (t.key = 'show' and lower(name) ~ '(anim|amine)')
     order by (kind = t.kind) desc, position limit 1;
    if lid is null then
      select id into lid from tracker_lists where user_id = me and not deleted and kind = t.kind
       and not (t.key = 'show' and lower(name) ~ '(anim|amine)') order by position limit 1;
    end if;
    if lid is null then
      lid := 'l-' || replace(gen_random_uuid()::text, '-', '');
      insert into tracker_lists (user_id, id, name, kind, show_in_play, position)
      values (me, lid, t.name, t.kind, true, coalesce((select max(position) + 1 from tracker_lists where user_id = me), 0));
    else
      update tracker_lists set kind = t.kind, show_in_play = true, updated_at = now(), synced_at = now()
       where user_id = me and id = lid and (kind <> t.kind or not show_in_play);
    end if;
    out := out || jsonb_build_object(t.key, lid);
  end loop;
  return out;
end $$;

-- item: an existing item id, or a title from another app: {type, title, year, poster, ids: {tmdb, imdb, ...}}.
-- The library item another app means: by any id it knows, else by type + title. Internal.
create or replace function public.tracker_find(me uuid, item jsonb) returns public.tracker_items
language plpgsql stable security definer set search_path = public as $$
declare it tracker_items;
begin
  if jsonb_typeof(item -> 'ids') = 'object' and item -> 'ids' <> '{}' then
    select i.* into it from tracker_items i, jsonb_each(item -> 'ids') k
     where i.user_id = me and i.ids -> k.key = k.value and i.season is null
     order by i.deleted, i.updated_at desc limit 1;
    if found then return it; end if;
  end if;
  if coalesce(item ->> 'title', '') <> '' then
    select i.* into it from tracker_items i
     where i.user_id = me and i.season is null and lower(i.title) = lower(item ->> 'title')
       and (item ->> 'type' is null or i.type = item ->> 'type')
     order by i.deleted, i.updated_at desc limit 1;
    if found then return it; end if;
  end if;
  return null;
end $$;

-- A title from another app, made sure it's in the library (planned if new). Internal.
create or replace function public.tracker_ensure(me uuid, item jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare it tracker_items; iid text := item ->> 'id';
begin
  if iid is not null and exists (select 1 from tracker_items where user_id = me and id = iid) then return iid; end if;
  it := tracker_find(me, item);
  if it.id is not null then
    update tracker_items set ids = ids || coalesce(item -> 'ids', '{}'), deleted = false,
        status = case when deleted then 'planned' else status end,
        cover_url = coalesce(cover_url, left(item ->> 'poster', 1000)), updated_at = now(), synced_at = now()
     where user_id = me and id = it.id;
    return it.id;
  end if;
  if coalesce(item ->> 'title', '') = '' then raise exception 'item needs an id or a title'; end if;
  iid := 'i-' || replace(gen_random_uuid()::text, '-', '');
  insert into tracker_items (user_id, id, type, title, creator, year, cover_url, backdrop_url, ids)
  values (me, iid, left(coalesce(item ->> 'type', 'movie'), 24), left(item ->> 'title', 200), left(item ->> 'creator', 120),
          (item ->> 'year')::int, left(item ->> 'poster', 1000), left(item ->> 'backdrop', 1000), coalesce(item -> 'ids', '{}'));
  return iid;
end $$;

create or replace function public.add_to_list(list_id text, item jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := tracker_me(); iid text;
begin
  if not exists (select 1 from tracker_lists l where l.user_id = me and l.id = add_to_list.list_id and not l.deleted) then
    raise exception 'No such list';
  end if;
  iid := tracker_ensure(me, item);
  insert into tracker_list_items as t (user_id, list_id, item_id, position)
  values (me, add_to_list.list_id, iid,
          coalesce((select max(position) + 1 from tracker_list_items x where x.user_id = me and x.list_id = add_to_list.list_id and not x.deleted), 0))
  on conflict (user_id, list_id, item_id) do update set deleted = false, updated_at = now(), synced_at = now();
  return jsonb_build_object('item_id', iid);
end $$;

-- Everything another app knows you read, watched or are partway through (128bitPlay sends its
-- audiobooks, comics, movies and shows). Only ever moves things forward: progress goes up,
-- planned → in progress → finished; never deletes, never undoes a finish, never touches
-- something you dropped or put on hold yourself. Shows come one item per season.
create or replace function public.track_items(items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := tracker_me();
  r jsonb;
  it tracker_items;
  added int := 0;
  changed int := 0;
  st text;
  rank_new int;
  rank_old int;
begin
  if jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 1000 then raise exception 'Send a list of at most 1000 items'; end if;
  for r in select * from jsonb_array_elements(items) loop
    continue when coalesce(r ->> 'title', '') = '';
    st := coalesce(r ->> 'status', case when coalesce((r ->> 'progress')::numeric, 0) > 0 then 'active' else 'planned' end);
    continue when st not in ('planned', 'active', 'done');
    it := null;
    if r ->> 'season' is not null then
      select * into it from tracker_items t
       where t.user_id = me and not t.deleted and t.season = (r ->> 'season')::int and (t.type = coalesce(r ->> 'type', 'show') or (t.type in ('show', 'anime') and coalesce(r ->> 'type', 'show') in ('show', 'anime')))
         and ((r -> 'ids' ? 'imdb' and t.ids ->> 'imdb' = r -> 'ids' ->> 'imdb') or lower(t.title) = lower(r ->> 'title'))
       limit 1;
    else
      it := tracker_find(me, r);
    end if;
    if it.id is null then
      insert into tracker_items (user_id, id, type, title, creator, year, cover_url, status, progress, progress_total, season, ids, meta, started_at, finished_at)
      values (me, 'i-' || replace(gen_random_uuid()::text, '-', ''), left(coalesce(r ->> 'type', 'movie'), 24), left(r ->> 'title', 200),
              left(r ->> 'creator', 120), (r ->> 'year')::int, left(r ->> 'poster', 1000), st,
              coalesce((r ->> 'progress')::numeric, case when st = 'done' then coalesce((r ->> 'progress_total')::numeric, 1) else 0 end),
              (r ->> 'progress_total')::numeric, (r ->> 'season')::int, coalesce(r -> 'ids', '{}'), coalesce(r -> 'meta', '{}'),
              case when st <> 'planned' then coalesce((r ->> 'started_at')::timestamptz, now()) end,
              case when st = 'done' then coalesce((r ->> 'finished_at')::timestamptz, now()) end);
      added := added + 1;
      continue;
    end if;
    rank_old := case when it.deleted then -1 when it.status in ('dropped', 'on_hold') then 99 when it.status = 'done' then 2 when it.status = 'active' then 1 else 0 end;
    rank_new := case st when 'done' then 2 when 'active' then 1 else 0 end;
    if rank_old = 99 then continue; end if;
    if rank_new <= rank_old and coalesce((r ->> 'progress')::numeric, 0) <= it.progress
       and (it.progress_total is not null or r ->> 'progress_total' is null) and it.ids @> coalesce(r -> 'ids', '{}')
       and it.meta @> coalesce(r -> 'meta', '{}') then
      continue; -- nothing new
    end if;
    update tracker_items set
        deleted = false,
        status = case when rank_new > greatest(rank_old, 0) then st else status end,
        progress = greatest(progress, coalesce((r ->> 'progress')::numeric, 0),
                            case when rank_new = 2 and rank_old < 2 then coalesce(progress_total, (r ->> 'progress_total')::numeric, 0) else 0 end),
        progress_total = coalesce(progress_total, (r ->> 'progress_total')::numeric),
        ids = ids || coalesce(r -> 'ids', '{}'),
        meta = meta || coalesce(r -> 'meta', '{}'),
        cover_url = coalesce(cover_url, left(r ->> 'poster', 1000)),
        creator = coalesce(creator, left(r ->> 'creator', 120)),
        started_at = coalesce(started_at, case when rank_new >= 1 then coalesce((r ->> 'started_at')::timestamptz, now()) end),
        finished_at = coalesce(finished_at, case when rank_new = 2 then coalesce((r ->> 'finished_at')::timestamptz, now()) end),
        updated_at = now(), synced_at = now()
     where user_id = me and id = it.id;
    changed := changed + 1;
  end loop;
  return jsonb_build_object('added', added, 'updated', changed);
end $$;

-- Where you are right now in one title, live from a player (when you pause or leave, and
-- every few minutes). Same rules as track_items: forward only, meta.pct / meta.now replaced.
create or replace function public.set_progress(item jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'item must be an object'; end if;
  return public.track_items(jsonb_build_array(item));
end $$;

-- A timestamp or number from app data, or null when it isn't one.
create or replace function public.tracker_ts(v text) returns timestamptz
language plpgsql stable set search_path = public as $$
begin
  return v::timestamptz;
exception when others then return null;
end $$;
create or replace function public.tracker_num(v jsonb) returns numeric
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(v) = 'number' then v::text::numeric end
$$;

-- Everything you're partway through, on any device or app, most recent first:
-- movies, episodes, books, comics, with meta.now (position, episode, chapter, page).
create or replace function public.get_in_progress(max_rows int default 30) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(tracker_item_json(i.t) || jsonb_build_object('at', i.at) order by i.at desc), '[]')
    from (select t, coalesce(tracker_ts(t.meta -> 'now' ->> 'at'), t.updated_at) as at
            from tracker_items t
           where t.user_id = tracker_me() and not t.deleted and t.status = 'active'
             and (t.meta ? 'now' or tracker_num(t.meta -> 'pct') > 0)
             and coalesce(tracker_num(t.meta -> 'pct'), 0) < 100
             -- a show's "now" only counts while that episode isn't watched yet
             and (t.type not in ('show', 'anime') or coalesce(tracker_num(t.meta -> 'now' -> 'episode'), 0) > t.progress)
           order by at desc limit least(greatest(max_rows, 1), 200)) i
$$;

-- Is this title in my library? By any id, else by type + title (books and comics from 128bitPlay).
create or replace function public.find_item(item jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare it tracker_items := tracker_find(tracker_me(), item);
begin
  if it.id is null or it.deleted then return null; end if;
  return tracker_item_json(it);
end $$;

-- Want to watch (or not): from another app's title page. Adds the title as planned if it isn't
-- in the library yet; taking it off only removes it while it's still just planned.
create or replace function public.set_watchlist(item jsonb, wanted boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := tracker_me(); it tracker_items;
begin
  if not wanted then
    it := tracker_find(me, item);
    if it.id is not null and it.status = 'planned' and not it.deleted then
      update tracker_items set deleted = true, updated_at = now(), synced_at = now() where user_id = me and id = it.id;
    end if;
    return jsonb_build_object('item_id', null);
  end if;
  return jsonb_build_object('item_id', tracker_ensure(me, item));
end $$;

create or replace function public.remove_from_list(list_id text, item_id text) returns void
language sql security definer set search_path = public as $$
  update tracker_list_items set deleted = true, updated_at = now(), synced_at = now()
   where user_id = tracker_me() and tracker_list_items.list_id = remove_from_list.list_id and tracker_list_items.item_id = remove_from_list.item_id
$$;

create or replace function public.rate(item_id text, rating int) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if rating is not null and (rating < 1 or rating > 10) then raise exception 'rating is 1 to 10'; end if;
  update tracker_items set rating = rate.rating, updated_at = now(), synced_at = now()
   where user_id = tracker_me() and id = rate.item_id;
  if not found then raise exception 'No such item'; end if;
end $$;

-- ---------- Profiles and sharing (private unless the owner says otherwise) ----------

create or replace function public.set_profile(handle text default null, display_name text default null, is_public boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare me uuid := tracker_me();
begin
  if handle is not null and handle !~ '^[a-z0-9_]{3,24}$' then raise exception 'Handles are 3-24 lowercase letters, numbers or _'; end if;
  insert into tracker_profiles (user_id, handle, display_name, is_public) values (me, handle, left(display_name, 60), coalesce(is_public, false))
  on conflict (user_id) do update set handle = coalesce(set_profile.handle, tracker_profiles.handle),
    display_name = coalesce(left(set_profile.display_name, 60), tracker_profiles.display_name),
    is_public = coalesce(set_profile.is_public, tracker_profiles.is_public), updated_at = now();
  return (select to_jsonb(p) - 'user_id' from tracker_profiles p where user_id = me);
exception when unique_violation then raise exception 'That handle is taken';
end $$;

create or replace function public.get_public_list(share_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('name', l.name, 'description', l.description, 'kind', l.kind,
      'owner', (select coalesce(p.display_name, p.handle) from tracker_profiles p where p.user_id = l.user_id and p.is_public),
      'items', coalesce((select jsonb_agg(tracker_item_json(i) - 'rating' - 'status' - 'progress' - 'started_at' - 'finished_at' - 'updated_at'
                           order by li.position)
                    from tracker_list_items li join tracker_items i on i.user_id = li.user_id and i.id = li.item_id and not i.deleted
                   where li.user_id = l.user_id and li.list_id = l.id and not li.deleted), '[]'))
    from tracker_lists l
   where l.share_id = get_public_list.share_id and l.is_public and not l.deleted
$$;

create or replace function public.get_public_profile(handle text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('handle', p.handle, 'display_name', p.display_name,
      'trophies', coalesce((select jsonb_object_agg(kind, n) from (select kind, count(*) n from tracker_trophies t
                              where t.user_id = p.user_id and not t.deleted group by kind) x), '{}'),
      'recent_trophies', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'title', title, 'earned_at', earned_at) order by earned_at desc)
                              from (select * from tracker_trophies t where t.user_id = p.user_id and not t.deleted order by earned_at desc limit 24) r), '[]'),
      'lists', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'kind', kind, 'share_id', share_id))
                              from tracker_lists l where l.user_id = p.user_id and l.is_public and not l.deleted), '[]'))
    from tracker_profiles p
   where p.handle = get_public_profile.handle and p.is_public
$$;

-- Which services this account connected with the Connect buttons (never the tokens).
create or replace function public.tracker_connections_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('service', service, 'account', account, 'connected_at', updated_at)), '[]')
    from tracker_connections where user_id = tracker_me()
$$;

create or replace function public.tracker_disconnect(service text) returns void
language sql security definer set search_path = public as $$
  delete from tracker_connections where user_id = tracker_me() and tracker_connections.service = tracker_disconnect.service
$$;


-- Counts one lookup made with 128bit's shared keys (the connect Edge Function's daily limit).
create or replace function public.tracker_bump_usage(who uuid, svc text) returns int
language sql security definer set search_path = public as $$
  insert into tracker_proxy_usage (user_id, day, service, count) values (who, current_date, left(svc, 40), 1)
  on conflict (user_id, day, service) do update set count = tracker_proxy_usage.count + 1
  returning count
$$;

-- ---------- Watching in any 128bit app updates the library, even with Tracker closed ----------
-- 128bitPlay posts movie.watched / episode.watched / book.finished / chapter.read to the family
-- feed. This applies them here: the season's progress moves on, the last episode finishes it.
-- Items are matched by IMDb id when the event has one ({imdb: "tt…"}), else by title.
create or replace function public.tracker_apply_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d jsonb := new.data;
  me uuid := new.user_id;
  it tracker_items;
  typ text;
  ttl text;
  s int;
  num int;
  total int;
  idz jsonb;
begin
  if new.app = 'tracker' or new.type not in ('movie.watched', 'episode.watched', 'book.finished', 'chapter.read') then
    return new;
  end if;
  begin
    idz := jsonb_strip_nulls(jsonb_build_object('imdb', d ->> 'imdb', 'tmdb', d -> 'tmdb', 'anilist', d -> 'anilist', 'kitsu', d -> 'kitsu'));
    if new.type = 'episode.watched' then
      ttl := d ->> 'show';
      if coalesce(ttl, '') = '' then return new; end if;
      typ := case when coalesce((d ->> 'anime')::boolean, false) then 'anime' else 'show' end;
      s := coalesce((d ->> 'season')::int, substring(d ->> 'episode' from '[Ss](\d+)')::int, 1);
      num := coalesce((d ->> 'number')::int, substring(d ->> 'episode' from '[Ee](\d+)')::int);
      total := (d ->> 'season_episodes')::int;
      select * into it from tracker_items t
       where t.user_id = me and not t.deleted and t.type in ('show', 'anime') and t.season = s
         and ((idz ? 'imdb' and t.ids ->> 'imdb' = idz ->> 'imdb') or lower(t.title) = lower(ttl))
       order by (t.ids ->> 'imdb' = idz ->> 'imdb') desc nulls last limit 1;
      if not found then
        insert into tracker_items (user_id, id, type, title, year, cover_url, status, progress, progress_total, season, ids, started_at, updated_at)
        values (me, 'p-' || md5(me::text || ':' || typ || ':' || lower(ttl) || ':' || s), typ, left(ttl, 200), (d ->> 'year')::int,
                left(d ->> 'poster', 1000), case when total is not null and coalesce(num, 1) >= total then 'done' else 'active' end,
                coalesce(num, 1), total, s, idz, new.at, new.at)
        on conflict (user_id, id) do nothing;
      else
        update tracker_items set
            progress = greatest(progress, coalesce(num, progress + 1)),
            progress_total = coalesce(progress_total, total),
            status = case when coalesce(progress_total, total) is not null and greatest(progress, coalesce(num, progress + 1)) >= coalesce(progress_total, total) then 'done'
                          when status in ('planned', 'on_hold') then 'active' else status end,
            finished_at = case when coalesce(progress_total, total) is not null and greatest(progress, coalesce(num, progress + 1)) >= coalesce(progress_total, total)
                               then coalesce(finished_at, new.at) else finished_at end,
            started_at = coalesce(started_at, new.at),
            ids = ids || idz, cover_url = coalesce(cover_url, left(d ->> 'poster', 1000)),
            updated_at = greatest(updated_at, now()), synced_at = now()
         where user_id = me and id = it.id;
      end if;
    else
      typ := case new.type when 'movie.watched' then 'movie' when 'book.finished' then 'book' else 'comic' end;
      ttl := coalesce(d ->> 'title', d ->> 'comic');
      if coalesce(ttl, '') = '' then return new; end if;
      select * into it from tracker_items t
       where t.user_id = me and not t.deleted and t.type = typ and t.season is null
         and ((idz ? 'imdb' and t.ids ->> 'imdb' = idz ->> 'imdb') or lower(t.title) = lower(ttl))
       order by (t.ids ->> 'imdb' = idz ->> 'imdb') desc nulls last limit 1;
      if not found then
        insert into tracker_items (user_id, id, type, title, creator, year, cover_url, status, progress, ids, started_at, finished_at, updated_at)
        values (me, 'p-' || md5(me::text || ':' || typ || ':' || lower(ttl)), typ, left(ttl, 200), left(d ->> 'author', 120), (d ->> 'year')::int,
                left(d ->> 'poster', 1000), case when typ = 'comic' then 'active' else 'done' end, 1, idz, new.at,
                case when typ = 'comic' then null else new.at end, new.at)
        on conflict (user_id, id) do update set progress = tracker_items.progress + case when typ = 'comic' then 1 else 0 end,
            updated_at = now(), synced_at = now();
      elsif typ = 'comic' then
        update tracker_items set progress = progress + 1, status = case when status = 'planned' then 'active' else status end,
            updated_at = now(), synced_at = now() where user_id = me and id = it.id;
      else
        update tracker_items set status = 'done', finished_at = coalesce(finished_at, new.at), started_at = coalesce(started_at, new.at),
            progress = coalesce(progress_total, greatest(progress, 1)), ids = ids || idz, updated_at = now(), synced_at = now()
         where user_id = me and id = it.id;
      end if;
    end if;
  exception when others then
    null; -- never block the feed over a malformed event
  end;
  return new;
end $$;

drop trigger if exists tracker_apply_event on public.family_events;
create trigger tracker_apply_event after insert on public.family_events
  for each row execute function public.tracker_apply_event();

revoke all on function public.tracker_find(uuid, jsonb), public.tracker_ensure(uuid, jsonb), public.find_item(jsonb), public.track_items(jsonb), public.set_progress(jsonb), public.get_in_progress(int), public.tracker_ts(text), public.tracker_num(jsonb), public.tracker_apply_event(), public.tracker_item_json(public.tracker_items), public.tracker_me(), public.tracker_push(jsonb),
  public.tracker_pull(timestamptz), public.get_lists(text, boolean), public.get_list_items(text, int, int),
  public.get_watchlist(text, int), public.get_up_next(int), public.get_calendar(int), public.get_calendar_local(int, text), public.starter_lists(), public.get_history(bigint, int),
  public.get_item_progress(jsonb), public.create_list(text, text, boolean), public.add_to_list(text, jsonb),
  public.set_watchlist(jsonb, boolean), public.remove_from_list(text, text), public.rate(text, int), public.set_profile(text, text, boolean),
  public.get_public_list(text), public.get_public_profile(text), public.tracker_connections_status(),
  public.tracker_disconnect(text) from public, anon, authenticated;
grant execute on function public.tracker_push(jsonb), public.tracker_pull(timestamptz), public.get_lists(text, boolean),
  public.get_list_items(text, int, int), public.get_watchlist(text, int), public.get_up_next(int), public.get_calendar(int), public.get_calendar_local(int, text), public.starter_lists(),
  public.get_history(bigint, int), public.get_item_progress(jsonb), public.create_list(text, text, boolean),
  public.add_to_list(text, jsonb), public.set_watchlist(jsonb, boolean), public.find_item(jsonb), public.track_items(jsonb), public.set_progress(jsonb), public.get_in_progress(int), public.remove_from_list(text, text), public.rate(text, int),
  public.set_profile(text, text, boolean), public.tracker_connections_status(), public.tracker_disconnect(text) to authenticated;
-- Shared lists and public profiles open without signing in, and only when their owner made them public.
grant execute on function public.get_public_list(text), public.get_public_profile(text) to anon, authenticated;
-- Only the connect Edge Function (service role) counts lookups.
revoke all on function public.tracker_bump_usage(uuid, text) from public, anon, authenticated;
grant execute on function public.tracker_bump_usage(uuid, text) to service_role;
-- End of the tracker block.
