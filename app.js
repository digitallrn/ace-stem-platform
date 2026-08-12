(function(){
  "use strict";

  /* ================= STATE ================= */
  const state = {
    /* manifest entries only — {testId, testName, testVersion, moduleCount,
       questionCount, sections, legacyIds}. Questions arrive via loadTest().
       If the manifest script itself failed, this is [] — which is NOT the same
       as "this student has nothing assigned"; see manifestLoaded() below. */
    tests: (window.TEST_MANIFEST || []),
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
    hlHost: null,                // which annotatable region the popup is acting on
    hlGestureUsed: false,        // this drag already became a highlight — see the mousedown reset
    savedRange: null,
    noteSeq: 0,                  // session-unique note id counter (Phase B)
    notesCollapsed: false,       // notes rail collapse preference, survives navigation
    activeHlColor: "yellow",     // last-used swatch — what mode-drag + underline pairing apply
    hlMode: false,               // Highlights & Notes toggle: drag-select highlights instantly
    resumeRecords: {},           // canonical testId -> best resumable record (crash-resume only)
    assignAttempts: {},          // assignmentId -> {completed, resumable} — the home cards read THIS
    assignments: null,           // Phase F: assignment objects; [] once resolved
    activeAssignment: null,      // the assignment the running attempt started through
    pendingStart: null,          // {test, assignment} while the Start Code screen is up
    displayName: null,           // from the student:<CODE> profile row; null = show the code
    timing: 1,                   // Phase G §1: 1 | 1.5 | 2 | "untimed"
    untimed: false,              // current module runs count-up with no auto-submit
    elapsedSec: 0,               // count-up seconds for untimed modules
    fiveMinAlerted: false,       // Phase F §6: five-minute popup shown for this module
    pastAttempts: [],            // completed/timed-out records for this code (Phase D)
    practiceTab: "active",       // home Practice toggle: "active" | "past"
    testsTab: "active",          // home Your Tests toggle: "active" | "past"
    lastWasProctored: false,     // which section the just-finished attempt lands in
    /* Score Details review (read-only replay of a released attempt in the real
       test UI). Null during live testing. When set: { record, rowByQid,
       sdScroll }. Every mutating surface and every Attempts.* call in the test
       flow is gated on this being null — review must never write. */
    reviewMode: null
  };

  function el(id){ return document.getElementById(id); }
  function show(id){ el(id).classList.remove("hidden"); }
  function hide(id){ el(id).classList.add("hidden"); }
  const SCREENS = ["screen-signin","screen-home","screen-startcode","screen-loading","screen-loaderror","screen-ready","screen-moduleover","screen-break","screen-test","screen-submitted","screen-scoredetails","screen-dashboard"];
  // body-level overlays that live outside the SCREENS set — a screen change
  // (e.g. the timer expiring under an open save-fail/bug modal) must not leave
  // them floating as a full-screen click blocker over the next screen
  const FLOATING_OVERLAYS = ["saveFailModal","bugModal","deviceModal"];
  /* The persistent bar belongs to the signed-in non-test screens. In-test
     screens keep their own header, and sign-in has its own branding. */
  const TOPBAR_SCREENS = ["screen-home", "screen-scoredetails"];
  function showOnly(id){
    SCREENS.forEach(s => s===id ? show(s) : hide(s));
    FLOATING_OVERLAYS.forEach(o => hide(o));
    const onScoreDetails = id === "screen-scoredetails";
    el("appTopBar").classList.toggle("hidden", TOPBAR_SCREENS.indexOf(id) === -1);
    /* The wordmark is now static markup: this bar only ever shows on home and
       Score Details, and both carry OUR brand — the simulated app's wordmark
       belongs to the in-test chrome, which has its own header and is
       untouched. (It used to switch per screen, which is why it was set here.)
       The user chip doubles as a way back from Score Details, so it is only
       interactive there; disabled elsewhere keeps it out of the tab order
       rather than offering a control that does nothing on home. */
    el("appTopBar").classList.toggle("on-scoredetails", onScoreDetails);
    const chip = el("userChipBtn");
    chip.disabled = !onScoreDetails;
    chip.title = onScoreDetails ? "Return to home" : "";
  }
  function firstName(n){ return n.trim().split(/\s+/)[0] || "Student"; }

  /* What the student is shown. The profile row is display-only: state.userName
     stays the CODE everywhere that records, keys or syncs anything, so no name
     can reach an attempt record (ATTEMPTS-SPEC §7a). Silently falls back to the
     code when no profile exists. */
  function displayLabel(){ return state.displayName || state.userName; }

  /* ---- device session (stay signed in) ----
     Device-local UI state, not a record, so it lives under its own key rather
     than going through AttemptStore. Storing the code means anyone with the
     unlocked device is signed in — the same exposure as a magic link sitting
     in browser history, and the documented bearer-secret model. Sign out
     clears it; a student's saved work is never touched. */
  const SESSION_KEY = "acestem:code";
  function rememberSession(code){ try{ localStorage.setItem(SESSION_KEY, code); }catch(e){} }
  function forgetSession(){ try{ localStorage.removeItem(SESSION_KEY); }catch(e){} }
  function storedSession(){
    try{
      const c = localStorage.getItem(SESSION_KEY);
      return StudentCode.valid(c || "") ? StudentCode.normalize(c) : null;
    }catch(e){ return null; }
  }

  /* ---- magic link ----
     A code in the URL FRAGMENT (…/#AS-XXXXXXXX). Fragments are never sent to
     the server, so codes stay out of access logs, referrers and CDN records —
     a query string would leak them into all three. The fragment is
     user-controlled input reaching sign-in, so it is validated against the
     strict code pattern and otherwise ignored; it is never echoed into the
     DOM. Exposed for tests. */
  function parseFragmentCode(raw){
    const s = StudentCode.normalize(String(raw || "").replace(/^#/, ""));
    return StudentCode.valid(s) ? s : null;
  }
  /* `seen`/`accepted` record what boot observed, so a link that doesn't work
     can be diagnosed without guessing. The raw value is kept as an inert
     string and is never rendered. */
  window.AppMagicLink = { parse: parseFragmentCode, seen: null, accepted: null };

  /* A highlighted passage is stored AS HTML — the passage element's innerHTML,
     carrying highlight spans and whatever fmt()/KaTeX rendered — and is put
     back with innerHTML on resume. It therefore cannot be escaped on the way
     in: escaping would print the markup as text and destroy every highlight.
     But a resume blob is read out of a record, and records are untrusted
     (ATTEMPTS-SPEC §7), so the fragment is sanitized instead.
     This filters ATTRIBUTES rather than allowlisting tags on purpose: KaTeX
     emits a wide, version-dependent set of elements (spans, svg, path, MathML)
     and a tight tag allowlist would silently drop math from a restored
     passage — the quiet kind of breakage this codebase is most exposed to.
     Execution and fetching live in the attributes, so those are what go. */
  /* IMG is dropped rather than merely defanged: figures render in the QUESTION
     pane (buildQuestionHtml), and fmt() emits no <img> at all, so an image can
     never legitimately appear in a saved passage — one there came from a
     crafted record. */
  /* STYLE is dropped for the same reason SCRIPT is: this filters ATTRIBUTES,
     and a <style> element carries its payload in its TEXT, which no attribute
     check can see. Injected via innerHTML its sheet applies to the WHOLE
     document — enough to fetch an outbound URL through @import (there is no
     CSP) and to restyle the app's own controls, e.g. blowing an invisible
     element up to cover the viewport. fmt() never emits <style>, so one in a
     saved passage came from a crafted record. NOSCRIPT joins it because its
     content is parsed as markup when scripting is disabled. */
  /* PLAINTEXT (and its cousins XMP and LISTING) are dropped because they are
     TOKENIZER switches, not ordinary elements: once the parser meets one, every
     byte after it becomes that element's text and no end tag can close it. It
     therefore survives an attribute filter untouched, and re-inserting it eats
     whatever the app rendered AFTER the restored fragment — the rest of the
     stem, the whole choice list, the question pane. fmt() emits none of them,
     so one in a saved annotation came from a crafted record. */
  /* SMIL animation elements are dropped because they can PUT BACK an attribute
     this filter just removed: <a><animate attributeName="href" values="..."> is
     untouched by DROP_ATTRS (its payload lives in attributeName/values/to, none
     of which are URL attributes), and once the animation starts the anchor
     navigates on the animated value even though getAttribute("href") is still
     null. Planted in choiceHtml the SVG IS the visible choice, so the student's
     ordinary answering click would navigate the sitting away. A is dropped with
     them: nothing this app renders emits an anchor, so one in a saved
     annotation came from a crafted record.
     TITLE/NOEMBED/NOFRAMES are RCDATA — the HTML serializer does not escape
     their text, so a payload parked inside one comes back out as live markup on
     the next parse. FOREIGNOBJECT switches back to HTML parsing inside SVG and
     is the usual lever for that round-trip confusion.
     Verified against the whole shipped library before denying them: fmt() over
     every passage, stem, choice and rationale in all five tests (2542 strings,
     1.16MB of output) emits none of these tags, so no real content is lost. */
  const DROP_ELEMENTS = /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|LINK|META|BASE|FORM|INPUT|TEXTAREA|SELECT|BUTTON|IMG|AUDIO|VIDEO|SOURCE|TRACK|APPLET|FRAME|FRAMESET|PORTAL|PLAINTEXT|XMP|LISTING|A|ANIMATE|ANIMATEMOTION|ANIMATETRANSFORM|SET|TITLE|NOEMBED|NOFRAMES|FOREIGNOBJECT)$/;
  const DROP_ATTRS = /^(src|href|xlink:href|srcdoc|srcset|action|formaction|data|background|ping|dynsrc|lowsrc|id)$/;
  /* CLASS is an ALLOWLIST, and it is deliberately TINY.
     History, because the two wrong versions both looked reasonable:
       - A denylist of 8 structural hooks. It could not see that styles.css
         defined .qnav-overlay{position:fixed;inset:0;z-index:50} unscoped, so
         class="qnav-overlay" alone — no style attribute — rendered a
         full-viewport click-stealing sheet.
       - An allowlist of the KaTeX vocabulary, widened past what was measured
         "so a KaTeX upgrade cannot silently lose a fraction bar". Every
         speculative addition turned out to be a POSITIONING primitive: KaTeX's
         own stylesheet gives .rlap>.inner, .llap>.inner, .clap>.inner,
         .halfarrow-left and .brace-left position:absolute, and .stretchy
         position:relative;display:block;width:100%. So the allowlist handed
         back exactly the capability it was written to remove, and nesting
         absolutely-positioned .inner elements made the offset cap meaningless
         because each one becomes the containing block for the next. The
         sizing trio (sizing / reset-size<n> / size<n>) was just as bad in a
         different way: it is KaTeX's font-size multiplier, up to 4.976x per
         level and compounding, which silently inflates every em-based cap
         below it — a "6em" box the filter scores as 120px rendered 532px.
     The measured answer is much smaller than either. Annotations are
     Reading-and-Writing ONLY (Math is annotation-free on every path), and
     across all six shipped tests fmt() over every RW passage, stem and choice
     — 1944 fields — emits exactly SEVEN class tokens, all fmt-* block
     containers, and ZERO KaTeX classes, because no RW field contains {{m}} or
     {{mm}}. So no KaTeX class has any legitimate reason to appear in a saved
     annotation, and none is allowed. That removes the positioning vocabulary
     and the size multiplier at the root rather than trying to bound them.
     Add the highlighter's own output and the list is complete.
     If a future test bank ever puts math in an RW field, restored math would
     lose its styling. That is a visible degradation, not a hole, and it fails
     LOUDLY: tests/injection-proof.js asserts that fmt() over the whole library
     emits no RW class outside this list. */
  const KEEP_CLASSES = new RegExp("^(?:" + [
    // the highlighter's own output — these MUST survive or annotations vanish
    "hl", "c-(?:yellow|blue|pink|none)", "u-(?:solid|dashed|dotted)",
    // every class fmt() emits in a Reading and Writing field (measured, all 7)
    "fmt-(?:blank|bullets|caption|passage-label|quote|table|tnote)"
  ].join("|") + ")$");

  /* The style ATTRIBUTE is filtered by an ALLOWLIST of properties. It used to
     be three banned substrings (url(, expression(, javascript:) and that lost,
     twice over: `background-image:\000075rl(https://host/p)` and
     `background-image:image-set('https://host/p' 1x)` both walked past the
     `url(` test and Chrome issued the requests; and
     `position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647`
     planted in one choice covered the viewport at 1% opacity, so every click
     anywhere in the sitting bubbled to that choice's handler — answering it,
     and making Next, Back and the other choices unreachable. That is exactly
     the harm cited above as the reason to drop the <style> ELEMENT, and the
     attribute was still doing both. A fourth banned substring would have lost
     to a fifth encoding; enumerating what is allowed cannot.
     Only KaTeX legitimately needs this attribute. Measured across the whole
     shipped library — 3048 rendered fields, 7088 elements carrying a style —
     exactly SEVEN properties ever appear (height, margin-right,
     vertical-align, top, border-bottom-width, padding-left, min-width), every
     value is a plain signed number in em or px, and the largest magnitude
     anywhere is 4.2029. The list below is that set widened to the neighbouring
     lengths KaTeX emits for constructs this library happens not to contain, so
     a KaTeX upgrade cannot silently drop a fraction bar.
     Everything else goes — position, display, z-index, transform, opacity,
     background, pointer-events — and those are what the overlay needed.
     A value must be a BARE LENGTH: no parentheses, no functions, no escapes,
     so url()/image-set()/calc() have nowhere left to hide regardless of
     spelling. What remains is bounded by CAPS, and the first version of those
     caps was wrong in two ways worth recording, because both looked right:
       - It said offsets were "the only lengths that can MOVE a span" and gave
         everything else a loose cap. False. A negative margin-* moves a box in
         normal flow, vertical-align:<length> moves an inline box, and padding-*
         manufactures hit area. `margin-top:-20em;height:18em;width:40em;
         padding-left:40em` on a div in one choice rebuilt the whole overlay out
         of nothing but allowlisted properties: it covered the choices above it
         and every click there recorded the choice it was planted in.
       - The cap compared the bare NUMBER, so it was unit-blind: `top:-10rem`
         passed a cap of 10 and still moved 160px.
     So caps are now per ROLE and measured in PX-EQUIVALENT, with em/rem/ex
     converted at 20px (an upper bound on any font-size here). Observed maxima
     across the library, in px: top 73.6, height 57.7, vertical-align 24.2,
     min-width 14.9, padding-left 14.6, margin-right 4.9, border-width 0.7.
     The caps sit a modest multiple above those — enough that no real KaTeX
     construct is touched, small enough that nothing built from them can travel
     far. `%` is gone from the value grammar: the library uses only em and px,
     and a percentage cannot be bounded without knowing the container. */
  const STYLE_ALLOW = /^(height|width|min-width|max-width|vertical-align|top|left|bottom|right|margin-(top|right|bottom|left)|padding-(top|right|bottom|left)|border-(top|right|bottom|left)-width)$/;
  const STYLE_VALUE = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(em|ex|rem|px|pt)?$/;
  const STYLE_UNIT_PX = { em: 20, rem: 20, ex: 20, pt: 1.34, px: 1 };
  /* px-equivalent caps by role */
  const STYLE_CAPS = [
    [/^(top|left|bottom|right)$/,                    120],  // observed max 73.6
    [/^(height|width|min-width|max-width)$/,         120],  // observed max 57.7
    [/^vertical-align$/,                              50],  // observed max 24.2
    [/^(margin|padding)-(top|right|bottom|left)$/,    30],  // observed max 14.6
    [/^border-(top|right|bottom|left)-width$/,        10]   // observed max 0.7
  ];
  function sanitizeStyle(value){
    const kept = [];
    String(value == null ? "" : value).split(";").forEach(decl => {
      const i = decl.indexOf(":");
      if(i < 0) return;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const val  = decl.slice(i + 1).trim();
      if(!STYLE_ALLOW.test(prop)) return;
      const m = STYLE_VALUE.exec(val);
      if(!m) return;
      const px = Math.abs(parseFloat(m[1])) * (m[2] ? (STYLE_UNIT_PX[m[2]] || 20) : 1);
      const rule = STYLE_CAPS.find(c => c[0].test(prop));
      if(!rule || px > rule[1]) return;
      kept.push(prop + ":" + val);
    });
    return kept.join(";");
  }
  function sanitizeOnce(html){
    // a <template>'s content is inert: parsing here runs no script and fetches
    // nothing, so the payload is defused before it is ever examined
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html == null ? "" : html);
    tpl.content.querySelectorAll("*").forEach(node => {
      if(DROP_ELEMENTS.test(String(node.tagName).toUpperCase())){ node.remove(); return; }
      Array.prototype.slice.call(node.attributes).forEach(at => {
        const n = at.name.toLowerCase();
        if(n.indexOf("on") === 0 || DROP_ATTRS.test(n)){ node.removeAttribute(at.name); return; }
        if(n === "style"){
          const safe = sanitizeStyle(at.value);
          if(safe) node.setAttribute("style", safe); else node.removeAttribute(at.name);
        }
        if(n === "class"){
          const kept = String(at.value).split(/\s+/).filter(c => c && KEEP_CLASSES.test(c));
          if(kept.length) node.setAttribute("class", kept.join(" "));
          else node.removeAttribute("class");
        }
      });
    });
    return tpl.innerHTML;
  }
  /* Sanitize to a FIXED POINT. This filter parses into a <template>, edits, and
     serializes; the caller then assigns that string somewhere else, which parses
     it a SECOND time. Mutation-XSS is the whole family of payloads where that
     second parse yields a different tree than the first — the markup is inert
     in the template and live in the destination. Re-running the filter until
     the string stops changing collapses that gap: a fragment that survives is
     one the parser and serializer already agree on. Benign markup settles on
     the second pass (the first only normalizes, e.g. <animate/> to <animate>),
     so a fragment still changing after several rounds is not content — it is a
     payload that re-writes itself, and it is dropped entirely rather than
     handed on in whatever state the last round left it. */
  const SANITIZE_ROUNDS = 4;
  function sanitizeSavedHtml(html){
    let cur = sanitizeOnce(html);
    for(let i = 1; i < SANITIZE_ROUNDS; i++){
      const next = sanitizeOnce(cur);
      if(next === cur) return cur;
      cur = next;
    }
    return sanitizeOnce(cur) === cur ? cur : "";
  }
  window.AppSanitize = { html: sanitizeSavedHtml };

  /* An annotations blob is record-derived, so its SHAPE is untrusted too, not
     just its strings. Escaping every value is no help if `notes[qid]` is a
     string or holds nulls: renderNotesRail's notes.map(n => n.id) throws, and
     a throw mid-restore is worse on the review path than on resume (resume
     catches it and lands the student home; review had already half-applied
     its state). Coerce to the exact expected shape and drop anything else —
     a malformed blob costs its annotations, never the surface.
     Applied by BOTH consumers, so they cannot drift apart. */
  /* exposed for tests/injection-proof.js — the proof must exercise THIS
     function, not a copy of it */
  function restoreAnnotations(moduleState, ann){
    if(!ann || typeof ann !== "object") return;
    Object.keys(ann).forEach(mid => {
      const ms = moduleState[mid], src = ann[mid];
      if(!ms || !src || typeof src !== "object") return;
      /* passageHtml and stemHtml: {qid: html}. Only string values survive —
         a crafted record can put anything here, and a non-string reaching
         innerHTML is how a restore turns into a crash. */
      ["passageHtml", "stemHtml"].forEach(key => {
        if(src[key] && typeof src[key] === "object"){
          const out = {};
          Object.keys(src[key]).forEach(qid => {
            const h = src[key][qid];
            if(typeof h === "string") out[qid] = h;   // sanitized at every render
          });
          ms[key] = out;
        }
      });
      /* choiceHtml is one level deeper: {qid: {choiceIndex: html}}. The index
         must be a real choice ordinal, so anything non-numeric is dropped
         rather than carried into a lookup. */
      if(src.choiceHtml && typeof src.choiceHtml === "object"){
        const out = {};
        Object.keys(src.choiceHtml).forEach(qid => {
          const perChoice = src.choiceHtml[qid];
          if(!perChoice || typeof perChoice !== "object") return;
          const clean = {};
          Object.keys(perChoice).forEach(idx => {
            const n = parseInt(idx, 10);
            if(isNaN(n) || n < 0) return;
            if(typeof perChoice[idx] === "string") clean[n] = perChoice[idx];
          });
          if(Object.keys(clean).length) out[qid] = clean;
        });
        ms.choiceHtml = out;
      }
      if(src.notes && typeof src.notes === "object"){
        const out = {};
        Object.keys(src.notes).forEach(qid => {
          const list = src.notes[qid];
          if(!Array.isArray(list)) return;
          const clean = list.filter(n => n && typeof n === "object").map(n => ({
            id: String(n.id == null ? "" : n.id),
            snippet: String(n.snippet == null ? "" : n.snippet),
            text: String(n.text == null ? "" : n.text)
          }));
          if(clean.length) out[qid] = clean;
        });
        ms.notes = out;
      }
    });
  }

  window.AppSanitize.restoreAnnotations = restoreAnnotations;

  /* ================= SIGN IN / HOME ================= */
  el("signinBtn").addEventListener("click", doSignin);
  el("nameInput").addEventListener("keydown", e => { if(e.key === "Enter") doSignin(); });
  async function doSignin(){
    const v = el("nameInput").value.trim();
    if(!v){ el("nameInput").focus(); return; }
    /* Tutor route. On remote deployments the magic name is gone entirely
       (Phase H §4) — an email opens real Supabase Auth instead. Local and
       artifact deployments keep acestem-admin, since there is no auth server
       to check against there. */
    if(AttemptStore.isRemote()){
      if(v.indexOf("@") !== -1){
        el("nameInput").value = "";
        el("signinError").classList.add("hidden");
        openTutorAuth(v);
        return;
      }
    } else if(v.toLowerCase() === "acestem-admin"){   // tutor dashboard — never records (spec §4)
      el("nameInput").value = "";
      el("signinError").classList.add("hidden");
      if(window.Dashboard) Dashboard.open(showOnly);
      return;
    }
    // Phase H §4: codes are AS- plus 8 unambiguous characters (they act as a
    // bearer secret on remote deployments, so they need real entropy)
    const code = StudentCode.normalize(v);
    if(!StudentCode.valid(code)){
      el("signinError").textContent = "Enter the code your tutor gave you — it looks like AS-XXXXXXXX.";
      el("signinError").classList.remove("hidden");
      el("nameInput").focus();
      return;
    }
    el("nameInput").value = code;
    await signInWithCode(code);
  }

  /* Shared by all three entry points: typing a code, a magic-link fragment,
     and restoring a saved device session. Returns false when sign-in could
     not complete, leaving the student on the sign-in screen with a reason. */
  async function signInWithCode(code){
    if(!StudentCode.valid(code)) return false;
    el("signinError").classList.add("hidden");
    state.userName = code;
    // display name is a separate profile row, fetched by code; absent is fine
    let prof = null;
    try{ prof = await AttemptStore.getProfile(code); }catch(e){}
    state.displayName = (prof && typeof prof.displayName === "string" && prof.displayName.trim())
      ? prof.displayName.trim() : null;
    const shown = displayLabel();
    el("homeUserName").textContent = shown;
    el("homeAvatar").textContent = shown.charAt(0).toUpperCase();
    el("welcomeMsg").textContent = "Welcome, " + firstName(shown) + ". Good luck on test day!";
    el("tfName").textContent = shown;
    /* A manifest that never loaded leaves state.tests empty, and an empty
       library renders exactly like "nothing assigned" — the conflation
       CLAUDE.md forbids, because it would tell a student with a proctored
       sitting that they have nothing to do. Treat it like the unavailable
       branch below: stop at sign-in with a retry rather than guess. */
    if(!manifestLoaded()){
      el("signinError").textContent = "Couldn't load the test list. Check your connection and try again.";
      el("signinError").classList.remove("hidden");
      showOnly("screen-signin");
      return false;
    }
    // Phase F §2: assignment objects; absent resolves to [] (nothing granted)
    const assigns = await Attempts.assignments(code);
    if(assigns === "unavailable"){
      // a read error must not silently downgrade access (an ungated proctored
      // test) — keep the student at sign-in with a retry rather than guessing
      el("signinError").textContent = "Couldn't reach your assignments. Check your connection and try again.";
      el("signinError").classList.remove("hidden");
      showOnly("screen-signin");
      return false;
    }
    state.assignments = assigns;
    /* Past attempts + the per-assignment index + the crash-resume map, from
       ONE read. buildAssignmentIndex needs state.assignments, so this runs
       after the resolve above. Replaces the old per-test findResumableAnyId
       loop, whose testId-keyed resumeRecords could not tell two assignments
       of one test apart. A FAILED read halts sign-in with a retry (same as an
       unavailable assignment read) — proceeding with an empty index would show
       a completed assignment as startable, the retake hole this whole change
       closes. */
    if(!(await refreshStudentState(code))){
      el("signinError").textContent = "Couldn't reach your test history. Check your connection and try again.";
      el("signinError").classList.remove("hidden");
      showOnly("screen-signin");
      return false;
    }
    state.practiceTab = "active";
    state.testsTab = "active";
    rememberSession(code);            // stay signed in on this device

    /* Crash / refresh resume. A checkpoint with no `resume` blob means the
       student was mid-test and did NOT deliberately leave, so put them back
       where they were rather than making them find the card and click through
       the ready screen again. Save-and-Exit writes `resume` and clears the
       checkpoint, so it still lands on home: leaving on purpose and being
       interrupted are different intents. Expiry gates STARTING, never
       resuming, so there is no start-code re-prompt here either. */
    const interrupted = crashResumeCandidate();
    if(interrupted){
      renderHome();                   // so Back-from-test has a home to return to
      if(resumeTestFlow(interrupted.test, interrupted.record)) return true;
      // a corrupt or unusable checkpoint falls through to the In Progress card
      // rather than dropping the student into a blank test
    }
    renderHome();
    showOnly("screen-home");
    return true;
  }

  /* The record to drop straight back into, or null. Deliberately strict: a
     record whose checkpoint is missing, malformed, or points outside the test
     is not resumable and must fall back to the home card. */
  function crashResumeCandidate(){
    for(const testId of Object.keys(state.resumeRecords || {})){
      const rec = state.resumeRecords[testId];
      if(!rec || rec.resume) continue;            // deliberate exit -> home card
      const cp = rec.checkpoint;
      if(!cp || typeof cp !== "object") continue;
      if(typeof cp.moduleIndex !== "number" || cp.moduleIndex < 0) continue;
      /* `test` is a MANIFEST entry here — the questions are not loaded yet, so
         the range check uses the manifest's module count. Anything deeper
         (does that module have questions?) is the loader's job, and a content
         failure there surfaces as the retry screen rather than a blank test. */
      const test = testById(testId);
      if(!test || cp.moduleIndex >= testModuleCount(test)) continue;
      // a questionIndex past the end is clamped by beginModule, but a
      // non-numeric one means the blob is not trustworthy at all
      if(cp.questionIndex !== undefined &&
         (typeof cp.questionIndex !== "number" || cp.questionIndex < 0)) continue;
      // a negative or non-numeric clock would hand back an unlimited module
      if(cp.timeRemainingSeconds !== undefined &&
         (typeof cp.timeRemainingSeconds !== "number" || cp.timeRemainingSeconds < 0)) continue;
      // testVersion is already matched by findInProgress
      return { test, record: rec };
    }
    return null;
  }

  /* Student sign-out: forgets the device session only. Their recorded work is
     untouched — in local mode it is the only copy. */
  el("homeSignoutBtn").addEventListener("click", ()=>{
    forgetSession();
    state.userName = "Student";
    state.displayName = null;
    state.assignments = null;
    state.pastAttempts = [];
    state.resumeRecords = {};
    el("nameInput").value = "";
    el("signinError").classList.add("hidden");
    showOnly("screen-signin");
  });

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
      const mode = AttemptStore.isLocal() ? "local mode — saves on this device" : "shared storage";
      const wrote = await AttemptStore.set("devicecheck:probe", { t: Date.now() });
      if(wrote) await AttemptStore.remove("devicecheck:probe");
      devMark("storage", wrote, wrote ? mode : mode + " — write failed");
    }
  }

  /* Sync indicator (Phase H §1). Replaces the local-mode pill when a remote
     backend is configured. Purely informational — it never gates anything. */
  function updateSyncTag(){
    const tag = el("syncTag");
    if(!tag) return;
    if(!AttemptStore.isRemote()){ tag.classList.add("hidden"); return; }
    tag.classList.remove("hidden");
    const s = AttemptStore.syncState();
    tag.classList.toggle("offline", !s.online);
    tag.classList.toggle("syncing", s.online && s.pending > 0);
    el("syncTagText").textContent =
      !s.online ? "Offline — will sync" :
      s.pending > 0 ? "Syncing…" : "Synced";
  }
  setInterval(updateSyncTag, 3000);
  if(window.addEventListener){
    window.addEventListener("online", updateSyncTag);
    window.addEventListener("offline", updateSyncTag);
  }

  /* Tutor sign-in (Phase H §4). On a remote deployment the acestem-admin
     magic name is gone: dashboard access needs a real Supabase session. */
  function openTutorAuth(prefillEmail){
    el("tutorEmail").value = prefillEmail || "";
    el("tutorPassword").value = "";
    el("tutorAuthError").classList.add("hidden");
    show("tutorAuthModal");
    el(prefillEmail ? "tutorPassword" : "tutorEmail").focus();
  }
  function closeTutorAuth(){ hide("tutorAuthModal"); }
  el("tutorAuthClose").addEventListener("click", closeTutorAuth);
  el("tutorAuthCancel").addEventListener("click", closeTutorAuth);
  el("tutorPassword").addEventListener("keydown", e=>{ if(e.key === "Enter") el("tutorAuthGo").click(); });
  el("tutorAuthGo").addEventListener("click", async ()=>{
    const email = el("tutorEmail").value.trim();
    const pw = el("tutorPassword").value;
    if(!email || !pw){ el("tutorPassword").focus(); return; }
    el("tutorAuthGo").disabled = true;
    try{
      await AttemptStore.signInTutor(email, pw);
      el("tutorPassword").value = "";           // never keep the password around
      closeTutorAuth();
      if(window.Dashboard) Dashboard.open(showOnly);
    }catch(e){
      el("tutorAuthError").textContent = e.status === 400
        ? "That email and password didn't match."
        : "Couldn't reach the server. Check your connection and try again.";
      el("tutorAuthError").classList.remove("hidden");
    } finally { el("tutorAuthGo").disabled = false; }
  });

  /* Manifest entries, not full tests. Also resolves an id a test used to carry,
     so attempt records and assignments written before a rename still find their
     test instead of silently vanishing from the home screen. */
  function testById(id){
    if(!id) return null;
    return state.tests.find(t => t.testId === id) ||
           state.tests.find(t => (t.legacyIds || []).indexOf(id) !== -1) || null;
  }
  /* every id this test has ever been keyed under — attempt keys embed the id */
  function testIdAliases(entry){
    return entry ? [entry.testId].concat(entry.legacyIds || []) : [];
  }
  /* Did testdata/manifest.js actually execute? An absent global means the
     script failed; an empty array means a genuinely empty library. Both are
     unusable, but neither may be reported as "nothing assigned". */
  function manifestLoaded(){
    return Array.isArray(window.TEST_MANIFEST) && window.TEST_MANIFEST.length > 0;
  }

  /* Legacy-id resolution now lives in buildAssignmentIndex: it enumerates
     every "attempt:" record and canonicalises each via testById (which knows
     legacyIds), so a sitting recorded under a pre-rename prefix still resolves
     to its assignment. The old per-alias findResumableAnyId/findInProgress
     lookup is gone with it. */

  /* Counts work on a manifest entry OR a fully loaded test, so the home screen
     renders identically before and after the questions arrive. */
  function testModuleCount(t){
    return (t && typeof t.moduleCount === "number") ? t.moduleCount
         : (t && t.modules ? t.modules.length : 0);
  }
  function testQuestionCount(t){
    if(t && typeof t.questionCount === "number") return t.questionCount;
    return (t && t.modules) ? t.modules.reduce((s,m)=>s+m.questions.length,0) : 0;
  }
  /* A count read back out of a record is untrusted like any other record value
     (ATTEMPTS-SPEC §7) — coerce, never interpolate raw. Mirrors dashboard.js. */
  function num(v){ return typeof v === "number" && isFinite(v) ? v : null; }
  /* m:ss from a record-derived seconds value. Built on num() rather than on
     bare arithmetic: a hostile value coerced by arithmetic alone yields
     "NaN:NaN", which is inert but reads like a real reading — null lets the
     caller print an em-dash and say nothing it cannot support. Its output is
     digits and a colon, so it is safe to interpolate (contract rule 3:
     numbers computed from a record are fine). Mirrors dashboard.js's mmss,
     which is private to that file's IIFE and loads after this one. */
  function mmss(sec){
    const n = num(sec);
    if(n === null || n < 0) return null;
    return Math.floor(n / 60) + ":" + String(Math.floor(n % 60)).padStart(2, "0");
  }

  /* ================= TEST CONTENT LOADING =================
     Only the manifest loads at startup. A test's questions arrive when a
     sitting starts or resumes, from whichever source can answer first:
       1. already in memory (inlined by assemble.py in the single-file build,
          or loaded earlier this session)
       2. the local cache, keyed by testId AND testVersion — this is what keeps
          a student going when the network drops mid-sitting
       3. the network
     The cache write happens as soon as content is in hand, so from the moment
     a sitting begins the network is never again on the critical path. */
  const TESTCACHE_PREFIX = "acestem:testcache:";
  function cacheKey(entry){ return TESTCACHE_PREFIX + entry.testId + ":" + (entry.testVersion || "unversioned"); }

  function readCachedTest(entry){
    try{
      const raw = localStorage.getItem(cacheKey(entry));
      if(!raw) return null;
      const t = JSON.parse(raw);
      // a cache entry from a superseded version must never be served
      return (t && t.testId && t.modules && (t.testVersion || "unversioned") === (entry.testVersion || "unversioned")) ? t : null;
    }catch(e){ return null; }
  }
  function writeCachedTest(entry, test){
    try{
      // drop other versions of this same test so the cache can't grow forever
      const stale = [];
      for(let i = 0; i < localStorage.length; i++){
        const k = localStorage.key(i);
        if(k && k.indexOf(TESTCACHE_PREFIX + entry.testId + ":") === 0 && k !== cacheKey(entry)) stale.push(k);
      }
      stale.forEach(k => localStorage.removeItem(k));
      /* Serialise ONLY the content fields. Anything another module hangs off
         the shared test object (a lookup index, a memo) must never ride into
         the cache — it is not content, and one such index once inflated this
         by 26x. Belt and braces with the dashboard keeping its index outside. */
      localStorage.setItem(cacheKey(entry), JSON.stringify({
        testId: test.testId, testName: test.testName, testVersion: test.testVersion,
        legacyIds: test.legacyIds, scoring: test.scoring, modules: test.modules
      }));
    }catch(e){ /* quota or private mode: the sitting still works, just online */ }
  }

  /* A dead connection often does not fire onerror — it just hangs. Without a
     deadline the loading screen would sit there forever with no message and no
     way out, which is the exact silent-blank this is supposed to prevent. */
  const TEST_FETCH_TIMEOUT_MS = 20000;
  function fetchTestFile(testId){
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      let done = false;
      const finish = (fn, arg) => {
        if(done) return;
        done = true;
        clearTimeout(timer);
        s.remove();
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, new Error("timed out")), TEST_FETCH_TIMEOUT_MS);
      s.src = "testdata/" + encodeURIComponent(testId) + ".js";
      s.async = true;
      s.onload = () => {
        // look the test up BY THE ID WE ASKED FOR: a file that registers some
        // other id must not be accepted as this one
        const t = (window.__TESTDATA__ || {})[testId];
        t ? finish(resolve, t) : finish(reject, new Error("loaded but registered nothing"));
      };
      s.onerror = () => finish(reject, new Error("network"));
      document.head.appendChild(s);
    });
  }

  /* Resolves to the full test object, or throws. Callers show the retry. */
  async function loadTest(entryOrId){
    const entry = (typeof entryOrId === "string") ? testById(entryOrId) : entryOrId;
    if(!entry) throw new Error("unknown test");
    const inMemory = (window.__TESTDATA__ || {})[entry.testId];
    if(inMemory && (inMemory.testVersion || "unversioned") === (entry.testVersion || "unversioned")){
      writeCachedTest(entry, inMemory);
      return inMemory;
    }
    const cached = readCachedTest(entry);
    if(cached){
      window.__TESTDATA__ = window.__TESTDATA__ || {};
      window.__TESTDATA__[entry.testId] = cached;
      return cached;
    }
    const fetched = await fetchTestFile(entry.testId);
    if((fetched.testVersion || "unversioned") !== (entry.testVersion || "unversioned")){
      /* manifest and content disagree: refuse rather than run a sitting whose
         version cannot be trusted for review-matching later (ATTEMPTS-SPEC §9).
         Flagged as permanent — retrying re-downloads the same mismatched file
         forever, so the UI must not offer Retry as if it were a blip. */
      const e = new Error("version mismatch");
      e.permanent = true;
      throw e;
    }
    writeCachedTest(entry, fetched);
    return fetched;
  }

  // the dashboard needs full content for item analysis; same loader, same cache
  window.AppTestLoader = { load: loadTest, byId: testById };

  /* Shared loading/retry gate. Never leaves a blank screen: on failure the
     student gets a message and a Retry, and can always get back home. */
  const LOADING_DEFAULT_MSG = "This may take up to a minute. Please don't refresh this page or quit the app.";
  async function withTestContent(entry, onReady, origin){
    showOnly("screen-loading");
    el("loadingMsg") && (el("loadingMsg").textContent = "Loading " + (entry ? entry.testName : "test") + "…");
    try{
      const full = await loadTest(entry);
      // restore the standing instruction: this screen is reused by the normal
      // start/resume beat, which must not inherit a stale "Loading X…"
      el("loadingMsg") && (el("loadingMsg").textContent = LOADING_DEFAULT_MSG);
      onReady(full);
    }catch(e){
      el("loadingMsg") && (el("loadingMsg").textContent = LOADING_DEFAULT_MSG);
      showTestLoadError(entry, () => withTestContent(entry, onReady, origin), origin, e);
    }
  }
  /* `origin` decides where the escape hatch goes. A tutor who opened this from
     the dashboard has no student home to return to — sending them to the
     student home screen would strand them in the wrong app. */
  function showTestLoadError(entry, retry, origin, err){
    const name = entry ? entry.testName : "this test";
    const toDashboard = origin === "dashboard";
    const permanent = !!(err && err.permanent);
    el("loadErrTitle").textContent = "Couldn't load " + name;
    el("loadErrBody").textContent = permanent
      // a mismatch re-downloads identically forever; say so instead of
      // blaming the connection and inviting an endless retry
      ? "This test's content doesn't match the version on record, so it can't be opened safely. Retrying won't help — tell your tutor."
      : toDashboard
        ? "The test content didn't download, so the question-by-question view can't be shown. The attempt record itself is fine."
        : "The test content didn't download. Check your connection and try again — nothing you've already done has been lost.";
    el("loadErrRetry").classList.toggle("hidden", permanent);
    el("loadErrRetry").onclick = retry;
    el("loadErrHome").textContent = toDashboard ? "Back to dashboard" : "Back to home";
    el("loadErrHome").onclick = toDashboard
      ? ()=>{ showOnly("screen-dashboard"); }
      : ()=>{ renderHome(); showOnly("screen-home"); };
    showOnly("screen-loaderror");
  }

  /* ================= PER-ASSIGNMENT ATTEMPT STATE =================
     The unit is the ASSIGNMENT, not the test. Two assignments of the same
     test are independent; each attempt belongs to exactly one assignment
     (rec.assignmentId, stamped at Attempts.begin and carried across resume);
     completing one leaves the others untouched. State is DERIVED from the
     attempt records rather than a separately-written flag, because that flag
     (Attempts.completeAssignment) was silently failing — so a completed
     assignment stayed in Active and a re-assignment shared one resume slot.

     Rebuilt from a single read of all the student's attempts whenever the home
     data is refreshed. */
  function attemptCompleted(rec){
    return !!rec && (rec.status === "completed" || rec.status === "timed-out");
  }
  /* A resumable attempt: in-progress with a resume/checkpoint blob, and the
     SAME test build it was recorded under (ids/annotations only line up within
     a version — ATTEMPTS-SPEC §9). */
  function attemptResumable(rec){
    if(!rec || rec.status !== "in-progress" || !(rec.resume || rec.checkpoint)) return false;
    const entry = testById(rec.testId);
    if(!entry) return false;
    return (rec.testVersion || "unversioned") === (entry.testVersion || "unversioned");
  }
  function canonTestId(testId){ const e = testById(testId); return e ? e.testId : testId; }
  const byStartDesc = (a, b) => (b.startedAt || "").localeCompare(a.startedAt || "");
  /* A normalized legacy bare-testId assignment (Attempts.assignments turns each
     old array entry into {assignmentId:"legacy-<testId>",…}). It is a card, but
     it must NOT count toward the sole-assignment ambiguity gate — the dashboard
     skips these too, and counting them made the two views disagree. */
  function isLegacyAssign(a){ return !!a && typeof a.assignmentId === "string" && a.assignmentId.indexOf("legacy-") === 0; }
  /* An untagged attempt may only be attributed to an assignment whose CATEGORY
     matches how the attempt was administered. Pre-model attempts predate the
     start-code ceremony, so they are self-administered; without this check the
     sole-assignment fallback marked a freshly-scheduled PROCTORED sitting
     "completed" from an old practice run and hid it, so the student could never
     take it. category "test" ⇒ proctored; anything else ⇒ self-administered. */
  function categoryMatchesConditions(category, conditions){
    return category === "test" ? conditions === "proctored" : conditions !== "proctored";
  }

  /* Build state.assignAttempts (per assignment) and state.resumeRecords (per
     canonical test, for crash-resume) from every attempt record this student
     has. `all` is the full list, any status. */
  function buildAssignmentIndex(all){
    const byAssignId = {};         // assignmentId -> [records]
    const nullByTest = {};         // canonical testId -> [records with no assignmentId]
    (all || []).forEach(rec => {
      const canon = canonTestId(rec.testId);
      if(rec.assignmentId) (byAssignId[rec.assignmentId] = byAssignId[rec.assignmentId] || []).push(rec);
      else (nullByTest[canon] = nullByTest[canon] || []).push(rec);
    });

    // real (non-legacy) assignments per canonical test — the sole-assignment
    // fallback only fires when exactly one owns the untagged attempt
    const assignCountByTest = {};
    (state.assignments || []).forEach(a => {
      if(isLegacyAssign(a)) return;
      const c = canonTestId(a.testId);
      assignCountByTest[c] = (assignCountByTest[c] || 0) + 1;
    });

    const idx = {};
    (state.assignments || []).forEach(a => {
      const canon = canonTestId(a.testId);
      const explicit = byAssignId[a.assignmentId] || [];
      let completed = explicit.find(attemptCompleted) || null;
      let resumable = explicit.filter(attemptResumable).sort(byStartDesc)[0] || null;
      /* Migration: an attempt with NO assignmentId (recorded before the
         assignment model, or the sole live student's) cannot be tied to a
         specific assignment — attribute it only when the test has exactly ONE
         real assignment AND the attempt was administered the same way (a
         practice run must not consume a proctored assignment). With several
         assignments, only explicit assignmentIds count; every attempt started
         since the model exists carries one. Same care as legacyIds: absent
         references resolve, they don't vanish. */
      if(!completed && !resumable && assignCountByTest[canon] === 1 && !isLegacyAssign(a)){
        const pool = (nullByTest[canon] || []).filter(r => categoryMatchesConditions(a.category, r.conditions));
        completed = pool.find(attemptCompleted) || null;
        resumable = pool.filter(attemptResumable).sort(byStartDesc)[0] || null;
      }
      // completed wins: a resumable record on a done assignment is an orphan,
      // never offered (and never crash-resumed — see below)
      if(completed) resumable = null;
      idx[a.assignmentId] = { completed, resumable };
    });
    state.assignAttempts = idx;

    /* Crash-resume map: best resumable per canonical test, EXCLUDING any record
       whose owning assignment is already completed. Without that exclusion a
       stray checkpoint on a done assignment (a migration shape) would auto-drop
       the student back into a test they finished and produce a second completed
       record — bypassing the retake guard, which only sits on startTestFlow. */
    const resumeRecords = {};
    (all || []).forEach(rec => {
      if(!attemptResumable(rec)) return;
      const canon = canonTestId(rec.testId);
      let ownerCompleted = false;
      if(rec.assignmentId){
        const ix = idx[rec.assignmentId];
        ownerCompleted = !!(ix && ix.completed);
      } else {
        const owners = (state.assignments || []).filter(x => !isLegacyAssign(x) &&
          canonTestId(x.testId) === canon && categoryMatchesConditions(x.category, rec.conditions));
        if(owners.length === 1){ const ix = idx[owners[0].assignmentId]; ownerCompleted = !!(ix && ix.completed); }
      }
      if(ownerCompleted) return;
      if(!resumeRecords[canon] || (rec.startedAt || "") > (resumeRecords[canon].startedAt || "")){
        resumeRecords[canon] = rec;
      }
    });
    state.resumeRecords = resumeRecords;
  }

  /* One refresh for all home data: past attempts + the per-assignment index +
     the crash-resume map, from a single read. Returns false when the read
     FAILED (distinct from empty), so callers can hold the prior state or halt
     rather than wiping a completed assignment back to startable. */
  async function refreshStudentState(code){
    const all = await Attempts.loadForStudent(code);
    if(!Array.isArray(all)) return false;          // "unavailable" — keep prior state
    state.pastAttempts = all
      .filter(r => r.status === "completed" || r.status === "timed-out")
      .sort(byStartDesc);
    buildAssignmentIndex(all);
    return true;
  }

  /* Phase F §2 semantics, derived per assignment. Completion comes from the
     attempt records AND the persisted completedAttemptId hint — either counts,
     so a transient read failure that empties the derived index cannot re-offer
     a finished assignment, and an old completion whose record was archived away
     still reads done. A resumable attempt resumes; then window/expiry gates. */
  function assignmentComplete(a){
    const idx = (state.assignAttempts && state.assignAttempts[a.assignmentId]) || {};
    return !!(idx.completed || a.completedAttemptId);
  }
  function assignmentState(a){
    const idx = (state.assignAttempts && state.assignAttempts[a.assignmentId]) || {};
    if(assignmentComplete(a)) return "completed";
    if(idx.resumable) return "resume";
    if(a.windowOpens && Date.now() < Date.parse(a.windowOpens)) return "notyet";
    if(a.expiresAt && Date.now() > Date.parse(a.expiresAt)) return "expired";
    return "ready";
  }

  /* Phase D home (Active|Past) + Phase F §2 assignments v2: "Your Tests"
     carries category-"test" (proctored, start-code-gated) assignments;
     Practice and Prepare carries practice assignments, or every published
     test when this code has no assign: key at all. */
  function renderHome(){
    // local mode indicator — records stay on this device, nothing is synced
    el("localModeTag").classList.toggle("hidden", !AttemptStore.isLocal());
    updateSyncTag();
    document.querySelectorAll("#practiceSeg .seg-btn").forEach(b =>
      b.classList.toggle("on", b.dataset.seg === state.practiceTab));
    document.querySelectorAll("#testsSeg .seg-btn").forEach(b =>
      b.classList.toggle("on", b.dataset.seg === state.testsTab));
    renderYourTests();
    const wrap = el("practiceCards");
    wrap.innerHTML = "";
    /* Proctored sittings belong to Your Tests, so Past here is everything
       else — the conditions field is what the ceremony stamped (§2). */
    if(state.practiceTab === "past") renderPastCards(wrap, r => r.conditions !== "proctored", "No completed practice yet.");
    else renderActiveCards(wrap);
  }

  function assignmentCard(a){
    const test = testById(a.testId);
    if(!test) return null;                      // assignment for an unpublished test
    const st = assignmentState(a);
    /* A completed assignment leaves Active immediately — its attempt shows in
       Past instead (one Past card per attempt, distinguished by date). This
       is what stops a finished assignment lingering in Active, and — with the
       state now derived from the record rather than the flaky flag — it can
       never again read "Start" and launch a second sitting on a done
       assignment. */
    if(st === "completed") return null;
    const isTest = a.category === "test";
    // counts come from the manifest — the questions are not loaded yet
    const totalQ = testQuestionCount(test);
    const card = document.createElement("div");
    card.className = "pcard" + ((st === "ready" || st === "resume") ? " clickable" : "");
    const status =
      st === "completed" ? '<span class="pc-ico">✓</span> Completed' :
      st === "resume"    ? '<span class="pc-ico">🕐</span> In Progress' :
      st === "notyet"    ? 'Opens ' + fmtCardDate(a.windowOpens) :
      st === "expired"   ? 'Expired' :
      `${testModuleCount(test)} modules · ${totalQ} questions` + (isTest ? ' · proctored' : '');
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
      // resume THIS assignment's own attempt, not whatever the test's shared
      // slot last held — that shared slot is why two assignments used to
      // resume into the same sitting
      const idx = (state.assignAttempts && state.assignAttempts[a.assignmentId]) || {};
      card.addEventListener("click", ()=> resumeTestFlow(test, idx.resumable));
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

  /* Both home sections are always present now (screenshot 29). An empty
     "Your Tests" is informative — it's where a scheduled sitting will appear —
     so it gets a real empty-state card rather than being hidden. We
     deliberately do NOT copy the real app's paper-ticket sentence: that's
     College Board administration logistics and doesn't apply here. */
  function renderYourTests(){
    const wrap = el("testCards");
    wrap.innerHTML = "";
    if(state.testsTab === "past"){
      renderPastCards(wrap, r => r.conditions === "proctored", "No completed tests yet.");
      return;
    }
    const testAssigns = (state.assignments || []).filter(a => a.category === "test");
    // an assignment for an unpublished testId yields no card, so branch on
    // cards that actually render rather than the raw assignment count
    const cards = testAssigns.map(assignmentCard).filter(Boolean);
    if(!cards.length){
      wrap.innerHTML = '<div class="no-tests-card"><h3>You Have No Upcoming Tests</h3>' +
        '<p>Proctored tests appear here when your tutor schedules one.</p></div>';
      return;
    }
    cards.forEach(c => wrap.appendChild(c));
  }

  /* Everything a student sees is tutor-assigned (2026-08-01). There is no
     longer an "no assignments -> every published test" fallback: a code with
     nothing assigned shows the empty state in both sections. state.assignments
     is [] rather than null after any successful resolve; the || [] covers the
     pre-sign-in initial value only. */
  function renderActiveCards(wrap){
    const practice = (state.assignments || []).filter(a => a.category === "practice");
    // branch on renderable cards, not raw count — assignments for unpublished
    // testIds would otherwise skip the empty-state and leave the section blank
    const cards = practice.map(assignmentCard).filter(Boolean);
    if(!cards.length){
      wrap.innerHTML = '<div class="no-tests-card"><h3>No Practice Tests</h3><p>No practice is assigned to this code yet — ask your tutor.</p></div>';
      return;
    }
    cards.forEach(c => wrap.appendChild(c));
  }

  /* Per-module raw correct read STRAIGHT OFF the record, in the shape
     scaledScores wants. The record already carries score.byModule keyed by
     moduleId, so the home card can show a scaled total without re-grading a
     single answer. Returns null if the record predates byModule or is missing
     a module, in which case the caller falls back to the raw line. */
  function storedModuleRaw(test, record){
    const byModule = record && record.score && record.score.byModule;
    if(!byModule) return null;
    const SEC_KEY = { "Reading and Writing": "rw", "Math": "math" };
    const out = { rw: [0, 0], math: [0, 0] };
    const seen = { rw: 0, math: 0 };
    let ok = true;
    test.modules.forEach(mod => {
      const key = SEC_KEY[mod.section];
      if(!key) return;
      const entry = byModule[mod.moduleId];
      const n = entry ? num(entry.correct) : null;
      if(n === null){ ok = false; return; }
      if(seen[key] < 2) out[key][seen[key]] = n;
      seen[key]++;
    });
    return ok ? out : null;
  }

  function fmtCardDate(isoStr){
    if(!isoStr) return "";
    const d = new Date(isoStr);
    return d.toLocaleDateString(undefined, {month:"short", day:"numeric", year:"numeric"});
  }

  function renderPastCards(wrap, keep, emptyLine){
    const list = state.pastAttempts.filter(keep || (()=>true));
    if(!list.length){
      wrap.innerHTML = '<p class="past-empty">' + escapeHtml(emptyLine || "No completed tests yet.") + '</p>';
      return;
    }
    list.forEach(record => {
      const released = record.released === true;
      const test = testById(record.testId);   // resolves legacy ids too
      // reviewing against a different test build would mislabel questions
      // (ATTEMPTS-SPEC §9) — the tutor dashboard remains the archive view
      const canView = released && test &&
        (test.testVersion || "unversioned") === record.testVersion;
      /* §6: released cards show the scaled TOTAL, or a raw fallback.
         The scaled figure needs the questions, which are lazy-loaded — and the
         home screen must not pull a test file just to draw a card. So use the
         full content when it already happens to be in hand (the common case:
         the student just took it, so it is cached), and otherwise fall back to
         the raw correct/graded the record already carries. Opening Score
         Details loads the content and shows the scaled score either way. */
      /* The card reads the RECORD, never a re-grade. It used to branch on
         whether the test content happened to be in memory — recomputing when
         it was, reading the record when it wasn't — so the same card showed
         two different totals in one session (open Score Details, which loads
         the content, press Back, and the number moved), and the inlined
         single-file build disagreed with the lazy-loading site. The scaled
         figure still needs the test for its scoring table, but its INPUTS now
         come from record.score.byModule, so both branches describe the stored
         attempt. Score Details remains the one surface that re-grades. */
      const loadedTest = canView ? (window.__TESTDATA__ || {})[test.testId] : null;
      let scoreLine = "";
      const c = num(record.score && record.score.correct);
      const g = num(record.score && record.score.graded);
      const scaled = (canView && loadedTest) ? scaledScores(loadedTest,
        num(record.score && record.score.bySection &&
            record.score.bySection["Reading and Writing"] &&
            record.score.bySection["Reading and Writing"].correct),
        num(record.score && record.score.bySection && record.score.bySection["Math"] &&
            record.score.bySection["Math"].correct),
        storedModuleRaw(loadedTest, record)) : null;
      if(canView && scaled){
        scoreLine = `<div class="pcard-total">${scaled.total}${scaled.estimated ? EST : ""}<span class="pcard-total-range">400–1600</span></div>`;
      } else if(canView && c !== null && g !== null){
        scoreLine = `<div class="pcard-total">${c}<span class="pcard-total-of">/ ${g} correct</span></div>`;
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

  document.querySelectorAll("#testsSeg .seg-btn").forEach(b =>
    b.addEventListener("click", ()=>{
      state.testsTab = b.dataset.seg;
      renderHome();
    }));

  /* ================= FLOW: LOADING → READY → TEST ================= */
  /* Phase F §2: conditions come from the ceremony, not a toggle — a start
     code means proctored; everything else is self-administered practice. */
  /* Entry points take a MANIFEST entry and fetch the content first. The
     loading screen is already the natural place for the wait, so a lazy fetch
     costs the student nothing they weren't already seeing. */
  function startTestFlow(entry, assignment){
    /* Never start a second sitting on an assignment that already has a
       completed attempt. The card no longer offers it, and startAssignment
       re-checks state, but this is the last gate before a record is written —
       it covers the proctored path (start-code screen -> startTestFlow) and
       any stale click, so the data-integrity guarantee does not depend on the
       UI being fresh. */
    if(assignment && assignmentComplete(assignment)){ renderHome(); showOnly("screen-home"); return; }
    withTestContent(entry, full => startTestFlowLoaded(full, assignment));
  }
  function startTestFlowLoaded(test, assignment){
    state.reviewMode = null;     // a live sitting must never inherit review's read-only gates
    state.currentTest = test;
    state.activeAssignment = assignment || null;
    state.timing = (assignment && assignment.timing) || 1;    // Phase G §1: default standard
    state.moduleIndex = 0;
    state.moduleState = {};
    test.modules.forEach(m=>{
      state.moduleState[m.moduleId] = { answers:{}, flags:new Set(), eliminated:{}, passageHtml:{}, stemHtml:{}, choiceHtml:{}, notes:{} };
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
      mstate[m.moduleId] = { answers:{}, flags:new Set(), eliminated:{}, passageHtml:{}, stemHtml:{}, choiceHtml:{}, notes:{} };
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

  /* Phase C: rebuild the whole sitting — answers/flags/eliminations from the
     record, highlights + notes from the annotations blob, then land on the
     saved module/question with the saved time remaining.
     Restores from the deliberate-exit blob when there is one, otherwise from
     the crash checkpoint — identical restore path either way (answers,
     annotations, flags, timer). Returns false if the record can't be restored,
     so the caller can fall back to the home card instead of a blank test. */
  /* Manifest-entry front door: fetch, then restore. Returns true if a restore
     was STARTED — the loader owns the failure path from here (message + retry),
     so a failed fetch never leaves a blank test. */
  function resumeTestFlow(entry, record){
    if(!entry || !record) return false;
    withTestContent(entry, full => {
      /* Content arrived but the RECORD itself is unrestorable. Nothing else
         acts on that false, so land them home with the In Progress card rather
         than leaving them staring at the loading screen. */
      if(!resumeTestFlowLoaded(full, record)){
        state.currentTest = null;
        renderHome();
        showOnly("screen-home");
      }
    });
    return true;
  }
  function resumeTestFlowLoaded(test, record){
    const resume = record.resume || record.checkpoint || {};
    if(!test || !test.modules || !test.modules.length) return false;
    state.reviewMode = null;     // a live sitting must never inherit review's read-only gates
    state.currentTest = test;
    state.moduleState = buildModuleStateFromRecord(test, record);
    restoreAnnotations(state.moduleState, resume.annotations);
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
    setTimeout(()=>{
      /* beginModule runs after the loading beat, i.e. after this function has
         already returned true. If a malformed blob makes it throw, the student
         would sit on the loading screen forever, so land them home instead —
         the record is still in-progress and its card is still there. */
      try{ beginModule(idx, resume); }
      catch(e){
        state.currentTest = null;
        renderHome();
        showOnly("screen-home");
      }
    }, 1200);
    return true;
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
      /* The "Untimed" label stays in both states. It is an accommodation
         indicator, not the clock, so hiding the time should not hide it — and
         keeping it reserves the line, which is what stops the header changing
         height when the student toggles Hide/Show on an untimed module. */
      disp.innerHTML = (state.untimed ? '<span class="timer-untimed">Untimed</span>' : '') +
        '<span class="clock-ico">⏱</span>';
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
    /* Math directions, per reference 36 — the fuller panel the real app shows:
       the calculator/reference note, the "unless otherwise indicated"
       assumptions, then the per-type instructions. */
    return `<p>The questions in this section address a number of important math skills.</p>
            <p>Use of a calculator is permitted for all questions. A reference sheet, calculator, and these directions can be accessed throughout the test.</p>
            <p>Unless otherwise indicated:</p>
            <ul>
              <li>All variables and expressions represent real numbers.</li>
              <li>Figures provided are drawn to scale.</li>
              <li>All figures lie in a plane.</li>
              <li>The domain of a given function <i>f</i> is the set of all real numbers <i>x</i> for which <i>f</i>(<i>x</i>) is a real number.</li>
            </ul>
            <p>For <b>multiple-choice questions</b>, solve each problem and choose the correct answer from the choices provided. Each multiple-choice question has a single correct answer.</p>
            <p>For <b>student-produced response questions</b>, solve each problem and enter your answer as described below.</p>
            <ul>
              <li>If you find <b>more than one correct answer</b>, enter only one answer.</li>
              <li>You can enter up to 5 characters for a <b>positive</b> answer and up to 6 characters (including the negative sign) for a <b>negative</b> answer.</li>
              <li>If your answer is a <b>fraction</b> that doesn't fit in the provided space, enter the decimal equivalent.</li>
              <li>If your answer is a <b>decimal</b> that doesn't fit in the provided space, enter it by truncating or rounding at the fourth digit.</li>
              <li>If your answer is a <b>mixed number</b> (such as 3½), enter it as an improper fraction (7/2) or its decimal equivalent (3.5).</li>
              <li>Don't enter <b>symbols</b> such as a percent sign, comma, or dollar sign.</li>
            </ul>`;
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

  /* The zoom / reset / expand frame is a component, not a Math feature: an RW
     figure gets the identical chrome (reference 33). Where it sits differs by
     section, and only because the figure means something different — in RW it
     is part of the stimulus, so it belongs above the passage in the left pane;
     in Math it belongs with the question. */
  function figureFrameHtml(q){
    if(!q.figure) return "";
    return `
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
      </div>`;
  }
  function figureGoesLeft(mod, q){
    return !!q.figure && mod.section === "Reading and Writing";
  }

  let lastRenderedQKey = null;   // which question the divider width belongs to
  function renderQuestionView(){
    /* Any rebuild detaches the nodes the highlight popup points at, so dismiss
       it first — otherwise a swatch click would recolour a span that is no
       longer in the document and save that stale markup. */
    hideHlPopup();
    const mod = currentModule();
    const q = currentQuestion();
    const ms = currentModState();

    el("thTitle").textContent = sectionTitle(mod);
    el("tfName").textContent = displayLabel();   // real Bluebook shows the name bottom-left
    updateHeaderTools(mod);

    const isSpr = q.type === "spr";
    /* Math never splits the pane (reference 22/23): whatever a Math question
       carries — a table, a figure, a text set-up, the SPR directions — stacks
       above the stem in the one centred column. Only Reading and Writing puts
       a stimulus beside the question. */
    const isMath = mod.section === "Math";
    // an RW figure opens the stimulus pane even with no passage
    const figLeft = figureGoesLeft(mod, q);
    /* Math splits only for student-produced response, where the left column
       carries the directions document (reference 35). Math multiple-choice
       stays in the single centred column with any stimulus stacked above the
       stem (reference 22/23). A Math SPR that also has a set-up (s2m1 q4)
       keeps the directions on the left and stacks its set-up on the right. */
    const hasLeft = isMath ? isSpr : (!!q.passage || isSpr || figLeft);
    const tBody = el("tBody");
    tBody.classList.toggle("single", !hasLeft);
    tBody.classList.toggle("math", isMath);
    /* Predictable over clever: the divider recentres on every question change,
       including coming back to the one it was dragged on — no per-question
       memory. Keyed on the question, not on the render, because this function
       also re-runs for in-place updates (flagging, crossing out a choice,
       adding a note) where yanking the divider back would be maddening. */
    const qKey = mod.moduleId + "/" + q.id;
    if(lastRenderedQKey !== qKey){
      lastRenderedQKey = qKey;
      el("paneLeft").style.width = "";
    }

    const left = el("paneLeft");
    const right = el("paneRight");

    if(!hasLeft){
      left.innerHTML = "";
    } else if(isMath && isSpr){
      left.innerHTML = sprDirectionsHtml();
    } else if(q.passage || figLeft){
      const saved = ms.passageHtml[q.id];
      left.innerHTML = (figLeft ? figureFrameHtml(q) : "") +
        (q.passage
          ? '<div class="passage-text" id="passageText">' +
            (saved !== undefined ? sanitizeSavedHtml(saved) : fmt(q.passage)) + '</div>'
          : "");
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
    const review = !!state.reviewMode;
    el("tBody").classList.toggle("review-mode", review);
    /* Review navigates ACROSS modules (there is no Check Your Work / submit
       beat to cross), so Back stays visible at question 1 of a later module
       and Next disappears only at the very last question of the test. */
    el("btnBack").classList.toggle("hidden",
      state.questionIndex === 0 && (!review || state.moduleIndex === 0));
    el("btnNext").textContent = "Next";
    el("btnNext").classList.toggle("hidden",
      review && state.moduleIndex === state.currentTest.modules.length - 1 &&
      state.questionIndex === total - 1);
    if(!review) Attempts.questionShown(q.id);   // no-op on re-renders; never records in review
  }

  /* A stem that OPENS with display math or a table is a lead-in: the real app
     sets it apart as its own centred block above the prose, rather than
     letting it sit inside the sentence flow (reference 35). A run of them
     stays one block, which is what keeps a two-line system together.
     Only leading {{mm}}/{{table}} qualify — inline {{m}} opening a sentence
     ("{{m}}f{{/m}} is defined by…") is prose and must not be hoisted. */
  const LEAD_IN_RE = /^(?:\s*(?:\{\{mm\}\}[\s\S]*?\{\{\/mm\}\}|\{\{table\}\}[\s\S]*?\{\{\/table\}\})\s*(?:\{\{br\}\})*)+/;
  /* `saved` is the student's annotated markup for the stem, when they have
     highlighted it. It replaces only the .q-text BODY — a hoisted {{mm}}/
     {{table}} lead-in is re-rendered from the source either way, because the
     lead is not annotatable and its saved copy would otherwise be the only
     record of it. Sanitized here like every other stored-markup path. */
  function stemHtml(questionText, saved){
    const inner = (saved !== undefined && saved !== null) ? sanitizeSavedHtml(saved) : null;
    const qt = String(questionText == null ? "" : questionText);
    const m = LEAD_IN_RE.exec(qt);
    if(!m || !m[0].trim()) return '<div class="q-text">' + (inner !== null ? inner : fmt(qt)) + '</div>';
    const rest = qt.slice(m[0].length);
    if(!rest.trim()) return '<div class="q-text">' + (inner !== null ? inner : fmt(qt)) + '</div>';  // math IS the stem
    return '<div class="q-lead">' + fmt(m[0]) + '</div>' +
           '<div class="q-text">' + (inner !== null ? inner : fmt(rest)) + '</div>';
  }

  function buildQuestionHtml(q, ms){
    const isSpr = q.type === "spr";
    const review = !!state.reviewMode;
    const flagged = ms.flags.has(q.id);
    const abcOn = state.elimMode && !isSpr && !review;

    const mod = currentModule();
    // RW figures render in the stimulus pane instead (reference 33)
    const figHtml = figureGoesLeft(mod, q) ? "" : figureFrameHtml(q);
    /* A Math set-up stacks above the stem, since Math multiple-choice has no
       second pane and Math SPR gives its left column to the directions
       document (reference 35). */
    const isMath = mod.section === "Math";
    const stackedHtml = (isMath && q.passage)
      ? '<div class="q-stimulus"><div class="passage-text" id="passageText">' +
        (ms.passageHtml[q.id] !== undefined
          ? sanitizeSavedHtml(ms.passageHtml[q.id]) : fmt(q.passage)) + '</div></div>'
      : "";

    let body;
    if(isSpr){
      const cur = ms.answers.hasOwnProperty(q.id) ? ms.answers[q.id] : "";
      /* The answer area is ONE block child of the pane so it sits in the same
         capped, centred column as the stem and choices. Loose children did not:
         the input is inline-level, where auto margins cannot centre anything,
         and .ap-label's margin shorthand overrode the auto side margins — so
         both hugged the pane's left padding and appeared to travel with the
         divider while everything else re-centred. The keypad stays OUTSIDE the
         wrapper: it is position:fixed and dragged, and has its own margin rule. */
      /* Review: the input shows the recorded answer read-only, the keypad is
         gone (nothing to type), and the verdict banner below carries the
         correct answer — the SPR analogue of marking the choices. */
      body = `
        <div class="spr-answer">
          <input type="text" class="spr-input" id="sprInput" value="${escapeHtml(cur)}" autocomplete="off" spellcheck="false"${review ? " readonly" : ""}>
          <div class="ap-label">Answer Preview:</div>
          <div id="sprPreview">${sprPreviewHtml(cur)}</div>
          ${review ? sprReviewHtml(q) : '<div><button class="keypad-toggle" id="kpToggle">⌨&nbsp; Show Keypad</button></div>'}
        </div>` + (review ? "" : `
        <div class="keypad hidden" id="keypad">
          <div class="keypad-head" id="keypadHead">Keypad
            <span class="calc-drag" style="margin-left:auto;margin-right:10px;">⠿</span>
            <button class="panel-x" id="kpClose">✕</button>
          </div>
          <div class="kp-grid">${[1,2,3,4,5,6,7,8,9].map(n=>`<button data-k="${n}">${n}</button>`).join("")}</div>
          <div class="kp-row5">
            <button data-k="-">−</button><button data-k=".">.</button><button data-k="0">0</button><button data-k="/">/</button><button data-k="⌫">⌫</button>
          </div>
        </div>`);
    } else {
      const elimSet = ms.eliminated[q.id] || new Set();
      body = '<div class="choices' + (abcOn ? ' elim-mode' : '') + '" id="choicesWrap">' +
        q.choices.map((c,idx)=>{
          const letter = String.fromCharCode(65+idx);
          const sel = ms.answers[q.id] === idx;
          const elim = elimSet.has(idx);
          /* A highlighted choice replays the student's own markup. Sanitized
             on the way in like every stored-markup path — a choice blob is
             record-derived and therefore untrusted (ATTEMPTS-SPEC 7). */
          const savedC = (ms.choiceHtml && ms.choiceHtml[q.id]) ? ms.choiceHtml[q.id][idx] : undefined;
          const ctext = (savedC !== undefined && savedC !== null)
            ? sanitizeSavedHtml(savedC) : fmt(c, {bigInline:true});
          /* Review marks: the key and the student's pick, on the choices
             themselves. A crossed-out choice keeps its strikethrough (that is
             their work), but the cross-out buttons don't render — nothing on
             this surface mutates. `sel` styling is replaced by the marks. */
          if(review){
            const isKey = hasKey(q) && q.correctAnswer === idx;
            const mark = isKey && sel ? '<span class="rv-mark ok">✓ Your answer</span>'
                       : isKey        ? '<span class="rv-mark ok">✓ Correct answer</span>'
                       : sel          ? '<span class="rv-mark you">✕ Your answer</span>'
                       : "";
            return `
              <div class="choice-row${elim ? " is-elim" : ""}">
                <div class="choice rv ${isKey ? "rv-key" : ""} ${sel && !isKey ? "rv-wrong" : ""} ${elim ? "eliminated" : ""}" data-idx="${idx}">
                  <span class="clabel">${letter}</span>
                  <span class="ctext">${ctext}</span>
                  ${mark}
                </div>
              </div>`;
          }
          return `
            <div class="choice-row${elim ? " is-elim" : ""}">
              <div class="choice ${sel?"selected":""} ${elim?"eliminated":""}" data-idx="${idx}">
                <span class="clabel">${letter}</span>
                <span class="ctext">${ctext}</span>
              </div>
              <button class="elim-btn" data-elim="${idx}" title="Cross out choice ${letter}">${letter}</button>
              <button class="elim-undo" data-undo="${idx}">Undo</button>
            </div>`;
        }).join("") + '</div>';
    }

    /* Review-only extras: an omitted-MCQ banner (an unanswered SPR already
       reads as omitted in its verdict), and the rationale below the choices
       when the question carries one. Rationale is test data, so fmt() — it
       may hold tokens and math. */
    const omittedHtml = (review && !isSpr && !ms.answers.hasOwnProperty(q.id))
      ? '<div class="rv-omitted">You omitted this question.</div>' : "";
    const rationaleHtml = (review && q.rationale)
      ? `<div class="rv-rationale"><h3>Rationale</h3><div class="rv-rat-body">${fmt(q.rationale)}</div></div>` : "";

    return `
      <div class="q-head">
        <div class="q-num">${state.questionIndex+1}</div>
        <button class="q-flag ${flagged?"on":""}" id="flagBtn"${review ? " disabled" : ""}><span class="bkm"><svg viewBox="0 0 24 24" width="15" height="17" aria-hidden="true"><path d="M5.5 3h13v18l-6.5-4.8L5.5 21z" stroke-width="2" stroke-linejoin="round"/></svg></span> Mark for Review</button>
        ${review ? reviewTimeHtml(q) : ""}
        ${(isSpr || review) ? "" : `<button class="abc-toggle ${abcOn?"on":""}" id="abcToggle" title="Cross out answer choices"><span class="abctxt">ABC</span></button>`}
      </div>
      ${figHtml}
      ${stackedHtml}
      ${stemHtml(q.questionText, ms.stemHtml ? ms.stemHtml[q.id] : undefined)}
      ${body}
      ${omittedHtml}
      ${rationaleHtml}`;
  }

  /* Per-question time, review only — it is a fact about a finished sitting,
     and showing a running total to a student mid-test would be a new pressure
     the real app doesn't apply. Takes the slot the ABC toggle occupies in a
     live sitting (crossing out is gone in review), so the header band keeps
     its shape.

     `timeSpentSeconds` is the record's own total ACROSS VISITS — the recorder
     accumulates it per visit (closeClock adds to meta.timeMs) and resume
     rebuilds it from the stored value, so a question returned to three times
     reports the sum. Both fields are record-derived and therefore untrusted:
     mmss()/num() coerce them, and anything that is not a real number prints
     an em-dash rather than a fabricated reading.

     "Never visited" is decided by visitCount, not by the clock: a question
     that was opened and left instantly has timeSpentSeconds 0, which is a
     true 0:00 and must not read the same as one never reached. */
  function reviewTimeHtml(q){
    const a = ((state.reviewMode.record || {}).answers || {})[q.id] || {};
    const visits = num(a.visitCount);
    const t = (visits !== null && visits > 0) ? mmss(a.timeSpentSeconds) : null;
    const visitTag = (visits !== null && visits > 1)
      ? ` <span class="rv-visits">(${visits} visits)</span>` : "";
    return `<span class="rv-time" title="Time spent on this question, across all visits">` +
      `Time: ${t === null ? "&mdash;" : t}${t === null ? "" : visitTag}</span>`;
  }

  /* SPR verdict for review: outcome + the key (with accepted alternates).
     The recorded answer is untrusted record data — escaped; the key comes
     from test data — escaped all the same (it renders as plain text). */
  function sprReviewHtml(q){
    const row = state.reviewMode.rowByQid[q.id];
    let cls, verdict;
    if(!row || row.noKey){ cls = "neutral"; verdict = "No key yet for this question."; }
    else if(row.given === null){ cls = "bad"; verdict = "You omitted this question."; }
    else if(row.correct){ cls = "ok"; verdict = "Your answer is correct."; }
    else { cls = "bad"; verdict = "Your answer is incorrect."; }
    let key = "";
    if(row && !row.noKey){
      key = `<div class="rv-spr-key"><b>Correct answer:</b> ${escapeHtml(String(q.correctAnswer))}` +
        ((q.altAnswers && q.altAnswers.length)
          ? ` <span class="rv-spr-alt">(also accepted: ${q.altAnswers.map(a=>escapeHtml(String(a))).join(", ")})</span>` : "") +
        `</div>`;
    }
    return `<div class="rv-banner ${cls}">${verdict}</div>${key}`;
  }

  function attachQuestionHandlers(){
    const q = currentQuestion();
    const ms = currentModState();

    attachFigureHandlers(q);   // zoom/expand is read-only — wired in review too

    /* Review renders the student's work but attaches none of the mutating
       handlers: no answer clicks, no flagging, no cross-outs, no SPR typing.
       The markup side already dropped those controls; this is the second
       layer, so a style regression that re-shows a control still can't make
       it do anything. */
    if(state.reviewMode) return;

    el("flagBtn").addEventListener("click", ()=>{
      if(ms.flags.has(q.id)) ms.flags.delete(q.id); else ms.flags.add(q.id);
      renderQuestionView();
    });

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
        /* Clicking a crossed-out choice UN-crosses it (confirmed against real
           Bluebook 2026-08-08) rather than doing nothing, which is what this
           did before. It does not also select it: one click undoes the
           cross-out and leaves the choice available, which is the same result
           as the row's Undo control. Composed with the drag behaviour below,
           dragging inside a crossed-out choice highlights the text AND
           un-crosses the choice — each half being the documented behaviour of
           its own gesture. */
        if(elimSet && elimSet.has(idx)){ toggleEliminate(q.id, idx, true); return; }
        ms.answers[q.id] = idx;
        Attempts.answerCommitted(q.id, idx);
        /* Update the selected state IN PLACE. A drag inside a choice ends with
           a click here, and replacing paneRight.innerHTML would collapse the
           student's live text selection before it could become a highlight —
           which killed choice highlighting outright. Picking an answer only
           changes which choice carries .selected, so a full rebuild was never
           needed for it. */
        document.querySelectorAll("#paneRight .choice").forEach(c =>
          c.classList.toggle("selected", parseInt(c.dataset.idx, 10) === idx));
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

  /* inPlace: un-crossing is reachable by DRAGGING inside a crossed-out choice,
     and a rebuild there would collapse the live selection — and dismiss the
     popup — before it could become a highlight, leaving the compound case
     inconsistent with its two halves. Un-crossing only flips two classes, so
     it is done in place on that path. Crossing OUT keeps the full rebuild: it
     is reached from the elim button, never from a drag, and it can also clear
     the recorded answer. */
  function toggleEliminate(qid, idx, inPlace){
    const ms = currentModState();
    if(!ms.eliminated[qid]) ms.eliminated[qid] = new Set();
    if(ms.eliminated[qid].has(idx)){
      ms.eliminated[qid].delete(idx);
      if(inPlace){
        const c = document.querySelector('#paneRight .choice[data-idx="' + idx + '"]');
        const row = c && c.closest(".choice-row");
        if(c && row){ c.classList.remove("eliminated"); row.classList.remove("is-elim"); return; }
      }
    }
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
  /* One navigation per transition, matching the real app. A second click while
     a transition is in flight is DISCARDED, never queued: queueing is what
     turns an impatient double-click into a skipped question, and on a timed
     test that is unrecoverable — the student cannot get the time back. The
     same lock covers Next-from-review, so a double-click can't submit twice.
     The buttons are disabled for the window too, so the discard is visible
     rather than the click just seeming to do nothing. */
  const NAV_LOCK_MS = 260;
  let navLocked = false;
  function navigate(fn){
    if(navLocked) return;                       // discarded, not queued
    navLocked = true;
    const back = el("btnBack"), next = el("btnNext");
    back.disabled = next.disabled = true;
    try{ fn(); }
    finally{
      setTimeout(()=>{
        navLocked = false;
        back.disabled = next.disabled = false;
      }, NAV_LOCK_MS);
    }
  }
  window.AppNav = { locked: ()=> navLocked, lockMs: NAV_LOCK_MS };

  el("btnBack").addEventListener("click", ()=> navigate(()=>{
    if(state.reviewMode){ reviewStep(-1); return; }
    if(state.view === "review"){ state.view = "question"; renderTest(); return; }
    if(state.questionIndex > 0){ state.questionIndex--; renderTest(); }
  }));
  el("btnNext").addEventListener("click", ()=> navigate(()=>{
    if(state.reviewMode){ reviewStep(1); return; }
    if(state.view === "review"){ submitModule(); return; }
    const total = currentModule().questions.length;
    if(state.questionIndex < total-1){ state.questionIndex++; renderTest(); }
    else { state.view = "review"; renderTest(); }
  }));

  /* Review navigation: module structure is preserved, so stepping off either
     end of a module crosses into the neighbouring one — there is no Check
     Your Work page and no submit beat to run into. Ends are simply ends. */
  function reviewStep(dir){
    const mods = state.currentTest.modules;
    let mi = state.moduleIndex, qi = state.questionIndex + dir;
    if(qi < 0){
      if(mi === 0) return;
      mi--; qi = mods[mi].questions.length - 1;
    } else if(qi >= mods[mi].questions.length){
      if(mi === mods.length - 1) return;
      mi++; qi = 0;
    }
    /* Crossing a module boundary is a section change: the section tools go
       with it. A live sitting gets this from submitModule; review steps
       straight across, which left the Calculator floating over a Reading and
       Writing module whose header has no control to close it — a state the
       real app cannot produce. */
    if(mi !== state.moduleIndex){ closeCalc(); closeRef(); closeDirections(); hide("figOverlay"); }
    state.moduleIndex = mi;
    state.questionIndex = qi;
    renderTest();
  }

  /* ================= QUESTION NAVIGATOR POPUP ================= */
  el("qnavBtn").addEventListener("click", openQnav);
  el("qnavClose").addEventListener("click", closeQnav);
  el("qnavOverlay").addEventListener("click", closeQnav);
  el("gotoReviewBtn").addEventListener("click", ()=>{
    if(state.reviewMode) return;   // hidden in review; Check Your Work is a live-test surface
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
      if(state.reviewMode){
        /* Review: the navigator is an outcome map — correct / incorrect /
           omitted per question, module-local numbering, flags kept. */
        const row = state.reviewMode.rowByQid[q.id];
        const outcome = !row || row.noKey ? "rv-nokey"
          : row.given === null ? "rv-omit"
          : row.correct ? "rv-ok" : "rv-bad";
        cell.className = "qcell " + outcome;
      } else {
        const answered = ms.answers.hasOwnProperty(q.id);
        cell.className = "qcell" + (answered ? " answered" : "");
      }
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

  /* The static legend markup is the live-test one; review swaps in an
     outcome legend and swaps the original back on the way out. */
  const QNAV_LEGEND_LIVE = el("qnavLegend").innerHTML;
  const QNAV_LEGEND_REVIEW =
    '<span><span class="lg-sq rv-ok"></span> Correct</span>' +
    '<span><span class="lg-sq rv-bad"></span> Incorrect</span>' +
    '<span><span class="lg-sq rv-omit"></span> Omitted</span>' +
    '<span><span class="lg-flag">' + QNAV_FLAG + '</span> For Review</span>';

  function openQnav(){
    el("qnavTitle").textContent = sectionTitle(currentModule()) + " Questions";
    el("qnavLegend").innerHTML = state.reviewMode ? QNAV_LEGEND_REVIEW : QNAV_LEGEND_LIVE;
    // Check Your Work is a live-test destination; review has no such page
    el("gotoReviewWrap").classList.toggle("hidden", !!state.reviewMode);
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
    if(state.reviewMode) return;   // review has no submit path, by construction and by guard
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
      // which home section the finished attempt lands in; read after the
      // assignment is cleared below
      state.lastWasProctored = !!(state.activeAssignment && state.activeAssignment.category === "test");
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
    const local = AttemptStore.isLocal();
    // Local mode: the record can't be released remotely, so the JSON file IS
    // the handoff — offer it even when the local write succeeded.
    el("subSaveNote").textContent = local
      ? "Saved on this device. Download your results and send the file to your tutor."
      : working
        ? "Your attempt was recorded automatically."
        : "Automatic recording isn't available in this copy — download your results and send the file to your tutor.";
    el("subDownloadBtn").classList.toggle("hidden", working && !local);   // spec §6 fallback
    showOnly("screen-submitted");
  }
  el("subDownloadBtn").addEventListener("click", ()=> Attempts.downloadJson());
  el("subHomeBtn").addEventListener("click", async ()=>{
    // reload everything so the just-finished assignment leaves Active and its
    // attempt appears in Past — the completion is now read from the record
    await refreshStudentState(state.userName);
    /* land them where the new attempt now shows — a proctored sitting lands
       under Your Tests, everything else under Practice */
    if(state.lastWasProctored){ state.testsTab = "past"; state.practiceTab = "active"; }
    else { state.practiceTab = "past"; state.testsTab = "active"; }
    state.currentTest = null;
    renderHome();
    showOnly("screen-home");
  });

  function showBreak(){
    el("brkName").textContent = displayLabel();
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
    if(state.reviewMode) return;   // menu item is hidden in review; nothing to save either way
    clearInterval(state.timerInterval);           // timer pauses while exited
    closeDirections(); closeQnav(); hideHlPopup(); closeCalc(); closeRef(); hide("figOverlay");
    setLineReader(false);
    hide("fiveMinPopup");
    closeMoreMenu();
    const test = state.currentTest;
    /* Ask the recorder for the position/annotation blob rather than rebuilding
       it here. This used to be a second, hand-maintained copy that carried only
       passageHtml + notes, so widening annotation to the stem and choices would
       have persisted nothing from them on Save-and-Exit. */
    const ok = await Attempts.suspend(Attempts.positionBlob());
    if(!ok){
      // Phase F §8: never return home over unrecoverable progress — stay in
      // the test, restart the clock, explain, and offer the JSON fallback
      startTimer();
      renderTest();                               // reopens the per-question clock
      show("saveFailModal");
      return;
    }
    // re-read from storage so the home cards reflect what actually persisted:
    // the suspended assignment should now show Resume against ITS own attempt
    await refreshStudentState(state.userName);
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
    /* Review is not a sitting. It satisfies `inTest` (currentTest set,
       screen-test visible) but has no clock and no live attempt, so reporting
       state.timeRemainingSec here published a number left over from whatever
       sitting ran earlier this page-load — a report from a replay reading like
       a mid-sitting one at 7:34 on the timer. The module/question context IS
       real and worth keeping (it says which question rendered wrong); the
       clock is nulled, the reviewed attempt's own id is attached instead of
       the detached recorder's null, and the report says which surface it came
       from so a tutor can tell replay from sitting at a glance. */
    const inReview = !!state.reviewMode;
    const report = {
      at: new Date().toISOString(),
      studentCode: state.userName,
      surface: inReview ? "review" : (inTest ? "test" : "home"),
      testId: inTest ? state.currentTest.testId : null,
      testVersion: inTest ? (state.currentTest.testVersion || "unversioned") : null,
      attemptId: inReview
        ? ((state.reviewMode.record && state.reviewMode.record.attemptId) || null)
        : Attempts.currentAttemptId(),
      moduleId: inTest ? currentModule().moduleId : null,
      questionId: (inTest && state.view === "question") ? currentQuestion().id : null,
      timerRemainingSeconds: (inTest && !inReview) ? state.timeRemainingSec : null,
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
    const review = !!state.reviewMode;
    if(mod.section === "Math"){
      // calculator + reference are read-only tools — they stay in review
      tools.innerHTML = `
        <button class="th-tool" id="toolCalc"><span class="ticon"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2.5" width="14" height="19" rx="2.2"/><rect x="7.5" y="5" width="9" height="3.6" rx="0.8"/><path d="M8.5 12.5h0M12 12.5h0M15.5 12.5h0M8.5 15.5h0M12 15.5h0M15.5 15.5h0M8.5 18.5h0M12 18.5h0"/><path d="M15.5 17.5v2" stroke-width="1.7"/></svg></span>Calculator</button>
        <button class="th-tool" id="toolRef"><span class="ticon" style="font-family:var(--serif);font-style:italic;">x²</span>Reference</button>` +
        MORE_MENU_HTML;
      el("toolCalc").addEventListener("click", toggleCalc);
      el("toolRef").addEventListener("click", toggleRef);
      wireMoreMenu();
    } else {
      // the Highlights & Notes toggle exists to CREATE annotations — in
      // review they replay read-only, so the toggle doesn't render at all
      tools.innerHTML = (review ? "" : `
        <span class="hl-mode-wrap">
          <button class="th-tool" id="hlModeBtn" title="Toggle highlight mode"><span class="ticon">✎</span><span class="tlabel">Highlights &amp; Notes</span></button>
          <div class="hl-tip hidden" id="hlTip"><b>Highlight mode on:</b> Select text to create a highlight automatically.</div>
        </span>`) +
        MORE_MENU_HTML;
      if(!review) wireHlModeBtn();
      wireMoreMenu();
    }
    // review has nothing to save and no exit-to-home — Back goes to Score
    // Details instead. Line Reader and the bug report stay useful.
    if(review) el("miSaveExit").classList.add("hidden");
    el("tBody").classList.toggle("hl-mode", state.hlMode && mod.section !== "Math" && !review);
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
      /* Record the grab BEFORE attempting capture. setPointerCapture throws if
         the pointer id isn't active, and it used to do so between `dragging =
         true` and the coordinates being read — leaving a drag armed with
         undefined origins, so every move computed NaN and the panel silently
         refused to move at all. */
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      dragging = true;
      try{ handle.setPointerCapture(e.pointerId); }catch(err){ /* capture is an optimisation */ }
    });
    handle.addEventListener("pointermove", e=>{
      if(!dragging) return;
      const p = clampToViewport(panel, handle, ox + e.clientX - sx, oy + e.clientY - sy);
      panel.style.left = p.left + "px";
      panel.style.top  = p.top + "px";
      panel.style.right = "auto"; panel.style.bottom = "auto";
    });
    handle.addEventListener("pointerup", ()=>{ dragging = false; });
    /* A panel dragged off-screen takes its drag handle with it, and the handle
       is the only way to move it back — so it becomes permanently stranded and
       the student loses the calculator for the rest of the module. Re-clamp on
       resize too: shrinking the window must not orphan a panel that was legally
       placed a moment ago. */
    window.addEventListener("resize", ()=>{
      if(panel.classList.contains("hidden")) return;
      const r = panel.getBoundingClientRect();
      const p = clampToViewport(panel, handle, r.left, r.top);
      if(p.left !== Math.round(r.left) || p.top !== Math.round(r.top)){
        panel.style.left = p.left + "px";
        panel.style.top  = p.top + "px";
        panel.style.right = "auto"; panel.style.bottom = "auto";
      }
    });
  }

  /* Keep the HANDLE reachable, not merely some pixel of the panel: the handle
     is what the student has to grab. A generous slice of it must stay inside
     the viewport on every edge. */
  const HANDLE_KEEP_PX = 48;
  function clampToViewport(panel, handle, left, top){
    const pr = panel.getBoundingClientRect();
    const hr = handle.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // where the handle sits relative to the panel's own box
    const hOffX = hr.left - pr.left, hOffY = hr.top - pr.top;
    const keepX = Math.min(HANDLE_KEEP_PX, hr.width || HANDLE_KEEP_PX);
    const keepY = Math.min(HANDLE_KEEP_PX, hr.height || HANDLE_KEEP_PX);
    // handle's left edge must not pass the right edge minus a grabbable strip,
    // nor go further left than a grabbable strip remaining on screen
    const minLeft = -hOffX - (hr.width - keepX);
    const maxLeft = vw - hOffX - keepX;
    const minTop  = -hOffY;                       // never above the top edge
    const maxTop  = vh - hOffY - keepY;
    return {
      left: Math.round(Math.max(minLeft, Math.min(maxLeft, left))),
      top:  Math.round(Math.max(minTop,  Math.min(maxTop,  top)))
    };
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
    /* At 100% the CSS fit rules own the size, so the whole diagram is visible
       without scrolling. Any other zoom level is an explicit request for a
       different size, so the width is set and the height cap released — that
       is the only point at which the frame is allowed to scroll. */
    const apply = ()=>{
      if(pct === 100){ img.style.width = ""; img.style.maxHeight = ""; }
      else { img.style.width = pct + "%"; img.style.maxHeight = "none"; }
      el("figPct").textContent = pct + "%";
    };
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

  /* Capture phase, so the reset lands before any handler that reads the flag:
     a new press is a new gesture, whatever the previous one did. Tying the
     flag's life to the gesture rather than to a timer means a drag that ends
     without a click (released outside the window, cancelled) cannot leave it
     stuck on. */
  document.addEventListener("mousedown", ()=>{ state.hlGestureUsed = false; }, true);

  document.addEventListener("mouseup", e=>{
    if(hlPopup.contains(e.target)) return;
    /* In highlight mode the span is created and SAVED synchronously, here,
       before the browser dispatches the click that follows a drag. A drag
       inside a choice ends on that choice, and anything which re-renders the
       pane in the click handler collapses the live selection — a deferred
       handler would then find nothing to highlight. Creating it now also means
       the markup is already in moduleState, so it survives a later rebuild.
       The popup path stays deferred, so the selection has settled before it is
       measured and positioned. */
    if(state.hlMode && handleSelection(true)) return;
    setTimeout(handleSelection, 0);   // let selection settle
  });

  /* Returns true when it turned the selection into a highlight (highlight
     mode); false otherwise, including every refusal. */
  /* Nearest ancestor of `node` (up to but excluding `root`) that is not
     inline-level. Resolved from COMPUTED display rather than a tag list, so it
     covers table-cell, list-item and anything a future render surface adds
     without needing to be kept in sync. inline-block counts as inline: KaTeX
     is built from them and a highlight inside math must still work. */
  function blockAncestor(node, root){
    let e = node && node.nodeType === 1 ? node : (node && node.parentElement);
    while(e && e !== root){
      const d = getComputedStyle(e).display || "";
      if(d.indexOf("inline") !== 0) return e;
      e = e.parentElement;
    }
    return root;
  }
  /* Structural block containers fmt() can emit. KaTeX builds everything from
     SPAN/svg/MathML and never one of these, so wrapping a whole inline formula
     stays allowed — which it must, since highlighting a sentence containing
     math is ordinary. */
  const STRUCTURAL_BLOCKS = "div,p,table,thead,tbody,tfoot,tr,td,th,ul,ol,li," +
                            "blockquote,figure,figcaption,hr,pre,h1,h2,h3,h4,h5,h6";
  /* Chrome puts a caret INSIDE a childless inline-block, and fmt() renders a
     text-completion blank as exactly that: <span class="fmt-blank"></span>.
     A drag that starts or ends on the blank therefore leaves a range boundary
     inside the empty span, and extractContents() SHALLOW-CLONES a partially
     contained element — so the blank is duplicated and the student sees two
     52px blanks in a question that has one. Then it is saved. Pulling the
     boundary outside the empty element makes it wholly contained, so it moves
     instead of cloning. */
  function normalizeRangeBoundaries(range){
    try{
      const s = range.startContainer;
      if(s.nodeType === 1 && !s.firstChild) range.setStartBefore(s);
      const e = range.endContainer;
      if(e.nodeType === 1 && !e.firstChild) range.setEndAfter(e);
    }catch(err){ /* leave the range as it was */ }
    return range;
  }

  function crossesBlock(range, root){
    try{
      if(blockAncestor(range.startContainer, root) !== blockAncestor(range.endContainer, root)) return true;
      /* Endpoints alone are not enough: a block sitting WHOLLY BETWEEN them
         leaves both resolving to the same ancestor, and extractContents() then
         lifts that entire block inside the new highlight span. On a paired
         passage that swallows the "Text 2" header — which makes it the span's
         first element child, so .fmt-passage-label:first-child fires and the
         42px separation between the two texts collapses to nothing. Then it is
         SAVED, so the ruined spacing is what the student reads for the rest of
         the sitting and what Review Mode replays. Six shipped questions have
         that shape. */
      return !!range.cloneContents().querySelector(STRUCTURAL_BLOCKS);
    }catch(err){ return true; }   // fail closed: refuse rather than shred
  }

  function handleSelection(){
    if(el("screen-test").classList.contains("hidden")) return false;
    if(state.reviewMode) return false;   // annotations replay read-only in review — no new highlights
    if(currentModule().section === "Math") return false;   // annotation is R&W-only: no toolbar in Math
    const sel = window.getSelection();
    if(sel.isCollapsed || sel.rangeCount === 0){ return false; }
    const range = sel.getRangeAt(0);
    /* Passage, stem, or one choice — see annotationHost. A selection the
       regions don't wholly contain (across two choices, or onto the header
       band) yields null and is refused here. */
    const host = annotationHost(range.commonAncestorContainer);
    if(!host){ hideHlPopup(); return false; }
    normalizeRangeBoundaries(range);   // see the .fmt-blank note above
    /* A selection that crosses a BLOCK boundary cannot become one span. The
       wrap below is extractContents() + insertNode(), which splits every
       partially-selected block ancestor on the way — drag from one table cell
       to another and the table is rebuilt with the cells torn in half
       ("6,837,474" becomes "6," in one row and "837,474" in the next). That
       shredded markup is then SAVED, so it is what the student reads for the
       rest of the sitting and what Review Mode replays; the highlight itself
       is lost anyway, because a <span> serialised inside a <tr> is
       foster-parented out of the table on the next parse. Refusing is strictly
       better than the corruption, and it costs nothing real: prose paragraphs
       here are separated by <br>, not blocks, so ordinary multi-paragraph
       highlighting is unaffected. Tables and lists appear in 12 RW passages
       across the shipped library. */
    if(crossesBlock(range, host.el)){ hideHlPopup(); return false; }
    if(state.hlMode){
      // highlight mode: releasing the drag highlights instantly, no popup (19-20)
      hideHlPopup();
      const span = document.createElement("span");
      span.className = "hl c-" + state.activeHlColor;
      try{
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }catch(err){ return false; }
      sel.removeAllRanges();
      saveAnnotation(host);
      /* This gesture has spent itself: it became a highlight. The click that
         always follows a drag must not ALSO be read as a click-to-edit, because
         removeAllRanges() above has just made the "a selection is live, stand
         down" guard in those handlers stop holding. Without this the popup
         opens on the ENCLOSING span, and the next swatch recolours the whole
         existing highlight — or the trash unwraps it and takes its note with
         it — instead of touching the piece the student just dragged. */
      state.hlGestureUsed = true;
      return true;
    }
    state.savedRange = range.cloneRange();
    state.hlTarget = null;
    state.hlHost = host;
    positionHlPopup(range.getBoundingClientRect());
    return false;
  }

  passagePane.addEventListener("click", e=>{
    if(state.reviewMode) return;   // a restored highlight is display-only in review
    if(currentModule().section === "Math") return;   // Math is annotation-free
    if(state.hlGestureUsed) return;   // this click is the tail of a drag that already highlighted
    const span = e.target.closest(".hl");
    if(!span) return;
    const sel = window.getSelection();
    if(sel && !sel.isCollapsed) return;  // selection handler takes precedence
    state.hlTarget = span;
    state.savedRange = null;
    state.hlHost = annotationHost(span);
    positionHlPopup(span.getBoundingClientRect());
    e.stopPropagation();
  });

  /* Click-to-edit for STEM and CHOICE highlights. It reaches choices now that
     picking an answer updates in place instead of rebuilding the pane — the
     popup no longer risks pointing at a detached span. Without it a choice
     highlight could be created but never recoloured or removed, which is a
     one-way door the passage has never had. Clicking a choice still selects it
     as the answer, which is Bluebook's behaviour and stays. */
  el("paneRight").addEventListener("click", e=>{
    if(state.reviewMode) return;
    /* The Math invariant has to hold on THIS path too, not just on the
       selection path: a crafted record can plant annotation markup on a Math
       module, and restore renders whatever it plants. */
    if(currentModule().section === "Math") return;
    if(state.hlGestureUsed) return;   // ditto — see the passage handler above
    const span = e.target.closest && e.target.closest(".hl");
    if(!span) return;
    const host = annotationHost(span);
    if(!host || (host.kind !== "stem" && host.kind !== "choice")) return;
    const sel = window.getSelection();
    if(sel && !sel.isCollapsed) return;  // selection handler takes precedence
    state.hlTarget = span;
    state.savedRange = null;
    state.hlHost = host;
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
    /* Notes stay PASSAGE-ONLY even though highlighting now covers the stem and
       choices: the notes rail is keyed per passage question and only renders
       when the question has one, and deleteNote resolves its span inside
       #passageText. Offering the button on a stem or choice highlight would
       create a note the rail could never show or delete. Highlighting there
       works fully; only the note affordance is withheld. */
    const isRW = currentModule().section === "Reading and Writing";
    const notesOk = isRW && !!state.hlHost && state.hlHost.kind === "passage";
    el("hlNote").classList.toggle("hidden", !notesOk);
    el("hlNoteSep").classList.toggle("hidden", !notesOk);
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
    state.hlHost = null;
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

  /* ---- annotatable regions (Reading and Writing) ----
     Highlighting covers the passage, the question stem, and the text of a
     SINGLE answer choice. Everything else is out: the header band (Mark for
     Review / ABC), and any selection spanning two choices or straddling the
     stem and a choice.

     Those exclusions need no special-casing — they fall out of asking which
     region CONTAINS the whole selection. A range covering two choices has
     .choices as its common ancestor, and a range straddling stem and choice
     has the pane; neither is inside a region, so both resolve to null and are
     refused. One function answers "which region is this in?" for both the
     selection gate and the save path, so the two can never disagree about
     what is annotatable. */
  function annotationHost(node){
    if(!node) return null;
    const start = node.nodeType === 1 ? node : node.parentElement;
    if(!start || !start.closest) return null;
    const pt = start.closest("#passageText");
    if(pt) return { kind: "passage", el: pt };
    const stem = start.closest(".q-text");
    if(stem) return { kind: "stem", el: stem };
    const ctext = start.closest(".ctext");
    if(ctext){
      const choice = ctext.closest(".choice");
      const idx = choice ? parseInt(choice.dataset.idx, 10) : NaN;
      if(!isNaN(idx)) return { kind: "choice", el: ctext, idx: idx };
    }
    return null;
  }

  /* Persist a region's markup into its own keyed slot. Each region is stored
     separately (rather than one blob per question) so a restore can put each
     back into the element it came from — the stem's saved HTML must not be
     dropped into a choice. */
  function saveAnnotation(host){
    if(!host || !host.el) return;
    const ms = currentModState();
    const qid = currentQuestion().id;
    if(host.kind === "passage"){ ms.passageHtml[qid] = host.el.innerHTML; }
    else if(host.kind === "stem"){ ms.stemHtml[qid] = host.el.innerHTML; }
    else if(host.kind === "choice"){
      if(!ms.choiceHtml[qid]) ms.choiceHtml[qid] = {};
      ms.choiceHtml[qid][host.idx] = host.el.innerHTML;
    }
  }
  // save whichever region this node lives in
  function saveFromNode(node){ saveAnnotation(annotationHost(node)); }

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
      saveFromNode(span);
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
      saveFromNode(span);
    });
  });

  el("hlTrash").addEventListener("click", ()=>{
    const span = state.hlTarget;
    if(span){
      // resolve the region BEFORE unwrapping — afterwards the span is detached
      // and can no longer say which region it belonged to
      const host = annotationHost(span);
      if(span.dataset.noteId) removeNoteRecord(span.dataset.noteId);   // don't orphan the note
      const parent = span.parentNode;
      while(span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
      saveAnnotation(host);
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
    saveFromNode(span);
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
    if(span) saveFromNode(span);
    renderNotesRail();
  }

  function renderNotesRail(){
    const rail = el("notesRail");
    const mod = currentModule();
    const q = currentQuestion();
    const ms = currentModState();
    // Array.isArray, not truthiness: a record-derived blob can hold a string
    // here, and a string has .length — which used to reach notes.map() and throw
    const raw = ms.notes && ms.notes[q.id];
    const notes = Array.isArray(raw) ? raw : [];
    const visible = state.view === "question" &&
                    mod.section === "Reading and Writing" &&
                    !!q.passage && notes.length > 0;
    rail.classList.toggle("hidden", !visible);
    rail.classList.toggle("collapsed", state.notesCollapsed);
    el("tBody").classList.toggle("notes-open", visible && !state.notesCollapsed);
    el("notesChev").title = state.notesCollapsed ? "Expand notes" : "Collapse notes";
    if(!visible){ el("notesCards").innerHTML = ""; return; }

    /* Review: the note cards render exactly as the student left them, but
       read-only — no trash button, textarea locked. Note text/snippet/id come
       out of a record and are escaped like every other record value. */
    const review = !!state.reviewMode;
    const trashSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="M19 6l-1 13.5A1.5 1.5 0 0 1 16.5 21h-9A1.5 1.5 0 0 1 6 19.5L5 6"/><path d="M10 10.5v6M14 10.5v6"/></svg>';
    el("notesCards").innerHTML = notes.map(n => `
      <div class="note-card" data-note="${escapeHtml(n.id)}">
        <div class="note-head">
          <span class="note-title">${escapeHtml(n.snippet)}</span>
          ${review ? "" : `<button class="note-trash" title="Delete note">${trashSvg}</button>`}
        </div>
        <textarea class="note-body-ta" ${review ? "readonly" : 'placeholder="Notes are saved automatically."'}>${escapeHtml(n.text)}</textarea>
      </div>`).join("");

    if(review) return;
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
      /* The notes rail sits BETWEEN the left pane and the divider, so the
         divider's position is paneLeft + rail. Measuring the cursor from the
         body's left edge and assigning that straight to paneLeft ignored the
         rail and pushed the divider a full rail-width (290px) right of the
         cursor the moment a note existed. Subtract it. */
      const rail = el("notesRail");
      const railW = rail.classList.contains("hidden") ? 0 : rail.offsetWidth;
      let pct = ((e.clientX - bodyRect.left - railW) / bodyRect.width) * 100;
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
     null and the page falls back to raw counts — never invent numbers.
     Two forms (SCHEMA v1.2 scoring addendum):
     - per-section: sc.rw[rawRw] / sc.math[rawMath] — arrays over section raw.
     - per-module (sc.model === "per-module"): section scaled = sc.base +
       <sec>M1[raw correct in module 1] + <sec>M2[raw correct in module 2].
       Needs the per-module raws from buildScoreRows; without them (or with a
       malformed table) this returns null and the raw fallback shows. */
  function scaledScores(test, rawRw, rawMath, moduleRaw){
    const sc = test.scoring;
    if(!sc) return null;
    const pick = (arr, raw) => Array.isArray(arr) && typeof raw === "number"
      ? arr[Math.max(0, Math.min(raw, arr.length - 1))] : undefined;
    let rw, math;
    if(sc.model === "per-module"){
      if(!moduleRaw || typeof sc.base !== "number") return null;
      const rw1 = pick(sc.rwM1,   moduleRaw.rw[0]),   rw2 = pick(sc.rwM2,   moduleRaw.rw[1]);
      const ma1 = pick(sc.mathM1, moduleRaw.math[0]), ma2 = pick(sc.mathM2, moduleRaw.math[1]);
      if([rw1, rw2, ma1, ma2].some(v => typeof v !== "number")) return null;
      rw = sc.base + rw1 + rw2;
      math = sc.base + ma1 + ma2;
    } else {
      rw = pick(sc.rw, rawRw);
      math = pick(sc.math, rawMath);
    }
    if(typeof rw !== "number" || typeof math !== "number") return null;
    return { rw, math, total: rw + math,
      estimated: !!sc.estimated || sc.scoringSource === "estimated" };
  }
  const EST = '<sup class="sd-est" title="Estimated — approximate conversion">Est.</sup>';

  let sdCtx = null;   // { test, record, rows, filter, page, pageSize }

  function buildScoreRows(test, record){
    const ms = buildModuleStateFromRecord(test, record);
    const rows = [];
    const tally = { "Reading and Writing": {correct:0, graded:0}, "Math": {correct:0, graded:0} };
    const domains = {};    // section -> domain -> {correct, graded}
    /* per-module raw correct, in document order within each section — feeds
       the per-module scoring form. Index = which module of its section. */
    const SEC_KEY = { "Reading and Writing": "rw", "Math": "math" };
    const moduleRaw = { rw: [0, 0], math: [0, 0] };
    const modOrd = {};     // section -> how many of its modules seen so far
    test.modules.forEach((mod, modIndex) => {
      const mKey = SEC_KEY[mod.section];
      const mIdx = (modOrd[mod.section] = (modOrd[mod.section] || 0) + 1) - 1;
      const st = ms[mod.moduleId];
      mod.questions.forEach((q, qIndex) => {
        const noKey = !hasKey(q);
        const given = st.answers.hasOwnProperty(q.id) ? st.answers[q.id] : null;
        const correct = !noKey && given !== null && answerMatches(q, given);
        const domain = mapDomain(mod.section, q.skill);
        if(!noKey && tally[mod.section]){
          tally[mod.section].graded++;
          if(correct){
            tally[mod.section].correct++;
            if(mKey && mIdx < 2) moduleRaw[mKey][mIdx]++;
          }
        }
        if(!noKey){
          const dd = (domains[mod.section] = domains[mod.section] || {});
          const de = (dd[domain] = dd[domain] || {correct:0, graded:0});
          de.graded++; if(correct) de.correct++;
        }
        /* Numbering is MODULE-LOCAL on every student-facing surface (RW M1
           1-27, RW M2 1-27, Math M1 1-22, Math M2 1-22) — matching what the
           student saw while testing. Never a running 1-98 or per-section
           1-54; `mnum` + `modShort` together are the question's name. */
        rows.push({ q, mod, modIndex, qIndex, section: mod.section,
          mnum: qIndex + 1,
          modShort: (mod.section === "Reading and Writing" ? "RW" : "Math") + " M" + moduleNumber(mod),
          given, noKey, correct, domain });
      });
    });
    return { rows, tally, domains, moduleRaw };
  }

  function answerLetter(q, val){
    if(val === null || val === undefined) return null;
    return q.type === "spr" ? String(val) : String.fromCharCode(65 + val);
  }
  function correctLabel(q){
    if(!hasKey(q)) return "—";
    return q.type === "spr" ? String(q.correctAnswer) : String.fromCharCode(65 + q.correctAnswer);
  }

  /* Leaving Score Details. Two affordances share it: the Back button inside
     the page, and the name + avatar chip in the top bar. Both honour where
     the student (or tutor) came from — a dashboard-origin visit returns to
     the dashboard, so the chip can never strand a tutor in the student app.
     Wired ONCE, because the chip lives in the persistent top bar rather than
     inside sdRoot: attaching it in renderScoreDetails would stack a listener
     on every re-render. */
  function leaveScoreDetails(){
    if(sdCtx && sdCtx.origin === "dashboard" && window.Dashboard){ Dashboard.open(showOnly); return; }
    renderHome(); showOnly("screen-home");
  }
  el("userChipBtn").addEventListener("click", ()=>{
    // showOnly disables the chip off Score Details; belt and braces
    if(el("screen-scoredetails").classList.contains("hidden")) return;
    leaveScoreDetails();
  });

  /* Reviewing needs the questions too, so it goes through the same gate. In
     practice the content is already cached from the sitting, so this resolves
     without a fetch — but a student reviewing on a different device still gets
     the loading state and the retry rather than an empty report. */
  function openScoreDetails(entryOrTest, record, origin){
    if(entryOrTest && entryOrTest.modules) return openScoreDetailsLoaded(entryOrTest, record, origin);
    withTestContent(entryOrTest, full => openScoreDetailsLoaded(full, record, origin), origin);
  }
  function openScoreDetailsLoaded(test, record, origin){
    const built = buildScoreRows(test, record);
    sdCtx = { test, record, rows: built.rows, tally: built.tally, domains: built.domains,
      moduleRaw: built.moduleRaw,
      filter: "all", page: 0, pageSize: 10, showCorrect: false, origin: origin || "home" };
    renderScoreDetails();
    showOnly("screen-scoredetails");
    window.scrollTo(0, 0);   // the document is the scroller, not .sd-root
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
    const { test, record, tally, domains, moduleRaw } = sdCtx;
    const rawRw = tally["Reading and Writing"].correct;
    const rawMath = tally["Math"].correct;
    const scaled = scaledScores(test, rawRw, rawMath, moduleRaw);
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

    /* Module summary strips: one row per module — label, raw score, and a
       numbered chip per question colored by outcome. Chips open Review Mode
       at that question. Numbers are module-local (the only numbering any
       student surface uses). Counts are computed, never record-interpolated. */
    const rows = sdCtx.rows;
    const strips = '<section class="sd-modstrips" id="sdModStrips">' +
      test.modules.map((mod, mi) => {
        const mrows = rows.filter(r => r.modIndex === mi);
        const graded = mrows.filter(r => !r.noKey).length;
        const correct = mrows.filter(r => r.correct).length;
        return `<div class="sd-strip">
          <div class="sd-strip-head">
            <span class="sd-strip-label">${escapeHtml(mod.section)} · ${escapeHtml(mod.moduleLabel)}</span>
            <span class="sd-strip-raw">${correct}/${graded}</span>
          </div>
          <div class="sd-chips">` +
          mrows.map(r => {
            const cls = r.noKey ? "nokey" : r.given === null ? "omit" : r.correct ? "ok" : "bad";
            const word = r.noKey ? "no key yet" : r.given === null ? "omitted" : r.correct ? "correct" : "incorrect";
            return `<button class="sd-chip ${cls}" data-mi="${mi}" data-qi="${r.qIndex}"
              title="Question ${r.mnum} — ${word}. Open in review.">${r.mnum}</button>`;
          }).join("") +
          `</div></div>`;
      }).join("") + '</section>';

    /* Knowledge & Skills. A test with no tagged questions maps everything to
       "Other", and a grid reading "Other n/54" is noise dressed as data — so
       a fully-untagged test collapses to one line. The grid comes back by
       itself the moment any question carries a tag. */
    const allUntagged = rows.length > 0 && rows.every(r => r.domain === "Other");
    let ks = "";
    if(!allUntagged){
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
    }

    el("sdRoot").innerHTML = `
      <div class="sd-hero">
        <div class="sd-hero-top">
          <div>
            <h1>Score Details</h1>
            <div class="sd-hero-sub"><b>${escapeHtml(displayLabel())}</b>${state.displayName ? ' <span class="sd-code">' + escapeHtml(state.userName) + '</span>' : ""} · ${escapeHtml(test.testName)} · ${escapeHtml(dateStr)}${badge ? ' · <span class="sd-badge">' + escapeHtml(badge) + '</span>' : ""}</div>
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
        ${strips}
        <section class="sd-ks">
          <h2>Knowledge and Skills</h2>
          ${allUntagged
            ? '<p class="sd-muted">Skill tags aren\'t available for this test, so there\'s no domain breakdown — every question is in the review below.</p>'
            : '<p class="sd-muted">Your performance across the content domains measured on the SAT.</p>' +
              (ks || '<p class="sd-muted">Domain breakdown is not available for this test yet.</p>')}
        </section>
        <section class="sd-questions" id="sdQuestions"></section>
      </div>`;

    el("sdHomeBtn").textContent = sdCtx.origin === "dashboard" ? "Back to Dashboard" : "Return to Home";
    el("sdHomeBtn").addEventListener("click", leaveScoreDetails);
    el("sdReviewAllBtn").addEventListener("click", ()=> openReviewMode(0, 0));
    // one delegated handler for every chip: open review at that question
    el("sdModStrips").addEventListener("click", e=>{
      const chip = e.target.closest(".sd-chip");
      if(!chip) return;
      openReviewMode(parseInt(chip.dataset.mi, 10), parseInt(chip.dataset.qi, 10));
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
      /* module-local number + module column: "3 · RW M2" is the question's
         name, matching the strips, the review header and what the student
         saw while testing — never a running index */
      return `<tr>
        <td>${r.mnum}</td>
        <td>${escapeHtml(r.modShort)}</td>
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
          <thead><tr><th>Question #</th><th>Module</th><th>Correct Answer</th><th>Your Answer</th><th>Review</th><th>Domain</th></tr></thead>
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
      b.addEventListener("click", ()=>{
        const r = rows[parseInt(b.dataset.rid, 10)];
        if(r) openReviewMode(r.modIndex, r.qIndex);
      }));
  }

  /* ================= REVIEW MODE =================
     The one review surface (2026-08-02): a read-only replay of a released,
     version-matched attempt in the REAL test UI — same renderer, panes,
     figures and math as the sitting itself, with the student's highlights,
     notes, eliminations and flags restored through the same sanitizer path
     resume uses. Replaces the Phase G review popup and the Phase D
     "View My Responses" results page, both deleted.

     Reached only from Score Details, so the release/version gate is already
     behind us. Nothing in review records: Attempts.detach() drops the
     recorder's handle on whatever attempt it last held (after finalize, `rec`
     still points at the completed record and the visibility/unload flushes
     write whenever it exists — left attached, reviewing attempt B over the
     same test would flush B's replayed answers into A's record), and every
     mutating handler and Attempts.* call in the test flow is additionally
     gated on state.reviewMode. */
  async function openReviewMode(modIdx, qIdx){
    if(!sdCtx) return;
    const { test, record, rows } = sdCtx;
    if(!test.modules || !test.modules.length) return;
    /* Awaited: detach drains any unpersisted write before letting go of the
       record, so entering review can never strand a finished sitting. */
    await Attempts.detach();
    const rowByQid = {};
    rows.forEach(r => { rowByQid[r.q.id] = r; });
    /* Score Details scrolls with the DOCUMENT — #screen-scoredetails has no
       overflow of its own — so the position to restore is window.scrollY.
       Reading sdRoot.scrollTop here always returned 0, which made Back land
       at the top of the page on every chip round-trip. */
    state.reviewMode = { record, rowByQid, sdScroll: window.scrollY || 0 };
    state.currentTest = test;
    state.moduleState = buildModuleStateFromRecord(test, record);
    /* Annotations: finalize keeps the sitting's blob on the completed record;
       older completed records may predate that and simply review clean.
       Same restore as resume — shape-validated, raw HTML into moduleState,
       sanitized at every render. */
    restoreAnnotations(state.moduleState,
      record.annotations || ((record.resume || record.checkpoint || {}).annotations));
    state.view = "question";
    state.elimMode = false;
    /* hlMode is deliberately NOT reset: it is a session preference that
       survives navigation and Save-and-Exit, and review is already fully
       gated without touching it (updateHeaderTools drops the toggle and the
       hl-mode class, handleSelection returns early). Clearing it here silently
       turned the mode off for a sitting the student had left it on in. */
    clearInterval(state.timerInterval);
    // "Review" where the clock was; no Hide toggle, no five-minute machinery
    el("timerDisplay").innerHTML = '<span class="timer-review">Review</span>';
    el("timerBtn").classList.add("hidden");
    hide("fiveMinPopup");
    show("rvBackBtn");
    state.moduleIndex = Math.max(0, Math.min(modIdx || 0, test.modules.length - 1));
    const mod = test.modules[state.moduleIndex];
    state.questionIndex = Math.max(0, Math.min(qIdx || 0, mod.questions.length - 1));
    /* A render that throws must not leave review half-entered — the flags are
       already set and the Back button already shown, so the student would be
       stuck on Score Details with every chip re-throwing and a dead
       "‹ Score Details" button leaking into their next live sitting.
       restoreAnnotations makes a malformed record unlikely to get here; this
       is the backstop that keeps ANY render failure recoverable. */
    try{
      renderTest();
      showOnly("screen-test");
    }catch(e){
      exitReviewMode(true);
    }
  }

  function exitReviewMode(failed){
    if(!state.reviewMode) return;
    const scroll = state.reviewMode.sdScroll || 0;
    closeDirections(); closeQnav(); closeCalc(); closeRef(); hide("figOverlay");
    setLineReader(false);
    hide("rvBackBtn");
    // live-test chrome comes back with the next beginModule; un-hide the
    // timer toggle so nothing depends on that
    el("timerBtn").classList.remove("hidden");
    el("tBody").classList.remove("review-mode");
    state.reviewMode = null;
    state.currentTest = null;
    state.moduleState = {};
    lastRenderedQKey = null;
    renderScoreDetails();
    showOnly("screen-scoredetails");
    window.scrollTo(0, scroll);
    if(failed){
      el("sdModStrips").insertAdjacentHTML("afterbegin",
        '<p class="sd-muted">This attempt\'s saved highlights and notes couldn\'t be opened, so review isn\'t available for it. Your scores below are unaffected.</p>');
    }
  }
  el("rvBackBtn").addEventListener("click", ()=> exitReviewMode());

  /* Printing targets #screen-scoredetails, which showOnly() has hidden while
     review is up (display:none beats the print sheet's visibility:visible),
     so Ctrl+P from review produced entirely blank pages. Leaving review first
     restores the pre-redesign behaviour: printing mid-review yields the score
     report. beforeprint fires before the snapshot is taken. */
  window.addEventListener("beforeprint", ()=>{ if(state.reviewMode) exitReviewMode(); });

  /* ================= INIT ================= */
  // §6: dashboard "Open student view" bridges into the Score Details page,
  // regardless of release (admin-only path). Guards a missing/mismatched test.
  window.AppScoreView = {
    open(testId, record){
      const test = testById(testId);          // resolves legacy ids too
      if(!test) return false;
      // admin path: show that student's identity, resolved from their profile
      state.userName = (record.student && record.student.code) || state.userName;
      state.displayName = (window.Dashboard && Dashboard.nameFor)
        ? (Dashboard.nameFor(state.userName) || null) : null;
      openScoreDetails(test, record, "dashboard");
      return true;
    }
  };
  /* Entry: magic-link fragment beats a saved session, which beats the form.
     The fragment is stripped from the address bar FIRST — synchronously,
     before any await — so the code never lingers where it can be shoulder-
     surfed, bookmarked or pasted onward, and so a reload doesn't re-consume
     it. Stripping happens whether or not the fragment was a valid code. */
  (function boot(){
    const raw = location.hash || "";
    if(raw){
      try{ history.replaceState(null, "", location.pathname + location.search); }
      catch(e){ try{ location.hash = ""; }catch(e2){} }
    }
    const fromLink = parseFragmentCode(raw);
    window.AppMagicLink.seen = raw || null;
    window.AppMagicLink.accepted = fromLink;
    const code = fromLink || storedSession();
    showOnly("screen-signin");
    if(code){
      signInWithCode(code).then(ok => { if(!ok) showOnly("screen-signin"); })
                          .catch(()=> showOnly("screen-signin"));
    }
  })();
})();
