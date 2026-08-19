/* tests/timer-drift.test.js — run: node tests/timer-drift.test.js (from the repo root)

   Proves the module countdown/elapsed timers are anchored to an absolute
   epoch timestamp and recomputed from Date.now() on every tick — not
   decremented/incremented once per setInterval tick — so a hidden or
   minimized tab's THROTTLED timer (Chrome clamps a hidden tab to roughly one
   tick a minute after ~5 minutes hidden; this project has already hit that
   during long proof runs) cannot make the displayed time, or the auto-submit
   trigger, drift behind real elapsed time.

   The real startTimer/tickCountdownTimer/tickUntimedTimer/resyncTimerOnReturn
   are pulled out of app.js by source text (app.js is a DOM-heavy single IIFE
   with no exports, so it can't be `require()`d or vm-loaded whole the way
   attempts.js can — see tests/local-mode.test.js) and evaluated in a tiny
   harness that fakes only what those functions touch: `state`, `el`/`show`/
   `hide`, `document`/`window` listener registration, a controllable
   `setInterval`/`clearInterval` (the test decides when a "tick" fires, so it
   can simulate a throttled tab by firing far fewer ticks than real seconds
   elapsed), a controllable `Date.now()`, and a `submitModule` spy.

   The pre-fix shape (tick-decrement, no Date.now involved at all) is pinned
   below VERBATIM as `oldStartTimer` — same technique tests/spr-grading.test.js
   uses for its old-vs-new comparison — so the control is self-contained: this
   file alone shows the replaced shape failing and the current shape passing,
   without needing a second git checkout. */

const fs = require("fs");
const path = require("path");
const repo = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(repo, "app.js"), "utf8");

/* ---- pull a named top-level function's source out of app.js verbatim ---- */
function extractFn(src, name){
  const re = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{");
  const m = re.exec(src);
  if(!m) throw new Error("function not found in app.js: " + name);
  let i = m.index + m[0].length, depth = 1;
  while(depth > 0 && i < src.length){
    if(src[i] === "{") depth++;
    else if(src[i] === "}") depth--;
    i++;
  }
  return src.slice(m.index, i);
}

const NEW_FNS = ["startTimer", "tickUntimedTimer", "tickCountdownTimer", "resyncTimerOnReturn"]
  .map(n => extractFn(appSrc, n)).join("\n\n");

/* the shape this fix replaces, pinned VERBATIM (copied from app.js before this
   fix — see git history around the 2026-08-19 timer-drift fix) so the control
   is honest about what actually shipped, not a paraphrase of it. Tick logic
   decrements a counter once per setInterval callback and never reads the
   clock at all — the bug this whole file exists to catch. */
const OLD_FNS = `
function startTimer(){
  clearInterval(state.timerInterval);
  updateTimerDisplay();
  if(state.untimed){
    state.timerInterval = setInterval(()=>{
      state.elapsedSec++;
      updateTimerDisplay();
    }, 1000);
    return;
  }
  state.timerInterval = setInterval(()=>{
    state.timeRemainingSec--;
    if(state.timeRemainingSec <= 0){
      state.timeRemainingSec = 0;
      updateTimerDisplay();
      clearInterval(state.timerInterval);
      submitModule("timer-expired");
      return;
    }
    if(state.timeRemainingSec === 300 && !state.fiveMinAlerted){
      state.fiveMinAlerted = true;
      state.timerHidden = false;
      el("timerBtn").textContent = "Hide";
      el("timerBtn").classList.add("hidden");
      show("fiveMinPopup");
    }
    updateTimerDisplay();
  }, 1000);
}
`;

/* ---- minimal harness: build {startTimer, ...} bound to a fresh fake world ---- */
function makeWorld(fnSrc){
  const calls = { submit: [] };
  const state = {
    timerInterval: null, timeRemainingSec: 0, elapsedSec: 0, untimed: false,
    fiveMinAlerted: false, timerHidden: false, timerRunning: false,
    timerEndAt: null, timerAnchorMs: null
  };
  let nowMs = 1_700_000_000_000;   // arbitrary fixed epoch, advanced by the test
  const FakeDate = { now: () => nowMs };
  let registered = null, nextId = 1;
  const fakeSetInterval = (fn) => { registered = fn; return nextId++; };
  const fakeClearInterval = () => {};
  const fakeEl = () => ({
    textContent: "", classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } }
  });
  const submitModule = (reason) => calls.submit.push(reason);
  const factory = new Function(
    "state", "el", "show", "hide", "document", "window",
    "clearInterval", "setInterval", "submitModule", "updateTimerDisplay", "Date",
    fnSrc + "\nreturn { startTimer, tickUntimedTimer, tickCountdownTimer, resyncTimerOnReturn };"
  );
  const fns = factory(
    state, fakeEl, ()=>{}, ()=>{}, { addEventListener(){} }, { addEventListener(){} },
    fakeClearInterval, fakeSetInterval, submitModule, ()=>{}, FakeDate
  );
  return {
    state, calls,
    fns,
    advance(ms){ nowMs += ms; },
    fireTick(){ if(registered) registered(); }
  };
}

/* OLD_FNS has no resyncTimerOnReturn (that function is new), so the factory
   call above would throw on a missing identifier — build old worlds with a
   trimmed factory instead. */
function makeOldWorld(){
  const calls = { submit: [] };
  const state = { timerInterval: null, timeRemainingSec: 0, elapsedSec: 0, untimed: false, fiveMinAlerted: false, timerHidden: false };
  let registered = null, nextId = 1;
  const fakeSetInterval = (fn) => { registered = fn; return nextId++; };
  const fakeEl = () => ({ textContent: "", classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } } });
  const submitModule = (reason) => calls.submit.push(reason);
  const factory = new Function(
    "state", "el", "show", "clearInterval", "setInterval", "submitModule", "updateTimerDisplay",
    OLD_FNS + "\nreturn { startTimer };"
  );
  const fns = factory(state, fakeEl, ()=>{}, ()=>{}, fakeSetInterval, submitModule, ()=>{});
  return { state, calls, fns, fireTick(){ if(registered) registered(); } };
}

let pass = true;
const check = (ok, label, detail) => {
  if(!ok) pass = false;
  console.log((ok ? "PASS" : "FAIL") + " | " + label.padEnd(64) + (detail || ""));
};

/* ============ 1. the shape this replaces DOES drift (control: fails) ============ */
{
  const w = makeOldWorld();
  w.state.timeRemainingSec = 1500;      // 25:00 module
  w.fns.startTimer();
  // tab hidden for the full 25 real minutes; throttling means only ONE tick
  // actually fires in that whole window (nothing in the old code reads a
  // clock, so "real minutes passed" has literally no effect on it below)
  w.fireTick();
  check(w.state.timeRemainingSec === 1499 && w.calls.submit.length === 0,
    "pre-fix startTimer: one throttled tick after 25 real minutes",
    "remaining=" + w.state.timeRemainingSec + " submits=" + w.calls.submit.length +
    " (decremented by 1, did not auto-submit — this is the drift bug)");
}

/* ============ 2. the current shape does NOT drift ============ */
{
  const w = makeWorld(NEW_FNS);
  w.state.timeRemainingSec = 1500;
  w.fns.startTimer();
  w.advance(1500 * 1000);               // 25 real minutes pass while hidden
  w.fireTick();                         // the one throttled tick that fires
  check(w.state.timeRemainingSec === 0 && w.calls.submit.length === 1 && w.calls.submit[0] === "timer-expired",
    "current startTimer: one throttled tick after 25 real minutes",
    "remaining=" + w.state.timeRemainingSec + " submits=" + JSON.stringify(w.calls.submit));
}

/* ============ 3. a partial throttled gap recomputes correctly, not just at 0 ============ */
{
  const w = makeWorld(NEW_FNS);
  w.state.timeRemainingSec = 1500;
  w.fns.startTimer();
  w.advance(400 * 1000);                // 6:40 passes hidden
  w.fireTick();
  check(w.state.timeRemainingSec === 1100,
    "current startTimer: mid-module throttled gap recomputes exactly",
    "remaining=" + w.state.timeRemainingSec + " (want 1100)");
}

/* ============ 4. five-minute alert still fires even when a throttled tick
   skips straight past the exact 300s mark ============ */
{
  const w = makeWorld(NEW_FNS);
  w.state.timeRemainingSec = 310;
  w.fns.startTimer();
  w.advance(70 * 1000);                 // jumps from 310 to 240 in one tick — skips 300 exactly
  w.fireTick();
  check(w.state.timeRemainingSec === 240 && w.state.fiveMinAlerted === true,
    "current startTimer: five-minute alert survives skipping the exact tick",
    "remaining=" + w.state.timeRemainingSec + " fiveMinAlerted=" + w.state.fiveMinAlerted);
}

/* ============ 5. visibilitychange/focus resync closes the gap WITHOUT
   waiting for a tick at all ============ */
{
  const w = makeWorld(NEW_FNS);
  w.state.timeRemainingSec = 600;
  w.fns.startTimer();
  w.advance(650 * 1000);                // already expired while hidden — no tick has fired yet
  w.fns.resyncTimerOnReturn();          // the tab-return handler, called directly
  check(w.state.timeRemainingSec === 0 && w.calls.submit.length === 1,
    "resyncTimerOnReturn: catches an already-expired countdown with zero ticks",
    "remaining=" + w.state.timeRemainingSec + " submits=" + JSON.stringify(w.calls.submit));
}

/* ============ 6. resync is a no-op when no timer is actually live (home,
   break, review, between modules) ============ */
{
  const w = makeWorld(NEW_FNS);
  w.state.timeRemainingSec = 900;
  w.state.timerRunning = false;         // e.g. saveAndExit / submitModule / openReviewMode already ran
  w.advance(999 * 1000);
  w.fns.resyncTimerOnReturn();
  check(w.state.timeRemainingSec === 900 && w.calls.submit.length === 0,
    "resyncTimerOnReturn: no-ops when timerRunning is false",
    "remaining=" + w.state.timeRemainingSec);
}

/* ============ 7. deliberate pause (Save-and-Exit / crash-resume) still
   freezes remaining time across however much real time passes, and
   restarting counts down from exactly where it left off ============ */
{
  const w = makeWorld(NEW_FNS);
  w.state.timeRemainingSec = 600;
  w.fns.startTimer();
  w.advance(60 * 1000);
  w.fireTick();
  check(w.state.timeRemainingSec === 540, "pause: countdown correct right before pausing",
    "remaining=" + w.state.timeRemainingSec);

  // saveAndExit()'s own pause: clearInterval + timerRunning=false
  w.state.timerRunning = false;
  w.advance(5 * 60 * 1000);             // 5 real minutes pass while exited
  w.fns.resyncTimerOnReturn();          // must be inert while paused
  check(w.state.timeRemainingSec === 540,
    "pause: remaining time untouched by real time elapsed while exited",
    "remaining=" + w.state.timeRemainingSec + " (want 540, unchanged)");

  // resume: beginModule() -> startTimer() re-anchors off the SAME timeRemainingSec
  w.fns.startTimer();
  w.advance(10 * 1000);
  w.fireTick();
  check(w.state.timeRemainingSec === 530,
    "pause: resumed countdown continues from where it paused, not from a drifted value",
    "remaining=" + w.state.timeRemainingSec + " (want 530)");
}

console.log(pass ? "\nALL TIMER-DRIFT CASES PASS" : "\nFAILURES PRESENT");
process.exit(pass ? 0 : 1);
