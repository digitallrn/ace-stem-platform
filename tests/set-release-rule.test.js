/* tests/set-release-rule.test.js — run: node tests/set-release-rule.test.js

   Regression for the adversarial review's release-rule finding (2026-08-31).

   fn_upsert_attempt (supabase/migrations/2026-08-31_practice_sets.sql) derives
   released=true for a practice-SET attempt at its completion transition. The
   flawed first version discriminated set-vs-form by the CLIENT-SUPPLIED
   p_value->>'kind', so a student could POST fn_upsert_attempt directly with
   their real FORM attempt key + form JSON augmented with kind:"set" and a
   genuine set assignmentId, and the server would release their real-test
   scaled score early — breaking contract 6 (server-side release; forms stay
   self-release-forced-false) and ATTEMPTS-SPEC §7 (a client `released` is
   ignored so a student can't self-release).

   This can't run against a live Postgres here, so it checks the fix two ways:
   (1) a MODEL of the release-branch decision, evaluated for both the flawed
       and the fixed guard, proving the exploit flips from RELEASE to NO-RELEASE
       while every legitimate case is unchanged; and
   (2) a TEXTUAL assertion that the real migration's branch is gated on the
       attempt KEY PREFIX (p_key like 'attempt:pset-%') and the setId link, and
       is NOT gated on the forgeable p_value->>'kind' — so reverting the SQL fix
       reds this test. The model would keep passing on its own (it hard-codes
       both guards); (2) is what couples the check to the actual file. */
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}

/* ---- (1) the release-branch decision, as the SQL computes it ----
   inputs mirror fn_upsert_attempt's locals/args. `assignments` is the set of
   assign rows the code owns (owner-scoped, as the SQL subquery is). Returns
   whether `released` is set true on this write. `guard` selects which
   discriminator the branch uses. */
function decideRelease(guard, ctx){
  const { stored_released, stored_status, p_key, p_value, assignments } = ctx;
  if(stored_released !== false) return stored_released;   // server always preserves a set flag
  const statusOk = ["completed", "timed-out"].indexOf(p_value.status) !== -1;
  const transition = ["completed", "timed-out"].indexOf(stored_status || "") === -1;
  if(!statusOk || !transition) return false;
  // the discriminator under test
  const isSet = guard === "flawed"
    ? (p_value.kind === "set")                       // CLIENT payload — forgeable
    : (/^attempt:pset-/.test(p_key));                // KEY prefix — structural
  if(!isSet) return false;
  // assignment lookup (owner-scoped): key = assign:<code>:<assignmentId>, kind set
  const a = assignments.find(x =>
    x.key === "assign:" + ctx.code + ":" + p_value.assignmentId &&
    x.value.kind === "set" &&
    (guard === "fixed" ? x.value.setId === p_value.setId : true));  // fixed adds the setId link
  if(!a) return false;
  if(a.value.holdRelease === true) return false;
  return true;
}

console.log("--- 1. release-branch decision model (flawed vs fixed) ---");
const CODE = "AS-7K4M9PXR";
const realSetAssign = { key: "assign:" + CODE + ":a-set-1",
  value: { kind: "set", setId: "pset-1", assignmentId: "a-set-1" } };

// THE EXPLOIT: form attempt key + form payload wearing kind:"set" + real set assignmentId
const exploit = {
  code: CODE, stored_released: false, stored_status: "in-progress",
  p_key: "attempt:202606asiav1:1700000000:aaaa",         // a FORM key
  p_value: { kind: "set", status: "completed", assignmentId: "a-set-1", setId: "pset-1" },
  assignments: [realSetAssign]
};
check(decideRelease("flawed", exploit) === true,
  "the exploit RELEASES a form attempt under the flawed (client-kind) guard — the bug is real");
check(decideRelease("fixed", exploit) === false,
  "the exploit is REFUSED under the fixed (key-prefix) guard — a form key never triggers set release");

// legitimate set submit: pset key, real assignment naming this set
const legitSet = {
  code: CODE, stored_released: false, stored_status: "in-progress",
  p_key: "attempt:pset-1:1700000000:bbbb",
  p_value: { kind: "set", status: "completed", assignmentId: "a-set-1", setId: "pset-1" },
  assignments: [realSetAssign]
};
check(decideRelease("fixed", legitSet) === true,
  "a genuine set submit still releases under the fixed guard");

// held set: same, but the assignment holds release
const heldSet = JSON.parse(JSON.stringify(legitSet));
heldSet.assignments = [{ key: "assign:" + CODE + ":a-set-1",
  value: { kind: "set", setId: "pset-1", assignmentId: "a-set-1", holdRelease: true } }];
check(decideRelease("fixed", heldSet) === false,
  "a HELD set assignment stays unreleased under the fixed guard");

// a set attempt whose assignment names a DIFFERENT set (setId mismatch) — the
// defence-in-depth link refuses it
const wrongSet = JSON.parse(JSON.stringify(legitSet));
wrongSet.p_value.setId = "pset-OTHER";
check(decideRelease("fixed", wrongSet) === false,
  "fixed guard refuses when the assignment's setId doesn't match the attempt's set");

// plain FORM submit: no kind, form key — never releases under either guard
const formSubmit = {
  code: CODE, stored_released: false, stored_status: "in-progress",
  p_key: "attempt:202606asiav1:1700000000:cccc",
  p_value: { status: "completed", assignmentId: "a-form-1" },
  assignments: [realSetAssign]
};
check(decideRelease("fixed", formSubmit) === false && decideRelease("flawed", formSubmit) === false,
  "a normal form submit never self-releases under either guard (control)");

// forging a pset KEY with a form payload only ever touches a set-keyed record,
// never the student's form record — and still needs a matching set assignment
const forgePsetKey = {
  code: CODE, stored_released: false, stored_status: "in-progress",
  p_key: "attempt:pset-forged:1700000000:dddd",
  p_value: { kind: "set", status: "completed", assignmentId: "a-set-1", setId: "pset-forged" },
  assignments: [realSetAssign]   // assignment is for pset-1, not pset-forged
};
check(decideRelease("fixed", forgePsetKey) === false,
  "forging a pset-keyed record for an unowned set is refused (setId link fails)");

console.log("--- 2. the real migration carries the structural guard ---");
const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations",
  "2026-08-31_practice_sets.sql"), "utf8");
// isolate the release branch: the `if coalesce(v_released ...` up to the
// insert that follows it (skip the leading comment, which mentions the old
// approach it replaced and would otherwise poison the assertions)
const ifIdx = sql.indexOf("if coalesce(v_released");
const insIdx = sql.indexOf("insert into public.records", ifIdx);
const branch = (ifIdx >= 0 && insIdx > ifIdx) ? sql.slice(ifIdx, insIdx) : "";
check(/p_key\s+like\s+'attempt:pset-%'/.test(branch),
  "release branch is gated on the attempt KEY PREFIX (p_key like 'attempt:pset-%')");
check(/a\.value\s*->>\s*'setId'\s*=\s*\(?\s*p_value\s*->>\s*'setId'\s*\)?/.test(branch),
  "release branch cross-checks the assignment's setId against the attempt's setId");
/* the flawed discriminator must be GONE from the branch condition: no
   `and p_value ->> 'kind' = 'set'` guarding the release. (The word "kind"
   still appears in the assignment lookup's `a.value ->> 'kind' = 'set'`, which
   is correct and stays; assert specifically that the CLIENT payload's kind is
   not the release gate.) */
check(!/and\s+p_value\s*->>\s*'kind'\s*=\s*'set'/.test(branch),
  "release branch no longer trusts the client-supplied p_value->>'kind' as the discriminator");

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
