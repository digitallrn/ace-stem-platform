/* tests/set-flow.test.js — run: node tests/set-flow.test.js (from the repo root)

   Custom practice sets, the record-side contracts:
   1. ADDITIVE record shape — a form attempt's record carries exactly the
      fields it always has; the set fields appear only on set attempts.
   2. THE SNAPSHOT — begin() freezes the resolved question list (deep copy);
      mutating the caller's array afterwards changes nothing.
   3. RELEASE — finalize() releases a set attempt on submit (the local-mode
      rule; the server re-derives independently), holds it when the
      assignment said hold, and NEVER releases a form attempt (control).
   4. RESUMABILITY — attemptResumable's set branch requires every snapshot
      source to be servable.
   5. ASSIGNMENT INDEX — set assignments match attempts only by explicit
      assignmentId and never consume untagged attempts; form fallback
      counting ignores them.
   6. REVIEW REBUILD — buildSetTestFromRecord: drift notice when a form
      moved on, error stub when a bank qid is gone, throw on pinned resume
      when the recorded build is unavailable.
   7. SYNC ELIGIBILITY — a set attempt's key keeps the attempt: prefix and
      enqueues through the same fn_upsert_attempt queue in remote mode. */
"use strict";
const fs = require("fs");
const vm = require("vm");
const pathmod = require("path");
const { extractFn, extractConst } = require("./extract-helper");

const attemptsSrc = fs.readFileSync("attempts.js", "utf8");
const appSrc = fs.readFileSync("app.js", "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}

/* ---- attempts.js sandbox (local-mode.test.js pattern) ---- */
function load(opts){
  opts = opts || {};
  const sandbox = {
    localStorage: {
      _d: {}, setItem(k, v){ this._d[k] = v; },
      getItem(k){ return k in this._d ? this._d[k] : null; },
      removeItem(k){ delete this._d[k]; },
      key(i){ return Object.keys(this._d)[i]; },
      get length(){ return Object.keys(this._d).length; }
    },
    location: { search: opts.search || "" },
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
  if(opts.config) sandbox.ACESTEM_CONFIG = opts.config;
  vm.createContext(sandbox);
  vm.runInContext(attemptsSrc, sandbox);
  return sandbox;
}
const CODE = "AS-7K4M9PXR";
const waitForSave = async (sandbox, attemptId, predicate) => {
  for(let i = 0; i < 40; i++){
    const raw = sandbox.localStorage.getItem("devstore:" + attemptId);
    if(raw){
      const r = JSON.parse(raw);
      if(!predicate || predicate(r)) return r;
    }
    await new Promise(res => setImmediate(res));
  }
  return null;
};

function makeFormTest(){
  return { testId: "202606asiav2", testName: "2026 June Asia v2", testVersion: "2026-08-09-a",
    modules: [{ moduleId: "m1", section: "Math", moduleLabel: "Module 1", timeLimitMinutes: 35,
      questions: [{ id: "ma1-q1", type: "mcq", correctAnswer: 2 }] }] };
}
function makeSetTest(){
  return { testId: "pset-100-ab", testName: "Linear practice", kind: "set",
    modules: [{ moduleId: "pset-100-ab-m1", section: "Math", moduleLabel: "Module 1",
      setTitle: "Linear practice — Math", timeLimitMinutes: 0,
      questions: [
        { id: "bank-david-core:q0001", type: "mcq", correctAnswer: 2 },
        { id: "202606asiav2:ma1-q1", type: "mcq", correctAnswer: 0 }
      ] }] };
}
const SET_META = () => ({ kind: "set", setId: "pset-100-ab", setName: "Linear practice",
  subject: "math",
  questions: [
    { ref: "bank-david-core:q0001", source: "bank", bankId: "bank-david-core", qid: "q0001", bankVersion: "sha-23154ea489a4" },
    { ref: "202606asiav2:ma1-q1", source: "form", testId: "202606asiav2", moduleId: "m1", qid: "ma1-q1", testVersion: "2026-08-09-a" }
  ],
  releaseOnSubmit: true });
function makeAppState(test){
  const ms = {};
  test.modules.forEach(m => { ms[m.moduleId] = { answers: {}, flags: new Set(), eliminated: {}, passageHtml: {}, stemHtml: {}, choiceHtml: {}, notes: {} }; });
  return { currentTest: test, moduleIndex: 0, questionIndex: 0, timeRemainingSec: 100,
    untimed: false, elapsedSec: 0, moduleState: ms };
}

(async () => {
  console.log("--- 1+2. record shape: additive, snapshot frozen ---");
  {
    const w = load();
    const form = makeFormTest();
    w.Attempts.begin(form, CODE, "self-administered", makeAppState(form), "a-1-x", 1);
    const formRec = await waitForSave(w, w.Attempts.currentAttemptId());
    const GOLDEN_FORM_KEYS = ["recordVersion","attemptId","student","testId","testName",
      "testVersion","assignmentId","timing","conditions","startedAt","lastSavedAt",
      "submittedAt","status","released","modules","answers","score","client"].sort();
    check(!!formRec && JSON.stringify(Object.keys(formRec).sort()) === JSON.stringify(GOLDEN_FORM_KEYS),
      "a form attempt's record keys are exactly the pre-sets golden set",
      formRec ? Object.keys(formRec).sort().join(",") : "no record saved");

    const w2 = load();
    const setTest = makeSetTest();
    const meta = SET_META();
    w2.Attempts.begin(setTest, CODE, "self-administered", makeAppState(setTest), "a-2-y", "untimed", meta);
    const setId = w2.Attempts.currentAttemptId();
    check(typeof setId === "string" && setId.indexOf("attempt:pset-100-ab:") === 0,
      "set attempt key keeps the attempt:<setId>: prefix (sync + listing eligibility)");
    let setRec = await waitForSave(w2, setId);
    const extra = Object.keys(setRec).filter(k => GOLDEN_FORM_KEYS.indexOf(k) === -1).sort();
    check(JSON.stringify(extra) === JSON.stringify(["kind","releaseOnSubmit","setId","setName","setQuestions","subject"]),
      "set fields are exactly the additive six (kind, releaseOnSubmit, setId, setName, setQuestions, subject)",
      extra.join(","));
    check(setRec.kind === "set" && setRec.setId === "pset-100-ab" && setRec.subject === "math"
      && setRec.timing === "untimed" && setRec.released === false,
      "set record carries kind/setId/subject/timing, released starts false");
    check(Array.isArray(setRec.setQuestions) && setRec.setQuestions.length === 2
      && setRec.setQuestions[0].ref === "bank-david-core:q0001"
      && setRec.setQuestions[0].bankVersion === "sha-23154ea489a4"
      && setRec.setQuestions[1].testVersion === "2026-08-09-a",
      "snapshot holds per-question provenance (source, version, qid) in order");
    // freeze: mutate the caller's array — the record must not move
    meta.questions.push({ ref: "evil", source: "bank" });
    meta.questions[0].qid = "q9999";
    w2.Attempts.moduleStart(setTest.modules[0]);
    w2.Attempts.answerCommitted("bank-david-core:q0001", 2);
    w2.Attempts.moduleEnd(setTest.modules[0], "submitted");
    setRec = await waitForSave(w2, setId, r => !!(r.modules[0] && r.modules[0].endedAt));
    check(setRec.setQuestions.length === 2 && setRec.setQuestions[0].qid === "q0001",
      "mutating the caller's questions array after begin() cannot rewrite the snapshot");

    console.log("--- 3. release on submit (local rule) ---");
    w2.Attempts.finalize("submitted");
    setRec = await waitForSave(w2, setId, r => r.status === "completed" && r.released === true);
    check(!!setRec && setRec.status === "completed" && setRec.released === true,
      "finalize() releases a set attempt on submit (releaseOnSubmit true)");

    const w3 = load();
    const held = SET_META();
    held.releaseOnSubmit = false;
    const heldTest = makeSetTest();
    w3.Attempts.begin(heldTest, CODE, "self-administered", makeAppState(heldTest), "a-3-z", "untimed", held);
    const heldId = w3.Attempts.currentAttemptId();
    w3.Attempts.moduleStart(heldTest.modules[0]);
    w3.Attempts.moduleEnd(heldTest.modules[0], "submitted");
    w3.Attempts.finalize("submitted");
    const heldRec = await waitForSave(w3, heldId, r => r.status === "completed");
    check(!!heldRec && heldRec.released === false && heldRec.releaseOnSubmit === false,
      "a held set assignment stays unreleased at submit");

    // control: the rule must be set-gated — forms never self-release
    w.Attempts.moduleStart(form.modules[0]);
    w.Attempts.moduleEnd(form.modules[0], "submitted");
    w.Attempts.finalize("submitted");
    const doneForm = await waitForSave(w, formRec.attemptId, r => r.status === "completed");
    check(!!doneForm && doneForm.released === false,
      "CONTROL: a form attempt's finalize still leaves released false");
  }

  console.log("--- 4+5. resumability + assignment index (app.js extracts) ---");
  {
    const FN = ["archivedVersions","canServeVersion","testById","testIdAliases","attemptCompleted",
      "attemptResumable","setAttemptResumable","canServeBank","bankById","canonTestId",
      "isLegacyAssign","isSetAssign","categoryMatchesConditions","buildAssignmentIndex",
      "assignmentComplete","assignmentState"];
    const body = FN.map(n => extractFn(appSrc, n)).join("\n") + "\n" +
      extractConst(appSrc, "byStartDesc") + "\n" +
      extractConst(appSrc, "BANKCACHE_PREFIX") + "\n" +
      "return {archivedVersions,canServeVersion,testById,attemptCompleted,attemptResumable," +
      "setAttemptResumable,canServeBank,buildAssignmentIndex,assignmentComplete,assignmentState};";
    const mkWorld = () => {
      const state = { tests: [{ testId: "202606asiav2", testName: "T", testVersion: "2026-08-09-a", moduleCount: 1 }],
        assignments: null, assignAttempts: {}, resumeRecords: {} };
      const win = { TEST_ARCHIVE_INDEX: { "202606asiav2": ["2026-08-02-a"] },
        BANK_MANIFEST: [{ bankId: "bank-david-core", type: "bank", bankVersion: "sha-1" }],
        __TESTDATA__: {}, __BANKDATA__: {} };
      const ls = { _d: {}, key(i){ return Object.keys(this._d)[i]; },
        getItem(k){ return k in this._d ? this._d[k] : null; },
        get length(){ return Object.keys(this._d).length; } };
      const api = new Function("state", "window", "localStorage", body)(state, win, ls);
      return { state, win, ls, api };
    };

    const resumableSet = { kind: "set", status: "in-progress", checkpoint: { moduleIndex: 0 },
      assignmentId: "a-s1", testId: "pset-1", startedAt: "2026-08-30T01:00:00Z",
      setQuestions: [
        { ref: "bank-david-core:q0001", source: "bank", bankId: "bank-david-core", qid: "q0001", bankVersion: "sha-1" },
        { ref: "202606asiav2:ma1-q1", source: "form", testId: "202606asiav2", moduleId: "m1", qid: "ma1-q1", testVersion: "2026-08-09-a" }
      ] };
    let world = mkWorld();
    check(world.api.attemptResumable(resumableSet) === true,
      "set attempt resumable when every snapshot source is servable");
    const badBank = JSON.parse(JSON.stringify(resumableSet));
    badBank.setQuestions[0].bankId = "bank-unknown";
    check(world.api.attemptResumable(badBank) === false,
      "unknown bank in the snapshot blocks resume (fail-closed)");
    const badVer = JSON.parse(JSON.stringify(resumableSet));
    badVer.setQuestions[1].testVersion = "1999-01-01-z";
    check(world.api.attemptResumable(badVer) === false,
      "unservable form build in the snapshot blocks resume");
    const archived = JSON.parse(JSON.stringify(resumableSet));
    archived.setQuestions[1].testVersion = "2026-08-02-a";
    check(world.api.attemptResumable(archived) === true,
      "an ARCHIVED form build in the snapshot still resumes (same guarantee as tests)");
    const noSnap = { kind: "set", status: "in-progress", checkpoint: { moduleIndex: 0 } };
    check(world.api.attemptResumable(noSnap) === false,
      "a set record with no snapshot is not resumable");

    world = mkWorld();
    const setAssign = { assignmentId: "a-s1", kind: "set", category: "practice",
      setId: "pset-1", setName: "S", completedAttemptId: null };
    const formAssign = { assignmentId: "a-f1", testId: "202606asiav2", category: "practice",
      completedAttemptId: null };
    world.state.assignments = [setAssign, formAssign];
    const doneSet = { kind: "set", status: "completed", assignmentId: "a-s1",
      testId: "pset-1", startedAt: "2026-08-30T01:00:00Z" };
    const untaggedPractice = { status: "completed", testId: "202606asiav2",
      conditions: "self-administered", startedAt: "2026-08-29T01:00:00Z" };
    world.api.buildAssignmentIndex([doneSet, untaggedPractice]);
    check(world.state.assignAttempts["a-s1"].completed === doneSet,
      "a completed set attempt completes its assignment via explicit assignmentId");
    check(world.state.assignAttempts["a-f1"].completed === untaggedPractice,
      "the untagged-attempt fallback still fires for the sole FORM assignment (set assignments don't inflate the count)");
    check(world.api.assignmentState(setAssign) === "completed",
      "assignmentState(set) reads completed");

    world = mkWorld();
    world.state.assignments = [setAssign];
    world.api.buildAssignmentIndex([untaggedPractice]);
    check(!world.state.assignAttempts["a-s1"].completed && !world.state.assignAttempts["a-s1"].resumable,
      "a set assignment NEVER consumes an untagged attempt");
  }

  console.log("--- 6. review rebuild: drift banner, missing-bank error, pinned resume throw ---");
  {
    /* extractFn matches from the `function` keyword, so an `async function`
       loses its `async` — restore it for the one async extract */
    const body = extractFn(appSrc, "syntheticSetTest") + "\n" +
      extractFn(appSrc, "setStubQuestion") + "\n" +
      "async " + extractFn(appSrc, "buildSetTestFromRecord") +
      "\nreturn buildSetTestFromRecord;";
    const bank = { bankId: "bank-david-core", bankVersion: "sha-2",
      questions: [{ qid: "q0001", type: "mcq", questionText: "bq", choices: ["a","b","c","d"], correctAnswer: 2 }] };
    const formCurrent = { testId: "202606asiav2", testName: "2026 June Asia v2", testVersion: "2026-08-20-b",
      modules: [{ moduleId: "m1", questions: [{ id: "ma1-q1", type: "mcq", questionText: "fq", choices: ["a","b","c","d"], correctAnswer: 0 }] }] };
    const entry = { testId: "202606asiav2", testName: "2026 June Asia v2", testVersion: "2026-08-20-b" };
    const mk = (opts) => new Function("bankById", "loadBank", "testById", "canServeVersion", "loadTest", "num", body)(
      id => id === "bank-david-core" ? { bankId: "bank-david-core" } : null,
      async () => opts.bank || bank,
      id => id === "202606asiav2" ? entry : null,
      () => opts.canServe !== false,
      async (e, pin) => { if(opts.failPinned && pin) throw new Error("nope"); return formCurrent; },
      v => (typeof v === "number" && isFinite(v)) ? v : null
    );
    const record = { setId: "pset-1", setName: "S", subject: "math", timing: "untimed",
      modules: [{ timeLimitMinutes: 0 }],
      setQuestions: [
        { ref: "bank-david-core:q0001", source: "bank", bankId: "bank-david-core", qid: "q0001", bankVersion: "sha-1" },
        { ref: "202606asiav2:ma1-q1", source: "form", testId: "202606asiav2", moduleId: "m1", qid: "ma1-q1", testVersion: "2026-08-09-a" }
      ] };

    const out = await mk({})(record, false);
    check(out.test.modules[0].questions.length === 2 &&
      out.test.modules[0].questions[0].questionText === "bq",
      "review rebuild resolves both sources against current content");
    const driftKeys = Object.keys(out.notices);
    check(driftKeys.length === 1 && driftKeys[0] === "202606asiav2:ma1-q1"
      && out.notices[driftKeys[0]].kind === "drift"
      && out.notices[driftKeys[0]].text.indexOf("2026-08-09-a") !== -1
      && out.notices[driftKeys[0]].text.indexOf("2026-08-20-b") !== -1,
      "form drift produces exactly one banner NAMING the item and both versions");

    const goneBank = { bankId: "bank-david-core", bankVersion: "sha-2", questions: [] };
    const out2 = await mk({ bank: goneBank })(record, false);
    const n2 = out2.notices["bank-david-core:q0001"];
    check(!!n2 && n2.kind === "error" &&
      out2.test.modules[0].questions[0].correctAnswer === null,
      "a recorded bank qid missing from the loaded bank is an ERROR banner over a keyless stub — never silence");

    let threw = false;
    try{ await mk({ canServe: false })(record, true); }catch(e){ threw = true; }
    check(threw, "pinned resume THROWS when a recorded form build is unservable (no mismatched-content resume)");

    // banks never drift: same content, different bankVersion → no notice
    check(out.notices["bank-david-core:q0001"] === undefined,
      "a bankVersion difference alone produces NO banner (append-only content cannot drift)");
  }

  console.log("--- 6b. loadBank is version-aware (stale cache must not mask the current build) ---");
  {
    /* Regression for the adversarial review's stale-bank-cache finding: a
       device holding an older cached bank build must NOT have it served in
       place of the current build the manifest names — the set start path is
       fail-closed, so a stale cache there refuses a correctly-assigned set.
       Harness extracts loadBank + its cache helpers and INJECTS fetchBankFile
       (the real one builds a <script> tag). */
    const body =
      extractConst(appSrc, "BANKCACHE_PREFIX") + "\n" +
      extractFn(appSrc, "bankById") + "\n" +
      extractFn(appSrc, "canServeBank") + "\n" +
      extractFn(appSrc, "readCachedBank") + "\n" +
      extractFn(appSrc, "writeCachedBank") + "\n" +
      "async " + extractFn(appSrc, "loadBank") + "\n" +
      "return { loadBank, readCachedBank };";
    const mk = (opts) => {
      const ls = { _d: {}, setItem(k, v){ this._d[k] = v; },
        getItem(k){ return k in this._d ? this._d[k] : null; },
        removeItem(k){ delete this._d[k]; },
        key(i){ return Object.keys(this._d)[i]; },
        get length(){ return Object.keys(this._d).length; } };
      const win = {
        BANK_MANIFEST: [{ bankId: "bank-david-core", type: "bank", bankVersion: "sha-v2" }],
        __BANKDATA__: {}
      };
      let fetched = 0;
      const v2 = { bankId: "bank-david-core", bankName: "Core", bankVersion: "sha-v2",
        questions: [{ qid: "q0001", type: "mcq", correctAnswer: 2 },
                    { qid: "q0099", type: "mcq", correctAnswer: 0 }] };  // v2 adds q0099
      const fetchBankFile = async () => { fetched++; if(opts.offline) throw new Error("network"); return v2; };
      // seed ONLY the older v1 cache (no q0099)
      ls.setItem("acestem:bankcache:bank-david-core:sha-v1", JSON.stringify({
        bankId: "bank-david-core", bankName: "Core", bankVersion: "sha-v1",
        questions: [{ qid: "q0001", type: "mcq", correctAnswer: 2 }] }));
      const api = new Function("window", "localStorage", "fetchBankFile", body)(win, ls, fetchBankFile);
      return { api, ls, win, getFetched: () => fetched };
    };

    const online = mk({ offline: false });
    const got = await online.api.loadBank("bank-david-core");
    check(got.bankVersion === "sha-v2" && got.questions.some(q => q.qid === "q0099"),
      "online: loadBank fetches the CURRENT build, not the stale v1 cache",
      "got " + got.bankVersion + " (fetched " + online.getFetched() + "x)");
    check(online.getFetched() === 1,
      "online: the current build is actually fetched when only an older cache exists");

    const offline = mk({ offline: true });
    const got2 = await offline.api.loadBank("bank-david-core");
    check(got2.bankVersion === "sha-v1",
      "offline: falls back to the stale cache rather than throwing (append-only, per-qid fails downstream)");

    // exact-version read must never substitute a different build (fresh
    // harness: only sha-v1 is cached, nothing has fetched yet)
    const fresh = mk({ offline: true });
    check(fresh.api.readCachedBank("bank-david-core", "sha-v2") === null,
      "readCachedBank(id, exactVersion) returns null when only a DIFFERENT version is cached");
    check(fresh.api.readCachedBank("bank-david-core", "sha-v1") !== null,
      "readCachedBank(id, exactVersion) returns the build when that exact version IS cached");
  }

  console.log("--- 7. remote sync eligibility ---");
  {
    const w = load({ config: { SUPABASE_URL: "https://example-ref.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_testkey" } });
    const setTest = makeSetTest();
    w.Attempts.begin(setTest, CODE, "self-administered", makeAppState(setTest), "a-9", "untimed", SET_META());
    await waitForSave(w, w.Attempts.currentAttemptId());
    const q = JSON.parse(w.localStorage.getItem("devstore:__syncqueue") || "[]");
    check(q.length === 1 && q[0].kind === "attempt" && q[0].key.indexOf("attempt:pset-") === 0
      && q[0].code === CODE,
      "a set attempt enqueues through the same fn_upsert_attempt sync queue as a form attempt");
  }

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})();
