/* tests/set-audit.test.js — run: node tests/set-audit.test.js

   Contract 3 names three audits — SPR audit, records audit, not-in-library
   check — and requires each to handle set records EXPLICITLY (recognize and
   check them, or skip with an honest labelled reason; a silent pass-over is a
   fail-open). All three live in tests/spr-grading.test.js §5 (the export
   audit): `moved` (SPR grade change), `storedDisagree` (records audit —
   stored verdict vs recomputed), and `unknown`/`setUnresolved` (not-in-
   library). §5 was extended to resolve set-record answers through the
   record's frozen snapshot provenance.

   The SPR audit's set handling was demonstrated in Phase 1. This proves the
   OTHER two, permanently, by running the real audit (as a subprocess, the way
   the audit is meant to be used) against synthesized set-record exports:

   - a set export where every ref resolves and every stored verdict matches
     the recompute  -> PASS (exit 0);
   - a set export with a BANK-sourced ref to a nonexistent qid
     -> the not-in-library check fails closed (exit 1);
   - a set export whose stored `correct` DISAGREES with the recompute
     -> the records audit catches it (exit 1).

   Each set record carries a FORM-sourced SPR ref (the bank ships no SPR key),
   so §5's SPR-only verdict path actually runs on it. */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const repo = path.join(__dirname, "..");
const audit = path.join(__dirname, "spr-grading.test.js");
// a real form SPR question (key "21") — resolved via a set snapshot provenance ref
const FORM = { testId: "202606asiav2", moduleId: "2026-june-asia-v2-math1", qid: "ma1-q3", key: "21" };
const CODE = "AS-7K4M9PXR";

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}

function setRecord(opts){
  // opts: { bankRefMissing?, verdictWrong? }
  const ref = FORM.testId + ":" + FORM.qid;
  const given = "21";                                  // matches the key -> correct
  const setQuestions = [
    { ref: ref, source: "form", testId: FORM.testId, moduleId: FORM.moduleId, qid: FORM.qid, testVersion: "x" }
  ];
  const answers = {
    [ref]: { given: given, firstGiven: given,
      correct: opts.verdictWrong ? false : true,       // stored verdict; recompute says correct
      markedForReview: false, eliminated: [], timeSpentSeconds: 12, visitCount: 1, changeCount: 0, blankReason: null }
  };
  if(opts.bankRefMissing){
    // a bank-sourced ref to a qid that no loaded bank carries -> unresolvable
    const bad = "bank-david-core:q9999";
    setQuestions.push({ ref: bad, source: "bank", bankId: "bank-david-core", qid: "q9999", bankVersion: "sha-x" });
    answers[bad] = { given: "5", firstGiven: "5", correct: true, markedForReview: false,
      eliminated: [], timeSpentSeconds: 8, visitCount: 1, changeCount: 0, blankReason: null };
  }
  return {
    recordVersion: 1, attemptId: "attempt:pset-1:1700000000:aaaa",
    student: { code: CODE, key: CODE }, testId: "pset-1", kind: "set", setId: "pset-1",
    setName: "Audit Set", subject: "math", testVersion: "unversioned",
    status: "completed", released: true, startedAt: "2026-08-31T00:00:00Z",
    setQuestions: setQuestions, answers: answers,
    score: { correct: 1, graded: 1, noKey: 0 }
  };
}

function writeFixture(name, records){
  const p = path.join(os.tmpdir(), "set-audit-" + name + "-" + process.pid + ".json");
  fs.writeFileSync(p, JSON.stringify({ schema: "acestem-attempt-archive-v1", records: records }));
  return p;
}
function runAudit(fixture){
  // SPR_AUDIT_ONLY=1 skips spr-grading's ~11M-comparison sweep so each run is
  // fast; §5 (the audit under test) still runs against the real code.
  const env = Object.assign({}, process.env, { SPR_AUDIT_ONLY: "1" });
  try{ execFileSync("node", [audit, fixture], { cwd: repo, stdio: "pipe", env }); return 0; }
  catch(e){ return e.status || 1; }
}

console.log("--- set records through the real spr-grading export audit ---");

const good = writeFixture("good", [setRecord({})]);
check(runAudit(good) === 0,
  "a set export with resolvable refs and matching verdicts PASSES the audit (set records are graded, not skipped)");

const missing = writeFixture("missing", [setRecord({ bankRefMissing: true })]);
check(runAudit(missing) === 1,
  "NOT-IN-LIBRARY: a set record with an unresolvable bank ref FAILS the audit (fails closed, never silently skipped)");

const wrong = writeFixture("wrong", [setRecord({ verdictWrong: true })]);
check(runAudit(wrong) === 1,
  "RECORDS AUDIT: a set record whose stored verdict disagrees with the recompute FAILS the audit");

[good, missing, wrong].forEach(p => { try{ fs.unlinkSync(p); }catch(e){} });

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
