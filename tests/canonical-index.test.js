/* tests/canonical-index.test.js — run: node tests/canonical-index.test.js (repo root)

   Canonical-id awareness in the dashboard (2026-09-07): the read-only
   derivations over testdata/dedup-index.js and the loaded attempt records.
   The functions are pulled out of dashboard.js by source text (the
   tutor-writes harness pattern) and run against the REAL committed index,
   manifest, test files and render.js escapeHtml, so the proof case is the
   one David asked for:

     a student who sat 2025 June Asia v2 (202506asiav2), then is offered
     2025 June Asia v4 (202506asiav4): every RW2 overlap the index carries
     is derived — 16 identical items (same canonical id) and 9 reskins
     (family siblings), pinned pair by pair below, none in RW1 or Math.

   THE PINS ARE THE POINT. The expected pairs below are written out by hand
   from the committed index, not derived from it, so a canonical id that
   moves under a pinned item fails this file. Re-pin deliberately, from the
   index, when an export legitimately changes them — and say which export.
   History: 5b41a30 (2026-09-07) pinned 15 + 10; 28d192d (2026-09-08)
   bumped 202506asiav2 and fixed its re2-q8 choice B OCR join "acritical"
   -> "a critical", which made v4 re2-q7 = v2 re2-q8 EXACT (16 + 9, the
   pair David had called identical all along); 8d45238 (2026-09-24) linked
   202503usv1 re2-q1 to v2 re2-q4 as a reskin, so the "clean form" control
   moved to 202511asiav1. Nobody re-pinned, and the file failed 20 checks
   until 2026-09-30.
   To watch a pin catch a move, point the harness at a planted index:
     DEDUP_INDEX_SRC=<scratch>/dedup-index-planted.js node tests/canonical-index.test.js

   Then the contracts around it:
     1. only COMPLETED (or timed-out) attempts count; in-progress never;
     2. a legacy testId resolves through the manifest on EVERY index lookup:
        a form record, a set snapshot ref and a saved set ref alike;
     3. a SET attempt contributes its frozen snapshot refs (form and bank);
        an unknown ref is counted "unindexed" AND surfaced as a caveat,
        never silently unseen;
     4. the builder holds ONE entry per canonical item, form AND bank
        questions alike (within a form, across forms, bank <-> form and
        bank <-> bank; 2026-09-30 — until then bank rows were left out of
        the grouping as v1 scope), symmetric in click order, and copies
        that got in anyway are called out;
     5. provenance strings: "also in" = exact class, "reskin of" = family
        outside the class; a ruled-DISTINCT pair shares a family but not a
        canonical id;
     6. honest degradation: malformed / unfetchable / timed-out / empty
        index -> one notice with the right remedy, marks off, nothing
        throws; a late-arriving index is adopted; Refresh re-arms a
        network failure; a stale index names the form it predates AND the
        form it was built against a different version of; an async settle
        never wipes what the tutor typed;
     7. every string from the index or a record is escaped on every new
        innerHTML site (hostile ref, family, set name, attempt id);
     8. a record-derived student code named like an Object.prototype
        property is just a code;
     9. a retake counts each form item once per source attempt;
    10. bank items are SEEN exactly as form items are: a form sitting marks
        its bank twin, a set sitting's bank item marks its form twin, and
        the RENDERED picker row and the set's own ref row carry the mark and
        the provenance;
    11. a RETIRED bank item never enters a set: no Add in the picker (nor
        while a save is in flight), pushRef refuses one this page knows is
        retired — including after a save's re-read revealed it — the named
        replacement is the LIVE end of the supersededBy chain, the Sets-list
        report says how many sets hold one and which, and every new string
        on those surfaces is escaped. (The save-time refusal itself is
        tests/tutor-writes.test.js §9f.)

   To watch this fail on the pre-feature dashboard:
     git show 8915e95:dashboard.js > <scratch>/dashboard-pre.js
     DASHBOARD_SRC=<scratch>/dashboard-pre.js node tests/canonical-index.test.js
   and on the first-cut feature (5b41a30) for the review fixes:
     git show 5b41a30:dashboard.js > <scratch>/dashboard-v1.js
     DASHBOARD_SRC=<scratch>/dashboard-v1.js node tests/canonical-index.test.js */
"use strict";
const fs = require("fs");
const vm = require("vm");
const { extractFn, extractConst } = require("./extract-helper");

const SRC_PATH = process.env.DASHBOARD_SRC || "dashboard.js";
const src = fs.readFileSync(SRC_PATH, "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}
function run(label, fn){
  try{ fn(); }
  catch(e){ check(false, label + " — case could not run: " + (e && e.stack || e)); }
}

/* ---- the real index, manifests, test files and escapeHtml, as the browser gets them ---- */
function loadScript(file){
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, "utf8"), ctx);
  return ctx;
}
const INDEX_PATH = process.env.DEDUP_INDEX_SRC || "testdata/dedup-index.js";
const REAL_INDEX = loadScript(INDEX_PATH).window.DEDUP_INDEX;
const BANK_INDEX = loadScript("testdata/bank-index.js").window.BANK_INDEX;
const TEST_MANIFEST = loadScript("testdata/manifest.js").window.TEST_MANIFEST;
const BANK_MANIFEST = loadScript("testdata/bank-manifest.js").window.BANK_MANIFEST;
const escapeHtml = loadScript("render.js").escapeHtml;       // the real one: escapes & < > " '
if(typeof escapeHtml !== "function") throw new Error("render.js did not define escapeHtml");
const nameOf = id => (TEST_MANIFEST.find(t => t.testId === id) || {}).testName;
const questionIdsCache = {};
function questionIds(testId){
  if(!questionIdsCache[testId]){
    const w = loadScript("testdata/" + testId + ".js").window;
    const t = (w.__TESTDATA__ || {})[testId];
    questionIdsCache[testId] = t.modules.reduce((acc, m) => acc.concat(m.questions.map(q => q.id)), []);
  }
  return questionIdsCache[testId];
}
/* a completed FORM record's answers map: one entry per question of every
   module, exactly as attempts.js writes it */
function answersFor(testId){
  const a = {};
  questionIds(testId).forEach(id => { a[id] = { given: null, correct: null }; });
  return a;
}

/* ---- the dashboard closure, rebuilt per case from the real source ---- */
const NAMES = ["ensureDedupLoaded", "adoptDedup", "rearmDedup", "onDedupSettled", "renderKeepingInputs",
  "normalizeDedupIndex", "splitRef", "manifestEntry", "canonRef", "indexItem", "formRefs", "refText", "canonInfo",
  "provHtml", "completedAttemptsOf", "recordAnswerKeys", "attemptRefs", "attemptLabel", "seenSetFor", "seenCaveat",
  "markFor", "seenCounts", "countsText", "viaText", "markHtml", "selectedStudent", "setRefKeys",
  "dedupNoticeHtml", "overlapFor", "assignOverlapHtml", "overlapNotes", "refreshAssignOverlap",
  "builderHeldAs", "pushRef", "builderDuplicateGroups", "builderAddRef", "refKey", "fmtDay", "nameFor",
  "studentCell", "codeOptionLabel", "formCodes",
  // tombstones (2026-09-18): the seen set and the code pickers read these
  "tombFor", "isDeletedStudent", "isTombstoned", "deletedAttemptsOf",
  // retired bank items + the builder view itself (2026-09-30)
  "bankEntryIn", "isRetiredBankRef", "retiredRefsOf", "retiredRefText", "bankStatusBadge", "refLabel", "stripTokens",
  "qIndex", "ensureTestLoaded", "viewSetBuilder",
  "bankEntryOf", "liveReplacement", "bankIndexReReadable", "retiredSetsNoticeHtml"];
const CONSTS = ["esc", "escAttr", "MARKS", "DEDUP_FETCH_TIMEOUT_MS", "KEPT_VALUES", "KEPT_CHECKS", "KEPT_MULTI", "qIndexes",
  "BANK_INDEX_URL", "BANK_INDEX_TIMEOUT_MS"];
const extracted = NAMES.map(n => { try{ return [n, extractFn(src, n)]; }catch(e){ return [n, ""]; } });
const BODY = extracted.map(x => x[1]).join("\n") + "\n" +
  CONSTS.map(n => { try{ return extractConst(src, n); }catch(e){ return ""; } }).join("\n");
const PRESENT = extracted.filter(x => x[1] !== "").map(x => x[0]);

const StudentCode = {
  valid: c => /^AS-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(String(c || "").trim().toUpperCase()),
  normalize: c => String(c || "").trim().toUpperCase().replace(/\s+/g, "")
};
/* a <select multiple> stub whose selectedOptions follow its options' selected
   flags, as the DOM's do */
function mkSelect(values, selected){
  const el = { options: values.map(v => ({ value: v, selected: (selected || []).indexOf(v) !== -1 })), value: "" };
  Object.defineProperty(el, "selectedOptions", { get(){ return el.options.filter(o => o.selected); } });
  return el;
}

function build(opts){
  opts = opts || {};
  const els = {};
  const $ = id => els[id] || (els[id] = { value: "", innerHTML: "", textContent: "", checked: false, selectedOptions: [], focus(){} });
  const scripts = [], timers = [];
  /* a document whose appended <script> reports what the case wants:
     "error" (404/offline), "empty" (loaded, registered nothing), "hang"
     (never settles — the case fires the captured timer itself), or "ok"
     (registers the given index) */
  const documentStub = {
    createElement: () => ({ remove(){}, onload: null, onerror: null, src: "", async: false }),
    head: { appendChild(s){
      scripts.push(s);
      const mode = opts.fetch || "error";
      if(mode === "error") s.onerror();
      else if(mode === "empty") s.onload();
      else if(mode === "ok"){ windowStub.DEDUP_INDEX = opts.fetched; s.onload(); }
      /* "hang": nothing */
    } }
  };
  /* the page loads bank-index.js at startup (index.html), so the dashboard
     always has window.BANK_INDEX — the real one here */
  const windowStub = { TEST_MANIFEST: opts.manifest || TEST_MANIFEST, BANK_MANIFEST: opts.banks || BANK_MANIFEST,
                       BANK_INDEX: opts.bankIndex || BANK_INDEX };
  if(opts.inlined) windowStub.DEDUP_INDEX = opts.inlined;
  const setTimeoutStub = (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; };
  const clearTimeoutStub = id => { if(timers[id - 1]) timers[id - 1].cleared = true; };
  const factory = new Function("window", "document", "$", "escapeHtml", "StudentCode", "setTimeout", "clearTimeout", "wipe", "BANK_INDEX", `
    let recs = [], profiles = {}, builder = null, tab = ${JSON.stringify(opts.tab || "sets")}, tombs = {}, sets = [];
    let builderTestId = "", openAttemptId = null, bankIndexFresh = null;
    const fullTests = {}, loadingTests = {};
    const loads = { render: 0 };
    const testsById = {};
    (window.TEST_MANIFEST || []).forEach(t => { testsById[t.testId] = t; (t.legacyIds || []).forEach(old => { testsById[old] = t; }); });
    /* the section's module state, declared as dashboard.js declares it */
    let dedup = null, dedupState = "idle", dedupNote = "", dedupTransient = false, dedupRaw = null, overlapSig = null;
    /* the real render() rebuilds #dashBody, so every DOM-only value is lost:
       model that, so renderKeepingInputs' restore is actually exercised */
    function render(){ loads.render++; wipe(); }
    ${BODY}
    const fns = {};
    ${PRESENT.map(n => `fns[${JSON.stringify(n)}] = ${n};`).join("\n")}
    return {
      fns, loads,
      state: () => ({ dedup, dedupState, dedupNote, dedupTransient, recs, builder, tab }),
      seed: o => {
        if("recs" in o) recs = o.recs; if("builder" in o) builder = o.builder; if("tab" in o) tab = o.tab;
        if("sets" in o) sets = o.sets; if("bankIndexFresh" in o) bankIndexFresh = o.bankIndexFresh;
        if("profiles" in o) profiles = o.profiles;
      }
    };
  `);
  const wipe = () => Object.keys(els).forEach(id => {
    const el = els[id];
    el.value = ""; el.innerHTML = ""; el.checked = false;
    if(el.options) el.options.forEach(o => { o.selected = false; }); else el.selectedOptions = [];
  });
  const d = factory(windowStub, documentStub, $, escapeHtml, StudentCode, setTimeoutStub, clearTimeoutStub, wipe,
    windowStub.BANK_INDEX);   // a browser page reads window globals bare too (dashboard.js says BANK_INDEX.entries)
  d.els = els; d.$ = $; d.scripts = scripts; d.timers = timers; d.window = windowStub;
  return d;
}
const CODE = "AS-TESTSEEN";
const OTHER = "AS-OTHERKID";
function formRec(testId, status, extra){
  const canon = (TEST_MANIFEST.find(t => t.testId === testId || (t.legacyIds || []).indexOf(testId) !== -1) || {}).testId;
  return Object.assign({ recordVersion: 1, attemptId: "attempt:" + testId + ":1700000000:t1",
    student: { code: CODE, key: CODE }, testId: testId, testName: "(record name)", testVersion: "x",
    status: status || "completed", startedAt: "2026-09-01T10:00:00.000Z", submittedAt: "2026-09-01T12:30:00.000Z",
    modules: [], answers: canon ? answersFor(canon) : {}, score: null }, extra || {});
}

/* ======================= the proof case ======================= */
/* pinned from the committed index (f64c512, 2026-09-30) — see the header */
const EXACT_V4_V2 = [   // 202506asiav4 RW2 item  =  its canonical on 202506asiav2
  ["re2-q1", "re2-q1"], ["re2-q2", "re2-q2"], ["re2-q3", "re2-q3"], ["re2-q4", "re2-q4"],
  ["re2-q6", "re2-q7"], ["re2-q7", "re2-q8"], ["re2-q11", "re2-q12"], ["re2-q12", "re2-q14"],
  ["re2-q13", "re2-q15"], ["re2-q14", "re2-q16"], ["re2-q15", "re2-q17"], ["re2-q17", "re2-q19"],
  ["re2-q18", "re2-q20"], ["re2-q20", "re2-q22"], ["re2-q21", "re2-q23"], ["re2-q22", "re2-q24"]
];
const SKELETON_V4_V2 = [   // 202506asiav4 RW2 item  ~  its reskin on 202506asiav2
  ["re2-q5", "re2-q6"], ["re2-q8", "re2-q9"], ["re2-q9", "re2-q10"], ["re2-q10", "re2-q11"],
  ["re2-q16", "re2-q18"], ["re2-q19", "re2-q21"], ["re2-q24", "re2-q25"], ["re2-q26", "re2-q26"],
  ["re2-q27", "re2-q27"]
];
/* a form that shares NOTHING with 202506asiav2 — no class, no family */
const CLEAN_VS_V2 = "202511asiav1";
/* the bank <-> form class the 2026-09-30 grouping exists for */
const BANK_TWIN = "bank-202608-salvage:q0049", FORM_TWIN = "202412usv2:re2-q25";
/* a bank <-> bank class: q0032 was retired 2026-09-12 as supersededBy q0202 */
const RETIRED = "bank-202608-salvage:q0032", REMINT = "bank-202608-salvage:q0202";
const bankRef = k => ({ type: "bank", bankId: k.split(":")[0], qid: k.split(":")[1] });
console.log("--- proof: 202506asiav4 offered after a completed 202506asiav2 sitting ---");
run("proof", () => {
  const d = build({ inlined: REAL_INDEX });
  d.seed({ recs: [formRec("202506asiav2")] });
  d.fns.ensureDedupLoaded();
  check(d.state().dedupState === "ready" && d.scripts.length === 0,
    "an inlined window.DEDUP_INDEX is adopted synchronously — no fetch");
  check(d.fns.attemptRefs(formRec("202506asiav2")).length === 98, "a completed form record exposes the 98 questions its answers map holds");
  const o = d.fns.overlapFor(CODE, "202506asiav4");
  check(!!o && o.total === 98 && o.attempts === 1 && o.caveat === "", "the offered form has 98 indexed items; one completed attempt counted; nothing unindexed",
    o && JSON.stringify({ total: o.total, attempts: o.attempts, caveat: o.caveat }));
  const seenPairs = o.seenItems.map(x => [x.ref.split(":")[1], x.via[0].ref.split(":")[1]]).sort();
  check(JSON.stringify(seenPairs) === JSON.stringify(EXACT_V4_V2.slice().sort()),
    "SEEN: exactly the 16 identical RW2 items, each traced to its 202506asiav2 canonical", "got " + JSON.stringify(seenPairs));
  const reskinPairs = o.reskinItems.map(x => [x.ref.split(":")[1], x.via[0].ref.split(":")[1]]).sort();
  check(JSON.stringify(reskinPairs) === JSON.stringify(SKELETON_V4_V2.slice().sort()),
    "RESKIN: exactly the 9 family siblings in RW2, each traced to its 202506asiav2 reskin", "got " + JSON.stringify(reskinPairs));
  check(o.seenItems.concat(o.reskinItems).every(x => x.ref.indexOf("202506asiav4:re2-") === 0),
    "nothing outside RW2 is flagged (RW1 and both Math modules are clean between these forms)");
  check(o.sources.length === 1 && o.sources[0].seen === 16 && o.sources[0].reskin === 9 &&
        o.sources[0].att.name === nameOf("202506asiav2") && o.sources[0].att.status === "completed",
    "the source attempt is named from the MANIFEST (not the record's testName) with 16 identical / 9 reskin", JSON.stringify(o.sources));
  const seen = d.fns.seenSetFor(CODE);
  const c = d.fns.seenCounts(d.fns.formRefs("202506asiav4"), seen);
  check(c.seen === 16 && c.reskin === 9 && c.unseen === 73 && c.unindexed === 0 && c.total === 98,
    "seenCounts over the whole form: 16 seen · 9 reskin · 73 unseen · 0 not indexed", JSON.stringify(c));
  check(d.fns.countsText(c) === "16 seen · 9 reskin · 73 unseen", "countsText omits the not-indexed clause when zero", d.fns.countsText(c));
  const m13 = d.fns.markFor("202506asiav4:re2-q13", seen), m7 = d.fns.markFor("202506asiav4:re2-q7", seen),
        m5 = d.fns.markFor("202506asiav4:re2-q5", seen), m30 = d.fns.markFor("202506asiav4:re1-q1", seen);
  check(m13.mark === "seen" && m13.via[0].ref === "202506asiav2:re2-q15" && m7.mark === "seen" && m7.via[0].ref === "202506asiav2:re2-q8" &&
        m5.mark === "reskin" && m5.via[0].ref === "202506asiav2:re2-q6" && m30.mark === "unseen",
    "markFor: re2-q13 seen (via v2 re2-q15), re2-q7 seen (via v2 re2-q8, EXACT since 28d192d), re2-q5 reskin (via v2 re2-q6), re1-q1 unseen");
  const html = d.fns.assignOverlapHtml([CODE], "202506asiav4");
  check(html.indexOf("has already seen 25 of " + nameOf("202506asiav4") + "’s 98 items") !== -1 &&
        html.indexOf("16 identical (same canonical id) and 9 reskin items (family siblings)") !== -1 &&
        html.indexOf("nothing is excluded automatically") !== -1,
    "the assignment warning reads 25 of 98 — 16 identical, 9 reskin items — and says nothing is excluded", html.slice(0, 400));
  const notes = d.fns.overlapNotes([CODE], "202506asiav4");
  check(notes.length === 1 && notes[0] === CODE + " had already seen 25 of its 98 items (16 identical, 9 reskin).",
    "status-line note after Create assignment repeats the overlap", JSON.stringify(notes));
  const none = d.fns.overlapFor(CODE, CLEAN_VS_V2);
  check(!!none && none.total === 98 && none.seenItems.length === 0 && none.reskinItems.length === 0,
    "control: " + nameOf(CLEAN_VS_V2) + " shares nothing with 202506asiav2 — zero overlap over its 98 indexed items");
  const mh = d.fns.markHtml(m13);
  const whenText = d.fns.attemptLabel(formRec("202506asiav2")).whenText;   // locale-formatted by fmtDay; never "—" for a real date
  check(mh.indexOf('class="dstatus to canon-mark seen"') !== -1 && whenText !== "—" && mh.split("completed " + whenText).length - 1 === 2,
    "a seen mark borrows the .dstatus palette and prints the attempt's date, formatted once, in the badge title and the inline via", mh);
});

console.log("--- 1. completed attempts only ---");
run("completed-only", () => {
  const d = build({ inlined: REAL_INDEX });
  d.seed({ recs: [formRec("202506asiav2", "in-progress")] });
  d.fns.ensureDedupLoaded();
  const o = d.fns.overlapFor(CODE, "202506asiav4");
  check(o.attempts === 0 && o.seenItems.length === 0 && o.reskinItems.length === 0, "an in-progress sitting contributes nothing (attempts 0, no items)");
  d.seed({ recs: [formRec("202506asiav2", "timed-out")] });
  check(d.fns.overlapFor(CODE, "202506asiav4").attempts === 1 && d.fns.overlapFor(CODE, "202506asiav4").seenItems.length === 16, "a timed-out sitting counts as completed");
  d.seed({ recs: [Object.assign(formRec("202506asiav2"), { student: { code: OTHER, key: OTHER } })] });
  check(d.fns.overlapFor(CODE, "202506asiav4").attempts === 0 && d.fns.overlapFor(OTHER, "202506asiav4").seenItems.length === 16,
    "the seen set is per student — another code's sitting never marks this one");
  check(d.fns.seenSetFor("") === null, "no student selected -> no seen set (marks off, not 'all unseen')");
  d.seed({ recs: [Object.assign(formRec("202506asiav2"), { answers: "not a map" })] });
  const junk = d.fns.seenSetFor(CODE);
  check(junk.attempts === 1 && Object.keys(junk.canon).length === 0 && junk.unindexed === 0, "a completed record whose answers is not an object exposes nothing and throws nothing");
});

console.log("--- 2. legacy testId resolves through the manifest on every lookup ---");
run("legacy", () => {
  const d = build({ inlined: REAL_INDEX });
  d.seed({ recs: [formRec("2026-june-asia-v1")] });    // the legacy id of 202606asiav1
  d.fns.ensureDedupLoaded();
  check(d.fns.canonRef("2026-june-asia-v1:re1-q4") === "202606asiav1:re1-q4" && d.fns.canonRef("bank-david-core:q0001") === "bank-david-core:q0001" && d.fns.canonRef("nope:q1") === "nope:q1",
    "canonRef: a legacy form id maps to the current id; bank and unknown containers pass through");
  const seen = d.fns.seenSetFor(CODE);
  check(seen.unindexed === 0 && Object.keys(seen.canon).length > 0, "a form record under a legacy id resolves every one of its 98 refs (none unindexed)", String(seen.unindexed));
  const q4 = d.fns.markFor("202606asiav2:re1-q4", seen), q15 = d.fns.markFor("202606asiav2:re1-q15", seen);
  check(q4.mark === "seen" && q4.via[0].ref === "2026-june-asia-v1:re1-q4" && q4.via[0].att.name === nameOf("202606asiav1"),
    "202606asiav2 re1-q4 is SEEN via 202606asiav1 re1-q4 (sibling-reskin class), named from the manifest");
  check(q15.mark === "reskin" && q15.via[0].ref === "2026-june-asia-v1:re1-q15", "202606asiav2 re1-q15 is RESKIN via 202606asiav1 re1-q15 (skeleton)");
  check(d.fns.markFor("202606asiav2:re1-q7", seen).mark === "seen", "a key-ruling pair (keys legitimately differ) is still the same canonical item -> seen");
  /* the SET side: a snapshot ref and a saved set ref under the legacy id */
  const setRec = { attemptId: "attempt:pset-l:1:s", student: { code: CODE, key: CODE }, kind: "set", testId: "pset-l", setId: "pset-l", setName: "Legacy set",
    status: "completed", submittedAt: "2026-09-02T09:00:00.000Z",
    setQuestions: [{ ref: "2026-june-asia-v1:re1-q4", source: "form", testId: "2026-june-asia-v1", qid: "re1-q4" }] };
  d.seed({ recs: [setRec] });
  const s2 = d.fns.seenSetFor(CODE);
  check(s2.unindexed === 0 && d.fns.markFor("202606asiav2:re1-q4", s2).mark === "seen", "a set snapshot ref under the legacy id still marks the current-id duplicate seen (0 unindexed)");
  check(d.fns.seenCounts(d.fns.setRefKeys({ refs: [{ type: "form", testId: "2026-june-asia-v1", moduleId: "m", qid: "re1-q4" }] }), s2).seen === 1,
    "a saved set ref under the legacy id counts as seen, not 'not indexed'");
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [{ type: "form", testId: "2026-june-asia-v1", moduleId: "m", qid: "re1-q4" }] } });
  check(d.fns.builderHeldAs({ type: "form", testId: "202606asiav1", moduleId: "m", qid: "re1-q4" }) === "202606asiav1:re1-q4" &&
        d.fns.pushRef({ type: "form", testId: "202606asiav1", moduleId: "m", qid: "re1-q4" }) === false && d.state().builder.refs.length === 1,
    "the builder treats the legacy-id ref and the current-id ref as the same question");
  check(d.fns.canonInfo("2026-june-asia-v1:re1-q4").alsoIn.indexOf("202606asiav2:re1-q4") !== -1 && d.fns.canonInfo("2026-june-asia-v1:re1-q4").alsoIn.indexOf("202606asiav1:re1-q4") === -1,
    "provenance of a legacy-id ref lists its duplicates, never itself");
});

console.log("--- 3. set attempts contribute their frozen snapshot; unknown refs are surfaced ---");
run("set-attempt", () => {
  const d = build({ inlined: REAL_INDEX });
  const setRec = { attemptId: "attempt:pset-1:1700000001:s1", student: { code: CODE, key: CODE }, kind: "set",
    testId: "pset-1", setId: "pset-1", setName: "Warm-up", testName: "Warm-up", status: "completed",
    submittedAt: "2026-09-03T09:00:00.000Z",
    setQuestions: [
      { ref: "202506asiav2:re2-q15", source: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15", testVersion: "x" },
      { ref: "bank-david-core:q0001", source: "bank", bankId: "bank-david-core", qid: "q0001", bankVersion: "y" },
      { ref: "bank-nowhere:q9999", source: "bank", bankId: "bank-nowhere", qid: "q9999", bankVersion: "z" }
    ],
    answers: {} };
  d.seed({ recs: [setRec] });
  d.fns.ensureDedupLoaded();
  const seen = d.fns.seenSetFor(CODE);
  const m = d.fns.markFor("202506asiav4:re2-q13", seen);
  check(m.mark === "seen" && m.via[0].att.name === "Warm-up" && m.via[0].ref === "202506asiav2:re2-q15",
    "a form question in a completed SET marks its exact duplicate on another form seen, named after the set");
  check(d.fns.markFor("bank-david-core:q0001", seen).mark === "seen", "a bank question in a completed set is seen");
  check(seen.unindexed === 1 && seen.unindexedAttempts === 1, "an unknown snapshot ref is counted unindexed (1 ref, 1 attempt), not dropped silently", JSON.stringify([seen.unindexed, seen.unindexedAttempts]));
  check(d.fns.seenCaveat(seen) === "1 question from their completed attempt is not in the index and could not be compared.",
    "the caveat names how much of the history could not be compared", d.fns.seenCaveat(seen));
  const oh = d.fns.assignOverlapHtml([CODE], "202506asiav4");
  check(oh.indexOf("could not be compared") !== -1 && oh.indexOf("has already seen 1 of") !== -1, "the overlap block carries the caveat next to its result", oh.slice(0, 300));
  check(d.fns.markFor("202506asiav4:re2-q1", seen).mark === "unseen", "the set does not mark items it did not hold");
  const o = d.fns.overlapFor(CODE, "202506asiav4");
  check(o.seenItems.length === 1 && o.reskinItems.length === 0 && o.sources[0].att.name === "Warm-up" && o.sources[0].seen === 1,
    "overlap from a set attempt: 1 identical item, source line names the set", JSON.stringify(o.sources.map(s => [s.att.name, s.seen])));
  const noSnap = Object.assign({}, setRec, { setQuestions: undefined, answers: { "202506asiav2:re2-q15": {}, "junk": {} } });
  check(JSON.stringify(d.fns.attemptRefs(noSnap)) === JSON.stringify(["202506asiav2:re2-q15", "junk"]), "a set record with no snapshot falls back to its answer keys");
});

console.log("--- 4. builder: one entry per canonical item — form and bank questions alike ---");
run("builder", () => {
  const d = build({ inlined: REAL_INDEX });
  d.fns.ensureDedupLoaded();
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [{ type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15" },
                                                                  { type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q11" }] } });
  const cand13 = { type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q13" };
  const reskin10 = { type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q10" };     // family sibling of v2 re2-q11, in the set
  check(d.fns.builderHeldAs(cand13) === "202506asiav2:re2-q15", "builderHeldAs: v4 re2-q13's exact class is held by v2 re2-q15");
  check(d.fns.builderHeldAs(reskin10) === null, "a reskin of an item in the set (family, not class: v4 re2-q10 ~ v2 re2-q11) is NOT held");
  d.fns.builderAddRef(cand13);
  check(d.state().builder.refs.length === 2 && d.loads.render === 0, "builderAddRef refuses a second member of a held canonical class (no push, no render)");
  d.fns.builderAddRef(reskin10);
  check(d.state().builder.refs.length === 3 && d.loads.render === 1, "a reskin is a different canonical item — it can be added (one render)");
  check(d.fns.builderHeldAs({ type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15" }) === "202506asiav2:re2-q15", "a ref already in the set is held by its own key");
  d.seed({ builder: { setId: null, name: "", subject: "math", refs: [{ type: "form", testId: "202512usv2", moduleId: "m", qid: "ma1-q4" }] } });
  check(d.fns.builderHeldAs({ type: "form", testId: "202512usv2", moduleId: "m", qid: "ma1-q11" }) === "202512usv2:ma1-q4",
    "within-form duplicate: 202512usv2 ma1-q11 is held by ma1-q4 (dup-ack pair)");
  /* bank questions take part (2026-09-30), BOTH ways, on the real index's
     bank/form class: bank-202608-salvage q0049 = 2024 December US v2 re2-q25 */
  const formTwin = { type: "form", testId: FORM_TWIN.split(":")[0], moduleId: "m", qid: FORM_TWIN.split(":")[1] };
  check(!!REAL_INDEX.items[BANK_TWIN] && !!REAL_INDEX.items[FORM_TWIN] && REAL_INDEX.items[BANK_TWIN].canonical === REAL_INDEX.items[FORM_TWIN].canonical,
    "PIN: the index puts " + BANK_TWIN + " and " + FORM_TWIN + " in one exact class");
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [formTwin] } });
  check(d.fns.builderHeldAs(bankRef(BANK_TWIN)) === FORM_TWIN && d.fns.pushRef(bankRef(BANK_TWIN)) === false && d.state().builder.refs.length === 1,
    "form held, bank twin offered: the bank ref is held AS the form ref and refused");
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [bankRef(BANK_TWIN)] } });
  check(d.fns.builderHeldAs(formTwin) === BANK_TWIN && d.fns.pushRef(formTwin) === false && d.state().builder.refs.length === 1,
    "bank held, form twin offered: the form ref is held AS the bank ref and refused — the same outcome in either click order");
  check(d.fns.pushRef(bankRef(BANK_TWIN)) === false && d.state().builder.refs.length === 1, "a plain duplicate bank ref is still refused");
  /* an unrelated active RW bank item (a class of one) still adds */
  const classSize = ref => Object.keys(REAL_INDEX.items).filter(k => REAL_INDEX.items[k].canonical === REAL_INDEX.items[ref].canonical).length;
  const loner = BANK_INDEX.entries.find(e => e.subject === "rw" && !e.retired && REAL_INDEX.items[e.ref] && classSize(e.ref) === 1);
  check(!!loner && d.fns.pushRef(bankRef(loner.ref)) === true && d.state().builder.refs.length === 2,
    "an unrelated active bank item (" + (loner && loner.ref) + ", a class of one) still adds");
  /* bank <-> bank: a set saved before q0032 was retired holds its re-mint's class */
  check(!!REAL_INDEX.items[REMINT] && REAL_INDEX.items[REMINT].canonical === RETIRED, "PIN: the index makes " + REMINT + " an exact duplicate of " + RETIRED);
  d.seed({ builder: { setId: "pset-legacy", name: "", subject: "rw", refs: [bankRef(RETIRED)] } });
  check(d.fns.builderHeldAs(bankRef(REMINT)) === RETIRED && d.fns.pushRef(bankRef(REMINT)) === false,
    "bank <-> bank: a set holding the retired q0032 already holds q0202's class, so q0202 is refused as a second copy");
  /* copies that got in anyway (index not loaded at the time) are called out */
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [
    { type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15" },
    { type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q13" },
    { type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q10" },
    bankRef(BANK_TWIN), formTwin] } });
  const groups = d.fns.builderDuplicateGroups();
  check(groups.length === 2 && JSON.stringify(groups[0]) === JSON.stringify(["202506asiav2:re2-q15", "202506asiav4:re2-q13"]) &&
        JSON.stringify(groups[1]) === JSON.stringify([BANK_TWIN, FORM_TWIN]),
    "builderDuplicateGroups names each class held twice — form/form AND bank/form — and ignores the singleton", JSON.stringify(groups));
  const d3 = build({ fetch: "error" });
  d3.seed({ builder: { setId: null, name: "", subject: "rw", refs: [{ type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15" }] } });
  d3.fns.ensureDedupLoaded();
  check(d3.fns.pushRef(cand13) === true && d3.fns.builderDuplicateGroups().length === 0, "with no index the class rule cannot apply (the notice covers it) and nothing throws");
});

console.log("--- 5. provenance strings ---");
run("provenance", () => {
  const d = build({ inlined: REAL_INDEX });
  d.fns.ensureDedupLoaded();
  const ci = d.fns.canonInfo("202506asiav4:re2-q13");
  check(ci.canonical === "202506asiav2:re2-q15" && JSON.stringify(ci.alsoIn) === JSON.stringify(["202506asiav2:re2-q15"]) && ci.reskins.length === 0,
    "canonInfo: v4 re2-q13 -> canonical v2 re2-q15, alsoIn = [that], no reskins", JSON.stringify(ci));
  check(d.fns.provHtml("202506asiav4:re2-q13") === '<span class="canon-prov">also in ' + nameOf("202506asiav2") + " re2-q15</span>",
    "provHtml: 'also in 2025 June Asia v2 re2-q15'", d.fns.provHtml("202506asiav4:re2-q13"));
  const c10 = d.fns.canonInfo("202506asiav4:re2-q10");
  check(c10.alsoIn.length === 0 && JSON.stringify(c10.reskins) === JSON.stringify(["202506asiav2:re2-q11"]) &&
        d.fns.provHtml("202506asiav4:re2-q10") === '<span class="canon-prov reskin">reskin of ' + nameOf("202506asiav2") + " re2-q11</span>",
    "provHtml: 'reskin of 2025 June Asia v2 re2-q11' for a skeleton sibling");
  check(JSON.stringify(d.fns.canonInfo("202506asiav4:re2-q7").alsoIn) === JSON.stringify(["202506asiav2:re2-q8"]),
    "v4 re2-q7 is 'also in' v2 re2-q8 — one exact class since the 'acritical' fix (28d192d)");
  const cv2 = d.fns.canonInfo("202506asiav2:re2-q15");
  check(cv2.canonical === "202506asiav2:re2-q15" && JSON.stringify(cv2.alsoIn) === JSON.stringify(["202506asiav4:re2-q13"]), "the canonical member lists its later duplicate as 'also in'");
  check(d.fns.provHtml("202506asiav4:re1-q1") === "", "a singleton has no provenance");
  const a = d.fns.canonInfo("202503usv1:ma1-q22"), b = d.fns.canonInfo("202508asiav1:ma2-q16");
  check(a.canonical !== b.canonical && a.family === b.family && a.reskins.indexOf("202508asiav1:ma2-q16") !== -1,
    "a ruled-DISTINCT pair shares a family (shown as reskin) but not a canonical id (never 'also in')");
  check(d.fns.refText("bank-david-core:q0001") === "bank-david-core q0001" && d.fns.refText("nope:q1") === "nope q1" && d.fns.refText("constructor:q1") === "constructor q1",
    "refText: bank refs print the bankId; unknown containers (even Object.prototype names) print raw");
});

console.log("--- 6. honest degradation ---");
run("degrade", () => {
  check(build().fns.normalizeDedupIndex(null) === null && build().fns.normalizeDedupIndex({ items: "x" }) === null &&
        build().fns.normalizeDedupIndex({}) === null, "normalize: null / non-object items / no items -> null");
  const n = build().fns.normalizeDedupIndex({ items: { "t:q1": { canonical: 5, family: 7 }, "t:q2": null, "t:q3": { canonical: "t:q1" } },
    reference: { forms: [{ testId: "t", testVersion: "v1" }, { nope: 1 }], banks: [{ bankId: "b" }] } });
  check(!!n && n.items["t:q1"].canonical === "t:q1" && n.items["t:q1"].family === null && !("t:q2" in n.items) &&
        JSON.stringify(n.classes["t:q1"]) === JSON.stringify(["t:q1", "t:q3"]) && JSON.stringify(n.byContainer.t) === JSON.stringify(["t:q1", "t:q3"]) &&
        JSON.stringify(n.forms) === JSON.stringify([{ id: "t", version: "v1" }]) && JSON.stringify(n.banks) === JSON.stringify([{ id: "b", version: null }]),
    "normalize: non-string canonical -> self, non-string family -> none, null entries dropped, classes canonical-first, reference keeps ids AND versions");
  const d1 = build({ inlined: { nope: true } });
  d1.fns.ensureDedupLoaded();
  check(d1.state().dedupState === "failed" && /malformed/.test(d1.state().dedupNote) && d1.fns.dedupNoticeHtml().indexOf("unavailable") !== -1 &&
        d1.fns.dedupNoticeHtml().indexOf("malformed") !== -1 && d1.fns.dedupNoticeHtml().indexOf("Regenerate") !== -1 && d1.fns.dedupNoticeHtml().indexOf("Refresh") === -1,
    "a malformed inlined index -> failed; the notice says unavailable, why, and to regenerate (not to Refresh)");
  d1.fns.rearmDedup(); d1.fns.ensureDedupLoaded();
  check(d1.state().dedupState === "failed" && d1.scripts.length === 0, "Refresh does not re-arm a malformed index (nothing to fetch), and the same object is not re-adopted");
  const d2 = build({ fetch: "error", tab: "sets" });
  d2.fns.ensureDedupLoaded();
  check(d2.scripts[0].src === "testdata/dedup-index.js" && d2.state().dedupState === "failed" && /fetched/.test(d2.state().dedupNote) && d2.loads.render === 1,
    "an unfetchable index -> failed after ONE fetch attempt, a re-render carries the notice", JSON.stringify([d2.scripts.map(s => s.src), d2.state().dedupNote, d2.loads]));
  check(d2.fns.dedupNoticeHtml().indexOf("Click Refresh to try again") !== -1 && d2.fns.dedupNoticeHtml().indexOf("Regenerate") === -1,
    "a network failure's notice says to Refresh, not to regenerate a file that is fine", d2.fns.dedupNoticeHtml());
  d2.fns.ensureDedupLoaded();
  check(d2.scripts.length === 1, "a failed load is never re-issued on later renders (no network hammering)");
  d2.fns.rearmDedup(); d2.fns.ensureDedupLoaded();
  check(d2.scripts.length === 2 && d2.state().dedupState === "failed", "Refresh re-arms a network failure: the next render fetches once more");
  check(d2.fns.markFor("202506asiav4:re2-q13", { canon: {}, fam: {} }) === null && d2.fns.seenSetFor(CODE) === null &&
        d2.fns.canonInfo("202506asiav4:re2-q13") === null && d2.fns.provHtml("x") === "" && d2.fns.builderHeldAs({ type: "form", testId: "x", qid: "q" }) === null,
    "with no index every derivation returns null/empty — marks off, nothing throws");
  const html = d2.fns.assignOverlapHtml([CODE], "202506asiav4");
  check((html.match(/canon-notice/g) || []).length === 1 && html.indexOf("unavailable") !== -1 && html.indexOf("canon-overlap") === -1,
    "Assignments tab: exactly ONE visible notice, no overlap block, when the index is off");
  check(d2.fns.overlapNotes([CODE], "202506asiav4").length === 0, "no status-line overlap note when the index is off");
  const d3 = build({ fetch: "empty" });
  d3.fns.ensureDedupLoaded();
  check(d3.state().dedupState === "failed" && /registered nothing/.test(d3.state().dedupNote) && d3.state().dedupTransient === false,
    "a file that registers nothing -> failed, says so, and is not a Refresh-able failure");
  /* the timeout path: a script that never settles, then arrives late */
  const d4 = build({ fetch: "hang", tab: "sets" });
  d4.seed({ recs: [formRec("202506asiav2")] });
  d4.fns.ensureDedupLoaded();
  check(d4.state().dedupState === "loading" && d4.fns.dedupNoticeHtml().indexOf("Loading the canonical-id index") !== -1 && d4.timers.length === 1 && d4.timers[0].ms === 20000,
    "while the fetch is in flight the tab shows the loading notice and a 20 s deadline is armed", JSON.stringify([d4.state().dedupState, d4.timers.length]));
  d4.timers[0].fn();
  check(d4.state().dedupState === "failed" && d4.state().dedupNote === "timed out" && d4.state().dedupTransient === true && d4.loads.render === 1,
    "the deadline fires -> failed (timed out), a Refresh-able failure, one re-render");
  d4.window.DEDUP_INDEX = REAL_INDEX;           // the removed script's bytes land anyway and register the global
  d4.scripts[0].onload();
  check(d4.state().dedupState === "failed", "the late onload itself is latched out (done), state unchanged");
  d4.fns.ensureDedupLoaded();
  check(d4.state().dedupState === "ready" && d4.scripts.length === 1 && d4.fns.overlapFor(CODE, "202506asiav4").seenItems.length === 16,
    "the next render adopts the late-arriving index from memory — no second fetch, marks on");
  const d5 = build({ fetch: "ok", fetched: REAL_INDEX });
  d5.seed({ recs: [formRec("202506asiav2")] });
  d5.fns.ensureDedupLoaded();
  check(d5.state().dedupState === "ready" && d5.loads.render === 1 && d5.fns.overlapFor(CODE, "202506asiav4").seenItems.length === 16,
    "a fetched index -> ready, one re-render, same derivation as inlined");
  check(d5.fns.dedupNoticeHtml() === "", "ready and covering every manifest test/bank at its shipped version -> no notice at all");
  /* an async settle must not wipe what the tutor typed, on any tab */
  const d6 = build({ fetch: "ok", fetched: REAL_INDEX, tab: "assign" });
  d6.seed({ recs: [formRec("202506asiav2")] });
  d6.$("afTest").value = "202506asiav4";
  d6.els.afCodes = mkSelect([CODE, OTHER], [CODE]);
  d6.$("afFree").value = "as-abcdefgh, junk";
  d6.$("afName").value = "Erin K";
  d6.$("afOverlap").innerHTML = "loading…";
  d6.fns.ensureDedupLoaded();
  check(d6.loads.render === 1 && d6.$("afFree").value === "as-abcdefgh, junk" && d6.$("afName").value === "Erin K" && d6.$("afTest").value === "202506asiav4" &&
        d6.$("afCodes").selectedOptions.length === 1 && d6.$("afCodes").selectedOptions[0].value === CODE,
    "settling on the Assignments tab re-renders once and RESTORES every typed value and the multi-select", JSON.stringify([d6.loads.render, d6.$("afFree").value, d6.$("afName").value]));
  check(d6.$("afOverlap").innerHTML.indexOf("has already seen 25 of") !== -1 && d6.$("afOverlap").innerHTML.indexOf("AS-ABCDEFGH") !== -1 &&
        d6.$("afOverlap").innerHTML.indexOf("junk") === -1 && d6.$("afOverlap").innerHTML.indexOf("no completed attempts in storage") !== -1,
    "…and recomputes the overlap block from the restored codes (typed codes parsed exactly as Create assignment parses them)");
  const d7 = build({ fetch: "ok", fetched: REAL_INDEX, tab: "sets" });
  d7.$("saFree").value = "AS-ABCDEFGH"; d7.$("saLimit").value = "30"; d7.$("saHold").checked = true; d7.els.saCodes = mkSelect([CODE], [CODE]);
  d7.fns.ensureDedupLoaded();
  check(d7.loads.render === 1 && d7.$("saFree").value === "AS-ABCDEFGH" && d7.$("saLimit").value === "30" && d7.$("saHold").checked === true && d7.$("saCodes").selectedOptions.length === 1,
    "settling on the Practice Sets tab keeps the Assign-a-set form (codes, limit, hold) the tutor was filling in");
  /* the keystroke path: no recompute until a valid code or the test changes */
  const d8 = build({ inlined: REAL_INDEX, tab: "assign" });
  d8.seed({ recs: [formRec("202506asiav2")] });
  d8.$("afTest").value = "202506asiav4"; d8.els.afCodes = mkSelect([CODE], [CODE]); d8.$("afFree").value = "AS-BCD";
  d8.fns.refreshAssignOverlap();
  const first = d8.$("afOverlap").innerHTML;
  d8.$("afOverlap").innerHTML = "SENTINEL"; d8.$("afFree").value = "AS-BCDF";
  d8.fns.refreshAssignOverlap();
  check(first.indexOf("has already seen 25 of") !== -1 && d8.$("afOverlap").innerHTML === "SENTINEL", "a keystroke that completes no new code leaves the block alone");
  d8.$("afFree").value = "AS-BCDFGHJK";
  d8.fns.refreshAssignOverlap();
  check(d8.$("afOverlap").innerHTML.indexOf("AS-BCDFGHJK") !== -1, "…and a completed code recomputes it");
  /* stale index: a manifest test the index predates, and one it was built against a different version of */
  const bumped = TEST_MANIFEST.map(t => t.testId === "202506asiav2" ? Object.assign({}, t, { testVersion: "2099-01-01-a" }) : t)
    .concat([{ testId: "209901usv1", testName: "2099 January US v1", testVersion: "z", legacyIds: [] }]);
  const d9 = build({ inlined: REAL_INDEX, manifest: bumped });
  const futureRec = Object.assign(formRec("202506asiav2"), { attemptId: "attempt:209901usv1:1:f", testId: "209901usv1", answers: { "re1-q1": {}, "re1-q2": {} } });
  d9.seed({ recs: [formRec("202506asiav2"), futureRec] });
  d9.fns.ensureDedupLoaded();
  const notice = d9.fns.dedupNoticeHtml();
  const v2Indexed = REAL_INDEX.reference.forms.find(x => x.testId === "202506asiav2").testVersion;   // the notice's format is the check, not the version
  check(notice.indexOf("predates 2099 January US v1") !== -1 && notice.indexOf("different build of " + nameOf("202506asiav2") + " (index " + v2Indexed + ", library 2099-01-01-a)") !== -1 &&
        (notice.match(/canon-notice/g) || []).length === 1,
    "one notice names both the test the index predates and the test it was built against a different version of", notice);
  const seen9 = d9.fns.seenSetFor(CODE);
  check(seen9.attempts === 2 && seen9.unindexed === 2 && seen9.unindexedAttempts === 1, "a completed attempt on the unindexed form counts its 2 refs as unindexed (1 attempt)", JSON.stringify([seen9.attempts, seen9.unindexed, seen9.unindexedAttempts]));
  const o9 = d9.fns.overlapFor(CODE, "209901usv1");
  check(o9.total === 0 && o9.seenItems.length === 0 && d9.fns.assignOverlapHtml([CODE], "209901usv1").indexOf("is not in the canonical-id index, so nothing can be compared") !== -1,
    "offering the unindexed form: 0 of 0 reads as 'not in the index', never 'none of its 0 items'");
  const h9 = d9.fns.assignOverlapHtml([CODE], CLEAN_VS_V2);
  check(h9.indexOf("none of " + nameOf(CLEAN_VS_V2) + "’s 98 items appear in their 2 completed attempts") !== -1 && h9.indexOf("2 questions from 1 of their 2 completed attempts are not in the index") !== -1,
    "offering a clean form: the 'none' line carries the caveat that part of the history could not be compared", h9);
  check(d9.fns.markFor("209901usv1:re1-q1", seen9).mark === "unindexed", "its questions mark 'unindexed', never 'unseen'");
});

console.log("--- 7. escaping on every new innerHTML site ---");
run("escaping", () => {
  const PAY = '"><img src=x onerror="window.__X=1"><b>PWN</b>';
  const hostileRef = PAY + ":" + PAY;
  const idx = { items: {
      "202506asiav2:re2-q15": { canonical: "202506asiav2:re2-q15", family: "fam:" + PAY },
      "202506asiav4:re2-q13": { canonical: "202506asiav2:re2-q15", family: "fam:" + PAY },
      [hostileRef]: { canonical: "202506asiav2:re2-q15", family: "fam:" + PAY },
      "202506asiav4:re2-q7": { canonical: "202506asiav4:re2-q7", family: "fam:" + PAY }
    }, reference: { forms: TEST_MANIFEST.map(t => ({ testId: t.testId, testVersion: t.testVersion })), banks: BANK_MANIFEST.map(b => ({ bankId: b.bankId, bankVersion: b.bankVersion })) } };
  const d = build({ inlined: idx });
  const rec = { attemptId: "attempt:pset-h:1:" + PAY, student: { code: CODE, key: CODE }, kind: "set", testId: "pset-h", setId: "pset-h",
    setName: PAY, status: "completed", submittedAt: PAY, lastSavedAt: PAY,
    setQuestions: [{ ref: hostileRef, source: "form", testId: PAY, qid: PAY }] };
  d.seed({ recs: [rec] });
  d.fns.ensureDedupLoaded();
  /* inert = the payload survives only as escaped TEXT: no element, and the
     escaped form is present */
  const inert = s => s.indexOf("<img") === -1 && s.indexOf("<b>PWN") === -1 && s.indexOf("&lt;img") !== -1;
  check(inert(d.fns.provHtml("202506asiav4:re2-q13")), "'also in <hostile ref>' is escaped", d.fns.provHtml("202506asiav4:re2-q13"));
  check(inert(d.fns.provHtml("202506asiav4:re2-q7")), "'reskin of <hostile ref>' is escaped", d.fns.provHtml("202506asiav4:re2-q7"));
  const seen = d.fns.seenSetFor(CODE);
  const mh = d.fns.markHtml(d.fns.markFor("202506asiav4:re2-q13", seen));
  check(inert(mh) && /title="[^"]*&lt;img[^"]*"/.test(mh) && /title="[^"]*&quot;/.test(mh) && mh.indexOf("canon-mark seen") !== -1 && mh.indexOf('onerror="') === -1,
    "the seen mark's inline via (record setName + hostile ref) and its title attribute are escaped, quotes included (render.js escapeHtml)", mh);
  const oh = d.fns.assignOverlapHtml([CODE], "202506asiav4");
  check(inert(oh) && oh.indexOf("has already seen 2 of") !== -1 && oh.indexOf("1 identical (same canonical id) and 1 reskin item") !== -1,
    "the overlap block (source name, status, date, ref) is escaped", oh);
  const notes = d.fns.overlapNotes([CODE], "202506asiav4");
  check(notes.length === 1 && notes[0] === CODE + " had already seen 2 of its 2 items (1 identical, 1 reskin).", "overlap notes are plain text for the status line", JSON.stringify(notes));
  const d2 = build({ inlined: { items: {}, reference: { forms: [], banks: [] } }, manifest: [{ testId: "t1", testName: PAY, testVersion: "v", legacyIds: [] }] });
  d2.fns.ensureDedupLoaded();
  check(inert(d2.fns.dedupNoticeHtml()), "a hostile manifest name in the stale-index notice is escaped", d2.fns.dedupNoticeHtml());
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [{ type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15" }, { type: "form", testId: PAY, moduleId: "m", qid: PAY }] } });
  const g = d.fns.builderDuplicateGroups();
  check(g.length === 1 && g[0].indexOf(hostileRef) !== -1 && inert(escapeHtml(g[0].map(d.fns.refText).join(" = "))), "duplicate-class groups carry the hostile ref, escaped where rendered");
});

console.log("--- 8. record-derived codes named like Object.prototype properties ---");
run("proto-keys", () => {
  ["constructor", "__proto__", "hasOwnProperty", "toString"].forEach(bad => {
    const d = build({ inlined: REAL_INDEX });
    d.seed({ recs: [Object.assign(formRec("202506asiav2"), { student: { code: bad, key: bad } })] });
    d.fns.ensureDedupLoaded();
    const seen = d.fns.seenSetFor(bad);
    const o = d.fns.overlapFor(bad, "202506asiav4");
    check(!!seen && seen.attempts === 1 && !!o && o.seenItems.length === 16 && d.fns.assignOverlapHtml([bad], "202506asiav4").indexOf("has already seen 25 of") !== -1 &&
          d.fns.overlapNotes([bad], "202506asiav4").length === 1,
      "a student key of \"" + bad + "\" is just a code: seen set, overlap, block and status note all work");
  });
  const d = build({ inlined: REAL_INDEX });
  d.seed({ recs: [Object.assign(formRec("202506asiav2"), { attemptId: "attempt:constructor:1:x", testId: "constructor", answers: { "re1-q1": {} } })] });
  d.fns.ensureDedupLoaded();
  const s = d.fns.seenSetFor(CODE);
  check(s.attempts === 1 && s.unindexed === 1 && d.fns.attemptLabel({ testId: "constructor", testName: "(record name)" }).name === "(record name)",
    "a record testId of \"constructor\" is an unknown form: its refs are unindexed, its label falls back to the record's own name");
});

console.log("--- 9. a retake counts each form item once per source attempt ---");
run("retake", () => {
  const d = build({ inlined: REAL_INDEX });
  d.seed({ recs: [formRec("202512usv2")] });
  d.fns.ensureDedupLoaded();
  const o = d.fns.overlapFor(CODE, "202512usv2");
  check(o.total === 98 && o.seenItems.length === 98 && o.reskinItems.length === 0, "every item of a form the student already completed is seen", JSON.stringify([o.total, o.seenItems.length, o.reskinItems.length]));
  check(o.sources.length === 1 && o.sources[0].seen === o.seenItems.length,
    "the within-form dup-ack pair (ma1-q4 = ma1-q11) is counted once per item, so the source line's count equals the item count", JSON.stringify(o.sources.map(s => s.seen)));
  const m11 = d.fns.markFor("202512usv2:ma1-q11", d.fns.seenSetFor(CODE));
  check(m11.mark === "seen" && m11.via.length === 2, "the duplicated item was seen twice in that sitting (both refs are provenance)");
});

console.log("--- 10. bank items are seen exactly as form items are ---");
run("bank-seen", () => {
  const d = build({ inlined: REAL_INDEX });
  d.fns.ensureDedupLoaded();
  d.seed({ recs: [formRec(FORM_TWIN.split(":")[0])] });
  const s1 = d.fns.seenSetFor(CODE);
  const mb = d.fns.markFor(BANK_TWIN, s1);
  check(mb.mark === "seen" && mb.via[0].ref === FORM_TWIN && mb.via[0].att.name === nameOf(FORM_TWIN.split(":")[0]),
    "a completed 2024 December US v2 sitting marks its bank twin q0049 SEEN (via re2-q25, named from the manifest)", JSON.stringify(mb));
  const setRec = { attemptId: "attempt:pset-b:1700000002:s1", student: { code: CODE, key: CODE }, kind: "set",
    testId: "pset-b", setId: "pset-b", setName: "Bank warm-up", testName: "Bank warm-up", status: "completed", submittedAt: "2026-09-29T09:00:00.000Z",
    setQuestions: [{ ref: BANK_TWIN, source: "bank", bankId: BANK_TWIN.split(":")[0], qid: BANK_TWIN.split(":")[1], bankVersion: "x" },
                   { ref: RETIRED, source: "bank", bankId: RETIRED.split(":")[0], qid: RETIRED.split(":")[1], bankVersion: "x" }],
    answers: {} };
  d.seed({ recs: [setRec] });
  const s2 = d.fns.seenSetFor(CODE);
  const mf = d.fns.markFor(FORM_TWIN, s2);
  check(mf.mark === "seen" && mf.via[0].ref === BANK_TWIN && mf.via[0].att.name === "Bank warm-up" && s2.unindexed === 0,
    "a completed SET that served bank q0049 marks its form twin 202412usv2 re2-q25 SEEN, named after the set", JSON.stringify(mf));
  const o = d.fns.overlapFor(CODE, FORM_TWIN.split(":")[0]);
  check(o.seenItems.length === 1 && o.seenItems[0].ref === FORM_TWIN && o.sources.length === 1 && o.sources[0].att.name === "Bank warm-up" && o.sources[0].seen === 1,
    "…and assigning 2024 December US v2 warns: 1 identical item, sourced to that set", JSON.stringify(o.sources.map(x => [x.att.name, x.seen])));
  check(d.fns.markFor(REMINT, s2).mark === "seen" && d.fns.markFor(REMINT, s2).via[0].ref === RETIRED,
    "bank <-> bank: a set that served q0032 marks its re-mint q0202 seen");
  check(d.fns.seenCounts(d.fns.setRefKeys({ refs: [formTwin(), bankRef(BANK_TWIN)] }), s2).seen === 2,
    "a saved set holding either twin counts it seen in the Sets list's Seen column");
  check(d.fns.provHtml(BANK_TWIN) === '<span class="canon-prov">also in ' + nameOf(FORM_TWIN.split(":")[0]) + " " + FORM_TWIN.split(":")[1] + "</span>",
    "provHtml on the bank ref: 'also in 2024 December US v2 re2-q25'", d.fns.provHtml(BANK_TWIN));
  check(d.fns.provHtml(FORM_TWIN) === '<span class="canon-prov">also in bank-202608-salvage q0049</span>',
    "provHtml on the form ref: 'also in bank-202608-salvage q0049'", d.fns.provHtml(FORM_TWIN));
  function formTwin(){ return { type: "form", testId: FORM_TWIN.split(":")[0], moduleId: "m", qid: FORM_TWIN.split(":")[1] }; }
  /* RENDERED, not just derived: with the student chosen in the Student
     filter, the bank picker row and the set's own ref row carry the mark and
     the provenance (review finding 19: both could be dropped with every
     derivation check still green) */
  d.seed({ recs: [formRec(FORM_TWIN.split(":")[0])], builder: { setId: null, name: "", subject: "rw", refs: [] } });
  d.$("dashFilterStudent").value = CODE;
  const pickRow = (html, ref) => html.split('<div class="setpick-row').slice(1).find(r => r.indexOf("<b>" + ref + "</b>") !== -1) || "";
  const hA = d.fns.viewSetBuilder();
  check(/class="dstatus to canon-mark seen"/.test(pickRow(hA, BANK_TWIN)),
    "rendered: the bank picker row for q0049 carries the SEEN mark for a student who sat 2024 December US v2", pickRow(hA, BANK_TWIN).slice(0, 400));
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [bankRef(BANK_TWIN)] } });
  const hB = d.fns.viewSetBuilder();
  const ownRow = (hB.split('<div class="setref-row">')[1] || "").split("setref-btns")[0];
  check(ownRow.indexOf("<b>" + BANK_TWIN + "</b>") !== -1 && /canon-mark seen/.test(ownRow) &&
        ownRow.indexOf("also in " + nameOf(FORM_TWIN.split(":")[0]) + " re2-q25") !== -1,
    "rendered: the set's own row for bank q0049 carries its provenance ('also in 2024 December US v2 re2-q25') and the SEEN mark", ownRow);
  d.$("dashFilterStudent").value = "";
});

console.log("--- 11. a retired bank item never enters a set ---");
run("retired", () => {
  const d = build({ inlined: REAL_INDEX });
  d.fns.ensureDedupLoaded();
  const formTwin = { type: "form", testId: FORM_TWIN.split(":")[0], moduleId: "m", qid: FORM_TWIN.split(":")[1] };
  check(d.fns.isRetiredBankRef(bankRef(RETIRED)) === true && d.fns.isRetiredBankRef(bankRef(REMINT)) === false && d.fns.isRetiredBankRef(formTwin) === false &&
        d.fns.isRetiredBankRef(null) === false && d.fns.isRetiredBankRef(bankRef("bank-nowhere:q1")) === false,
    "isRetiredBankRef reads the loaded BANK_INDEX: q0032 retired, q0202 active; form refs, null and unknown refs are not 'retired'");
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [] } });
  d.fns.builderAddRef(bankRef(RETIRED));
  check(d.fns.pushRef(bankRef(RETIRED)) === false && d.state().builder.refs.length === 0 && d.loads.render === 0,
    "pushRef/builderAddRef refuse a bank item THIS PAGE'S index marks retired (defense in depth: the picker renders no Add for it). " +
    "A page older than a retirement does add it until a save re-reads the index — see the next check and tutor-writes §9f");
  /* a save's successful re-read is kept (bankIndexFresh): an item retired
     since this page loaded is refused from then on, and the picker drops its Add */
  const freshIdx = JSON.parse(JSON.stringify(BANK_INDEX, (k, v) =>
    (v && typeof v === "object" && v.ref === BANK_TWIN) ? Object.assign({}, v, { retired: true, supersededBy: REMINT.split(":")[1] }) : v));
  check(d.fns.pushRef(bankRef(BANK_TWIN)) === true, "control: before any re-read, this page adds q0049 (its index says active)");
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [] }, bankIndexFresh: freshIdx });
  const rows = html => html.split('<div class="setpick-row').slice(1);
  const rowOf = (html, ref) => rows(html).find(r => r.indexOf("<b>" + ref + "</b>") !== -1) || "";
  check(d.fns.isRetiredBankRef(bankRef(BANK_TWIN)) === true && d.fns.pushRef(bankRef(BANK_TWIN)) === false && d.state().builder.refs.length === 0 &&
        !/pick-bank/.test(rowOf(d.fns.viewSetBuilder(), BANK_TWIN)),
    "after a save's re-read showed q0049 retired, pushRef refuses it and its picker row loses the Add button");
  d.seed({ bankIndexFresh: null });
  /* a save in flight locks the builder: pushRef refuses anything, the view
     disables Save and every Add */
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [], saving: true } });
  const busyHtml = d.fns.viewSetBuilder();
  check(d.fns.pushRef(bankRef(REMINT)) === false && d.state().builder.refs.length === 0 &&
        /id="sbSaveBtn"[^>]*disabled/.test(busyHtml) &&
        rows(busyHtml).filter(r => /class="dash-rel pick-bank"/.test(r)).every(r => /pick-bank"[^>]*\sdisabled/.test(r.replace(/\s+/g, " "))),
    "while a save is in flight pushRef refuses everything and the view disables Save and every Add");
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [] } });
  const h1 = d.fns.viewSetBuilder();
  const rwEntries = BANK_INDEX.entries.filter(e => e.subject === "rw");
  const retiredRw = rwEntries.filter(e => e.retired), activeRw = rwEntries.filter(e => !e.retired);
  const retiredWithButton = retiredRw.filter(e => /class="dash-rel pick-bank"/.test(rowOf(h1, e.ref)));
  const activeWithButton = activeRw.filter(e => /class="dash-rel pick-bank"/.test(rowOf(h1, e.ref)));
  check(retiredRw.length > 0 && retiredWithButton.length === 0,
    "picker: none of the " + retiredRw.length + " retired RW rows carries an Add button", retiredWithButton.map(e => e.ref).join(", "));
  check(activeWithButton.length === activeRw.length, "picker: every one of the " + activeRw.length + " active RW rows still does");
  check(rowOf(h1, RETIRED).indexOf("Retired — can’t be added; use q0202") !== -1 && /is-retired/.test(rowOf(h1, RETIRED)),
    "picker: q0032's row says it is retired and names its replacement", rowOf(h1, RETIRED));
  /* the chain: the named replacement is the LIVE end, never a retired middle */
  const CHAIN = [["bank-202608-salvage:q0098", "q0209", "q0239"], ["bank-202608-salvage:q0126", "q0210", "q0240"]];
  CHAIN.forEach(([ref, mid, end]) => {
    const e = BANK_INDEX.entries.find(x => x.ref === ref), m = BANK_INDEX.entries.find(x => x.ref === "bank-202608-salvage:" + mid);
    check(!!e && e.retired && e.supersededBy === mid && !!m && m.retired && m.supersededBy === end,
      "PIN: the index chains " + ref + " → " + mid + " (itself retired) → " + end);
    check(d.fns.liveReplacement(bankRef(ref)) === end && rowOf(h1, ref).indexOf("use " + end) !== -1 && rowOf(h1, ref).indexOf("use " + mid) === -1 &&
          d.fns.retiredRefText(bankRef(ref)) === ref + " → " + end,
      "chain: " + ref + " names " + end + " (the live end), never the retired " + mid, rowOf(h1, ref));
  });
  check(d.fns.liveReplacement(bankRef(REMINT)) === null && d.fns.liveReplacement(bankRef("bank-nowhere:q1")) === null,
    "liveReplacement is null for an active item and for an unknown one");
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [formTwin] } });
  const h2 = d.fns.viewSetBuilder();
  const twinRow = rowOf(h2, BANK_TWIN);
  check(/<button class="dash-rel pick-bank"[^>]*disabled[^>]*>In set as 2024 December US v2 re2-q25<\/button>/.test(twinRow.replace(/\s+/g, " ")) &&
        twinRow.indexOf("also in " + nameOf(FORM_TWIN.split(":")[0]) + " re2-q25") !== -1 && /is-held/.test(twinRow),
    "picker: with its form twin in the set, q0049 reads 'In set as 2024 December US v2 re2-q25' (disabled) and carries the provenance", twinRow);
  const own = rowOf(h2, REMINT);
  check(/>Add<\/button>/.test(own), "picker: an unrelated active row still reads Add", own);
  /* a set that already holds the retired item: reported, kept, never changed */
  const legacy = { setId: "pset-legacy", name: "Old warm-up", subject: "rw", refs: [bankRef(RETIRED), bankRef(BANK_TWIN)] };
  d.seed({ builder: JSON.parse(JSON.stringify(legacy)) });
  const h3 = d.fns.viewSetBuilder();
  const notice3 = (h3.match(/<p class="retired-notice[^]*?<\/p>/) || [""])[0];
  check(notice3.indexOf("This set holds a retired bank item: bank-202608-salvage:q0032 → q0202. Students still get it as the set was saved.") !== -1 &&
        rowOf(h3, RETIRED).indexOf("In set · retired") !== -1 && JSON.stringify(d.state().builder.refs) === JSON.stringify(legacy.refs),
    "builder: a set holding q0032 says so (no claim about when it got there), shows it 'In set · retired', and keeps it untouched", notice3);
  d.seed({ builder: { setId: "pset-legacy", name: "", subject: "rw", refs: [bankRef(RETIRED), bankRef("bank-202608-salvage:q0098")] } });
  const notice4 = (d.fns.viewSetBuilder().match(/<p class="retired-notice[^]*?<\/p>/) || [""])[0];
  check(notice4.indexOf("holds 2 retired bank items") !== -1 && notice4.indexOf("q0098 → q0239") !== -1 && notice4.indexOf("Remove them") !== -1,
    "builder: two retired items read in the plural and each names its live replacement", notice4);
  check(d.fns.retiredRefsOf(legacy.refs).length === 1 && d.fns.retiredRefsOf([null, "junk", 7, bankRef(BANK_TWIN)]).length === 0,
    "retiredRefsOf finds exactly the retired refs and skips malformed ones");

  /* the Sets-list REPORT (item 1: "how many and which") — the only place
     the tutor learns which stored sets serve a retired item */
  const setsList = [
    { setId: "pset-a", name: "Old warm-up", subject: "rw", refs: [bankRef(RETIRED), bankRef(BANK_TWIN)] },
    { setId: "pset-b", name: "Clean", subject: "rw", refs: [bankRef(BANK_TWIN), bankRef(REMINT)] },
    { setId: "pset-c", name: "Chained", subject: "rw", refs: [bankRef("bank-202608-salvage:q0098")] },
    null, "junk"];
  const before = JSON.stringify(setsList);
  const rep = d.fns.retiredSetsNoticeHtml(setsList);
  check(rep.indexOf("2 sets hold a retired bank item: <b>Old warm-up</b> (bank-202608-salvage:q0032 → q0202); <b>Chained</b> (bank-202608-salvage:q0098 → q0239).") !== -1 &&
        rep.indexOf("Clean") === -1 && rep.indexOf("Nothing was changed") !== -1 && JSON.stringify(setsList) === before,
    "Sets-list report: counts the sets holding a retired item, names each with its items and live replacements, skips the clean one and malformed rows, changes nothing", rep);
  check(d.fns.retiredSetsNoticeHtml([setsList[1]]) === "" && d.fns.retiredSetsNoticeHtml([]) === "" && d.fns.retiredSetsNoticeHtml(null) === "",
    "Sets-list report: nothing at all when no set holds a retired item");
  check(d.fns.retiredSetsNoticeHtml([setsList[0]]).indexOf("1 set holds a retired bank item") !== -1 &&
        d.fns.retiredSetsNoticeHtml([setsList[0]]).indexOf("students assigned this set") !== -1,
    "Sets-list report: singular for one set");

  /* escaping on the new surfaces (review findings 8/26): a hostile set name
     in the report, a hostile replacement qid in the picker and the builder
     notice, a hostile ref behind "In set as" */
  const PAY = '"><img src=x onerror="window.__X=1"><b>PWN</b>';
  const inert = h => h.indexOf("<img") === -1 && h.indexOf("<b>PWN") === -1 && h.indexOf("&lt;img") !== -1;
  check(inert(d.fns.retiredSetsNoticeHtml([{ setId: "pset-x", name: PAY, refs: [bankRef(RETIRED)] }])),
    "the Sets-list report escapes a hostile set name", d.fns.retiredSetsNoticeHtml([{ setId: "pset-x", name: PAY, refs: [bankRef(RETIRED)] }]));
  const hostileIdx = JSON.parse(JSON.stringify(BANK_INDEX, (k, v) =>
    (v && typeof v === "object" && v.ref === RETIRED) ? Object.assign({}, v, { supersededBy: PAY }) : v));
  hostileIdx.entries.push({ ref: "bank-202608-salvage:" + PAY, containerType: "bank", bankId: "bank-202608-salvage", qid: PAY,
    subject: "rw", skill: PAY, tags: [], keyType: "mcq", retired: false, supersededBy: null, stemPreview: PAY });
  const dH = build({ inlined: REAL_INDEX, bankIndex: hostileIdx });
  dH.fns.ensureDedupLoaded();
  dH.seed({ builder: { setId: "pset-x", name: "", subject: "rw", refs: [bankRef(RETIRED)] } });
  const hH = dH.fns.viewSetBuilder();
  const hRow = hH.split('<div class="setpick-row').slice(1).find(r => r.indexOf("bank-202608-salvage:q0032</b>") !== -1) || "";
  const hNotice = (hH.match(/<p class="retired-notice[^]*?<\/p>/) || [""])[0];
  check(inert(hNotice) && hNotice.indexOf("→ &quot;&gt;&lt;img") !== -1,
    "the builder's retired notice escapes a hostile replacement qid", hNotice);
  dH.seed({ builder: { setId: null, name: "", subject: "rw", refs: [] } });
  const hRow2 = dH.fns.viewSetBuilder().split('<div class="setpick-row').slice(1).find(r => r.indexOf("bank-202608-salvage:q0032</b>") !== -1) || "";
  check(inert(hRow2) && hRow2.indexOf("use &quot;&gt;&lt;img") !== -1, "the picker's 'use <replacement>' escapes a hostile qid", hRow2);
  check(hRow.indexOf("In set · retired") !== -1 && hRow.indexOf("<img") === -1 && hRow.indexOf("<b>PWN") === -1,
    "the retired row of a set holding it reads 'In set · retired' and renders no hostile markup", hRow);
  const hRep = dH.fns.retiredSetsNoticeHtml([{ setId: "pset-y", name: "Plain", refs: [bankRef(RETIRED)] }]);
  check(inert(hRep) && hRep.indexOf("q0032 → &quot;&gt;&lt;img") !== -1, "the Sets-list report escapes a hostile replacement qid in its item list", hRep);
  /* the report reaches the Sets tab: viewSets renders exactly this helper
     over the loaded sets (viewSets itself needs the whole tab's state; the
     browser proof, tests/injection-proof.js, renders it end to end) */
  const viewSetsSrc = (() => { try{ return extractFn(src, "viewSets"); }catch(e){ return ""; } })();
  check(/const retiredHtml = retiredSetsNoticeHtml\(sets\);/.test(viewSetsSrc) && /\$\{retiredHtml\}/.test(viewSetsSrc),
    "viewSets renders retiredSetsNoticeHtml(sets) into the Sets card");
  const synth = { items: { [BANK_TWIN]: { canonical: BANK_TWIN }, [PAY + ":" + PAY]: { canonical: BANK_TWIN } }, reference: { forms: [], banks: [] } };
  const dS = build({ inlined: synth });
  dS.fns.ensureDedupLoaded();
  dS.seed({ builder: { setId: null, name: "", subject: "rw", refs: [{ type: "form", testId: PAY, moduleId: "m", qid: PAY }] } });
  const sRow = dS.fns.viewSetBuilder().split('<div class="setpick-row').slice(1).find(r => r.indexOf("<b>" + BANK_TWIN + "</b>") !== -1) || "";
  check(inert(sRow) && sRow.indexOf("In set as &quot;&gt;&lt;img") !== -1, "a bank row 'In set as <hostile ref>' escapes the ref", sRow);
});


console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
