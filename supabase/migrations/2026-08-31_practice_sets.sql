-- 2026-08-31 — custom practice sets: student set reads + the server-side
-- release rule.
--
-- ⚠ NOT YET APPLIED. Per the practice-sets stop condition this migration
-- needs David's explicit go before it runs, and his one-click human check of
-- the tutor write path afterward. Apply THIS file in the Supabase SQL
-- editor — never re-run schema.sql against live data (its drop-policy
-- preamble is destructive). This file is additive and re-runnable.
--
-- What it does, and what it deliberately does not:
--
-- 1. fn_get_set — students read a practice set they are assigned.
--    Sets are tutor-authored rows (key 'pset:<setId>', owner_code NULL —
--    tutor-global, like nothing a student owns), written only through the
--    authenticated table path. A student may read exactly the sets that an
--    assignment row for THEIR code references: no enumeration, no reading a
--    set that was never assigned to that code. The set stays MUTABLE — the
--    student resolves the current set at sitting start; the attempt then
--    freezes its own copy (client-side snapshot in the record).
--
-- 2. fn_upsert_attempt — one added rule, everything else byte-identical in
--    behavior. The standing contract holds: the client's `released` is
--    ALWAYS discarded, so a student still cannot self-release a form
--    attempt (or anything else). The addition: when a PRACTICE-SET attempt
--    transitions to completed/timed-out, the server derives released=true
--    from the set-assignment row — unless that row says holdRelease — and
--    it derives it exactly ONCE, at the transition. Deriving only at the
--    transition means a tutor who later un-releases a set attempt is not
--    fought by a late-syncing student device replaying its final write.
--    The rule reads the assignment row (tutor-written, kind='set'), never
--    the client payload, so a crafted record can at most release ITS OWN
--    owner's answers to that owner — which they already have.
--
-- Deploy-order note: the app's set flow in remote mode calls fn_get_set at
-- sitting start, so this migration must be applied BEFORE the practice-sets
-- app code is pushed to production. (Local/devstorage/artifact modes read
-- the row directly and don't need it.)
--
-- After applying, David's one-click check of the tutor write path:
--   1. Dashboard → Practice Sets → create a set, assign it to a fresh code.
--   2. Sit it as that code (remote deployment), submit.
--   3. In the SQL editor:
--        select key,
--               value ->> 'kind'      as kind,
--               value ->> 'status'    as status,
--               value ->> 'released'  as released
--          from records
--         where key like 'attempt:pset-%'
--         order by updated_at desc limit 5;
--      The just-submitted row must show kind=set, status=completed,
--      released=true (or released=false if the assignment was created with
--      "hold release" — then releasing from the dashboard must flip it).
--   4. Sanity: a FORM attempt submitted after the migration still lands
--      released=false.

-- ---------------------------------------------------------------------------
-- 1. fn_get_set(p_code, p_set_id)
-- ---------------------------------------------------------------------------
create or replace function public.fn_get_set(p_code text, p_set_id text)
returns table(key text, value jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.fn_valid_code(p_code) then
    raise exception 'invalid code';
  end if;
  -- setIds are app-minted ('pset-' + timestamp + rand); constrain the shape
  -- so nothing pattern-like ever reaches the key comparison below
  if p_set_id is null or p_set_id !~ '^pset-[A-Za-z0-9-]{1,64}$' then
    raise exception 'invalid set id';
  end if;
  return query
    select r.key, r.value, r.updated_at
      from public.records r
     where r.key = 'pset:' || p_set_id
       and exists (
         -- assigned to THIS code: an assignment row of kind 'set' whose
         -- setId names this set. Assignment rows are tutor-written only
         -- (no anon write path reaches 'assign:%' keys), so this is a
         -- tutor-granted capability, not something a student can mint.
         select 1
           from public.records a
          where a.owner_code = p_code
            and a.key like ('assign:' || p_code || ':%')
            and a.value ->> 'kind' = 'set'
            and a.value ->> 'setId' = p_set_id
       );
end;
$$;

revoke all on function public.fn_get_set(text, text) from public, anon;
grant execute on function public.fn_get_set(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. fn_upsert_attempt — adds the set release rule at the completion
--    transition; client-supplied `released` stays ignored in every case.
-- ---------------------------------------------------------------------------
create or replace function public.fn_upsert_attempt(p_code text, p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner    text;
  v_released jsonb;
  v_status   text;
  v_assign   jsonb;
begin
  if not public.fn_valid_code(p_code) then
    raise exception 'invalid code';
  end if;
  if p_key is null or p_key not like 'attempt:%' then
    raise exception 'invalid attempt key';
  end if;

  select r.owner_code,
         coalesce(r.value -> 'released', 'false'::jsonb),
         r.value ->> 'status'
    into v_owner, v_released, v_status
    from public.records r
   where r.key = p_key;

  if v_owner is not null and v_owner <> p_code then
    raise exception 'not your record';
  end if;

  -- Practice-set release rule (2026-08-31, contract 6): released-on-submit,
  -- derived server-side from the SET-ASSIGNMENT row, exactly once — at the
  -- in-progress -> completed/timed-out transition. Form attempts never take
  -- this branch (their records carry no kind), so their released stays the
  -- stored value / false, exactly as before this migration.
  if coalesce(v_released, 'false'::jsonb) = 'false'::jsonb
     and p_value ->> 'kind' = 'set'
     and p_value ->> 'status' in ('completed', 'timed-out')
     and coalesce(v_status, '') not in ('completed', 'timed-out') then
    select a.value
      into v_assign
      from public.records a
     where a.owner_code = p_code
       and a.key = 'assign:' || p_code || ':' || (p_value ->> 'assignmentId')
       and a.value ->> 'kind' = 'set';
    if v_assign is not null
       and coalesce(v_assign -> 'holdRelease', 'false'::jsonb) <> 'true'::jsonb then
      v_released := 'true'::jsonb;
    end if;
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

-- grants unchanged from schema.sql; restated so this file stands alone
revoke all on function public.fn_upsert_attempt(text, text, jsonb) from public, anon;
grant execute on function public.fn_upsert_attempt(text, text, jsonb) to anon, authenticated;
