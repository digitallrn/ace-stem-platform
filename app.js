(function(){
  "use strict";

  /* ================= STATE ================= */
  const state = {
    tests: (window.TEST_DATA || []),
    userName: "Student",
    currentTest: null,
    moduleIndex: 0,
    questionIndex: 0,
    view: "question",            // "question" | "review"
    moduleState: {},             // moduleId -> {answers, flags:Set, eliminated:{qid:Set}, passageHtml:{qid:html}}
    timerInterval: null,
    timeRemainingSec: 0,
    timerHidden: false,
    elimMode: false,
    hlTarget: null,              // existing .hl span being edited, or null (new selection)
    savedRange: null,
    noteSeq: 0,                  // session-unique note id counter (Phase B)
    notesCollapsed: false,       // notes rail collapse preference, survives navigation
    activeHlColor: "yellow",     // last-used swatch — what mode-drag + underline pairing apply
    hlMode: false,               // Highlights & Notes toggle: drag-select highlights instantly
    resumeRecords: {},           // testId -> in-progress attempt record (Phase C)
    assignments: null,           // Phase F: assignment objects; null = default all-practice
    activeAssignment: null,      // the assignment the running attempt started through
    pendingStart: null,          // {test, assignment} while the Start Code screen is up
    timing: 1,                   // Phase G §1: 1 | 1.5 | 2 | "untimed"
    untimed: false,              // current module runs count-up with no auto-submit
    elapsedSec: 0,               // count-up seconds for untimed modules
    fiveMinAlerted: false,       // Phase F §6: five-minute popup shown for this module
    pastAttempts: [],            // completed/timed-out records for this code (Phase D)
    practiceTab: "active"        // home Practice toggle: "active" | "past"
  };

  function el(id){ return document.getElementById(id); }
  function show(id){ el(id).classList.remove("hidden"); }
  function hide(id){ el(id).classList.add("hidden"); }
  const SCREENS = ["screen-signin","screen-home","screen-startcode","screen-loading","screen-ready","screen-moduleover","screen-break","screen-test","screen-submitted","screen-results","screen-scoredetails","screen-dashboard"];
  // body-level overlays that live outside the SCREENS set — a screen change
  // (e.g. the timer expiring under an open save-fail/bug modal) must not leave
  // them floating as a full-screen click blocker over the next screen
  const FLOATING_OVERLAYS = ["saveFailModal","bugModal","deviceModal","qrModal"];
  function showOnly(id){
    SCREENS.forEach(s => s===id ? show(s) : hide(s));
    FLOATING_OVERLAYS.forEach(o => hide(o));
  }
  function firstName(n){ return n.trim().split(/\s+/)[0] || "Student"; }

  /* ================= SIGN IN / HOME ================= */
  el("signinBtn").addEventListener("click", doSignin);
  el("nameInput").addEventListener("keydown", e => { if(e.key === "Enter") doSignin(); });
  async function doSignin(){
    const v = el("nameInput").value.trim();
    if(!v){ el("nameInput").focus(); return; }
    if(v.toLowerCase() === "acestem-admin"){        // tutor dashboard — never records (spec §4)
      el("nameInput").value = "";
      el("signinError").classList.add("hidden");
      if(window.Dashboard) Dashboard.open(showOnly);
      return;
    }
    // Phase F §7: student codes are AS- plus four letters/digits
    const code = v.toUpperCase();
    if(!/^AS-[A-Z0-9]{4}$/.test(code)){
      el("signinError").textContent = "Enter the code your tutor gave you — it looks like AS-1234.";
      el("signinError").classList.remove("hidden");
      el("nameInput").focus();
      return;
    }
    el("signinError").classList.add("hidden");
    el("nameInput").value = code;
    state.userName = code;
    el("homeUserName").textContent = state.userName;
    el("homeAvatar").textContent = state.userName.charAt(0).toUpperCase();
    el("welcomeMsg").textContent = "Welcome, " + firstName(state.userName) + ". Good luck on test day!";
    el("tfName").textContent = state.userName;
    // Phase C: an in-progress attempt for this code + test resumes rather
    // than starting fresh (starting over is a tutor-dashboard action)
    state.resumeRecords = {};
    for(const t of state.tests){
      const r = await Attempts.findInProgress(code, t.testId, t.testVersion);
      if(r) state.resumeRecords[t.testId] = r;
    }
    // Phase F §2: assignment objects (absent -> all published tests as practice)
    const assigns = await Attempts.assignments(code);
    if(assigns === "unavailable"){
      // a read error must not silently downgrade access (an ungated proctored
      // test) — keep the student at sign-in with a retry rather than guessing
      el("signinError").textContent = "Couldn't reach your assignments. Check your connection and try again.";
      el("signinError").classList.remove("hidden");
      return;
    }
    state.assignments = assigns;
    state.pastAttempts = await Attempts.pastAttempts(code);
    state.practiceTab = "active";
    renderHome();
    showOnly("screen-home");
  }

  /* ---- Test Your Device pre-flight (Phase F §5) ---- */
  el("tydBtn").addEventListener("click", ()=>{ show("deviceModal"); runDeviceChecks(); });
  el("deviceClose").addEventListener("click", ()=> hide("deviceModal"));
  el("deviceRunBtn").addEventListener("click", runDeviceChecks);
  el("deviceModal").addEventListener("click", e=>{ if(e.target.id === "deviceModal") hide("deviceModal"); });

  function devMark(id, ok, note){
    const row = el("dev-" + id);
    if(!row) return;
    row.classList.remove("pass", "fail");
    row.classList.add(ok ? "pass" : "fail");
    row.querySelector(".dev-mark").textContent = ok ? "✓" : "✕";
    if(note !== undefined) el("devnote-" + id).innerHTML = note;
  }

  function loadProbeScript(src, timeoutMs){
    return new Promise(resolve => {
      const s = document.createElement("script");
      const t = setTimeout(()=>{ s.remove(); resolve(false); }, timeoutMs);
      s.onload = ()=>{ clearTimeout(t); s.remove(); resolve(true); };
      s.onerror = ()=>{ clearTimeout(t); s.remove(); resolve(false); };
      s.src = src;
      document.head.appendChild(s);
    });
  }

  async function runDeviceChecks(){
    el("deviceChecks").innerHTML = [
      ["net", "Internet connection"],
      ["katex", "Math rendering (KaTeX)"],
      ["desmos", "Desmos calculator"],
      ["storage", "Attempt recording (storage)"]
    ].map(([id, label]) => `
      <div class="devrow" id="dev-${id}">
        <span class="dev-mark">…</span><span>${label}</span>
        <span class="dev-note" id="devnote-${id}"></span>
      </div>`).join("");

    // internet: fetch a tiny script from the same CDN the app already uses
    const net = await loadProbeScript(
      "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/contrib/copy-tex.min.js?cb=" + Date.now(), 8000);
    devMark("net", net, net ? "" : "No connection to the content CDN");

    // KaTeX: actually render a test fraction into the row
    let katexOk = false, katexNote = "KaTeX didn't load — math shows as raw LaTeX";
    try{
      if(window.katex){
        katexNote = katex.renderToString("\\frac{1}{2}");
        katexOk = true;
      }
    }catch(e){}
    devMark("katex", katexOk, katexNote);

    // Desmos: present already, or loadable from its CDN
    let desmos = !!window.Desmos;
    if(!desmos){
      desmos = await loadProbeScript(
        "https://www.desmos.com/api/v1.11/calculator.js?apiKey=dcb31709b452b1cf9dc26972add0fda6", 10000)
        && !!window.Desmos;
    }
    devMark("desmos", desmos, desmos ? "" : "Calculator needs an internet connection");

    // storage: identify the mode, then prove a write+delete round-trip
    if(!AttemptStore.available()){
      devMark("storage", false, "No storage in this copy — attempts won't be recorded");
    } else {
      const mode = AttemptStore.isDev() ? "practice (dev) storage" : "shared storage";
      const wrote = await AttemptStore.set("devicecheck:probe", { t: Date.now() });
      if(wrote) await AttemptStore.remove("devicecheck:probe");
      devMark("storage", wrote, wrote ? mode : mode + " — write failed");
    }
  }

  function testById(id){ return state.tests.find(t => t.testId === id) || null; }

  /* Phase F §2 semantics: completed wins; a resumable attempt always resumes
     (expiry gates starting, never resuming); then window/expiry gates Start. */
  function assignmentState(a){
    if(a.completedAttemptId) return "completed";
    if(state.resumeRecords[a.testId]) return "resume";
    if(a.windowOpens && Date.now() < Date.parse(a.windowOpens)) return "notyet";
    if(a.expiresAt && Date.now() > Date.parse(a.expiresAt)) return "expired";
    return "ready";
  }

  /* Phase D home (Active|Past) + Phase F §2 assignments v2: "Your Tests"
     carries category-"test" (proctored, start-code-gated) assignments;
     Practice and Prepare carries practice assignments, or every published
     test when this code has no assign: key at all. */
  function renderHome(){
    document.querySelectorAll("#practiceSeg .seg-btn").forEach(b =>
      b.classList.toggle("on", b.dataset.seg === state.practiceTab));
    renderYourTests();
    const wrap = el("practiceCards");
    wrap.innerHTML = "";
    if(state.practiceTab === "past") renderPastCards(wrap);
    else renderActiveCards(wrap);
  }

  function assignmentCard(a){
    const test = testById(a.testId);
    if(!test) return null;                      // assignment for an unpublished test
    const st = assignmentState(a);
    const isTest = a.category === "test";
    const totalQ = test.modules.reduce((s,m)=>s+m.questions.length,0);
    const card = document.createElement("div");
    card.className = "pcard" + ((st === "ready" || st === "resume") ? " clickable" : "");
    const status =
      st === "completed" ? '<span class="pc-ico">✓</span> Completed' :
      st === "resume"    ? '<span class="pc-ico">🕐</span> In Progress' :
      st === "notyet"    ? 'Opens ' + fmtCardDate(a.windowOpens) :
      st === "expired"   ? 'Expired' :
      `${test.modules.length} modules · ${totalQ} questions` + (isTest ? ' · proctored' : '');
    const action =
      st === "resume"  ? '<button class="pill ghost">Resume</button>' :
      st === "ready"   ? '<button class="pill ghost">Start</button>' :
      st === "expired" ? '<span class="pc-pending">This assignment has expired — ask your tutor</span>' : "";
    card.innerHTML = `
      <div class="pcard-head">${isTest ? escapeHtml(test.testName) : "Full-Length Practice — " + escapeHtml(test.testName)}</div>
      <div class="pcard-body">
        <div class="pcard-status">${status}</div>
        ${action ? '<div class="pcard-action">' + action + '</div>' : ""}
      </div>`;
    if(st === "resume"){
      card.addEventListener("click", ()=> resumeTestFlow(test, state.resumeRecords[test.testId]));
    } else if(st === "ready"){
      card.addEventListener("click", ()=> startAssignment(test, a));
    }
    return card;
  }

  /* re-evaluate the assignment at click time — the home screen isn't
     re-rendered on a timer, so a card can still read "Start" after its window
     lapsed. §2: expiry gates starting for BOTH categories (the start-code
     screen re-checks separately for the proctored path). */
  function startAssignment(test, a){
    const st = assignmentState(a);
    if(st !== "ready"){
      renderHome();                               // repaint the now-expired/opened/completed state
      return;
    }
    if(a.category === "test") openStartCode(test, a);   // ceremony gates proctored sittings (§4)
    else startTestFlow(test, a);
  }

  function renderYourTests(){
    const row = el("yourTestsRow"), wrap = el("testCards");
    wrap.innerHTML = "";
    const testAssigns = (state.assignments || []).filter(a => a.category === "test");
    // gate visibility on cards that actually render, not the raw assignment
    // count — an assignment for an unpublished testId yields no card, and a
    // bare "Your Tests" heading over empty space would just confuse
    const cards = testAssigns.map(assignmentCard).filter(Boolean);
    row.classList.toggle("hidden", !cards.length);
    wrap.classList.toggle("hidden", !cards.length);
    cards.forEach(c => wrap.appendChild(c));
  }

  function renderActiveCards(wrap){
    if(state.assignments === null){
      // no assign: key — default: every published test as plain practice
      if(!state.tests.length){
        wrap.innerHTML = '<div class="no-tests-card"><h3>No Practice Tests</h3><p>Add tests to test-data.js following the schema documented at the top of that file.</p></div>';
        return;
      }
      state.tests.forEach(test => {
        const totalQ = test.modules.reduce((s,m)=>s+m.questions.length,0);
        const resume = state.resumeRecords[test.testId];
        const card = document.createElement("div");
        card.className = "pcard clickable";
        card.innerHTML = `
          <div class="pcard-head">Full-Length Practice — ${escapeHtml(test.testName)}</div>
          <div class="pcard-body">
            <div class="pcard-status">${resume
              ? '<span class="pc-ico">🕐</span> In Progress'
              : `${test.modules.length} modules · ${totalQ} questions`}</div>
            <div class="pcard-action"><button class="pill ghost">${resume ? "Resume" : "Start"}</button></div>
          </div>`;
        card.addEventListener("click", ()=> resume ? resumeTestFlow(test, resume) : startTestFlow(test, null));
        wrap.appendChild(card);
      });
      return;
    }
    const practice = state.assignments.filter(a => a.category === "practice");
    // branch on renderable cards, not raw count — assignments for unpublished
    // testIds would otherwise skip the empty-state and leave the section blank
    const cards = practice.map(assignmentCard).filter(Boolean);
    if(!cards.length){
      wrap.innerHTML = '<div class="no-tests-card"><h3>No Practice Tests</h3><p>No practice is assigned to this code yet — ask your tutor.</p></div>';
      return;
    }
    cards.forEach(c => wrap.appendChild(c));
  }

  function fmtCardDate(isoStr){
    if(!isoStr) return "";
    const d = new Date(isoStr);
    return d.toLocaleDateString(undefined, {month:"short", day:"numeric", year:"numeric"});
  }

  function renderPastCards(wrap){
    if(!state.pastAttempts.length){
      wrap.innerHTML = '<div class="no-tests-card"><h3>No Past Practice</h3><p>Completed practice tests will appear here.</p></div>';
      return;
    }
    state.pastAttempts.forEach(record => {
      const released = record.released === true;
      const test = state.tests.find(t => t.testId === record.testId);
      // reviewing against a different test build would mislabel questions
      // (ATTEMPTS-SPEC §9) — the tutor dashboard remains the archive view
      const canView = released && test &&
        (test.testVersion || "unversioned") === record.testVersion;
      // §6: released cards show the scaled TOTAL, or raw fallback
      let scoreLine = "";
      if(canView){
        const built = buildScoreRows(test, record);
        const rawRw = built.tally["Reading and Writing"].correct;
        const rawMath = built.tally["Math"].correct;
        const scaled = scaledScores(test, rawRw, rawMath);
        scoreLine = scaled
          ? `<div class="pcard-total">${scaled.total}${scaled.estimated ? EST : ""}<span class="pcard-total-range">400–1600</span></div>`
          : `<div class="pcard-total">${rawRw + rawMath}<span class="pcard-total-of">/ ${built.tally["Reading and Writing"].graded + built.tally["Math"].graded} correct</span></div>`;
      }
      const badge = timingBadge(record.timing);
      const card = document.createElement("div");
      card.className = "pcard";
      card.innerHTML = `
        <div class="pcard-head">${escapeHtml(record.testName || record.testId)}</div>
        <div class="pcard-body">
          <div class="pcard-status"><span class="pc-ico">✓</span> Completed
            <span class="pc-date">${fmtCardDate(record.startedAt)}</span></div>
          ${badge ? `<div class="pcard-badge">${escapeHtml(badge)}</div>` : ""}
          ${scoreLine}
          <div class="pcard-action">${canView
            ? '<button class="pcard-link">View Score Details</button>'
            : released
              ? '<span class="pc-pending">Test content was updated — ask your tutor for the review</span>'
              : '<span class="pc-pending">Scores not released yet</span>'}</div>
        </div>`;
      if(canView) card.querySelector(".pcard-link").addEventListener("click", ()=> openScoreDetails(test, record));
      wrap.appendChild(card);
    });
  }

  document.querySelectorAll("#practiceSeg .seg-btn").forEach(b =>
    b.addEventListener("click", ()=>{
      state.practiceTab = b.dataset.seg;
      renderHome();
    }));

  /* ================= FLOW: LOADING → READY → TEST ================= */
  /* Phase F §2: conditions come from the ceremony, not a toggle — a start
     code means proctored; everything else is self-administered practice. */
  function startTestFlow(test, assignment){
    state.currentTest = test;
    state.activeAssignment = assignment || null;
    state.timing = (assignment && assignment.timing) || 1;    // Phase G §1: default standard
    state.moduleIndex = 0;
    state.moduleState = {};
    test.modules.forEach(m=>{
      state.moduleState[m.moduleId] = { answers:{}, flags:new Set(), eliminated:{}, passageHtml:{}, notes:{} };
    });
    const conditions = (assignment && assignment.category === "test")
      ? "proctored" : "self-administered";
    Attempts.begin(test, state.userName, conditions, state,    // spec §3: record on test start
      assignment ? assignment.assignmentId : null, state.timing);
    showOnly("screen-loading");
    setTimeout(()=>{ showReady(true); }, 2200);
  }

  /* ================= START CODE (Phase F §4, screenshot 24) ================= */
  const scDigits = Array.from(document.querySelectorAll(".sc-digit"));
  function openStartCode(test, assignment){
    state.pendingStart = { test, assignment };
    el("scError").classList.add("hidden");
    scDigits.forEach(i => { i.value = ""; });
    showOnly("screen-startcode");
    scDigits[0].focus();
  }
  function scFail(msg){
    el("scError").textContent = msg;
    el("scError").classList.remove("hidden");
  }
  scDigits.forEach((box, idx) => {
    box.addEventListener("input", ()=>{
      box.value = box.value.replace(/\D/g, "").slice(0, 1);
      if(box.value && idx < scDigits.length - 1) scDigits[idx + 1].focus();
    });
    box.addEventListener("keydown", e=>{
      if(e.key === "Backspace" && !box.value && idx > 0){ scDigits[idx - 1].focus(); }
      if(e.key === "Enter"){ el("scStartBtn").click(); }
    });
    box.addEventListener("paste", e=>{
      const digits = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
      if(!digits) return;
      e.preventDefault();
      digits.split("").forEach((d, i) => { if(scDigits[i]) scDigits[i].value = d; });
      scDigits[Math.min(digits.length, scDigits.length - 1)].focus();
    });
  });
  el("scHomeBtn").addEventListener("click", ()=>{
    state.pendingStart = null;
    showOnly("screen-home");
  });
  el("scStartBtn").addEventListener("click", ()=>{
    const pending = state.pendingStart;
    if(!pending){ showOnly("screen-home"); return; }
    const a = pending.assignment;
    if(a.expiresAt && Date.now() > Date.parse(a.expiresAt)){
      scFail("This start code has expired — ask your tutor.");
      return;
    }
    const entered = scDigits.map(i => i.value).join("");
    if(entered.length !== 6 || entered !== String(a.startCode)){
      scFail("That start code isn't right. Check the numbers and try again.");
      return;
    }
    state.pendingStart = null;
    startTestFlow(pending.test, a);
  });

  /* rebuild a moduleState shape from a stored attempt record — used by both
     resume (Phase C) and View My Responses (Phase D) */
  function buildModuleStateFromRecord(test, record){
    const mstate = {};
    test.modules.forEach(m=>{
      mstate[m.moduleId] = { answers:{}, flags:new Set(), eliminated:{}, passageHtml:{}, notes:{} };
    });
    test.modules.forEach(m=>{
      const ms = mstate[m.moduleId];
      m.questions.forEach(q=>{
        const a = (record.answers || {})[q.id];
        if(!a) return;
        if(a.given !== null && a.given !== undefined) ms.answers[q.id] = a.given;
        if(a.markedForReview) ms.flags.add(q.id);
        if(a.eliminated && a.eliminated.length) ms.eliminated[q.id] = new Set(a.eliminated);
      });
    });
    return mstate;
  }

  /* Phase C: rebuild the whole sitting from a saved-and-exited attempt —
     answers/flags/eliminations from the record, highlights + notes from its
     resume.annotations blob, then land on the saved module/question with the
     saved time remaining. */
  function resumeTestFlow(test, record){
    state.currentTest = test;
    state.moduleState = buildModuleStateFromRecord(test, record);
    const resume = record.resume || {};
    const ann = resume.annotations || {};
    Object.keys(ann).forEach(mid=>{
      const ms = state.moduleState[mid];
      if(!ms) return;
      if(ann[mid].passageHtml) ms.passageHtml = ann[mid].passageHtml;
      if(ann[mid].notes) ms.notes = ann[mid].notes;
    });
    state.timing = record.timing || 1;   // Phase G §1: accommodation persists across resume
    Attempts.resume(record, state);   // adopts the record; deletes its resume blob
    // re-associate the assignment this attempt was started through, so
    // finalizing a resumed sitting still marks it Completed (Phase F §2)
    state.activeAssignment = (record.assignmentId && state.assignments)
      ? (state.assignments.find(a => a.assignmentId === record.assignmentId) || null)
      : null;
    const idx = Math.min(resume.moduleIndex || 0, test.modules.length - 1);
    delete state.resumeRecords[test.testId];
    showOnly("screen-loading");
    setTimeout(()=>{ beginModule(idx, resume); }, 1200);
  }

  function showReady(isFirst){
    const card = el("readyCard");
    if(isFirst){
      el("readyTitle").textContent = "Practice Test";
      card.innerHTML = `
        <div class="ready-item"><div class="ricon">🕐</div><div><h3>Timing</h3><p>Practice tests are timed, and the timer auto-advances you when it runs out. Need to stop early? Use <b>Save and Exit</b> in the More (⋮) menu — your place is saved and you can resume from the home screen.</p></div></div>
        <div class="ready-item"><div class="ricon">📝</div><div><h3>Scores</h3><p>When you finish, your answers go to your tutor. Once they release your scores, the full question-by-question review appears under <b>Past</b> on your home screen.</p></div></div>
        <div class="ready-item"><div class="ricon">🧰</div><div><h3>Tools</h3><p>Mark questions for review, cross out answer choices, and highlight passage text — just like on test day.</p></div></div>
        <div class="ready-item"><div class="ricon">🔓</div><div><h3>No Device Lock</h3><p>We don't lock your device during practice. On test day, you'll be blocked from using other programs or apps.</p></div></div>
      `;
      el("readyBackBtn").classList.remove("hidden");
      el("readyBackBtn").onclick = ()=> showOnly("screen-home");
    } else {
      const mod = state.currentTest.modules[state.moduleIndex];
      el("readyTitle").textContent = "Module Complete";
      card.innerHTML = `
        <div class="ready-item"><div class="ricon">➡️</div><div><h3>Up next: ${escapeHtml(sectionTitle(mod))}</h3><p>${mod.questions.length} questions · ${mod.timeLimitMinutes} minutes. The timer starts as soon as you select Next.</p></div></div>
      `;
      el("readyBackBtn").classList.add("hidden");
    }
    el("readyNextBtn").onclick = ()=> beginModule(state.moduleIndex);
    showOnly("screen-ready");
  }

  /* ================= MODULE / TIMER ================= */
  function currentModule(){ return state.currentTest.modules[state.moduleIndex]; }
  function currentModState(){ return state.moduleState[currentModule().moduleId]; }
  function currentQuestion(){ return currentModule().questions[state.questionIndex]; }
  function sectionNumber(mod){ return mod.section === "Reading and Writing" ? 1 : 2; }
  function moduleNumber(mod){ const m = String(mod.moduleLabel).match(/\d+/); return m ? m[0] : "1"; }
  function sectionTitle(mod){ return `Section ${sectionNumber(mod)}, Module ${moduleNumber(mod)}: ${mod.section}`; }

  /* Phase G §1: accommodated time. Multipliers apply exactly to the module
     limit; break stays 10:00 (handled separately). Untimed has no limit. */
  function timingMultiplier(t){ return (t === 1.5 || t === 2) ? t : 1; }
  function accommodatedLimitSec(mod, timing){
    return Math.round(mod.timeLimitMinutes * 60 * timingMultiplier(timing));
  }
  function timingBadge(timing){
    if(timing === "untimed") return "Untimed";
    if(timing === 1.5) return "Extended time 1.5×";
    if(timing === 2) return "Extended time 2×";
    return "";
  }

  function beginModule(idx, resume){
    state.moduleIndex = idx;
    state.view = "question";
    state.elimMode = false;
    const mod = currentModule();
    state.questionIndex = resume ?
      Math.min(resume.questionIndex || 0, mod.questions.length - 1) : 0;
    state.untimed = state.timing === "untimed";
    if(state.untimed){
      // Phase G §1: count-up, no countdown/auto-submit/5-min; resume restores
      // elapsed (the blob flags untimed and stores elapsedSeconds)
      state.elapsedSec = (resume && resume.untimed && resume.elapsedSeconds > 0)
        ? Math.floor(resume.elapsedSeconds) : 0;
      state.timeRemainingSec = 0;
      state.fiveMinAlerted = true;             // never fires when untimed
    } else {
      state.timeRemainingSec = (resume && resume.timeRemainingSeconds > 0) ?
        Math.floor(resume.timeRemainingSeconds) : accommodatedLimitSec(mod, state.timing);
      // Phase F §6: alert fires once per module; resuming inside the final five
      // minutes keeps it consumed and the Hide control stays gone (screenshot 22)
      state.fiveMinAlerted = state.timeRemainingSec <= 300;
    }
    state.timerHidden = false;
    el("timerBtn").textContent = "Hide";
    hide("fiveMinPopup");
    el("timerBtn").classList.toggle("hidden", state.fiveMinAlerted && !state.untimed);
    showOnly("screen-test");
    renderTest();
    openDirections();
    startTimer();
    Attempts.moduleStart(mod);
  }

  function startTimer(){
    clearInterval(state.timerInterval);
    updateTimerDisplay();
    if(state.untimed){
      // Phase G §1: count up, never auto-submit, no five-minute alert
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
        submitModule("timer-expired");   // real Bluebook auto-advances at 0:00
        return;
      }
      if(state.timeRemainingSec === 300 && !state.fiveMinAlerted){
        state.fiveMinAlerted = true;
        state.timerHidden = false;               // force-show the timer (§6)
        el("timerBtn").textContent = "Hide";
        el("timerBtn").classList.add("hidden");  // Hide control gone for the rest (22)
        show("fiveMinPopup");                    // dark alert below the timer (23)
      }
      updateTimerDisplay();
    }, 1000);
  }
  el("fiveMinClose").addEventListener("click", ()=> hide("fiveMinPopup"));

  function updateTimerDisplay(){
    const secs = state.untimed ? state.elapsedSec : state.timeRemainingSec;
    const m = Math.floor(secs/60);
    const s = secs % 60;
    const disp = el("timerDisplay");
    disp.classList.toggle("warn", !state.untimed && state.timeRemainingSec <= 300);
    if(state.timerHidden){
      disp.innerHTML = '<span class="clock-ico">⏱</span>';
    } else {
      // untimed counts up with a small "Untimed" label above the clock (§1)
      disp.innerHTML = (state.untimed ? '<span class="timer-untimed">Untimed</span>' : '') +
        '<span id="timerVal">' + m + ":" + String(s).padStart(2,"0") + "</span>";
    }
  }

  el("timerBtn").addEventListener("click", ()=>{
    state.timerHidden = !state.timerHidden;
    el("timerBtn").textContent = state.timerHidden ? "Show" : "Hide";
    updateTimerDisplay();
  });

  /* ================= DIRECTIONS ================= */
  function directionsHtml(mod){
    if(mod.section === "Reading and Writing"){
      return `<p>The questions in this section address a number of important reading and writing skills. Each question includes one or more passages, which may include a table or graph. Read each passage and question carefully, and then choose the best answer to the question based on the passage(s).</p>
              <p>All questions in this section are multiple-choice with four answer choices. Each question has a single best answer.</p>`;
    }
    return `<p>The questions in this section address a number of important math skills.</p>
            <p>For multiple-choice questions, solve each problem and choose the correct answer from the choices provided. Each multiple-choice question has a single correct answer.</p>
            <p>For student-produced response questions, solve each problem and enter your answer. If you find more than one correct answer, enter only one answer. You can enter fractions (such as 7/2) or decimals (such as 3.5).</p>`;
  }

  el("dirToggle").addEventListener("click", ()=>{
    if(el("dirOverlay").classList.contains("hidden")) openDirections();
    else closeDirections();
  });
  function openDirections(){
    el("dirPanel").innerHTML = directionsHtml(currentModule()) +
      '<div class="close-row"><button class="pill yellow" id="dirCloseBtn" style="padding:9px 30px;">Close</button></div>';
    el("dirCloseBtn").addEventListener("click", closeDirections);
    show("dirOverlay");
    el("dirToggle").classList.add("open");
  }
  function closeDirections(){
    hide("dirOverlay");
    el("dirToggle").classList.remove("open");
  }
  el("dirOverlay").addEventListener("click", e=>{ if(e.target.id === "dirOverlay") closeDirections(); });

  /* ================= RENDER TEST ================= */
  function renderTest(){
    if(state.view === "review") renderReviewView();
    else renderQuestionView();
    renderNotesRail();
  }

  function renderQuestionView(){
    const mod = currentModule();
    const q = currentQuestion();
    const ms = currentModState();

    el("thTitle").textContent = sectionTitle(mod);
    el("tfName").textContent = state.userName;
    updateHeaderTools(mod);

    const isSpr = q.type === "spr";
    const hasLeft = !!q.passage || isSpr;
    const tBody = el("tBody");
    tBody.classList.toggle("single", !hasLeft);

    const left = el("paneLeft");
    const right = el("paneRight");

    if(q.passage){
      const saved = ms.passageHtml[q.id];
      left.innerHTML = '<div class="passage-text" id="passageText">' +
        (saved !== undefined ? saved : fmt(q.passage)) + '</div>';
    } else if(isSpr){
      left.innerHTML = sprDirectionsHtml();
    } else {
      left.innerHTML = "";
    }

    right.innerHTML = buildQuestionHtml(q, ms);
    right.scrollTop = 0;
    attachQuestionHandlers();

    const total = mod.questions.length;
    el("qnavBtnLabel").textContent = `Question ${state.questionIndex+1} of ${total}`;
    el("qnavBtn").style.visibility = "visible";
    el("btnBack").classList.toggle("hidden", state.questionIndex === 0);
    el("btnNext").textContent = "Next";
    Attempts.questionShown(q.id);      // no-op on re-renders of the same question
  }

  function buildQuestionHtml(q, ms){
    const isSpr = q.type === "spr";
    const flagged = ms.flags.has(q.id);
    const abcOn = state.elimMode && !isSpr;

    const figHtml = q.figure ? `
      <div class="fig-frame">
        <div class="fig-toolbar">
          <button id="figZin" title="Zoom in">🔍+</button>
          <button id="figZout" title="Zoom out">🔍−</button>
          <span id="figPct">100%</span>
          <button id="figReset">Reset</button>
          <span class="sep"></span>
          <button id="figExpand" title="Expand">⛶</button>
        </div>
        <div class="fig-imgwrap"><img id="figImg" src="${escapeHtml(q.figure)}" alt="Question figure"></div>
        ${q.figureCaption ? `<div class="fig-caption">${fmt(q.figureCaption)}</div>` : ""}
      </div>` : "";

    let body;
    if(isSpr){
      const cur = ms.answers.hasOwnProperty(q.id) ? ms.answers[q.id] : "";
      body = `
        <input type="text" class="spr-input" id="sprInput" value="${escapeHtml(cur)}" autocomplete="off" spellcheck="false">
        <div class="ap-label">Answer Preview:</div>
        <div id="sprPreview">${sprPreviewHtml(cur)}</div>
        <div><button class="keypad-toggle" id="kpToggle">⌨&nbsp; Show Keypad</button></div>
        <div class="keypad hidden" id="keypad">
          <div class="keypad-head" id="keypadHead">Keypad
            <span class="calc-drag" style="margin-left:auto;margin-right:10px;">⠿</span>
            <button class="panel-x" id="kpClose">✕</button>
          </div>
          <div class="kp-grid">${[1,2,3,4,5,6,7,8,9].map(n=>`<button data-k="${n}">${n}</button>`).join("")}</div>
          <div class="kp-row5">
            <button data-k="-">−</button><button data-k=".">.</button><button data-k="0">0</button><button data-k="/">/</button><button data-k="⌫">⌫</button>
          </div>
        </div>`;
    } else {
      const elimSet = ms.eliminated[q.id] || new Set();
      body = '<div class="choices' + (abcOn ? ' elim-mode' : '') + '" id="choicesWrap">' +
        q.choices.map((c,idx)=>{
          const letter = String.fromCharCode(65+idx);
          const sel = ms.answers[q.id] === idx;
          const elim = elimSet.has(idx);
          return `
            <div class="choice-row${elim ? " is-elim" : ""}">
              <div class="choice ${sel?"selected":""} ${elim?"eliminated":""}" data-idx="${idx}">
                <span class="clabel">${letter}</span>
                <span class="ctext">${fmt(c)}</span>
              </div>
              <button class="elim-btn" data-elim="${idx}" title="Cross out choice ${letter}">${letter}</button>
              <button class="elim-undo" data-undo="${idx}">Undo</button>
            </div>`;
        }).join("") + '</div>';
    }

    return `
      <div class="q-head">
        <div class="q-num">${state.questionIndex+1}</div>
        <button class="q-flag ${flagged?"on":""}" id="flagBtn"><span class="bkm"><svg viewBox="0 0 24 24" width="15" height="17" aria-hidden="true"><path d="M5.5 3h13v18l-6.5-4.8L5.5 21z" stroke-width="2" stroke-linejoin="round"/></svg></span> Mark for Review</button>
        ${isSpr ? "" : `<button class="abc-toggle ${abcOn?"on":""}" id="abcToggle" title="Cross out answer choices"><span class="abctxt">ABC</span></button>`}
      </div>
      ${figHtml}
      <div class="q-text">${fmt(q.questionText)}</div>
      ${body}`;
  }

  function attachQuestionHandlers(){
    const q = currentQuestion();
    const ms = currentModState();

    el("flagBtn").addEventListener("click", ()=>{
      if(ms.flags.has(q.id)) ms.flags.delete(q.id); else ms.flags.add(q.id);
      renderQuestionView();
    });

    attachFigureHandlers(q);

    if(q.type === "spr"){
      const input = el("sprInput");
      const sync = ()=>{
        input.value = sanitizeSpr(input.value);
        const val = input.value.trim();
        if(val === "") delete ms.answers[q.id]; else ms.answers[q.id] = val;
        el("sprPreview").innerHTML = sprPreviewHtml(val);
        Attempts.answerLive(q.id, val || null);   // committed when the question leaves the screen
      };
      input.addEventListener("input", sync);

      const kp = el("keypad"), kt = el("kpToggle");
      const setKp = (open)=>{
        kp.classList.toggle("hidden", !open);
        kt.innerHTML = open ? "⌨&nbsp; Hide Keypad" : "⌨&nbsp; Show Keypad";
        if(open){
          const r = input.getBoundingClientRect();
          kp.style.top = Math.max(80, r.top - 10) + "px";
          kp.style.left = Math.min(window.innerWidth - 296, r.right + 70) + "px";
        }
      };
      kt.addEventListener("click", ()=> setKp(kp.classList.contains("hidden")));
      el("kpClose").addEventListener("click", ()=> setKp(false));
      kp.querySelectorAll("[data-k]").forEach(b=> b.addEventListener("click", ()=>{
        let v = input.value;
        if(b.dataset.k === "⌫") v = v.slice(0,-1); else v += b.dataset.k;
        input.value = v;
        sync();
        input.focus();
      }));
      makeDraggable(kp, el("keypadHead"));
      return;
    }

    el("abcToggle").addEventListener("click", ()=>{
      state.elimMode = !state.elimMode;
      renderQuestionView();
    });

    document.querySelectorAll("#paneRight .choice").forEach(node=>{
      node.addEventListener("click", ()=>{
        const idx = parseInt(node.dataset.idx,10);
        const elimSet = ms.eliminated[q.id];
        if(elimSet && elimSet.has(idx)) return;   // can't select a crossed-out choice
        ms.answers[q.id] = idx;
        Attempts.answerCommitted(q.id, idx);
        renderQuestionView();
      });
    });
    document.querySelectorAll("#paneRight .elim-btn").forEach(btn=>{
      btn.addEventListener("click", e=>{
        e.stopPropagation();
        toggleEliminate(q.id, parseInt(btn.dataset.elim,10));
      });
    });
    document.querySelectorAll("#paneRight .elim-undo").forEach(btn=>{
      btn.addEventListener("click", e=>{
        e.stopPropagation();
        toggleEliminate(q.id, parseInt(btn.dataset.undo,10));
      });
    });
  }

  function toggleEliminate(qid, idx){
    const ms = currentModState();
    if(!ms.eliminated[qid]) ms.eliminated[qid] = new Set();
    if(ms.eliminated[qid].has(idx)) ms.eliminated[qid].delete(idx);
    else {
      ms.eliminated[qid].add(idx);
      if(ms.answers[qid] === idx){
        delete ms.answers[qid];
        Attempts.answerCommitted(qid, null);   // crossing out the selected choice clears it
      }
    }
    renderQuestionView();
  }

  /* ================= NAV BUTTONS ================= */
  el("btnBack").addEventListener("click", ()=>{
    if(state.view === "review"){ state.view = "question"; renderTest(); return; }
    if(state.questionIndex > 0){ state.questionIndex--; renderTest(); }
  });
  el("btnNext").addEventListener("click", ()=>{
    if(state.view === "review"){ submitModule(); return; }
    const total = currentModule().questions.length;
    if(state.questionIndex < total-1){ state.questionIndex++; renderTest(); }
    else { state.view = "review"; renderTest(); }
  });

  /* ================= QUESTION NAVIGATOR POPUP ================= */
  el("qnavBtn").addEventListener("click", openQnav);
  el("qnavClose").addEventListener("click", closeQnav);
  el("qnavOverlay").addEventListener("click", closeQnav);
  el("gotoReviewBtn").addEventListener("click", ()=>{
    closeQnav();
    state.view = "review";
    renderTest();
  });

  const QNAV_PIN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#1E1E1E" stroke-width="2" aria-hidden="true"><path d="M12 21.5S5 14.9 5 10.3a7 7 0 0 1 14 0c0 4.6-7 11.2-7 11.2z"/><circle cx="12" cy="10" r="2.6"/></svg>';
  const QNAV_FLAG = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M5 2.5h14V21l-7-5.1L5 21z" fill="#C23349"/></svg>';

  function buildQnavGrid(container, jumpFn){
    const mod = currentModule();
    const ms = currentModState();
    container.innerHTML = "";
    mod.questions.forEach((q,idx)=>{
      const cell = document.createElement("div");
      const answered = ms.answers.hasOwnProperty(q.id);
      cell.className = "qcell" + (answered ? " answered" : "");
      cell.textContent = idx+1;
      if(state.view === "question" && idx === state.questionIndex){
        cell.classList.add("current");
        cell.insertAdjacentHTML("beforeend", '<span class="cellpin">' + QNAV_PIN + '</span>');
      }
      if(ms.flags.has(q.id)){
        cell.insertAdjacentHTML("beforeend", '<span class="cellflag">' + QNAV_FLAG + '</span>');
      }
      cell.addEventListener("click", ()=>jumpFn(idx));
      container.appendChild(cell);
    });
  }

  function openQnav(){
    el("qnavTitle").textContent = sectionTitle(currentModule()) + " Questions";
    buildQnavGrid(el("qnavGrid"), idx=>{
      closeQnav();
      state.view = "question";
      state.questionIndex = idx;
      renderTest();
    });
    show("qnavOverlay"); show("qnavPopup");
    el("qnavBtn").classList.add("open");     // footer chevron flips while open (15 vs 16)
  }
  function closeQnav(){
    hide("qnavOverlay"); hide("qnavPopup");
    el("qnavBtn").classList.remove("open");
  }

  /* ================= CHECK YOUR WORK (review view) ================= */
  function renderReviewView(){
    Attempts.reviewShown();               // closes the per-question clock
    const mod = currentModule();
    el("thTitle").textContent = sectionTitle(mod);
    el("tBody").classList.add("single");
    el("paneLeft").innerHTML = "";
    const right = el("paneRight");
    right.innerHTML = `
      <div class="review-wrap">
        <h1>Check Your Work</h1>
        <p class="rv-sub">On test day, you won't be able to move on to the next module until time expires. For this practice test, you can select <b>Next</b> when you're ready to move on. You won't be able to return to this module afterward.</p>
        <div class="review-box">
          <div class="qnav-title">${escapeHtml(sectionTitle(mod))} Questions</div>
          <div class="qnav-legend">
            <span><span class="lg-dash"></span> Unanswered</span>
            <span><span class="lg-flag">${QNAV_FLAG}</span> For Review</span>
          </div>
          <div class="qnav-grid" id="reviewGrid"></div>
        </div>
      </div>`;
    buildQnavGrid(el("reviewGrid"), idx=>{
      state.view = "question";
      state.questionIndex = idx;
      renderTest();
    });
    el("qnavBtn").style.visibility = "hidden";
    el("btnBack").classList.remove("hidden");
    el("btnNext").textContent = "Next";
  }

  function submitModule(endedBy){
    clearInterval(state.timerInterval);
    closeDirections(); closeQnav(); hideHlPopup(); closeCalc(); closeRef(); hide("figOverlay");
    setLineReader(false);
    hide("fiveMinPopup");
    const cur = currentModule();
    Attempts.moduleEnd(cur, endedBy || "submitted");
    const nextIdx = state.moduleIndex + 1;
    if(nextIdx < state.currentTest.modules.length){
      const next = state.currentTest.modules[nextIdx];
      state.moduleIndex = nextIdx;
      if(next.section === cur.section){
        showModuleOver(false);
      } else {
        showBreak();
      }
    } else {
      Attempts.finalize(endedBy || "submitted");
      delete state.resumeRecords[state.currentTest.testId];   // completed ≠ resumable
      if(state.activeAssignment){
        // Phase F §2: the assignment is consumed — its card becomes Completed
        state.activeAssignment.completedAttemptId = Attempts.currentAttemptId() || "unknown";
        Attempts.completeAssignment(state.userName, state.activeAssignment.assignmentId);
        state.activeAssignment = null;
      }
      showModuleOver(true);
    }
  }

  function showModuleOver(isFinal){
    showOnly("screen-moduleover");
    setTimeout(()=>{
      if(isFinal) showSubmitted();     // score-visibility (b): confirmation only
      else beginModule(state.moduleIndex);
    }, 2600);
  }

  /* Phase D, score-visibility (b): submit -> confirmation only. Results
     surface in Past -> View My Responses once the tutor flips the released
     flag from the dashboard. */
  function showSubmitted(){
    const working = Attempts.storageWorking();
    el("subSaveNote").textContent = working
      ? "Your attempt was recorded automatically."
      : "Automatic recording isn't available in this copy — download your results and send the file to your tutor.";
    el("subDownloadBtn").classList.toggle("hidden", working);   // spec §6 fallback
    showOnly("screen-submitted");
  }
  el("subDownloadBtn").addEventListener("click", ()=> Attempts.downloadJson());
  el("subHomeBtn").addEventListener("click", async ()=>{
    state.pastAttempts = await Attempts.pastAttempts(state.userName);
    state.practiceTab = "past";      // land them where the new attempt now shows
    state.currentTest = null;
    renderHome();
    showOnly("screen-home");
  });

  function showBreak(){
    el("brkName").textContent = state.userName;
    state.breakRemaining = 10 * 60;
    el("brkTimer").classList.remove("hidden");
    el("brkTitle").textContent = "Take a Break";
    el("brkText").textContent = "Testing will resume when the timer ends, or select Resume Testing to continue now.";
    updateBreakDisplay();
    clearInterval(state.breakInterval);
    state.breakInterval = setInterval(()=>{
      state.breakRemaining--;
      if(state.breakRemaining <= 0){
        clearInterval(state.breakInterval);
        el("brkTimer").classList.add("hidden");
        el("brkTitle").textContent = "Resume Testing Now";
        el("brkText").textContent = "Your testing timer has not started counting down yet.";
        return;
      }
      updateBreakDisplay();
    }, 1000);
    showOnly("screen-break");
  }
  function updateBreakDisplay(){
    const m = Math.floor(state.breakRemaining/60);
    const s = state.breakRemaining % 60;
    el("brkTimer").textContent = m + ":" + String(s).padStart(2,"0");
  }
  el("brkResumeBtn").addEventListener("click", ()=>{
    clearInterval(state.breakInterval);
    beginModule(state.moduleIndex);
  });

  /* ================= SECTION TOOLS (Calculator / Reference / Highlights) ================= */
  /* More (⋮) menu — Phase C ships Save and Exit; Phase E completes the menu.
     Unimplemented items stay hidden rather than shipping dead entries. */
  const MORE_MENU_HTML = `
    <span class="more-wrap">
      <button class="th-tool" id="moreBtn"><span class="ticon">⋮</span><span class="tlabel">More</span></button>
      <div class="more-menu hidden" id="moreMenu">
        <button class="more-item" id="miLineReader">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#1E1E1E" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 5h16M4 19h16"/><rect x="4" y="9.5" width="16" height="5" rx="1.5"/></svg>
          <span>Line Reader</span>
        </button>
        <button class="more-item" id="miSaveExit">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#1E1E1E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>
          <span>Save and Exit</span>
        </button>
        <button class="more-item" id="miBugReport">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#1E1E1E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="6"/><path d="M12 7V4M7.5 9L5 6.5M16.5 9L19 6.5M6 13H3M21 13h-3M7.5 17L5 19.5M16.5 17L19 19.5"/></svg>
          <span>Report a bug</span>
        </button>
      </div>
    </span>`;

  function wireMoreMenu(){
    el("moreBtn").addEventListener("click", ()=>{
      const open = el("moreMenu").classList.contains("hidden");
      el("moreMenu").classList.toggle("hidden", !open);
      el("moreBtn").classList.toggle("on", open);
    });
    el("miLineReader").addEventListener("click", ()=>{   // re-click toggles off
      setLineReader(el("lineReader").classList.contains("hidden"));
      closeMoreMenu();
    });
    el("miSaveExit").addEventListener("click", saveAndExit);
    el("miBugReport").addEventListener("click", ()=>{ closeMoreMenu(); openBugModal(); });
  }

  /* ---- Line Reader (Phase E) ---- */
  function setLineReader(on){
    el("lineReader").classList.toggle("hidden", !on);
    if(on) setLrTop(Math.round(el("tBody").getBoundingClientRect().height * 0.25));
  }
  function setLrTop(px){
    const bodyH = el("tBody").getBoundingClientRect().height;
    const bandH = el("lrBand").offsetHeight;
    el("lrTop").style.height = Math.max(0, Math.min(px, bodyH - bandH)) + "px";
  }
  let lrDrag = null;
  el("lrBand").addEventListener("pointerdown", e=>{
    lrDrag = { startY: e.clientY, startTop: el("lrTop").offsetHeight };
    el("lrBand").setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el("lrBand").addEventListener("pointermove", e=>{
    if(!lrDrag) return;
    setLrTop(lrDrag.startTop + (e.clientY - lrDrag.startY));
  });
  el("lrBand").addEventListener("pointerup", ()=>{ lrDrag = null; });
  document.addEventListener("keydown", e=>{
    if(e.key === "Escape" && !el("lineReader").classList.contains("hidden")) setLineReader(false);
  });
  function closeMoreMenu(){
    const menu = document.getElementById("moreMenu");
    if(menu) menu.classList.add("hidden");
    const btn = document.getElementById("moreBtn");
    if(btn) btn.classList.remove("on");
  }
  document.addEventListener("mousedown", e=>{
    const menu = document.getElementById("moreMenu");
    if(menu && !menu.classList.contains("hidden") && !e.target.closest(".more-wrap")) closeMoreMenu();
  });

  async function saveAndExit(){
    clearInterval(state.timerInterval);           // timer pauses while exited
    closeDirections(); closeQnav(); hideHlPopup(); closeCalc(); closeRef(); hide("figOverlay");
    setLineReader(false);
    hide("fiveMinPopup");
    closeMoreMenu();
    const test = state.currentTest;
    const annotations = {};
    Object.keys(state.moduleState).forEach(mid=>{
      const ms = state.moduleState[mid];
      if(Object.keys(ms.passageHtml).length || Object.keys(ms.notes).length){
        annotations[mid] = { passageHtml: ms.passageHtml, notes: ms.notes };
      }
    });
    const ok = await Attempts.suspend({
      moduleIndex: state.moduleIndex,
      questionIndex: state.questionIndex,
      timeRemainingSeconds: state.timeRemainingSec,
      untimed: state.untimed,                 // Phase G §1: untimed resumes by elapsed
      elapsedSeconds: state.elapsedSec,
      annotations
    });
    if(!ok){
      // Phase F §8: never return home over unrecoverable progress — stay in
      // the test, restart the clock, explain, and offer the JSON fallback
      startTimer();
      renderTest();                               // reopens the per-question clock
      show("saveFailModal");
      return;
    }
    // re-read from storage so the home card reflects what actually persisted
    const r = await Attempts.findInProgress(state.userName, test.testId, test.testVersion);
    if(r) state.resumeRecords[test.testId] = r;
    state.currentTest = null;
    renderHome();
    showOnly("screen-home");
  }
  el("sfContinueBtn").addEventListener("click", ()=> hide("saveFailModal"));
  el("sfDownloadBtn").addEventListener("click", ()=> Attempts.downloadJson());

  /* ================= REPORT A BUG (Phase F §9) ================= */
  function openBugModal(){
    el("bugText").value = "";
    el("bugNote").classList.add("hidden");
    show("bugModal");
    el("bugText").focus();
  }
  function closeBugModal(){ hide("bugModal"); }
  el("bugClose").addEventListener("click", closeBugModal);
  el("bugCancel").addEventListener("click", closeBugModal);
  el("homeBugBtn").addEventListener("click", openBugModal);
  el("bugSend").addEventListener("click", async ()=>{
    const text = el("bugText").value.trim();
    if(!text){ el("bugText").focus(); return; }
    // gate on the test screen actually being visible, not just currentTest
    // being set — backing out of the Ready screen leaves currentTest set, and
    // a home-screen bug report must not carry fabricated module/question/timer
    // context (§9: "moduleId + question id if in-test")
    const inTest = !!state.currentTest && !el("screen-test").classList.contains("hidden");
    const report = {
      at: new Date().toISOString(),
      studentCode: state.userName,
      testId: inTest ? state.currentTest.testId : null,
      testVersion: inTest ? (state.currentTest.testVersion || "unversioned") : null,
      attemptId: Attempts.currentAttemptId(),
      moduleId: inTest ? currentModule().moduleId : null,
      questionId: (inTest && state.view === "question") ? currentQuestion().id : null,
      timerRemainingSeconds: inTest ? state.timeRemainingSec : null,
      userAgent: navigator.userAgent,
      text
    };
    const note = el("bugNote");
    const ok = await Attempts.reportBug(report);
    if(ok){
      note.textContent = "Thanks — your report was sent.";
      note.classList.remove("err");
      note.classList.remove("hidden");
      setTimeout(closeBugModal, 1400);
    } else {
      // storage absent/failing → mailto draft with the same context (§9)
      const body = "Bug report from the Bluebook Simulator\n\n" + JSON.stringify(report, null, 2);
      window.location.href = "mailto:lee.david87@gmail.com?subject=" +
        encodeURIComponent("Bluebook Simulator bug report") +
        "&body=" + encodeURIComponent(body);
      note.textContent = "Storage isn't reachable — an email draft was opened instead.";
      note.classList.add("err");
      note.classList.remove("hidden");
    }
  });

  function updateHeaderTools(mod){
    const tools = el("thTools");
    if(mod.section === "Math"){
      tools.innerHTML = `
        <button class="th-tool" id="toolCalc"><span class="ticon"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2.5" width="14" height="19" rx="2.2"/><rect x="7.5" y="5" width="9" height="3.6" rx="0.8"/><path d="M8.5 12.5h0M12 12.5h0M15.5 12.5h0M8.5 15.5h0M12 15.5h0M15.5 15.5h0M8.5 18.5h0M12 18.5h0"/><path d="M15.5 17.5v2" stroke-width="1.7"/></svg></span>Calculator</button>
        <button class="th-tool" id="toolRef"><span class="ticon" style="font-family:var(--serif);font-style:italic;">x²</span>Reference</button>` +
        MORE_MENU_HTML;
      el("toolCalc").addEventListener("click", toggleCalc);
      el("toolRef").addEventListener("click", toggleRef);
      wireMoreMenu();
    } else {
      tools.innerHTML = `
        <span class="hl-mode-wrap">
          <button class="th-tool" id="hlModeBtn" title="Toggle highlight mode"><span class="ticon">✎</span><span class="tlabel">Highlights &amp; Notes</span></button>
          <div class="hl-tip hidden" id="hlTip"><b>Highlight mode on:</b> Select text to create a highlight automatically.</div>
        </span>` +
        MORE_MENU_HTML;
      wireHlModeBtn();
      wireMoreMenu();
    }
    el("tBody").classList.toggle("hl-mode", state.hlMode && mod.section !== "Math");
  }

  /* Highlights & Notes as a real mode toggle (screenshots 16-18): when on,
     drag-selecting passage text highlights it instantly in the active color */
  let hlTipTimer = null;
  function wireHlModeBtn(){
    const btn = el("hlModeBtn"), tip = el("hlTip");
    btn.classList.toggle("on", state.hlMode);
    const showTip = (autoHide)=>{
      tip.classList.remove("hidden");
      if(hlTipTimer) clearTimeout(hlTipTimer);
      if(autoHide) hlTipTimer = setTimeout(()=> tip.classList.add("hidden"), 5000);
    };
    btn.addEventListener("click", ()=>{
      state.hlMode = !state.hlMode;
      btn.classList.toggle("on", state.hlMode);
      el("tBody").classList.toggle("hl-mode", state.hlMode);
      if(state.hlMode) showTip(true);
      else tip.classList.add("hidden");
    });
    btn.addEventListener("mouseenter", ()=>{ if(state.hlMode) showTip(false); });
    btn.addEventListener("mouseleave", ()=>{
      if(hlTipTimer) clearTimeout(hlTipTimer);
      tip.classList.add("hidden");
    });
  }

  function makeDraggable(panel, handle){
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener("pointerdown", e=>{
      if(e.target.closest("button")) return;
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
    });
    handle.addEventListener("pointermove", e=>{
      if(!dragging) return;
      panel.style.left = (ox + e.clientX - sx) + "px";
      panel.style.top  = (oy + e.clientY - sy) + "px";
      panel.style.right = "auto"; panel.style.bottom = "auto";
    });
    handle.addEventListener("pointerup", ()=>{ dragging = false; });
  }

  /* ---- Desmos calculator ---- */
  let desmosState = "idle";   // idle | loading | ready | error
  let calcG = null, calcS = null;
  function toggleCalc(){ el("calcPanel").classList.contains("hidden") ? openCalc() : closeCalc(); }
  function openCalc(){
    show("calcPanel");
    if(desmosState === "idle") loadDesmos();
  }
  function closeCalc(){ hide("calcPanel"); }
  function loadDesmos(){
    desmosState = "loading";
    const s = document.createElement("script");
    // Desmos demo API key (for development). For classroom-scale use, get a free key at desmos.com/api
    s.src = "https://www.desmos.com/api/v1.11/calculator.js?apiKey=dcb31709b452b1cf9dc26972add0fda6";
    s.onload = ()=>{
      try{
        calcG = Desmos.GraphingCalculator(el("calcGraph"), { expressions:true });
        calcS = Desmos.ScientificCalculator(el("calcSci"));
        desmosState = "ready";
        hide("calcMsg");
        new ResizeObserver(()=>{ if(calcG) calcG.resize(); if(calcS) calcS.resize(); }).observe(el("calcPanel"));
      }catch(err){ desmosFail(); }
    };
    s.onerror = desmosFail;
    document.head.appendChild(s);
  }
  function desmosFail(){
    desmosState = "error";
    el("calcMsg").textContent = "The Desmos calculator couldn't load — it needs an internet connection. Everything else works offline.";
    show("calcMsg");
  }
  el("calcClose").addEventListener("click", closeCalc);
  el("calcTabG").addEventListener("click", ()=>{
    el("calcTabG").classList.add("on"); el("calcTabS").classList.remove("on");
    hide("calcSci"); show("calcGraph");
    if(calcG) calcG.resize();
  });
  el("calcTabS").addEventListener("click", ()=>{
    el("calcTabS").classList.add("on"); el("calcTabG").classList.remove("on");
    hide("calcGraph"); show("calcSci");
    if(calcS) calcS.resize();
  });
  makeDraggable(el("calcPanel"), el("calcHead"));

  /* ---- Reference sheet ---- */
  const REF_HTML = `
    <div class="ref-grid">
      <div class="ref-fig">
        <svg viewBox="0 0 130 92" width="130"><circle cx="62" cy="46" r="34" fill="none" stroke="#111" stroke-width="1.5"/><circle cx="62" cy="46" r="2.4" fill="#111"/><line x1="62" y1="46" x2="90" y2="31" stroke="#111" stroke-width="1.2"/><text x="78" y="30" font-size="13" font-style="italic">r</text></svg>
        <div class="rf-f"><i>A</i> = π<i>r</i>²&nbsp;&nbsp;&nbsp;<i>C</i> = 2π<i>r</i></div>
      </div>
      <div class="ref-fig">
        <svg viewBox="0 0 150 84" width="150"><rect x="22" y="20" width="104" height="46" fill="none" stroke="#111" stroke-width="1.5"/><text x="70" y="14" font-size="13" font-style="italic">ℓ</text><text x="132" y="47" font-size="13" font-style="italic">w</text></svg>
        <div class="rf-f"><i>A</i> = <i>ℓw</i></div>
      </div>
      <div class="ref-fig">
        <svg viewBox="0 0 150 92" width="150"><polygon points="15,78 135,78 75,16" fill="none" stroke="#111" stroke-width="1.5"/><line x1="75" y1="16" x2="75" y2="78" stroke="#111" stroke-width="1.1" stroke-dasharray="4 3"/><text x="80" y="52" font-size="13" font-style="italic">h</text><text x="72" y="91" font-size="13" font-style="italic">b</text></svg>
        <div class="rf-f"><i>A</i> = ½<i>bh</i></div>
      </div>
      <div class="ref-fig">
        <svg viewBox="0 0 150 96" width="150"><polygon points="20,80 130,80 130,20" fill="none" stroke="#111" stroke-width="1.5"/><rect x="118" y="68" width="12" height="12" fill="none" stroke="#111" stroke-width="1.1"/><text x="70" y="93" font-size="13" font-style="italic">a</text><text x="135" y="53" font-size="13" font-style="italic">b</text><text x="60" y="46" font-size="13" font-style="italic">c</text></svg>
        <div class="rf-f"><i>c</i>² = <i>a</i>² + <i>b</i>²</div>
      </div>
      <div class="ref-fig">
        <svg viewBox="0 0 175 104" width="170"><polygon points="15,86 157,86 157,24" fill="none" stroke="#111" stroke-width="1.5"/><rect x="145" y="74" width="12" height="12" fill="none" stroke="#111" stroke-width="1.1"/><text x="38" y="81" font-size="11">30°</text><text x="141" y="44" font-size="11">60°</text><text x="66" y="46" font-size="12" font-style="italic">2x</text><text x="162" y="60" font-size="12" font-style="italic">x</text><text x="72" y="99" font-size="12" font-style="italic">x√3</text></svg>
      </div>
      <div class="ref-fig">
        <svg viewBox="0 0 150 104" width="145"><polygon points="20,86 130,86 130,22" fill="none" stroke="#111" stroke-width="1.5"/><rect x="118" y="74" width="12" height="12" fill="none" stroke="#111" stroke-width="1.1"/><text x="40" y="81" font-size="11">45°</text><text x="112" y="42" font-size="11">45°</text><text x="55" y="48" font-size="12" font-style="italic">s√2</text><text x="136" y="58" font-size="12" font-style="italic">s</text><text x="72" y="100" font-size="12" font-style="italic">s</text></svg>
      </div>
      <div class="ref-span">Special Right Triangles</div>
      <div class="ref-fig">
        <svg viewBox="0 0 165 112" width="160"><rect x="25" y="42" width="80" height="50" fill="none" stroke="#111" stroke-width="1.5"/><polygon points="25,42 55,22 135,22 105,42" fill="none" stroke="#111" stroke-width="1.5"/><polygon points="105,42 135,22 135,72 105,92" fill="none" stroke="#111" stroke-width="1.5"/><text x="60" y="106" font-size="13" font-style="italic">ℓ</text><text x="120" y="16" font-size="13" font-style="italic">w</text><text x="142" y="52" font-size="13" font-style="italic">h</text></svg>
        <div class="rf-f"><i>V</i> = <i>ℓwh</i></div>
      </div>
      <div class="ref-fig">
        <svg viewBox="0 0 135 112" width="130"><ellipse cx="66" cy="26" rx="38" ry="12" fill="none" stroke="#111" stroke-width="1.5"/><path d="M28,26 v56 a38,12 0 0 0 76,0 v-56" fill="none" stroke="#111" stroke-width="1.5"/><circle cx="66" cy="26" r="2" fill="#111"/><line x1="66" y1="26" x2="99" y2="22" stroke="#111" stroke-width="1.1"/><text x="80" y="19" font-size="12" font-style="italic">r</text><text x="112" y="62" font-size="13" font-style="italic">h</text></svg>
        <div class="rf-f"><i>V</i> = π<i>r</i>²<i>h</i></div>
      </div>
      <div class="ref-fig">
        <svg viewBox="0 0 115 104" width="110"><circle cx="57" cy="52" r="38" fill="none" stroke="#111" stroke-width="1.5"/><ellipse cx="57" cy="52" rx="38" ry="11" fill="none" stroke="#111" stroke-width="1" stroke-dasharray="4 3"/><circle cx="57" cy="52" r="2" fill="#111"/><line x1="57" y1="52" x2="90" y2="45" stroke="#111" stroke-width="1.1"/><text x="72" y="42" font-size="12" font-style="italic">r</text></svg>
        <div class="rf-f"><i>V</i> = <span class="fstack" style="font-size:.72em;vertical-align:-4px;"><span>4</span><span class="fbar"></span><span>3</span></span>π<i>r</i>³</div>
      </div>
      <div class="ref-fig">
        <svg viewBox="0 0 125 112" width="120"><ellipse cx="62" cy="90" rx="38" ry="12" fill="none" stroke="#111" stroke-width="1.5"/><polyline points="24,90 62,16 100,90" fill="none" stroke="#111" stroke-width="1.5"/><line x1="62" y1="16" x2="62" y2="90" stroke="#111" stroke-width="1.1" stroke-dasharray="4 3"/><line x1="62" y1="90" x2="96" y2="86" stroke="#111" stroke-width="1.1"/><text x="76" y="84" font-size="12" font-style="italic">r</text><text x="66" y="58" font-size="12" font-style="italic">h</text></svg>
        <div class="rf-f"><i>V</i> = <span class="fstack" style="font-size:.72em;vertical-align:-4px;"><span>1</span><span class="fbar"></span><span>3</span></span>π<i>r</i>²<i>h</i></div>
      </div>
      <div class="ref-fig">
        <svg viewBox="0 0 155 112" width="150"><polygon points="28,92 118,92 138,74 48,74" fill="none" stroke="#111" stroke-width="1.2" stroke-dasharray="4 3"/><line x1="28" y1="92" x2="85" y2="18" stroke="#111" stroke-width="1.5"/><line x1="118" y1="92" x2="85" y2="18" stroke="#111" stroke-width="1.5"/><line x1="138" y1="74" x2="85" y2="18" stroke="#111" stroke-width="1.2" stroke-dasharray="4 3"/><line x1="48" y1="74" x2="85" y2="18" stroke="#111" stroke-width="1.2" stroke-dasharray="4 3"/><line x1="28" y1="92" x2="118" y2="92" stroke="#111" stroke-width="1.5"/><text x="66" y="106" font-size="13" font-style="italic">ℓ</text><text x="132" y="92" font-size="13" font-style="italic">w</text><text x="88" y="60" font-size="13" font-style="italic">h</text></svg>
        <div class="rf-f"><i>V</i> = <span class="fstack" style="font-size:.72em;vertical-align:-4px;"><span>1</span><span class="fbar"></span><span>3</span></span><i>ℓwh</i></div>
      </div>
    </div>
    <div class="ref-facts">
      The number of degrees of arc in a circle is 360.<br>
      The number of radians of arc in a circle is 2π.<br>
      The sum of the measures in degrees of the angles of a triangle is 180.
    </div>`;

  function toggleRef(){ el("refPanel").classList.contains("hidden") ? openRef() : closeRef(); }
  function openRef(){
    if(!el("refBody").innerHTML.trim()) el("refBody").innerHTML = REF_HTML;
    show("refPanel");
  }
  function closeRef(){ hide("refPanel"); }
  el("refClose").addEventListener("click", closeRef);
  el("refExpand").addEventListener("click", ()=> el("refPanel").classList.toggle("expanded"));

  /* ---- Figure zoom / expand ---- */
  function attachFigureHandlers(q){
    if(!q.figure) return;
    let pct = 100;
    const img = el("figImg");
    const apply = ()=>{ img.style.width = pct + "%"; el("figPct").textContent = pct + "%"; };
    el("figZin").addEventListener("click", ()=>{ pct = Math.min(300, pct + 25); apply(); });
    el("figZout").addEventListener("click", ()=>{ pct = Math.max(50, pct - 25); apply(); });
    el("figReset").addEventListener("click", ()=>{ pct = 100; apply(); });
    el("figExpand").addEventListener("click", ()=>{
      el("figOverlayImg").src = q.figure;
      show("figOverlay");
    });
  }
  el("figOverlayClose").addEventListener("click", ()=> hide("figOverlay"));
  el("figOverlay").addEventListener("click", e=>{ if(e.target.id === "figOverlay") hide("figOverlay"); });

  /* ---- SPR helpers ---- */
  function sanitizeSpr(v){
    v = String(v).replace(/[^0-9./-]/g, "");
    v = v.charAt(0) + v.slice(1).replace(/-/g, "");   // '-' only as leading char
    const max = v.startsWith("-") ? 6 : 5;
    return v.slice(0, max);
  }

  function sprPreviewHtml(v){
    if(!v) return '<span class="ap-val" style="color:#999;">—</span>';
    const m = String(v).match(/^(-?)(\d+)\/(\d+)$/);
    if(m){
      return `<span class="frac">${m[1] ? '<span>−</span>' : ''}<span class="fstack"><span>${m[2]}</span><span class="fbar"></span><span>${m[3]}</span></span></span>`;
    }
    return '<span class="ap-val">' + escapeHtml(v) + '</span>';
  }

  function sprDirectionsHtml(){
    return `
      <div class="spr-dir">
        <h2>Student-produced response directions</h2>
        <ul>
          <li>If you find <b>more than one correct answer</b>, enter only one answer.</li>
          <li>You can enter up to 5 characters for a <b>positive</b> answer and up to 6 characters (including the negative sign) for a <b>negative</b> answer.</li>
          <li>If your answer is a <b>fraction</b> that doesn't fit in the provided space, enter the decimal equivalent.</li>
          <li>If your answer is a <b>decimal</b> that doesn't fit in the provided space, enter it by truncating or rounding at the fourth digit.</li>
          <li>If your answer is a <b>mixed number</b> (such as 3½), enter it as an improper fraction (7/2) or its decimal equivalent (3.5).</li>
          <li>Don't enter <b>symbols</b> such as a percent sign, comma, or dollar sign.</li>
        </ul>
        <div class="spr-extitle">Examples</div>
        <table class="spr-table">
          <tr><th>Answer</th><th>Acceptable ways to<br>enter answer</th><th>Unacceptable: will<br>NOT receive credit</th></tr>
          <tr><td>3.5</td><td><code>3.5</code><br><code>3.50</code><br><code>7/2</code></td><td><code>31/2</code><br><code>3 1/2</code></td></tr>
          <tr><td><span class="fstack" style="font-size:.85em;"><span>2</span><span class="fbar"></span><span>3</span></span></td><td><code>2/3</code><br><code>.6666</code><br><code>.6667</code><br><code>0.666</code><br><code>0.667</code></td><td><code>0.66</code><br><code>.66</code><br><code>0.67</code><br><code>.67</code></td></tr>
          <tr><td>−<span class="fstack" style="font-size:.85em;"><span>1</span><span class="fbar"></span><span>3</span></span></td><td><code>-1/3</code><br><code>-.3333</code><br><code>-0.333</code></td><td><code>-.33</code><br><code>-0.33</code></td></tr>
        </table>
      </div>`;
  }

  /* ================= HIGHLIGHTING ================= */
  const passagePane = el("paneLeft");
  const hlPopup = el("hlPopup");
  const uMenu = el("uMenu");

  document.addEventListener("mouseup", e=>{
    if(hlPopup.contains(e.target)) return;
    setTimeout(handleSelection, 0);   // let selection settle
  });

  function handleSelection(){
    if(el("screen-test").classList.contains("hidden")) return;
    if(currentModule().section === "Math") return;   // annotation is R&W-only: no toolbar in Math
    const sel = window.getSelection();
    const pt = document.getElementById("passageText");
    if(!pt) { hideHlPopup(); return; }
    if(sel.isCollapsed || sel.rangeCount === 0){ return; }
    const range = sel.getRangeAt(0);
    if(!pt.contains(range.commonAncestorContainer)){ hideHlPopup(); return; }
    if(state.hlMode){
      // highlight mode: releasing the drag highlights instantly, no popup (19-20)
      hideHlPopup();
      const span = document.createElement("span");
      span.className = "hl c-" + state.activeHlColor;
      try{
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }catch(err){ return; }
      sel.removeAllRanges();
      savePassage();
      return;
    }
    state.savedRange = range.cloneRange();
    state.hlTarget = null;
    positionHlPopup(range.getBoundingClientRect());
  }

  passagePane.addEventListener("click", e=>{
    const span = e.target.closest(".hl");
    if(!span) return;
    const sel = window.getSelection();
    if(sel && !sel.isCollapsed) return;  // selection handler takes precedence
    state.hlTarget = span;
    state.savedRange = null;
    positionHlPopup(span.getBoundingClientRect());
    e.stopPropagation();
  });

  function setUMenu(open){
    uMenu.classList.toggle("hidden", !open);
    el("hlUBtn").classList.toggle("open", open);
  }

  function positionHlPopup(rect){
    const bodyRect = el("tBody").getBoundingClientRect();
    hlPopup.classList.remove("hidden");
    setUMenu(false);
    // notes are Reading & Writing only (spec Phase B) — Math never shows the button
    const isRW = currentModule().section === "Reading and Writing";
    el("hlNote").classList.toggle("hidden", !isRW);
    el("hlNoteSep").classList.toggle("hidden", !isRW);
    updateActiveDot();
    const top = Math.max(6, rect.top - bodyRect.top - 64);
    let left = rect.left - bodyRect.left;
    left = Math.max(8, Math.min(left, bodyRect.width - hlPopup.offsetWidth - 8));
    hlPopup.style.top = top + "px";
    hlPopup.style.left = left + "px";
  }

  function hideHlPopup(){
    hlPopup.classList.add("hidden");
    setUMenu(false);
    state.hlTarget = null;
    state.savedRange = null;
  }

  document.addEventListener("mousedown", e=>{
    if(!hlPopup.classList.contains("hidden") &&
       !hlPopup.contains(e.target) &&
       !e.target.closest(".hl")){
      hideHlPopup();
    }
  });

  function getOrCreateTargetSpan(){
    if(state.hlTarget) return state.hlTarget;
    if(!state.savedRange) return null;
    const span = document.createElement("span");
    span.className = "hl c-none";
    try{
      span.appendChild(state.savedRange.extractContents());
      state.savedRange.insertNode(span);
    }catch(err){ return null; }
    window.getSelection().removeAllRanges();
    return span;
  }

  function savePassage(){
    const pt = document.getElementById("passageText");
    if(!pt) return;
    const q = currentQuestion();
    currentModState().passageHtml[q.id] = pt.innerHTML;
  }

  function updateActiveDot(){
    hlPopup.querySelectorAll(".hl-dot").forEach(d =>
      d.classList.toggle("active", d.dataset.color === state.activeHlColor));
  }

  hlPopup.querySelectorAll(".hl-dot").forEach(dot=>{
    dot.addEventListener("click", ()=>{
      const span = getOrCreateTargetSpan();
      if(!span) return hideHlPopup();
      span.classList.remove("c-yellow","c-blue","c-pink","c-none");
      span.classList.add("c-" + dot.dataset.color);
      state.activeHlColor = dot.dataset.color;   // becomes the last-used swatch
      updateActiveDot();
      state.hlTarget = span; state.savedRange = null;
      savePassage();
    });
  });

  el("hlUBtn").addEventListener("click", e=>{
    if(e.target.closest(".u-menu")) return;
    setUMenu(uMenu.classList.contains("hidden"));
  });
  uMenu.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const span = getOrCreateTargetSpan();
      if(!span) return hideHlPopup();
      span.classList.remove("u-solid","u-dashed","u-dotted");
      if(btn.dataset.u !== "none"){
        span.classList.add("u-" + btn.dataset.u);
        // an underline is never bare — pair it with the active swatch color
        // (RW questions use underlining as content; screenshot 16)
        if(!/\bc-(yellow|blue|pink)\b/.test(span.className)){
          span.classList.remove("c-none");
          span.classList.add("c-" + state.activeHlColor);
        }
      }
      state.hlTarget = span; state.savedRange = null;
      setUMenu(false);
      savePassage();
    });
  });

  el("hlTrash").addEventListener("click", ()=>{
    const span = state.hlTarget;
    if(span){
      if(span.dataset.noteId) removeNoteRecord(span.dataset.noteId);   // don't orphan the note
      const parent = span.parentNode;
      while(span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
      savePassage();
      renderNotesRail();
    }
    hideHlPopup();
  });

  /* ================= NOTES (Phase B — screenshots 6, 13, 14) ================= */
  el("hlNote").addEventListener("click", ()=>{
    const span = getOrCreateTargetSpan();
    if(!span) return hideHlPopup();
    const q = currentQuestion();
    const ms = currentModState();
    if(!ms.notes) ms.notes = {};
    if(!ms.notes[q.id]) ms.notes[q.id] = [];
    let id = span.dataset.noteId;
    if(!id){
      id = "n" + (++state.noteSeq);
      span.dataset.noteId = id;
      // a noted span must read as a real highlight underneath, so deleting the
      // note later downgrades to a normal highlight instead of stripping it
      if(!/\bc-(yellow|blue|pink)\b/.test(span.className)){
        span.classList.remove("c-none");
        span.classList.add("c-yellow");
      }
      ms.notes[q.id].push({ id, snippet: (span.textContent || "").trim().slice(0, 80), text: "" });
    }
    state.notesCollapsed = false;
    savePassage();
    hideHlPopup();
    renderNotesRail();
    const ta = document.querySelector('.note-card[data-note="' + id + '"] .note-body-ta');
    if(ta) ta.focus();
  });

  function removeNoteRecord(id){
    const q = currentQuestion();
    const ms = currentModState();
    if(ms.notes && ms.notes[q.id]){
      ms.notes[q.id] = ms.notes[q.id].filter(n => n.id !== id);
    }
  }

  function deleteNote(id){
    removeNoteRecord(id);
    // downgrade the span to a normal highlight — keep the highlight itself
    const span = document.querySelector('#passageText .hl[data-note-id="' + id + '"]');
    if(span) span.removeAttribute("data-note-id");
    savePassage();
    renderNotesRail();
  }

  function renderNotesRail(){
    const rail = el("notesRail");
    const mod = currentModule();
    const q = currentQuestion();
    const ms = currentModState();
    const notes = (ms.notes && ms.notes[q.id]) || [];
    const visible = state.view === "question" &&
                    mod.section === "Reading and Writing" &&
                    !!q.passage && notes.length > 0;
    rail.classList.toggle("hidden", !visible);
    rail.classList.toggle("collapsed", state.notesCollapsed);
    el("tBody").classList.toggle("notes-open", visible && !state.notesCollapsed);
    el("notesChev").title = state.notesCollapsed ? "Expand notes" : "Collapse notes";
    if(!visible){ el("notesCards").innerHTML = ""; return; }

    const trashSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="M19 6l-1 13.5A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5L5 6"/><path d="M10 10.5v6M14 10.5v6"/></svg>';
    el("notesCards").innerHTML = notes.map(n => `
      <div class="note-card" data-note="${n.id}">
        <div class="note-head">
          <span class="note-title">${escapeHtml(n.snippet)}</span>
          <button class="note-trash" title="Delete note">${trashSvg}</button>
        </div>
        <textarea class="note-body-ta" placeholder="Notes are saved automatically.">${escapeHtml(n.text)}</textarea>
      </div>`).join("");

    el("notesCards").querySelectorAll(".note-card").forEach(card => {
      const note = notes.find(n => n.id === card.dataset.note);
      card.querySelector(".note-trash").addEventListener("click", ()=> deleteNote(card.dataset.note));
      card.querySelector(".note-body-ta").addEventListener("input", e => { note.text = e.target.value; });
    });
  }

  el("notesChev").addEventListener("click", ()=>{
    state.notesCollapsed = !state.notesCollapsed;
    renderNotesRail();
  });

  /* ================= DIVIDER DRAG ================= */
  (function(){
    const divider = el("divider");
    let dragging = false;
    divider.addEventListener("pointerdown", e=>{
      dragging = true;
      divider.setPointerCapture(e.pointerId);
    });
    divider.addEventListener("pointermove", e=>{
      if(!dragging) return;
      const bodyRect = el("tBody").getBoundingClientRect();
      let pct = ((e.clientX - bodyRect.left) / bodyRect.width) * 100;
      pct = Math.max(25, Math.min(70, pct));
      el("paneLeft").style.width = pct + "%";
    });
    divider.addEventListener("pointerup", ()=>{ dragging = false; });
  })();

  /* ================= SCORE DETAILS (Phase G §3-§7) ================= */
  const CB_DOMAINS = {
    "Reading and Writing": ["Information and Ideas", "Craft and Structure", "Expression of Ideas", "Standard English Conventions"],
    "Math": ["Algebra", "Advanced Math", "Problem-Solving and Data Analysis", "Geometry and Trigonometry"]
  };
  function mapDomain(section, skill){
    const list = CB_DOMAINS[section] || [];
    if(skill){
      const s = String(skill).toLowerCase();
      for(const d of list){ if(s.indexOf(d.toLowerCase()) !== -1) return d; }
    }
    return "Other";   // unmapped/keyless skills; shown only if non-empty (§4)
  }

  /* §3: scaled scores only when the test carries a scoring table; otherwise
     null and the page falls back to raw counts — never invent numbers. */
  function scaledScores(test, rawRw, rawMath){
    const sc = test.scoring;
    if(!sc || !Array.isArray(sc.rw) || !Array.isArray(sc.math)) return null;
    const rw = sc.rw[Math.max(0, Math.min(rawRw, sc.rw.length - 1))];
    const math = sc.math[Math.max(0, Math.min(rawMath, sc.math.length - 1))];
    if(typeof rw !== "number" || typeof math !== "number") return null;
    return { rw, math, total: rw + math, estimated: !!sc.estimated };
  }
  const EST = '<sup class="sd-est" title="Estimated — approximate conversion">Est.</sup>';

  let sdCtx = null;   // { test, record, rows, filter, page, pageSize }

  function buildScoreRows(test, record){
    const ms = buildModuleStateFromRecord(test, record);
    const rows = [];
    const secCount = {};   // per-section running question number
    const tally = { "Reading and Writing": {correct:0, graded:0}, "Math": {correct:0, graded:0} };
    const domains = {};    // section -> domain -> {correct, graded}
    test.modules.forEach(mod => {
      const st = ms[mod.moduleId];
      mod.questions.forEach(q => {
        const noKey = !hasKey(q);
        const given = st.answers.hasOwnProperty(q.id) ? st.answers[q.id] : null;
        const correct = !noKey && given !== null && answerMatches(q, given);
        const domain = mapDomain(mod.section, q.skill);
        secCount[mod.section] = (secCount[mod.section] || 0) + 1;
        if(!noKey && tally[mod.section]){
          tally[mod.section].graded++;
          if(correct) tally[mod.section].correct++;
        }
        if(!noKey){
          const dd = (domains[mod.section] = domains[mod.section] || {});
          const de = (dd[domain] = dd[domain] || {correct:0, graded:0});
          de.graded++; if(correct) de.correct++;
        }
        rows.push({ q, mod, section: mod.section, num: secCount[mod.section],
          given, noKey, correct, domain });
      });
    });
    return { rows, tally, domains };
  }

  function answerLetter(q, val){
    if(val === null || val === undefined) return null;
    return q.type === "spr" ? String(val) : String.fromCharCode(65 + val);
  }
  function correctLabel(q){
    if(!hasKey(q)) return "—";
    return q.type === "spr" ? String(q.correctAnswer) : String.fromCharCode(65 + q.correctAnswer);
  }

  function openScoreDetails(test, record, origin){
    const built = buildScoreRows(test, record);
    sdCtx = { test, record, rows: built.rows, tally: built.tally, domains: built.domains,
      filter: "all", page: 0, pageSize: 10, showCorrect: false, origin: origin || "home" };
    qrShowAnswer = false;   // §5: the popup toggle is sticky per session, fresh per visit
    renderScoreDetails();
    showOnly("screen-scoredetails");
    el("sdRoot").scrollTop = 0;
  }

  function domainBar(correct, graded){
    // segmented performance bar: share of graded answered correctly (§4)
    const segs = 8;
    const filled = graded ? Math.round((correct / graded) * segs) : 0;
    let out = '<div class="sd-bar">';
    for(let i = 0; i < segs; i++) out += `<span class="${i < filled ? "on" : ""}"></span>`;
    return out + "</div>";
  }

  function renderScoreDetails(){
    const { test, record, tally, domains } = sdCtx;
    const rawRw = tally["Reading and Writing"].correct;
    const rawMath = tally["Math"].correct;
    const scaled = scaledScores(test, rawRw, rawMath);
    const badge = timingBadge(record.timing);
    const dateStr = fmtCardDate(record.startedAt);

    // hero
    let hero;
    if(scaled){
      const est = scaled.estimated ? EST : "";
      hero = `
        <div class="sd-hero-total">
          <div class="sd-hero-lbl">TOTAL SCORE</div>
          <div class="sd-hero-num">${scaled.total}${est}</div>
          <div class="sd-hero-range">400–1600</div>
        </div>
        <div class="sd-hero-sections">
          <div><div class="sd-sec-lbl">Reading and Writing</div><div class="sd-sec-range">200–800</div><div class="sd-sec-num">${scaled.rw}${est}</div></div>
          <div><div class="sd-sec-lbl">Math</div><div class="sd-sec-range">200–800</div><div class="sd-sec-num">${scaled.math}${est}</div></div>
        </div>`;
    } else {
      hero = `
        <div class="sd-hero-total">
          <div class="sd-hero-lbl">CORRECT</div>
          <div class="sd-hero-num">${rawRw + rawMath}<span class="sd-hero-of">/ ${tally["Reading and Writing"].graded + tally["Math"].graded}</span></div>
          <div class="sd-hero-range">scaled scores not available for this test</div>
        </div>
        <div class="sd-hero-sections">
          <div><div class="sd-sec-lbl">Reading and Writing</div><div class="sd-sec-num">${rawRw}<span class="sd-hero-of">/ ${tally["Reading and Writing"].graded}</span></div></div>
          <div><div class="sd-sec-lbl">Math</div><div class="sd-sec-num">${rawMath}<span class="sd-hero-of">/ ${tally["Math"].graded}</span></div></div>
        </div>`;
    }

    // knowledge & skills
    let ks = "";
    ["Reading and Writing", "Math"].forEach(section => {
      const dd = domains[section];
      if(!dd) return;
      const order = CB_DOMAINS[section].concat(["Other"]).filter(d => dd[d]);
      if(!order.length) return;
      ks += `<div class="sd-ks-section"><h3>${escapeHtml(section)}</h3><div class="sd-ks-grid">` +
        order.map(d => {
          const e = dd[d];
          return `<div class="sd-ks-item">
            <div class="sd-ks-name">${escapeHtml(d)}</div>
            <div class="sd-ks-count">${e.correct}/${e.graded} correct</div>
            ${domainBar(e.correct, e.graded)}
          </div>`;
        }).join("") + "</div></div>";
    });

    el("sdRoot").innerHTML = `
      <div class="sd-hero">
        <div class="sd-hero-top">
          <div>
            <h1>Score Details</h1>
            <div class="sd-hero-sub">${escapeHtml(test.testName)} · ${escapeHtml(dateStr)}${badge ? ' · <span class="sd-badge">' + escapeHtml(badge) + '</span>' : ""}</div>
          </div>
          <button class="sd-home" id="sdHomeBtn">Return to Home</button>
        </div>
        <div class="sd-hero-body">${hero}</div>
        <div class="sd-hero-actions">
          <button class="pill" id="sdReviewAllBtn">Review All Questions</button>
          <button class="pill ghost" id="sdDownloadBtn">Download Score Report</button>
        </div>
      </div>
      <div class="sd-body">
        <section class="sd-ks">
          <h2>Knowledge and Skills</h2>
          <p class="sd-muted">Your performance across the content domains measured on the SAT.</p>
          ${ks || '<p class="sd-muted">Domain breakdown is not available for this test yet.</p>'}
        </section>
        <section class="sd-questions" id="sdQuestions"></section>
      </div>`;

    el("sdHomeBtn").textContent = sdCtx.origin === "dashboard" ? "Back to Dashboard" : "Return to Home";
    el("sdHomeBtn").addEventListener("click", ()=>{
      if(sdCtx.origin === "dashboard" && window.Dashboard){ Dashboard.open(showOnly); return; }
      renderHome(); showOnly("screen-home");
    });
    el("sdReviewAllBtn").addEventListener("click", ()=>{
      el("sdQuestions").scrollIntoView({ behavior: "smooth" });
    });
    el("sdDownloadBtn").addEventListener("click", ()=> window.print());
    renderQuestionsOverview();
  }

  function renderQuestionsOverview(){
    const { rows, filter, page, pageSize, showCorrect } = sdCtx;
    const filtered = rows.filter(r =>
      filter === "all" ? true :
      filter === "rw" ? r.section === "Reading and Writing" : r.section === "Math");
    const total = filtered.length;
    const size = pageSize === "all" ? total : pageSize;
    const pages = size ? Math.ceil(total / size) : 1;
    const pg = Math.min(page, Math.max(0, pages - 1));
    const start = pg * size;
    const shown = filtered.slice(start, size ? start + size : total);

    const tab = (key, label) => `<button class="sd-tab ${filter===key?"on":""}" data-filter="${key}">${label}</button>`;
    const body = shown.map(r => {
      const yours = answerLetter(r.q, r.given);
      const stateCls = r.noKey ? "nokey" : (r.given === null ? "omit" : (r.correct ? "ok" : "bad"));
      return `<tr>
        <td>${r.num}</td>
        <td>${escapeHtml(r.section === "Reading and Writing" ? "RW" : "Math")}</td>
        <td class="sd-correct-col">${showCorrect ? escapeHtml(correctLabel(r.q)) : '<span class="sd-hidden">•</span>'}</td>
        <td class="sd-${stateCls}">${yours === null ? "Omitted" : escapeHtml(yours)}</td>
        <td><button class="sd-review-link" data-rid="${rows.indexOf(r)}">Review</button></td>
        <td>${escapeHtml(r.domain)}</td>
      </tr>`;
    }).join("");

    el("sdQuestions").innerHTML = `
      <h2>Questions Overview</h2>
      <div class="sd-tabs">${tab("all","All")}${tab("rw","Reading and Writing")}${tab("math","Math")}</div>
      <div class="sd-table-controls">
        <label class="sd-toggle"><input type="checkbox" id="sdShowCorrect" ${showCorrect?"checked":""}> Show Correct Answers</label>
        <div class="sd-view">View
          ${[10,30,"all"].map(v => `<button class="sd-view-btn ${pageSize===v?"on":""}" data-size="${v}">${v==="all"?"All":v}</button>`).join("")}
        </div>
      </div>
      <div class="sd-table-wrap">
        <table class="sd-table">
          <thead><tr><th>Question #</th><th>Section</th><th>Correct Answer</th><th>Your Answer</th><th>Review</th><th>Domain</th></tr></thead>
          <tbody>${body || '<tr><td colspan="6" class="sd-muted">No questions.</td></tr>'}</tbody>
        </table>
      </div>
      ${pages > 1 ? `<div class="sd-pager">
        <button class="sd-page-btn" id="sdPrev" ${pg===0?"disabled":""}>Previous</button>
        <span>Page ${pg+1} of ${pages}</span>
        <button class="sd-page-btn" id="sdNext" ${pg>=pages-1?"disabled":""}>Next</button>
      </div>` : ""}`;

    document.querySelectorAll("#sdQuestions .sd-tab").forEach(b =>
      b.addEventListener("click", ()=>{ sdCtx.filter = b.dataset.filter; sdCtx.page = 0; renderQuestionsOverview(); }));
    el("sdShowCorrect").addEventListener("change", e=>{ sdCtx.showCorrect = e.target.checked; renderQuestionsOverview(); });
    document.querySelectorAll("#sdQuestions .sd-view-btn").forEach(b =>
      b.addEventListener("click", ()=>{ sdCtx.pageSize = b.dataset.size === "all" ? "all" : parseInt(b.dataset.size,10); sdCtx.page = 0; renderQuestionsOverview(); }));
    if(el("sdPrev")) el("sdPrev").addEventListener("click", ()=>{ sdCtx.page = pg - 1; renderQuestionsOverview(); });
    if(el("sdNext")) el("sdNext").addEventListener("click", ()=>{ sdCtx.page = pg + 1; renderQuestionsOverview(); });
    document.querySelectorAll("#sdQuestions .sd-review-link").forEach(b =>
      b.addEventListener("click", ()=> openQuestionReview(filtered, filtered.indexOf(rows[parseInt(b.dataset.rid,10)]))));
  }

  /* ---- Question Review popup (§5) ---- */
  let qrCtx = null;   // { list, idx }  (showAnswer is sticky per popup session)
  let qrShowAnswer = false;

  function qrQuestionHtml(q){
    let html = "";
    if(q.figure){
      html += `<div class="qr-fig"><img src="${escapeHtml(q.figure)}" alt="Question figure">` +
        (q.figureCaption ? `<div class="qr-fig-cap">${fmt(q.figureCaption)}</div>` : "") + `</div>`;
    }
    if(q.passage) html += `<div class="qr-passage">${fmt(q.passage)}</div>`;
    html += `<div class="qr-qtext">${fmt(q.questionText)}</div>`;
    if(q.type !== "spr"){
      html += `<ol class="qr-choices">` +
        q.choices.map((c,i)=> `<li><span class="qr-cl">${String.fromCharCode(65+i)}.</span> ${fmt(c)}</li>`).join("") + `</ol>`;
    }
    return html;
  }

  function qrAnswerHtml(row){
    const q = row.q;
    let banner, cls;
    if(row.noKey){
      cls = "neutral"; banner = "No key yet for this question.";
    } else {
      const correct = correctLabel(q);
      if(row.given === null){ cls = "bad"; banner = `You omitted this question. The correct answer is ${escapeHtml(correct)}.`; }
      else if(row.correct){ cls = "ok"; banner = `You answered ${escapeHtml(answerLetter(q, row.given))}, which is correct.`; }
      else { cls = "bad"; banner = `Your answer is ${escapeHtml(answerLetter(q, row.given))}. The correct answer is ${escapeHtml(correct)}.`; }
    }
    let html = `<h3 class="qr-ans-h">Answer</h3><div class="qr-banner ${cls}">${banner}</div>`;
    if(q.rationale){   // §5: rendered only when present, no empty placeholder
      html += `<h3 class="qr-rat-h">Rationale</h3><div class="qr-rationale">${fmt(q.rationale)}</div>`;
    }
    return html;
  }

  function renderQuestionReview(){
    const row = qrCtx.list[qrCtx.idx];
    const q = row.q;
    el("qrCard").innerHTML = `
      <div class="qr-head">
        <button class="panel-x dark" id="qrClose">✕</button>
        <div class="qr-domain">Knowledge and Skills: ${escapeHtml(row.domain)}</div>
      </div>
      <div class="qr-body">
        <div class="qr-left">
          <div class="qr-qnum">${escapeHtml(row.section)}: Question ${row.num}</div>
          ${qrQuestionHtml(q)}
        </div>
        <div class="qr-right">${qrShowAnswer ? qrAnswerHtml(row) : ""}</div>
      </div>
      <div class="qr-foot">
        <label class="qr-toggle"><input type="checkbox" id="qrShow" ${qrShowAnswer?"checked":""}> Show correct answer and explanation</label>
        <div class="qr-nav">
          <button class="pill ghost" id="qrPrev" ${qrCtx.idx===0?"disabled":""}>Previous</button>
          <button class="pill" id="qrNext" ${qrCtx.idx>=qrCtx.list.length-1?"disabled":""}>Next</button>
        </div>
      </div>`;
    el("qrClose").addEventListener("click", ()=> hide("qrModal"));
    el("qrShow").addEventListener("change", e=>{ qrShowAnswer = e.target.checked; renderQuestionReview(); });
    el("qrPrev").addEventListener("click", ()=>{ if(qrCtx.idx>0){ qrCtx.idx--; renderQuestionReview(); } });
    el("qrNext").addEventListener("click", ()=>{ if(qrCtx.idx<qrCtx.list.length-1){ qrCtx.idx++; renderQuestionReview(); } });
  }

  function openQuestionReview(list, idx){
    qrCtx = { list, idx: Math.max(0, idx) };
    renderQuestionReview();
    show("qrModal");
  }
  el("qrModal").addEventListener("click", e=>{ if(e.target.id === "qrModal") hide("qrModal"); });

  /* ================= GRADING / RESULTS ================= */
  /* Phase D: the student-facing entry point — read-only review of a stored,
     released attempt (reuses the results renderer below). */
  function viewResponses(test, record){
    renderResults({ test, moduleState: buildModuleStateFromRecord(test, record), review: true });
  }

  /* No opts (live mode, post-submit results) is currently unreachable —
     score-visibility (b) routes submits to the confirmation screen — but the
     branch is kept intact so flipping back to instant results stays a
     one-line change in showModuleOver. */
  function renderResults(opts){
    const review = !!(opts && opts.review);
    const test = review ? opts.test : state.currentTest;
    const modStates = review ? opts.moduleState : state.moduleState;
    let totalQ = 0, totalGraded = 0, totalCorrect = 0, totalNoKey = 0;
    const sectionTally = {};
    const allReviewItems = [];

    test.modules.forEach(mod=>{
      const ms = modStates[mod.moduleId];
      if(!sectionTally[mod.section]) sectionTally[mod.section] = {correct:0,total:0};
      mod.questions.forEach(q=>{
        totalQ++;
        const noKey = !hasKey(q);                       // excluded from denominators (v1.2 §4)
        if(noKey) totalNoKey++; else { totalGraded++; sectionTally[mod.section].total++; }
        const given = ms.answers.hasOwnProperty(q.id) ? ms.answers[q.id] : null;
        const isCorrect = !noKey && given !== null && answerMatches(q, given);
        if(isCorrect){ totalCorrect++; sectionTally[mod.section].correct++; }
        allReviewItems.push({ q, mod, given, isCorrect, noKey });
      });
    });

    el("resTitle").textContent = (review ? "Your Responses — " : "Results — ") + test.testName;
    el("resSub").textContent = `${state.userName}, you answered ${totalCorrect} of ${totalGraded} questions correctly.` +
      (totalNoKey ? ` (${totalNoKey} question${totalNoKey===1?"":"s"} not yet graded — no answer key.)` : "");

    el("scoreGrid").innerHTML = `
      <div class="score-card total"><div class="sc-lbl">Overall</div><div class="sc-val">${totalCorrect}/${totalGraded}</div></div>
      ${Object.entries(sectionTally).map(([sec,t])=>`
        <div class="score-card"><div class="sc-lbl">${escapeHtml(sec)}</div><div class="sc-val">${t.correct}/${t.total}</div></div>
      `).join("")}`;

    el("breakdownList").innerHTML = test.modules.map(mod=>{
      const ms = modStates[mod.moduleId];
      let correct = 0, graded = 0;
      mod.questions.forEach(q=>{
        if(!hasKey(q)) return;
        graded++;
        const given = ms.answers.hasOwnProperty(q.id) ? ms.answers[q.id] : null;
        if(given !== null && answerMatches(q, given)) correct++;
      });
      const pct = graded ? Math.round((correct/graded)*100) : 0;
      return `
        <div class="mb-row">
          <span>${escapeHtml(mod.section)} — ${escapeHtml(mod.moduleLabel)}</span>
          <div class="mb-bar"><div class="mb-bar-fill" style="width:${pct}%;"></div></div>
          <span>${correct}/${graded}</span>
        </div>`;
    }).join("");

    el("qReviewList").innerHTML = allReviewItems.map((item,i)=>{
      const status = item.noKey ? "nokey" : (item.given === null ? "skipped" : (item.isCorrect ? "correct" : "wrong"));
      const statusLabel = { nokey:"No key yet", skipped:"Skipped", correct:"Correct", wrong:"Incorrect" }[status];
      let yourAnswerHtml, correctAnswerHtml;
      if(item.q.type === "spr"){
        yourAnswerHtml = item.given === null ? "—" : escapeHtml(String(item.given));
        if(item.noKey){
          correctAnswerHtml = "No key yet";
        } else {
          correctAnswerHtml = escapeHtml(String(item.q.correctAnswer)) +
            ((item.q.altAnswers && item.q.altAnswers.length)
              ? ` <span style="color:#666;">(also accepted: ${item.q.altAnswers.map(a=>escapeHtml(String(a))).join(", ")})</span>` : "");
        }
      } else {
        yourAnswerHtml = item.given === null ? "—"
          : String.fromCharCode(65+item.given) + ". " + fmt(item.q.choices[item.given]);
        correctAnswerHtml = item.noKey ? "No key yet"
          : String.fromCharCode(65+item.q.correctAnswer) + ". " + fmt(item.q.choices[item.q.correctAnswer]);
      }
      return `
        <div class="qreview-item">
          <div class="qri-head">
            <span class="qri-badge ${status}">${statusLabel}</span>
            <span class="qri-skill">${escapeHtml(item.mod.section)} · ${escapeHtml(item.mod.moduleLabel)} · Q${i+1}${item.q.skill ? " · " + escapeHtml(item.q.skill) : ""}</span>
          </div>
          <div class="qri-qtext">${fmt(item.q.questionText)}</div>
          <div style="font-size:13.5px;">
            <div style="margin-bottom:4px;"><b>Your answer:</b> ${yourAnswerHtml}</div>
            <div><b>Correct answer:</b> ${correctAnswerHtml}</div>
          </div>
        </div>`;
    }).join("");

    el("resRestartBtn").onclick = ()=>{ renderHome(); showOnly("screen-home"); };
    el("resDownloadBtn").onclick = ()=> Attempts.downloadJson();
    el("resDownloadBtn").classList.toggle("hidden", review);
    el("resSaveNote").classList.toggle("hidden", review);
    if(!review){
      /* spec §6: the JSON download is the fallback archive when shared storage
         is absent (local copy) or the final write failed. */
      el("resSaveNote").textContent = Attempts.storageWorking()
        ? "Your attempt was recorded automatically."
        : "Automatic recording isn't available in this copy — download your results and send the file to your tutor.";
    }
    showOnly("screen-results");
  }

  /* ================= INIT ================= */
  // §6: dashboard "Open student view" bridges into the Score Details page,
  // regardless of release (admin-only path). Guards a missing/mismatched test.
  window.AppScoreView = {
    open(testId, record){
      const test = state.tests.find(t => t.testId === testId);
      if(!test) return false;
      state.userName = (record.student && record.student.code) || state.userName;
      openScoreDetails(test, record, "dashboard");
      return true;
    }
  };
  showOnly("screen-signin");
})();
