-- Migration — student display-name profiles.
--
-- APPLY THIS FILE, NOT schema.sql. schema.sql opens with `drop ... if exists`
-- and there is live data now; re-running it would destroy records. This
-- migration only adds, and is safe to re-run.
--
-- WHAT THIS IS FOR
-- Students should see their own name, but attempt records must stay
-- pseudonymous (ATTEMPTS-SPEC §7a): a leaked record must read "AS-7K4M9PXR
-- scored 1210", never a name. So the name lives in its OWN row —
--
--     key         'student:AS-7K4M9PXR'
--     owner_code  'AS-7K4M9PXR'
--     value       {"displayName": "Erin K"}
--
-- and nothing ever copies it into an attempt. Attempts, archives and exports
-- stay keyed by code; joining code -> name requires either that student's own
-- code or tutor auth.
--
-- READ path  : fn_get_profile(code) below — anon, scoped to that one code.
-- WRITE path : the tutor's authenticated table access. Deliberately NOT an
--              anon RPC — a student must not be able to rename themselves (or
--              anyone else), and a writable public RPC would also let anyone
--              holding a code plant arbitrary strings into the tutor's
--              dashboard.

-- Returns at most one row: the profile for exactly the code supplied. There is
-- no listing form, so a valid code reveals nothing about any other code.
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
  return query
    select r.key, r.value, r.updated_at
      from public.records r
     where r.key = 'student:' || p_code
       and r.owner_code = p_code;
end;
$$;

revoke all on function public.fn_get_profile(text) from public, anon;
grant execute on function public.fn_get_profile(text) to anon, authenticated;
