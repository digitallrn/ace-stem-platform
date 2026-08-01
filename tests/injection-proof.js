/* tests/injection-proof.js — manual XSS regression proof.
   No test runner is wired up yet (CLAUDE.md), so this is a paste-into-the-
   console script. Run it against dist/index-live.html.

   WHY THIS EXISTS
   Attempt records live in artifact shared storage, which ATTEMPTS-SPEC §7
   states is writable by anyone who can run the artifact. So every value read
   back out of a record — SPR answer strings, student codes, testName — is
   untrusted input, even though sanitizeSpr() limits what a student can type
   through the UI. This script plants a hostile record and walks every render
   surface that displays record-derived data, asserting the payload stays
   inert text.

   HOW TO RUN
   1. Open dist/index-live.html.
   2. Paste this whole file into the console and press Enter.
   3. Read the printed report. Every surface must show PASS.
   Covers record-derived text (SPR answers, codes, testName), test-data text
   (rationale via fmt), and the student:<CODE> display name.
   NOTE: run this with local mode active (no config.js beside the page), since
   it uses the acestem-admin route, which a remote deployment removes.
   4. Reload the page afterwards (the script cleans its own storage keys).   */
(function(){
  "use strict";

  const PAYLOAD  = '"><img src=x onerror="window.__XSS_FIRED=true"><b data-x=\'y\'>PWN</b>';
  const ATTR_PAY = '1" onfocus="window.__ATTR_FIRED=true" x="';   // attribute-context probe
  window.__XSS_FIRED = false;
  window.__ATTR_FIRED = false;

  /* localStorage-backed stand-in for artifact shared storage */
  window.storage = {
    async set(k, v){ localStorage.setItem("as:" + k, v); return true; },
    async get(k){ const v = localStorage.getItem("as:" + k); return v === null ? null : { value: v }; },
    async list(p){
      const ks = [];
      for(let i = 0; i < localStorage.length; i++){
        const k = localStorage.key(i);
        if(k && k.indexOf("as:" + p) === 0) ks.push(k.slice(3));
      }
      return { keys: ks };
    },
    async delete(k){ localStorage.removeItem("as:" + k); return true; }
  };
  const clean = () => Object.keys(localStorage)
    .filter(k => k.indexOf("as:") === 0).forEach(k => localStorage.removeItem(k));

  /* A surface passes when the payload produced no live element and no event
     handler. Seeing the payload as visible TEXT is the desired outcome. */
  function audit(label, root){
    const els = [...root.querySelectorAll("*")];
    const injected = root.querySelectorAll('img[src="x"]').length +
                     els.filter(e => e.tagName === "B" && e.textContent === "PWN").length;
    const handlers = els.filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length;
    const pass = injected === 0 && handlers === 0 && !window.__XSS_FIRED;
    return { surface: label, pass, injectedElements: injected, handlerAttrs: handlers };
  }

  function poisonedRecord(test, opts){
    const answers = {};
    let sprCount = 0;
    test.modules.forEach(m => m.questions.forEach((q, i) => {
      const noKey = (q.correctAnswer === null || q.correctAnswer === undefined);
      let given = null;
      if(!noKey){
        if(q.type === "spr"){ given = PAYLOAD; sprCount++; }      // hostile SPR answer
        else if(i % 4 === 0) given = null;
        else given = q.correctAnswer;
      }
      answers[q.id] = { given, firstGiven: given, correct: false, markedForReview: false,
        eliminated: [], timeSpentSeconds: 10, visitCount: 1, changeCount: 0,
        blankReason: given === null ? "never-answered" : null };
    }));
    return { sprCount, rec: Object.assign({
      recordVersion: 1, attemptId: "attempt:" + test.testId + ":1700000001:xss1",
      student: { code: PAYLOAD, key: "AS-XSSTEST2" },                 // hostile student code
      testId: test.testId, testName: PAYLOAD,                     // hostile test name
      testVersion: test.testVersion, assignmentId: null, timing: 1.5,
      conditions: "proctored", startedAt: "2026-07-30T14:00:00.000Z",
      lastSavedAt: "2026-07-30T15:00:00.000Z", submittedAt: "2026-07-30T15:00:00.000Z",
      status: "completed", released: true, modules: [], answers,
      score: { correct: 0, graded: 98, noKey: 0 }, client: {}
    }, opts || {}) };
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);

  async function run(){
    const results = [];
    clean();
    const test = window.TEST_DATA[0];

    /* future-content fields: rationale goes through fmt(), which must escape
       prose while still honouring {{i}}/{{m}} tokens; an SPR correctAnswer
       comes from test data and reaches the table + banner */
    let firstQ = null, firstSpr = null;
    test.modules.forEach(m => m.questions.forEach(q => {
      if(!firstQ){ firstQ = q; q.rationale = PAYLOAD + " {{i}}italic{{/i}} {{m}}x^2{{/m}}"; }
      if(!firstSpr && q.type === "spr"){ firstSpr = q; q.correctAnswer = PAYLOAD; }
    }));

    const { rec, sprCount } = poisonedRecord(test);
    localStorage.setItem("as:" + rec.attemptId, JSON.stringify(rec));

    /* display-name profile row (student:<CODE>) — a NEW untrusted string that
       reaches the welcome banner, test footer, Score Details hero, printed
       report header and the dashboard. Written by the tutor, but stored in the
       same records table every other value comes from, so it gets the same
       treatment as any record-derived text. */
    localStorage.setItem("as:student:AS-XSSTEST2", JSON.stringify({ displayName: PAYLOAD }));

    $("nameInput").value = "AS-XSSTEST2";
    $("signinBtn").click();
    await wait(900);

    results.push(audit("Home welcome banner (hostile display name)", $("welcomeMsg")));
    results.push(audit("Home user chip + avatar (hostile display name)",
      $("homeUserName").parentElement));
    document.querySelector('#practiceSeg .seg-btn[data-seg="past"]').click();
    results.push(audit("Past card (testName, total, timing badge)", $("practiceCards")));

    document.querySelector("#practiceCards .pcard-link").click();
    await wait(400);
    const root = $("sdRoot");
    $("sdShowCorrect").click();                                   // reveal correct-answer column
    [...root.querySelectorAll(".sd-view-btn")].find(b => b.textContent === "All").click();
    results.push(audit("Score Details hero + Knowledge and Skills", root));
    results.push(audit("Questions Overview table (SPR given + correct)", root));

    /* banner check must run on a poisoned SPR row (student-typed value) */
    const poisonRow = [...root.querySelectorAll(".sd-table tbody tr")]
      .find(tr => tr.textContent.indexOf("PWN") !== -1);
    if(poisonRow){
      poisonRow.querySelector(".sd-review-link").click();
      await wait(250);
      $("qrShow").click();
      await wait(250);
      results.push(audit("Review popup banner (hostile SPR answer)", $("qrCard")));
      $("qrClose").click();
      await wait(150);
    }

    /* rationale check must run on the question that HAS the poisoned
       rationale (firstQ) — the SPR rows above carry none, and their missing
       .qr-rationale is correct spec behaviour, not a failure */
    const firstRow = root.querySelector(".sd-table tbody tr .sd-review-link");
    if(firstRow){
      firstRow.click();
      await wait(250);
      if(!$("qrShow").checked) $("qrShow").click();
      await wait(250);
      const rat = $("qrCard").querySelector(".qr-rationale");
      results.push(audit("Review popup rationale (hostile HTML via fmt)", $("qrCard")));
      results.push({ surface: "fmt() escapes prose but keeps {{i}}/{{m}} tokens",
        pass: !!rat && !rat.querySelector("img") && !!rat.querySelector("i"),
        note: rat ? "rationale rendered; tokens live, payload inert" : "no .qr-rationale found" });
      $("qrClose").click();
      await wait(150);
    }

    /* print output renders this same DOM; the print stylesheet only toggles
       visibility and adds one static ::before, so no new interpolation */
    results.push(audit("Print output (same DOM as Score Details)", root));

    $("nameInput") && ([...document.querySelectorAll('[id^=screen-]')].forEach(s => s.classList.add("hidden")),
      $("screen-signin").classList.remove("hidden"), $("signinError").classList.add("hidden"));
    $("nameInput").value = "acestem-admin";
    $("signinBtn").click();
    await wait(900);
    results.push(audit("Dashboard attempts table (code, timing badge)", $("dashBody")));
    const drow = document.querySelector("#dashBody tbody tr[data-att]");
    if(drow){
      drow.click();
      await wait(300);
      results.push(audit("Dashboard attempt detail", $("dashDetailBody")));
    }

    /* attribute-context regression: escapeHtml must escape quotes, or a
       hostile value planted in value="..." can add its own event handler */
    const probe = document.createElement("div");
    probe.innerHTML = '<input type="text" value="' + escapeHtml(ATTR_PAY) + '">';
    const pin = probe.querySelector("input");
    results.push({ surface: "escapeHtml quote-safety in attribute context",
      pass: !pin.hasAttribute("onfocus") && pin.value === ATTR_PAY,
      note: "old textContent-based escaper planted onfocus here" });

    clean();
    const failed = results.filter(r => !r.pass);
    console.table(results);
    console.log(failed.length ? "FAIL — " + failed.length + " surface(s)" :
      "ALL PASS — " + results.length + " surfaces, " + sprCount + " poisoned SPR answers, payload never fired");
    return { pass: failed.length === 0, results };
  }

  return run();
})();
