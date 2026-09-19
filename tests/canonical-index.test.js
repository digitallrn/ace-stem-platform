/* tests/canonical-index.test.js — run: node tests/canonical-index.test.js (repo root)

   Canonical-id awareness in the dashboard (2026-09-07): the read-only
   derivations over testdata/dedup-index.js and the loaded attempt records.
   The functions are pulled out of dashboard.js by source text (the
   tutor-writes harness pattern) and run against the REAL committed index,
   manifest, test files and render.js escapeHtml, so the proof case is the
   one David asked for:

     a student who sat 2025 June Asia v2 (202506asiav2), then is offered
     2025 June Asia v4 (202506asiav4): every RW2 overlap the index carries
     is derived — 15 identical items (same canonical id) and 10 reskins
     (family siblings), pinned pair by pair below, none in RW1 or Math.

   Then the contracts around it:
     1. only COMPLETED (or timed-out) attempts count; in-progress never;
     2. a legacy testId resolves through the manifest on EVERY index lookup:
        a form record, a set snapshot ref and a saved set ref alike;
     3. a SET attempt contributes its frozen snapshot refs (form and bank);
        an unknown ref is counted "unindexed" AND surfaced as a caveat,
        never silently unseen;
     4. the builder holds ONE entry per canonical item for form questions
        (within a form and across forms), bank rows are unaffected in BOTH
        directions, and copies that got in anyway are called out;
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
     9. a retake counts each form item once per source attempt.

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
const REAL_INDEX = loadScript("testdata/dedup-index.js").window.DEDUP_INDEX;
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
  "tombFor", "isDeletedStudent", "isTombstoned", "deletedAttemptsOf"];
const CONSTS = ["esc", "escAttr", "MARKS", "DEDUP_FETCH_TIMEOUT_MS", "KEPT_VALUES", "KEPT_CHECKS", "KEPT_MULTI"];
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
  const windowStub = { TEST_MANIFEST: opts.manifest || TEST_MANIFEST, BANK_MANIFEST: opts.banks || BANK_MANIFEST };
  if(opts.inlined) windowStub.DEDUP_INDEX = opts.inlined;
  const setTimeoutStub = (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; };
  const clearTimeoutStub = id => { if(timers[id - 1]) timers[id - 1].cleared = true; };
  const factory = new Function("window", "document", "$", "escapeHtml", "StudentCode", "setTimeout", "clearTimeout", "wipe", `
    let recs = [], profiles = {}, builder = null, tab = ${JSON.stringify(opts.tab || "sets")}, tombs = {};
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
        if("profiles" in o) profiles = o.profiles;
      }
    };
  `);
  const wipe = () => Object.keys(els).forEach(id => {
    const el = els[id];
    el.value = ""; el.innerHTML = ""; el.checked = false;
    if(el.options) el.options.forEach(o => { o.selected = false; }); else el.selectedOptions = [];
  });
  const d = factory(windowStub, documentStub, $, escapeHtml, StudentCode, setTimeoutStub, clearTimeoutStub, wipe);
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
const EXACT_V4_V2 = [   // 202506asiav4 RW2 item  =  its canonical on 202506asiav2
  ["re2-q1", "re2-q1"], ["re2-q2", "re2-q2"], ["re2-q3", "re2-q3"], ["re2-q4", "re2-q4"],
  ["re2-q6", "re2-q7"], ["re2-q11", "re2-q12"], ["re2-q12", "re2-q14"], ["re2-q13", "re2-q15"],
  ["re2-q14", "re2-q16"], ["re2-q15", "re2-q17"], ["re2-q17", "re2-q19"], ["re2-q18", "re2-q20"],
  ["re2-q20", "re2-q22"], ["re2-q21", "re2-q23"], ["re2-q22", "re2-q24"]
];
const SKELETON_V4_V2 = [   // 202506asiav4 RW2 item  ~  its reskin on 202506asiav2
  ["re2-q5", "re2-q6"], ["re2-q7", "re2-q8"], ["re2-q8", "re2-q9"], ["re2-q9", "re2-q10"],
  ["re2-q10", "re2-q11"], ["re2-q16", "re2-q18"], ["re2-q19", "re2-q21"], ["re2-q24", "re2-q25"],
  ["re2-q26", "re2-q26"], ["re2-q27", "re2-q27"]
];
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
    "SEEN: exactly the 15 identical RW2 items, each traced to its 202506asiav2 canonical", "got " + JSON.stringify(seenPairs));
  const reskinPairs = o.reskinItems.map(x => [x.ref.split(":")[1], x.via[0].ref.split(":")[1]]).sort();
  check(JSON.stringify(reskinPairs) === JSON.stringify(SKELETON_V4_V2.slice().sort()),
    "RESKIN: exactly the 10 family siblings in RW2, each traced to its 202506asiav2 reskin", "got " + JSON.stringify(reskinPairs));
  check(o.seenItems.concat(o.reskinItems).every(x => x.ref.indexOf("202506asiav4:re2-") === 0),
    "nothing outside RW2 is flagged (RW1 and both Math modules are clean between these forms)");
  check(o.sources.length === 1 && o.sources[0].seen === 15 && o.sources[0].reskin === 10 &&
        o.sources[0].att.name === nameOf("202506asiav2") && o.sources[0].att.status === "completed",
    "the source attempt is named from the MANIFEST (not the record's testName) with 15 identical / 10 reskin", JSON.stringify(o.sources));
  const seen = d.fns.seenSetFor(CODE);
  const c = d.fns.seenCounts(d.fns.formRefs("202506asiav4"), seen);
  check(c.seen === 15 && c.reskin === 10 && c.unseen === 73 && c.unindexed === 0 && c.total === 98,
    "seenCounts over the whole form: 15 seen · 10 reskin · 73 unseen · 0 not indexed", JSON.stringify(c));
  check(d.fns.countsText(c) === "15 seen · 10 reskin · 73 unseen", "countsText omits the not-indexed clause when zero", d.fns.countsText(c));
  const m13 = d.fns.markFor("202506asiav4:re2-q13", seen), m7 = d.fns.markFor("202506asiav4:re2-q7", seen), m30 = d.fns.markFor("202506asiav4:re1-q1", seen);
  check(m13.mark === "seen" && m13.via[0].ref === "202506asiav2:re2-q15" && m7.mark === "reskin" && m7.via[0].ref === "202506asiav2:re2-q8" && m30.mark === "unseen",
    "markFor: re2-q13 seen (via v2 re2-q15), re2-q7 reskin (via v2 re2-q8), re1-q1 unseen");
  const html = d.fns.assignOverlapHtml([CODE], "202506asiav4");
  check(html.indexOf("has already seen 25 of " + nameOf("202506asiav4") + "’s 98 items") !== -1 &&
        html.indexOf("15 identical (same canonical id) and 10 reskin items (family siblings)") !== -1 &&
        html.indexOf("nothing is excluded automatically") !== -1,
    "the assignment warning reads 25 of 98 — 15 identical, 10 reskin items — and says nothing is excluded", html.slice(0, 400));
  const notes = d.fns.overlapNotes([CODE], "202506asiav4");
  check(notes.length === 1 && notes[0] === CODE + " had already seen 25 of its 98 items (15 identical, 10 reskin).",
    "status-line note after Create assignment repeats the overlap", JSON.stringify(notes));
  const none = d.fns.overlapFor(CODE, "202503usv1");
  check(!!none && none.seenItems.length === 0 && none.reskinItems.length === 0,
    "control: 2025 March US v1 shares nothing with 202506asiav2 — zero overlap");
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
  check(d.fns.overlapFor(CODE, "202506asiav4").attempts === 1 && d.fns.overlapFor(CODE, "202506asiav4").seenItems.length === 15, "a timed-out sitting counts as completed");
  d.seed({ recs: [Object.assign(formRec("202506asiav2"), { student: { code: OTHER, key: OTHER } })] });
  check(d.fns.overlapFor(CODE, "202506asiav4").attempts === 0 && d.fns.overlapFor(OTHER, "202506asiav4").seenItems.length === 15,
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

console.log("--- 4. builder: one entry per canonical item (form questions), bank unaffected both ways ---");
run("builder", () => {
  const d = build({ inlined: REAL_INDEX });
  d.fns.ensureDedupLoaded();
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [{ type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15" }] } });
  const cand13 = { type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q13" };
  check(d.fns.builderHeldAs(cand13) === "202506asiav2:re2-q15", "builderHeldAs: v4 re2-q13's exact class is held by v2 re2-q15");
  check(d.fns.builderHeldAs({ type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q7" }) === null, "a reskin (family, not class) is NOT held");
  d.fns.builderAddRef(cand13);
  check(d.state().builder.refs.length === 1 && d.loads.render === 0, "builderAddRef refuses a second member of a held canonical class (no push, no render)");
  d.fns.builderAddRef({ type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q7" });
  check(d.state().builder.refs.length === 2 && d.loads.render === 1, "a reskin is a different canonical item — it can be added (one render)");
  check(d.fns.builderHeldAs({ type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15" }) === "202506asiav2:re2-q15", "a ref already in the set is held by its own key");
  d.seed({ builder: { setId: null, name: "", subject: "math", refs: [{ type: "form", testId: "202512usv2", moduleId: "m", qid: "ma1-q4" }] } });
  check(d.fns.builderHeldAs({ type: "form", testId: "202512usv2", moduleId: "m", qid: "ma1-q11" }) === "202512usv2:ma1-q4",
    "within-form duplicate: 202512usv2 ma1-q11 is held by ma1-q4 (dup-ack pair)");
  /* bank unaffected in BOTH directions: a synthetic index where a bank item
     is an exact duplicate of a form item */
  const synth = { items: { "202506asiav2:ma1-q1": { canonical: "202506asiav2:ma1-q1" },
                           "bank-david-core:q0001": { canonical: "202506asiav2:ma1-q1" } },
                  reference: { forms: [], banks: [] } };
  const d2 = build({ inlined: synth });
  d2.fns.ensureDedupLoaded();
  d2.seed({ builder: { setId: null, name: "", subject: "math", refs: [{ type: "form", testId: "202506asiav2", moduleId: "m", qid: "ma1-q1" }] } });
  check(d2.fns.pushRef({ type: "bank", bankId: "bank-david-core", qid: "q0001" }) === true && d2.state().builder.refs.length === 2,
    "form held, bank copy offered: the bank ref still adds (bank rows are unaffected)");
  check(d2.fns.pushRef({ type: "bank", bankId: "bank-david-core", qid: "q0001" }) === false && d2.state().builder.refs.length === 2, "plain duplicate refs are still refused");
  d2.seed({ builder: { setId: null, name: "", subject: "math", refs: [{ type: "bank", bankId: "bank-david-core", qid: "q0001" }] } });
  check(d2.fns.builderHeldAs({ type: "form", testId: "202506asiav2", moduleId: "m", qid: "ma1-q1" }) === null &&
        d2.fns.pushRef({ type: "form", testId: "202506asiav2", moduleId: "m", qid: "ma1-q1" }) === true,
    "bank held, form copy offered: the form ref still adds — the outcome does not depend on click order");
  /* copies that got in anyway (index not loaded at the time) are called out */
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: [
    { type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15" },
    { type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q13" },
    { type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q7" }] } });
  const groups = d.fns.builderDuplicateGroups();
  check(groups.length === 1 && JSON.stringify(groups[0]) === JSON.stringify(["202506asiav2:re2-q15", "202506asiav4:re2-q13"]),
    "builderDuplicateGroups names the two members of one class and ignores the singleton", JSON.stringify(groups));
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
  const c7 = d.fns.canonInfo("202506asiav4:re2-q7");
  check(c7.alsoIn.length === 0 && JSON.stringify(c7.reskins) === JSON.stringify(["202506asiav2:re2-q8"]) &&
        d.fns.provHtml("202506asiav4:re2-q7") === '<span class="canon-prov reskin">reskin of ' + nameOf("202506asiav2") + " re2-q8</span>",
    "provHtml: 'reskin of 2025 June Asia v2 re2-q8' for a skeleton sibling");
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
  check(d4.state().dedupState === "ready" && d4.scripts.length === 1 && d4.fns.overlapFor(CODE, "202506asiav4").seenItems.length === 15,
    "the next render adopts the late-arriving index from memory — no second fetch, marks on");
  const d5 = build({ fetch: "ok", fetched: REAL_INDEX });
  d5.seed({ recs: [formRec("202506asiav2")] });
  d5.fns.ensureDedupLoaded();
  check(d5.state().dedupState === "ready" && d5.loads.render === 1 && d5.fns.overlapFor(CODE, "202506asiav4").seenItems.length === 15,
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
  check(notice.indexOf("predates 2099 January US v1") !== -1 && notice.indexOf("different build of " + nameOf("202506asiav2") + " (index 2026-09-04-a, library 2099-01-01-a)") !== -1 &&
        (notice.match(/canon-notice/g) || []).length === 1,
    "one notice names both the test the index predates and the test it was built against a different version of", notice);
  const seen9 = d9.fns.seenSetFor(CODE);
  check(seen9.attempts === 2 && seen9.unindexed === 2 && seen9.unindexedAttempts === 1, "a completed attempt on the unindexed form counts its 2 refs as unindexed (1 attempt)", JSON.stringify([seen9.attempts, seen9.unindexed, seen9.unindexedAttempts]));
  const o9 = d9.fns.overlapFor(CODE, "209901usv1");
  check(o9.total === 0 && o9.seenItems.length === 0 && d9.fns.assignOverlapHtml([CODE], "209901usv1").indexOf("is not in the canonical-id index, so nothing can be compared") !== -1,
    "offering the unindexed form: 0 of 0 reads as 'not in the index', never 'none of its 0 items'");
  const h9 = d9.fns.assignOverlapHtml([CODE], "202503usv1");
  check(h9.indexOf("none of " + nameOf("202503usv1") + "’s 98 items appear in their 2 completed attempts") !== -1 && h9.indexOf("2 questions from 1 of their 2 completed attempts are not in the index") !== -1,
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
    check(!!seen && seen.attempts === 1 && !!o && o.seenItems.length === 15 && d.fns.assignOverlapHtml([bad], "202506asiav4").indexOf("has already seen 25 of") !== -1 &&
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

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
