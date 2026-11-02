/* tests/partial-sittings.test.js — run: node tests/partial-sittings.test.js (repo root)

   Partial sittings (2026-11-02): an assignment's scopePolicy lets the tutor
   (or the student) sit the full form, one section, or one module. The
   record gains ONE optional top-level field, `scope`, and the sitting runs on
   a copy of the form filtered to it (attempts.js AttemptScope.testFor), the
   way a practice set runs on its synthetic one-module test. Every check here
   has a control — a doctored source, a mutated input, or the pre-change
   recorder's own output — that shows the check goes red when its fix is
   taken away; a check that cannot fail proves nothing.

     §1  AttemptScope (attempts.js): the readers, total over junk; slots by
         section and ordinal on every shipped form and archived build; the
         seam (testFor) hands back the very form for a full scope;
     §2  AssignmentRules.scopePolicyOf / rowVersion: fixed full by default,
         never a free pick, a too-new row refused;
     §3  the recorder for REAL, on the REAL 2026 June Asia v2 form: a
         Math-only record has exactly two modules, no Reading and Writing
         answer, a Math section score with total null; a single-module
         record has no scaled score anywhere; a full-scope record is
         byte-identical to what the PRE-CHANGE recorder wrote (the golden
         fixture tests/partial-sittings-golden.json, emitted from 21b6855's
         attempts.js by --emit-golden with the same driver); the stamp
         removed reds the Math-only check;
     §4  app.js's start path for real: a fixed Math row begins on the
         two-module copy and stamps the scope; a student-choice scope row
         begins NOTHING without a pick for this very assignment; a pick
         stamps selectedByStudent; a too-new row is refused; the seam
         removed reds it;
     §5  crash-resume restores the STORED scope: a Math-only checkpoint at
         moduleIndex 1 reopens the second MATH module, never RW Module 2
         (the seam removed reds it), and crashResumeCandidate refuses an
         index past the scope (the scope check removed reds it);
     §6  Score Details and the printed report (the same DOM): a section-only
         record prints "—" for the total and "Section only" with that
         section's exact scaled number; a single-module record prints no
         scaled number anywhere; Review Mode's bounds are the sat modules
         (the strips, and reviewStep never crosses out of them); the seam
         removed reds it;
     §7  the Past card: the section's score over 200–800 with "Section only",
         never "400–1600"; the raw count with "Single module"; a full card
         unchanged; the scope dropped from the conversion reds it;
     §8  the dashboard: the scope badge on the Attempts row, the Students
         card (whose RW column prints "—" for a Math-only record) and the
         detail line; the Assignments table's Scope text; the modules-
         already-sat line; the badge emptied reds it;
     §9  the SPR audit (tests/spr-grading.test.js §5) over an export holding
         a partial record: audited, not skipped — its SPR answers counted,
         a wrong stored verdict in it caught;
     §10 every consumer goes through the ONE seam (source pins), the archive
         schema name is unchanged, and a pre-scope record reads as full.

   To watch it fail on the pre-change code:
     git show 21b6855:attempts.js > <scratch>/attempts-pre.js   (and app.js, dashboard.js)
     ATTEMPTS_SRC=… APP_SRC=… DASHBOARD_SRC=… node tests/partial-sittings.test.js
   To regenerate the golden (only when the DRIVER changes, never to make §3 pass):
     ATTEMPTS_SRC=<scratch>/attempts-pre.js node tests/partial-sittings.test.js --emit-golden > tests/partial-sittings-golden.json */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const { execFileSync } = require("child_process");
const { extractFn, extractConst } = require("./extract-helper");

const repo = path.join(__dirname, "..");
const readLf = p => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const attemptsSrc = readLf(process.env.ATTEMPTS_SRC || path.join(repo, "attempts.js"));
const appSrc = readLf(process.env.APP_SRC || path.join(repo, "app.js"));
const dashSrc = readLf(process.env.DASHBOARD_SRC || path.join(repo, "dashboard.js"));
const renderSrc = readLf(path.join(repo, "render.js"));
const gradingSrc = readLf(path.join(repo, "grading.js"));
const EMIT_GOLDEN = process.argv.indexOf("--emit-golden") !== -1;

let pass = 0, fail = 0;
const failures = [];
let finished = false;
process.on("beforeExit", () => {
  if(finished || EMIT_GOLDEN) return;
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

/* ---------- the real library pieces ---------- */
function loadScript(file){ const c = { window: {} }; vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(repo, file), "utf8"), c); return c; }
const MANIFEST = loadScript("testdata/manifest.js").window.TEST_MANIFEST;
const ARCHIVE_INDEX = loadScript("testdata/archive/index.js").window.TEST_ARCHIVE_INDEX;
const escapeHtml = loadScript("render.js").escapeHtml;
const G = (() => { const c = {}; vm.createContext(c); vm.runInContext(gradingSrc, c); return c; })();
const FORM_ID = "202606asiav2";
function realForm(id, version){
  const c = { window: { __TESTDATA__: {} } };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(repo, "testdata", version ? "archive/" + id + "@" + version + ".js" : id + ".js"), "utf8"), c);
  return c.window.__TESTDATA__[id];
}
const FORM = realForm(FORM_ID);
const ENTRY = MANIFEST.find(t => t.testId === FORM_ID);
if(!ENTRY || !FORM) throw new Error("the harness needs " + FORM_ID + " in the manifest and on disk");

/* ---------- attempts.js in a DETERMINISTIC sandbox (local mode: devstore: keys) ---------- */
const NOW = 1_700_000_000_000;
function load(src){
  class FakeDate extends Date { static now(){ return NOW; } }
  const sandbox = {
    localStorage: {
      _d: {},
      setItem(k, v){ this._d[k] = String(v); }, getItem(k){ return k in this._d ? this._d[k] : null; },
      removeItem(k){ delete this._d[k]; }, key(i){ return Object.keys(this._d)[i]; },
      get length(){ return Object.keys(this._d).length; }
    },
    location: { search: "" },
    document: { addEventListener(){}, createElement: () => ({}) },
    navigator: { userAgent: "node", onLine: true },
    screen: { width: 1, height: 1 },
    Date: FakeDate,
    Math: Object.assign(Object.create(Math), { random: () => 0.4321 }),
    setInterval: () => 0, clearInterval(){}, setTimeout: () => 0, clearTimeout(){},
    fetch: () => Promise.reject(new Error("network blocked in test"))
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(gradingSrc, sandbox);          // the REAL grading, so the record's score is real
  vm.runInContext(src || attemptsSrc, sandbox);
  return sandbox;
}
const S = load().AttemptScope || null;
const R = load().AssignmentRules || {};
const CODE = "AS-7K4M9PXR";
const waitForSave = async (sb, attemptId, predicate) => {
  for(let i = 0; i < 80; i++){
    const raw = sb.localStorage.getItem("devstore:" + attemptId);
    if(raw){ const r = JSON.parse(raw); if(!predicate || predicate(r)) return r; }
    await new Promise(res => setImmediate(res));
  }
  return null;
};
/* app state as startTestFlowLoaded builds it for the test the sitting runs on */
function makeAppState(test){
  const ms = {};
  test.modules.forEach(m => { ms[m.moduleId] = { answers: {}, flags: new Set(), eliminated: {}, passageHtml: {}, stemHtml: {}, choiceHtml: {}, notes: {} }; });
  return { currentTest: test, moduleIndex: 0, questionIndex: 0, timeRemainingSec: 100, untimed: false, elapsedSec: 0, moduleState: ms };
}
/* THE DRIVER — one sequence for every §3 case and for the golden: begin,
   every module opened and submitted with its first question answered
   correctly, finalize. Deterministic (fixed clock, fixed random). */
async function drive(sb, test, beginOpts){
  const st = makeAppState(test);
  sb.Attempts.begin(test, CODE, "self-administered", st, "a-1", 1, undefined, beginOpts);
  const id = sb.Attempts.currentAttemptId();
  for(let i = 0; i < test.modules.length; i++){
    const mod = test.modules[i];
    st.moduleIndex = i;
    sb.Attempts.moduleStart(mod);
    const q = mod.questions[0];
    sb.Attempts.questionShown(q.id);
    const given = q.type === "spr" ? String(q.correctAnswer) : q.correctAnswer;
    st.moduleState[mod.moduleId].answers[q.id] = given;
    sb.Attempts.answerCommitted(q.id, given);
    sb.Attempts.moduleEnd(mod, "submitted");
  }
  sb.Attempts.finalize("submitted");
  return await waitForSave(sb, id, r => r.status === "completed");
}

/* ---------- app.js pieces in small harnesses ---------- */
const el = () => { const els = {}; return { els, el: id => els[id] || (els[id] = { innerHTML: "", textContent: "", value: "", disabled: false,
  addEventListener(){}, classList: { add(){}, remove(){}, toggle(){} } }) }; };
const num = v => typeof v === "number" && isFinite(v) ? v : null;

if(EMIT_GOLDEN){
  (async () => {
    const rec = await drive(load(), FORM, undefined);
    process.stdout.write(JSON.stringify(rec, null, 1) + "\n");
  })();
} else (async () => {

/* ================= §1 AttemptScope ================= */
await run("1. AttemptScope: readers total over junk; slots on every shipped form; the seam", async () => {
  check(!!S && typeof S.scopeOf === "function" && typeof S.testFor === "function" && typeof S.formProblems === "function", "attempts.js exposes window.AttemptScope with scopeOf, testFor and formProblems");
  if(!S) return;
  const full = S.scopeOf({});
  check(full.kind === "full" && full.declared === false && full.selected === false && full.modules.join() === "re1,re2,ma1,ma2", "no scope field -> full, undeclared (every pre-scope record)");
  const math = S.scopeOf({ scope: { modules: ["ma1", "ma2"], selectedByStudent: false } });
  check(math.kind === "section" && math.preset === "math" && math.section === "Math" && math.declared && !math.selected, "{modules:[ma1,ma2]} -> section Math");
  const re2 = S.scopeOf({ scope: { modules: ["re2"], selectedByStudent: true } });
  check(re2.kind === "module" && re2.preset === "re2" && re2.section === "Reading and Writing" && re2.selected === true, "{modules:[re2], selectedByStudent:true} -> module re2, selected");
  [["out of order", ["ma2", "ma1"]], ["not a preset", ["re1", "ma1"]], ["junk slot", ["re1", "re2", "xx"]], ["duplicate", ["ma1", "ma1"]],
   ["empty", []], ["not a list", "ma1,ma2"], ["markup", ['"><img src=x onerror=alert(1)>']], ["three", ["re1", "re2", "ma1"]]].forEach(([what, mods]) =>
    check(S.scopeOf({ scope: { modules: mods } }).kind === "full", "a scope that is " + what + " reads as FULL (never a partial label, never a throw)"));
  check(S.scopeOf({ scope: { modules: ["ma1"], selectedByStudent: "true" } }).selected === false && S.scopeOf({ scope: { modules: ["ma1"], selectedByStudent: 1 } }).selected === false,
    "selectedByStudent counts only as the literal true");
  check(S.scopeOf(null).kind === "full" && S.scopeOf({ scope: null }).kind === "full" && S.scopeOf({ scope: "math" }).kind === "full", "null / non-object scopes read as full");
  /* slots by section and ordinal, on every shipped form and archived build */
  const ids = MANIFEST.map(t => t.testId);
  const bad = [];
  ids.forEach(id => { const p = S.formProblems(realForm(id)); if(p.length) bad.push(id + ": " + p.join("; ")); });
  check(bad.length === 0, "every one of the " + ids.length + " shipped forms maps onto re1, re2, ma1, ma2 by section and ordinal, every question id under its slot", bad.join(" | "));
  const archBad = [];
  let archN = 0;
  Object.keys(ARCHIVE_INDEX).forEach(id => (ARCHIVE_INDEX[id] || []).forEach(v => { archN++; const p = S.formProblems(realForm(id, v)); if(p.length) archBad.push(id + "@" + v); }));
  check(archBad.length === 0, "…and every one of the " + archN + " archived builds too (resume and review pin to them)", archBad.join(", "));
  const swapped = Object.assign({}, FORM, { modules: [FORM.modules[0], FORM.modules[2], FORM.modules[1], FORM.modules[3]] });
  control(S.formProblems(swapped).length === 1 && /do not map/.test(S.formProblems(swapped)[0]), "a form with its modules out of section order is named by formProblems");
  const mislabelled = JSON.parse(JSON.stringify(FORM));
  mislabelled.modules[1].questions[0].id = "re1-q99";
  control(S.formProblems(mislabelled).length === 1 && /re2.*1 question id/.test(S.formProblems(mislabelled)[0]), "a question id under the wrong slot prefix is named by formProblems");
  /* the seam */
  check(S.testFor(FORM, {}) === FORM && S.testFor(FORM, S.fromPreset("full")) === FORM, "testFor hands back the VERY form object for a full scope (sets and pre-scope records pass through untouched)");
  const m = S.testFor(FORM, { scope: { modules: ["ma1", "ma2"] } });
  check(m !== FORM && m.modules.length === 2 && m.modules.map(x => x.moduleId).join() === FORM.modules.slice(2).map(x => x.moduleId).join() &&
        m.testId === FORM.testId && m.testVersion === FORM.testVersion && m.scoring === FORM.scoring && FORM.modules.length === 4,
    "a Math scope -> a shallow copy holding exactly the two Math modules in form order, same id, version and scoring; the form itself untouched");
  check(S.testFor(FORM, { scope: { modules: ["re2"] } }).modules[0].moduleId === FORM.modules[1].moduleId, "a single-slot scope -> that one module (re2 = the SECOND Reading and Writing module)");
  /* a practice-set RECORD as the recorder writes it — kind "set" AND a
     modules[] array — must read as full and pass its synthetic test through
     untouched: a duck-type on {kind, modules} alone read it as a scope and
     emptied the test (review 2026-11-02, finding 1) */
  const setTest = { testId: "pset-1", modules: [{ moduleId: "pset-1-m1", section: "Math", questions: [{ id: "bank-x:q0001" }] }] };
  const setRec = { attemptId: "attempt:pset-1:1:a", kind: "set", setId: "pset-1", status: "in-progress", student: { code: CODE, key: CODE },
    modules: [{ moduleId: "pset-1-m1", section: "Math", moduleLabel: "Module 1", endedAt: null }], answers: {}, checkpoint: { moduleIndex: 0 } };
  check(S.testFor(setTest, setRec) === setTest && S.scopeOf(setRec).kind === "full" && S.label(setRec) === "" && S.scoreLabel(setRec) === "",
    "a practice-set RECORD (kind \"set\", modules[]) reads as full: its synthetic test passes through untouched, no label");
  check(S.testFor(FORM, { kind: "set", modules: ["ma1", "ma2"] }) === FORM && S.testFor(FORM, { kind: "section", modules: ["ma1", "ma2"] }) === FORM,
    "an object with a scope-like kind and modules but no preset is a record, not a scope: nothing is filtered on its say-so");
  check(S.slotLabel("constructor", true) === "" && S.slotLabel("re1", true) === "RW Module 1" && S.presetLabel("constructor") === "", "slotLabel and presetLabel answer only for their own keys");
  /* labels: closed table */
  check(S.label({}) === "" && S.label({}, true) === "Full test" && S.label({ scope: { modules: ["ma1", "ma2"] } }) === "Math only" &&
        S.label({ scope: { modules: ["re1", "re2"] } }) === "Reading and Writing only" && S.label({ scope: { modules: ["ma2"] } }) === "Single module · Math Module 2",
    "label: '' / Full test / <section> only / Single module · <slot>");
  check(S.scoreLabel({}) === "" && S.scoreLabel({ scope: { modules: ["re1", "re2"] } }) === "Section only" && S.scoreLabel({ scope: { modules: ["re1"] } }) === "Single module",
    "scoreLabel: the brief's two words, '' for full");
  check(S.presetLabel("rw") === "Reading and Writing" && S.presetLabel("ma1") === "Math · Module 1" && S.presetLabel("zz") === "", "presetLabel from the closed table, '' for an unknown name");
  check(S.openedSlots({ status: "in-progress", answers: { "re1-q1": { visitCount: 1 }, "re2-q1": { visitCount: 0 }, "ma2-q5": { visitCount: 3 } } }).join() === "re1,ma2",
    "openedSlots: a slot is opened when any of its answers has a visit (in-progress: only what was reached)");
  check(S.openedSlots({ status: "completed", scope: { modules: ["ma1", "ma2"] }, answers: {} }).join() === "ma1,ma2", "…and a finished record's declared scope counts whole");
  check(S.openedSlots({ status: "completed", answers: { "re1-q1": { visitCount: 1 } } }).join() === "re1", "…a pre-scope record (no scope) counts only what its answers show opened");
});

/* ================= §2 scopePolicyOf / rowVersion ================= */
await run("2. AssignmentRules.scopePolicyOf and the row version", async () => {
  check(typeof R.scopePolicyOf === "function" && typeof R.rowTooNew === "function" && R.ROW_VERSION === 2, "attempts.js exposes scopePolicyOf, rowTooNew and ROW_VERSION 2");
  if(typeof R.scopePolicyOf !== "function") return;
  const fullMods = "re1,re2,ma1,ma2";
  [undefined, null, {}, { scopePolicy: null }, { scopePolicy: "math" }, { scopePolicy: { mode: "fixed" } }, { scopePolicy: { mode: "fixed", modules: ["ma2", "ma1"] } },
   { scopePolicy: { mode: "fixed", modules: ["re1", "ma1"] } }, { scopePolicy: { mode: "student-choice", allowed: [] } }, { scopePolicy: { mode: "student-choice", allowed: ["junk", 7] } },
   { scopePolicy: { mode: "student-choice" } }].forEach(a => {
    const p = R.scopePolicyOf(a);
    check(p.mode === "fixed" && p.modules.join() === fullMods, "fixed FULL for " + JSON.stringify(a) + " (absent, malformed, or nothing valid to choose from — never a free pick)");
  });
  const fx = R.scopePolicyOf({ scopePolicy: { mode: "fixed", modules: ["ma1", "ma2"] } });
  check(fx.mode === "fixed" && fx.modules.join() === "ma1,ma2", "a fixed Math row reads as its two slots");
  const sc = R.scopePolicyOf({ scopePolicy: { mode: "student-choice", allowed: ["math", "zz", "full", "math", "re1"] } });
  check(sc.mode === "student-choice" && sc.allowed.join() === "full,math,re1", "a student-choice row keeps only known preset names, once each, in the closed list's order");
  check(R.rowVersionOf({}) === 1 && R.rowVersionOf({ rowVersion: 2 }) === 2 && R.rowVersionOf({ rowVersion: "9" }) === 1 && R.rowVersionOf({ rowVersion: -3 }) === 1 && R.rowVersionOf({ rowVersion: 2.9 }) === 2,
    "rowVersionOf: absent or junk is 1, a number is floored");
  check(!R.rowTooNew({}) && !R.rowTooNew({ rowVersion: 2 }) && R.rowTooNew({ rowVersion: 3 }) && R.rowTooNew({ rowVersion: 99 }), "rowTooNew: above 2 is too new; absent and 2 are not");
  check(typeof R.RELOAD_LINE === "string" && /Reload this page/.test(R.RELOAD_LINE), "the reload line is a constant the card and the suite share");
});

/* ================= §3 the recorder for real ================= */
await run("3. the recorder on the real form: Math-only, single module, and the full-scope golden", async () => {
  if(!S) return check(false, "no AttemptScope");
  const mathTest = S.testFor(FORM, S.fromPreset("math"));
  const rec = await drive(load(), mathTest, { scope: { modules: ["ma1", "ma2"], selectedByStudent: false } });
  check(!!rec, "a Math-only sitting saved a completed record");
  if(!rec) return;
  const mids = rec.modules.map(m => m.moduleId);
  check(rec.modules.length === 2 && mids.join() === FORM.modules.slice(2).map(m => m.moduleId).join() && rec.modules.every(m => m.section === "Math" && m.endedBy === "submitted"),
    "exactly TWO modules, the form's two Math modules, both submitted", mids.join());
  const keys = Object.keys(rec.answers);
  const mathQ = FORM.modules.slice(2).reduce((n, m) => n + m.questions.length, 0);
  check(keys.length === mathQ && keys.every(k => /^ma[12]-/.test(k)), "answers hold every Math question (" + mathQ + ") and NO Reading and Writing answer — absent, not blank", keys.filter(k => !/^ma/.test(k)).slice(0, 3).join());
  check(Object.keys(rec.score.bySection).join() === "Math" && Object.keys(rec.score.byModule).join() === mids.join() && rec.score.graded === keys.filter(k => G.hasKey(FORM.modules[2].questions.concat(FORM.modules[3].questions).find(q => q.id === k))).length,
    "score.bySection has only Math, score.byModule only the two Math modules, graded counts only Math items");
  check(JSON.stringify(rec.scope) === JSON.stringify({ modules: ["ma1", "ma2"], selectedByStudent: false }), "the record's scope is {modules:[ma1,ma2], selectedByStudent:false}", JSON.stringify(rec.scope));
  check(rec.status === "completed" && !("checkpoint" in rec) && !("resume" in rec) && rec.kind === undefined, "completed, no blobs, still a FORM record (no kind)");
  /* the Math section score: exact from the per-module table; total null */
  const SC = new Function("AttemptScope", "num", extractFn(appSrc, "scaledScores") + "\n" + extractFn(appSrc, "storedModuleRaw") + "\nreturn { scaledScores, storedModuleRaw };")(S, num);
  const mr = SC.storedModuleRaw(FORM, rec);
  check(!!mr && mr.math.join() === rec.score.byModule[mids[0]].correct + "," + rec.score.byModule[mids[1]].correct && mr.rw.join() === "0,0",
    "storedModuleRaw reads the two Math module raws off the record (the absent RW modules are not asked for)", JSON.stringify(mr));
  const sc = SC.scaledScores(FORM, null, rec.score.bySection.Math.correct, mr, S.scopeOf(rec));
  const want = FORM.scoring.base + FORM.scoring.mathM1[mr.math[0]] + FORM.scoring.mathM2[mr.math[1]];
  check(!!sc && sc.math === want && sc.rw === null && sc.total === null, "scaledScores: Math = base + mathM1[raw] + mathM2[raw] = " + want + ", rw null, TOTAL NULL", JSON.stringify(sc));
  /* a single module: no scaled score anywhere */
  const oneTest = S.testFor(FORM, S.fromPreset("re2"));
  const one = await drive(load(), oneTest, { scope: { modules: ["re2"], selectedByStudent: true } });
  check(!!one && one.modules.length === 1 && one.modules[0].moduleId === FORM.modules[1].moduleId && Object.keys(one.answers).every(k => /^re2-/.test(k)) &&
        JSON.stringify(one.scope) === JSON.stringify({ modules: ["re2"], selectedByStudent: true }),
    "a single-module (re2, student-selected) sitting: one module, only re2 answers, scope stamped with selectedByStudent:true");
  check(SC.scaledScores(FORM, one.score.bySection["Reading and Writing"].correct, null, SC.storedModuleRaw(FORM, one), S.scopeOf(one)) === null, "scaledScores is NULL for a single module (no conversion exists for one module)");
  /* the full-scope golden: byte-identical to the pre-change recorder */
  const goldenPath = path.join(__dirname, "partial-sittings-golden.json");
  check(fs.existsSync(goldenPath), "the golden fixture exists (tests/partial-sittings-golden.json, emitted from 21b6855's attempts.js)");
  if(fs.existsSync(goldenPath)){
    const golden = JSON.parse(readLf(goldenPath));
    const full = await drive(load(), FORM, undefined);
    check(JSON.stringify(full) === JSON.stringify(golden), "a tutor-fixed full sitting's record is BYTE-IDENTICAL to the pre-change recorder's (same driver, same clock): no scope key, nothing else moved",
      full && golden ? "keys now: " + Object.keys(full).join(",") + " | golden: " + Object.keys(golden).join(",") : "");
    const fullFixed = await drive(load(), S.testFor(FORM, S.fromPreset("full")), { scope: { modules: ["re1", "re2", "ma1", "ma2"], selectedByStudent: false } });
    check(JSON.stringify(fullFixed) === JSON.stringify(golden), "…and so is a full sitting under a scopePolicy row (fixed full): the stamp is omitted, not written as four slots");
    const fullPicked = await drive(load(), FORM, { scope: { modules: ["re1", "re2", "ma1", "ma2"], selectedByStudent: true } });
    check(!!fullPicked && JSON.stringify(fullPicked.scope) === JSON.stringify({ modules: ["re1", "re2", "ma1", "ma2"], selectedByStudent: true }) &&
          JSON.stringify(Object.assign({}, fullPicked, { scope: undefined })) === JSON.stringify(golden),
      "a full sitting the STUDENT chose carries scope {all four, selectedByStudent:true} and nothing else differs");
    control(!("scope" in golden) && golden.modules.length === 4 && Object.keys(golden.answers).length === FORM.modules.reduce((n, m) => n + m.questions.length, 0), "the golden is a four-module, 98-answer record with no scope key");
  }
  /* control: the stamp taken out of attempts.js reds the Math-only check */
  {
    const MUT = attemptsSrc.replace("rec.scope = { modules: sc.modules.slice(), selectedByStudent: opts.scope.selectedByStudent === true };", "/* stamp removed */");
    control(MUT !== attemptsSrc, "the mutant differs from the source");
    const mrec = await drive(load(MUT), mathTest, { scope: { modules: ["ma1", "ma2"], selectedByStudent: false } });
    control(!!mrec && !("scope" in mrec) && mrec.modules.length === 2, "without the stamp the record has two modules but NO scope — the scope check above reds, and every consumer would read it as full");
  }
});

/* ================= §4 the start path for real ================= */
await run("4. startTestFlowLoaded: a fixed Math row begins on the scoped copy; student-choice needs a pick; too-new is refused", async () => {
  const SRC = extractFn(appSrc, "startTestFlowLoaded");
  function world(src, assignment, pendingTiming, pendingScope){
    const calls = { begin: [], showOnly: [], choice: [], ready: 0, home: 0 };
    const state = { pendingTiming: pendingTiming === undefined ? null : pendingTiming, pendingScope: pendingScope === undefined ? null : pendingScope,
      timing: 1, reviewMode: {}, moduleState: null, activeAssignment: null, userName: CODE, sessionGen: 1, currentTest: null };
    const Attempts = { begin: (...a) => calls.begin.push(a) };
    const fn = new Function("state", "Attempts", "showOnly", "setTimeout", "showReady", "openTimingChoice", "AssignmentRules", "AttemptScope", "renderHome",
      src + "\nreturn startTestFlowLoaded;")(state, Attempts, id => calls.showOnly.push(id), () => 0, () => { calls.ready++; }, (t, a) => calls.choice.push([t, a]), R, S, () => { calls.home++; });
    fn(FORM, assignment);
    return { calls, state };
  }
  const mathRow = { assignmentId: "a-m", testId: FORM_ID, category: "practice", timing: 1, scopePolicy: { mode: "fixed", modules: ["ma1", "ma2"] } };
  {
    const w = world(SRC, mathRow);
    const b = w.calls.begin[0];
    check(w.calls.begin.length === 1 && b[0].modules.length === 2 && b[0].modules.every(m => m.section === "Math") && b[0].testId === FORM_ID && w.state.currentTest === b[0] && Object.keys(w.state.moduleState).length === 2,
      "a fixed Math row: begin runs on the TWO-module copy, which is state.currentTest, with moduleState for those two only", b && b[0].modules.length);
    check(!!b && JSON.stringify(b[7]) === JSON.stringify({ scope: { modules: ["ma1", "ma2"], selectedByStudent: false } }), "…and the scope is passed to begin, selectedByStudent false", b && JSON.stringify(b[7]));
    const w2 = world(SRC, { assignmentId: "a-f", testId: FORM_ID, category: "practice", timing: 2 });
    const b2 = w2.calls.begin[0];
    check(w2.calls.begin.length === 1 && b2[0] === FORM && b2[7] === undefined && b2[5] === 2, "a row with no scopePolicy (today's shape): begin on the FORM ITSELF with no options, as before");
    const w3 = world(SRC, null);
    check(w3.calls.begin.length === 1 && w3.calls.begin[0][0] === FORM && w3.calls.begin[0][7] === undefined, "no assignment at all: the whole form, no options, as before");
  }
  const choiceRow = { assignmentId: "a-c", testId: FORM_ID, category: "practice", timing: 1, scopePolicy: { mode: "student-choice", allowed: ["full", "rw", "math"] } };
  {
    const w = world(SRC, choiceRow, null, null);
    check(w.calls.begin.length === 0 && w.calls.choice.length === 1 && w.calls.choice[0][1] === choiceRow && w.state.pendingScope === null, "student-choice scope with NO pick: begin is never called, the choice screen opens");
    const w2 = world(SRC, choiceRow, null, { assignmentId: "a-other", scope: "math" });
    check(w2.calls.begin.length === 0 && w2.calls.choice.length === 1 && w2.state.pendingScope === null, "a pick made for ANOTHER assignment does not start this one (and is dropped)");
    const w3 = world(SRC, choiceRow, null, { assignmentId: "a-c", scope: "re1" });
    check(w3.calls.begin.length === 0 && w3.calls.choice.length === 1, "a pick outside the allowed presets does not start the sitting");
    const w4 = world(SRC, choiceRow, null, { assignmentId: "a-c", scope: "rw" });
    const b = w4.calls.begin[0];
    check(w4.calls.begin.length === 1 && b[0].modules.length === 2 && b[0].modules.every(m => m.section === "Reading and Writing") &&
          JSON.stringify(b[7]) === JSON.stringify({ scope: { modules: ["re1", "re2"], selectedByStudent: true } }) && w4.state.pendingScope === null,
      "a valid pick (rw) for THIS assignment: begins on the two RW modules, stamps selectedByStudent:true, consumes the pick");
    const w5 = world(SRC, choiceRow, null, { assignmentId: "a-c", scope: "full" });
    check(w5.calls.begin.length === 1 && w5.calls.begin[0][0] === FORM && JSON.stringify(w5.calls.begin[0][7]) === JSON.stringify({ scope: { modules: ["re1", "re2", "ma1", "ma2"], selectedByStudent: true } }),
      "a pick of Full test: the whole form, and the chosen full scope IS stamped (selectedByStudent:true)");
    /* both choices on one row */
    const both = Object.assign({}, choiceRow, { timing: null, timingPolicy: { mode: "student-choice", allowed: [1.5, "untimed"] } });
    const w6 = world(SRC, both, { assignmentId: "a-c", timing: 1.5 }, null);
    check(w6.calls.begin.length === 0 && w6.calls.choice.length === 1, "timing picked but scope not: nothing starts");
    const w7 = world(SRC, both, { assignmentId: "a-c", timing: 1.5 }, { assignmentId: "a-c", scope: "math" });
    check(w7.calls.begin.length === 1 && JSON.stringify(w7.calls.begin[0][7]) === JSON.stringify({ timingSelectedByStudent: true, scope: { modules: ["ma1", "ma2"], selectedByStudent: true } }) && w7.calls.begin[0][5] === 1.5,
      "both picked: begin carries the timing flag AND the scope, on the Math copy, at 1.5×");
  }
  {
    const w = world(SRC, Object.assign({}, mathRow, { rowVersion: 3 }));
    check(w.calls.begin.length === 0 && w.calls.choice.length === 0 && w.calls.home === 1 && w.calls.showOnly[0] === "screen-home", "a row above the version this client understands: NOTHING begins, home is repainted (the card carries the reload line)");
  }
  /* controls: the seam taken out — the sitting runs on the whole form under a Math row */
  {
    const MUT = SRC.replace("test = AttemptScope.testFor(test, scope);", "/* seam removed */");
    control(MUT !== SRC, "the mutant differs from the source");
    const w = world(MUT, mathRow);
    control(w.calls.begin.length === 1 && w.calls.begin[0][0].modules.length === 4, "without the seam a Math row begins on all FOUR modules — which the two-module check above catches");
  }
  /* startAssignment: a scope-choice row goes to the screen; a too-new row goes nowhere */
  {
    const SA = extractFn(appSrc, "startAssignment");
    const mk = () => { const calls = { choice: 0, code: 0, flow: 0, home: 0 };
      const fn = new Function("assignmentState", "renderHome", "AssignmentRules", "openTimingChoice", "openStartCode", "startTestFlow", SA + "\nreturn startAssignment;")(
        () => "ready", () => { calls.home++; }, R, () => { calls.choice++; }, () => { calls.code++; }, () => { calls.flow++; });
      return { fn, calls }; };
    const a = mk(); a.fn({}, Object.assign({}, choiceRow, { category: "test" }));
    const b = mk(); b.fn({}, mathRow);
    const c = mk(); c.fn({}, Object.assign({}, mathRow, { rowVersion: 3 }));
    check(a.calls.choice === 1 && a.calls.code === 0 && b.calls.flow === 1 && b.calls.choice === 0, "startAssignment: a scope-choice row opens the choice screen first (even proctored); a fixed Math row goes straight to the flow");
    check(c.calls.flow === 0 && c.calls.code === 0 && c.calls.choice === 0 && c.calls.home === 1, "…a too-new row starts nothing and repaints home");
  }
  /* the card: the reload line, no Start */
  {
    const AC = ["assignmentCard", "assignmentExtentText", "testModuleCount", "testQuestionCount"].map(n => extractFn(appSrc, n)).join("\n");
    const made = [];
    const document = { createElement: () => { const c = { className: "", innerHTML: "", addEventListener(){ c.wired = true; } }; made.push(c); return c; } };
    const fn = new Function("document", "escapeHtml", "assignmentState", "testById", "AssignmentRules", "AttemptScope", "fmtCardDate", "state", "resumeTestFlow", "startAssignment",
      AC + "\nreturn assignmentCard;")(document, escapeHtml, () => "ready", () => ENTRY, R, S, () => "", { assignAttempts: {} }, () => {}, () => {});
    const tooNew = fn(Object.assign({}, mathRow, { rowVersion: 3 }));
    check(tooNew.innerHTML.indexOf(R.RELOAD_LINE) !== -1 && tooNew.innerHTML.indexOf(">Start<") === -1 && !tooNew.wired && tooNew.className.indexOf("clickable") === -1,
      "the home card for a too-new row says 'Reload this page to start this assignment', offers no Start and is not clickable");
    const ok = fn(mathRow);
    check(ok.innerHTML.indexOf(">Start<") !== -1 && ok.wired && /Math · 2 modules · 44 questions/.test(ok.innerHTML), "a fixed Math row's card: Start, and 'Math · 2 modules · 44 questions' from the manifest");
    check(/Full test or a part — you choose/.test(fn(choiceRow).innerHTML) && /4 modules · 98 questions/.test(fn({ assignmentId: "a-f", testId: FORM_ID, category: "practice" }).innerHTML) &&
          /RW Module 1 · 1 module/.test(fn(Object.assign({}, mathRow, { scopePolicy: { mode: "fixed", modules: ["re1"] } })).innerHTML),
      "…a choice row says the choice is theirs; a plain row reads as before; a single module names itself without a question count");
  }
  /* every session reset drops the scope pick too */
  {
    ["enterTutorSession", "endDeletedSession", "endSittingDeleted"].forEach(n => check(/state\.pendingScope = null/.test(extractFn(appSrc, n)), n + " clears pendingScope"));
    const so = appSrc.match(/el\("homeSignoutBtn"\)\.addEventListener\("click", \(\)=>\{([\s\S]*?)\n  \}\);/);
    check(!!so && /state\.pendingScope = null/.test(so[1]), "Sign out clears pendingScope");
    const sc = appSrc.match(/el\("scHomeBtn"\)\.addEventListener\("click", \(\)=>\{([\s\S]*?)\}\);/);
    check(!!sc && /state\.pendingScope = null/.test(sc[1]), "Return to Home from the start code drops the scope pick");
    const tc = appSrc.match(/el\("tcHomeBtn"\)\.addEventListener\("click", \(\)=>\{([\s\S]*?)\}\);/);
    check(!!tc && /state\.pendingScope = null/.test(tc[1]), "Return to Home from the choice screen drops it");
  }
});

/* ================= §5 crash-resume ================= */
await run("5. crash-resume restores the stored scope; a checkpoint past the scope is refused", async () => {
  const SRC = ["resumeTestFlowLoaded", "buildModuleStateFromRecord"].map(n => extractFn(appSrc, n)).join("\n");
  function resumeWorld(src, record, test, scopeApi){
    const calls = { begin: [], show: [] };
    const state = { assignments: [], resumeRecords: { [FORM_ID]: record }, currentTest: null, moduleState: null, timing: 1, reviewMode: {}, readyTimer: null, sessionGen: 1 };
    const fn = new Function("state", "AttemptScope", "restoreAnnotations", "Attempts", "showOnly", "setTimeout", "beginModule", "renderHome",
      src + "\nreturn resumeTestFlowLoaded;")(state, scopeApi || S, () => {}, { resume(){} }, id => calls.show.push(id), (cb) => { cb(); return 1; },
      (idx, resume) => calls.begin.push({ idx, mods: state.currentTest.modules.map(m => m.moduleId), resume }), () => {});
    const ok = fn(test || FORM, record);
    return { ok, calls, state };
  }
  /* a PRACTICE SET resumes through this very function (resumeSetFlow hands it
     the synthetic test and the set record): the set record must pass the seam
     untouched — review 2026-11-02, finding 1 */
  {
    const setTest = { testId: "pset-1", testName: "Set", kind: "set", modules: [{ moduleId: "pset-1-m1", section: "Math", moduleLabel: "Module 1", timeLimitMinutes: 0,
      questions: [{ id: "bank-x:q0001", type: "mcq", choices: ["a", "b", "c", "d"], correctAnswer: 0 }, { id: "bank-x:q0002", type: "mcq", choices: ["a", "b", "c", "d"], correctAnswer: 1 }] }] };
    const setRec = { attemptId: "attempt:pset-1:1:a", kind: "set", setId: "pset-1", testId: "pset-1", status: "in-progress", timing: "untimed", student: { code: CODE, key: CODE },
      modules: [{ moduleId: "pset-1-m1", section: "Math", moduleLabel: "Module 1", endedAt: null }], answers: { "bank-x:q0001": { given: 0 } }, checkpoint: { moduleIndex: 0, questionIndex: 1, untimed: true, elapsedSeconds: 30 } };
    const w = resumeWorld(SRC, setRec, setTest);
    check(w.ok === true && w.calls.begin.length === 1 && w.calls.begin[0].idx === 0 && w.calls.begin[0].mods.join() === "pset-1-m1" && w.state.currentTest === setTest,
      "a practice-set record resumes on its one synthetic module — the set's test passes the seam untouched", JSON.stringify(w.calls));
    /* control: the duck-typed scope test the review caught (kind + modules) empties the set and the resume returns false */
    const LOOSE = attemptsSrc.replace(/const isScope = v => !!\(v && typeof v === "object" && typeof v\.preset === "string"[^;]*;/, 'const isScope = v => !!(v && typeof v === "object" && typeof v.kind === "string" && Array.isArray(v.modules));');
    control(LOOSE !== attemptsSrc, "the loose-isScope mutant differs from the source");
    const loose = resumeWorld(SRC, setRec, setTest, load(LOOSE).AttemptScope);
    control(loose.ok === false && loose.calls.begin.length === 0, "with the duck-typed isScope a set record cannot resume (false, no beginModule) — which the check above catches");
  }
  const mathRec = { attemptId: "attempt:" + FORM_ID + ":1:a", testId: FORM_ID, testVersion: FORM.testVersion, status: "in-progress", timing: 1,
    scope: { modules: ["ma1", "ma2"], selectedByStudent: false }, answers: {}, modules: [], checkpoint: { moduleIndex: 1, questionIndex: 3, timeRemainingSeconds: 900 } };
  const w = resumeWorld(SRC, mathRec);
  const b = w.calls.begin[0];
  check(w.ok === true && !!b && b.idx === 1 && b.mods.length === 2 && b.mods[1] === FORM.modules[3].moduleId && w.state.currentTest.modules.length === 2,
    "a Math-only checkpoint at moduleIndex 1 reopens the SECOND MATH module (state.currentTest is the two-module copy)", JSON.stringify(b));
  const full = resumeWorld(SRC, Object.assign({}, mathRec, { scope: undefined }));
  check(full.calls.begin[0].mods.length === 4 && full.calls.begin[0].mods[1] === FORM.modules[1].moduleId, "a pre-scope record's checkpoint at 1 reopens RW Module 2 of the whole form, as before");
  const one = resumeWorld(SRC, Object.assign({}, mathRec, { scope: { modules: ["re2"] }, checkpoint: { moduleIndex: 0, questionIndex: 2 } }));
  check(one.calls.begin[0].mods.length === 1 && one.calls.begin[0].mods[0] === FORM.modules[1].moduleId, "a single-module (re2) record resumes on exactly that module");
  {
    const MUT = SRC.replace("test = AttemptScope.testFor(test, record);", "/* seam removed */");
    control(MUT !== SRC, "the mutant differs from the source");
    const m = resumeWorld(MUT, mathRec);
    control(m.calls.begin[0].mods.length === 4 && m.calls.begin[0].mods[1] === FORM.modules[1].moduleId, "without the seam the Math-only checkpoint reopens RW MODULE 2 — which the check above catches");
  }
  /* crashResumeCandidate: the index is checked against the record's scope */
  {
    const CRC = ["crashResumeCandidate", "testById", "testIdAliases", "testModuleCount"].map(n => extractFn(appSrc, n)).join("\n");
    const mk = (src, rec) => new Function("state", "AttemptScope", src + "\nreturn crashResumeCandidate;")({ tests: MANIFEST, resumeRecords: { [FORM_ID]: rec } }, S)();
    const at = i => Object.assign({}, mathRec, { checkpoint: { moduleIndex: i, questionIndex: 0 } });
    check(!!mk(CRC, at(1)) && mk(CRC, at(2)) === null && mk(CRC, at(3)) === null, "crashResumeCandidate: a Math-only record resumes at index 1 but an index of 2 or 3 is a corrupt blob — refused, not clamped");
    check(!!mk(CRC, Object.assign({}, at(3), { scope: undefined })) && mk(CRC, Object.assign({}, at(4), { scope: undefined })) === null, "a pre-scope record: 3 is fine, 4 is past the manifest's four, as before");
    const MUT = CRC.replace("cp.moduleIndex >= Math.min(testModuleCount(test), AttemptScope.scopeOf(rec).modules.length)", "cp.moduleIndex >= testModuleCount(test)");
    control(MUT !== CRC && !!mk(MUT, at(3)), "without the scope check a Math-only record's index 3 is accepted — which the check above catches");
  }
});

/* ================= §6 Score Details, the print DOM and Review Mode's bounds ================= */
const SD_NAMES = ["scaledScores", "buildScoreRows", "buildModuleStateFromRecord", "mapDomain", "domainBar", "moduleNumber", "renderScoreDetails", "renderQuestionsOverview",
  "answerLetter", "correctLabel", "openScoreDetailsLoaded", "fmtCardDate", "timingBadgeHtml", "timingBadgeFor", "studentSelectedTiming", "scopeBadgeHtml", "displayLabel", "storedModuleRaw", "reviewStep"];
const SD_CONSTS = ["EST", "CB_DOMAINS", "SELECTED_MARK", "SCOPE_SELECTED_MARK"];
function sdWorld(appSource){
  const names = SD_NAMES.map(n => { try{ return extractFn(appSource, n); }catch(e){ return "/* " + n + " absent */"; } }).join("\n");
  const consts = SD_CONSTS.map(n => { try{ return extractConst(appSource, n); }catch(e){ return "/* " + n + " absent */"; } }).join("\n");
  const E = el();
  const state = { userName: CODE, displayName: null, currentTest: null, moduleIndex: 0, questionIndex: 0, moduleState: {} };
  const calls = { render: 0, closed: 0 };
  const api = new Function("el", "state", "escapeHtml", "hasKey", "answerMatches", "AttemptScope", "AssignmentRules", "num", "window", "document", "showOnly",
    "openReviewMode", "openScoreCalc", "leaveScoreDetails", "renderTest", "closeCalc", "closeRef", "closeDirections", "hide",
    "let sdCtx = null;\n" + consts + "\n" + names + "\nreturn { openScoreDetailsLoaded, reviewStep, ctx: () => sdCtx, scaledScores };")(
    E.el, state, escapeHtml, G.hasKey, G.answerMatches, S, R, num, { SKILL_DOMAINS: undefined, scrollTo(){} }, { querySelectorAll: () => [] }, () => {},
    () => {}, () => {}, () => {}, () => { calls.render++; }, () => { calls.closed++; }, () => {}, () => {}, () => {});
  return { api, els: E.els, state, calls };
}
await run("6. Score Details prints no total for a partial record; Review Mode is bounded by the sat modules", async () => {
  if(!S) return check(false, "no AttemptScope");
  const mathRec = await drive(load(), S.testFor(FORM, S.fromPreset("math")), { scope: { modules: ["ma1", "ma2"], selectedByStudent: false } });
  const oneRec = await drive(load(), S.testFor(FORM, S.fromPreset("re1")), { scope: { modules: ["re1"], selectedByStudent: true } });
  const fullRec = await drive(load(), FORM, undefined);
  const strips = html => (html.match(/<div class="sd-strip">/g) || []).length;
  {
    const w = sdWorld(appSrc);
    w.api.openScoreDetailsLoaded(FORM, mathRec, "home");
    const root = w.els.sdRoot.innerHTML, q = w.els.sdQuestions.innerHTML;
    const want = FORM.scoring.base + FORM.scoring.mathM1[mathRec.score.byModule[FORM.modules[2].moduleId].correct] + FORM.scoring.mathM2[mathRec.score.byModule[FORM.modules[3].moduleId].correct];
    check(/<div class="sd-hero-lbl">TOTAL SCORE<\/div>\s*<div class="sd-hero-num">—<\/div>/.test(root) && root.indexOf("Section only") !== -1 && root.indexOf("400–1600") === -1,
      "section-only hero: TOTAL SCORE '—', 'Section only', no 400–1600 anywhere (this DOM is the printed report)");
    check(new RegExp('<div class="sd-sec-lbl">Math</div><div class="sd-sec-range">200–800</div><div class="sd-sec-num">' + want).test(root) && root.indexOf('<div class="sd-sec-lbl">Reading and Writing</div>') === -1,
      "…the Math section's exact scaled number (" + want + ") over 200–800, and no Reading and Writing block");
    check(strips(root) === 2 && w.api.ctx().test.modules.length === 2 && w.api.ctx().rows.every(r => r.section === "Math") && root.indexOf("Math only") !== -1,
      "two module strips, sdCtx.test is the two-module copy, every row is Math, the 'Math only' badge is in the sub-line");
    check(q.indexOf('data-filter="rw"') === -1 && q.indexOf('data-filter="math"') !== -1 && q.indexOf("RW M") === -1 && q.indexOf("Math M") !== -1,
      "the Questions tabs offer All and Math only; no Reading and Writing row exists to read 'Omitted'");
    /* Review Mode's bounds: reviewStep over the scoped test never leaves the Math modules */
    w.state.currentTest = w.api.ctx().test;
    w.state.moduleIndex = 1; w.state.questionIndex = w.state.currentTest.modules[1].questions.length - 1;
    w.api.reviewStep(1);
    check(w.state.moduleIndex === 1 && w.state.questionIndex === w.state.currentTest.modules[1].questions.length - 1, "reviewStep(+1) at the last Math question stays (nothing after the sat modules)");
    w.state.moduleIndex = 0; w.state.questionIndex = 0;
    w.api.reviewStep(-1);
    check(w.state.moduleIndex === 0 && w.state.questionIndex === 0, "reviewStep(-1) at the first Math question stays (nothing before: RW is not part of this sitting)");
    w.state.moduleIndex = 0; w.state.questionIndex = w.state.currentTest.modules[0].questions.length - 1;
    w.api.reviewStep(1);
    check(w.state.moduleIndex === 1 && w.state.questionIndex === 0 && w.state.currentTest.modules[1].moduleId === FORM.modules[3].moduleId, "…and crossing from Math Module 1 lands on Math Module 2, the form's fourth module");
  }
  {
    const w = sdWorld(appSrc);
    w.api.openScoreDetailsLoaded(FORM, oneRec, "home");
    const root = w.els.sdRoot.innerHTML;
    check(root.indexOf("Single module") !== -1 && root.indexOf("200–800") === -1 && root.indexOf("400–1600") === -1 && /<div class="sd-hero-lbl">CORRECT<\/div>/.test(root) &&
          strips(root) === 1 && root.indexOf("(student-selected)") !== -1 && root.indexOf("Single module · RW Module 1") !== -1,
      "single-module hero: CORRECT n/m, 'Single module', no 200–800 or 400–1600, one strip, the student-selected mark");
  }
  {
    const w = sdWorld(appSrc);
    w.api.openScoreDetailsLoaded(FORM, fullRec, "home");
    const root = w.els.sdRoot.innerHTML;
    check(/TOTAL SCORE/.test(root) && root.indexOf("400–1600") !== -1 && strips(root) === 4 && root.indexOf("Section only") === -1 && root.indexOf("Single module") === -1 && root.indexOf("sd-badge") === -1,
      "a full record: the total over 400–1600, four strips, no partial word, no badge");
  }
  /* control: the seam taken out of openScoreDetailsLoaded — four strips and an RW score of 200 for a Math-only record */
  {
    const MUT = appSrc.replace("    test = AttemptScope.testFor(test, record);\n    const scope = AttemptScope.scopeOf(record);\n    const built = buildScoreRows(test, record);", "    const scope = AttemptScope.scopeOf(record);\n    const built = buildScoreRows(test, record);");
    control(MUT !== appSrc, "the mutant differs from the source");
    const w = sdWorld(MUT);
    w.api.openScoreDetailsLoaded(FORM, mathRec, "home");
    const root = w.els.sdRoot.innerHTML;
    control(strips(root) === 4 && w.api.ctx().rows.some(r => r.section === "Reading and Writing" && r.given === null), "without the seam a Math-only record renders four strips with every RW question 'omitted' — which the checks above catch");
  }
});

/* ================= §7 the Past card ================= */
await run("7. the Past card: a section's score over 200–800 with 'Section only'; a single module's raw count; never a total", async () => {
  if(!S) return check(false, "no AttemptScope");
  const mathRec = await drive(load(), S.testFor(FORM, S.fromPreset("math")), { scope: { modules: ["ma1", "ma2"], selectedByStudent: false } });
  const oneRec = await drive(load(), S.testFor(FORM, S.fromPreset("ma2")), { scope: { modules: ["ma2"], selectedByStudent: false } });
  const fullRec = await drive(load(), FORM, undefined);
  [mathRec, oneRec, fullRec].forEach(r => { r.released = true; });
  const NAMES = ["renderPastCards", "scaledScores", "storedModuleRaw", "fmtCardDate", "timingBadgeHtml", "timingBadgeFor", "studentSelectedTiming", "scopeBadgeHtml", "isSetKeyed", "isValidSetRecord"];
  function cards(appSource, recs){
    const src = NAMES.map(n => extractFn(appSource, n)).join("\n") + "\n" + ["EST", "SELECTED_MARK", "SCOPE_SELECTED_MARK"].map(n => extractConst(appSource, n)).join("\n");
    const made = [];
    const document = { createElement: () => { const c = { className: "", innerHTML: "", querySelector: () => ({ addEventListener(){} }) }; made.push(c); return c; } };
    const wrap = { innerHTML: "", appendChild(){} };
    const fn = new Function("state", "document", "escapeHtml", "testById", "canServeVersion", "window", "num", "AttemptScope", "AssignmentRules", "openScoreDetails", "openSetReview",
      src + "\nreturn renderPastCards;")({ pastAttempts: recs }, document, escapeHtml, () => ENTRY, () => true, { __TESTDATA__: { [FORM_ID]: FORM } }, num, S, R, () => {}, () => {});
    fn(wrap, () => true, "");
    return made.map(c => c.innerHTML);
  }
  const [m, o, f] = cards(appSrc, [mathRec, oneRec, fullRec]);
  const want = FORM.scoring.base + FORM.scoring.mathM1[mathRec.score.byModule[FORM.modules[2].moduleId].correct] + FORM.scoring.mathM2[mathRec.score.byModule[FORM.modules[3].moduleId].correct];
  /* the Est. mark (an estimated curve) sits between the number and its range line */
  check(new RegExp('<div class="pcard-total">' + want + '(<sup class="sd-est"[^>]*>Est\\.</sup>)?<span class="pcard-total-range">Math 200–800 · Section only · total —</span>').test(m) && m.indexOf("400–1600") === -1 && m.indexOf("Math only") !== -1,
    "Math-only card: the Math score " + want + " over 'Math 200–800 · Section only · total —', the 'Math only' badge, no 400–1600", m);
  check(/\/ \d+ correct · Single module<\/span>/.test(o) && o.indexOf("200–800") === -1 && o.indexOf("400–1600") === -1 && o.indexOf("Single module · Math Module 2") !== -1,
    "single-module card: 'n / m correct · Single module', no scaled number, the badge", o);
  check(/<span class="pcard-total-range">400–1600<\/span>/.test(f) && f.indexOf("pcard-badge") === -1, "a full record's card: the total over 400–1600 and no badge, as before", f);
  /* the pre-change card: the conversion without the scope, and the total branch for any scaled result */
  const MUT = appSrc.replace("storedModuleRaw(loadedTest, record), scope) : null;", "storedModuleRaw(loadedTest, record)) : null;")
    .replace('if(canView && scaled && scope.kind === "full"){', "if(canView && scaled){");
  control(MUT !== appSrc && MUT.indexOf('if(canView && scaled){') !== -1, "the mutant differs from the source");
  const [mm] = cards(MUT, [mathRec]);
  control(mm.indexOf("400–1600") !== -1, "with the scope out of the card a Math-only record shows a TOTAL over 400–1600 (RW read as 0 correct) — which the check above catches", mm);
});

/* ================= §8 the dashboard ================= */
await run("8. the dashboard: scope badges, the Scope column's text, the Students card's '—', the modules-already-sat line", async () => {
  if(!S) return check(false, "no AttemptScope");
  const NAMES = ["scopeBadgeHtml", "assignScopeText", "viewAttempts", "viewStudents", "exposureHtml", "studentCell", "nameFor", "statusBadge", "isTombstoned", "tombFor", "isDeletedStudent",
    "fmtDate", "fmtDay", "num", "cnt", "countPair", "scoreStr", "scorePct", "sortVal", "releaseCell", "assignmentOf", "timingLabel", "timingBadgeHtml", "attemptLabel", "manifestEntry", "sameTest", "orphanStubs", "releaseModeText",
    /* the row's verdict the exposure line reads */
    "assignRowStatus", "attemptsForAssignment", "assignCountFor", "attemptCategoryMatches", "deletedMayClose", "assignmentsAtDeletionOf"];
  function dash(dashSource, seed){
    const src = NAMES.map(n => { try{ return extractFn(dashSource, n); }catch(e){ return "/* " + n + " absent */"; } }).join("\n");
    const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const escAttr = s => esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const els = {}; const $ = id => els[id] || (els[id] = { value: "", textContent: "" });
    const pre = "let recs = S.recs, assigns = S.assigns, tombs = S.tombs || {}, profiles = {}, source = 'storage', sortKey = 'startedAt', sortDir = -1;\nconst testsById = {};\n(window.TEST_MANIFEST || []).forEach(t => { testsById[t.testId] = t; (t.legacyIds || []).forEach(o => { testsById[o] = t; }); });\n";
    return new Function("S", "esc", "escAttr", "$", "window", "AssignmentRules", "AttemptScope", "StudentCode", "Date",
      pre + src + "\nreturn { scopeBadgeHtml, assignScopeText, viewAttempts, viewStudents, exposureHtml };")(
      seed, esc, escAttr, $, { TEST_MANIFEST: MANIFEST }, R, S, { valid: () => true, normalize: c => c }, Date);
  }
  const mathRec = { attemptId: "attempt:" + FORM_ID + ":1:a", student: { code: CODE, key: CODE }, testId: FORM_ID, testName: "T", status: "completed", conditions: "self-administered", released: false,
    startedAt: "2026-10-01T10:00:00.000Z", submittedAt: "2026-10-01T11:00:00.000Z", scope: { modules: ["ma1", "ma2"], selectedByStudent: true },
    score: { correct: 30, graded: 44, noKey: 0, bySection: { "Math": { correct: 30, graded: 44 } }, byModule: {} },
    answers: { "ma1-q1": { given: 0, correct: true, visitCount: 1 }, "ma2-q1": { given: 0, correct: true, visitCount: 1 } } };
  const d = dash(dashSrc, { recs: [mathRec], assigns: [] });
  const badge = d.scopeBadgeHtml(mathRec);
  check(/<span class="dstatus tm">Math only <span class="sd-sel" title="[^"]+">\(student-selected\)<\/span><\/span>/.test(badge), "the record badge: 'Math only' with the student-selected mark", badge);
  check(d.scopeBadgeHtml({}) === "" && d.scopeBadgeHtml({ scope: { modules: ['"><img src=x>'] } }) === "" && d.scopeBadgeHtml({ scope: { modules: ["re1"], selectedByStudent: "yes" } }) === ' <span class="dstatus tm">Single module · RW Module 1</span>',
    "no badge for a full or crafted scope; a single module without the mark unless the flag is the literal true");
  check(d.assignScopeText({}) === "Full test" && d.assignScopeText({ scopePolicy: { mode: "fixed", modules: ["re1", "re2"] } }) === "Reading and Writing" &&
        d.assignScopeText({ scopePolicy: { mode: "student-choice", allowed: ["full", "math"] } }) === "Student chooses: Full test, Math",
    "the Assignments table's Scope text: the fixed preset, or the student's options");
  const va = d.viewAttempts([mathRec]);
  check(va.indexOf(badge) !== -1 && va.indexOf("<b>30/44</b>") !== -1, "the Attempts row carries the badge in its Test cell and the record's own 30/44");
  const vs = d.viewStudents([mathRec]);
  check(/<td><b>30\/44<\/b><\/td>\s*<td>—<\/td>\s*<td>30\/44<\/td>/.test(vs) && vs.indexOf("Math only") !== -1, "the Students card: Score 30/44, RW '—' (absent, never 0/0), Math 30/44, the badge", vs.slice(vs.indexOf("<tbody>"), vs.indexOf("<tbody>") + 400));
  /* the modules-already-sat line */
  const ex = d.exposureHtml([CODE], FORM_ID);
  check(/has sat 2026 June Asia v2: Math Module 1 <span class="dash-hint">\(completed [^)]+\)<\/span>, Math Module 2 <span class="dash-hint">\(completed [^)]+\)<\/span>\./.test(ex),
    "the exposure line names the two Math modules as sat (completed, dated) and nothing of Reading and Writing", ex);
  const d2 = dash(dashSrc, { recs: [Object.assign({}, mathRec, { status: "in-progress", scope: undefined, answers: { "re1-q1": { visitCount: 2 }, "re2-q1": { visitCount: 0 } } })], assigns: [] });
  check(/has sat 2026 June Asia v2: RW Module 1 <span class="dash-hint">\(in-progress [^)]+\)<\/span>\./.test(d2.exposureHtml([CODE], FORM_ID)), "an in-progress pre-scope record counts only the modules it opened (RW Module 1)");
  const UNKNOWN = /has sat 2026 June Asia v2: sat — modules unknown \(no live record of it in storage: archived away, or deleted\)\./;
  const d3 = dash(dashSrc, { recs: [], assigns: [{ code: CODE, list: [{ assignmentId: "a-h", testId: FORM_ID, category: "practice", completedAttemptId: "attempt:" + FORM_ID + ":9:gone" }] }] });
  check(UNKNOWN.test(d3.exposureHtml([CODE], FORM_ID)), "a row Completed by hint alone (its record archived away) reads 'sat — modules unknown'");
  /* a DELETED completed record: the row stays Completed (the tombstone rule), the button counts the test as sat — so does this line, without the deleted record's slots */
  const delRec = Object.assign({}, mathRec, { assignmentId: "a-d" });
  const d4 = dash(dashSrc, { recs: [delRec], tombs: { ["tomb:" + delRec.attemptId]: { kind: "tombstone", targetKind: "attempt", target: delRec.attemptId, code: CODE, status: "completed" } },
    assigns: [{ code: CODE, list: [{ assignmentId: "a-d", testId: FORM_ID, category: "practice", completedAttemptId: null }] }] });
  check(UNKNOWN.test(d4.exposureHtml([CODE], FORM_ID)) && d4.exposureHtml([CODE], FORM_ID).indexOf("Math Module") === -1,
    "a deleted completed record: the line agrees with the row (sat — modules unknown) and shows none of the deleted record's modules");
  check(/has sat 2026 June Asia v2: none of its modules yet\./.test(dash(dashSrc, { recs: [], assigns: [] }).exposureHtml([CODE], FORM_ID)), "nothing sat: 'none of its modules yet'");
  const MUT = dashSrc.replace("    const sc = AttemptScope.scopeOf(r);\n    const lbl = AttemptScope.label(sc, sc.selected);\n    if(!lbl) return \"\";", "    return \"\";\n    const sc = AttemptScope.scopeOf(r);\n    const lbl = AttemptScope.label(sc, sc.selected);\n    if(!lbl) return \"\";");
  control(MUT !== dashSrc, "the mutant differs from the source");
  const dm = dash(MUT, { recs: [mathRec], assigns: [] });
  control(dm.viewAttempts([mathRec]).indexOf("Math only") === -1 && dm.viewStudents([mathRec]).indexOf("Math only") === -1, "with the badge emptied neither table says 'Math only' — which the checks above catch");
});

/* ================= §9 the SPR audit over a partial record ================= */
await run("9. the SPR audit audits a partial record (its SPR answers counted; a wrong stored verdict caught)", async () => {
  if(!S) return check(false, "no AttemptScope");
  const rec = await drive(load(), S.testFor(FORM, S.fromPreset("math")), { scope: { modules: ["ma1", "ma2"], selectedByStudent: false } });
  /* give every Math SPR its key (the driver answers only question 1 of each module) so the audit has SPR answers to count */
  const sprIds = [];
  FORM.modules.slice(2).forEach(m => m.questions.forEach(q => { if(q.type === "spr" && G.hasKey(q)){ sprIds.push(q.id); rec.answers[q.id].given = String(q.correctAnswer); rec.answers[q.id].correct = true; } }));
  const write = (name, records) => { const p = path.join(os.tmpdir(), "partial-audit-" + name + "-" + process.pid + ".json"); fs.writeFileSync(p, JSON.stringify({ schema: "acestem-attempt-archive-v1", records: records })); return p; };
  const audit = f => { const env = Object.assign({}, process.env, { SPR_AUDIT_ONLY: "1" });
    try{ return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, "spr-grading.test.js"), f], { cwd: repo, env, encoding: "utf8" }) }; }
    catch(e){ return { code: e.status || 1, out: String(e.stdout || "") + String(e.stderr || "") }; } };
  const good = write("good", [rec]);
  const r1 = audit(good);
  const m = /1 record\(s\), (\d+) answered SPR item\(s\)/.exec(r1.out);
  check(r1.code === 0 && !!m && +m[1] === sprIds.length && sprIds.length > 0, "an export holding ONE Math-only record passes the audit with its " + sprIds.length + " SPR answers counted (audited, not skipped)", (m ? m[0] : r1.out.slice(-300)));
  const bad = JSON.parse(JSON.stringify(rec));
  bad.answers[sprIds[0]].correct = false;
  const wrong = write("wrong", [bad]);
  const r2 = audit(wrong);
  check(r2.code === 1 && /stored verdict/i.test(r2.out), "…and a wrong stored verdict in that partial record FAILS the audit (the records audit reads it)", r2.out.slice(-300));
  [good, wrong].forEach(p => { try{ fs.unlinkSync(p); }catch(e){} });
});

/* ================= §10 source pins ================= */
await run("10. every consumer goes through the one seam; the archive is untouched; a pre-scope record reads as full", async () => {
  const pin = (fn, re, what) => check(re.test(extractFn(appSrc, fn)), fn + " " + what);
  pin("openScoreDetailsLoaded", /test = AttemptScope\.testFor\(test, record\);[\s\S]*buildScoreRows\(test, record\)/, "scopes the form BEFORE buildScoreRows (Score Details, Review Mode, the print DOM)");
  pin("resumeTestFlowLoaded", /test = AttemptScope\.testFor\(test, record\);[\s\S]*buildModuleStateFromRecord\(test, record\)/, "scopes the pinned build BEFORE buildModuleStateFromRecord (resume and crash-resume)");
  pin("startTestFlowLoaded", /test = AttemptScope\.testFor\(test, scope\);\s*state\.currentTest = test;/, "runs the sitting on the scoped copy");
  pin("storedModuleRaw", /AttemptScope\.testFor\(test, record\)\.modules\.forEach/, "reads only the sat modules' raws (the Past card)");
  pin("scPrefillSource", /AttemptScope\.scopeOf\(r\)\.kind !== "full"\) return false/, "skips partial records (the calculator prefill)");
  pin("crashResumeCandidate", /AttemptScope\.scopeOf\(rec\)\.modules\.length/, "range-checks against the record's scope");
  pin("renderScoreDetails", /scaledScores\(test, rawRw, rawMath, moduleRaw, scope\)/, "converts with the scope");
  pin("renderPastCards", /storedModuleRaw\(loadedTest, record\), scope\)/, "converts with the scope");
  check(!/AttemptScope\.testFor\(state\.currentTest/.test(appSrc) && !/testFor\(sdCtx\.test/.test(appSrc), "the seam is never handed an already-scoped copy (a copy loses its section ordinals)");
  const sites = (appSrc.match(/AttemptScope\.testFor\(/g) || []).length;
  check(sites === 4, "AttemptScope.testFor is called in exactly four places in app.js (start, resume, Score Details, storedModuleRaw)", String(sites));
  check(/schema: "acestem-attempt-archive-v1",\s*exportedAt: new Date\(\)\.toISOString\(\),\s*records: recs,/.test(extractFn(dashSrc, "exportAll")), "the archive export is the records as stored, under the unchanged schema name");
  check(/AttemptScope\.PRESET_NAMES\.filter\(n => \{ const cb = \$\("afScopeAllow_" \+ n\)/.test(extractFn(dashSrc, "createAssignment")) && /rowVersion: AssignmentRules\.ROW_VERSION/.test(extractFn(dashSrc, "createAssignment")),
    "createAssignment reads the ticked presets through the closed list and stamps rowVersion from the shared constant");
  /* the two scope readers are the only ones: nobody re-derives a scope from the record's own modules */
  check(!/record\.scope\.modules|r\.scope\.modules|rec\.scope\.modules/.test(appSrc.replace(/\/\*[\s\S]*?\*\//g, "")) && !/r\.scope\.modules|record\.scope\.modules/.test(dashSrc.replace(/\/\*[\s\S]*?\*\//g, "")),
    "neither app.js nor dashboard.js reads record.scope.modules directly — every read goes through AttemptScope");
  /* a pre-scope record reads as full on every reader */
  const pre = { attemptId: "attempt:x:1:a", testId: FORM_ID, status: "completed", answers: {}, modules: [], score: { correct: 1, graded: 2 } };
  check(S.scopeOf(pre).kind === "full" && S.testFor(FORM, pre) === FORM && S.label(pre) === "" && S.scoreLabel(pre) === "", "a record written before scope existed: full, the very form, no label");
});

finished = true;
console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
})();
