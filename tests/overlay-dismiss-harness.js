/* tests/overlay-dismiss-harness.js — paste into the console with a module
   open (dist/index-live.html or the live site), run OverlayDismissHarness.run().

   Covers two "an overlay intercepts/outlives navigation" reports investigated
   in the same session (2026-08-19):

   WORK ITEM 2 — question navigator popup on the last question of a module.
   Reported as: "an open navigator popup intercepts the Next button: instead
   of advancing, it re-navigates questions and silently wraps q27 -> q1."
   Already fixed in f48ae3a (2026-08-13, "Footer sits above the question-
   navigator scrim; navigating closes the navigator") — that commit's own
   MEASURED section found the swallow was real (two clicks needed) but the
   re-navigation/wrap never occurred, and fixed the swallow by raising the
   footer above the scrim and having navigate() call closeQnav(). Case D
   below is a REGRESSION GUARD re-proving that fix is intact: opening the
   navigator on a module's last question and clicking Next reaches Check
   Your Work in ONE click, with the popup closed and no wrap to question 1.
   Re-run against HEAD at the time of writing (2026-08-19): PASSES already,
   with no app.js change — see BLUEBOOK-PARITY session notes for this date.

   WORK ITEM 3 — Directions dropdown. The twin bug f48ae3a's own diff did
   NOT touch: navigate() closed the question navigator but never closed
   Directions, so clicking Next (or Back, or jumping via the navigator) left
   Directions hanging open over the next question, and clicking anywhere
   outside the dropdown that wasn't literally the dir-overlay's own DOM
   (header controls, footer buttons) did nothing either. Cases B and C are
   the control for that fix: FAIL on the build before it, PASS after.

   CASE E — a second, more serious bug the adversarial review of the first
   attempt at this fix caught before it shipped: that first attempt closed
   Directions on "mousedown" (copying the moreMenu/hlPopup pattern below).
   dirOverlay is a full-pane scrim laid OVER the live answer choices, not a
   small anchored popup, so closing it on mousedown hides the scrim
   mid-gesture — the browser then re-hit-tests the pending mouseup/click
   against whatever is newly exposed underneath. Measured live: dismissing
   Directions with a click over a covered answer choice SELECTED that
   choice, and the wrong answer survived a reload. Fixed by dismissing on
   "click" instead, which resolves the target before anything closes. Case E
   is the regression guard for that: FAILS on the mousedown-based attempt,
   PASSES on the shipped click-based fix.

   WHY A CONSOLE HARNESS, NOT A NODE TEST
   navigate()/openDirections()/closeDirections()/openQnav() are private
   closures inside app.js's single IIFE, deeply coupled to live state
   (currentModule(), renderTest(), the real DOM) — see tests/drag-harness.js
   for the established precedent of testing this surface by driving the real
   app in a browser rather than extracting functions into an isolated harness.

   Event sequence discipline (tests/drag-harness.js's rule 1/2, same reason
   here): dispatch mousedown -> mouseup -> click, and resolve each event's
   target with elementFromPoint AT DISPATCH TIME, not resolved once up front
   — a click can itself trigger a re-render that detaches the node a
   pre-resolved target pointed to.
*/
(function(){
  "use strict";

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);

  function fire(type, pt, target){
    const el = target || document.elementFromPoint(pt.x, pt.y);
    if(!el) return "NO-TARGET";
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: pt.x, clientY: pt.y, button: 0
    }));
    return el.tagName + (el.id ? "#" + el.id : (el.className ? "." + String(el.className).split(/\s+/)[0] : ""));
  }

  async function click(target, pt){
    const p = pt || (()=>{ const r = target.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })();
    fire("mousedown", p, document.elementFromPoint(p.x, p.y));
    fire("mouseup", p, document.elementFromPoint(p.x, p.y));
    fire("click", p, document.elementFromPoint(p.x, p.y));
    await sleep(150);
  }

  function dirOpen(){ return !$("dirOverlay").classList.contains("hidden"); }
  function qnavOpen(){ return !$("qnavPopup").classList.contains("hidden") || !$("qnavOverlay").classList.contains("hidden"); }
  /* showOnly() (app.js) toggles which top-level screen is visible but does not
     clear the others' inner markup, so a stale #paneRight from a PREVIOUS
     module's Check Your Work can still match ".review-wrap h1" after the
     module has moved on (submitted, into a break, etc). Require screen-test
     to actually be the visible screen before trusting that selector. */
  function onReviewPage(){
    return !$("screen-test").classList.contains("hidden") && !!document.querySelector(".review-wrap h1");
  }
  async function ensureDirOpen(){
    if(!dirOpen()) await click($("dirToggle"));
  }
  async function ensureDirClosed(){
    if(dirOpen()) await click($("dirCloseBtn") || $("dirToggle"));
  }

  async function run(){
    const results = [];
    const ok = (name, pass, note) => results.push({ case: name, pass, note });

    if($("screen-test").classList.contains("hidden")){
      ok("precondition: a module is open", false, "open a module first");
      console.table(results); return { pass: false, results };
    }

    /* ---- Case A: Directions starts open at module entry (documented
       behaviour, not itself a bug) — recorded for context, not scored. */
    results.push({ case: "context: Directions opens automatically at module start",
      pass: true, note: "not scored — establishing behaviour only" });

    /* Normalize to question 1 of whatever module is current, regardless of
       where the harness happened to be started — Cases B/C must not land on
       the LAST question, or their Next click would submit the module (via
       Check Your Work) instead of the simple same-module advance they mean
       to test, taking the rest of the run with it. */
    if(onReviewPage()){
      const rg = $("reviewGrid");
      if(rg && rg.children.length) await click(rg.children[0]);
    } else {
      await click($("qnavBtn"));
      const g0 = $("qnavGrid");
      if(g0 && g0.children.length) await click(g0.children[0]);
    }

    /* ---- Case B: clicking Next closes an open Directions AND still
       advances navigation. Work Item 3, primary control. */
    await ensureDirOpen();
    const bBeforeOpen = dirOpen();
    const bLabelBefore = $("qnavBtnLabel") ? $("qnavBtnLabel").textContent : null;
    await click($("btnNext"));
    const bAfterOpen = dirOpen();
    const bLabelAfter = $("qnavBtnLabel") ? $("qnavBtnLabel").textContent : null;
    const bAdvanced = onReviewPage() /* landed on Check Your Work */
      || (bLabelBefore && bLabelAfter && bLabelBefore !== bLabelAfter); /* or moved to the next question */
    ok("Next closes an open Directions dropdown",
       bBeforeOpen && !bAfterOpen,
       `open before: ${bBeforeOpen}, open after Next: ${bAfterOpen}`);
    ok("Next still advances while Directions was open",
       !!bAdvanced,
       `label ${bLabelBefore} -> ${bLabelAfter}` + (onReviewPage() ? " (reached Check Your Work)" : ""));

    /* ---- Case C: a click outside the panel — NOT on Next, NOT a
       navigation action — also closes Directions. Work Item 3, secondary
       control. Click the .battery text specifically (not .th-right's
       bounding-box center) — .th-right also holds #thTools, which on a Math
       module holds the live Calculator/Reference toggle buttons; a center
       click could land on one of those instead of blank chrome and pop a
       panel as an unrelated side effect on top of whatever this run does
       next. .battery is plain text with no handler, so it is always safe. */
    await ensureDirOpen();
    const cBeforeOpen = dirOpen();
    const battery = document.querySelector(".t-header .battery") || document.querySelector(".t-header");
    if(battery){
      const r = battery.getBoundingClientRect();
      await click(null, { x: r.left + r.width/2, y: r.top + r.height/2 });
    }
    const cAfterOpen = dirOpen();
    ok("clicking outside the panel (header area) closes Directions",
       cBeforeOpen && !cAfterOpen,
       `open before: ${cBeforeOpen}, open after outside click: ${cAfterOpen}`);
    await ensureDirClosed();

    /* ---- Case E: REGRESSION GUARD for the click-through corruption bug
       found reviewing this very fix. dirOverlay is a full-pane scrim laid
       OVER the live answer choices in #paneRight, not a small anchored
       popup — closing it on "mousedown" (the first attempt at this fix,
       copied from the moreMenu/hlPopup pattern below) hides the scrim
       mid-gesture, so the browser re-hit-tests the pending mouseup/click
       against whatever is newly exposed underneath. Measured live: a
       mousedown/mouseup/click at a point over an answer choice — covered by
       the scrim, NOT the panel — SELECTED that choice once the scrim closed
       out from under the gesture, silently corrupting the student's answer,
       and the wrong selection survived a reload. Fixed by dismissing on
       "click" instead (resolved before anything closes). This case proves
       it stays fixed: dismiss Directions via a click over a covered choice,
       and that choice must NOT become selected. */
    await ensureDirOpen();
    const choices = Array.from(document.querySelectorAll("#paneRight .choice"));
    const panelE = $("dirPanel");
    const target = choices.find(c => {
      const r = c.getBoundingClientRect();
      const px = r.right - 15, py = r.top + r.height / 2;
      return !panelE.getBoundingClientRect ? false :
        px > panelE.getBoundingClientRect().right && document.elementFromPoint(px, py) &&
        document.elementFromPoint(px, py).id === "dirOverlay";
    });
    if(target){
      const r = target.getBoundingClientRect();
      const pt = { x: r.right - 15, y: r.top + r.height / 2 };
      const wasSelected = target.classList.contains("selected");
      await click(null, pt);
      const isSelectedNow = target.classList.contains("selected");
      ok("dismissing Directions via a click over a covered choice does not select it",
         !isSelectedNow || wasSelected,
         wasSelected ? "precondition: choice was already selected before this case — inconclusive"
                     : `selected after dismiss-click: ${isSelectedNow}`);
    } else {
      ok("dismissing Directions via a click over a covered choice does not select it",
         true, "SKIPPED — no choice found positioned under the scrim but outside the panel at this viewport size");
    }
    await ensureDirClosed();

    /* ---- Case D: REGRESSION GUARD for f48ae3a (Work Item 2). Opening the
       navigator on the module's LAST question and clicking Next reaches
       Check Your Work (or submits, if already on Check Your Work) in ONE
       click — popup closes, no re-navigation, no wrap to question 1.
       Case B may itself have already reached Check Your Work (e.g. if the
       harness started on the last question already) — jump back to a
       question via the review grid first so qnavBtn is live again. */
    if(onReviewPage()){
      const reviewGrid = $("reviewGrid");
      if(reviewGrid && reviewGrid.children.length) await click(reviewGrid.children[0]);
    }
    await click($("qnavBtn"));
    const grid = $("qnavGrid");
    const total = grid ? grid.children.length : 0;
    if(total > 0){
      const lastCell = grid.children[total - 1];
      await click(lastCell);   // jumps to the last question, closes the popup as a side effect
      ok("jumping to the last question via the navigator closes the popup",
         !qnavOpen(), `qnav open after jump: ${qnavOpen()}`);
      // reopen the navigator while sitting on the last question
      await click($("qnavBtn"));
      const dOpenBefore = qnavOpen();
      const dLabelBefore = $("qnavBtnLabel") ? $("qnavBtnLabel").textContent : null;
      await click($("btnNext"));
      const dOpenAfter = qnavOpen();
      const reachedReview = !!onReviewPage();
      const wrappedToQ1 = !reachedReview && $("qnavBtnLabel") && /Question 1 of/.test($("qnavBtnLabel").textContent);
      ok("Next from the last question (navigator open) reaches Check Your Work in one click",
         dOpenBefore && !dOpenAfter && reachedReview && !wrappedToQ1,
         `popup open before: ${dOpenBefore}, after: ${dOpenAfter}; label ${dLabelBefore} -> ` +
         (reachedReview ? "Check Your Work" : ($("qnavBtnLabel") ? $("qnavBtnLabel").textContent : "?")) +
         (wrappedToQ1 ? " — WRAPPED TO Q1" : ""));
    } else {
      ok("Next from the last question (navigator open) reaches Check Your Work in one click",
         false, "could not read the navigator grid — is a module open?");
    }

    const failed = results.filter(r => !r.pass);
    console.table(results);
    console.log(failed.length ? "FAIL — " + failed.length + " case(s)"
                              : "ALL PASS — " + results.length + " cases");
    return { pass: failed.length === 0, results };
  }

  window.OverlayDismissHarness = { run, click, dirOpen, qnavOpen, onReviewPage };
  console.log("OverlayDismissHarness ready — run OverlayDismissHarness.run() with a module open.");
})();
