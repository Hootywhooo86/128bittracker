-- Two accounts, A and B: each sees and changes only their own Tracker data.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@x.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@x.com') on conflict do nothing;
-- Supabase grants table access to the API roles by default; RLS (no policies) must still block it.
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;
create or replace function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid, false); end $$;

-- ---------- A builds a library ----------
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
set role authenticated;
select public.tracker_push('{
  "items": [
    {"id": "i1", "type": "show", "title": "Severance", "season": 1, "status": "active", "progress": 2, "progress_total": 9,
     "ids": {"imdb": "tt11280740", "tmdb": 95396}, "updated_at": "2026-10-01T00:00:00Z"},
    {"id": "m1", "type": "movie", "title": "Alien", "year": 1979, "status": "planned", "ids": {"imdb": "tt0078748"}, "updated_at": "2026-10-01T00:00:00Z"}
  ],
  "lists": [{"id": "L1", "name": "Sci-fi night", "kind": "movie", "show_in_play": true, "updated_at": "2026-10-01T00:00:00Z"}],
  "list_items": [{"list_id": "L1", "item_id": "m1", "position": 0, "updated_at": "2026-10-01T00:00:00Z"}],
  "trophies": [{"id": "t1", "kind": "vhs", "title": "Alien", "item_id": "m1"}],
  "calendar": []
}'::jsonb || jsonb_build_object('calendar', jsonb_build_array(jsonb_build_object('date', current_date + 10, 'kind', 'episode',
  'title', 'Severance', 'detail', 'S3 E1', 'item_id', 'i1'))));
select pg_temp.expect(jsonb_array_length(public.get_lists()) = 1, 'A sees her list');
select pg_temp.expect(jsonb_array_length(public.get_lists('movie', true)) = 1, 'list filtered by kind + play');
select pg_temp.expect(jsonb_array_length(public.get_lists('book', false)) = 0, 'no book lists');
select pg_temp.expect((public.get_lists() -> 0 ->> 'item_count')::int = 1, 'item_count');
select pg_temp.expect(public.get_list_items('L1') -> 0 -> 'ids' ->> 'imdb' = 'tt0078748', 'list item carries imdb');
select pg_temp.expect(jsonb_array_length(public.get_watchlist()) = 1, 'watchlist = planned');
select pg_temp.expect((public.get_up_next() -> 0 -> 'next' ->> 'number')::int = 3, 'up next is S1 E3');
select pg_temp.expect(jsonb_array_length(public.get_calendar(30)) = 1, 'calendar');
select pg_temp.expect(jsonb_array_length(public.get_item_progress('{"tmdb": 95396}')) = 1, 'progress by tmdb id');

-- Last writer wins: an older copy doesn't overwrite.
select public.tracker_push('{"items": [{"id": "i1", "type": "show", "title": "OLD", "updated_at": "2020-01-01T00:00:00Z"}]}');
select pg_temp.expect(public.get_item_progress('{"imdb": "tt11280740"}') -> 0 ->> 'title' = 'Severance', 'older write ignored');

-- Play adds to a list by ids it knows; same title isn't duplicated.
select pg_temp.expect(public.add_to_list('L1', '{"type": "movie", "title": "Alien", "ids": {"imdb": "tt0078748"}}') ->> 'item_id' = 'm1', 'matched by imdb');
select public.add_to_list('L1', '{"type": "movie", "title": "Dune", "year": 2021, "ids": {"imdb": "tt1160419"}}');
select pg_temp.expect(jsonb_array_length(public.get_list_items('L1')) = 2, 'new title added');
select public.rate('m1', 9);
-- Watchlist from Play's title page: add, don't duplicate, remove only while just planned.
select pg_temp.expect(public.set_watchlist('{"type": "movie", "title": "Arrival", "ids": {"imdb": "tt2543164"}}') ->> 'item_id' is not null, 'watchlisted');
select public.set_watchlist('{"type": "movie", "title": "Arrival", "ids": {"imdb": "tt2543164"}}');
select pg_temp.expect((select count(*) from jsonb_array_elements(public.get_watchlist()) w where w ->> 'title' = 'Arrival') = 1, 'no duplicate');
select public.set_watchlist('{"ids": {"imdb": "tt2543164"}}', false);
select pg_temp.expect((select count(*) from jsonb_array_elements(public.get_watchlist()) w where w ->> 'title' = 'Arrival') = 0, 'off the watchlist');
select public.set_watchlist('{"ids": {"imdb": "tt11280740"}}', false);
select pg_temp.expect(jsonb_array_length(public.get_item_progress('{"imdb": "tt11280740"}')) = 1, 'a show in progress isn''t removed');

-- Direct table access finds nothing, even for the owner (functions only).
select pg_temp.expect((select count(*) from public.tracker_items) = 0, 'RLS hides tables');
do $$ begin
  insert into public.tracker_items (user_id, id, type, title) values ('aaaaaaaa-0000-0000-0000-000000000001', 'x', 'movie', 'x');
  raise exception 'FAILED: direct insert allowed';
exception when insufficient_privilege then null; end $$;

-- Watching in 128bitPlay (family feed) moves the season on; the last episode finishes it.
select public.log_events('[{"id": "p1", "app": "play", "type": "episode.watched", "at": 1790000000000,
  "data": {"show": "Severance", "episode": "S1 E3 · Who Is Alive?", "imdb": "tt11280740", "season_episodes": 9}}]');
select pg_temp.expect((public.get_item_progress('{"imdb": "tt11280740"}') -> 0 ->> 'progress')::numeric = 3, 'episode applied');
select public.log_events('[{"id": "p2", "app": "play", "type": "episode.watched", "at": 1790000001000,
  "data": {"show": "Severance", "season": 1, "number": 9, "imdb": "tt11280740"}}]');
select pg_temp.expect(public.get_item_progress('{"imdb": "tt11280740"}') -> 0 ->> 'status' = 'done', 'finale finishes the season');
select public.log_events('[{"id": "p3", "app": "play", "type": "episode.watched", "at": 1790000002000,
  "data": {"show": "Frieren", "episode": "S1 E1", "anime": true, "season_episodes": 28}}]');
select pg_temp.expect(public.get_up_next() -> 0 ->> 'type' = 'anime', 'anime from Play is anime');
select public.log_events('[{"id": "p4", "app": "play", "type": "movie.watched", "at": 1790000003000, "data": {"title": "Dune", "imdb": "tt1160419"}}]');
select pg_temp.expect(public.get_item_progress('{"imdb": "tt1160419"}') -> 0 ->> 'status' = 'done', 'movie watched');
select pg_temp.expect(jsonb_array_length(public.get_history()) = 4, 'history');
select public.log_events('[{"id": "bad", "app": "play", "type": "episode.watched", "at": 1, "data": {"show": "X", "season": "not a number"}}]');
select pg_temp.expect(jsonb_array_length(public.get_history()) = 5, 'a malformed event never blocks the feed');

-- ---------- B: a separate account ----------
reset role;
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
set role authenticated;
select pg_temp.expect(public.get_lists() = '[]', 'B sees no lists');
select pg_temp.expect(public.get_list_items('L1') = '[]', 'B cannot read A''s list');
select pg_temp.expect(public.get_watchlist() = '[]' and public.get_up_next() = '[]' and public.get_history() = '[]', 'B empty');
select pg_temp.expect(public.get_item_progress('{"imdb": "tt11280740"}') = '[]', 'B cannot see A''s progress');
select pg_temp.expect(public.get_calendar(30) = '[]', 'B calendar empty');
select pg_temp.expect(jsonb_array_length(public.tracker_pull(null) -> 'items') = 0, 'B pulls nothing');
do $$ begin perform public.add_to_list('L1', '{"title": "Hack"}'); raise exception 'FAILED: B added to A''s list';
exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; end $$;
do $$ begin perform public.rate('m1', 1); raise exception 'FAILED: B rated A''s item';
exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; end $$;
select public.remove_from_list('L1', 'm1');
-- Same ids from B make B's own rows.
select public.tracker_push('{"items": [{"id": "i1", "type": "show", "title": "Mine now", "updated_at": "2030-01-01T00:00:00Z"}],
                             "lists": [{"id": "L1", "name": "B list", "updated_at": "2030-01-01T00:00:00Z"}]}');
select public.log_events('[{"id": "p1", "app": "play", "type": "movie.watched", "at": 1790000000000, "data": {"title": "Alien"}}]');
select pg_temp.expect(jsonb_array_length(public.get_lists()) = 1 and public.get_lists() -> 0 ->> 'name' = 'B list', 'B has own list');
select pg_temp.expect(public.tracker_connections_status() = '[]', 'B has no connections');

-- ---------- back to A: untouched ----------
reset role;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
set role authenticated;
select pg_temp.expect(public.get_lists() -> 0 ->> 'name' = 'Sci-fi night', 'A list untouched');
select pg_temp.expect(jsonb_array_length(public.get_list_items('L1')) = 2, 'A list items untouched');
select pg_temp.expect(public.get_item_progress('{"imdb": "tt11280740"}') -> 0 ->> 'title' = 'Severance', 'A item untouched');
select pg_temp.expect((public.get_item_progress('{"imdb": "tt0078748"}') -> 0 ->> 'rating')::int = 9, 'A rating untouched');
select pg_temp.expect((select count(*) from jsonb_array_elements(public.get_watchlist()) w where w ->> 'title' = 'Alien') = 1, 'B watching Alien did not touch A');

-- Tokens are never handed out.
reset role;
insert into public.tracker_connections (user_id, service, access_token, account)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'anilist', 'SECRET', '{"name": "pixelfan"}');
set role authenticated;
select pg_temp.expect(public.tracker_connections_status()::text not like '%SECRET%', 'no tokens out');
select pg_temp.expect(public.tracker_connections_status() -> 0 -> 'account' ->> 'name' = 'pixelfan', 'connection listed');

-- Sharing is opt-in.
select pg_temp.expect(public.get_lists() -> 0 ->> 'share_id' is null, 'private by default');
select public.tracker_push('{"lists": [{"id": "L1", "name": "Sci-fi night", "kind": "movie", "show_in_play": true, "is_public": true, "updated_at": "2026-10-02T00:00:00Z"}]}');
select public.set_profile('pixelfan', 'Pixel Fan', true);
create temp table share as select public.get_lists() -> 0 ->> 'share_id' as id;
grant select on share to anon;
reset role;
set role anon;
select pg_temp.expect(jsonb_array_length(public.get_public_list((select id from share)) -> 'items') = 2, 'public list readable signed out');
select pg_temp.expect(public.get_public_list((select id from share)) -> 'items' -> 0 -> 'rating' is null, 'no private fields in a public list');
select pg_temp.expect((public.get_public_profile('pixelfan') -> 'trophies' ->> 'vhs')::int = 1, 'public profile');
do $$ begin perform public.get_lists(); raise exception 'FAILED: anon read lists';
exception when insufficient_privilege then null; end $$;
reset role;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
set role authenticated;
select public.tracker_push('{"lists": [{"id": "L1", "name": "Sci-fi night", "is_public": false, "updated_at": "2026-10-03T00:00:00Z"}]}');
select public.set_profile(null, null, false);
reset role;
set role anon;
select pg_temp.expect(public.get_public_list((select id from share)) is null, 'private again');
select pg_temp.expect(public.get_public_profile('pixelfan') is null, 'profile private again');

-- Shared-key lookups are counted per account, and only the Edge Function may count them.
reset role;
set role authenticated;
do $$ begin perform public.tracker_bump_usage('bbbbbbbb-0000-0000-0000-000000000002', 'tmdb'); raise exception 'FAILED: a person bumped usage';
exception when insufficient_privilege then null; end $$;
reset role;
set role service_role;
select pg_temp.expect(public.tracker_bump_usage('aaaaaaaa-0000-0000-0000-000000000001', 'tmdb') = 1, 'first lookup');
select pg_temp.expect(public.tracker_bump_usage('aaaaaaaa-0000-0000-0000-000000000001', 'tmdb') = 2, 'counted');
reset role;

-- Deleting the account deletes everything.
reset role;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
set role authenticated;
select public.delete_my_account();
reset role;
select pg_temp.expect((select count(*) from public.tracker_items where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0, 'items gone');
select pg_temp.expect((select count(*) from public.tracker_connections where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0, 'tokens gone');
select pg_temp.expect((select count(*) from public.tracker_items where user_id = 'bbbbbbbb-0000-0000-0000-000000000002') > 0, 'B kept');
