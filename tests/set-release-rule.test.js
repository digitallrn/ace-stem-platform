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
const keySetId = k => String(k).split(":")[1];   // attempt:<setId>:<epoch>:<rand>
function decideRelease(guard, ctx){
  const { stored_released, stored_status, p_key, p_value, assignments } = ctx;
  if(stored_released !== false) return stored_released;   // server always preserves a stored flag
  const statusOk = ["completed", "timed-out"].indexOf(p_value.status) !== -1;
  const transition = ["completed", "timed-out"].indexOf(stored_status || "") === -1;
  if(!statusOk || !transition) return false;
  /* the branch's entry condition, per guard tier:
     - "flawed"   : the ORIGINAL — trusts the client `kind` field alone.
     - "keyonly"  : the FIRST fix — key prefix (+ assignment setId link below).
                    Still permissive: a form-shaped payload under a pset key
                    with a real set assignment passes.
     - "hardened" : the FINAL fix — key prefix AND set SHAPE (kind:set,
                    setQuestions array, key's own setId == payload setId). */
  let enters;
  if(guard === "flawed") enters = (p_value.kind === "set");
  else if(guard === "keyonly") enters = /^attempt:pset-/.test(p_key);
  else enters = /^attempt:pset-/.test(p_key)
    && p_value.kind === "set"
    && Array.isArray(p_value.setQuestions)
    && keySetId(p_key) === p_value.setId;
  if(!enters) return false;
  // assignment lookup (owner-scoped); the fixes also bind assignment.setId
  const a = assignments.find(x =>
    x.key === "assign:" + ctx.code + ":" + p_value.assignmentId &&
    x.value.kind === "set" &&
    (guard === "flawed" ? true : x.value.setId === p_value.setId));
  if(!a) return false;
  if(a.value.holdRelease === true) return false;
  return true;
}

console.log("--- 1. release-branch decision model (flawed vs key-only vs hardened) ---");
const CODE = "AS-7K4M9PXR";
const realSetAssign = { key: "assign:" + CODE + ":a-set-1",
  value: { kind: "set", setId: "pset-1", assignmentId: "a-set-1" } };

// ORIGINAL EXPLOIT: form attempt key + form payload wearing kind:"set"
const exploitFormKey = {
  code: CODE, stored_released: false, stored_status: "in-progress",
  p_key: "attempt:202606asiav1:1700000000:aaaa",         // a FORM key
  p_value: { kind: "set", status: "completed", assignmentId: "a-set-1", setId: "pset-1",
             setQuestions: [] },
  assignments: [realSetAssign]
};
check(decideRelease("flawed", exploitFormKey) === true,
  "original exploit RELEASES under the flawed (client-kind) guard — bug 1 is real");
check(decideRelease("hardened", exploitFormKey) === false,
  "original exploit REFUSED under the hardened guard — a form key never triggers set release");

/* SECOND EXPLOIT (the user's follow-up): a COPY of an unreleased FORM attempt
   stored UNDER a pset key — form testId, scaled fields, NO set shape (no kind,
   no setQuestions) — with a genuine set assignmentId/setId to satisfy the
   assignment lookup. The key-only fix RELEASES it (that is the new bug); the
   hardened fix REFUSES it because the payload isn't set-shaped. */
const exploitFormUnderPset = {
  code: CODE, stored_released: false, stored_status: "in-progress",
  p_key: "attempt:pset-1:1700000000:eeee",               // a pset KEY
  p_value: { testId: "202606asiav1", status: "completed", assignmentId: "a-set-1",
             setId: "pset-1", score: { correct: 48, scaled: 1400 } },  // FORM-shaped, no kind/setQuestions
  assignments: [realSetAssign]
};
check(decideRelease("keyonly", exploitFormUnderPset) === true,
  "form-shaped payload under a pset key RELEASES under the key-only guard — bug 2 is real");
check(decideRelease("hardened", exploitFormUnderPset) === false,
  "form-shaped payload under a pset key is REFUSED under the hardened guard (no set shape)");

// legitimate set submit: pset key, set shape, real assignment naming this set
const legitSet = {
  code: CODE, stored_released: false, stored_status: "in-progress",
  p_key: "attempt:pset-1:1700000000:bbbb",
  p_value: { kind: "set", status: "completed", assignmentId: "a-set-1", setId: "pset-1",
             setQuestions: [{ ref: "bank-x:q1" }] },
  assignments: [realSetAssign]
};
check(decideRelease("hardened", legitSet) === true,
  "a genuine set submit still releases under the hardened guard");

// held set
const heldSet = JSON.parse(JSON.stringify(legitSet));
heldSet.assignments = [{ key: "assign:" + CODE + ":a-set-1",
  value: { kind: "set", setId: "pset-1", assignmentId: "a-set-1", holdRelease: true } }];
check(decideRelease("hardened", heldSet) === false,
  "a HELD set assignment stays unreleased under the hardened guard");

// key's setId disagrees with payload setId (key attempt:pset-1, payload setId pset-2)
const keyPayloadMismatch = JSON.parse(JSON.stringify(legitSet));
keyPayloadMismatch.p_value.setId = "pset-2";
check(decideRelease("hardened", keyPayloadMismatch) === false,
  "hardened guard refuses when the key's setId and the payload setId disagree");

// setQuestions missing (not an array) — not set-shaped
const noSnapshot = JSON.parse(JSON.stringify(legitSet));
delete noSnapshot.p_value.setQuestions;
check(decideRelease("hardened", noSnapshot) === false,
  "hardened guard refuses a pset-keyed payload with no setQuestions array");

// plain FORM submit: no kind, form key — never releases under any guard
const formSubmit = {
  code: CODE, stored_released: false, stored_status: "in-progress",
  p_key: "attempt:202606asiav1:1700000000:cccc",
  p_value: { status: "completed", assignmentId: "a-form-1" },
  assignments: [realSetAssign]
};
check(decideRelease("hardened", formSubmit) === false && decideRelease("flawed", formSubmit) === false,
  "a normal form submit never self-releases under any guard (control)");

console.log("--- 2. the real migration carries the structural + shape guards ---");
const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations",
  "2026-08-31_practice_sets.sql"), "utf8");
// isolate the release branch: the `if coalesce(v_released ...` up to the
// insert that follows it (skip the leading comment)
const ifIdx = sql.indexOf("if coalesce(v_released");
const insIdx = sql.indexOf("insert into public.records", ifIdx);
const branch = (ifIdx >= 0 && insIdx > ifIdx) ? sql.slice(ifIdx, insIdx) : "";
check(/p_key\s+like\s+'attempt:pset-%'/.test(branch),
  "release branch is gated on the attempt KEY PREFIX (p_key like 'attempt:pset-%')");
check(/jsonb_typeof\s*\(\s*p_value\s*->\s*'setQuestions'\s*\)\s*=\s*'array'/.test(branch),
  "release branch requires the payload to carry a setQuestions ARRAY (set shape)");
check(/split_part\s*\(\s*p_key\s*,\s*':'\s*,\s*2\s*\)\s*=\s*\(?\s*p_value\s*->>\s*'setId'\s*\)?/.test(branch),
  "release branch binds the KEY's own setId to the payload setId (split_part)");
check(/a\.value\s*->>\s*'setId'\s*=\s*\(?\s*p_value\s*->>\s*'setId'\s*\)?/.test(branch),
  "release branch cross-checks the ASSIGNMENT's setId against the payload setId");

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
