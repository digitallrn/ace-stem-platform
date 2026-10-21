/* tests/viewer-proof.js — the browser half of the tutor test viewer's proof
   (the node half is tests/test-viewer.test.js).

   The viewer's first rule is that it WRITES NOTHING. This walks EVERY
   question of EVERY manifest form through the real dashboard and the real
   viewer — Show answers both ways — and then diffs: every Storage write
   CALL (an identical re-write counts), the whole of localStorage byte for
   byte (the offline content cache and the sync queue included), and every
   request (no non-GET of any kind; in remote mode no server call at all).
   It also checks, on every question, that what renders is what a sitting
   renders minus the key when answers are off, and with the key marked the
   way Review Mode marks it when they are on.

   RUN IT on a page fresh from load, sign-in screen showing, nothing
   remembered, in each of three places (repo root served by
   .claude/launch.json "repo-preview" on :8930, dist/ by "dist-preview" on
   :8931):
     remote mode:  http://localhost:8930/   (the gitignored config.js puts the
                   repo root in remote mode; this proof replaces fetch BEFORE
                   anything signs in, so not one request leaves the page —
                   the tutor "sign-in" is answered by the stub). The full walk.
     local mode, split build: a copy of the served files WITHOUT config.js,
                   opened with ?devstorage=1 — the full walk + recorder leg,
                   content over the network path.
     local mode, single file: http://localhost:8931/index-live.html — the
                   full walk + recorder leg, content from memory.
   Opened as http://localhost:8930/?devstorage=1 (a server deployment forced
   local, as ?devstorage=1 on the live site is) it proves the OTHER half: the
   password-free acestem-admin dashboard lists the forms and opens none.
   then in the console:
     const p = (0,eval)(await (await fetch("/tests/viewer-proof.js", {cache:"reload"})).text());
     const res = await p;   // ~2-6 min for all forms; stash p and poll if your console times out
   `res` is {pass, results:[{check, pass, note}], stats}; the table also goes
   to console.table. window.VIEWER_PROOF_OPTS = {forms:["202606asiav1"]}
   limits the walk (the full run is the proof; a subset is for iterating).
   It refuses to start on a dirty origin (a remembered code, a non-empty sync
   queue), and removes exactly the keys its own setup created when it ends.

   LOCAL MODE also runs the recorder leg: a student starts a sitting and
   backs out at the Ready screen, which leaves the recorder ATTACHED to the
   app's shared state across sign-out; the tutor then opens the viewer, and
   forced tab-hide / unload / online events must write nothing. (Without the
   viewer's detach, that flush would rebuild the student's record from the
   viewer's empty answers.)

   CONTROLS. The in-page controls prove the write net can see a write and
   (remote) that the stub saw the server calls. The guard controls are
   mutant builds made by `node tests/viewer-proof-mutants.js`: the real app
   with ONE guard removed each (the viewer loading through the caching
   loadTest; the detach removed; the exit through Dashboard.open; Report a
   bug shown; the key leaking with answers off; a server deployment's local
   dashboard allowed in) — that file lists each target, how to open it, and
   the check this proof must turn red on it. A proof that cannot fail proves
   nothing.

   It needs a real viewport (it refuses below 1000×600: a background tab can
   report 0×0, where layout checks mean nothing). In a hidden pane the
   timers it waits on are throttled; routing setTimeout through a
   MessageChannel before evaluating it keeps a full run to minutes (that
   changes no check). */
(async () => {
  "use strict";
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = id => { const e = $(id); return !!e && !e.classList.contains("hidden"); };
  async function until(fn, ms, what){
    const t0 = Date.now();
    while(Date.now() - t0 < ms){
      try{ if(fn()) return true; }catch(e){}
      await sleep(20);
    }
    throw new Error("timed out waiting for " + what);
  }
  const results = [];
  const check = (name, ok, note) => { results.push({ check: name, pass: !!ok, note: note == null ? "" : String(note).slice(0, 300) }); return !!ok; };
  const OPTS = window.VIEWER_PROOF_OPTS || {};
  const MODE = AttemptStore.mode();
  const stats = { mode: MODE, forms: 0, questions: 0, renders: 0, scriptGets: 0, failures: 0 };
  const failLog = [];              // per-question assertion failures, capped
  const qfail = (where, what) => { stats.failures++; if(failLog.length < 40) failLog.push(where + ": " + what); };

  /* ---------- preconditions: a clean origin, nothing that could write for us ---------- */
  if(MODE !== "local" && MODE !== "remote") throw new Error("viewer-proof runs in local (?devstorage=1) or remote mode; this page is " + MODE);
  if(!visible("screen-signin")) throw new Error("open the page fresh: the sign-in screen must be showing");
  if(localStorage.getItem("acestem:code")) throw new Error("acestem:code is set on this origin — remove it first (the page would sign that student in)");
  if(localStorage.getItem("devstore:__syncqueue") && localStorage.getItem("devstore:__syncqueue") !== "[]")
    throw new Error("the sync queue on this origin is not empty — a forced 'online' would drain it and read as the viewer's write");
  if(MODE === "remote" && AttemptStore.hasAuthToken()) throw new Error("a tutor token is already held — reload first");
  if(typeof window.AppTestViewer !== "object") throw new Error("this build has no AppTestViewer");
  /* the layout checks (the toggle never moves the pane) need a real
     viewport: a background tab can report 0×0, where every column is sized
     by its content and the measurement means nothing */
  if(window.innerWidth < 1000 || window.innerHeight < 600)
    throw new Error("viewer-proof needs a real viewport of at least 1000×600 (this one is " + window.innerWidth + "×" + window.innerHeight + ") — front the tab or emulate a desktop size");
  const keysAtStart = new Set(Object.keys(localStorage));

  /* ---------- the write net ---------- */
  const NET = { phase: "setup", storage: [], fetch: [], xhr: [], beacon: [], scripts: [] };
  const P = Storage.prototype;
  const ORIG = { setItem: P.setItem, removeItem: P.removeItem, clear: P.clear, fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open, beacon: navigator.sendBeacon };
  P.setItem = function(k, v){ NET.storage.push({ phase: NET.phase, op: "set", key: String(k) }); return ORIG.setItem.call(this, k, v); };
  P.removeItem = function(k){ NET.storage.push({ phase: NET.phase, op: "remove", key: String(k) }); return ORIG.removeItem.call(this, k); };
  P.clear = function(){ NET.storage.push({ phase: NET.phase, op: "clear" }); return ORIG.clear.call(this); };
  XMLHttpRequest.prototype.open = function(m, u){ NET.xhr.push({ phase: NET.phase, method: String(m), url: String(u) }); return ORIG.xhrOpen.apply(this, arguments); };
  if(navigator.sendBeacon) navigator.sendBeacon = function(u){ NET.beacon.push({ phase: NET.phase, url: String(u) }); return true; };
  const SERVER_ROWS = [{ key: "student:AS-VWPRF234", owner_code: "AS-VWPRF234", value: { displayName: "Viewer Proof" } }];
  const json = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { "Content-Type": "application/json" } });
  window.fetch = async function(input, init){
    const url = String((input && input.url) || input);
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const headers = (init && init.headers) || {};
    NET.fetch.push({ phase: NET.phase, method, url });
    const sameOrigin = url.indexOf("http") !== 0 || url.indexOf(location.origin + "/") === 0;
    if(sameOrigin && method === "GET") return ORIG.fetch.call(window, input, init);
    /* nothing leaves the page: the "server" is this stub */
    if(/\/auth\/v1\/token/.test(url)) return json({ access_token: "viewer-proof-token", token_type: "bearer", user: { email: "viewer-proof@example.test" } });
    if(/\/rest\/v1\/records\?/.test(url) && method === "GET"){
      const range = String(headers.Range || headers.range || "0-499");
      return json(/^0-/.test(range) ? SERVER_ROWS : []);
    }
    return json(method === "GET" ? [] : null);
  };
  const scriptObs = new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
    if(n.tagName === "SCRIPT" && n.src) NET.scripts.push({ phase: NET.phase, src: n.src });
  })));
  scriptObs.observe(document.head, { childList: true });
  function uninstall(){
    P.setItem = ORIG.setItem; P.removeItem = ORIG.removeItem; P.clear = ORIG.clear;
    window.fetch = ORIG.fetch; XMLHttpRequest.prototype.open = ORIG.xhrOpen;
    if(ORIG.beacon) navigator.sendBeacon = ORIG.beacon;
    scriptObs.disconnect();
  }
  const snapshot = () => {
    const o = {};
    for(let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); o[k] = localStorage.getItem(k); }
    return o;
  };

  let report;
  const EARLY = {};                  // a finished early leg, not a harness error
  try{
    /* the net can see a write — every zero-write check below leans on this */
    localStorage.setItem("viewerproof:probe", "1");
    localStorage.removeItem("viewerproof:probe");
    check("Proof can observe a storage write (guards every zero-write check)",
      NET.storage.filter(w => w.key === "viewerproof:probe").length === 2);

    const forms = (window.TEST_MANIFEST || []).filter(t => t && t.testId)
      .slice().sort((a, b) => a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0)
      .filter(t => !OPTS.forms || OPTS.forms.indexOf(t.testId) !== -1);

    /* the EXPECTED content comes from the proof's own read of each shipped
       file, never from the app's loaders (they are what is under test, and the
       viewer puts memory back as it found it, so __TESTDATA__ is no oracle).
       A single-file build has every test inlined, so memory serves there. */
    const CONTENT = {};
    for(const t of (window.TEST_MANIFEST || []).filter(x => x && x.testId)){
      const mem = window.__TESTDATA__ && window.__TESTDATA__[t.testId];
      if(mem && mem.testVersion === t.testVersion){ CONTENT[t.testId] = mem; continue; }
      const res = await ORIG.fetch.call(window, "testdata/" + encodeURIComponent(t.testId) + ".js", { cache: "no-store" });
      if(!res.ok) throw new Error("setup: could not read testdata/" + t.testId + ".js (" + res.status + ")");
      const box = { __TESTDATA__: {} };
      new Function("window", await res.text())(box);
      CONTENT[t.testId] = box.__TESTDATA__[t.testId];
      if(!CONTENT[t.testId] || CONTENT[t.testId].testVersion !== t.testVersion) throw new Error("setup: testdata/" + t.testId + ".js is not the manifest's build");
    }

    /* ---------- tutor-only: no route in from outside the dashboard ---------- */
    const r0 = await window.AppTestViewer.open(forms[0].testId, "");
    check("Signed out (sign-in screen): AppTestViewer.open refuses and nothing changes",
      r0 === false && visible("screen-signin") && !visible("screen-test") && !visible("screen-loading"));

    /* ---------- setup: the recorder leg (local mode) ---------- */
    const CODE = "AS-VWPRF234";
    let recorderLeg = false;
    /* only where the viewer will open (no server): on a server deployment
       forced local the viewer refuses, nothing detaches the recorder, and
       the page's own unload flush would rewrite the student's record after
       this proof's cleanup */
    if(MODE === "local" && !AttemptStore.remoteConfigured() && !OPTS.skipRecorder){
      const target = forms[0];
      localStorage.setItem("devstore:assign:" + CODE + ":viewerproof-a1", JSON.stringify({
        assignmentId: "viewerproof-a1", testId: target.testId, category: "practice", startCode: null,
        windowOpens: null, expiresAt: null, assignedAt: null, completedAttemptId: null }));
      $("nameInput").value = CODE;
      $("signinBtn").click();
      await until(() => visible("screen-home"), 15000, "the student's home");
      const r1 = await window.AppTestViewer.open(target.testId, "");
      check("A student session (home): AppTestViewer.open refuses and nothing changes",
        r1 === false && visible("screen-home") && !visible("screen-test"));
      const card = Array.from(document.querySelectorAll("#screen-home .pcard.clickable"))
        .find(c => ((c.querySelector(".pcard-head") || {}).textContent || "").indexOf(target.testName) !== -1);
      if(!card) throw new Error("setup: the planted assignment's card did not render");
      card.click();
      await until(() => visible("screen-ready"), 20000, "the Ready screen");
      $("readyBackBtn").click();
      await until(() => visible("screen-home"), 5000, "home after Ready → Back");
      $("homeSignoutBtn").click();
      await until(() => visible("screen-signin"), 5000, "sign-in after sign-out");
      recorderLeg = Attempts.isRecording() === true;
      check("Proof can observe a LIVE recorder: Ready → Back → sign-out leaves it attached to the app's state (the hazard the viewer's detach answers)",
        recorderLeg, "isRecording=" + Attempts.isRecording());
    }

    /* ---------- the tutor signs in ---------- */
    if(MODE === "local"){
      $("nameInput").value = "acestem-admin";
      $("signinBtn").click();
    } else {
      $("nameInput").value = "viewer-proof@example.test";
      $("signinBtn").click();
      await until(() => visible("tutorAuthModal"), 5000, "the tutor sign-in dialog");
      $("tutorPassword").value = "viewer-proof-stub";      // answered by the stub above; reaches no server
      $("tutorAuthGo").click();
    }
    await until(() => visible("screen-dashboard"), 15000, "the dashboard");
    await until(() => !/Loading/.test($("dashStatus").textContent), 15000, "the dashboard's load");
    await sleep(200);
    /* the tutor's entry takes the device: the student's recorder is let go
       (after its last save — setup, outside the window) before any viewer
       exists; the viewer's own detach is the second layer behind it */
    if(recorderLeg) check("The tutor's entry let go of the recorder the student's sitting left attached (before the viewer can open)",
      Attempts.isRecording() === false);

    /* ======================= THE WINDOW ======================= */
    const before = snapshot();
    const memAtWindow = {};
    (window.TEST_MANIFEST || []).forEach(t => { memAtWindow[t.testId] = !!(window.__TESTDATA__ && window.__TESTDATA__[t.testId]); });
    NET.phase = "window";

    document.querySelector('#dashTabs [data-tab="tests"]').click();
    await sleep(50);
    const mustAuth = AttemptStore.remoteConfigured();
    check("Opening is authorised exactly when the deployment has no server or a real tutor token is held (" +
      (mustAuth ? "this origin has a server" : "this origin has none") + ")",
      window.AppTestViewer.authorised() === (!mustAuth || AttemptStore.hasAuthToken()));

    /* A deployment WITH a server forced into local mode (?devstorage=1 on the
       live site, or the repo root with its config.js): the acestem-admin
       dashboard opens without a password there, so the viewer must refuse.
       Prove that, with zero writes, and stop — the walk itself runs on a
       build with no server (dist-preview, or a copy without config.js). */
    if(!window.AppTestViewer.authorised()){
      const notice = (document.querySelector("#dashBody .dash-warn") || {}).textContent || "";
      const openButtons = document.querySelectorAll("#dashBody .tv-open").length;
      const rOpen = await window.AppTestViewer.open(forms[0].testId, "");
      $("tvTestsGoto").value = forms[0].testId + " ma1-q1";
      $("tvTestsGoto").dispatchEvent(new Event("input"));
      $("tvTestsGoBtn").click();
      await sleep(200);
      const msg = ((document.querySelector("#dashBody .tv-tests-msg") || {}).textContent) || "";
      check("Server deployment forced local (?devstorage=1): the Tests tab lists the forms but offers no open control, and says why",
        openButtons === 0 && /open only for a tutor signed in/.test(notice) && document.querySelectorAll("#dashBody .tv-tests tbody tr").length === (window.TEST_MANIFEST || []).length);
      check("...AppTestViewer.open refuses from that dashboard and the screen stays put",
        rOpen === false && visible("screen-dashboard") && !visible("screen-test") && !visible("screen-loading"));
      check("...and its Go-to box opens nothing", /^Not opened/.test(msg) && !visible("screen-test"), msg);
      NET.phase = "after";
      check("...with zero storage write calls and no request of any kind", NET.storage.filter(w => w.phase === "window").length === 0
        && NET.fetch.filter(f => f.phase === "window").length === 0 && NET.scripts.filter(s => s.phase === "window").length === 0);
      check("NOTE: the full walk needs a build with no server (dist-preview, or a copy without config.js) — not run on this origin", true);
      throw EARLY;
    }

    const rows = document.querySelectorAll("#dashBody .tv-tests tbody tr");
    const want = (window.TEST_MANIFEST || []).length;
    check("Tests tab lists every manifest form (" + want + ")", rows.length === want, rows.length + " rows");
    const ids = Array.from(rows).map(tr => tr.children[1].textContent);
    check("…in testId order", ids.join(",") === ids.slice().sort().join(","));
    const blank = Array.from(rows).some(tr => Array.from(tr.children).some(td => td.textContent.trim() === "" || /undefined|null/.test(td.textContent)));
    check("…with no blank, undefined or null cell (a missing field is an em dash)", !blank);
    /* the split build fetches every form (~13 MB) one at a time to count it;
       a loaded machine or a shared local server can take minutes */
    await until(() => !Array.from(document.querySelectorAll("#dashBody [data-tv-qpm]")).some(td => td.textContent === "…"), 300000, "the per-module counts");
    const qpmBad = [];
    const qpmCells = Array.from(document.querySelectorAll("#dashBody [data-tv-qpm]"));
    qpmCells.forEach(td => {
      const t = CONTENT[td.dataset.tvQpm];
      const exp = t ? t.modules.map(m => m.questions.length).join(" · ") : "(no content)";
      if(td.textContent !== exp) qpmBad.push(td.dataset.tvQpm + ": " + td.textContent + " vs " + exp);
    });
    check("…and its questions-per-module column matches each form's content (" + qpmCells.length + " cells)", qpmBad.length === 0 && qpmCells.length === want, qpmBad.join("; "));
    const leftInMemory = (window.TEST_MANIFEST || []).filter(t => window.__TESTDATA__ && window.__TESTDATA__[t.testId] && !memAtWindow[t.testId]).map(t => t.testId);
    check("…and counting left memory as it found it (no form loaded just to count stays loaded for a later sitting)", leftInMemory.length === 0, leftInMemory.join(", "));

    const sectionTitleOf = mod => "Section " + (mod.section === "Reading and Writing" ? 1 : 2) + ", Module " +
      ((String(mod.moduleLabel).match(/\d+/) || ["1"])[0]) + ": " + mod.section;
    const spell = id => { const m = /^(re|ma)([12])-q(\d+)$/.exec(id); return m ? (m[1] === "re" ? "rw" : "m") + m[2] + "-q" + m[3] : "—"; };
    const keyed = q => q.correctAnswer !== null && q.correctAnswer !== undefined;
    const pane = () => $("paneRight");
    const boxOf = id => { const r = $(id).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(","); };

    async function openForm(testId, ref){
      $("dashBody").scrollTop = 0;
      const btn = Array.from(document.querySelectorAll("#dashBody .tv-open")).find(b => b.dataset.tvTest === testId);
      if(!btn) throw new Error("no Tests-tab row for " + testId);
      if(ref){
        $("tvTestsGoto").value = testId + " " + ref;
        $("tvTestsGoto").dispatchEvent(new Event("input"));
        $("tvTestsGoBtn").click();
      } else btn.click();
      await until(() => visible("screen-test") || visible("screen-loaderror") || (visible("screen-dashboard") && /Not found/.test($("dashBody").textContent)), 30000, testId + " to open");
    }
    function assertQuestion(where, test, mod, q, qi, answersOn){
      stats.renders++;
      const P = pane();
      const ids = $("tvId").textContent, skill = $("tvSkill").textContent, ver = $("tvVer").textContent;
      if(ids !== q.id + " · " + spell(q.id)) qfail(where, "strip id " + ids);
      if(skill !== ((typeof q.skill === "string" && q.skill.trim()) ? q.skill : "untagged")) qfail(where, "strip skill " + skill);
      if(ver !== "version " + test.testVersion) qfail(where, "strip version " + ver);
      if($("thTitle").textContent !== sectionTitleOf(mod)) qfail(where, "title " + $("thTitle").textContent);
      if($("qnavBtnLabel").textContent !== "Question " + (qi + 1) + " of " + mod.questions.length) qfail(where, "label " + $("qnavBtnLabel").textContent);
      if(P.querySelector(".q-num").textContent !== String(qi + 1)) qfail(where, "q-num");
      /* the student's own controls, as a sitting shows them — and inert
         (no handler is attached in the viewer; the click probes below and
         the zero-write diff are what prove it) */
      if($("flagBtn").disabled) qfail(where, "Mark for Review greyed (a sitting shows it live)");
      if(q.type === "spr" ? (!$("kpToggle") || $("abcToggle")) : (!$("abcToggle") || $("kpToggle"))) qfail(where, "ABC / Show Keypad not as a sitting shows them");
      if(P.querySelector(".elim-btn, #keypad")) qfail(where, "a cross-out button or the keypad panel rendered");
      if($("tBody").classList.contains("review-mode")) qfail(where, "review styling (no hover) on the viewer");
      if(P.querySelector(".rv-omitted, .rv-time, .selected, .rv-wrong")) qfail(where, "review residue (omitted / time / your answer)");
      if(q.type === "spr" && !($("sprInput") && $("sprInput").readOnly && $("sprInput").value === "")) qfail(where, "SPR input not empty+readonly");
      const keyEls = P.querySelectorAll(".choice.rv-key");
      const marks = P.querySelectorAll(".rv-mark");
      const sprKey = P.querySelector(".rv-spr-key");
      const banner = P.querySelector(".rv-banner");
      const noKeyShown = !$("tvNoKey").classList.contains("hidden");
      if(!answersOn){
        if(keyEls.length || marks.length || sprKey || banner || P.querySelector(".rv-rationale") || noKeyShown) qfail(where, "a key leaked with answers OFF");
        return;
      }
      if(q.type === "spr"){
        if(keyed(q)){
          if(!sprKey || sprKey.textContent.indexOf("Correct answer: " + String(q.correctAnswer)) !== 0) qfail(where, "SPR key " + (sprKey && sprKey.textContent));
          (q.altAnswers || []).forEach(a => { if(!sprKey || sprKey.textContent.indexOf(String(a)) === -1) qfail(where, "alt answer missing: " + a); });
          if(banner || noKeyShown) qfail(where, "SPR verdict / no-key on a keyed item");
        } else if(!(banner && banner.classList.contains("neutral") && noKeyShown)) qfail(where, "unkeyed SPR without the neutral banner");
      } else {
        if(keyed(q)){
          if(keyEls.length !== 1 || String(keyEls[0].dataset.idx) !== String(q.correctAnswer)) qfail(where, "MCQ key mark " + keyEls.length);
          if(marks.length !== 1 || marks[0].textContent !== "✓ Correct answer") qfail(where, "MCQ mark text");
          if(noKeyShown) qfail(where, "no-key on a keyed item");
        } else if(keyEls.length || marks.length || !noKeyShown) qfail(where, "unkeyed MCQ marks / no-key strip");
      }
    }

    /* a tab-hide and an unload. Forced WHILE the viewer is open as well as at
       the end: the recorder's build() reads state.currentTest, so a recorder
       still attached here would rebuild its student's record from the
       viewer's test and empty answers — after the viewer closes it builds
       nothing, and a flush there would prove nothing */
    const forceFlushes = () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.visibilityState;
      window.dispatchEvent(new Event("beforeunload"));
    };

    for(const entry of forms){
      const test = CONTENT[entry.testId];
      await openForm(entry.testId);
      if(!visible("screen-test")){ qfail(entry.testId, "did not open"); continue; }
      stats.forms++;
      forceFlushes();
      await sleep(50);
      const W = entry.testId;
      /* chrome, once per form */
      if(!(visible("tvBar") && $("timerDisplay").textContent === "Viewer" && !visible("timerBtn") && !visible("fiveMinPopup")
        && $("rvBackBtn").textContent === "‹ Dashboard" && visible("rvBackBtn") && $("tfName").textContent === test.testName))
        qfail(W, "viewer chrome (bar / no timer / back label / footer name)");
      if($("tvMods").children.length !== test.modules.length) qfail(W, "module buttons");
      for(let mi = 0; mi < test.modules.length; mi++){
        const mod = test.modules[mi];
        $("tvMods").children[mi].click();
        await sleep(300);                                           // navigate()'s lock
        if(!$("tvMods").children[mi].classList.contains("on")) qfail(W + " m" + mi, "module button state");
        /* tools: a sitting's own (Calculator for Math, Highlights & Notes for
           RW) shown and inert; Report a bug and Save and Exit hidden */
        const isMathMod = mod.section === "Math";
        if((isMathMod ? (!$("toolCalc") || $("hlModeBtn")) : (!$("hlModeBtn") || $("toolCalc"))) || visible("miBugReport") || visible("miSaveExit") || !$("miLineReader"))
          qfail(W + " m" + mi, "header tools (a sitting's Calculator / Highlights & Notes shown; Report a bug and Save and Exit hidden)");
        if($("toolCalc")){ $("toolCalc").click(); if(visible("calcPanel")) qfail(W + " m" + mi, "the Calculator opened (Desmos)"); }
        if($("hlModeBtn")){ $("hlModeBtn").click(); if($("tBody").classList.contains("hl-mode")) qfail(W + " m" + mi, "highlight mode turned on"); }
        $("qnavBtn").click();
        const grid = $("qnavGrid");
        if(grid.children.length !== mod.questions.length || grid.querySelector(".rv-ok, .rv-bad, .rv-omit, .rv-nokey")
          || visible("gotoReviewWrap") || !/Unanswered/.test($("qnavLegend").textContent)
          || $("qnavTitle").textContent !== sectionTitleOf(mod) + " Questions")
          qfail(W + " m" + mi, "navigator (live look, no outcomes, no Check Your Work)");
        $("qnavClose").click();
        for(let qi = 0; qi < mod.questions.length; qi++){
          const q = mod.questions[qi];
          const where = W + " " + q.id;
          if(qi > 0){
            $("qnavBtn").click();
            $("qnavGrid").children[qi].click();
          }
          stats.questions++;
          if(!$("tvShowAnswers").checked) qfail(where, "Show answers not ON");
          assertQuestion(where, test, mod, q, qi, true);
          const boxOn = boxOf("tBody") + "|" + boxOf("paneRight");
          /* inertness: a click on a choice, the flag, ABC or Show Keypad
             selects, flags, crosses out and opens nothing */
          const c0 = pane().querySelector(".choice");
          if(c0) c0.click();
          $("flagBtn").click();
          if($("abcToggle")) $("abcToggle").click();
          if($("kpToggle")) $("kpToggle").click();
          if(pane().querySelector(".choice.selected, .choice.rv-wrong, .rv-mark.you, .q-flag.on, .abc-toggle.on, .choices.elim-mode, #keypad")) qfail(where, "a click selected, flagged, crossed out or opened the keypad");
          $("tvShowAnswers").click();
          assertQuestion(where + " (off)", test, mod, q, qi, false);
          if(boxOf("tBody") + "|" + boxOf("paneRight") !== boxOn) qfail(where, "the toggle moved the pane");
          $("tvShowAnswers").click();
          assertQuestion(where + " (on again)", test, mod, q, qi, true);
        }
        /* a passage selection makes no highlight (RW) */
        const pt = $("passageText");
        if(mod.section !== "Math" && pt && pt.firstChild){
          const rng = document.createRange();
          const tn = document.createTreeWalker(pt, NodeFilter.SHOW_TEXT).nextNode();
          if(tn && tn.length > 5){
            rng.setStart(tn, 0); rng.setEnd(tn, 5);
            const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rng);
            pt.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            await sleep(20);
            if(pt.querySelector(".hl") || visible("hlPopup")) qfail(W + " m" + mi, "a highlight was created");
            sel.removeAllRanges();
          }
        }
      }
      /* Back / Next cross modules; the ends are ends */
      $("tvMods").children[0].click(); await sleep(300);
      if(visible("btnBack")) qfail(W, "Back shown at the first question");
      $("qnavBtn").click(); $("qnavGrid").children[test.modules[0].questions.length - 1].click();
      $("btnNext").click(); await sleep(300);
      if($("thTitle").textContent !== sectionTitleOf(test.modules[1]) || $("qnavBtnLabel").textContent.indexOf("Question 1 of") !== 0) qfail(W, "Next across a module");
      $("btnBack").click(); await sleep(300);
      if($("thTitle").textContent !== sectionTitleOf(test.modules[0])) qfail(W, "Back across a module");
      const lastMi = test.modules.length - 1;
      $("tvMods").children[lastMi].click(); await sleep(300);
      $("qnavBtn").click(); $("qnavGrid").children[test.modules[lastMi].questions.length - 1].click();
      if(visible("btnNext")) qfail(W, "Next shown at the last question");
      /* Directions, Reference, Line Reader: read-only tools still work */
      $("dirToggle").click();
      const dirOk = visible("dirOverlay");
      $("dirToggle").click();
      if(!dirOk || visible("dirOverlay")) qfail(W, "Directions");
      if($("toolRef")){
        $("toolRef").click(); const refOk = visible("refPanel"); $("refClose").click();
        if(!refOk || visible("refPanel")) qfail(W, "Reference");
      }
      $("moreBtn").click(); $("miLineReader").click();
      const lrOk = visible("lineReader");
      $("moreBtn").click(); $("miLineReader").click();
      if(!lrOk || visible("lineReader")) qfail(W, "Line Reader");
      /* the in-viewer Go-to: both spellings, padded, q-less; unknown says so */
      const probe = test.modules[lastMi].questions[Math.min(6, test.modules[lastMi].questions.length - 1)];
      for(const ref of [probe.id, spell(probe.id), spell(probe.id).replace(/-q(\d+)$/, "-q0$1"), spell(probe.id).replace(/-q(\d+)$/, "-$1")]){
        $("tvMods").children[0].click(); await sleep(300);
        $("tvGoto").value = ref; $("tvGotoBtn").click(); await sleep(300);
        if($("tvId").textContent.indexOf(probe.id + " ·") !== 0 || $("tvGotoMsg").textContent !== "") qfail(W, "Go-to " + ref + " -> " + $("tvId").textContent);
      }
      $("tvGoto").value = test.modules[0].questions[0].id.replace(/-q\d+$/, "-q999"); $("tvGotoBtn").click();
      if(!/not found in this form/.test($("tvGotoMsg").textContent)) qfail(W, "Go-to unknown id");
      /* a figure: zoom, reset, expand — read-only */
      let figQ = null, figMi = -1, figQi = -1;
      test.modules.forEach((m, mi2) => m.questions.forEach((q, qi2) => { if(!figQ && q.figure) { figQ = q; figMi = mi2; figQi = qi2; } }));
      if(figQ){
        $("tvGoto").value = figQ.id; $("tvGotoBtn").click(); await sleep(300);
        if($("figZin")){ $("figZin").click(); $("figReset").click(); $("figExpand").click();
          const ovOk = visible("figOverlay"); $("figOverlayClose").click();
          if(!ovOk) qfail(W, "figure expand"); }
      }
      /* leave by the back control */
      $("rvBackBtn").click();
      await until(() => visible("screen-dashboard"), 5000, "the dashboard after Back");
      if(visible("screen-test") || visible("tvBar") || visible("rvBackBtn") || $("tBody").classList.contains("review-mode") || !visible("timerBtn"))
        qfail(W, "Back left viewer chrome behind");
      if(!document.querySelector('#dashTabs [data-tab="tests"]').classList.contains("on")) qfail(W, "Back did not return to the Tests tab");
    }
    check("Walked every question of " + forms.length + " form(s), Show answers ON → OFF → ON, through the navigator, every module button, Back/Next, Go-to, Directions, Reference, Line Reader, figure zoom",
      stats.failures === 0 && stats.forms === forms.length, stats.forms + " forms, " + stats.questions + " questions, " + stats.renders + " checked renders; " + failLog.slice(0, 6).join(" | "));

    /* the Tests-tab Go-to: prefix + question, ambiguous, unknown, missing question */
    const go = async v => { $("tvTestsGoto").value = v; $("tvTestsGoto").dispatchEvent(new Event("input")); $("tvTestsGoBtn").click(); await sleep(150); };
    const msgText = () => (document.querySelector("#dashBody .tv-tests-msg") || {}).textContent || "";
    const ids6 = (window.TEST_MANIFEST || []).map(t => t.testId).filter(id => id.indexOf("202606") === 0);
    await go("202606 ma2-q21");
    check("Tests-tab Go-to: an ambiguous start lists the forms it matches and opens none",
      visible("screen-dashboard") && document.querySelectorAll("#dashBody .tv-pick").length === ids6.length && ids6.length > 1, msgText());
    await go("zz9999 ma2-q21");
    check("Tests-tab Go-to: an unknown test says not found", /^Not found/.test(msgText()) && visible("screen-dashboard"), msgText());
    const f0 = forms[0];
    await go(f0.testId + " " + "m2-q999");
    await until(() => visible("screen-dashboard") && /Not found/.test(msgText()), 15000, "the not-found answer");
    check("Tests-tab Go-to: a question the form lacks comes back not found (no guess)", /isn't in/.test(msgText()), msgText());
    const lastQ = CONTENT[f0.testId].modules[3].questions.slice(-1)[0];
    await go(f0.testId + " " + spell(lastQ.id));
    await until(() => visible("screen-test"), 15000, "the viewer from the Tests-tab Go-to");
    check("Tests-tab Go-to: test + question (test-bank spelling) opens that form at that question",
      $("tvId").textContent.indexOf(lastQ.id + " ·") === 0, $("tvId").textContent);
    $("rvBackBtn").click();
    await until(() => visible("screen-dashboard"), 5000, "the dashboard");

    /* the page-wide flushes again, plus `online` (queue drain, orphan retry) */
    forceFlushes();
    window.dispatchEvent(new Event("online"));
    await sleep(400);
    if(recorderLeg) check("No recorder is attached at the end of the window (no flush can rebuild that student's record from the viewer's state)",
      Attempts.isRecording() === false);

    NET.phase = "after";
    const after = snapshot();
    const memDrift = (window.TEST_MANIFEST || []).filter(t => !!(window.__TESTDATA__ && window.__TESTDATA__[t.testId]) !== memAtWindow[t.testId]).map(t => t.testId);
    check("Memory holds exactly the forms it held before the window (the viewer and the counts put back what they loaded, so a later sitting on this page sees no difference)",
      memDrift.length === 0, memDrift.join(", "));
    /* ======================= THE DIFF ======================= */
    const wWrites = NET.storage.filter(w => w.phase === "window");
    check("ZERO storage write calls during the whole window (Tests tab, every form, every question, both toggles, Go-to, Back, a forced tab-hide + unload inside every form, and tab-hide/unload/online after)",
      wWrites.length === 0, wWrites.slice(0, 8).map(w => w.op + ":" + w.key).join(", "));
    const changed = Object.keys(Object.assign({}, before, after)).filter(k => before[k] !== after[k]);
    check("localStorage byte-identical before and after (" + Object.keys(before).length + " keys: the offline content cache and the sync queue included)",
      changed.length === 0, changed.slice(0, 8).join(", "));
    const cacheKeys = Object.keys(after).filter(k => k.indexOf("acestem:testcache:") === 0 && !(k in before));
    check("No offline content-cache entry was created", cacheKeys.length === 0, cacheKeys.join(", "));
    const q = after["devstore:__syncqueue"], q0 = before["devstore:__syncqueue"];
    check("The sync queue is unchanged", q === q0, String(q).slice(0, 80));
    const wFetch = NET.fetch.filter(f => f.phase === "window");
    const nonGet = wFetch.filter(f => f.method !== "GET").concat(NET.xhr.filter(x => x.phase === "window" && String(x.method).toUpperCase() !== "GET"))
      .concat(NET.beacon.filter(b => b.phase === "window"));
    check("No write request of any kind (no POST / PATCH / PUT / DELETE / beacon)", nonGet.length === 0, nonGet.slice(0, 5).map(f => f.method + " " + f.url).join(", "));
    if(MODE === "remote"){
      const server = wFetch.filter(f => /supabase|\/rest\/v1\/|\/auth\/v1\//.test(f.url));
      check("Remote mode: not one server call during the window (no RPC, no select, no auth)", server.length === 0, server.slice(0, 5).map(f => f.method + " " + f.url).join(", "));
      const setupServer = NET.fetch.filter(f => f.phase === "setup" && /\/auth\/v1\/token|\/rest\/v1\/records\?/.test(f.url));
      check("Proof can observe server calls: the tutor sign-in and the dashboard's pull went through the stub before the window (guards the check above)",
        setupServer.some(f => /auth/.test(f.url)) && setupServer.some(f => /records/.test(f.url)), setupServer.map(f => f.method + " " + f.url.replace(/^https?:\/\/[^/]+/, "")).join(", "));
    }
    const ext = NET.scripts.filter(s => s.phase === "window" && s.src.indexOf(location.origin + "/") !== 0);
    stats.scriptGets = NET.scripts.filter(s => s.phase === "window").length;
    check("Every script the window loaded was a same-origin test file (no third-party code, no Desmos)", ext.length === 0, ext.map(s => s.src).join(", "));
    report = { pass: results.every(r => r.pass), results, stats, failLog };
  } catch(e){
    if(e !== EARLY) results.push({ check: "HARNESS: " + (e && e.message || e), pass: false, note: (e && e.stack || "").slice(0, 300) });
    report = { pass: e === EARLY && results.every(r => r.pass), results, stats, failLog };
  } finally {
    NET.phase = "teardown";
    uninstall();
    /* remove exactly what the setup created on this origin (records, the
       assignment row, the cache entry the student's start wrote, the
       remembered code), so a second run starts clean */
    Object.keys(localStorage).forEach(k => { if(!keysAtStart.has(k)) localStorage.removeItem(k); });
  }
  try{ console.table(report.results); }catch(e){}
  window.__viewerProofResult = report;
  return report;
})();
