(function(){
  "use strict";

  /* ================= STATE ================= */
  const state = {
    tests: (window.TEST_DATA || []),
    userName: "Student",
    conditions: "unknown",       // "proctored" | "self-administered" (ATTEMPTS-SPEC §10)
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
    savedRange: null
  };

  function el(id){ return document.getElementById(id); }
  function show(id){ el(id).classList.remove("hidden"); }
  function hide(id){ el(id).classList.add("hidden"); }
  const SCREENS = ["screen-signin","screen-home","screen-loading","screen-ready","screen-moduleover","screen-break","screen-test","screen-results","screen-dashboard"];
  function showOnly(id){ SCREENS.forEach(s => s===id ? show(s) : hide(s)); }
  function firstName(n){ return n.trim().split(/\s+/)[0] || "Student"; }

  /* ================= SIGN IN / HOME ================= */
  el("signinBtn").addEventListener("click", doSignin);
  el("nameInput").addEventListener("keydown", e => { if(e.key === "Enter") doSignin(); });
  document.querySelectorAll("#condToggle button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#condToggle button").forEach(b => b.classList.toggle("on", b === btn));
      state.conditions = btn.dataset.cond;
    });
  });
  function doSignin(){
    const v = el("nameInput").value.trim();
    if(!v){ el("nameInput").focus(); return; }
    if(v.toLowerCase() === "acestem-admin"){        // tutor dashboard — never records (spec §4)
      el("nameInput").value = "";
      if(window.Dashboard) Dashboard.open(showOnly);
      return;
    }
    state.userName = v;
    el("homeUserName").textContent = state.userName;
    el("homeAvatar").textContent = state.userName.charAt(0).toUpperCase();
    el("welcomeMsg").textContent = "Welcome, " + firstName(state.userName) + ". Good luck on test day!";
    el("tfName").textContent = state.userName;
    renderHome();
    showOnly("screen-home");
  }

  function renderHome(){
    const wrap = el("practiceCards");
    wrap.innerHTML = "";
    if(!state.tests.length){
      wrap.innerHTML = '<div class="no-tests-card"><h3>No practice tests loaded</h3><p>Add tests to test-data.js following the schema documented at the top of that file.</p></div>';
      return;
    }
    state.tests.forEach(test => {
      const totalQ = test.modules.reduce((s,m)=>s+m.questions.length,0);
      const card = document.createElement("div");
      card.className = "pcard";
      card.innerHTML = `<div class="icn">🖥️</div><h3>Full-Length Practice<br>${escapeHtml(test.testName)}</h3><div class="sub">${test.modules.length} modules · ${totalQ} questions</div>`;
      card.addEventListener("click", ()=>startTestFlow(test));
      wrap.appendChild(card);
    });
  }

  /* ================= FLOW: LOADING → READY → TEST ================= */
  function startTestFlow(test){
    state.currentTest = test;
    state.moduleIndex = 0;
    state.moduleState = {};
    test.modules.forEach(m=>{
      state.moduleState[m.moduleId] = { answers:{}, flags:new Set(), eliminated:{}, passageHtml:{} };
    });
    Attempts.begin(test, state.userName, state.conditions, state);   // spec §3: record on test start
    showOnly("screen-loading");
    setTimeout(()=>{ showReady(true); }, 2200);
  }

  function showReady(isFirst){
    const card = el("readyCard");
    if(isFirst){
      el("readyTitle").textContent = "Practice Test";
      card.innerHTML = `
        <div class="ready-item"><div class="ricon">🕐</div><div><h3>Timing</h3><p>Practice tests are timed, but this is an emulator — leaving the test loses your progress, so finish each module in one sitting. The timer auto-advances you when it runs out.</p></div></div>
        <div class="ready-item"><div class="ricon">📝</div><div><h3>Scores</h3><p>When you finish the practice test, you'll see your scores and a question-by-question review right away.</p></div></div>
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

  function beginModule(idx){
    state.moduleIndex = idx;
    state.questionIndex = 0;
    state.view = "question";
    state.elimMode = false;
    const mod = currentModule();
    state.timeRemainingSec = mod.timeLimitMinutes * 60;
    state.timerHidden = false;
    el("timerBtn").textContent = "Hide";
    showOnly("screen-test");
    renderTest();
    openDirections();
    startTimer();
    Attempts.moduleStart(mod);
  }

  function startTimer(){
    clearInterval(state.timerInterval);
    updateTimerDisplay();
    state.timerInterval = setInterval(()=>{
      state.timeRemainingSec--;
      if(state.timeRemainingSec <= 0){
        state.timeRemainingSec = 0;
        updateTimerDisplay();
        clearInterval(state.timerInterval);
        submitModule("timer-expired");   // real Bluebook auto-advances at 0:00
        return;
      }
      if(state.timeRemainingSec === 300 && state.timerHidden){
        state.timerHidden = false;    // auto-reveal at 5 minutes
        el("timerBtn").textContent = "Hide";
      }
      updateTimerDisplay();
    }, 1000);
  }

  function updateTimerDisplay(){
    const m = Math.floor(state.timeRemainingSec/60);
    const s = state.timeRemainingSec % 60;
    const disp = el("timerDisplay");
    disp.classList.toggle("warn", state.timeRemainingSec <= 300);
    if(state.timerHidden){
      disp.innerHTML = '<span class="clock-ico">⏱</span>';
    } else {
      disp.innerHTML = '<span id="timerVal">' + m + ":" + String(s).padStart(2,"0") + "</span>";
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
    if(state.view === "review"){ renderReviewView(); return; }
    renderQuestionView();
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
        <button class="q-flag ${flagged?"on":""}" id="flagBtn"><span class="bkm">${flagged?"🔖":"⚐"}</span> Mark for Review</button>
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
        cell.insertAdjacentHTML("beforeend", '<span class="cellpin">📍</span>');
      }
      if(ms.flags.has(q.id)){
        cell.insertAdjacentHTML("beforeend", '<span class="cellflag">⚑</span>');
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
  }
  function closeQnav(){ hide("qnavOverlay"); hide("qnavPopup"); }

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
            <span><span class="lg-flag">⚑</span> For Review</span>
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
      showModuleOver(true);
    }
  }

  function showModuleOver(isFinal){
    showOnly("screen-moduleover");
    setTimeout(()=>{
      if(isFinal) renderResults();
      else beginModule(state.moduleIndex);
    }, 2600);
  }

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
  function updateHeaderTools(mod){
    const tools = el("thTools");
    if(mod.section === "Math"){
      tools.innerHTML = `
        <button class="th-tool" id="toolCalc"><span class="ticon">🧮</span>Calculator</button>
        <button class="th-tool" id="toolRef"><span class="ticon" style="font-family:var(--serif);font-style:italic;">x²</span>Reference</button>
        <button class="th-tool"><span class="ticon">⋮</span>More</button>`;
      el("toolCalc").addEventListener("click", toggleCalc);
      el("toolRef").addEventListener("click", toggleRef);
    } else {
      tools.innerHTML = `
        <button class="th-tool" title="Select passage text to highlight"><span class="ticon">✎</span>Highlights &amp; Notes</button>
        <button class="th-tool"><span class="ticon">⋮</span>More</button>`;
    }
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
    const sel = window.getSelection();
    const pt = document.getElementById("passageText");
    if(!pt) { hideHlPopup(); return; }
    if(sel.isCollapsed || sel.rangeCount === 0){ return; }
    const range = sel.getRangeAt(0);
    if(!pt.contains(range.commonAncestorContainer)){ hideHlPopup(); return; }
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

  hlPopup.querySelectorAll(".hl-dot").forEach(dot=>{
    dot.addEventListener("click", ()=>{
      const span = getOrCreateTargetSpan();
      if(!span) return hideHlPopup();
      span.classList.remove("c-yellow","c-blue","c-pink","c-none");
      span.classList.add("c-" + dot.dataset.color);
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
      if(btn.dataset.u !== "none") span.classList.add("u-" + btn.dataset.u);
      state.hlTarget = span; state.savedRange = null;
      setUMenu(false);
      savePassage();
    });
  });

  el("hlTrash").addEventListener("click", ()=>{
    const span = state.hlTarget;
    if(span){
      const parent = span.parentNode;
      while(span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
      savePassage();
    }
    hideHlPopup();
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

  /* ================= GRADING / RESULTS ================= */
  function renderResults(){
    const test = state.currentTest;
    let totalQ = 0, totalGraded = 0, totalCorrect = 0, totalNoKey = 0;
    const sectionTally = {};
    const allReviewItems = [];

    test.modules.forEach(mod=>{
      const ms = state.moduleState[mod.moduleId];
      if(!sectionTally[mod.section]) sectionTally[mod.section] = {correct:0,total:0};
      mod.questions.forEach(q=>{
        totalQ++;
        const noKey = !hasKey(q);                       // excluded from denominators (v1.1 §4)
        if(noKey) totalNoKey++; else { totalGraded++; sectionTally[mod.section].total++; }
        const given = ms.answers.hasOwnProperty(q.id) ? ms.answers[q.id] : null;
        const isCorrect = !noKey && given !== null && answerMatches(q, given);
        if(isCorrect){ totalCorrect++; sectionTally[mod.section].correct++; }
        allReviewItems.push({ q, mod, given, isCorrect, noKey });
      });
    });

    el("resTitle").textContent = "Results — " + test.testName;
    el("resSub").textContent = `${state.userName}, you answered ${totalCorrect} of ${totalGraded} questions correctly.` +
      (totalNoKey ? ` (${totalNoKey} question${totalNoKey===1?"":"s"} not yet graded — no answer key.)` : "");

    el("scoreGrid").innerHTML = `
      <div class="score-card total"><div class="sc-lbl">Overall</div><div class="sc-val">${totalCorrect}/${totalGraded}</div></div>
      ${Object.entries(sectionTally).map(([sec,t])=>`
        <div class="score-card"><div class="sc-lbl">${escapeHtml(sec)}</div><div class="sc-val">${t.correct}/${t.total}</div></div>
      `).join("")}`;

    el("breakdownList").innerHTML = test.modules.map(mod=>{
      const ms = state.moduleState[mod.moduleId];
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
    /* spec §6: the JSON download is the fallback archive when shared storage
       is absent (local copy) or the final write failed. */
    el("resSaveNote").textContent = Attempts.storageWorking()
      ? "Your attempt was recorded automatically."
      : "Automatic recording isn't available in this copy — download your results and send the file to your tutor.";
    showOnly("screen-results");
  }

  /* ================= INIT ================= */
  showOnly("screen-signin");
})();
