-- 2026-09-18 — tutor-side deletion as TOMBSTONES (a student, or one attempt).
--
-- ⚠ NOT YET APPLIED. Apply THIS file in the Supabase SQL editor — never re-run
-- schema.sql against live data (its drop-policy preamble is destructive).
-- This file is additive and re-runnable. Apply it BEFORE (or after — both
-- orders are safe, see "deploy order" below) pushing the matching app code.
--
-- WHY A TOMBSTONE AND NOT A DELETE
-- Completed attempt records are immutable: that invariant is what lets the
-- SPR audit and version-pinned Review Mode prove nothing shifted. Deletion
-- must therefore not become a mutation path. Nothing here UPDATEs or DELETEs
-- a record row. Deleting writes a SEPARATE row —
--
--     key         'tomb:attempt:<testId>:<ts>:<rand>'      (one per attempt)
--     key         'tomb:student:AS-XXXXXXXX'                (one per student)
--     owner_code  the student's code
--     value       {"kind":"tombstone","targetKind":…,"target":…,"deletedAt":…,
--                  "deletedBy":<tutor email from the JWT>,"reason":…, plus a
--                  server-copied identity summary of the attempt: testId,
--                  assignmentId, status, attemptKind, setId, conditions,
--                  startedAt, submittedAt — NO answers, NO score, NO name}
--
-- and the attempt row / profile row stay byte-identical. An audit can
-- therefore always tell "removed" (row + tomb row) from "never existed"
-- (no row), and a stray restore cannot resurrect anything: the tomb row is
-- separate from whatever gets restored, fn_upsert_attempt refuses a
-- tombstoned key outright, and a trigger makes tomb rows PERMANENT — no
-- UPDATE or DELETE on a 'tomb:%' key succeeds for anyone, the tutor's own
-- authenticated REST path included. `on conflict do nothing` means
-- re-deleting never overwrites the original who/when. There is no un-delete.
-- (Only the project owner in the SQL editor could disable the trigger; that
-- is the same tier as the old wipe query, and is not reachable from the app.)
--
-- WHY THE TOMBSTONE CANNOT LIVE INSIDE THE RECORD
-- fn_upsert_attempt lets a student replace their own attempt value wholesale
-- (only `released` is server-preserved), so a flag inside the value could
-- be stripped by a late-syncing device. A separate row cannot.
--
-- TUTOR-ONLY, SERVER-ENFORCED
-- fn_tombstone_attempt / fn_tombstone_student are SECURITY DEFINER with
-- EXECUTE revoked from public and anon and granted to `authenticated` only,
-- AND each re-checks the JWT role claim inside the body (definer bypasses
-- RLS, so the grant alone is not the whole story). No anon RPC can write a
-- 'tomb:' key: fn_upsert_attempt requires an 'attempt:' key and fn_insert_bug
-- mints its own 'bug:' key. Individual deletion is FINISHED attempts only,
-- enforced here (the exposed function has no way to say otherwise; the
-- in-progress case exists only inside fn_tombstone_student, through an
-- internal function nobody can EXECUTE). Proof: tests/tombstone.test.js (SQL
-- contract) and tests/tombstone-live-proof.js (anon against the live
-- project). NOTE `authenticated` means "any Supabase Auth user" — keep
-- Authentication → Providers → Email → "Allow new users to sign up" OFF, as
-- Phase H already requires; the tutor account is created by hand.
--
-- A DELETED STUDENT FAILS CLOSED
-- Every student RPC raises 'student deleted' when tomb:student:<code> exists
-- — sign-in (typed code, magic link, saved session), assignments, own
-- attempts, profile, sets, attempt writes, bug reports. The client treats
-- exactly 'student deleted' / 'attempt deleted' as TERMINAL (a queued write
-- is dropped, never retried, and the sync pill says so); every other error
-- keeps its retry/backoff.
--
-- WHAT A DELETED ATTEMPT LOOKS LIKE TO THE STUDENT
-- fn_get_own_attempts excludes any attempt that has a tomb row and returns
-- the student's tomb:attempt rows in the same result set (minus deletedBy —
-- the tutor's email has no business on a student device) — one read, one
-- failure mode — so the client can drop its local copy and still keep the
-- attempt's ASSIGNMENT closed (the summary carries assignmentId + status;
-- without it, removing the record would reopen the assignment for a retake,
-- the bug fixed at 25ef8f7).
--
-- DEPLOY ORDER: APP FIRST, then this migration. App before migration is
-- inert: the dashboard's delete reports "Not deleted — … the server rejected
-- it (HTTP 404)" and no student RPC changes. Migration BEFORE the app is
-- NOT safe: the client at HEAD treats a 400 'student deleted' as an outage
-- and signs a deleted student in from its cached rows, and its sync queue
-- backs a refused write off for ever. So: push, confirm the deploy is live,
-- then apply this file.
--
-- HUMAN CHECKS after both are live. The authenticated tutor call cannot be
-- machine-verified past the password boundary (tests/tombstone-live-proof.js
-- holds only the anon key, so it proves refusals, never permission). Two
-- probes, each ONE action and NON-destructive — nothing real is deleted:
--
--   A. THE TUTOR CALL IS PERMITTED. In the signed-in dashboard on the live
--      site, open the browser console and run:
--        await AttemptStore.adminRpc("fn_tombstone_attempt", { p_key: "attempt:probe:0:zzzz" })
--      It must REJECT with message exactly 'no such attempt'. Only the
--      function body can say that, so the tutor JWT passed the EXECUTE grant
--      and the in-function role gate, and nothing was written (the probe key
--      names no record). 'tutor sign-in required', 'permission denied', or
--      an HTTP 404 mean the grant, the role claim, or the apply is wrong.
--
--   B. MARKERS ARE PERMANENT. In the SQL editor — which runs as the project
--      owner, gated by neither RLS nor grants, so a refusal can only come
--      from the trigger — run these three, one at a time:
--        insert into records (key, owner_code, value) values
--          ('tomb:attempt:probe:0:zzzz', null,
--           '{"kind":"tombstone","targetKind":"attempt","target":"attempt:probe:0:zzzz","probe":true}');
--        delete from records where key = 'tomb:attempt:probe:0:zzzz';
--        update records set updated_at = now() where key = 'tomb:attempt:probe:0:zzzz';
--      The delete and the update must both fail with
--        ERROR:  tombstones are permanent
--      The probe row stays for ever — that is the property being checked.
--      It names no record and no student, so no surface ever shows it.
--
--   C. OPTIONAL full run on a throwaway code that has a finished attempt:
--      dashboard → Attempts → open it → "Delete this attempt…" → type the
--      code → Delete; then
--        select key, owner_code, value ->> 'deletedBy' as deleted_by,
--               value ->> 'deletedAt' as deleted_at, value ->> 'status' as status
--          from records where key like 'tomb:%' order by updated_at desc limit 5;
--      shows tomb:<that key> with deleted_by = YOUR tutor email (stamped by
--      the server from the JWT, never typed by the browser), the attempt row
--      itself still exists unchanged, and signing in as that code in a
--      private window shows no Past card while its assignment still reads
--      Completed.

-- ---------------------------------------------------------------------------
-- 0. helpers
-- ---------------------------------------------------------------------------
-- Is this code retired? Called from every student RPC. `stable` and plain
-- SQL: it runs in the calling definer's context, so no privileges of its own.
create or replace function public.fn_student_deleted(p_code text)
returns boolean
language sql
stable
as $$
  select exists (select 1 from public.records r where r.key = 'tomb:student:' || p_code);
$$;

-- Tombstones are permanent. No path — RPC, the tutor's REST access, a
-- script holding the anon or a user JWT — can UPDATE or DELETE a 'tomb:%'
-- row, or turn another row into one. `on conflict do nothing` never fires
-- an UPDATE, so idempotent re-deletes are unaffected.
create or replace function public.fn_protect_tombstones()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.key like 'tomb:%' then
      raise exception 'tombstones are permanent';
    end if;
    return old;
  end if;
  if old.key like 'tomb:%' or new.key like 'tomb:%' then
    raise exception 'tombstones are permanent';
  end if;
  return new;
end;
$$;

drop trigger if exists records_protect_tombstones on public.records;
create trigger records_protect_tombstones
  before update or delete on public.records
  for each row execute function public.fn_protect_tombstones();

-- ---------------------------------------------------------------------------
-- 1. fn_tombstone_attempt_any — INTERNAL. EXECUTE revoked from every role
--    (anon, authenticated, service_role; see the grants): only
--    fn_tombstone_student reaches it, running as the definer.
--    Marks one attempt deleted with the given reason; never edits or deletes
--    the record; idempotent (an existing marker is returned untouched).
-- ---------------------------------------------------------------------------
create or replace function public.fn_tombstone_attempt_any(p_key text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims   jsonb;
  v_rec      public.records%rowtype;
  v_owner    text;
  v_tomb     jsonb;
begin
  -- the JWT PostgREST verified for this request; anon carries role 'anon'
  v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  if coalesce(v_claims ->> 'role', '') <> 'authenticated' then
    raise exception 'tutor sign-in required';
  end if;
  if p_key is null or p_key not like 'attempt:%' then
    raise exception 'invalid attempt key';
  end if;
  if p_reason is null or p_reason not in ('attempt', 'student') then
    raise exception 'invalid reason';
  end if;

  -- lock the record for the rest of this transaction: the finished-check
  -- below and the marker write see one consistent row
  select * into v_rec from public.records r where r.key = p_key for update;
  if not found then
    raise exception 'no such attempt';
  end if;
  if p_reason = 'attempt'
     and coalesce(v_rec.value ->> 'status', '') not in ('completed', 'timed-out') then
    raise exception 'attempt is in progress';
  end if;

  -- already tombstoned: return the ORIGINAL marker, never a fresh one
  select r.value into v_tomb from public.records r where r.key = 'tomb:' || p_key;
  if found then
    return v_tomb;
  end if;

  v_owner := coalesce(v_rec.owner_code, v_rec.value #>> '{student,key}');
  v_tomb := jsonb_build_object(
    'kind',         'tombstone',
    'targetKind',   'attempt',
    'target',       p_key,
    'code',         v_owner,
    'deletedAt',    now(),
    'deletedBy',    coalesce(v_claims ->> 'email', 'tutor'),
    'reason',       p_reason,
    -- identity summary, copied by the SERVER from the stored record
    'testId',       v_rec.value -> 'testId',
    'assignmentId', v_rec.value -> 'assignmentId',
    'status',       v_rec.value -> 'status',
    'attemptKind',  case when v_rec.value ->> 'kind' = 'set' then 'set' else 'form' end,
    'setId',        v_rec.value -> 'setId',
    'conditions',   v_rec.value -> 'conditions',
    'startedAt',    v_rec.value -> 'startedAt',
    'submittedAt',  v_rec.value -> 'submittedAt');

  insert into public.records (key, owner_code, value, updated_at)
  values ('tomb:' || p_key, v_owner, v_tomb, now())
  on conflict (key) do nothing;

  -- re-read: a concurrent deleter may have won the conflict; theirs stands
  select r.value into v_tomb from public.records r where r.key = 'tomb:' || p_key;
  return v_tomb;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. fn_tombstone_attempt — TUTOR ONLY. Marks ONE FINISHED attempt deleted.
--    The only exposed per-attempt entry point, and it has no reason argument:
--    the finished-only rule cannot be argued away from the client.
-- ---------------------------------------------------------------------------
create or replace function public.fn_tombstone_attempt(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims jsonb;
begin
  -- checked here too, not only inside _any: every exposed tutor function
  -- carries its own refusal, so no future re-wiring can drop it by accident
  v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  if coalesce(v_claims ->> 'role', '') <> 'authenticated' then
    raise exception 'tutor sign-in required';
  end if;
  return public.fn_tombstone_attempt_any(p_key, 'attempt');
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. fn_tombstone_student — TUTOR ONLY. One transaction: a tomb row for
--    every attempt the code owns (in-progress included — the student can no
--    longer sign in to resume it), then the student tomb row. Returns every
--    row it wrote (or found) so the dashboard can mirror them. The profile
--    row and every attempt row stay untouched.
-- ---------------------------------------------------------------------------
create or replace function public.fn_tombstone_student(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims      jsonb;
  v_row         record;
  v_t           jsonb;
  v_attempts    jsonb := '[]'::jsonb;
  v_n           integer := 0;
  v_student     jsonb;
  v_had_profile boolean;
begin
  v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  if coalesce(v_claims ->> 'role', '') <> 'authenticated' then
    raise exception 'tutor sign-in required';
  end if;
  if not public.fn_valid_code(p_code) then
    raise exception 'invalid code';
  end if;

  for v_row in
    select r.key
      from public.records r
     where r.owner_code = p_code
       and r.key like 'attempt:%'
     order by r.key
  loop
    v_t := public.fn_tombstone_attempt_any(v_row.key, 'student');
    v_attempts := v_attempts || jsonb_build_array(jsonb_build_object('key', 'tomb:' || v_row.key, 'value', v_t));
    v_n := v_n + 1;
  end loop;

  select exists (select 1 from public.records r where r.key = 'student:' || p_code) into v_had_profile;

  select r.value into v_student from public.records r where r.key = 'tomb:student:' || p_code;
  if not found then
    v_student := jsonb_build_object(
      'kind',               'tombstone',
      'targetKind',         'student',
      'target',             p_code,
      'code',               p_code,
      'deletedAt',          now(),
      'deletedBy',          coalesce(v_claims ->> 'email', 'tutor'),
      'attemptsTombstoned', v_n,
      'hadProfile',         v_had_profile);
    insert into public.records (key, owner_code, value, updated_at)
    values ('tomb:student:' || p_code, p_code, v_student, now())
    on conflict (key) do nothing;
    select r.value into v_student from public.records r where r.key = 'tomb:student:' || p_code;
  end if;

  return jsonb_build_object('student', v_student, 'attempts', v_attempts);
end;
$$;

-- Grants. Supabase's default privileges hand EXECUTE on new functions to
-- anon, authenticated AND service_role, so every function here is revoked
-- from all three explicitly first (the service key never reaches the
-- browser by design, but "no role" should mean no role).
--   tutor-only : fn_tombstone_attempt, fn_tombstone_student
--   no role    : fn_tombstone_attempt_any (definer-internal), the trigger
--                function, and the fn_student_deleted helper — only the
--                definer's own execution reaches them
revoke all on function public.fn_tombstone_attempt(text)           from public, anon, authenticated, service_role;
revoke all on function public.fn_tombstone_student(text)           from public, anon, authenticated, service_role;
revoke all on function public.fn_tombstone_attempt_any(text, text) from public, anon, authenticated, service_role;
revoke all on function public.fn_protect_tombstones()              from public, anon, authenticated, service_role;
revoke all on function public.fn_student_deleted(text)             from public, anon, authenticated, service_role;
grant execute on function public.fn_tombstone_attempt(text) to authenticated;
grant execute on function public.fn_tombstone_student(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Student RPCs — every one fails closed for a deleted code.
-- ---------------------------------------------------------------------------
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
  if public.fn_student_deleted(p_code) then
    raise exception 'student deleted';
  end if;
  return query
    select r.key, r.value, r.updated_at
      from public.records r
     where r.owner_code = p_code
       and r.key like 'assign:%';
end;
$$;

-- Own attempts, MINUS any with a tomb row, PLUS the tomb:attempt rows (minus
-- deletedBy) — one read so the client learns about a deletion in the same
-- call that would otherwise have returned the record, never from a second
-- call that can fail independently.
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
  if public.fn_student_deleted(p_code) then
    raise exception 'student deleted';
  end if;
  return query
    select r.key,
           case when r.key like 'tomb:%' then r.value - 'deletedBy' else r.value end,
           r.updated_at
      from public.records r
     where r.owner_code = p_code
       and ((r.key like 'attempt:%'
             and not exists (select 1 from public.records t where t.key = 'tomb:' || r.key))
            or r.key like 'tomb:attempt:%');
end;
$$;

create or replace function public.fn_get_profile(p_code text)
returns table (key text, value jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.fn_valid_code(p_code) then
    raise exception 'invalid code';
  end if;
  if public.fn_student_deleted(p_code) then
    raise exception 'student deleted';
  end if;
  return query
    select r.key, r.value, r.updated_at
      from public.records r
     where r.key = 'student:' || p_code
       and r.owner_code = p_code;
end;
$$;

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
  if public.fn_student_deleted(p_code) then
    raise exception 'student deleted';
  end if;
  if p_set_id is null or p_set_id !~ '^pset-[A-Za-z0-9-]{1,64}$' then
    raise exception 'invalid set id';
  end if;
  return query
    select r.key, r.value, r.updated_at
      from public.records r
     where r.key = 'pset:' || p_set_id
       and exists (
         select 1
           from public.records a
          where a.owner_code = p_code
            and a.key like ('assign:' || p_code || ':%')
            and a.value ->> 'kind' = 'set'
            and a.value ->> 'setId' = p_set_id
       );
end;
$$;

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
  if public.fn_student_deleted(p_code) then
    raise exception 'student deleted';
  end if;
  v_key := 'bug:' || floor(extract(epoch from now()))::bigint
                  || '-' || substr(md5(random()::text), 1, 6);
  insert into public.records (key, owner_code, value, updated_at)
  values (v_key, p_code, p_value, now());
  return v_key;
end;
$$;

-- fn_upsert_attempt: the 2026-08-31 body (practice-set release rule intact,
-- client-supplied `released` still ignored) plus two refusals BEFORE any
-- write: a deleted student, and a tombstoned key (a stray restore or a late
-- sync of a deleted attempt is refused; even if it somehow landed, the tomb
-- row is separate and would still stand). tests/set-release-rule.test.js
-- reads THIS file's copy of the release branch, so a restatement that
-- dropped a guard would red that test.
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
  if public.fn_student_deleted(p_code) then
    raise exception 'student deleted';
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
  if exists (select 1 from public.records t where t.key = 'tomb:' || p_key) then
    raise exception 'attempt deleted';
  end if;

  -- Practice-set release rule (2026-08-31, contract 6): released-on-submit,
  -- derived server-side from the SET-ASSIGNMENT row, exactly once — at the
  -- in-progress -> completed/timed-out transition. See that migration for
  -- why the key prefix is the primary discriminator and why the payload
  -- must also carry the set shape.
  if coalesce(v_released, 'false'::jsonb) = 'false'::jsonb
     and p_key like 'attempt:pset-%'
     and p_value ->> 'kind' = 'set'
     and jsonb_typeof(p_value -> 'setQuestions') = 'array'
     and split_part(p_key, ':', 2) = (p_value ->> 'setId')
     and p_value ->> 'status' in ('completed', 'timed-out')
     and coalesce(v_status, '') not in ('completed', 'timed-out') then
    select a.value
      into v_assign
      from public.records a
     where a.owner_code = p_code
       and a.key = 'assign:' || p_code || ':' || (p_value ->> 'assignmentId')
       and a.value ->> 'kind' = 'set'
       and a.value ->> 'setId' = (p_value ->> 'setId');
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

-- grants unchanged from schema.sql / earlier migrations; restated so this
-- file stands alone. Anon keeps EXECUTE on the student RPCs only.
revoke all on function public.fn_get_assignments(text)             from public, anon;
revoke all on function public.fn_get_own_attempts(text)            from public, anon;
revoke all on function public.fn_get_profile(text)                 from public, anon;
revoke all on function public.fn_get_set(text, text)               from public, anon;
revoke all on function public.fn_insert_bug(text, jsonb)           from public, anon;
revoke all on function public.fn_upsert_attempt(text, text, jsonb) from public, anon;
grant execute on function public.fn_get_assignments(text)             to anon, authenticated;
grant execute on function public.fn_get_own_attempts(text)            to anon, authenticated;
grant execute on function public.fn_get_profile(text)                 to anon, authenticated;
grant execute on function public.fn_get_set(text, text)               to anon, authenticated;
grant execute on function public.fn_insert_bug(text, jsonb)           to anon, authenticated;
grant execute on function public.fn_upsert_attempt(text, text, jsonb) to anon, authenticated;
