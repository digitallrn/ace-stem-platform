/* tests/assignment-options.test.js — run: node tests/assignment-options.test.js (repo root)

   Assignment options (2026-11-02): auto score release, the student's timing
   choice, and the pieces of bulk assign that live outside the dashboard's
   write path (tests/tutor-writes.test.js §13 drives the real createAssignment).
   Every check here has a control — a doctored source, a mutated input or a
   pre-change shape — that shows the check goes red when its fix is taken
   away; a check that cannot fail proves nothing.

     §1 AssignmentRules (attempts.js): the ONE reading of releaseMode and
        timingPolicy, total over junk, and its normalisation rules;
     §2 the recorder, run for real: the additive record flag, the auto-release
        mirror at finalize (completed and timed-out only, never in-progress,
        never a mismatched or absent assignment, never a form through the set
        rule), and a student-picked timing that survives suspend → resume →
        finalize on the record alone;
     §3 the server rule: a model of the migration's form auto-release branch
        over every case the brief names (client-asserted released still
        discarded on manual rows), and a TEXTUAL gate on the migration file
        itself, with each guard removed in turn to show the gate is live;
     §4 app.js's start path, run for real: startTestFlowLoaded begins
        nothing without a valid pick for the very assignment, stamps the
        pick and the flag at begin, and the fixed path is unchanged;
        startAssignment routes a student-choice row to the choice screen
        first; resume reads the record, never the assignment (source pins);
     §5 the home sort and the flipped default (nothing assigned → nothing);
     §6 the timing labels: "(student-selected)" only on the literal true,
        closed label table, escaped output, the printed report keeps it;
     §7 the dashboard cells: Auto-released without a button, the
        assignment row's timing text, the record badge;
     §8 the screen and the form: the choice screen exists and starts
        disabled, every interpolation in it is escaped, the test picker is a
        multi-select that lists the whole manifest. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { extractFn, extractConst } = require("./extract-helper");

const repo = path.join(__dirname, "..");
const readLf = p => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
/* To watch these checks fail on the pre-change code (every section must go
   red — that is the proof the checks are live):
     git show <pre-change>:attempts.js  > <scratch>/attempts-pre.js   (and app.js, dashboard.js, index.html, styles.css)
     ATTEMPTS_SRC=… APP_SRC=… DASHBOARD_SRC=… INDEX_SRC=… STYLES_SRC=… ASSIGN_MIG_DIR=<migrations dir without 2026-11-02_assignment_options.sql> node tests/assignment-options.test.js */
const attemptsSrc = readLf(process.env.ATTEMPTS_SRC || path.join(repo, "attempts.js"));
const appSrc = readLf(process.env.APP_SRC || path.join(repo, "app.js"));
const dashSrc = readLf(process.env.DASHBOARD_SRC || path.join(repo, "dashboard.js"));
const indexHtml = readLf(process.env.INDEX_SRC || path.join(repo, "index.html"));
const stylesCss = readLf(process.env.STYLES_SRC || path.join(repo, "styles.css"));
const renderSrc = readLf(path.join(repo, "render.js"));
const MIG_DIR = process.env.ASSIGN_MIG_DIR || path.join(repo, "supabase", "migrations");

let pass = 0, fail = 0;
const failures = [];
let finished = false;
process.on("beforeExit", () => {
  if(finished) return;
  console.log("HARNESS HUNG — a case never settled. " + pass + " passed, " + fail + " failed before it.");
  process.exit(2);
});
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}
function control(ok, label, detail){ check(ok, "control: " + label, detail); }
async function run(title, fn){
  console.log("--- " + title + " ---");
  try{ await fn(); }
  catch(e){ check(false, "case could not run — " + (e && e.stack || e)); }
}

/* ---------- attempts.js in a sandbox (local mode: devstore: keys) ---------- */
function load(opts){
  opts = opts || {};
  const sandbox = {
    localStorage: {
      _d: opts.seed ? Object.assign({}, opts.seed) : {},
      setItem(k, v){ this._d[k] = String(v); }, getItem(k){ return k in this._d ? this._d[k] : null; },
      removeItem(k){ delete this._d[k]; }, key(i){ return Object.keys(this._d)[i]; },
      get length(){ return Object.keys(this._d).length; }
    },
    location: { search: "" },
    document: { addEventListener(){}, createElement: () => ({}) },
    navigator: { userAgent: "node", onLine: true },
    screen: { width: 1, height: 1 },
    hasKey: q => q.correctAnswer !== null && q.correctAnswer !== undefined,
    answerMatches: (q, given) => given === q.correctAnswer,
    setInterval: () => 0, clearInterval(){}, setTimeout: () => 0, clearTimeout(){},
    fetch: () => Promise.reject(new Error("network blocked in test"))
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(attemptsSrc, sandbox);
  return sandbox;
}
const RULES = load().AssignmentRules || { /* pre-change attempts.js: every reader is absent, and each case says so */ };
/* an object-literal method (`    resume(record, stateRef){`) lifted by brace-matching —
   extract-helper's extractFn only knows `function name(` declarations */
function extractMethod(src, name){
  const m = new RegExp("\\n\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{").exec(src);
  if(!m) throw new Error("method not found: " + name);
  let i = m.index + m[0].length, depth = 1;
  while(depth > 0 && i < src.length){ if(src[i] === "{") depth++; else if(src[i] === "}") depth--; i++; }
  return src.slice(m.index, i);
}
const escapeHtml = (() => { const c = { window: {} }; vm.createContext(c); vm.runInContext(renderSrc, c); return c.escapeHtml; })();
const CODE = "AS-7K4M9PXR";
const waitForSave = async (sb, attemptId, predicate) => {
  for(let i = 0; i < 60; i++){
    const raw = sb.localStorage.getItem("devstore:" + attemptId);
    if(raw){ const r = JSON.parse(raw); if(!predicate || predicate(r)) return r; }
    await new Promise(res => setImmediate(res));
  }
  return null;
};
function makeFormTest(){
  return { testId: "202606asiav2", testName: "2026 June Asia v2", testVersion: "2026-08-09-a",
    modules: [{ moduleId: "m1", section: "Math", moduleLabel: "Module 1", timeLimitMinutes: 35,
      questions: [{ id: "ma1-q1", type: "mcq", correctAnswer: 2 }] }] };
}
function makeAppState(test){
  const ms = {};
  test.modules.forEach(m => { ms[m.moduleId] = { answers: {}, flags: new Set(), eliminated: {}, passageHtml: {}, stemHtml: {}, choiceHtml: {}, notes: {} }; });
  return { currentTest: test, moduleIndex: 0, questionIndex: 0, timeRemainingSec: 100, untimed: false, elapsedSec: 0, moduleState: ms };
}
/* the pre-change form record shape, pinned by tests/set-flow.test.js too */
const GOLDEN_FORM_KEYS = ["recordVersion","attemptId","student","testId","testName","testVersion","assignmentId","timing",
  "conditions","startedAt","lastSavedAt","submittedAt","status","released","modules","answers","score","client"].sort();
const keysOf = r => Object.keys(r).sort().join(",");

(async () => {
/* ================= §1 AssignmentRules ================= */
await run("1. AssignmentRules: one reading of releaseMode and timingPolicy", async () => {
  const R = RULES;
  check(typeof R === "object" && typeof R.releaseModeOf === "function" && typeof R.timingPolicyOf === "function", "attempts.js exposes window.AssignmentRules with both readers");
  check(JSON.stringify(R.TIMING_CHOICES) === JSON.stringify([1, 1.5, 2, "untimed"]), "the closed timing list is exactly 1, 1.5, 2, untimed");
  [undefined, null, {}, { releaseMode: "manual" }, { releaseMode: "AUTO" }, { releaseMode: 1 }, { releaseMode: "" }, "auto", 7].forEach(a =>
    check(R.releaseModeOf(a) === "manual", "releaseModeOf is manual for " + JSON.stringify(a)));
  check(R.releaseModeOf({ releaseMode: "auto" }) === "auto", "releaseModeOf is auto only for the literal \"auto\"");

  const fixed = (t, a) => JSON.stringify(R.timingPolicyOf(a)) === JSON.stringify({ mode: "fixed", timing: t });
  check(fixed(1, undefined) && fixed(1, null) && fixed(1, {}) && fixed(1, "junk"), "no row / no policy / junk -> fixed at standard");
  check(fixed(1.5, { timing: 1.5 }) && fixed("untimed", { timing: "untimed" }) && fixed(2, { timing: 2 }), "absent policy -> fixed at the row's Phase G timing (today's rows)");
  check(fixed(1, { timing: 3 }) && fixed(1, { timing: "bogus" }) && fixed(1.5, { timing: "1.5" }), "an unknown fixed value is standard; a numeric string is read");
  check(fixed(2, { timing: 1.5, timingPolicy: { mode: "fixed", timing: 2 } }), "an explicit fixed policy wins over the Phase G field");
  check(fixed(1.5, { timing: 1.5, timingPolicy: { mode: "fixed" } }), "a fixed policy without a timing falls back to the row's timing");
  const sc = R.timingPolicyOf({ timing: null, timingPolicy: { mode: "student-choice", allowed: ["untimed", 3, 1.5, "bogus", "2", null] } });
  check(JSON.stringify(sc) === JSON.stringify({ mode: "student-choice", allowed: [1.5, 2, "untimed"] }),
    "student-choice: unknown entries dropped, exact decimal strings read, canonical order kept", JSON.stringify(sc));
  /* the injection proof's finding (2026-11-02): an entry that merely STARTS
     with a digit must not be parsed into a legal value */
  const sneaky = R.timingPolicyOf({ timingPolicy: { mode: "student-choice", allowed: ['1" onfocus="x', "1.5 anything", "2x", " 2", "1.50", "untimed ", 1.0] } });
  check(JSON.stringify(sneaky) === JSON.stringify({ mode: "student-choice", allowed: [1] }),
    "allowed entries are read EXACTLY (no parseFloat): only the number 1 survives this list", JSON.stringify(sneaky));
  check(R.normTiming("1.5 anything") === 1 && R.normTiming("2x") === 1 && R.normTiming(" 2") === 1 && R.normTiming("1.50") === 1 && R.normTiming("2") === 2,
    "normTiming reads exact spellings only; anything else is standard");
  check(fixed(1.5, { timing: 1.5, timingPolicy: { mode: "student-choice", allowed: [] } }) &&
        fixed(1.5, { timing: 1.5, timingPolicy: { mode: "student-choice", allowed: ["bogus"] } }) &&
        fixed(1.5, { timing: 1.5, timingPolicy: { mode: "student-choice" } }) &&
        fixed(1.5, { timing: 1.5, timingPolicy: { mode: "student-choice", allowed: "untimed" } }),
    "student-choice with nothing valid to choose from falls back to FIXED at the row's timing — never a free pick");
  check(fixed(1, { timingPolicy: { mode: "whatever", allowed: [1.5] } }) && fixed(1, { timingPolicy: "student-choice" }), "an unknown or non-object policy is fixed");
  const frozen = Object.freeze({ timingPolicy: Object.freeze({ mode: "student-choice", allowed: Object.freeze([2]) }) });
  check(JSON.stringify(R.timingPolicyOf(frozen)) === JSON.stringify({ mode: "student-choice", allowed: [2] }), "the reader never mutates its input (frozen row)");
  check(R.normTiming("untimed") === "untimed" && R.normTiming("1.5") === 1.5 && R.normTiming(2) === 2 && R.normTiming("x") === 1 && R.normTiming(undefined) === 1, "normTiming matches timingMultiplier's reading");
  check(R.timingLabel(1) === "" && R.timingLabel(1, true) === "Standard time" && R.timingLabel(1.5) === "Extended time 1.5×" && R.timingLabel(2) === "Extended time 2×" && R.timingLabel("untimed") === "Untimed" && R.timingLabel("<img>") === "",
    "timingLabel: closed table, blank for plain standard, 'Standard time' only when asked, junk is blank");
  /* the exact reader is exported (the radio and the picker read through it:
     junk is "no pick", never Standard), and the choice vocabulary and the
     mark's sentence live here, once */
  check(typeof R.exactTiming === "function" && R.exactTiming("x") === null && R.exactTiming(" 2") === null && R.exactTiming("1.50") === null && R.exactTiming(3) === null &&
        R.exactTiming("1.5") === 1.5 && R.exactTiming("1") === 1 && R.exactTiming(2) === 2 && R.exactTiming("untimed") === "untimed",
    "exactTiming answers null on anything outside the table and the value itself otherwise");
  check(R.choiceLabel(1) === "Standard time" && R.choiceLabel(1.5) === "Time and a half (1.5×)" && R.choiceLabel(2) === "Double time (2×)" && R.choiceLabel("untimed") === "Untimed" && R.choiceLabel("<img>") === "Standard time",
    "choiceLabel: the choice-screen / form vocabulary, closed table");
  check(typeof R.SELECTED_TITLE === "string" && R.SELECTED_TITLE.length > 20 && !/[<>"]/.test(R.SELECTED_TITLE), "SELECTED_TITLE is one plain sentence");
  check(!/function timingBadge\(/.test(appSrc) && !/"Time and a half \(1\.5×\)"/.test(appSrc) && /AssignmentRules\.choiceLabel\(t\)/.test(appSrc) && /AssignmentRules\.SELECTED_TITLE/.test(appSrc) && /AssignmentRules\.SELECTED_TITLE/.test(dashSrc),
    "app.js keeps no copy of the label tables (timingBadge gone, choice labels and the mark's title read from AssignmentRules) and the dashboard shares the title");
  check(/AssignmentRules\.TIMING_CHOICES\.map\(t =>[\s\S]{0,120}AssignmentRules\.choiceLabel\(t\)/.test(extractFn(dashSrc, "viewAssign")), "the form's Fixed-timing options are generated from the closed list and the shared labels");
});

/* ================= §2 the recorder ================= */
await run("2. recorder: the additive flag, the auto-release mirror, the pick surviving resume", async () => {
  /* additive: without the option the record is byte-for-byte the pre-change shape */
  {
    const w = load(); const t = makeFormTest();
    w.Attempts.begin(t, CODE, "self-administered", makeAppState(t), "a-1", 1.5);
    const r = await waitForSave(w, w.Attempts.currentAttemptId());
    check(!!r && keysOf(r) === GOLDEN_FORM_KEYS.join(","), "begin without the option: exactly the golden form keys (no timingSelectedByStudent)", r && keysOf(r));
    check(r.timing === 1.5 && r.released === false, "…timing stamped as given, released false");
  }
  /* the flag: present and true only for the literal true */
  {
    const w = load(); const t = makeFormTest();
    w.Attempts.begin(t, CODE, "proctored", makeAppState(t), "a-2", 2, undefined, { timingSelectedByStudent: true });
    const r = await waitForSave(w, w.Attempts.currentAttemptId());
    check(!!r && r.timingSelectedByStudent === true && r.timing === 2, "begin with the option: timingSelectedByStudent === true beside the chosen timing", JSON.stringify(r && { t: r.timing, s: r.timingSelectedByStudent }));
    check(keysOf(r) === GOLDEN_FORM_KEYS.concat(["timingSelectedByStudent"]).sort().join(","), "…and that is the ONLY new key (strictly additive)", keysOf(r));
    const w2 = load();
    w2.Attempts.begin(t, CODE, "proctored", makeAppState(t), "a-3", 2, undefined, { timingSelectedByStudent: "true" });
    const r2 = await waitForSave(w2, w2.Attempts.currentAttemptId());
    check(!!r2 && !("timingSelectedByStudent" in r2), "a non-boolean option value stamps nothing (strict literal true)");
  }
  /* auto-release mirror at finalize */
  const finish = async (opts, endedBy, assignmentId, setup) => {
    const w = load(); const t = makeFormTest(); const st = makeAppState(t);
    w.Attempts.begin(t, CODE, "self-administered", st, assignmentId, 1);
    const id = w.Attempts.currentAttemptId();
    await waitForSave(w, id);
    w.Attempts.moduleStart(t.modules[0]);
    if(setup) await setup(w, id);
    w.Attempts.moduleEnd(t.modules[0], endedBy || "submitted");
    w.Attempts.finalize(endedBy || "submitted", opts);
    return await waitForSave(w, id, r => r.status !== "in-progress");
  };
  const TID = makeFormTest().testId;           // the key's testId — what the server binds the assignment's testId to
  const rA = await finish({ autoRelease: true, assignmentId: "a-auto", testId: TID }, "submitted", "a-auto");
  check(!!rA && rA.status === "completed" && rA.released === true, "finalize with autoRelease for THIS assignment and THIS test: completed and released (the local-mode rule)", JSON.stringify(rA && { s: rA.status, r: rA.released }));
  const rT = await finish({ autoRelease: true, assignmentId: "a-auto", testId: TID }, "timer-expired", "a-auto");
  check(!!rT && rT.status === "timed-out" && rT.released === true, "…and a timed-out attempt releases too");
  const rM = await finish(undefined, "submitted", "a-man");
  control(!!rM && rM.status === "completed" && rM.released === false, "no option (today's path): completed, NOT released");
  const rF = await finish({ autoRelease: false, assignmentId: "a-man", testId: TID }, "submitted", "a-man");
  check(!!rF && rF.released === false, "autoRelease false: not released");
  const rX = await finish({ autoRelease: true, assignmentId: "a-other", testId: TID }, "submitted", "a-auto");
  check(!!rX && rX.released === false, "autoRelease for a DIFFERENT assignment than the record's: not released");
  const rN = await finish({ autoRelease: true, assignmentId: null, testId: TID }, "submitted", null);
  check(!!rN && rN.released === false, "a sitting with no assignment never auto-releases");
  const rS = await finish({ autoRelease: "true", assignmentId: "a-auto", testId: TID }, "submitted", "a-auto");
  check(!!rS && rS.released === false, "autoRelease must be the literal true");
  /* the server's other equality, mirrored: the assignment's testId must be
     the record's (the key's) — a row still carrying a legacy id is held on
     BOTH sides, never shown here and withdrawn by the next pull */
  const rL = await finish({ autoRelease: true, assignmentId: "a-auto", testId: "2026-june-asia-v2" }, "submitted", "a-auto");
  check(!!rL && rL.released === false, "an assignment whose testId is not the record's (a legacy id): not released locally either");
  const rU = await finish({ autoRelease: true, assignmentId: "a-auto" }, "submitted", "a-auto");
  check(!!rU && rU.released === false, "no testId passed at all: not released (fail closed, like a missing autoRelease)");
  check(/testId: aa\.testId/.test(extractFn(appSrc, "submitModule")), "submitModule passes the active assignment's testId along");
  /* in-progress: the mirror lives in finalize and nowhere else */
  {
    const w = load(); const t = makeFormTest(); const st = makeAppState(t);
    w.Attempts.begin(t, CODE, "self-administered", st, "a-auto", 1);
    const id = w.Attempts.currentAttemptId();
    await waitForSave(w, id);
    w.Attempts.moduleStart(t.modules[0]);
    w.Attempts.answerCommitted("ma1-q1", 2);
    await w.Attempts.suspend({ moduleIndex: 0, questionIndex: 0, timeRemainingSeconds: 50, annotations: {} });
    const r = await waitForSave(w, id, x => !!x.resume);
    check(!!r && r.status === "in-progress" && r.released === false, "an in-progress record (checkpoint + Save and Exit) is never released, auto assignment or not");
    check(!/released\s*=\s*true/.test(extractFn(attemptsSrc, "build")) && !/released/.test(extractFn(attemptsSrc, "positionBlob")), "source: neither build() nor positionBlob() touches released — only finalize does");
  }
  /* a set attempt under the form option: the set rule governs */
  {
    const w = load();
    const setTest = { testId: "pset-9-ab", testName: "Held set", kind: "set", modules: [{ moduleId: "pset-9-ab-m1", section: "Math", moduleLabel: "Module 1", setTitle: "Held set — Math", timeLimitMinutes: 0, questions: [{ id: "202606asiav2:ma1-q1", type: "mcq", correctAnswer: 0 }] }] };
    const st = makeAppState(setTest);
    w.Attempts.begin(setTest, CODE, "self-administered", st, "a-set", "untimed", { kind: "set", setId: "pset-9-ab", setName: "Held set", subject: "math",
      questions: [{ ref: "202606asiav2:ma1-q1", source: "form", testId: "202606asiav2", moduleId: "m1", qid: "ma1-q1", testVersion: "2026-08-09-a" }], releaseOnSubmit: false });
    const id = w.Attempts.currentAttemptId();
    await waitForSave(w, id);
    w.Attempts.moduleStart(setTest.modules[0]); w.Attempts.moduleEnd(setTest.modules[0], "submitted");
    w.Attempts.finalize("submitted", { autoRelease: true, assignmentId: "a-set" });
    const r = await waitForSave(w, id, x => x.status !== "in-progress");
    check(!!r && r.released === false, "a HELD set attempt stays unreleased even if the form option is passed: the form branch is gated on kind !== set");
  }
  /* the pick survives suspend -> resume (new page) -> finalize, read from the record */
  {
    const w = load(); const t = makeFormTest(); const st = makeAppState(t);
    w.Attempts.begin(t, CODE, "proctored", st, "a-pick", 1.5, undefined, { timingSelectedByStudent: true });
    const id = w.Attempts.currentAttemptId();
    await waitForSave(w, id);
    w.Attempts.moduleStart(t.modules[0]);
    await w.Attempts.suspend({ moduleIndex: 0, questionIndex: 0, timeRemainingSeconds: 1234, annotations: {} });
    const saved = await waitForSave(w, id, x => !!x.resume);
    check(!!saved && saved.timing === 1.5 && saved.timingSelectedByStudent === true && saved.resume.timeRemainingSeconds === 1234, "Save and Exit keeps the chosen timing and the flag on the record");
    /* a new page: the record comes back from storage; the assignment is NOT consulted */
    const w2 = load({ seed: w.localStorage._d });
    const record = JSON.parse(w2.localStorage.getItem("devstore:" + id));
    const st2 = makeAppState(t);
    w2.Attempts.resume(record, st2);
    w2.Attempts.moduleStart(t.modules[0]);
    w2.Attempts.moduleEnd(t.modules[0], "submitted");
    w2.Attempts.finalize("submitted", { autoRelease: true, assignmentId: "a-pick", testId: t.testId });
    const done = await waitForSave(w2, id, x => x.status !== "in-progress");
    check(!!done && done.timing === 1.5 && done.timingSelectedByStudent === true && done.status === "completed" && done.released === true && !done.resume,
      "resumed on a new page and finished: timing 1.5 and the flag survive on the record; the sitting completes and (auto) releases", JSON.stringify(done && { t: done.timing, s: done.timingSelectedByStudent, st: done.status, r: done.released }));
    check(!/timingPolicyOf|AssignmentRules|pendingTiming|assignment\.timing/.test(extractMethod(attemptsSrc, "resume")), "source: Attempts.resume reads nothing from an assignment");
  }
});

/* ================= §3 the server rule ================= */
await run("3. fn_upsert_attempt: the form auto-release branch, modelled and pinned to the migration text", async () => {
  /* the branch as the SQL computes it: inputs mirror the function's locals */
  const T = ["completed", "timed-out"];
  function decide(ctx){
    const { stored_released, stored_status, p_key, p_value, assignments, code } = ctx;
    let v = stored_released === undefined ? false : stored_released;     // coalesce(r.value->'released','false')
    const keyTest = String(p_key).split(":")[1];
    if(v === false && !/^attempt:pset-/.test(p_key) && (p_value.kind || "") !== "set" &&
       T.indexOf(p_value.status) !== -1 && T.indexOf(stored_status || "") === -1 &&
       p_value.assignmentId != null && keyTest === p_value.testId){
      const a = assignments.find(x => x.owner === code && x.key === "assign:" + code + ":" + p_value.assignmentId &&
        x.value.releaseMode === "auto" && (x.value.kind || "") !== "set" && x.value.testId === keyTest);
      if(a) v = true;
    }
    return v;                                   // what jsonb_set(p_value,'{released}', v) writes
  }
  const autoRow = { owner: CODE, key: "assign:" + CODE + ":a-auto", value: { assignmentId: "a-auto", testId: "202606asiav1", releaseMode: "auto" } };
  const manRow  = { owner: CODE, key: "assign:" + CODE + ":a-man",  value: { assignmentId: "a-man",  testId: "202606asiav1" } };
  const base = { code: CODE, stored_released: false, stored_status: "in-progress", p_key: "attempt:202606asiav1:1700000000:aaaa",
    p_value: { testId: "202606asiav1", status: "completed", assignmentId: "a-auto", released: false }, assignments: [autoRow, manRow] };
  const vary = o => Object.assign({}, base, o, o.p_value ? { p_value: Object.assign({}, base.p_value, o.p_value) } : {});
  check(decide(base) === true, "completed under an auto row -> released");
  check(decide(vary({ p_value: { status: "timed-out" } })) === true, "timed-out under an auto row -> released");
  check(decide(vary({ p_value: { status: "in-progress" } })) === false, "an in-progress write never releases (checkpoints, Save and Exit)");
  check(decide(vary({ p_value: { assignmentId: "a-man" } })) === false, "under a manual row -> not released");
  check(decide(vary({ p_value: { assignmentId: "a-man", released: true } })) === false, "client-asserted released:true on a manual row is DISCARDED (stored false wins)");
  check(decide(vary({ p_value: { released: true, status: "in-progress" } })) === false, "client-asserted released:true on an in-progress auto write is discarded too");
  check(decide(vary({ stored_released: true, p_value: { assignmentId: "a-man" } })) === true, "a flag the tutor already set is preserved across a rewrite (unchanged rule)");
  check(decide(vary({ stored_status: "completed" })) === false, "a record already completed on the server is not re-released by rewriting it");
  check(decide(vary({ p_value: { testId: "202606asiav2" } })) === false, "payload testId must equal the KEY's testId");
  check(decide(vary({ assignments: [Object.assign({}, autoRow, { value: Object.assign({}, autoRow.value, { testId: "202606asiav2" }) })] })) === false, "the assignment must name the key's test (a legacy-id mismatch fails closed)");
  check(decide(vary({ assignments: [Object.assign({}, autoRow, { owner: "AS-JKLMNPQR" })] })) === false, "another student's auto row never releases this one's attempt");
  check(decide(vary({ p_value: { assignmentId: "a-none" } })) === false && decide(vary({ p_value: { assignmentId: null } })) === false, "no assignment, or one the server does not hold -> not released");
  check(decide(vary({ p_key: "attempt:pset-1:1700000000:bbbb", p_value: { testId: "pset-1" } })) === false, "a pset-keyed attempt never enters the form branch");
  check(decide(vary({ p_value: { kind: "set" } })) === false, "a set-shaped payload never enters the form branch");
  check(decide(vary({ assignments: [Object.assign({}, autoRow, { value: Object.assign({}, autoRow.value, { kind: "set" }) })] })) === false, "a set-kind assignment row never satisfies the form branch");

  /* the real file: newest migration defining fn_upsert_attempt, and the branch's guards */
  const defining = fs.readdirSync(MIG_DIR).filter(f => /\.sql$/.test(f)).sort()
    .filter(f => /create or replace function public\.fn_upsert_attempt\(/.test(readLf(path.join(MIG_DIR, f))));
  const newest = defining[defining.length - 1] || "";
  check(newest === "2026-11-02_assignment_options.sql", "the newest migration defining fn_upsert_attempt is the assignment-options one (ASSIGN_MIG_DIR=<dir without it> reds this)", defining.join(", "));
  const sql = newest ? readLf(path.join(MIG_DIR, newest)) : "";
  const fnStart = sql.indexOf("create or replace function public.fn_upsert_attempt(");
  const fnEnd = sql.indexOf("\n$$;", fnStart);
  const body = fnStart >= 0 && fnEnd > fnStart ? sql.slice(fnStart, fnEnd) : "";
  const at = body.indexOf("-- Form auto-release");
  const ins = body.indexOf("insert into public.records", at);
  const branch = (at >= 0 && ins > at) ? body.slice(at, ins) : "";
  const GUARDS = [
    [/p_key not like 'attempt:pset-%'/, "excludes pset-keyed attempts"],
    [/coalesce\(p_value ->> 'kind', ''\) <> 'set'/, "excludes set-shaped payloads"],
    [/p_value ->> 'status' in \('completed', 'timed-out'\)/, "requires a completed or timed-out status on this write"],
    [/coalesce\(v_status, ''\) not in \('completed', 'timed-out'\)/, "requires the stored row not to be completed already (the transition guard)"],
    [/\(p_value ->> 'assignmentId'\) is not null/, "requires an assignmentId"],
    [/split_part\(p_key, ':', 2\) = \(p_value ->> 'testId'\)/, "binds the payload testId to the KEY's testId"],
    [/a\.owner_code = p_code/, "scopes the assignment row to this code"],
    [/a\.key = 'assign:' \|\| p_code \|\| ':' \|\| \(p_value ->> 'assignmentId'\)/, "looks the assignment up by this code's key"],
    [/a\.value ->> 'releaseMode' = 'auto'/, "requires releaseMode = 'auto' on the ASSIGNMENT row"],
    [/coalesce\(a\.value ->> 'kind', ''\) <> 'set'/, "refuses a set-kind assignment row"],
    [/a\.value ->> 'testId' = split_part\(p_key, ':', 2\)/, "binds the assignment's testId to the KEY's testId"],
    [/coalesce\(v_released, 'false'::jsonb\) = 'false'::jsonb/, "runs only when the stored flag is false (a tutor's release is preserved)"]
  ];
  check(branch.length > 0, "the migration's fn_upsert_attempt carries the form auto-release branch before its insert");
  GUARDS.forEach(([re, what]) => check(re.test(branch), "the branch " + what, re.source));
  /* the write still discards the client's flag: both the insert and the conflict update stamp coalesce(v_released) */
  const writes = body.slice(ins);
  check(/jsonb_set\(p_value, '\{released\}', coalesce\(v_released, 'false'::jsonb\), true\)/.test(writes) &&
        /jsonb_set\(excluded\.value, '\{released\}',\s*coalesce\(v_released, 'false'::jsonb\), true\)/.test(writes),
    "the insert AND the on-conflict update stamp the server's v_released over the payload (client released ignored)");
  /* the restated guards the other suites pin are present here too */
  check(/raise exception 'student deleted'/.test(body) && /raise exception 'attempt deleted'/.test(body) && /for update;/.test(body) && /raise exception 'not your record'/.test(body),
    "the restatement keeps the deleted-student gate, the tomb refusal, the row lock and the owner check");
  /* controls: each guard removed in turn reds its check */
  GUARDS.forEach(([re, what]) => {
    const doctored = branch.replace(re, "true");
    control(!re.test(doctored) && doctored !== branch, "removing the guard that " + what + " is caught");
  });
  control(!/jsonb_set\(p_value, '\{released\}', coalesce\(v_released/.test(writes.replace("coalesce(v_released, 'false'::jsonb), true)", "coalesce(p_value -> 'released', 'false'::jsonb), true)")), "a write that trusted the payload's released would be caught");
  /* the practice-set rule is untouched: tests/set-release-rule.test.js reads the same newest file */
  check(/p_key like 'attempt:pset-%'[\s\S]*jsonb_typeof\(p_value -> 'setQuestions'\) = 'array'/.test(body), "the set release rule still precedes the form branch in the same body");
});

/* ================= §4 app.js's start path ================= */
await run("4. startTestFlowLoaded / startAssignment: nothing starts without a valid pick; the pick is stamped", async () => {
  const SRC = extractFn(appSrc, "startTestFlowLoaded");
  function world(src, assignment, pending){
    const calls = { begin: [], showOnly: [], choice: [], ready: 0 };
    const state = { pendingTiming: pending === undefined ? null : pending, timing: 1, reviewMode: {}, moduleState: null, activeAssignment: null, userName: CODE, sessionGen: 1 };
    const Attempts = { begin: (...a) => calls.begin.push(a) };
    const fn = new Function("state", "Attempts", "showOnly", "setTimeout", "showReady", "openTimingChoice", "AssignmentRules", src + "\nreturn startTestFlowLoaded;")(
      state, Attempts, id => calls.showOnly.push(id), () => 0, () => { calls.ready++; }, (t, a) => calls.choice.push([t, a]), RULES);
    const test = { testId: "202606asiav1", testName: "2026 June Asia v1", modules: [{ moduleId: "m1", questions: [] }] };
    fn(test, assignment);
    return { calls, state };
  }
  const fixedRow = { assignmentId: "a-f", testId: "202606asiav1", category: "practice", timing: 2 };
  {
    const w = world(SRC, fixedRow);
    check(w.calls.begin.length === 1 && w.calls.begin[0][5] === 2 && w.calls.begin[0][7] === undefined && w.calls.begin[0][4] === "a-f" && w.state.timing === 2 && w.calls.showOnly[0] === "screen-loading" && w.calls.choice.length === 0,
      "a fixed row (today's shape): begins at once with the row's timing, no option passed", JSON.stringify(w.calls));
    const w2 = world(SRC, { assignmentId: "a-p", testId: "202606asiav1", category: "test", timingPolicy: { mode: "fixed", timing: "untimed" } });
    check(w2.calls.begin.length === 1 && w2.calls.begin[0][5] === "untimed" && w2.calls.begin[0][2] === "proctored", "an explicit fixed policy: begins with its timing; a test-category row is proctored");
    const w3 = world(SRC, null);
    check(w3.calls.begin.length === 1 && w3.calls.begin[0][5] === 1 && w3.calls.begin[0][4] === null, "no assignment at all: standard timing, as before");
  }
  const choiceRow = { assignmentId: "a-c", testId: "202606asiav1", category: "practice", timing: null, timingPolicy: { mode: "student-choice", allowed: [1.5, "untimed"] } };
  {
    const w = world(SRC, choiceRow, null);
    check(w.calls.begin.length === 0 && w.calls.showOnly.length === 0 && w.calls.choice.length === 1 && w.calls.choice[0][1] === choiceRow && w.state.pendingTiming === null,
      "student-choice with NO pick: begin is never called, the choice screen is opened instead", JSON.stringify(w.calls));
    const w2 = world(SRC, choiceRow, { assignmentId: "a-other", timing: 1.5 });
    check(w2.calls.begin.length === 0 && w2.calls.choice.length === 1 && w2.state.pendingTiming === null, "a pick made for ANOTHER assignment does not start this one (and is dropped)");
    const w3 = world(SRC, choiceRow, { assignmentId: "a-c", timing: 2 });
    check(w3.calls.begin.length === 0 && w3.calls.choice.length === 1, "a pick outside the allowed set does not start the sitting");
    const w4 = world(SRC, choiceRow, { assignmentId: "a-c", timing: 1.5 });
    const b = w4.calls.begin[0];
    check(w4.calls.begin.length === 1 && b[5] === 1.5 && JSON.stringify(b[7]) === JSON.stringify({ timingSelectedByStudent: true }) && b[6] === undefined && w4.state.timing === 1.5 && w4.state.pendingTiming === null && w4.calls.choice.length === 0,
      "a valid pick for THIS assignment: begins with it, passes the flag, consumes the pick", JSON.stringify(w4.calls.begin));
    const w5 = world(SRC, choiceRow, { assignmentId: "a-c", timing: "untimed" });
    check(w5.calls.begin.length === 1 && w5.calls.begin[0][5] === "untimed" && w5.state.timing === "untimed", "untimed is a valid pick when allowed");
  }
  /* control: the guard taken out — the sitting begins on a default the tutor never set */
  {
    const MUT = SRC.replace('if(policy.mode === "student-choice"){', "if(false){");
    control(MUT !== SRC, "the mutant differs from the source");
    const w = world(MUT, choiceRow, null);
    control(w.calls.begin.length === 1 && w.calls.choice.length === 0, "without the guard a student-choice row begins without a pick — which the check above catches", JSON.stringify(w.calls));
  }
  /* startAssignment routes a student-choice row to the choice screen, for both categories */
  {
    const SA = extractFn(appSrc, "startAssignment");
    const mk = () => {
      const calls = { choice: 0, code: 0, flow: 0, home: 0 };
      const fn = new Function("assignmentState", "renderHome", "AssignmentRules", "openTimingChoice", "openStartCode", "startTestFlow", SA + "\nreturn startAssignment;")(
        () => "ready", () => { calls.home++; }, RULES, () => { calls.choice++; }, () => { calls.code++; }, () => { calls.flow++; });
      return { fn, calls };
    };
    const a = mk(); a.fn({}, Object.assign({}, choiceRow, { category: "test" }));
    const b = mk(); b.fn({}, Object.assign({}, choiceRow, { category: "practice" }));
    const c = mk(); c.fn({}, { assignmentId: "x", category: "test", timing: 1 });
    const d = mk(); d.fn({}, { assignmentId: "y", category: "practice", timing: 1.5 });
    check(a.calls.choice === 1 && a.calls.code === 0 && b.calls.choice === 1 && b.calls.flow === 0, "student-choice (test and practice): the choice screen comes first, never the start code or the flow");
    check(c.calls.code === 1 && c.calls.choice === 0 && d.calls.flow === 1 && d.calls.choice === 0, "fixed rows: the start code (test) or the flow (practice), exactly as before");
  }
  /* Continue, run for real: the pick is validated, then the card's gate is
     RE-RUN — the student can leave the screen open past the assignment's
     expiry, and for a practice row this is the last check before begin */
  {
    const CT = extractFn(appSrc, "continueTimingChoice");
    function runContinue(src, stateIn, picked, stOut){
      const calls = { home: 0, show: [], code: 0, flow: 0, err: [] };
      const state = Object.assign({ pendingTiming: null }, stateIn);
      const el = () => ({ set textContent(v){ calls.err.push(v); }, classList: { add(){}, remove(){} } });
      const fn = new Function("state", "el", "pickedTimingChoice", "assignmentState", "renderHome", "showOnly", "openStartCode", "startTestFlow",
        src + "\nreturn continueTimingChoice;")(state, el, () => picked, () => stOut, () => { calls.home++; }, id => calls.show.push(id), () => { calls.code++; }, () => { calls.flow++; });
      fn();
      return { calls, state };
    }
    const pcP = { test: { testId: "t" }, assignment: { assignmentId: "a-c", category: "practice" }, allowed: [1.5, "untimed"] };
    const pcT = { test: { testId: "t" }, assignment: { assignmentId: "a-c", category: "test" }, allowed: [1.5] };
    const exp = runContinue(CT, { pendingChoice: pcP }, 1.5, "expired");
    check(exp.calls.flow === 0 && exp.calls.code === 0 && exp.calls.home === 1 && exp.calls.show[0] === "screen-home" && exp.state.pendingTiming === null && exp.state.pendingChoice === null,
      "an EXPIRED practice assignment: Continue starts nothing, lands home, drops the pick", JSON.stringify(exp.calls));
    const res = runContinue(CT, { pendingChoice: pcP }, 1.5, "resume");
    check(res.calls.flow === 0 && res.calls.code === 0 && res.calls.home === 1, "an assignment that became resumable meanwhile: no second sitting");
    const ok = runContinue(CT, { pendingChoice: pcP }, "untimed", "ready");
    check(ok.calls.flow === 1 && ok.calls.code === 0 && JSON.stringify(ok.state.pendingTiming) === JSON.stringify({ assignmentId: "a-c", timing: "untimed" }) && ok.state.pendingChoice === null,
      "a ready practice assignment: the pick is recorded and the flow starts", JSON.stringify(ok.calls));
    const okT = runContinue(CT, { pendingChoice: pcT }, 1.5, "ready");
    check(okT.calls.code === 1 && okT.calls.flow === 0, "a ready proctored assignment: the start code screen comes next (the code still gates it)");
    const bad = runContinue(CT, { pendingChoice: pcP }, 2, "ready");
    check(bad.calls.flow === 0 && bad.calls.code === 0 && bad.calls.err.length > 0 && bad.state.pendingTiming === null, "a pick outside the allowed set is refused with the error line");
    const none = runContinue(CT, { pendingChoice: null }, 1.5, "ready");
    check(none.calls.flow === 0 && none.calls.code === 0 && none.calls.show.length === 0 && none.calls.home === 0, "no choice context (a second click while the first is already starting): nothing at all happens");
    const MUT = CT.replace('if(assignmentState(pc.assignment) !== "ready"){', "if(false){");
    control(MUT !== CT && runContinue(MUT, { pendingChoice: pcP }, 1.5, "expired").calls.flow === 1, "without the re-check an expired assignment starts — which the check above catches");
    check(/el\("tcContinueBtn"\)\.addEventListener\("click", continueTimingChoice\)/.test(appSrc), "the button is wired to that function");
    check(/AssignmentRules\.exactTiming\(on\.value\)/.test(extractFn(appSrc, "pickedTimingChoice")) && !/normTiming/.test(extractFn(appSrc, "pickedTimingChoice")), "pickedTimingChoice reads the radio through exactTiming (junk is no pick, never Standard)");
  }
  /* openTimingChoice's defensive fallback keeps the start code for a proctored row */
  {
    const OTC = extractFn(appSrc, "openTimingChoice");
    const mk = () => { const calls = { code: 0, flow: 0, shown: [] };
      const fn = new Function("AssignmentRules", "state", "openStartCode", "startTestFlow", "testById", "el", "escapeHtml", "timingChoiceLabel", "timingChoiceNote", "showOnly",
        OTC + "\nreturn openTimingChoice;")(RULES, {}, () => { calls.code++; }, () => { calls.flow++; }, () => null,
          () => ({ textContent: "", innerHTML: "", disabled: false, classList: { add(){} } }), s => String(s), t => String(t), () => "", id => calls.shown.push(id));
      return { fn, calls }; };
    const a = mk(); a.fn({ testId: "t", testName: "T" }, { assignmentId: "x", category: "test", timing: 1 });
    const b = mk(); b.fn({ testId: "t", testName: "T" }, { assignmentId: "y", category: "practice", timing: 1 });
    check(a.calls.code === 1 && a.calls.flow === 0 && a.calls.shown.length === 0 && b.calls.flow === 1 && b.calls.code === 0,
      "a fixed row reaching openTimingChoice takes the fixed route — start code for a proctored row, the flow for practice");
    const c = mk(); c.fn({ testId: "t", testName: "T" }, { assignmentId: "z", category: "practice", timingPolicy: { mode: "student-choice", allowed: [1.5] } });
    check(c.calls.shown[0] === "screen-timing" && c.calls.flow === 0 && c.calls.code === 0, "a student-choice row shows the screen and starts nothing");
  }
  /* every session reset drops both pending fields */
  {
    ["enterTutorSession", "endDeletedSession", "endSittingDeleted"].forEach(n => {
      const src = extractFn(appSrc, n);
      check(/state\.pendingChoice = null/.test(src) && /state\.pendingTiming = null/.test(src), n + " clears both pending fields");
    });
    const so = appSrc.match(/el\("homeSignoutBtn"\)\.addEventListener\("click", \(\)=>\{([\s\S]*?)\n  \}\);/);
    check(!!so && /state\.pendingStart = null/.test(so[1]) && /state\.pendingChoice = null/.test(so[1]) && /state\.pendingTiming = null/.test(so[1]), "Sign out clears pendingStart and both pending fields");
  }
  /* resume reads the record, never the assignment; the policy is read in exactly three places */
  {
    const rs = extractFn(appSrc, "resumeTestFlowLoaded");
    check(/state\.timing = record\.timing \|\| 1/.test(rs) && !/timingPolicyOf|pendingTiming|assignment\.timing/.test(rs), "resumeTestFlowLoaded takes the timing from the record only");
    const sites = (appSrc.match(/AssignmentRules\.timingPolicyOf\(/g) || []).length;
    check(sites === 3, "AssignmentRules.timingPolicyOf is read in exactly three places (startAssignment, startTestFlowLoaded, openTimingChoice)", String(sites));
    const sm = extractFn(appSrc, "submitModule");
    check(/AssignmentRules\.releaseModeOf\(aa\) === "auto"/.test(sm) && /assignmentId: aa\.assignmentId/.test(sm) && /Attempts\.finalize\(endedBy \|\| "submitted", aa \?/.test(sm),
      "submitModule hands finalize the active assignment's release mode AND its id");
    const sc = appSrc.match(/el\("scHomeBtn"\)\.addEventListener\("click", \(\)=>\{([\s\S]*?)\}\);/);
    check(!!sc && /state\.pendingTiming = null/.test(sc[1]), "Return to Home from the start code drops the pick");
    const SCREENS = extractConst(appSrc, "SCREENS");
    check(/"screen-timing"/.test(SCREENS), "screen-timing is in the SCREENS set (showOnly hides it like every other screen)");
  }
});

/* ================= §5 the home sort and the flipped default ================= */
await run("5. home cards sort by display name; nothing assigned -> nothing shown", async () => {
  const body = ["isSetAssign", "testById", "homeSortKey", "sortAssignmentsForHome"].map(n => extractFn(appSrc, n)).join("\n") + "\nreturn sortAssignmentsForHome;";
  const state = { tests: [
    { testId: "b", testName: "2026 June Asia v2", legacyIds: ["old-b"] }, { testId: "a", testName: "2026 June Asia v1", legacyIds: [] },
    { testId: "c", testName: "2025 October US v3", legacyIds: [] }, { testId: "t10", testName: "Test 10", legacyIds: [] }, { testId: "t9", testName: "Test 9", legacyIds: [] }] };
  const sort = new Function("state", body)(state);
  const rows = [
    { assignmentId: "1", testId: "b", category: "practice", assignedAt: "2026-10-02" },
    { assignmentId: "2", testId: "a", category: "practice", assignedAt: "2026-10-01" },
    { assignmentId: "3", kind: "set", setName: "Algebra warm-up", category: "practice", assignedAt: "2026-10-03" },
    { assignmentId: "4", testId: "old-b", category: "practice", assignedAt: "2026-10-01" },
    { assignmentId: "5", testId: "c", category: "practice", assignedAt: "2026-10-04" },
    { assignmentId: "6", testId: "t10", category: "practice" }, { assignmentId: "7", testId: "t9", category: "practice" },
    { assignmentId: "8", testId: "zzz-unpublished", category: "practice" }
  ];
  const before = JSON.stringify(rows);
  const out = sort(rows).map(r => r.assignmentId).join(",");
  check(out === "5,2,4,1,3,7,6,8", "sorted by what the card shows: test names (legacy id resolved), set names, numeric-aware, ties by assignedAt then id", out);
  check(JSON.stringify(rows) === before, "the input list is not mutated");
  check(sort([]).length === 0 && sort(null).length === 0, "empty and null in -> empty out");
  control(rows.map(r => r.assignmentId).join(",") !== out, "the unsorted order differs, so the sort is doing something");
  /* the flipped default is untouched: both sections render an empty state and nothing falls back to 'every test' */
  const ryt = extractFn(appSrc, "renderYourTests"), rac = extractFn(appSrc, "renderActiveCards");
  check(/sortAssignmentsForHome\(\(state\.assignments \|\| \[\]\)\.filter/.test(ryt) && /sortAssignmentsForHome\(\(state\.assignments \|\| \[\]\)\.filter/.test(rac), "both home sections sort what they already filtered");
  check(/You Have No Upcoming Tests/.test(ryt) && /No Practice Tests/.test(rac) && !/state\.tests\b/.test(rac) && !/state\.tests\b/.test(ryt), "both keep their empty states and never read state.tests (no 'every published test' fallback)");
  const w = load();
  const list = await w.Attempts.assignments(CODE);
  check(Array.isArray(list) && list.length === 0, "Attempts.assignments for a never-configured code is [] (nothing assigned -> nothing shown), run for real");
});

/* ================= §6 timing labels ================= */
await run("6. the record's timing badge: (student-selected) only on the literal true, closed table, escaped", async () => {
  const body = ["studentSelectedTiming", "timingBadgeFor", "timingBadgeHtml"].map(n => extractFn(appSrc, n)).join("\n") + "\n" + extractConst(appSrc, "SELECTED_MARK") + "\nreturn { timingBadgeFor, timingBadgeHtml };";
  const T = new Function("AssignmentRules", "escapeHtml", body)(RULES, escapeHtml);
  check(T.timingBadgeHtml({ timing: 1 }) === "" && T.timingBadgeFor({ timing: 1 }) === null, "plain standard timing: no badge (as today)");
  check(T.timingBadgeHtml({ timing: 1.5 }) === "Extended time 1.5×", "a fixed accommodation: the Phase G label alone");
  const sel = T.timingBadgeHtml({ timing: 1, timingSelectedByStudent: true });
  check(/^Standard time <span class="sd-sel" title="[^"]+">\(student-selected\)<\/span>$/.test(sel), "student-selected standard: 'Standard time' plus the honest mark with its reason in the title", sel);
  check(/^Untimed <span class="sd-sel"/.test(T.timingBadgeHtml({ timing: "untimed", timingSelectedByStudent: true })), "student-selected untimed carries the mark too");
  check(T.timingBadgeHtml({ timing: 1.5, timingSelectedByStudent: "true" }) === "Extended time 1.5×" && T.timingBadgeHtml({ timing: 1.5, timingSelectedByStudent: 1 }) === "Extended time 1.5×", "the flag counts only as the literal true");
  check(T.timingBadgeHtml({ timing: '"><img src=x onerror=alert(1)>', timingSelectedByStudent: true }) === sel.replace("Standard time", "Standard time") && T.timingBadgeHtml({ timing: "<b>x</b>" }) === "", "a hostile timing value never reaches the markup (closed table)");
  check(T.timingBadgeHtml(null) === "" && T.timingBadgeHtml(undefined) === "", "no record -> nothing");
  /* the surfaces: Past card, Score Details hero (which the printed report is), the dashboard rows */
  const rsd = extractFn(appSrc, "renderScoreDetails");
  check(/const badgeHtml = timingBadgeHtml\(record\)/.test(rsd) && /<span class="sd-badge">' \+ badgeHtml \+ '<\/span>/.test(rsd), "Score Details renders the record's badge html in its hero line");
  const rpc = extractFn(appSrc, "renderPastCards");
  check(/const badgeHtml = timingBadgeHtml\(record\)/.test(rpc) && /<div class="pcard-badge">\$\{badgeHtml\}<\/div>/.test(rpc), "the Past card renders it too");
  const print = stylesCss.slice(stylesCss.indexOf("@media print{"));
  const hidden = (print.match(/\.sd-home, \.sd-hero-actions[^{]*\{ display:none/) || [""])[0];
  check(!/\.sd-hero-sub/.test(hidden) && /\.sd-hero-sub/.test(print), "the printed report keeps the hero line (and so the timing and its mark)");
  check(/\.sd-sel\{/.test(stylesCss), "the mark has a style");
  check(!/timingBadge\(record\.timing\)/.test(appSrc), "no surface still calls the bare Phase G badge with the value alone (every record surface sees the flag)");
});

/* ================= §7 dashboard cells ================= */
await run("7. dashboard: Auto-released without a button; assignment timing text; the record badge", async () => {
  const FNS = ["releaseCell", "assignmentOf", "assignTimingText", "releaseModeText", "timingBadgeHtml", "timingLabel", "isTombstoned", "tombFor", "isDeletedStudent"];
  const body = "let tombs = {}, assigns = [], recs = [];\n" +
    "const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');\n" +
    "const escAttr = s => esc(s).replace(/\"/g,'&quot;').replace(/'/g,'&#39;');\n" +
    FNS.map(n => extractFn(dashSrc, n)).join("\n") +
    "\nreturn { releaseCell, assignTimingText, timingBadgeHtml, releaseModeText, assignmentOf, set(o){ Object.assign({ }, o); if(o.assigns) assigns = o.assigns; if(o.tombs) tombs = o.tombs; } };";
  const D = new Function("AssignmentRules", body)(RULES);
  const T1 = "202606asiav1";
  D.set({ assigns: [{ code: CODE, list: [
    { assignmentId: "a-auto", testId: T1, category: "practice", releaseMode: "auto" },
    { assignmentId: "a-man", testId: T1, category: "practice" } ] }] });
  const rec = (aid, released, extra) => Object.assign({ attemptId: "attempt:" + T1 + ":1:" + aid, student: { code: CODE, key: CODE }, testId: T1, status: "completed", assignmentId: aid, released }, extra || {});
  const autoRel = D.releaseCell(rec("a-auto", true));
  check(/Released · auto/.test(autoRel) && !/>Release</.test(autoRel) && !/Released ✓/.test(autoRel) && /<button[^>]*data-rel="attempt:202606asiav1:1:a-auto"[^>]*>Hide<\/button>/.test(autoRel),
    "an auto row's released attempt: 'Released · auto', no Release button, a Hide button (un-release stays reachable)", autoRel);
  check(!/automatically/.test(autoRel), "the badge states a fact about the assignment, not who released the record");
  check(/<button[^>]*>Release<\/button>/.test(D.releaseCell(rec("a-auto", false))), "an auto row's UNRELEASED attempt keeps the manual button (the tutor's way to finish the job)");
  check(/<button[^>]*>Released ✓<\/button>/.test(D.releaseCell(rec("a-man", true))) && /<button[^>]*>Release<\/button>/.test(D.releaseCell(rec("a-man", false))), "a manual row's attempt keeps the button either way (control)");
  check(/<button/.test(D.releaseCell(rec("a-gone", true))) && /<button/.test(D.releaseCell(rec(null, true))), "no assignment row found, or none named: the button stays");
  check(D.releaseCell(rec("a-auto", true, { status: "in-progress" })) === "—", "an in-progress attempt has no release cell at all");
  check(D.releaseCell(rec("a-auto", "true")) !== autoRel && !/Released · auto/.test(D.releaseCell(rec("a-auto", "true"))) && /<button[^>]*>Released ✓<\/button>/.test(D.releaseCell(rec("a-auto", "true"))),
    "released must be the literal true for the auto cell (a string lands on the plain toggle)");
  check(D.assignmentOf(rec("a-auto", true)).assignmentId === "a-auto" && D.assignmentOf(rec("a-x", true)) === null && D.assignmentOf({ assignmentId: "a-auto" }) === null, "assignmentOf: the row by code + id, null otherwise");
  check(D.assignTimingText({ timing: 1.5 }) === "Extended time 1.5×" && D.assignTimingText({}) === "Standard" && D.assignTimingText({ timing: null, timingPolicy: { mode: "student-choice", allowed: [1, "untimed"] } }) === "Student chooses: standard, untimed" &&
        D.assignTimingText({ timingPolicy: { mode: "student-choice", allowed: [1.5, 2] } }) === "Student chooses: 1.5×, 2×", "the Assignments table's timing text: fixed label, Standard, or the student's options");
  check(D.releaseModeText({ releaseMode: "auto" }) === "Auto-release" && D.releaseModeText({}) === "Manual", "the Release column text");
  const badge = D.timingBadgeHtml({ timing: 2, timingSelectedByStudent: true });
  check(/Extended time 2×/.test(badge) && /\(student-selected\)/.test(badge) && !/\(student-selected\)/.test(D.timingBadgeHtml({ timing: 2 })) && D.timingBadgeHtml({ timing: 1 }) === "" && /Standard time/.test(D.timingBadgeHtml({ timing: 1, timingSelectedByStudent: true })),
    "the dashboard record badge carries the mark on the literal true only, and 'Standard time' when selected", badge);
  check(D.timingBadgeHtml(null) === "" && D.timingBadgeHtml(undefined) === "" && D.timingBadgeHtml({}) === "", "no record, or one with no timing: nothing");
  check(D.timingBadgeHtml({ timing: "<img src=x>", timingSelectedByStudent: true }).indexOf("<img") === -1, "a hostile timing value never reaches the markup");
  check(badge.indexOf(RULES.SELECTED_TITLE) !== -1, "the dashboard mark carries the shared title sentence");
  /* the three record surfaces pass the RECORD now, not the bare value */
  const bare = (dashSrc.match(/timingBadgeHtml\(r\.timing\)/g) || []).length;
  check(bare === 0 && (dashSrc.match(/timingBadgeHtml\(r\)/g) || []).length >= 3, "viewAttempts, the detail pane and the set attempts table hand the record to the badge", String(bare));
  const va = extractFn(dashSrc, "viewAssign");
  check(/assignTimingText\(a\)/.test(va) && /<th>Timing<\/th><th>Release<\/th>/.test(va) && /Auto-release<\/span>/.test(va), "the Assignments table shows the timing text and a Release column that says Auto-release");
  check(/const isSet = a\.kind === "set"/.test(va) && /Held — release manually/.test(va) && /Releases on submit/.test(va) && /a\.timeLimitMinutes/.test(va) && /a\.setName \|\| a\.setId/.test(va),
    "a practice-SET row in that table prints the set's own name, limit and release rule — never 'Manual' from releaseMode");
});

/* ================= §8 the screen and the form ================= */
await run("8. the choice screen and the bulk form: present, disabled until a pick, escaped, untruncated", async () => {
  check(/<div id="screen-timing" class="hidden">/.test(indexHtml) && /id="tcOptions"/.test(indexHtml) && /id="tcError"/.test(indexHtml) && /id="tcHomeBtn"/.test(indexHtml),
    "index.html carries the timing-choice screen with its options, error and home controls");
  check(/<button class="pill yellow sc-start" id="tcContinueBtn" disabled>Continue<\/button>/.test(indexHtml), "Continue starts DISABLED in the markup");
  const otc = extractFn(appSrc, "openTimingChoice");
  const interps = otc.match(/\$\{[^}]*\}/g) || [];
  check(interps.length >= 3 && interps.every(x => /^\$\{escapeHtml\(/.test(x)), "every interpolation in the choice screen's innerHTML goes through escapeHtml", interps.join(" "));
  check(/el\("tcTestName"\)\.textContent = /.test(otc) && /el\("tcContinueBtn"\)\.disabled = true/.test(otc), "the test name is set as text and Continue is re-disabled on every open");
  check(/el\("tcOptions"\)\.addEventListener\("change", \(\)=>\{\s*el\("tcContinueBtn"\)\.disabled = pickedTimingChoice\(\) === null;/.test(appSrc), "Continue enables only once a radio is on");
  check(/#screen-timing\{/.test(stylesCss) && /\.tc-opt\{/.test(stylesCss), "the screen has its styles");
  /* the dashboard form */
  const va = extractFn(dashSrc, "viewAssign");
  check(/<select id="afTest" class="af-multi" multiple size="\$\{Math\.min\(Math\.max\(manifestTests\.length, 4\), 14\)\}">\$\{manifestTests\.map\(/.test(va), "the Test control is a multi-select sized to the manifest (every test listed, up to 14 rows visible, then scrolling — never truncated)");
  check(/id="afSelAll"/.test(va) && /id="afSelUnsat"/.test(va) && /id="afRelease"/.test(va) && /id="afTimingMode"/.test(va) && /id="afAllow1" checked/.test(va) && /id="afAllowU" checked/.test(va),
    "Select all, Select all not yet sat, the release-mode control, the timing mode and the four allowed boxes are in the form");
  check(/<option value="manual">[^<]*<\/option>\s*<option value="auto">/.test(va) && /<option value="fixed">[^<]*<\/option>\s*<option value="student-choice">/.test(va), "manual and fixed are the first (default) options");
  const KV = extractConst(dashSrc, "KEPT_VALUES"), KC = extractConst(dashSrc, "KEPT_CHECKS"), KM = extractConst(dashSrc, "KEPT_MULTI");
  check(/"afRelease"/.test(KV) && /"afTimingMode"/.test(KV) && /"afAllow1"/.test(KC) && /"afAllowU"/.test(KC) && /"afTest"/.test(KM), "the new controls survive a re-render (renderKeepingInputs lists)");
  const ca = extractFn(dashSrc, "createAssignment");
  const code = ca.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");   // comments mention "await" too
  const firstAwait = code.search(/\bawait\s+\w/);
  const reads = ["formTests()", "$(\"afRelease\")", "$(\"afTimingMode\")", "$(\"afAllow1\")", "activeAssignmentFor("];
  check(firstAwait > 0 && /await saveProfiles\(/.test(code.slice(firstAwait, firstAwait + 24)) && reads.every(r => code.indexOf(r) !== -1 && code.indexOf(r) < firstAwait),
    "createAssignment reads every new control and decides the plan BEFORE its first await (a Refresh landing mid-write cannot change what is written)", String(firstAwait));
  check(/timing: studentChoice \? null : timing/.test(ca) && /timingPolicy: timingPolicy/.test(ca) && /releaseMode: releaseMode/.test(ca), "each row carries timing (null when the student picks), timingPolicy and releaseMode");
  check(/const back = await freshAssignmentRow\(key\)\.catch\(\(\) => null\)/.test(ca) && /canonJson\(back\) !== canonJson\(a\)/.test(ca) && !/JSON\.stringify\(back\)/.test(ca),
    "each written row is read back through the one row-fetch helper and compared by canonical (key-sorted) serialisation, never by raw JSON text");
  check(!/kind: "set"/.test(ca), "the form path never writes a set-kind row");
  check(/if\(createInFlight\)\{/.test(ca) && /createInFlight = true;/.test(ca) && /finally\{\s*createInFlight = false;/.test(ca) && /id="afCreateBtn"[^>]*\$\{createInFlight \? "disabled" : ""\}/.test(va),
    "one run at a time: the in-flight flag is checked first, set for the run, released in a finally, and the button is rendered disabled while it is held");
  check(/if\(!plan\.length\)\{ \$\("afMsg"\)\.textContent = refusalLines\.join\(" "\); return; \}/.test(ca), "an all-refused submit returns before the profile write, the reload and the render");
  check(/assignmentId: newAssignmentId\(taken\)/.test(ca) && /taken\.add\(a\.assignmentId\)/.test(ca), "ids come from newAssignmentId over the ids the code already holds");
  /* the id helper itself: unique even when Math.random repeats */
  {
    const NAI = extractFn(dashSrc, "newAssignmentId");
    const mk = new Function("Date", "Math", NAI + "\nreturn newAssignmentId;");
    const stub = { random: () => 0.5, floor: Math.floor };
    const fn = mk({ now: () => 1000 }, stub);
    const taken = new Set(["a-1-80000000"]);
    const ids = [fn(taken), fn(taken), fn(taken)];
    check(new Set(ids).size === 3 && ids.every(id => id !== "a-1-80000000") && /^a-1-80000000-\d+$/.test(ids[0]), "newAssignmentId never repeats an id in `taken`, even with a constant Math.random (a counter suffix)", ids.join());
    const CJ = extractFn(dashSrc, "canonJson");
    const canon = new Function(CJ + "\nreturn canonJson;")();
    check(canon({ b: 1, a: [ { z: 1, y: 2 } ] }) === canon({ a: [ { y: 2, z: 1 } ], b: 1 }) && canon({ a: [1, 2] }) !== canon({ a: [2, 1] }) && canon(null) === "null",
      "canonJson: key order never matters, array order always does");
  }
});

finished = true;
console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
