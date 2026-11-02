-- 2026-11-02 — partial sittings batch: ONE RELEASE PER AUTO-RELEASE ASSIGNMENT.
--
-- ⚠ Apply THIS file in the Supabase SQL editor — never re-run schema.sql
-- against live data (its drop-policy preamble is destructive). This file is
-- additive and re-runnable: `create or replace` of ONE function, no table
-- change, no new grant. It restates fn_upsert_attempt exactly as
-- 2026-11-02_assignment_options.sql left it (row lock, both deletion
-- refusals, the practice-set release rule, the form auto-release branch,
-- client `released` ignored) and adds ONE guard to the form branch.
--
-- WHAT CHANGES
-- The form auto-release branch already binds the release to the attempt's
-- STAMPED assignmentId: it looks the assignment row up by
--     'assign:' || p_code || ':' || (p_value ->> 'assignmentId')
-- and requires that row to say releaseMode 'auto' and to name the test in
-- the attempt's KEY. A genuine later manual sitting of the same test stamps
-- its own manual row's id, finds a manual row, and is not released — that
-- was already so, and stays so.
--
-- What it did NOT check: whether that auto row had ALREADY released a
-- sitting. A payload stamping the id of a COMPLETED auto row (a forged
-- assignmentId — every field of p_value is student-writable, ATTEMPTS-SPEC
-- §7) was released again. Now an assignment releases AT MOST ONE completed
-- or timed-out attempt, the first: the branch also requires that no OTHER
-- attempt row of this code, completed or timed-out, names that
-- assignmentId. A tombstoned record still counts — markers never remove the
-- record, and a finished deleted sitting keeps its assignment Completed
-- (2026-09-18) — so deleting the first sitting does not reopen the release.
-- A deleted IN-PROGRESS sitting does not count (it was never completed), so
-- the re-sit the tutor asked for by deleting it releases as before.
--
-- A forged assignmentId can still move an attempt visibly into that
-- assignment's bucket on the dashboard (assignmentOf / attemptsForAssignment
-- bucket by the stamped id) — and grants nothing else.
--
-- The `scope` field the partial-sittings batch adds to attempt records is
-- NOT read here: it is a client-written label and filter, never a grant.
-- Nothing a scope says can change what this function releases.
--
-- STATED LIMITS
--   · Archive-then-delete (ATTEMPTS-SPEC §7b) removes finished records from
--     this table. Once the consuming record is gone, a forged id naming that
--     auto row releases again: the guard can only see rows that exist. The
--     assignment row's completedAttemptId hint cannot stand in — students
--     never write assignment rows in remote mode, so it is absent there.
--   · The practice-set release rule is UNCHANGED (restated verbatim): a set
--     assignment is likewise sat once by the client's own rule, but the brief
--     scoped this guard to the form branch, and the set branch keeps the
--     text tests/set-release-rule.test.js pins.
--   · Local / artifact / ?devstorage=1 storage has no server: there the
--     recorder's finalize mirror decides, as it always has.
--
-- DEPLOY ORDER: either order is safe; apply this file FIRST, then push.
--   · This guard is purely restrictive — it refuses one forged case and
--     nothing a genuine sitting does — and the app changes in this batch do
--     not depend on it. Migration first means the forged case is closed
--     before any new row exists; app first costs nothing but leaves it open
--     until the file lands. Re-applying is harmless. Applying it also
--     re-applies the 2026-09-21 and 2026-11-02 bodies it restates.
--
-- HUMAN CHECKS after both are live (the authenticated tutor path and the
-- live RPC cannot be machine-verified from this repo;
-- tests/assignment-options.test.js §3 models the branch and pins this text):
--   H. PARTIAL SITTING, END TO END. Dashboard → Assign: Generate a fresh code,
--      pick ONE test, Category "Practice", Part of the test "Fixed — Math",
--      Create. The Assignments table's Scope column reads "Math". Sign that
--      code in on another tab (Copy sign-in link): the card reads "Math ·
--      2 modules · 44 questions"; Start → the Ready screen names the part;
--      the sitting runs two Math modules with a Module Complete beat and NO
--      break, then submits. Return to Home → Past: the card shows a Math
--      score over 200–800 with "Section only · total —" and a "Math only"
--      badge; Score Details shows TOTAL "—", "Section only", the Math
--      section only, two module strips, Reading and Writing absent from the
--      Knowledge and Skills and the Questions tabs; Download Score Report
--      prints the same. Dashboard → Attempts: the row's Test cell carries
--      the "Math only" badge; the Students card's RW column reads "—".
--      In the SQL editor:
--        select value -> 'scope' as scope,
--               jsonb_array_length(value -> 'modules') as modules,
--               (select count(*) from jsonb_object_keys(value -> 'answers') k where k like 're%') as rw_answers
--          from records where key like 'attempt:%' order by updated_at desc limit 3;
--      The new row shows scope {"modules":["ma1","ma2"],"selectedByStudent":false},
--      modules 2, rw_answers 0.
--   I. STUDENT CHOICE. Same steps with Part of the test "Student chooses"
--      (tick Full test, Reading and Writing, Math) and Timing "Student
--      chooses": the card reads "Full test or a part — you choose"; Start
--      opens "Before You Start" with BOTH blocks; Continue stays disabled
--      until both have a pick; pick Reading and Writing → the record's scope
--      reads {"modules":["re1","re2"],"selectedByStudent":true} and every
--      badge carries "(student-selected)".
--   J. THE GUARD (the forged case, from the SQL editor as the anon role would
--      see it — no app involved). After check F of the previous batch (an
--      auto-release row <AID> whose sitting completed and was released), run:
--        select public.fn_upsert_attempt('<CODE>', 'attempt:<TESTID>:1999999999:zzzz',
--          jsonb_build_object('recordVersion', 1, 'attemptId', 'attempt:<TESTID>:1999999999:zzzz',
--            'student', jsonb_build_object('code', '<CODE>', 'key', '<CODE>'),
--            'testId', '<TESTID>', 'assignmentId', '<AID>', 'status', 'completed',
--            'released', true, 'modules', '[]'::jsonb, 'answers', '{}'::jsonb));
--        select key, value ->> 'released' from records where key = 'attempt:<TESTID>:1999999999:zzzz';
--      Expected: released = false (the row claimed an auto assignment that
--      had already released its one sitting; its own released:true was
--      discarded). Then tombstone that junk row from the dashboard
--      (Attempts → the row → Delete this attempt…) so it is on no student
--      surface. Before this file is applied the same call lands released =
--      true — that is the case this guard closes.

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
  --
  -- One release per assignment (partial sittings batch, 2026-11-02): the
  -- assignment must not already have released a sitting — no OTHER attempt
  -- row of this code, completed or timed-out, may name this assignmentId.
  -- A tombstoned record still counts (its row is never removed; a finished
  -- deleted sitting keeps its assignment Completed); a deleted IN-PROGRESS
  -- sitting does not (it never completed, so the tutor's re-sit releases).
  -- This is what stops a payload stamping a consumed auto row's id from
  -- being released by it; a genuine sitting under its own row is untouched.
  v_assign := null;
  if coalesce(v_released, 'false'::jsonb) = 'false'::jsonb
     and p_key not like 'attempt:pset-%'
     and coalesce(p_value ->> 'kind', '') <> 'set'
     and p_value ->> 'status' in ('completed', 'timed-out')
     and coalesce(v_status, '') not in ('completed', 'timed-out')
     and (p_value ->> 'assignmentId') is not null
     and split_part(p_key, ':', 2) = (p_value ->> 'testId')
     and not exists (
       select 1
         from public.records o
        where o.owner_code = p_code
          and o.key like 'attempt:%'
          and o.key <> p_key
          and o.value ->> 'assignmentId' = (p_value ->> 'assignmentId')
          and o.value ->> 'status' in ('completed', 'timed-out')) then
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
