/* tests/attempts-recording.test.js — run: node tests/attempts-recording.test.js
   (from the repo root)

   Loads the REAL attempts.js in a vm sandbox — same technique as
   tests/local-mode.test.js — and drives its public API in the exact
   sequence app.js's beginModule()/renderQuestionView() call it in, so the
   proof exercises real recorder code, not a re-implementation of it.

   Two things proved:

   1. Question-1 timing (Work Item 1b). beginModule() used to call
      renderTest() — which stamps the CURRENT question's reading clock via
      Attempts.questionShown() — before Attempts.moduleStart(). moduleStart()
      unconditionally closes whatever clock is open, so the clock Q1 opened
      a moment earlier was immediately closed again, and nothing reopened it
      until the student navigated away — by which point there was no open
      clock left to close, so none of the time spent on Q1 was ever added.
      Fixed order: moduleStart() first, then the render (and its
      questionShown stamp). This file proves BOTH orders against the real
      recorder, so the "fails on current build" half of the control is the
      literal call order app.js used to make, not a description of it.

   2. Notes diagnostic (Work Item 5). A note created on a question (the
      shape el("hlNote")'s click handler in app.js writes: ms.notes[qid] =
      [{id, snippet, text}]) is captured into the SAME attempts.js the app
      uses, survives finalize(), and comes back out of storage in
      rec.annotations[moduleId].notes — i.e. capture and persistence are
      both intact. (Render — Work Item 5's remaining stage, restoreAnnotations
      + renderNotesRail in app.js — is already covered by
      tests/injection-proof.js's "Review Mode notes rail" and "Malformed
      annotation shapes" checks, which is real DOM and can't run outside a
      browser; see the notes-diagnostic report in the session summary for
      the full trace.) */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const repo = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(repo, "attempts.js"), "utf8");

function load(){
  let mockNow = 1_700_000_000_000;
  class FakeDate extends Date {
    static now(){ return mockNow; }
  }
  const store = {};
  const sandbox = {
    localStorage: {
      _d: {}, setItem(k, v){ this._d[k] = v; }, getItem(k){ return k in this._d ? this._d[k] : null; },
      removeItem(k){ delete this._d[k]; }, key(i){ return Object.keys(this._d)[i]; },
      get length(){ return Object.keys(this._d).length; }
    },
    location: { search: "" },
    document: { addEventListener(){}, createElement: () => ({}) },
    navigator: { userAgent: "node", onLine: true },
    screen: { width: 1, height: 1 },
    hasKey: () => false, answerMatches: () => false,
    // real recorder ticker is 45s (CHECKPOINT_MS) — stubbed inert so nothing
    // saves on a timer behind the test's back; every save in this file is
    // triggered explicitly by the call sequence being tested
    setInterval: () => 0, clearInterval(){}, setTimeout: () => 0, clearTimeout(){},
    fetch: () => Promise.reject(new Error("network blocked in test")),
    Date: FakeDate
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    AS: sandbox.AttemptStore, Attempts: sandbox.Attempts,
    advance(ms){ mockNow += ms; }
  };
}

function makeTest(){
  return {
    testId: "t1", testName: "Test One", testVersion: "v1",
    modules: [{
      moduleId: "m1", section: "Reading and Writing", moduleLabel: "1",
      timeLimitMinutes: 32, questions: [{ id: "q1" }, { id: "q2" }]
    }]
  };
}
function makeAppState(test){
  const moduleState = {};
  test.modules.forEach(m => {
    moduleState[m.moduleId] = { answers: {}, eliminated: {}, flags: new Set(),
      passageHtml: {}, stemHtml: {}, choiceHtml: {}, notes: {} };
  });
  return { currentTest: test, moduleIndex: 0, questionIndex: 0, moduleState,
    timeRemainingSec: 0, untimed: false, elapsedSec: 0 };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* save() queues behind an in-flight write and re-runs build() fresh once it
   drains (see attempts.js's save()), so an early, unspecific predicate (e.g.
   "answers.q1 exists") can be satisfied by begin()'s own initial save —
   before the moduleEnd/finalize write this test actually cares about has
   landed — and return a stale snapshot. Callers pass a predicate that can
   only be true on the write they mean (a field only THAT call sets), so
   polling can't mistake an earlier save for the later one. */
async function waitForSave(AS, attemptId, predicate){
  for(let i = 0; i < 40; i++){
    const rec = await AS.get(attemptId);
    if(rec && predicate(rec)) return rec;
    await sleep(15);
  }
  return await AS.get(attemptId);   // last read, even if the predicate never matched
}
const moduleEnded = r => !!(r.modules && r.modules[0] && r.modules[0].endedAt);

let pass = true;
const check = (ok, label, detail) => {
  if(!ok) pass = false;
  console.log((ok ? "PASS" : "FAIL") + " | " + label.padEnd(64) + (detail || ""));
};

(async () => {
  const CODE = "AS-7K4M9PXR";
  const mod = makeTest().modules[0];

  /* ---- 1a. the ORDER beginModule() used to call in (broken): render (and
     its questionShown stamp) before moduleStart ---- */
  {
    const w = load();
    const test = makeTest();
    const appState = makeAppState(test);
    w.Attempts.begin(test, CODE, "self-administered", appState, null, 1);
    w.Attempts.questionShown("q1");     // renderTest() -> renderQuestionView(), old order
    w.Attempts.moduleStart(mod);        // moduleStart's closeClock() immediately closes it
    w.advance(90 * 1000);               // student reads Q1 for 90 real seconds
    w.Attempts.questionShown("q2");     // navigates away — nothing open to close
    const attemptId = w.Attempts.currentAttemptId();
    w.Attempts.moduleEnd(mod, "submitted");
    const rec = await waitForSave(w.AS, attemptId, moduleEnded);
    const secs = rec && rec.answers && rec.answers.q1 && rec.answers.q1.timeSpentSeconds;
    check(secs === 0, "pre-fix call order: Q1 records zero seconds", "q1.timeSpentSeconds=" + secs);
  }

  /* ---- 1b. the FIXED order: moduleStart before render/questionShown ---- */
  {
    const w = load();
    const test = makeTest();
    const appState = makeAppState(test);
    w.Attempts.begin(test, CODE, "self-administered", appState, null, 1);
    w.Attempts.moduleStart(mod);        // fixed order
    w.Attempts.questionShown("q1");
    w.advance(90 * 1000);
    w.Attempts.questionShown("q2");     // first visit to q1 closes at 90s

    // revisit summing must still work, within the SAME still-open module —
    // moduleEnd fires exactly once, when the student actually submits it
    w.Attempts.questionShown("q1");     // back to q1 for a second look
    w.advance(30 * 1000);
    w.Attempts.questionShown("q2");     // closes q1's second visit at +30s

    const attemptId = w.Attempts.currentAttemptId();
    w.Attempts.moduleEnd(mod, "submitted");
    const rec = await waitForSave(w.AS, attemptId, moduleEnded);
    const secs = rec && rec.answers && rec.answers.q1 && rec.answers.q1.timeSpentSeconds;
    check(secs === 120, "fixed call order: Q1 records real elapsed time, revisits summed",
      "q1.timeSpentSeconds=" + secs + " (want 90+30=120)");
  }

  /* ---- 2. notes: captured (simulating what el("hlNote")'s click handler
     writes) and persisted through finalize() into rec.annotations ---- */
  {
    const w = load();
    const test = makeTest();
    const appState = makeAppState(test);
    w.Attempts.begin(test, CODE, "self-administered", appState, null, 1);
    w.Attempts.moduleStart(mod);
    w.Attempts.questionShown("q1");
    // exactly the shape app.js's hlNote handler writes into moduleState
    const ms = appState.moduleState.m1;
    ms.passageHtml.q1 = '<span class="hl c-yellow" data-note-id="n1">a highlighted phrase</span>';
    ms.notes.q1 = [{ id: "n1", snippet: "a highlighted phrase", text: "check this against the graph" }];
    w.advance(20 * 1000);
    const attemptId = w.Attempts.currentAttemptId();
    w.Attempts.finalize("submitted");
    const rec = await waitForSave(w.AS, attemptId, r => r.status === "completed");
    const notes = rec && rec.annotations && rec.annotations.m1 && rec.annotations.m1.notes;
    const n = notes && notes.q1 && notes.q1[0];
    check(!!n && n.id === "n1" && n.text === "check this against the graph",
      "notes: captured note survives finalize() into rec.annotations",
      "annotations.m1.notes.q1=" + JSON.stringify(notes && notes.q1));
    check(rec.status === "completed", "notes: sitting finalized normally alongside the note",
      "status=" + rec.status);
  }

  console.log(pass ? "\nALL RECORDING CASES PASS" : "\nFAILURES PRESENT");
  process.exit(pass ? 0 : 1);
})();
