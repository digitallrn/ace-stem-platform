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
      /* visitCount/changeCount are counts read straight off the record and
         reach the dashboard detail pane — same class as the score counts, so
         they carry the payload too. firstGiven differs from given so the
         "changed ×N" branch (which prints changeCount) actually renders. */
      answers[q.id] = { given, firstGiven: given === null ? "X" : null, correct: false, markedForReview: false,
        eliminated: [], timeSpentSeconds: 10, visitCount: PAYLOAD, changeCount: PAYLOAD,
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
      /* counts are record-derived too: a crafted record can put markup where a
         number belongs, and these reach markup without esc() */
      score: { correct: PAYLOAD, graded: 98, noKey: PAYLOAD,
        bySection: { "Reading and Writing": { correct: PAYLOAD, graded: "" },
                     "Math": { correct: PAYLOAD, graded: PAYLOAD } } },
      client: {}
    }, opts || {}) };
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);

  async function run(){
    const results = [];
    clean();
    /* Test content is lazy-loaded per test now, so fetch the first one in the
       manifest through the app's own loader rather than reading a global that
       no longer exists. Poisoning happens on the loaded object, exactly as it
       did on window.TEST_DATA[0]. */
    if(!window.AppTestLoader || !Array.isArray(window.TEST_MANIFEST) || !window.TEST_MANIFEST.length){
      throw new Error("no test manifest/loader — open the app first, then paste this");
    }
    const test = await window.AppTestLoader.load(window.TEST_MANIFEST[0]);

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
    /* a second hostile profile with NO attempts — renders through the
       Students tab's zero-attempts card (profile-only union entry) */
    localStorage.setItem("as:student:AS-PRFLXSS2", JSON.stringify({ displayName: PAYLOAD }));
    /* hostile CODES living in storage KEY NAMES — shared storage lets anyone
       write any key, and the Students-tab union now parses codes out of
       student:<CODE> and assign:<CODE>:<id> keys and renders them as cards */
    localStorage.setItem("as:student:" + PAYLOAD, JSON.stringify({ displayName: "innocent" }));
    localStorage.setItem("as:assign:" + PAYLOAD + ":a1",
      JSON.stringify({ assignmentId: "a1", testId: "x", timing: 1 }));

    $("nameInput").value = "AS-XSSTEST2";
    $("signinBtn").click();
    await wait(900);

    results.push(audit("Home welcome banner (hostile display name)", $("welcomeMsg")));
    results.push(audit("Home user chip + avatar (hostile display name)",
      $("homeUserName").parentElement));
    /* Past cards live in two sections now: proctored sittings under Your
       Tests, everything else under Practice. Switch both toggles and take the
       card from wherever this record landed, so the proof follows the record
       rather than assuming a section. */
    document.querySelector('#practiceSeg .seg-btn[data-seg="past"]').click();
    document.querySelector('#testsSeg .seg-btn[data-seg="past"]').click();
    await wait(200);
    results.push(audit("Past card (testName, total, timing badge)", $("practiceCards")));
    results.push(audit("Your Tests past card (testName, total, timing badge)", $("testCards")));

    const pastLink = document.querySelector("#practiceCards .pcard-link") ||
                     document.querySelector("#testCards .pcard-link");
    if(!pastLink) throw new Error("no Past card rendered — check the section split");
    pastLink.click();
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

    /* Students tab: the profile-only card (union entry with zero attempts)
       shows the hostile display name and a copy-link button */
    document.querySelector('#dashTabs [data-tab="students"]').click();
    await wait(300);
    results.push(audit("Students tab incl. profile-only card (hostile name)", $("dashBody")));
    const pCard = [...document.querySelectorAll("#dashBody .dcard")]
      .find(c => c.textContent.indexOf("AS-PRFLXSS2") !== -1);
    results.push({ surface: "Profile-only card renders with copy-link intact",
      pass: !!pCard && !!pCard.querySelector('.copy-link[data-code="AS-PRFLXSS2"]') &&
            pCard.textContent.indexOf("0 attempt") !== -1,
      note: pCard ? "zero-attempts card present, link button targets the code" : "card missing" });
    /* hostile key-name codes: rendered inert by the dashBody audit above, and
       an invalid code must never get a sign-in-link button */
    const hostileLinks = [...document.querySelectorAll("#dashBody .copy-link")]
      .filter(b => !window.StudentCode.valid(b.dataset.code));
    results.push({ surface: "No sign-in link for non-code card keys",
      pass: hostileLinks.length === 0,
      note: hostileLinks.length ? hostileLinks.length + " link(s) on invalid codes"
                                : "copy-link only appears on valid AS- codes" });

    /* v1.2 addendum tokens: {{bullets}}/{{item}}, {{quote}}, {{credit}}.
       Test data is untrusted on the same terms as a record (contract rule 1),
       and these tokens add three new paths from data into markup, so each is
       driven with the payload as its content. fmt() is escape-first, so the
       assertion is that the payload survives as visible TEXT inside the new
       wrapper, never as an element. */
    const tokenCases = [
      ["{{bullets}}", "Notes:{{bullets}}" + PAYLOAD + "{{item}}second{{/bullets}}", "ul.fmt-bullets li"],
      ["{{quote}}",   "{{quote}}" + PAYLOAD + "{{/quote}}",   "div.fmt-quote"],
      ["{{credit}}",  "{{credit}}" + PAYLOAD + "{{/credit}}", "div.fmt-credit"],
      ["{{tnote}}",   "{{tnote}}" + PAYLOAD + "{{/tnote}}",   "div.fmt-tnote"],
      // display-style inline math is a second render path through KaTeX
      ["bigInline math", "{{m}}\\frac{1}{2}{{/m}} " + PAYLOAD, "span.katex"],
      ["nested in bullets", "{{bullets}}{{i}}" + PAYLOAD + "{{/i}}{{item}}x{{/bullets}}", "ul.fmt-bullets li i"]
    ];
    const tokenProbe = document.createElement("div");
    document.body.appendChild(tokenProbe);
    const tokenBad = [];
    tokenCases.forEach(([label, src, sel]) => {
      tokenProbe.innerHTML = fmt(src) + fmt(src, {bigInline:true});
      /* The wrapper must render, and the payload must survive as inert TEXT
         somewhere in the probe — not necessarily inside the wrapper: in the
         math case the payload sits after the KaTeX span, not within it. */
      const wrapper = tokenProbe.querySelector(sel);
      const inert = !!wrapper && tokenProbe.textContent.indexOf("PWN") !== -1 &&
                    !tokenProbe.querySelector('img[src="x"]') &&
                    ![...tokenProbe.querySelectorAll("*")].some(e => [...e.attributes].some(a => /^on/i.test(a.name)));
      if(!inert) tokenBad.push(label);
    });
    await wait(120);
    results.push({ surface: "fmt() v1.2 tokens escape their content",
      pass: tokenBad.length === 0 && !window.__XSS_FIRED,
      note: tokenBad.length ? "leaked: " + tokenBad.join(", ")
                            : tokenCases.length + " token surfaces render payload as inert text" });
    tokenProbe.remove();

    /* Fill-in blanks: fmt() now rewrites runs of 3+ underscores into markup,
       which puts a substitution AFTER escaping on every text path including
       the no-token fast path. Escaping must still win. */
    const blankProbe = document.createElement("div");
    document.body.appendChild(blankProbe);
    const blankCases = [
      PAYLOAD + " ___",                       // payload beside a blank, fast path
      "___" + PAYLOAD,                        // payload immediately after one
      "{{i}}" + PAYLOAD + "{{/i}} ____",      // and on the tokenized path
      "___<img src=x onerror=window.__XSS_FIRED=true>___"
    ];
    const blankBad = [];
    blankCases.forEach(src => {
      blankProbe.innerHTML = fmt(src);
      const inert = !blankProbe.querySelector('img[src="x"]') &&
                    ![...blankProbe.querySelectorAll("*")].some(e =>
                      [...e.attributes].some(a => /^on/i.test(a.name))) &&
                    !!blankProbe.querySelector("span.fmt-blank");
      if(!inert) blankBad.push(src.slice(0, 24));
    });
    await wait(120);
    results.push({ surface: "fmt() blank substitution stays escape-first",
      pass: blankBad.length === 0 && !window.__XSS_FIRED,
      note: blankBad.length ? "leaked: " + blankBad.join(" | ")
                            : blankCases.length + " payload+blank combinations inert, blank still rendered" });
    /* a blank must be uniform regardless of underscore count — the whole point */
    const widths = ["___", "_____", "____________"].map(u => {
      blankProbe.innerHTML = fmt("x " + u + " y");
      return blankProbe.querySelector("span.fmt-blank").getBoundingClientRect().width;
    });
    results.push({ surface: "Blank width is uniform across underscore counts",
      pass: widths.every(w => Math.abs(w - widths[0]) < 0.5 && w > 0),
      note: "widths: " + widths.map(w => Math.round(w)).join(", ") });
    blankProbe.remove();

    /* Magic-link fragment (…/#AS-XXXXXXXX). The fragment is user-controlled
       input that reaches sign-in, so it is a genuine untrusted surface. The
       gate is AppMagicLink.parse: anything that is not a well-formed code must
       be rejected outright and never reach sign-in or the DOM. (Boot also
       strips the fragment from the address bar; that needs a real page load,
       so it is verified by navigation rather than here.) */
    if(window.AppMagicLink){
      const hostileFragments = [
        '#' + PAYLOAD,
        '#AS-7K4M9PXR"><img src=x onerror="window.__XSS_FIRED=true">',
        "#AS-7K4M9PXR' or '1'='1",
        '#javascript:alert(1)',
        '#AS-1234',                       // old short code
        '#AS-7K4M9PX0',                   // ambiguous 0
        '#AS-7K4M9PXO',                   // ambiguous O
        '#../../etc/passwd',
        '#%3Cscript%3Ealert(1)%3C/script%3E'
      ];
      const accepted = hostileFragments.filter(f => window.AppMagicLink.parse(f) !== null);
      results.push({ surface: "Magic-link fragment rejects hostile input",
        pass: accepted.length === 0 && !window.__XSS_FIRED,
        note: accepted.length ? "ACCEPTED: " + accepted.join(" | ")
                              : hostileFragments.length + " hostile fragments all rejected" });
      results.push({ surface: "Magic-link fragment still accepts a real code",
        pass: window.AppMagicLink.parse('#AS-7K4M9PXR') === 'AS-7K4M9PXR' &&
              window.AppMagicLink.parse('#as-7k4m9pxr') === 'AS-7K4M9PXR',
        note: "valid codes accepted, lowercase normalised" });
    }

    /* Resume annotations. A highlighted passage is stored AS HTML and put back
       with innerHTML on resume, so it is the one record-derived value that
       cannot be escaped — escaping would destroy every highlight. It is
       sanitized instead. Exercised directly: driving a real resume needs a
       running module, but the sanitizer is the whole gate. */
    if(window.AppSanitize){
      const hostileHtml = [
        PAYLOAD,
        '<script>window.__XSS_FIRED=true<\/script>',
        '<svg onload="window.__XSS_FIRED=true"></svg>',
        '<span class="hl" onmouseover="window.__XSS_FIRED=true">text</span>',
        '<iframe src="javascript:window.__XSS_FIRED=true"></iframe>',
        '<img src=x onerror=window.__XSS_FIRED=true>',
        '<b style="background:url(javascript:alert(1))">x</b>'
      ];
      const probe = document.createElement("div");
      probe.innerHTML = hostileHtml.map(h => window.AppSanitize.html(h)).join("");
      document.body.appendChild(probe);
      await wait(150);                       // let any surviving handler fire
      /* audit() is not the right assertion here: it treats any surviving <b>
         as injection, but preserving <b>/<i> is exactly what a passage
         sanitizer must do. What matters is that nothing can execute or fetch:
         no executable/embedding element, no event handler, no URL attribute. */
      const els = [...probe.querySelectorAll("*")];
      const executable = els.filter(e => /^(SCRIPT|IFRAME|OBJECT|EMBED|IMG|LINK|FORM|INPUT|BUTTON|AUDIO|VIDEO)$/.test(e.tagName));
      const handlers = els.filter(e => [...e.attributes].some(a => /^on/i.test(a.name)));
      const urlAttrs = els.filter(e => [...e.attributes].some(a => /^(src|href|xlink:href|srcdoc|action|formaction|data)$/i.test(a.name)));
      results.push({ surface: "Resume annotations: stored passage HTML sanitized",
        pass: !executable.length && !handlers.length && !urlAttrs.length && !window.__XSS_FIRED,
        note: executable.length || handlers.length || urlAttrs.length
          ? `survived: ${executable.length} executable, ${handlers.length} handler(s), ${urlAttrs.length} url attr(s)`
          : hostileHtml.length + " hostile fragments defused; nothing can execute or fetch" });
      /* the sanitizer must not be so blunt it eats real highlights or math —
         a restored passage silently losing them is the failure mode that
         would go unnoticed */
      const keep = document.createElement("div");
      keep.innerHTML = window.AppSanitize.html(
        '<span class="hl" data-note-id="n1">kept</span> <span class="katex"><span class="mord">x</span></span>');
      results.push({ surface: "Sanitizer preserves highlights and KaTeX markup",
        pass: !!keep.querySelector('span.hl[data-note-id="n1"]') && !!keep.querySelector("span.katex .mord") &&
              keep.textContent.indexOf("kept") !== -1,
        note: "highlight span, data-note-id and KaTeX spans survive" });
      probe.remove();
    }

    /* The crash checkpoint is a resume surface on the same footing as the
       Save-and-Exit blob: it is written into the attempt record, read back at
       boot, and its annotations reach innerHTML. Same gate, same assertions —
       a hostile checkpoint must not execute. */
    if(window.AppSanitize){
      const cpProbe = document.createElement("div");
      document.body.appendChild(cpProbe);
      const hostileCheckpoint = {
        moduleIndex: 0, questionIndex: 0, timeRemainingSeconds: 100,
        annotations: { "m1": {
          passageHtml: { "q1": PAYLOAD + '<img src=x onerror=window.__XSS_FIRED=true>' },
          notes: { "q1": [{ id: ATTR_PAY, snippet: PAYLOAD, text: PAYLOAD }] }
        } }
      };
      const ann = hostileCheckpoint.annotations.m1;
      cpProbe.innerHTML = window.AppSanitize.html(ann.passageHtml.q1);
      const note = ann.notes.q1[0];
      cpProbe.innerHTML += `<div class="note-card" data-note="${escapeHtml(note.id)}">` +
        `<span>${escapeHtml(note.snippet)}</span><textarea>${escapeHtml(note.text)}</textarea></div>`;
      await wait(140);
      const els = [...cpProbe.querySelectorAll("*")];
      const exec = els.filter(e => /^(SCRIPT|IFRAME|OBJECT|EMBED|IMG|LINK|FORM|INPUT|BUTTON)$/.test(e.tagName));
      const handlers = els.filter(e => [...e.attributes].some(a => /^on/i.test(a.name)));
      const card = cpProbe.querySelector(".note-card");
      results.push({ surface: "Crash checkpoint annotations are inert on restore",
        pass: !exec.length && !handlers.length && !window.__XSS_FIRED &&
              !!card && card.dataset.note === ATTR_PAY,
        note: exec.length || handlers.length
          ? `survived: ${exec.length} executable, ${handlers.length} handler(s)`
          : "hostile passageHtml sanitized, hostile note id/snippet/text inert" });
      cpProbe.remove();
    }

    /* note ids come back from the same resume blob and land in an ATTRIBUTE */
    const nprobe = document.createElement("div");
    nprobe.innerHTML = `<div class="note-card" data-note="${escapeHtml(ATTR_PAY)}"></div>`;
    const ncard = nprobe.querySelector(".note-card");
    results.push({ surface: "Resume note id inert in attribute context",
      pass: !ncard.hasAttribute("onfocus") && ncard.dataset.note === ATTR_PAY,
      note: "hostile note id stays a data value, round-trips for lookup" });

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

  /* run() is async, so a throw inside it becomes a rejected promise. Pasted
     into a console that shows no output, that is indistinguishable from "the
     proof printed nothing because I did not look" — a check whose failure mode
     is silence. Make it always say something. */
  return run().catch(e => {
    console.error("PROOF DID NOT COMPLETE — no surface was verified: " +
      ((e && (e.stack || e.message)) || e));
    throw e;
  });
})();
