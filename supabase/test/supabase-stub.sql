-- The bits of Supabase that family.sql and tracker.sql rely on, for testing on plain Postgres.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as
  $$ select jsonb_build_object('sub', auth.uid(), 'is_anonymous', false) $$;
grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
