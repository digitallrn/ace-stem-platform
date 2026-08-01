-- PHASE-H schema — Ace STEM Bluebook Simulator remote backend.
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- SECURITY MODEL (PHASE-H-SPEC §4)
--   tutor    : real Supabase Auth. The `authenticated` role gets full
--              read/write on `records` through RLS policies.
--   students : no accounts. The student code is a bearer secret. The `anon`
--              role gets *no table privileges at all* — only EXECUTE on the
--              four SECURITY DEFINER functions below, each of which scopes
--              every row it touches to the code it was handed.
--
-- The service_role key is never used by this app and must never reach the
-- browser, the repo, or the build.

-- ---------------------------------------------------------------- table --
create table if not exists public.records (
  key         text primary key,          -- 'attempt:...', 'assign:AS-...:a-...', 'bug:...'
  owner_code  text,                      -- student code this row belongs to; null = tutor-global
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists records_owner_code_idx on public.records (owner_code);
create index if not exists records_key_prefix_idx on public.records (key text_pattern_ops);

alter table public.records enable row level security;

-- Tutor (authenticated) — full access. No anon policy exists, so with RLS on
-- and privileges revoked below, anon cannot reach the table by any path.
drop policy if exists records_authenticated_all on public.records;
create policy records_authenticated_all
  on public.records
  for all
  to authenticated
  using (true)
  with check (true);

revoke all on public.records from anon, public;
grant  all on public.records to authenticated;

-- ------------------------------------------------------------- helpers --
-- Student codes are AS- plus 8 unambiguous characters (PHASE-H-SPEC §4).
create or replace function public.fn_valid_code(p_code text)
returns boolean
language sql immutable
as $$
  select p_code ~ '^AS-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$';
$$;

-- ---------------------------------------------------------------- RPCs --
-- Every function is SECURITY DEFINER (runs as owner, bypassing RLS) with a
-- pinned search_path, and filters strictly on owner_code so a code can only
-- ever see or touch its own rows.

-- Assignments for one student.
create or replace function public.fn_get_assignments(p_code text)
returns table (key text, value jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.fn_valid_code(p_code) then
    raise exception 'invalid code';
  end if;
  return query
    select r.key, r.value, r.updated_at
      from public.records r
     where r.owner_code = p_code
       and r.key like 'assign:%';
end;
$$;

-- This student's own attempts (includes the tutor-controlled `released` flag).
create or replace function public.fn_get_own_attempts(p_code text)
returns table (key text, value jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.fn_valid_code(p_code) then
    raise exception 'invalid code';
  end if;
  return query
    select r.key, r.value, r.updated_at
      from public.records r
     where r.owner_code = p_code
       and r.key like 'attempt:%';
end;
$$;

-- Create/update one attempt. Two things this deliberately refuses to do:
--   * touch a row owned by a different code (cross-student write), and
--   * accept `released` from the client — a student must not be able to
--     release their own scores, so the server keeps whatever it already had
--     (false for a new row). Only the tutor, authenticated, can flip it.
create or replace function public.fn_upsert_attempt(p_code text, p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner    text;
  v_released jsonb;
begin
  if not public.fn_valid_code(p_code) then
    raise exception 'invalid code';
  end if;
  if p_key is null or p_key not like 'attempt:%' then
    raise exception 'invalid attempt key';
  end if;

  select r.owner_code, coalesce(r.value -> 'released', 'false'::jsonb)
    into v_owner, v_released
    from public.records r
   where r.key = p_key;

  if v_owner is not null and v_owner <> p_code then
    raise exception 'not your record';
  end if;

  insert into public.records as r (key, owner_code, value, updated_at)
  values (p_key, p_code,
          jsonb_set(p_value, '{released}', coalesce(v_released, 'false'::jsonb), true),
          now())
  on conflict (key) do update
     set value      = jsonb_set(excluded.value, '{released}',
                                coalesce(v_released, 'false'::jsonb), true),
         updated_at = now()
   where r.owner_code = p_code;
end;
$$;

-- File a bug report. The key is generated server-side so one student cannot
-- overwrite another's report by choosing a colliding key.
create or replace function public.fn_insert_bug(p_code text, p_value jsonb)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  if not public.fn_valid_code(p_code) then
    raise exception 'invalid code';
  end if;
  v_key := 'bug:' || floor(extract(epoch from now()))::bigint
                  || '-' || substr(md5(random()::text), 1, 6);
  insert into public.records (key, owner_code, value, updated_at)
  values (v_key, p_code, p_value, now());
  return v_key;
end;
$$;

-- ------------------------------------------------------------- grants --
revoke all on function public.fn_get_assignments(text)            from public, anon;
revoke all on function public.fn_get_own_attempts(text)           from public, anon;
revoke all on function public.fn_upsert_attempt(text, text, jsonb) from public, anon;
revoke all on function public.fn_insert_bug(text, jsonb)          from public, anon;

grant execute on function public.fn_get_assignments(text)             to anon, authenticated;
grant execute on function public.fn_get_own_attempts(text)            to anon, authenticated;
grant execute on function public.fn_upsert_attempt(text, text, jsonb) to anon, authenticated;
grant execute on function public.fn_insert_bug(text, jsonb)           to anon, authenticated;

-- Anon must not be able to enumerate or call anything else.
revoke all on schema public from anon;
grant usage on schema public to anon;
