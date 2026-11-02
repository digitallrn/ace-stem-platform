-- 2026-11-02 — assignment options: AUTO SCORE RELEASE for form attempts.
--
-- ⚠ Apply THIS file in the Supabase SQL editor — never re-run schema.sql
-- against live data (its drop-policy preamble is destructive). This file is
-- additive and re-runnable: `create or replace` of ONE function, no table
-- change, no new grant. It restates fn_upsert_attempt exactly as the
-- 2026-09-21 revision of 2026-09-18_tombstones.sql left it (row lock, both
-- deletion refusals, the practice-set release rule, client `released`
-- ignored) and adds one branch.
--
-- WHAT CHANGES
-- An assignment row (assign:<CODE>:<assignmentId>) may now carry
--     "releaseMode": "auto"
-- (absent or anything else ⇒ "manual", today's behaviour). When a FORM
-- attempt makes its in-progress → completed/timed-out transition, and the
-- assignment row it names — owned by the same code, naming the same test
-- as the attempt's own key — says "auto", the server stamps released=true
-- on that write. Nothing else moves: the tutor's Release button keeps
-- working on manual rows, a stored released flag is preserved across
-- rewrites exactly as before, and the client's own `released` value is
-- still discarded on every write.
--
-- WHY THE DECISION IS MADE HERE AND NOT IN THE CLIENT
-- Everything in p_value is student-writable (ATTEMPTS-SPEC §7). A rule that
-- trusted the payload would let a student release their own scores by
-- claiming an auto-release assignment. So the branch reads the ASSIGNMENT
-- ROW — which only the tutor's authenticated table path can write — and
-- binds it three ways: it must belong to this code (owner_code = p_code and
-- the key is built from p_code), it must carry releaseMode 'auto', and its
-- testId must equal the testId in the attempt's KEY (split_part(p_key, ':',
-- 2), the identity every surface trusts — a record whose key and payload
-- disagree on testId is already dropped by the client as forged). The
-- payload's testId must match the key too. A set-shaped payload or a pset-
-- keyed attempt never enters this branch (the set rule above it is the only
-- path for those), and an attempt that is already completed on the server
-- cannot be re-released by rewriting it (the transition guard).
--
-- The client mirrors the same rule in Attempts.finalize — assignment id AND
-- the testId equality, raw strings, exactly as below — for local / artifact
-- / ?devstorage=1 storage, which has no server to derive anything, and as a
-- display convenience in remote mode; this function overwrites whatever it
-- sent, as it always has.
--
-- STATED LIMITS
--   · A student holding an auto-release assignment for test X can obtain
--     the early release of any attempt of X they sit, because the server
--     cannot tell which of their assignments for X a sitting belongs to
--     beyond the assignmentId the client stamps. The dashboard refuses a
--     second ACTIVE assignment of the same test for the same student, so in
--     practice the two do not coexist; a completed manual one followed by an
--     auto one is the tutor's own decision. The leak is of that student's
--     own score for a test the tutor chose to auto-release.
--   · A legacy-id mismatch (assignment testId ≠ the attempt key's testId)
--     refuses the release — fail closed; the tutor releases by hand.
--   · In-progress attempts are never released: status must be 'completed'
--     or 'timed-out' on this write and not already so on the stored row.
--
-- DEPLOY ORDER: either order is safe, and MIGRATION FIRST is preferred.
--   · Migration first: inert until the first row with releaseMode 'auto'
--     exists, and only the new dashboard writes one. Old clients are
--     unaffected (nothing they send or read changes).
--   · App first: a new auto-release assignment's completed attempt is
--     mirrored released locally, then the next pull brings the server's
--     copy (released=false under the old function) and the student loses
--     the card's link until this file is applied. Nothing is lost, but it
--     is a score SHOWN and then withdrawn, not held — which is why
--     migration first is the order to use.
--   So: apply this file, then push. Re-applying is harmless.
--
-- HUMAN CHECKS after both are live (the authenticated tutor path cannot be
-- machine-verified; tests/assignment-options.test.js models this branch and
-- pins its text, tests/set-release-rule.test.js and tests/tombstone.test.js
-- pin the restated guards):
--   F. AUTO-RELEASE, ONE SITTING. Dashboard → Assign: Generate a fresh code,
--      pick ONE test, Category "Practice", Release "Auto-release", Create.
--      Sign that code in on another tab (Copy sign-in link), sit the test
--      (answer anything, Next through every module), Return to Home → Past:
--      the card shows the scaled total and "View Score Details" with NO
--      dashboard action; opening it shows the full report. The dashboard
--      Attempts row for it reads "Released · auto" with a Hide button and
--      no Release button.
--   G. MANUAL, SAME STEPS, Release left at "Manual (release from the
--      dashboard)": after Return to Home the card reads "Scores not released
--      yet" and the dashboard row offers "Release". Press it, Refresh the
--      student's home: the link appears. Together F and G show the server
--      derives the flag from the row, not from the client's submit.

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

  -- FOR UPDATE: the tomb check below must be serialised against a concurrent
  -- fn_tombstone_attempt, which locks this same row first. Without the lock a
  -- submit could read "no marker", block on the insert, and land a COMPLETED
  -- record after the marker was written — a record whose marker says
  -- in-progress, which the client would then treat as a startable assignment
  -- while the student believes they submitted. A row that does not exist yet
  -- locks nothing, and cannot have a marker either (fn_tombstone_attempt
  -- requires the record), so a brand-new attempt is unaffected.
  select r.owner_code,
         coalesce(r.value -> 'released', 'false'::jsonb),
         r.value ->> 'status'
    into v_owner, v_released, v_status
    from public.records r
   where r.key = p_key
     for update;

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

  -- Form auto-release (2026-11-02): derived server-side from the FORM
  -- assignment row the tutor wrote, exactly once — at the same transition.
  -- Never a pset-keyed or set-shaped payload (those take the branch above and
  -- only that one), never an in-progress write, never a re-release of a row
  -- already completed, and the assignment must be this code's, say 'auto',
  -- and name the very test the attempt's KEY names.
  v_assign := null;
  if coalesce(v_released, 'false'::jsonb) = 'false'::jsonb
     and p_key not like 'attempt:pset-%'
     and coalesce(p_value ->> 'kind', '') <> 'set'
     and p_value ->> 'status' in ('completed', 'timed-out')
     and coalesce(v_status, '') not in ('completed', 'timed-out')
     and (p_value ->> 'assignmentId') is not null
     and split_part(p_key, ':', 2) = (p_value ->> 'testId') then
    select a.value
      into v_assign
      from public.records a
     where a.owner_code = p_code
       and a.key = 'assign:' || p_code || ':' || (p_value ->> 'assignmentId')
       and a.value ->> 'releaseMode' = 'auto'
       and coalesce(a.value ->> 'kind', '') <> 'set'
       and a.value ->> 'testId' = split_part(p_key, ':', 2);
    if v_assign is not null then
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

-- grants unchanged; restated so this file stands alone. Anon keeps EXECUTE
-- on the student RPCs only.
revoke all on function public.fn_upsert_attempt(text, text, jsonb) from public, anon;
grant execute on function public.fn_upsert_attempt(text, text, jsonb) to anon, authenticated;
