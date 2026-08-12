/* Drag/annotation regression harness — paste into the console with a Reading
   and Writing module open (dist/index-live.html or the live site).

   WHY THIS FILE EXISTS
   On 2026-08-08 a verification of choice highlighting dispatched `mouseup` on
   `document` and nothing else. It reported green on a build where dragging
   inside an answer choice could NEVER produce a highlight and silently rewrote
   the student's recorded answer on every attempt. The check proved nothing
   while looking like it proved everything.

   The two rules that failure teaches, both enforced below:

   1. A real drag emits `mousedown -> mousemove -> mouseup -> click`. The
      `click` is not incidental — it is the event that reaches the .choice
      handler. Omitting it tests a sequence no browser produces.

   2. Resolve each event's target with elementFromPoint AT DISPATCH TIME.
      Creating a highlight splits and rewraps the text node, so a target
      captured before the drag is already detached by the click; the click then
      goes nowhere and the answer-selection half looks broken when it is fine.
      This produced a false regression report on the same day.

   And the rule for the harness itself: before trusting a pass, make it FAIL.
   Build the previous commit into a git worktree, serve both, and require every
   case here to fail on the build that lacks the fix. A green from an unvalidated
   harness is worth less than no check at all.

   Usage:  DragHarness.run()        -> runs every case, returns {pass, results}
           DragHarness.drag(sel)    -> one full drag inside the first free text
                                       node under `sel`
*/
(function(){
  "use strict";

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);

  /* every event target resolved fresh — see rule 2 above */
  function fire(type, pt){
    const el = document.elementFromPoint(pt.x, pt.y);
    if(!el) return "NO-TARGET";
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: pt.x, clientY: pt.y, button: 0,
      buttons: type === "mouseup" || type === "click" ? 0 : 1
    }));
    return el.tagName + (el.className ? "." + String(el.className).split(/\s+/)[0] : "");
  }

  async function dragRange(range){
    const r = range.getBoundingClientRect();
    const from = { x: r.left + 1,  y: r.top + r.height / 2 };
    const to   = { x: r.right - 1, y: r.top + r.height / 2 };
    const log = {};
    log.down = fire("mousedown", from);
    log.move = fire("mousemove", to);
    // a real drag leaves this selection in place when the button is released
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(range);
    log.up = fire("mouseup", to);
    log.click = fire("click", to);      // <- rule 1: the whole mechanism
    await sleep(300);
    return log;
  }

  function freeTextNode(host, minLen){
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    while(w.nextNode()){
      const n = w.currentNode;
      if(n.nodeValue.trim().length > (minLen || 8) && !n.parentElement.closest(".hl")) return n;
    }
    return null;
  }

  async function drag(sel, len){
    const host = document.querySelector(sel);
    if(!host) return { error: "no region for " + sel };
    const tn = freeTextNode(host, 8);
    if(!tn) return { error: "no free text node in " + sel };
    const a = tn.nodeValue.search(/\S/);
    const range = document.createRange();
    range.setStart(tn, a);
    range.setEnd(tn, Math.min(tn.nodeValue.length, a + (len || 12)));
    const text = range.toString();
    return { text, targets: await dragRange(range) };
  }

  const probe = () => ({
    stemHl:    document.querySelectorAll("#paneRight .q-text .hl").length,
    choiceHl:  [...document.querySelectorAll("#paneRight .choice")].map(c => c.querySelectorAll(".ctext .hl").length),
    passageHl: document.querySelectorAll("#passageText .hl").length,
    selected:  [...document.querySelectorAll("#paneRight .choice")].map((c, i) => c.classList.contains("selected") ? i : -1).filter(i => i >= 0),
    elim:      [...document.querySelectorAll("#paneRight .choice")].map((c, i) => c.classList.contains("eliminated") ? i : -1).filter(i => i >= 0),
    popup:     !$("hlPopup").classList.contains("hidden"),
    hlMode:    $("tBody").classList.contains("hl-mode")
  });

  const setHlMode = async on => {
    if($("tBody").classList.contains("hl-mode") !== on){ $("hlModeBtn").click(); await sleep(250); }
  };
  const dismissPopup = () => $("hlPopup").classList.add("hidden");

  async function run(){
    const results = [];
    const ok = (name, pass, note) => results.push({ case: name, pass, note });

    if($("screen-test").classList.contains("hidden")) {
      ok("precondition: a module is open", false, "open a Reading and Writing module first");
      console.table(results); return { pass: false, results };
    }
    // the directions overlay swallows hit-testing while it is up
    if($("dirCloseBtn")) { $("dirCloseBtn").click(); await sleep(300); }

    /* 1 — a drag inside a choice highlights AND selects that choice.
       Both halves matter: Bluebook selects the choice on a drag, so a fix that
       suppressed the click would be wrong in the other direction. */
    await setHlMode(true);
    const idx = 3;
    const before = probe();
    await drag(`#paneRight .choice[data-idx="${idx}"] .ctext`);
    const after = probe();
    ok("drag in a choice creates a highlight",
       after.choiceHl[idx] > before.choiceHl[idx],
       `choice ${idx}: ${before.choiceHl[idx]} -> ${after.choiceHl[idx]} highlight(s)`);
    ok("drag in a choice also selects it as the answer",
       after.selected.includes(idx),
       `selected: [${after.selected.join(",")}]`);

    /* 2 — stem and passage still highlight */
    const bs = probe(); await drag("#paneRight .q-text"); const as_ = probe();
    ok("drag in the stem creates a highlight", as_.stemHl > bs.stemHl, `${bs.stemHl} -> ${as_.stemHl}`);
    const bp = probe(); await drag("#passageText"); const ap = probe();
    ok("drag in the passage creates a highlight", ap.passageHl > bp.passageHl, `${bp.passageHl} -> ${ap.passageHl}`);

    /* 3 — a drag INSIDE an existing highlight must not open the edit popup
       while in highlight mode. The sync highlight path clears the selection,
       which stops the click-to-edit "a selection is live, stand down" guard
       from holding; without a gesture flag the popup opens on whichever span
       the pointer resolves to and the next swatch or trash hits the wrong one. */
    await setHlMode(true); dismissPopup();
    /* Build a FRESH outer highlight rather than reusing whichever .hl happens
       to be first. On a resumed sitting that span may already have been split
       by an earlier nested highlight, leaving a firstChild text node one
       character long — the sub-range below then collapses, handleSelection
       bails at its isCollapsed guard, no highlight is created, the gesture
       flag is never set, and the trailing click correctly opens click-to-edit.
       That is a harness artifact which reads EXACTLY like the bug this case
       exists to catch, so the case asserts its own preconditions: an unsplit
       text node to nest in, and a nested highlight actually created. A pass
       must not be obtainable from nothing happening. */
    await drag("#passageText", 18);
    const outers = [...document.querySelectorAll("#passageText .hl")]
      .filter(s => s.firstChild && s.firstChild.nodeType === 3 && s.firstChild.nodeValue.length >= 8);
    const outer = outers[outers.length - 1];
    if(!outer){
      ok("nested drag in highlight mode does not open the edit popup", false,
         "precondition: no highlight with an unsplit text node to nest inside");
    } else {
      const t = outer.firstChild;
      const hlBefore = probe().passageHl;
      const r = document.createRange();
      r.setStart(t, 1); r.setEnd(t, Math.min(t.nodeValue.length, 6));
      if(r.collapsed){
        ok("nested drag in highlight mode does not open the edit popup", false,
           "precondition: the nested sub-range came out collapsed");
      } else {
        await dragRange(r);
        const made = probe().passageHl > hlBefore;
        const popped = probe().popup;
        ok("nested drag in highlight mode does not open the edit popup",
           made && !popped,
           !made ? "precondition: the nested drag created no highlight"
                 : (popped ? "popup opened — it will act on the wrong span"
                           : "suppressed, and the nested highlight was created"));
        ok("nested drag still leaves the outer highlight intact",
           document.body.contains(outer), "outer span still in the document");
      }
    }

    /* 4 — refusals */
    await setHlMode(false); dismissPopup();
    const c1 = freeTextNode(document.querySelector('#paneRight .choice[data-idx="1"] .ctext'), 6);
    const c2 = freeTextNode(document.querySelector('#paneRight .choice[data-idx="2"] .ctext'), 6);
    if(c1 && c2){
      const r = document.createRange(); r.setStart(c1, 0); r.setEnd(c2, Math.min(6, c2.nodeValue.length));
      const pre = probe(); await dragRange(r); const post = probe();
      ok("a selection spanning two choices is refused",
         !post.popup && JSON.stringify(pre.choiceHl) === JSON.stringify(post.choiceHl), "no popup, no new highlight");
    } else ok("a selection spanning two choices is refused", false, "could not build a cross-choice range");

    dismissPopup();
    const band = document.querySelector(".q-head");
    const bt = band && freeTextNode(band, 4);
    if(bt){
      const r = document.createRange(); r.setStart(bt, 0); r.setEnd(bt, Math.min(5, bt.nodeValue.length));
      await dragRange(r);
      ok("the header band is not highlightable", !probe().popup, "no popup on Mark for Review");
    } else ok("the header band is not highlightable", true, "band has no selectable text node");

    /* 4b — a drag that crosses a BLOCK boundary must be refused. Wrapping such
       a range splits every partially-selected block ancestor, which used to
       rebuild a 4x5 table as six rows with numbers torn across them, save that
       markup, and lose the highlight anyway. Only runs on a table-bearing
       passage; skipped elsewhere rather than silently passing. */
    await setHlMode(true); dismissPopup();
    const table = document.querySelector("#passageText table");
    if(table){
      const rows = [...table.querySelectorAll("tr")];
      const shape = () => [...table.querySelectorAll("tr")].map(r => r.children.length).join(",");
      const before = shape(), beforeHl = probe().passageHl;
      const a = rows[1] && freeTextNode(rows[1].children[1], 2);
      const b = rows[2] && freeTextNode(rows[2].children[2], 2);
      if(a && b){
        const r = document.createRange();
        r.setStart(a, 0); r.setEnd(b, Math.min(3, b.nodeValue.length));
        await dragRange(r);
        ok("a drag across two table cells is refused, table intact",
           shape() === before && probe().passageHl === beforeHl,
           shape() === before ? `table still ${before}` : `table SHREDDED: ${before} -> ${shape()}`);
      } else ok("a drag across two table cells is refused, table intact", false, "could not build a cross-cell range");
      // and a drag INSIDE one cell must still highlight
      const c = freeTextNode(rows[1].children[1], 2);
      if(c){
        const h0 = probe().passageHl;
        const r2 = document.createRange();
        r2.setStart(c, 0); r2.setEnd(c, Math.min(4, c.nodeValue.length));
        await dragRange(r2);
        ok("a drag inside one table cell still highlights",
           probe().passageHl > h0, `${h0} -> ${probe().passageHl}`);
      }
    } else {
      results.push({ case: "a drag across two table cells is refused, table intact",
        pass: true, note: "SKIPPED — this passage has no table (open a table question to cover it)" });
    }

    /* 5 — click-to-edit still works outside highlight mode (the gesture flag
       must not swallow an ordinary click on an existing highlight) */
    await setHlMode(false); dismissPopup();
    const hl = document.querySelector("#paneRight .q-text .hl") || document.querySelector("#passageText .hl");
    if(hl){
      const r = hl.getBoundingClientRect(); const p = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      fire("mousedown", p); fire("mouseup", p); fire("click", p);
      await sleep(300);
      ok("clicking an existing highlight still opens the edit popup", probe().popup, "popup opened");
    } else ok("clicking an existing highlight still opens the edit popup", false, "no highlight to click");
    dismissPopup();

    const failed = results.filter(r => !r.pass);
    console.table(results);
    console.log(failed.length ? "FAIL — " + failed.length + " case(s)"
                              : "ALL PASS — " + results.length + " drag cases");
    return { pass: failed.length === 0, results };
  }

  window.DragHarness = { run, drag, dragRange, probe, fire };
  console.log("DragHarness ready — run DragHarness.run() with a Reading and Writing module open.");
})();
