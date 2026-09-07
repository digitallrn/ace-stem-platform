/* tests/canonical-index.test.js — run: node tests/canonical-index.test.js (repo root)

   Canonical-id awareness in the dashboard (2026-09-07): the read-only
   derivations over testdata/dedup-index.js and the loaded attempt records.
   The functions are pulled out of dashboard.js by source text (the
   tutor-writes harness pattern) and run against the REAL committed index
   and manifest, so the proof case is the one David asked for:

     a student who sat 2025 June Asia v2 (202506asiav2), then is offered
     2025 June Asia v4 (202506asiav4): every RW2 overlap the index carries
     is derived — 15 identical items (same canonical id) and 10 reskins
     (family siblings), pinned pair by pair below, none in RW1 or Math.

   Then the contracts around it:
     1. only COMPLETED (or timed-out) attempts count; in-progress never;
     2. a record written under a legacy testId still resolves;
     3. a SET attempt contributes its frozen snapshot refs (form and bank),
        an unknown ref is counted "unindexed", never silently unseen;
     4. the builder holds ONE entry per canonical item for form questions
        (within a form and across forms); bank rows are unaffected;
     5. provenance strings: "also in" = exact class, "reskin of" = family
        outside the class; a ruled-DISTINCT pair shares a family but not a
        canonical id;
     6. honest degradation: malformed / missing / unfetchable index -> one
        notice, marks off, nothing throws; a stale index names the form it
        predates; the Assignments tab keeps its typed form on settle;
     7. every string from the index or a record is escaped on every new
        innerHTML site (hostile ref, family, set name, attempt id).

   To watch this fail on the pre-feature dashboard:
     git show 8915e95:dashboard.js > <scratch>/dashboard-pre.js
     DASHBOARD_SRC=<scratch>/dashboard-pre.js node tests/canonical-index.test.js */
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
  catch(e){ check(false, label + " — case could not run: " + (e && e.message || e)); }
}

/* ---- the real index and manifests, exactly as the browser gets them ---- */
function loadGlobal(file){
  const w = {};
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { window: w });
  return w;
}
const REAL_INDEX = loadGlobal("testdata/dedup-index.js").DEDUP_INDEX;
const TEST_MANIFEST = loadGlobal("testdata/manifest.js").TEST_MANIFEST;
const BANK_MANIFEST = loadGlobal("testdata/bank-manifest.js").BANK_MANIFEST;
const nameOf = id => (TEST_MANIFEST.find(t => t.testId === id) || {}).testName;

/* ---- the dashboard closure, rebuilt per case from the real source ---- */
const NAMES = ["ensureDedupLoaded", "adoptDedup", "onDedupSettled", "normalizeDedupIndex", "splitRef",
  "refText", "canonInfo", "provHtml", "completedAttemptsOf", "attemptRefs", "attemptLabel", "seenSetFor",
  "markFor", "seenCounts", "countsText", "viaText", "markHtml", "selectedStudent", "setRefKeys",
  "dedupNoticeHtml", "overlapFor", "assignOverlapHtml", "overlapNotes", "refreshAssignOverlap",
  "classInBuilder", "builderAddRef", "refKey", "fmtDay", "nameFor", "studentCell", "codeOptionLabel"];
function tryExtract(name){ try{ return extractFn(src, name); }catch(e){ return ""; } }
function tryConst(name){ try{ return extractConst(src, name); }catch(e){ return ""; } }
const BODY = NAMES.map(tryExtract).join("\n") + "\n" +
  ["esc", "escAttr", "MARK_LABEL", "MARK_CLASS", "DEDUP_FETCH_TIMEOUT_MS"].map(tryConst).join("\n");
const PRESENT = NAMES.filter(n => tryExtract(n) !== "");

/* textContent -> innerHTML escaping, as render.js escapeHtml does */
const escapeHtml = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const StudentCode = {
  valid: c => /^AS-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(String(c || "").trim().toUpperCase()),
  normalize: c => String(c || "").trim().toUpperCase().replace(/\s+/g, "")
};

function build(opts){
  opts = opts || {};
  const els = {};
  const $ = id => els[id] || (els[id] = { value: "", innerHTML: "", textContent: "", selectedOptions: [] });
  const scripts = [];
  /* a document whose appended <script> immediately reports what the case
     wants: "error" (404/offline), "empty" (loaded, registered nothing),
     "hang" (never settles), or "ok" (registers the given index) */
  const documentStub = {
    createElement: () => ({ remove(){}, onload: null, onerror: null, src: "", async: false }),
    head: { appendChild(s){
      scripts.push(s.src);
      const mode = opts.fetch || "error";
      if(mode === "error") s.onerror();
      else if(mode === "empty") s.onload();
      else if(mode === "ok"){ windowStub.DEDUP_INDEX = opts.fetched; s.onload(); }
    } }
  };
  const windowStub = { TEST_MANIFEST: opts.manifest || TEST_MANIFEST, BANK_MANIFEST: BANK_MANIFEST };
  if(opts.inlined) windowStub.DEDUP_INDEX = opts.inlined;
  const factory = new Function("window", "document", "$", "escapeHtml", "StudentCode", "setTimeout", "clearTimeout", `
    let recs = [], profiles = {}, builder = null, tab = "sets";
    const loads = { render: 0, overlap: 0 };
    const testsById = {};
    (window.TEST_MANIFEST || []).forEach(t => { testsById[t.testId] = t; (t.legacyIds || []).forEach(old => { testsById[old] = t; }); });
    let dedup = null, dedupState = "idle", dedupNote = "", seenCache = {};
    function render(){ loads.render++; seenCache = {}; }
    ${BODY}
    const fns = {};
    ${PRESENT.map(n => `fns[${JSON.stringify(n)}] = ${n};`).join("\n")}
    return {
      fns, loads,
      state: () => ({ dedup, dedupState, dedupNote, recs, builder, tab }),
      seed: o => {
        if("recs" in o) recs = o.recs; if("builder" in o) builder = o.builder; if("tab" in o) tab = o.tab;
        if("profiles" in o) profiles = o.profiles;
        seenCache = {};
      }
    };
  `);
  const d = factory(windowStub, documentStub, $, escapeHtml, StudentCode, () => 0, () => {});
  d.els = els; d.$ = $; d.scripts = scripts; d.window = windowStub;
  return d;
}
const CODE = "AS-TESTSEEN";
const OTHER = "AS-OTHERKID";
function formRec(testId, status, extra){
  return Object.assign({ recordVersion: 1, attemptId: "attempt:" + testId + ":1700000000:t1",
    student: { code: CODE, key: CODE }, testId: testId, testName: "(record name)", testVersion: "x",
    status: status || "completed", startedAt: "2026-09-01T10:00:00.000Z", submittedAt: "2026-09-01T12:30:00.000Z",
    modules: [], answers: {}, score: null }, extra || {});
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
  const o = d.fns.overlapFor(CODE, "202506asiav4");
  check(!!o && o.total === 98 && o.attempts === 1, "the offered form has 98 indexed items; one completed attempt counted",
    o && JSON.stringify({ total: o.total, attempts: o.attempts }));
  const seenPairs = o.seenItems.map(x => [x.ref.split(":")[1], x.via[0].ref.split(":")[1]]).sort();
  const wantSeen = EXACT_V4_V2.slice().sort();
  check(JSON.stringify(seenPairs) === JSON.stringify(wantSeen),
    "SEEN: exactly the 15 identical RW2 items, each traced to its 202506asiav2 canonical",
    "got " + JSON.stringify(seenPairs));
  const reskinPairs = o.reskinItems.map(x => [x.ref.split(":")[1], x.via[0].ref.split(":")[1]]).sort();
  const wantReskin = SKELETON_V4_V2.slice().sort();
  check(JSON.stringify(reskinPairs) === JSON.stringify(wantReskin),
    "RESKIN: exactly the 10 family siblings in RW2, each traced to its 202506asiav2 reskin",
    "got " + JSON.stringify(reskinPairs));
  check(o.seenItems.concat(o.reskinItems).every(x => x.ref.indexOf("202506asiav4:re2-") === 0),
    "nothing outside RW2 is flagged (RW1 and both Math modules are clean between these forms)");
  check(o.sources.length === 1 && o.sources[0].seen === 15 && o.sources[0].reskin === 10 &&
        o.sources[0].name === nameOf("202506asiav2") && o.sources[0].status === "completed",
    "the source attempt is named from the MANIFEST (not the record's testName) with 15 identical / 10 reskin",
    JSON.stringify(o.sources));
  const seen = d.fns.seenSetFor(CODE);
  const c = d.fns.seenCounts(REAL_INDEX.reference ? (d.state().dedup.byContainer["202506asiav4"]) : [], seen);
  check(c.seen === 15 && c.reskin === 10 && c.unseen === 73 && c.unindexed === 0 && c.total === 98,
    "seenCounts over the whole form: 15 seen · 10 reskin · 73 unseen · 0 not indexed", JSON.stringify(c));
  check(d.fns.countsText(c) === "15 seen · 10 reskin · 73 unseen", "countsText omits the not-indexed clause when zero", d.fns.countsText(c));
  const m13 = d.fns.markFor("202506asiav4:re2-q13", seen), m7 = d.fns.markFor("202506asiav4:re2-q7", seen), m30 = d.fns.markFor("202506asiav4:re1-q1", seen);
  check(m13.mark === "seen" && m13.via[0].ref === "202506asiav2:re2-q15" && m7.mark === "reskin" && m7.via[0].ref === "202506asiav2:re2-q8" && m30.mark === "unseen",
    "markFor: re2-q13 seen (via v2 re2-q15), re2-q7 reskin (via v2 re2-q8), re1-q1 unseen");
  const html = d.fns.assignOverlapHtml([CODE], "202506asiav4");
  check(html.indexOf("has already seen 25 of " + nameOf("202506asiav4") + "’s 98 items") !== -1 &&
        html.indexOf("15 identical (same canonical id) and 10 reskins") !== -1 &&
        html.indexOf("nothing is excluded automatically") !== -1,
    "the assignment warning reads 25 of 98 — 15 identical, 10 reskins — and says nothing is excluded", html.slice(0, 400));
  const notes = d.fns.overlapNotes([CODE], "202506asiav4");
  check(notes.length === 1 && notes[0] === CODE + " had already seen 25 of its 98 items (15 identical, 10 reskin).",
    "status-line note after Create assignment repeats the overlap", JSON.stringify(notes));
  const none = d.fns.overlapFor(CODE, "202503usv1");
  check(!!none && none.seenItems.length === 0 && none.reskinItems.length === 0,
    "control: 2025 March US v1 shares nothing with 202506asiav2 — zero overlap");
});

console.log("--- 1. completed attempts only ---");
run("completed-only", () => {
  const d = build({ inlined: REAL_INDEX });
  d.seed({ recs: [formRec("202506asiav2", "in-progress")] });
  d.fns.ensureDedupLoaded();
  const o = d.fns.overlapFor(CODE, "202506asiav4");
  check(o.attempts === 0 && o.seenItems.length === 0 && o.reskinItems.length === 0,
    "an in-progress sitting contributes nothing (attempts 0, no items)");
  d.seed({ recs: [formRec("202506asiav2", "timed-out")] });
  const o2 = d.fns.overlapFor(CODE, "202506asiav4");
  check(o2.attempts === 1 && o2.seenItems.length === 15, "a timed-out sitting counts as completed");
  d.seed({ recs: [Object.assign(formRec("202506asiav2"), { student: { code: OTHER, key: OTHER } })] });
  check(d.fns.overlapFor(CODE, "202506asiav4").attempts === 0 && d.fns.overlapFor(OTHER, "202506asiav4").seenItems.length === 15,
    "the seen set is per student — another code's sitting never marks this one");
  check(d.fns.seenSetFor("") === null, "no student selected -> no seen set (marks off, not 'all unseen')");
});

console.log("--- 2. legacy testId resolves through the manifest ---");
run("legacy", () => {
  const d = build({ inlined: REAL_INDEX });
  d.seed({ recs: [formRec("2026-june-asia-v1")] });    // the legacy id of 202606asiav1
  d.fns.ensureDedupLoaded();
  check(d.fns.attemptRefs(formRec("2026-june-asia-v1")).length === 98, "attemptRefs: legacy id -> the 98 refs of 202606asiav1");
  const seen = d.fns.seenSetFor(CODE);
  const q4 = d.fns.markFor("202606asiav2:re1-q4", seen), q15 = d.fns.markFor("202606asiav2:re1-q15", seen);
  check(q4.mark === "seen" && q4.via[0].ref === "202606asiav1:re1-q4" && q4.via[0].name === nameOf("202606asiav1"),
    "202606asiav2 re1-q4 is SEEN via 202606asiav1 re1-q4 (sibling-reskin class, key-agreeing)");
  check(q15.mark === "reskin" && q15.via[0].ref === "202606asiav1:re1-q15", "202606asiav2 re1-q15 is RESKIN via 202606asiav1 re1-q15 (skeleton)");
  const q7 = d.fns.markFor("202606asiav2:re1-q7", seen);
  check(q7.mark === "seen", "a key-ruling pair (keys legitimately differ) is still the same canonical item -> seen");
});

console.log("--- 3. set attempts contribute their frozen snapshot ---");
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
  check(m.mark === "seen" && m.via[0].name === "Warm-up" && m.via[0].ref === "202506asiav2:re2-q15",
    "a form question in a completed SET marks its exact duplicate on another form seen, named after the set");
  check(d.fns.markFor("bank-david-core:q0001", seen).mark === "seen", "a bank question in a completed set is seen");
  check(seen.unindexed === 1, "an unknown snapshot ref is counted unindexed (1), not dropped silently", String(seen.unindexed));
  check(d.fns.markFor("202506asiav4:re2-q1", seen).mark === "unseen", "the set does not mark items it did not hold");
  const o = d.fns.overlapFor(CODE, "202506asiav4");
  check(o.seenItems.length === 1 && o.reskinItems.length === 0 && o.sources[0].name === "Warm-up" && o.sources[0].seen === 1,
    "overlap from a set attempt: 1 identical item, source line names the set", JSON.stringify(o.sources));
  const noSnap = Object.assign({}, setRec, { setQuestions: undefined, answers: { "202506asiav2:re2-q15": {}, "junk": {} } });
  check(JSON.stringify(d.fns.attemptRefs(noSnap)) === JSON.stringify(["202506asiav2:re2-q15", "junk"]),
    "a set record with no snapshot falls back to its answer keys");
});

console.log("--- 4. builder: one entry per canonical item (form questions), bank unaffected ---");
run("builder", () => {
  const d = build({ inlined: REAL_INDEX });
  d.fns.ensureDedupLoaded();
  const holds = [{ type: "form", testId: "202506asiav2", moduleId: "m", qid: "re2-q15" }];
  d.seed({ builder: { setId: null, name: "", subject: "rw", refs: holds } });
  check(d.fns.classInBuilder("202506asiav4:re2-q13") === "202506asiav2:re2-q15",
    "classInBuilder: v4 re2-q13's exact class is held by v2 re2-q15");
  check(d.fns.classInBuilder("202506asiav4:re2-q7") === null, "a reskin (family, not class) is NOT held");
  d.fns.builderAddRef({ type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q13" });
  check(d.state().builder.refs.length === 1 && d.loads.render === 0,
    "builderAddRef refuses a second member of a held canonical class (no push, no render)");
  d.fns.builderAddRef({ type: "form", testId: "202506asiav4", moduleId: "m", qid: "re2-q7" });
  check(d.state().builder.refs.length === 2, "a reskin is a different canonical item — it can be added");
  d.seed({ builder: { setId: null, name: "", subject: "math", refs: [{ type: "form", testId: "202512usv2", moduleId: "m", qid: "ma1-q4" }] } });
  check(d.fns.classInBuilder("202512usv2:ma1-q11") === "202512usv2:ma1-q4",
    "within-form duplicate: 202512usv2 ma1-q11 is held by ma1-q4 (dup-ack pair)");
  /* bank unaffected: a synthetic index where a bank item is an exact
     duplicate of a held form item — the bank ref still adds */
  const synth = { items: { "202506asiav2:ma1-q1": { canonical: "202506asiav2:ma1-q1" },
                           "bank-david-core:q0001": { canonical: "202506asiav2:ma1-q1" } },
                  reference: { forms: [], banks: [] } };
  const d2 = build({ inlined: synth });
  d2.fns.ensureDedupLoaded();
  d2.seed({ builder: { setId: null, name: "", subject: "math", refs: [{ type: "form", testId: "202506asiav2", moduleId: "m", qid: "ma1-q1" }] } });
  d2.fns.builderAddRef({ type: "bank", bankId: "bank-david-core", qid: "q0001" });
  check(d2.state().builder.refs.length === 2, "bank rows are unaffected by the grouping: the bank copy of a held item still adds");
  d2.fns.builderAddRef({ type: "bank", bankId: "bank-david-core", qid: "q0001" });
  check(d2.state().builder.refs.length === 2, "plain duplicate refs are still refused");
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
  check(cv2.canonical === "202506asiav2:re2-q15" && JSON.stringify(cv2.alsoIn) === JSON.stringify(["202506asiav4:re2-q13"]),
    "the canonical member lists its later duplicate as 'also in'");
  check(d.fns.provHtml("202506asiav4:re1-q1") === "", "a singleton has no provenance");
  const a = d.fns.canonInfo("202503usv1:ma1-q22"), b = d.fns.canonInfo("202508asiav1:ma2-q16");
  check(a.canonical !== b.canonical && a.family === b.family && a.reskins.indexOf("202508asiav1:ma2-q16") !== -1,
    "a ruled-DISTINCT pair shares a family (shown as reskin) but not a canonical id (never 'also in')");
  check(d.fns.refText("bank-david-core:q0001") === "bank-david-core q0001" && d.fns.refText("nope:q1") === "nope q1",
    "refText: bank refs print the bankId; unknown containers print raw");
});

console.log("--- 6. honest degradation ---");
run("degrade", () => {
  check(build().fns.normalizeDedupIndex(null) === null && build().fns.normalizeDedupIndex({ items: "x" }) === null &&
        build().fns.normalizeDedupIndex({}) === null, "normalize: null / non-object items / no items -> null");
  const n = build().fns.normalizeDedupIndex({ items: { "t:q1": { canonical: 5, family: 7 }, "t:q2": null, "t:q3": { canonical: "t:q1" } } });
  check(!!n && n.items["t:q1"].canonical === "t:q1" && n.items["t:q1"].family === null && !("t:q2" in n.items) &&
        JSON.stringify(n.classes["t:q1"]) === JSON.stringify(["t:q1", "t:q3"]) && JSON.stringify(n.byContainer.t) === JSON.stringify(["t:q1", "t:q3"]),
    "normalize: non-string canonical -> self, non-string family -> none, null entries dropped, classes canonical-first");
  const d1 = build({ inlined: { nope: true } });
  d1.fns.ensureDedupLoaded();
  check(d1.state().dedupState === "failed" && /malformed/.test(d1.state().dedupNote) && /unavailable/.test(d1.fns.dedupNoticeHtml()) &&
        d1.fns.dedupNoticeHtml().indexOf("malformed") !== -1,
    "a malformed inlined index -> failed, notice says unavailable + why");
  const d2 = build({ fetch: "error", tab: "sets" });
  d2.fns.ensureDedupLoaded();
  check(d2.scripts[0] === "testdata/dedup-index.js" && d2.state().dedupState === "failed" && /fetched/.test(d2.state().dedupNote) && d2.loads.render === 1,
    "an unfetchable index -> failed after ONE fetch attempt, a re-render carries the notice", JSON.stringify([d2.scripts, d2.state().dedupNote, d2.loads]));
  d2.fns.ensureDedupLoaded();
  check(d2.scripts.length === 1, "a failed load is never re-issued on later renders (no network hammering)");
  check(d2.fns.markFor("202506asiav4:re2-q13", { canon: {}, fam: {} }) === null && d2.fns.seenSetFor(CODE) === null &&
        d2.fns.canonInfo("202506asiav4:re2-q13") === null && d2.fns.provHtml("x") === "" && d2.fns.classInBuilder("x") === null,
    "with no index every derivation returns null/empty — marks off, nothing throws");
  const html = d2.fns.assignOverlapHtml([CODE], "202506asiav4");
  check((html.match(/canon-notice/g) || []).length === 1 && html.indexOf("unavailable") !== -1 && html.indexOf("canon-overlap") === -1,
    "Assignments tab: exactly ONE visible notice, no overlap block, when the index is off");
  check(d2.fns.overlapNotes([CODE], "202506asiav4").length === 0, "no status-line overlap note when the index is off");
  const d3 = build({ fetch: "empty" });
  d3.fns.ensureDedupLoaded();
  check(d3.state().dedupState === "failed" && /registered nothing/.test(d3.state().dedupNote), "a file that registers nothing -> failed, says so");
  const d4 = build({ fetch: "ok", fetched: REAL_INDEX });
  d4.seed({ recs: [formRec("202506asiav2")] });
  d4.fns.ensureDedupLoaded();
  check(d4.state().dedupState === "ready" && d4.loads.render === 1 && d4.fns.overlapFor(CODE, "202506asiav4").seenItems.length === 15,
    "a fetched index -> ready, one re-render, same derivation as inlined");
  check(d4.fns.dedupNoticeHtml() === "", "ready and covering every manifest test/bank -> no notice at all");
  /* Assignments tab: settling must not rebuild the form the tutor is typing in */
  const d5 = build({ fetch: "ok", fetched: REAL_INDEX });
  d5.seed({ tab: "assign", recs: [formRec("202506asiav2")] });
  d5.$("afTest").value = "202506asiav4";
  d5.$("afCodes").selectedOptions = [{ value: CODE }];
  d5.$("afFree").value = "as-abcdefgh, junk";
  d5.$("afOverlap").innerHTML = "loading…";
  d5.fns.ensureDedupLoaded();
  check(d5.loads.render === 0 && d5.$("afOverlap").innerHTML.indexOf("has already seen 25 of") !== -1,
    "settling on the Assignments tab refreshes ONLY the overlap block (render() not called; typed codes survive)",
    "render=" + d5.loads.render);
  check(d5.$("afOverlap").innerHTML.indexOf("AS-ABCDEFGH") !== -1 && d5.$("afOverlap").innerHTML.indexOf("junk") === -1 &&
        d5.$("afOverlap").innerHTML.indexOf("no completed attempts yet") !== -1,
    "typed codes are normalized and validated; a valid unknown code gets the honest 'no completed attempts' line");
  /* stale index: a manifest test the index predates */
  const extra = TEST_MANIFEST.concat([{ testId: "209901usv1", testName: "2099 January US v1", testVersion: "z", legacyIds: [] }]);
  const d6 = build({ inlined: REAL_INDEX, manifest: extra });
  d6.seed({ recs: [formRec("202506asiav2")] });
  d6.fns.ensureDedupLoaded();
  check(d6.fns.dedupNoticeHtml().indexOf("predates 2099 January US v1") !== -1, "a test the index predates is named in the notice");
  const o = d6.fns.overlapFor(CODE, "209901usv1");
  check(o.total === 0 && o.seenItems.length === 0, "overlap against an unindexed form is 0 of 0, not a throw");
  check(d6.fns.markFor("209901usv1:re1-q1", d6.fns.seenSetFor(CODE)).mark === "unindexed", "its questions mark 'unindexed', never 'unseen'");
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
    }, reference: { forms: TEST_MANIFEST.map(t => ({ testId: t.testId })), banks: BANK_MANIFEST.map(b => ({ bankId: b.bankId })) } };
  const d = build({ inlined: idx });
  const rec = { attemptId: "attempt:pset-h:1:" + PAY, student: { code: CODE, key: CODE }, kind: "set", testId: "pset-h", setId: "pset-h",
    setName: PAY, status: "completed", submittedAt: PAY, lastSavedAt: PAY,
    setQuestions: [{ ref: hostileRef, source: "form", testId: PAY, qid: PAY }] };
  d.seed({ recs: [rec] });
  d.fns.ensureDedupLoaded();
  /* inert = the payload survives only as escaped TEXT: no element, and the
     escaped form is present. A bare onerror=" inside text is harmless. */
  const inert = s => s.indexOf("<img") === -1 && s.indexOf("<b>PWN") === -1 && s.indexOf("&lt;img") !== -1;
  check(inert(d.fns.provHtml("202506asiav4:re2-q13")), "'also in <hostile ref>' is escaped", d.fns.provHtml("202506asiav4:re2-q13"));
  check(inert(d.fns.provHtml("202506asiav4:re2-q7")), "'reskin of <hostile ref>' is escaped", d.fns.provHtml("202506asiav4:re2-q7"));
  const seen = d.fns.seenSetFor(CODE);
  const mh = d.fns.markHtml(d.fns.markFor("202506asiav4:re2-q13", seen));
  /* the title ATTRIBUTE must hold no raw quote (escAttr) — a raw quote in
     the inline TEXT span is harmless and stays */
  check(inert(mh) && /title="[^"]*&lt;img[^"]*"/.test(mh) && /title="[^"]*&quot;/.test(mh) && mh.indexOf("canon-mark seen") !== -1,
    "the seen mark's inline via (record setName + hostile ref) and its title attribute are escaped", mh);
  const oh = d.fns.assignOverlapHtml([CODE], "202506asiav4");
  // the synthetic form has two items: re2-q13 (seen via the hostile duplicate) and re2-q7 (reskin via the hostile family)
  check(inert(oh) && oh.indexOf("has already seen 2 of") !== -1 && oh.indexOf("1 identical (same canonical id) and 1 reskin") !== -1,
    "the overlap block (source name, status, date, ref) is escaped", oh);
  const notes = d.fns.overlapNotes([CODE], "202506asiav4");
  check(notes.length === 1 && notes[0] === CODE + " had already seen 2 of its 2 items (1 identical, 1 reskin).", "overlap notes are plain text for the status line", JSON.stringify(notes));
  const d2 = build({ inlined: { items: {}, reference: { forms: [], banks: [] } }, manifest: [{ testId: "t1", testName: PAY, legacyIds: [] }] });
  d2.fns.ensureDedupLoaded();
  check(inert(d2.fns.dedupNoticeHtml()), "a hostile manifest name in the stale-index notice is escaped", d2.fns.dedupNoticeHtml());
});

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
