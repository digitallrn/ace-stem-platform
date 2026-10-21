/* tests/test-viewer.test.js — run: node tests/test-viewer.test.js (repo root)

   The tutor test viewer (2026-10-21): dashboard → Tests opens any manifest
   form read-only, through Review Mode's replay with nobody's work in it. It
   replaces assigning a form to a code and sitting it just to look at it —
   every such sitting wrote a real attempt record — so its first rule is that
   it WRITES NOTHING, and its second is that only the signed-in dashboard can
   open it. This suite is the node half of the proof (the other half is
   tests/viewer-proof.js, which walks every form in a real browser). Every
   check has a CONTROL that fails when the guard it protects is taken away;
   a check that cannot fail proves nothing.

     §1 the loader: loadTestReadOnly writes no storage on its memory, cache
        and network paths (control: loadTest, the sitting's loader, does);
     §2 parseRef: both id spellings, zero-padded and q-less forms; nothing
        else is read as a question id;
     §3 the bridge: AppTestViewer.open refuses unless the dashboard is the
        screen showing and, in remote mode, a tutor token is held;
     §4 open / exit, run for real with recording stubs: the stand-in record
        reaches nothing but buildModuleStateFromRecord, the recorder is
        detached BEFORE state changes, the session fence holds, a missing
        question never guesses, exit never runs Dashboard.open;
     §5 the SPR key block: review's output is byte-identical to the build
        before the sprKeyHtml split, over every shipped SPR; the viewer's
        three states;
     §6 the Tests tab, run for real: manifest order, em-dash cells, every
        manifest value and every echo escaped, the Go-to matching rules, and
        the counts loader never touching the caching loader;
     §7 source sweeps: no viewer function reaches a write API, the only
        caller of the bridge is the Tests tab, no new URL input, the
        test-bank's Stage-3 anchor still appears exactly once.

   app.js and dashboard.js are pulled apart by source text, as the other
   suites do (tests/extract-helper.js). */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { extractFn, extractConst } = require("./extract-helper");

const repo = path.join(__dirname, "..");
const readLf = p => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const appSrc = readLf(process.env.APP_SRC || path.join(repo, "app.js"));
const dashSrc = readLf(process.env.DASHBOARD_SRC || path.join(repo, "dashboard.js"));
const renderSrc = readLf(path.join(repo, "render.js"));
const gradingSrc = readLf(path.join(repo, "grading.js"));

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}
/* a control must REALLY fail the guarded property: run the same probe on a
   mutated source and require the opposite outcome */
function control(ok, label, detail){ check(ok, "control: " + label, detail); }

const rctx = { window: {} };
vm.createContext(rctx);
vm.runInContext(renderSrc, rctx);
const escapeHtml = rctx.escapeHtml;
const hasKey = new Function(gradingSrc + "\nreturn hasKey;")();

/* the manifest and every shipped test, for the data-driven sections */
const win = {};
vm.createContext(win);
win.window = win;
vm.runInContext(readLf(path.join(repo, "testdata", "manifest.js")), win);
const MANIFEST = win.TEST_MANIFEST;
function loadTestFile(id){
  const c = { window: {} }; c.window = c; vm.createContext(c);
  vm.runInContext(readLf(path.join(repo, "testdata", id + ".js")), c);
  return (c.__TESTDATA__ || {})[id];
}

function memStorage(){
  const ls = { _d: {}, calls: [],
    setItem(k, v){ this.calls.push("set:" + k); this._d[k] = String(v); },
    getItem(k){ return k in this._d ? this._d[k] : null; },
    removeItem(k){ this.calls.push("remove:" + k); delete this._d[k]; },
    clear(){ this.calls.push("clear"); this._d = {}; },
    key(i){ return Object.keys(this._d)[i]; },
    get length(){ return Object.keys(this._d).length; } };
  return ls;
}

(async () => {
/* ================= §1 the loader ================= */
console.log("--- 1. loadTestReadOnly writes no storage on any path ---");
{
  const body = [
    extractConst(appSrc, "TESTCACHE_PREFIX"),
    extractFn(appSrc, "cacheKey"), extractFn(appSrc, "testById"), extractFn(appSrc, "testIdAliases"),
    extractFn(appSrc, "canonTestId"), extractFn(appSrc, "archivedVersions"),
    extractFn(appSrc, "resumableVersionsFor"), extractFn(appSrc, "readCachedTest"),
    extractFn(appSrc, "writeCachedTest"),
    "async " + extractFn(appSrc, "loadTest"),
    "async " + extractFn(appSrc, "loadTestReadOnly"),
    "return { loadTest, loadTestReadOnly };"].join("\n");
  const ENTRY = { testId: "tv1", testName: "Viewer One", testVersion: "v2", legacyIds: [] };
  const content = v => ({ testId: "tv1", testName: "Viewer One", testVersion: v, legacyIds: [], scoring: {},
    modules: [{ moduleId: "m", section: "Math", moduleLabel: "Module 1", questions: [{ id: "ma1-q1", type: "mcq", choices: ["a", "b"], correctAnswer: 0 }] }] });
  const mk = (opts) => {
    const ls = memStorage();
    const window = { __TESTDATA__: {}, TEST_ARCHIVE_INDEX: {} };
    if(opts.memory) window.__TESTDATA__.tv1 = content(opts.memory);
    if(opts.cache) ls._d["acestem:testcache:tv1:" + opts.cache] = JSON.stringify(content(opts.cache));
    if(opts.stale) ls._d["acestem:testcache:tv1:v1"] = JSON.stringify(content("v1"));
    let fetched = 0;
    const fetchTestFile = async (id) => {
      fetched++;
      if(opts.offline) throw new Error("network");
      window.__TESTDATA__[id] = content(opts.serve || "v2");
      return window.__TESTDATA__[id];
    };
    const state = { tests: [ENTRY], resumeRecords: {}, assignAttempts: {} };
    const api = new Function("window", "localStorage", "state", "fetchTestFile", body)(window, ls, state, fetchTestFile);
    return { api, ls, window, fetched: () => fetched };
  };

  let w = mk({ memory: "v2", stale: true });
  let t = await w.api.loadTestReadOnly(ENTRY);
  check(t && t.testVersion === "v2" && w.ls.calls.length === 0 && "acestem:testcache:tv1:v1" in w.ls._d,
    "memory hit: served from memory, ZERO storage calls, the older cache entry not evicted", w.ls.calls.join(","));
  const wc = mk({ memory: "v2", stale: true });
  await wc.api.loadTest(ENTRY);
  control(wc.ls.calls.some(c => c.indexOf("set:acestem:testcache:tv1:v2") === 0) && wc.ls.calls.some(c => c === "remove:acestem:testcache:tv1:v1"),
    "loadTest (the sitting's loader) on the same memory hit writes the cache and evicts — the probe sees writes", wc.ls.calls.join(","));

  w = mk({ cache: "v2" });
  t = await w.api.loadTestReadOnly(ENTRY);
  check(t && t.testVersion === "v2" && w.ls.calls.length === 0 && w.fetched() === 0,
    "cache hit: served from the offline cache by a READ, zero storage calls, no fetch", w.ls.calls.join(","));

  w = mk({ stale: true });
  t = await w.api.loadTestReadOnly(ENTRY);
  check(t && t.testVersion === "v2" && w.fetched() === 1 && w.ls.calls.length === 0 && "acestem:testcache:tv1:v1" in w.ls._d,
    "network: fetched, held in memory only — no cache write, nothing evicted", w.ls.calls.join(","));
  const wn = mk({ stale: true });
  await wn.api.loadTest(ENTRY);
  control(wn.ls.calls.some(c => c.indexOf("set:acestem:testcache:tv1:v2") === 0),
    "loadTest on the same network path writes the cache", wn.ls.calls.join(","));

  w = mk({ serve: "v9" });
  let err = null;
  try{ await w.api.loadTestReadOnly(ENTRY); }catch(e){ err = e; }
  check(err && err.permanent === true && w.ls.calls.length === 0,
    "a fetched file whose version the manifest does not vouch for is refused (permanent) and writes nothing");

  w = mk({ memory: "v1" });
  t = await w.api.loadTestReadOnly(ENTRY);
  check(t && t.testVersion === "v2" && w.fetched() === 1,
    "a superseded build in memory is never shown as the current form — the current build is fetched");

  w = mk({ offline: true });
  err = null;
  try{ await w.api.loadTestReadOnly(ENTRY); }catch(e){ err = e; }
  check(err && w.ls.calls.length === 0, "offline with nothing held: the load fails and writes nothing");
}

/* ================= §2 parseRef ================= */
console.log("--- 2. the question-id parser ---");
const refApi = new Function(extractFn(appSrc, "parseQuestionRef") + "\n" + extractFn(appSrc, "idSpellings") +
  "\n" + extractFn(appSrc, "locateQuestion") + "\nreturn { parseQuestionRef, idSpellings, locateQuestion };")();
const { parseQuestionRef, idSpellings, locateQuestion } = refApi;
{
  const ok = [
    ["rw1-q7", "re1-q7", "rw1-q7"], ["re1-q7", "re1-q7", "rw1-q7"], ["m2-q21", "ma2-q21", "m2-q21"],
    ["ma2-q21", "ma2-q21", "m2-q21"], ["m1-q08", "ma1-q8", "m1-q8"], ["m2-07", "ma2-q7", "m2-q7"],
    ["RW2-Q27", "re2-q27", "rw2-q27"], ["  ma1-q1  ", "ma1-q1", "m1-q1"], ["rw1-07", "re1-q7", "rw1-q7"],
    ["re2-q010", "re2-q10", "rw2-q10"]];
  const bad = ["", "q7", "rw3-q7", "rw0-q1", "rw1q7", "rw1-x7", "rw1-q", "math1-q1", "r1-q1", "ma1-q7a",
    "202606asiav1 ma2-q21", "ma2 q21", "<img src=x>", "rw1-q7;", "ma1--q1"];
  ok.forEach(([s, id, tsv]) => {
    const r = parseQuestionRef(s);
    check(r && r.id === id && r.tsv === tsv, "parseRef(" + JSON.stringify(s) + ") -> " + id + " / " + tsv, JSON.stringify(r));
  });
  check(bad.every(s => parseQuestionRef(s) === null), "every non-id is refused, never guessed: " + bad.map(s => JSON.stringify(s)).join(" "),
    bad.filter(s => parseQuestionRef(s) !== null).join(" | "));
  check(JSON.stringify(idSpellings("re2-q10")) === '["re2-q10","rw2-q10"]' && JSON.stringify(idSpellings("ma1-q3")) === '["ma1-q3","m1-q3"]'
    && idSpellings("odd")[1] === "—", "the strip prints both spellings, and an em dash for an id outside the convention");

  /* every shipped question id is reachable by both spellings, unpadded and padded */
  let total = 0, miss = [];
  MANIFEST.forEach(e => {
    const t = loadTestFile(e.testId);
    t.modules.forEach((m, mi) => m.questions.forEach((q, qi) => {
      total++;
      const sp = idSpellings(q.id);
      const n = /-q(\d+)$/.exec(q.id);
      const padded = n ? sp[1].replace(/-q\d+$/, "-q0" + n[1]) : sp[1];
      const qless = n ? sp[1].replace(/-q(\d+)$/, "-$1") : sp[1];
      [sp[0], sp[1], padded, qless].forEach(s => {
        const r = parseQuestionRef(s);
        const at = r && locateQuestion(t, r.id);
        if(!at || at.mi !== mi || at.qi !== qi) miss.push(e.testId + ":" + s);
      });
    }));
  });
  check(total > 3000 && miss.length === 0, "all " + total + " shipped questions resolve by both spellings, zero-padded and q-less, to their own position",
    miss.slice(0, 5).join(", "));
}

/* ================= §3 the bridge ================= */
console.log("--- 3. AppTestViewer.open: dashboard only, tutor only ---");
function bridgeSrc(src){
  const i = src.indexOf("window.AppTestViewer = {");
  if(i === -1) throw new Error("AppTestViewer bridge not found");
  let j = src.indexOf("{", i) + 1, depth = 1;
  while(depth > 0 && j < src.length){ if(src[j] === "{") depth++; else if(src[j] === "}") depth--; j++; }
  return src.slice(i, j) + ";";
}
function runBridge(src, opts){
  const calls = [];
  const els = { "screen-dashboard": { classList: { contains: c => c === "hidden" && !opts.dashVisible } } };
  const window = { __TESTDATA__: Object.assign({}, opts.memory || {}) };
  /* configured: the deployment has a server (the live site); remote: it is
     running in remote mode (not forced local by ?devstorage=1) */
  const configured = opts.configured !== undefined ? !!opts.configured : !!opts.remote;
  const AttemptStore = { isRemote: () => !!opts.remote, hasAuthToken: () => !!opts.token, remoteConfigured: () => configured };
  const entry = { testId: "tv1", testVersion: "v2" };
  const fetched = { testId: "tv1", testVersion: "v2", modules: [{ questions: [1, 2, 3] }, { questions: [1] }] };
  const loadTestReadOnly = async e => {
    calls.push(["load", e.testId]);
    if(window.__TESTDATA__.tv1 && window.__TESTDATA__.tv1.testVersion === "v2") return window.__TESTDATA__.tv1;
    window.__TESTDATA__.tv1 = fetched;               // what a script-tag fetch does
    return fetched;
  };
  const body = [extractFn(src, "viewerAuthorised"), extractFn(src, "viewerAllowed"), extractFn(src, "memoryBefore"), extractFn(src, "restoreMemory"), bridgeSrc(src)].join("\n");
  new Function("window", "el", "AttemptStore", "openTestViewer", "testById", "loadTestReadOnly", "parseQuestionRef",
    body)(window, id => els[id], AttemptStore, (...a) => { calls.push(a); return Promise.resolve(true); },
    id => id === "tv1" ? entry : null, loadTestReadOnly, () => null);
  return { open: (...a) => window.AppTestViewer.open(...a), counts: id => window.AppTestViewer.counts(id),
    get calls(){ return calls.filter(c => c[0] !== "load"); }, loads: () => calls.filter(c => c[0] === "load").length, window, fetched };
}
{
  const cases = [
    [{ dashVisible: false }, false, "the dashboard is not the screen showing (a student's home, a sitting, sign-in)"],
    [{ dashVisible: true, remote: true, token: false }, false, "remote mode with no tutor signed in"],
    [{ dashVisible: true, remote: true, token: true }, true, "remote mode, tutor signed in, on the dashboard"],
    [{ dashVisible: true, remote: false, configured: true }, false,
      "a deployment WITH a server forced into local mode (?devstorage=1 on the live site): the password-free acestem-admin dashboard is not a way in"],
    [{ dashVisible: true, remote: false }, true, "a build with no server (single-file / Stage-3 preview / file://): the local dashboard (acestem-admin) is the tutor's way in"]];
  for(const [opts, opens, what] of cases){
    const b = runBridge(appSrc, opts);
    const r = await b.open("202606asiav1", "");
    check(opens ? (b.calls.length === 1) : (b.calls.length === 0 && r === false),
      (opens ? "opens: " : "refuses: ") + what);
  }
  const mutant = appSrc.replace(/\n\s*if\(el\("screen-dashboard"\)\.classList\.contains\("hidden"\)\) return false;/, "");
  control(mutant !== appSrc, "the dashboard guard line is where this suite expects it");
  const mb = runBridge(mutant, { dashVisible: false });
  await mb.open("202606asiav1", "");
  control(mb.calls.length === 1, "without the dashboard guard the same off-dashboard call opens the viewer — the probe sees it");
  const openAuth = appSrc.replace("    return !AttemptStore.remoteConfigured() || AttemptStore.hasAuthToken();", "    return true;");
  control(openAuth !== appSrc, "the server-deployment auth line is where this suite expects it");
  const ma = runBridge(openAuth, { dashVisible: true, remote: false, configured: true });
  await ma.open("202606asiav1", "");
  control(ma.calls.length === 1, "without it, ?devstorage=1 + acestem-admin on the live site opens the viewer — the probe sees it");

  /* the Tests tab's counts: the same gate, and memory left as it was found */
  let b = runBridge(appSrc, { dashVisible: false });
  check((await b.counts("tv1")) === null && b.loads() === 0, "counts: off the dashboard it answers null and loads nothing (the tab's loop pauses)");
  b = runBridge(appSrc, { dashVisible: true, remote: true, token: false });
  check((await b.counts("tv1")) === null && b.loads() === 0, "counts: remote mode with no tutor signed in answers null");
  b = runBridge(appSrc, { dashVisible: true });
  const n = await b.counts("tv1");
  check(JSON.stringify(n) === "[3,1]" && !("tv1" in b.window.__TESTDATA__),
    "counts: per-module counts from the content, and a form fetched only to count is taken back OUT of memory (a later sitting on this page sees what it would have)");
  const held = { testId: "tv1", testVersion: "v2", modules: [{ questions: [1] }] };
  b = runBridge(appSrc, { dashVisible: true, memory: { tv1: held } });
  await b.counts("tv1");
  check(b.window.__TESTDATA__.tv1 === held, "counts: a form already in memory stays exactly where it was");
  const archived = { testId: "tv1", testVersion: "v1", modules: [] };
  b = runBridge(appSrc, { dashVisible: true, memory: { tv1: archived } });
  await b.counts("tv1");
  check(b.window.__TESTDATA__.tv1 === archived, "counts: an older build that was in memory is put back, not replaced by the one fetched to count");
  const noRestore = appSrc.replace("      return loadTestReadOnly(entry).then(t => {\n        restoreMemory(memo, t);", "      return loadTestReadOnly(entry).then(t => {");
  control(noRestore !== appSrc, "the counts restore line is where this suite expects it");
  b = runBridge(noRestore, { dashVisible: true });
  await b.counts("tv1");
  control("tv1" in b.window.__TESTDATA__, "without the restore the counted form stays in memory — the probe sees it");
}

/* ================= §4 open / exit ================= */
console.log("--- 4. openTestViewer / exitTestViewer, for real ---");
const OPEN_NAMES = ["openTestViewer", "exitTestViewer", "exitReviewMode", "buildModuleStateFromRecord", "memoryBefore", "restoreMemory"];
function viewerWorld(src, opts){
  opts = opts || {};
  const log = [];
  const viols = [];
  /* view "review" is what a finished sitting leaves behind (Check Your Work →
     submit); the viewer must not open onto it */
  const state = { sessionGen: 0, reviewMode: null, currentTest: "BEFORE", moduleState: "BEFORE",
    moduleIndex: 9, questionIndex: 9, view: "review", elimMode: true, timerInterval: 7, timerRunning: true,
    userName: "AS-UNTOUCHED", displayName: "Untouched" };
  const memory = opts.memory ? Object.assign({}, opts.memory) : {};
  const node = id => ({ id, textContent: "", value: "x", innerHTML: "",
    classList: { add(c){ log.push("hide?" + id + ":" + c); }, remove(c){ log.push("show?" + id + ":" + c); },
                 toggle(){}, contains(){ return false; } } });
  const nodes = {};
  const el = id => nodes[id] || (nodes[id] = node(id));
  const TEST = opts.test || { testId: "tv1", testName: "Viewer One", testVersion: "v2",
    modules: [{ moduleId: "m1", section: "Reading and Writing", moduleLabel: "Module 1", questions: [{ id: "re1-q1" }, { id: "re1-q3" }] },
              { moduleId: "m2", section: "Math", moduleLabel: "Module 1", questions: [{ id: "ma1-q1" }, { id: "ma1-q2" }] }] };
  const entry = { testId: "tv1", testName: "Viewer One", testVersion: "v2", legacyIds: ["old-tv1"] };
  let standInSeen = null;
  const Attempts = new Proxy({}, { get(_, k){
    if(k !== "detach"){ viols.push("Attempts." + String(k)); return () => {}; }
    return async () => {
      log.push("detach");
      if(state.reviewMode !== null || state.currentTest !== "BEFORE") viols.push("detach ran AFTER state changed");
      if(opts.endDuringDetach) state.sessionGen++;
    };
  }});
  const deps = {
    testById: id => (id === "tv1" || id === "old-tv1") ? entry : null,
    parseQuestionRef: s => refApi.parseQuestionRef(s),
    showOnly: id => log.push("showOnly:" + id),
    el, state,
    loadTestReadOnly: async e => {
      log.push("load:" + e.testId);
      if(opts.endDuringLoad) state.sessionGen++;
      if(opts.loadFails) throw Object.assign(new Error("network"), {});
      if(opts.fromMemory) return memory.tv1;
      memory.tv1 = TEST;                               // a script-tag fetch registers into memory
      return TEST;
    },
    LOADING_DEFAULT_MSG: "default",
    showTestLoadError: (e, retry, origin) => log.push("loadError:" + origin),
    locateQuestion: (t, id) => refApi.locateQuestion(t, id),
    Attempts,
    hide: id => log.push("hide:" + id), show: id => log.push("show:" + id),
    buildViewerModuleTabs: () => log.push("tabs"),
    renderTest: () => { log.push("render"); if(opts.renderThrows) throw new Error("boom"); },
    clearInterval: id => log.push("clearInterval:" + id),
    resetTestChrome: () => log.push("resetTestChrome"),
    Dashboard: { open: () => viols.push("Dashboard.open") },
    renderScoreDetails: () => log.push("renderScoreDetails"),
    refreshStudentState: () => viols.push("refreshStudentState"),
    renderHome: () => log.push("renderHome"),
    window: { Dashboard: { open: () => viols.push("Dashboard.open") }, scrollTo(){}, __TESTDATA__: memory },
    console
  };
  const names = Object.keys(deps);
  const body = OPEN_NAMES.map(n => (n === "openTestViewer" ? "async " : "") + extractFn(src, n)).join("\n") +
    "\nreturn { openTestViewer, exitTestViewer, exitReviewMode };";
  /* buildModuleStateFromRecord is real; wrap it to see what it is handed */
  const api = new Function(...names, body)(...names.map(n => deps[n]));
  return { api, state, log, viols, nodes, TEST, memory, standIn: () => standInSeen };
}
{
  let w = viewerWorld(appSrc);
  let opened = await w.api.openTestViewer("tv1", "", null);
  const rm = w.state.reviewMode;
  check(opened === true && rm && rm.viewer === true && w.state.currentTest === w.TEST,
    "opens: state.reviewMode.viewer is set and the test is the loaded content");
  check(rm && rm.record && /^viewer:/.test(rm.record.attemptId) && Object.isFrozen(rm.record)
    && JSON.stringify(rm.record.answers) === "{}",
    "the stand-in record is frozen, empty, and keyed viewer:<testId> — not an attempt: key, so it collides with no record", rm && rm.record && rm.record.attemptId);
  check(w.viols.length === 0, "the recorder is touched only to detach it, and detach runs BEFORE any state changes", w.viols.join("; "));
  check(w.log.indexOf("showOnly:screen-loading") < w.log.indexOf("load:tv1") && w.log.indexOf("load:tv1") < w.log.indexOf("detach")
    && w.log.indexOf("detach") < w.log.indexOf("render") && w.log[w.log.length - 1] === "showOnly:screen-test",
    "order: loading screen, load, detach, render, test screen", w.log.join(" > "));
  check(w.state.timerRunning === false && w.log.indexOf("clearInterval:7") !== -1 && w.log.indexOf("hide:fiveMinPopup") !== -1
    && w.log.indexOf("show:tvBar") !== -1 && w.nodes.timerDisplay.innerHTML.indexOf("Viewer") !== -1,
    "no timer: the interval is cleared, the five-minute alert hidden, the clock reads Viewer");
  check(w.state.userName === "AS-UNTOUCHED" && w.state.displayName === "Untouched",
    "the viewer never touches the signed-in identity (no student code stands behind it)");
  const ms = w.state.moduleState;
  check(ms && ms.m1 && ms.m2 && Object.keys(ms.m1.answers).length === 0 && ms.m1.flags.size === 0,
    "moduleState comes from buildModuleStateFromRecord on the empty stand-in: nothing answered, nothing flagged");
  check(w.state.view === "question" && w.state.elimMode === false,
    "a finished sitting's leftover view ('review', Check Your Work) is reset: the viewer opens on a question, never on a submit page");

  /* memory: a form the viewer fetched leaves with the viewer; one it found stays */
  check(w.memory.tv1 === w.TEST, "(the stubbed fetch registered the form in memory, as a script tag does)");
  w.api.exitReviewMode();
  check(!("tv1" in w.memory), "exit takes a form the viewer fetched back OUT of memory (a later sitting on this page sees what it would have)");
  const held = { testId: "tv1", testName: "Viewer One", testVersion: "v2", modules: [{ moduleId: "m1", section: "Math", moduleLabel: "Module 1", questions: [{ id: "ma1-q1" }] }] };
  w = viewerWorld(appSrc, { memory: { tv1: held }, fromMemory: true });
  await w.api.openTestViewer("tv1", "", null);
  w.api.exitReviewMode();
  check(w.memory.tv1 === held, "a form that was already in memory is left exactly where it was");
  const keepAll = appSrc.replace("    if(rm && rm.memo) restoreMemory(rm.memo, state.currentTest);\n", "");
  control(keepAll !== appSrc, "the exit's restore line is where this suite expects it");
  w = viewerWorld(keepAll);
  await w.api.openTestViewer("tv1", "", null);
  w.api.exitReviewMode();
  control("tv1" in w.memory, "without the restore the fetched form stays in memory — the probe sees it");

  w = viewerWorld(appSrc);
  await w.api.openTestViewer("tv1", "m1-02", null);
  check(w.state.moduleIndex === 1 && w.state.questionIndex === 1, "opens at the asked question (m1-02 -> ma1-q2)");
  w = viewerWorld(appSrc);
  await w.api.openTestViewer("old-tv1", "rw1-q3", null);
  check(w.state.moduleIndex === 0 && w.state.questionIndex === 1, "a legacy test id resolves; rw1-q3 lands on re1-q3 (id, not position)");

  w = viewerWorld(appSrc);
  let missed = null;
  opened = await w.api.openTestViewer("tv1", "rw1-q2", info => { missed = info; });
  check(opened === false && missed && missed.id === "re1-q2" && missed.tsv === "rw1-q2" && w.state.reviewMode === null
    && w.log.indexOf("detach") === -1 && w.log[w.log.length - 1] === "showOnly:screen-dashboard",
    "a question the form doesn't have: back to the dashboard, which is told — no guess, no detach, no state", w.log.join(" > "));

  w = viewerWorld(appSrc);
  opened = await w.api.openTestViewer("tv1", "rw9-q1", null);
  check(opened === false && w.log.length === 0, "an unreadable question id never even shows the loading screen");
  w = viewerWorld(appSrc);
  opened = await w.api.openTestViewer("nope", "", null);
  check(opened === false && w.log.length === 0, "an unknown test id opens nothing");

  w = viewerWorld(appSrc, { loadFails: true });
  await w.api.openTestViewer("tv1", "", null);
  check(w.log.indexOf("loadError:viewer") !== -1 && w.state.reviewMode === null && w.viols.length === 0,
    "a failed load shows the viewer's error screen (back to the dashboard) and changes nothing");

  w = viewerWorld(appSrc, { endDuringLoad: true });
  await w.api.openTestViewer("tv1", "", null);
  check(w.state.reviewMode === null && w.state.currentTest === "BEFORE" && w.log.indexOf("detach") === -1 && w.log.indexOf("render") === -1,
    "session fence: a session that ends during the load gets nothing painted and nothing changed", w.log.join(" > "));
  w = viewerWorld(appSrc, { endDuringDetach: true });
  await w.api.openTestViewer("tv1", "", null);
  check(w.state.reviewMode === null && w.log.indexOf("render") === -1, "session fence: ... and one that ends during the detach");
  const FENCE = "    if(gen !== state.sessionGen){ restoreMemory(memo, test); return; }\n";
  const POST_LOAD = FENCE + "    const at = target";
  const unfenced = appSrc.split(POST_LOAD).length === 2
    ? appSrc.replace(POST_LOAD, "    const at = target") : appSrc;
  control(unfenced !== appSrc, "the post-load fence is where this suite expects it");
  w = viewerWorld(unfenced, { endDuringLoad: true });
  await w.api.openTestViewer("tv1", "", null);
  /* the post-detach fence still stops the paint, so what the load fence
     alone protects is the recorder: without it an ended session gets a
     detach (which can drain a save) it has no business triggering */
  control(w.log.indexOf("detach") !== -1, "without the post-load fence the ended session reaches the recorder's detach — the probe sees it");
  const POST_DETACH = "    await Attempts.detach();\n" + FENCE + "    const standIn";
  const unfencedBoth = unfenced.split(POST_DETACH).length === 2
    ? unfenced.replace(POST_DETACH, "    await Attempts.detach();\n    const standIn") : unfenced;
  control(unfencedBoth !== unfenced, "the post-detach fence is where this suite expects it");
  w = viewerWorld(unfencedBoth, { endDuringLoad: true });
  await w.api.openTestViewer("tv1", "", null);
  control(w.state.reviewMode !== null, "without both fences the ended session DOES get the viewer painted — the probe sees it");

  const late = appSrc.replace(POST_DETACH, "    const standIn").replace("    state.moduleState = buildModuleStateFromRecord(test, standIn);\n",
    "    state.moduleState = buildModuleStateFromRecord(test, standIn);\n    await Attempts.detach();\n");
  control(late !== appSrc, "the detach line is where this suite expects it");
  w = viewerWorld(late);
  await w.api.openTestViewer("tv1", "", null);
  control(w.viols.some(v => /AFTER/.test(v)), "a detach moved after the state change is caught — the probe sees the order");

  w = viewerWorld(appSrc, { renderThrows: true });
  opened = await w.api.openTestViewer("tv1", "", null);
  check(opened === false && w.state.reviewMode === null && w.log.indexOf("resetTestChrome") !== -1
    && w.log[w.log.length - 1] === "showOnly:screen-dashboard",
    "a render that throws leaves the viewer whole: chrome reset, state cleared, back on the dashboard");

  /* exit: rvBackBtn and print both go through exitReviewMode */
  w = viewerWorld(appSrc);
  await w.api.openTestViewer("tv1", "", null);
  w.log.length = 0;
  w.api.exitReviewMode();
  check(w.state.reviewMode === null && w.state.currentTest === null && w.log.join(" > ") === "resetTestChrome > showOnly:screen-dashboard"
    && w.viols.length === 0,
    "exit: chrome reset, state cleared, the dashboard SCREEN shown — no Dashboard.open (whose reload pulls and writes the mirror in remote mode), no Score Details", w.log.join(" > ") + " " + w.viols.join(";"));
  w = viewerWorld(appSrc);
  w.state.reviewMode = { record: {}, rowByQid: {}, sdScroll: 0 };      // an ordinary form review
  w.api.exitReviewMode();
  control(w.log.indexOf("renderScoreDetails") !== -1, "an ordinary review still exits to Score Details (the branch is the viewer's alone)");
  check(/window\.addEventListener\("beforeprint", \(\)=>\{ if\(state\.reviewMode && state\.reviewMode\.viewer !== true\) exitReviewMode\(\); \}\);/.test(appSrc),
    "Ctrl+P in the viewer does not leave it through Score Details (beforeprint skips the viewer)");
}

/* ================= §5 the SPR key block ================= */
console.log("--- 5. SPR: review output unchanged, viewer states ---");
{
  /* sprReviewHtml as it stood before the sprKeyHtml split (692eb0e), pinned
     verbatim: the split must not change one byte of what review prints */
  const BEFORE = `function sprReviewHtml(q){
    const row = state.reviewMode.rowByQid[q.id];
    let cls, verdict;
    if(!row || row.noKey){ cls = "neutral"; verdict = "No key yet for this question."; }
    else if(row.given === null){ cls = "bad"; verdict = "You omitted this question."; }
    else if(row.correct){ cls = "ok"; verdict = "Your answer is correct."; }
    else { cls = "bad"; verdict = "Your answer is incorrect."; }
    let key = "";
    if(row && !row.noKey){
      key = \`<div class="rv-spr-key"><b>Correct answer:</b> \${escapeHtml(String(q.correctAnswer))}\` +
        ((q.altAnswers && q.altAnswers.length)
          ? \` <span class="rv-spr-alt">(also accepted: \${q.altAnswers.map(a=>escapeHtml(String(a))).join(", ")})</span>\` : "") +
        \`</div>\`;
    }
    return \`<div class="rv-banner \${cls}">\${verdict}</div>\${key}\`;
  }`;
  const mkOld = new Function("state", "escapeHtml", BEFORE + "\nreturn sprReviewHtml;");
  const mkNew = new Function("state", "escapeHtml", "hasKey", "viewerShowAnswersRef",
    "let viewerShowAnswers = viewerShowAnswersRef;\n" + extractFn(appSrc, "sprReviewHtml") + "\n" + extractFn(appSrc, "sprKeyHtml") +
    "\nreturn { sprReviewHtml, setShow(v){ viewerShowAnswers = v; } };");
  let n = 0, diffs = [];
  const rowsFor = q => [undefined, { noKey: true }, { noKey: false, given: null }, { noKey: false, given: "1", correct: true },
    { noKey: false, given: "2", correct: false }];
  MANIFEST.forEach(e => {
    const t = loadTestFile(e.testId);
    t.modules.forEach(m => m.questions.filter(q => q.type === "spr").forEach(q => {
      rowsFor(q).forEach(row => {
        const state = { reviewMode: { rowByQid: row ? { [q.id]: row } : {} } };
        const a = mkOld(state, escapeHtml)(q), b = mkNew(state, escapeHtml, hasKey, true).sprReviewHtml(q);
        n++;
        if(a !== b) diffs.push(e.testId + ":" + q.id);
      });
    }));
  });
  /* plus hostile keys and alternates, which must stay escaped identically */
  const hostile = { id: "ma1-q1", type: "spr", correctAnswer: '<img src=x onerror="1">', altAnswers: ["<b>PWN</b>", '"\'&'] };
  [{ noKey: false, given: null }].forEach(row => {
    const state = { reviewMode: { rowByQid: { [hostile.id]: row } } };
    n++;
    if(mkOld(state, escapeHtml)(hostile) !== mkNew(state, escapeHtml, hasKey, true).sprReviewHtml(hostile)) diffs.push("hostile");
  });
  check(n > 1500 && diffs.length === 0, "review's SPR verdict + key block is byte-identical to the pre-split build over " + n + " question×outcome cases (every shipped SPR, hostile keys)", diffs.slice(0, 5).join(", "));

  const q = { id: "ma1-q2", type: "spr", correctAnswer: "3/4", altAnswers: [".75", "0.75"] };
  const vstate = { reviewMode: { viewer: true, rowByQid: {} } };
  const v = mkNew(vstate, escapeHtml, hasKey, true);
  const on = v.sprReviewHtml(q);
  check(on === mkOld({ reviewMode: { rowByQid: { [q.id]: { noKey: false, given: "3/4", correct: true } } } }, escapeHtml)(q).replace(/^<div class="rv-banner ok">Your answer is correct\.<\/div>/, ""),
    "viewer, answers ON: exactly review's key block (key + also accepted), no verdict banner", on);
  v.setShow(false);
  check(v.sprReviewHtml(q) === "", "viewer, answers OFF: nothing — the SPR as a student meets it");
  v.setShow(true);
  check(/rv-banner neutral">No key yet/.test(v.sprReviewHtml({ id: "ma1-q3", type: "spr", correctAnswer: null })),
    "viewer, answers ON, no key: the neutral no-key banner, so ON never silently looks like OFF");
}

/* ================= §6 the Tests tab ================= */
console.log("--- 6. the Tests tab, for real ---");
const TAB_FNS = ["sortedForms", "testsCell", "testsOpenable", "viewTests", "ensureTestsCounts", "formsMatching", "openFormViewer", "testsGo"];
function tabDecls(src){
  const lines = src.split("\n").filter(l => /^\s*(let|const) (testsGoto|testsMsg|testsPicks|testsQpm|testsCountsStarted)\b/.test(l));
  if(lines.length !== 5) throw new Error("Tests tab module vars: expected 5 declarations, found " + lines.length);
  return lines.join("\n");
}
function tabWorld(src, manifest, opts){
  opts = opts || {};
  const calls = [];
  const dom = { tvTestsGoto: { value: opts.typed || "" } };
  const window = {
    TEST_MANIFEST: manifest,
    AppTestViewer: {
      open: (id, ref, onMiss) => { calls.push(["open", id, ref]); if(opts.miss) onMiss(opts.miss); return Promise.resolve(true); },
      authorised: () => !opts.unauthorised,
      counts: async id => { calls.push(["load", id]); if(opts.loadFails) throw new Error("x");
        if(opts.refuse) return null;
        return [2, 1]; },
      parseRef: s => refApi.parseQuestionRef(s)
    }
  };
  const cells = [];
  const document = { querySelectorAll: sel => sel === "#dashBody [data-tv-qpm]" ? cells : [] };
  const esc = s => escapeHtml(s);
  const escAttr = s => escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  let renders = 0;
  const forbidden = name => () => { calls.push(["FORBIDDEN", name]); };
  const body = tabDecls(src) + "\n" + TAB_FNS.map(n => extractFn(src, n)).join("\n") +
    "\nreturn { viewTests, testsGo, ensureTestsCounts, formsMatching, get msg(){ return testsMsg; }, get picks(){ return testsPicks; }, get qpm(){ return testsQpm; } };";
  const api = new Function("window", "document", "esc", "escAttr", "$", "render", "renderKeepingInputs", "tab",
    "ensureTestLoaded", "qIndex", "AppTestLoader", body)(
    window, document, esc, escAttr, id => dom[id], () => { renders++; }, () => { renders++; }, "tests",
    forbidden("ensureTestLoaded"), forbidden("qIndex"), { load: forbidden("AppTestLoader.load") });
  return { api, calls, dom, cells, renders: () => renders };
}
{
  const PAY = '<img src=x onerror="window.__XSS=1">';
  const ATTR = '" onmouseover="window.__XSS=1" x="';
  const manifest = [
    { testId: "202606asiav2", testName: "2026 June Asia v2", testVersion: "2026-08-19-a", legacyIds: [] },
    { testId: "202606asiav1", testName: PAY, testVersion: ATTR, pathway: PAY, legacyIds: ["2026-june-asia-v1"] },
    { testId: "202311intv1", testName: "", testVersion: null, legacyIds: [] },      // missing fields
    { testName: "No id at all" }];
  let w = tabWorld(dashSrc, manifest);
  const html = w.api.viewTests();
  const rowIds = [...html.matchAll(/<tr><td>[\s\S]*?<td class="tv-mono">([^<]*)<\/td>/g)].map(m => m[1]);
  check(JSON.stringify(rowIds) === JSON.stringify(["202311intv1", "202606asiav1", "202606asiav2", "&mdash;"]),
    "every manifest form is listed, in testId order (an entry with no id last)", rowIds.join(","));
  check(!/undefined|null/.test(html.replace(/placeholder="[^"]*"/, "")) && (html.match(/&mdash;/g) || []).length >= 5,
    "a missing field shows an em dash — never blank, undefined or null");
  check(html.indexOf("<img") === -1 && html.indexOf(' onmouseover="') === -1 && html.indexOf("&lt;img src=x onerror=&quot;window.__XSS=1&quot;&gt;") !== -1,
    "a poisoned manifest name, version and pathway render as text, never markup (escaped into cells AND the data attribute)");
  check(!/<button class="tv-open" data-tv-test="">/.test(html) && /No id at all/.test(html),
    "an entry with no testId is listed but offers no open button");
  /* the testId itself is manifest data too: it lands in three attributes
     (data-tv-test, data-tv-qpm, a pick's data-tv-test) and a cell */
  const hostileId = 'zz"><img src=x onerror="window.__XSS=1">';
  const hm = [{ testId: hostileId, testName: "x", testVersion: "v", legacyIds: [] }, { testId: hostileId + "2", testName: "y", testVersion: "v", legacyIds: [] }];
  const hw = tabWorld(dashSrc, hm, { typed: "zz ma1-q1" });
  hw.api.testsGo();
  const hHtml = hw.api.viewTests();
  check(hw.api.picks.length === 2 && hHtml.indexOf("<img") === -1 && hHtml.indexOf("<img src=x onerror=") === -1
    && (hHtml.match(/data-tv-test="zz&quot;&gt;&lt;img/g) || []).length === 4 && /data-tv-qpm="zz&quot;&gt;&lt;img/.test(hHtml),
    "a hostile testId is escaped into every attribute it reaches (row button, count cell, ambiguous picks) and its cell");
  const rawAttr = dashSrc.replace('<td class="tv-mono" data-tv-qpm="${escAttr(id)}">', '<td class="tv-mono" data-tv-qpm="${id}">');
  control(rawAttr !== dashSrc, "the count cell's attribute line is where this suite expects it");
  const rw = tabWorld(rawAttr, hm);
  control(rw.api.viewTests().indexOf("<img src=x onerror=") !== -1, "with that attribute unescaped the hostile id breaks out — the probe sees it");
  check(w.calls.filter(c => c[0] === "load").length >= 1 && !w.calls.some(c => c[0] === "FORBIDDEN"),
    "the per-module counts load through AppTestViewer.counts — never ensureTestLoaded / qIndex / AppTestLoader.load (they write the cache)",
    JSON.stringify(w.calls));

  /* off the dashboard the loop pauses, and the tab's next render restarts it */
  w = tabWorld(dashSrc, manifest.slice(0, 2), { refuse: true });
  w.api.ensureTestsCounts();
  await new Promise(r => setTimeout(r, 20));
  const firstRun = w.calls.filter(c => c[0] === "load").length;
  w.api.viewTests();
  await new Promise(r => setTimeout(r, 20));
  check(firstRun === 1 && !w.api.qpm["202606asiav1"] && w.calls.filter(c => c[0] === "load").length === 2,
    "refused (the viewer is open, or the tutor left): the loop stops after one ask, records nothing, and starts again on the tab's next render");

  /* a server deployment under ?devstorage=1 (not authorised): listed, never opened */
  const un = tabWorld(dashSrc, manifest, { unauthorised: true });
  const unHtml = un.api.viewTests();
  await new Promise(r => setTimeout(r, 20));
  check(unHtml.indexOf('class="tv-open"') === -1 && /tests open only for a tutor signed in/.test(unHtml) && !un.calls.some(c => c[0] === "load"),
    "not authorised (a server deployment's local acestem-admin dashboard): the forms are listed, none is openable, nothing is loaded to count");
  const ung = tabWorld(dashSrc, MANIFEST, { unauthorised: true, typed: "202606asiav1 ma2-q21" });
  ung.api.testsGo();
  check(!ung.calls.some(c => c[0] === "open") && /^Not opened/.test(ung.api.msg), "...and its Go-to box opens nothing", ung.api.msg);

  /* counts land in place, matched by VALUE, and failures read as an em dash */
  w = tabWorld(dashSrc, manifest.slice(0, 2));
  w.cells.push({ dataset: { tvQpm: "202606asiav1" }, textContent: "…" }, { dataset: { tvQpm: "zzz" }, textContent: "…" });
  w.api.ensureTestsCounts();
  await new Promise(r => setTimeout(r, 20));
  check(w.cells[0].textContent === "2 · 1" && w.cells[1].textContent === "…" && w.api.qpm["202606asiav2"] === "2 · 1",
    "per-module counts come from the content and land in their own cell only");
  w = tabWorld(dashSrc, manifest.slice(0, 2), { loadFails: true });
  w.api.ensureTestsCounts();
  await new Promise(r => setTimeout(r, 20));
  check(w.api.qpm["202606asiav1"] === "—", "a form whose content didn't load reads as an em dash, not a stuck ellipsis");

  const real = MANIFEST;
  const go = async (typed, opts) => {
    const t = tabWorld(dashSrc, real, Object.assign({ typed }, opts || {}));
    t.api.testsGo();
    return t;
  };
  let t = await go("202606asiav1 ma2-q21");
  check(JSON.stringify(t.calls.filter(c => c[0] === "open")) === '[["open","202606asiav1","ma2-q21"]]', "one exact form + a question: opens it at that question");
  t = await go("202606ASIAV1 m2-21");
  check(JSON.stringify(t.calls.filter(c => c[0] === "open")) === '[["open","202606asiav1","m2-21"]]', "case-insensitive, test-bank spelling passed through for the viewer to resolve");
  t = await go("2026-june-asia-v1 rw1-q7");
  check(t.calls.some(c => c[0] === "open" && c[1] === "202606asiav1"), "a legacy test id is an exact match");
  t = await go("202606 ma2-q21");
  check(!t.calls.some(c => c[0] === "open") && t.api.picks.length === 2 && t.api.picks.every(p => p.ref === "ma2-q21")
    && /matches 2 tests/.test(t.api.msg), "an ambiguous start (202606) lists the forms it matches — and opens none", t.api.msg);
  t = await go("2026 ma2-q21");
  check(!t.calls.some(c => c[0] === "open") && t.api.picks.length > 2, "a broad start lists every match");
  t = await go("202612 ma2-q21");
  check(!t.calls.some(c => c[0] === "open") && /^Not found/.test(t.api.msg) && t.api.picks.length === 0, "an unknown test: not found, nothing opened", t.api.msg);
  t = await go("202606asiav1 rw9-q1");
  check(!t.calls.some(c => c[0] === "open") && /isn't a question id/.test(t.api.msg), "an unreadable question: says so, opens nothing");
  t = await go("ma2-q21");
  check(!t.calls.some(c => c[0] === "open") && /put the test first/.test(t.api.msg), "a question with no test: asks for the test, never guesses one");
  t = await go("202606asiav1");
  check(JSON.stringify(t.calls.filter(c => c[0] === "open")) === '[["open","202606asiav1",""]]', "a test alone opens it at its first question");
  t = await go("202606asiav1 ma2-q99", { miss: { kind: "notfound", id: "ma2-q99", tsv: "m2-q99", testId: "202606asiav1", testName: "2026 June Asia v1" } });
  check(/^Not found: ma2-q99 \(m2-q99\) isn't in 2026 June Asia v1/.test(t.api.msg), "a form without that question: the viewer reports back and the tab says not found", t.api.msg);

  /* the echo: whatever is typed renders as text */
  t = await go(PAY + " ma2-q1");
  let out = t.api.viewTests();
  check(out.indexOf("<img src=x") === -1 && out.indexOf("&lt;img") !== -1, "a payload typed as the test is echoed escaped");
  t = await go("202606asiav1 " + ATTR.replace(/ /g, ""));
  out = t.api.viewTests();
  check(out.indexOf('" onmouseover=') === -1 && out.indexOf("onmouseover=&quot;") !== -1, "a payload typed as the question is echoed escaped");
  const stillTyped = tabWorld(dashSrc, real, { typed: ATTR });
  stillTyped.api.testsGo();
  out = stillTyped.api.viewTests();
  check(/value="&quot; onmouseover=&quot;/.test(out), "the box's own value is re-rendered escaped into its attribute");

  /* control: the same echo through a non-escaping render is caught */
  const unescaped = dashSrc.replace("${testsMsg ? `<p class=\"tv-tests-msg\">${esc(testsMsg)}</p>` : \"\"}",
    "${testsMsg ? `<p class=\"tv-tests-msg\">${testsMsg}</p>` : \"\"}");
  control(unescaped !== dashSrc, "the message line is where this suite expects it");
  const ue = tabWorld(unescaped, real, { typed: PAY + " ma2-q1" });
  ue.api.testsGo();
  control(ue.api.viewTests().indexOf("<img src=x") !== -1, "with the message unescaped the payload reaches the markup — the probe sees it");
}

/* ================= §7 source sweeps ================= */
console.log("--- 7. source sweeps ---");
{
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
  const VIEWER_FNS = ["loadTestReadOnly", "parseQuestionRef", "idSpellings", "locateQuestion", "openTestViewer", "exitTestViewer",
    "buildViewerModuleTabs", "viewerJump", "renderViewerChrome", "viewerGoTo", "viewerAllowed", "viewerAuthorised", "memoryBefore", "restoreMemory"];
  const WRITE_API = /\bAttemptStore\.(?!remoteConfigured\(\)|hasAuthToken\(\))|\bAttempts\.(?!detach\(\))|\blocalStorage\.(setItem|removeItem|clear)|\bwindow\.storage\b|writeCachedTest|\bloadTest\(|withTestContent|rememberSession|forgetSession|Dashboard\.open|refreshStudentState|reportBug|beginModule|startTimer|state\.userName\s*=|state\.displayName\s*=|\bfetch\(|sendBeacon|XMLHttpRequest/;
  const hits = [];
  VIEWER_FNS.forEach(n => {
    const body = strip(extractFn(appSrc, n));
    body.split("\n").forEach(l => { if(WRITE_API.test(l)) hits.push(n + ": " + l.trim()); });
  });
  check(hits.length === 0, "no viewer function reaches a write API, the recorder (beyond detach), the caching loader, the session or the identity", hits.join(" | "));
  const bridge = strip(bridgeSrc(appSrc) + "\n" + extractFn(appSrc, "viewerAllowed") + "\n" + extractFn(appSrc, "viewerAuthorised"));
  const bridgeHits = bridge.split("\n").filter(l => WRITE_API.test(l));
  check(bridgeHits.length === 0 && /return !AttemptStore\.remoteConfigured\(\) \|\| AttemptStore\.hasAuthToken\(\);/.test(bridge),
    "the bridge only READS whether the deployment has a server and whether a tutor token is held", bridgeHits.join(" | "));
  const tabHits = [];
  TAB_FNS.concat(["attachTestsHandlers"]).forEach(n => {
    strip(extractFn(dashSrc, n)).split("\n").forEach(l => {
      if(/AttemptStore|tutorPut|tutorDelete|tutorTombstone|ensureTestLoaded|qIndex\(|AppTestLoader|localStorage|loadFromStorage|Dashboard\.open/.test(l)) tabHits.push(n + ": " + l.trim());
    });
  });
  check(tabHits.length === 0, "no Tests-tab function writes, pulls, or loads through the caching loader", tabHits.join(" | "));

  /* one entry point: the Tests tab is the only caller of the bridge */
  const callers = [];
  [["app.js", appSrc], ["dashboard.js", dashSrc]].forEach(([f, s]) => strip(s).split("\n").forEach((l, i) => {
    if(/AppTestViewer\.open\(/.test(l)) callers.push(f + ":" + (i + 1));
  }));
  check(callers.length === 1 && /^dashboard\.js/.test(callers[0]) && /window\.AppTestViewer\.open\(testId, ref \|\| "", note =>/.test(strip(extractFn(dashSrc, "openFormViewer"))),
    "AppTestViewer.open has exactly one caller, the Tests tab's openFormViewer", callers.join(", "));
  check(!/openTestViewer\(/.test(strip(appSrc).split("\n").filter(l => !/function openTestViewer|openTestViewer\(testId, ref, onNote\)/.test(l)).join("\n")),
    "nothing else in app.js opens the viewer (only the bridge and the error-screen retry, both by the same call)");

  /* no route: the URL inputs are exactly the ones that predate the viewer */
  const urlReads = [];
  [["app.js", appSrc], ["dashboard.js", dashSrc], ["attempts.js", readLf(path.join(repo, "attempts.js"))]].forEach(([f, s]) =>
    strip(s).split("\n").forEach(l => { if(/\blocation\b|URLSearchParams|hashchange|popstate|pushState/.test(l)) urlReads.push(f + ": " + l.trim()); }));
  const KNOWN = [
    /^app\.js: window\.location\.href = "mailto:/,
    /^app\.js: const raw = location\.hash \|\| "";$/,
    /^app\.js: try\{ history\.replaceState\(null, "", location\.pathname \+ location\.search\); \}$/,
    /^app\.js: catch\(e\)\{ try\{ location\.hash = ""; \}catch\(e2\)\{\} \}$/,
    /^dashboard\.js: const base = location\.origin \+ location\.pathname\.replace/,
    /^dashboard\.js: const proto = \(window\.location && typeof window\.location\.protocol === "string"\)/,
    /^attempts\.js: const forcedLocal = \/\[\?&\]devstorage=1\/\.test\(location\.search\);$/];
  const unknown = urlReads.filter(l => !KNOWN.some(re => re.test(l)));
  check(unknown.length === 0 && urlReads.length === KNOWN.length,
    "no URL parameter, hash, history or popstate input exists beyond the seven that predate the viewer (none of them routes to it)", unknown.join(" | "));
  const routeMutant = appSrc.replace("  (function boot(){", "  if(/[#&]viewer=/.test(location.hash)) setTimeout(()=> openTestViewer(\"202606asiav1\", \"\"), 0);\n  (function boot(){");
  control(routeMutant !== appSrc, "the boot anchor is where this suite expects it");
  const mReads = strip(routeMutant).split("\n").filter(l => /\blocation\b/.test(l) && !KNOWN.some(re => re.test("app.js: " + l.trim())));
  control(mReads.length === 1, "a planted hash route into the viewer is caught by the sweep");

  /* the test-bank's Stage-3 preview patches app.js at this anchor, first occurrence */
  const anchor = (appSrc.match(/state\.assignments = assigns;/g) || []).length;
  check(anchor === 1, "the Stage-3 preview anchor `state.assignments = assigns;` still appears exactly once in app.js (build_stage3_preview.py)", "count " + anchor);

  /* every branch the viewer added to a shared function is keyed on the viewer flag */
  const shared = ["buildQuestionHtml", "sprReviewHtml", "buildQnavGrid", "openQnav", "updateHeaderTools", "renderQuestionView", "exitReviewMode"];
  const unkeyed = [];
  shared.forEach(n => {
    const b = extractFn(appSrc, n);
    if(!/reviewMode\.viewer|const viewer = review && state\.reviewMode\.viewer === true/.test(b)) unkeyed.push(n);
  });
  check(unkeyed.length === 0, "each shared function's viewer branch is keyed on state.reviewMode.viewer", unkeyed.join(","));
  check(/hide\("tvBar"\)/.test(extractFn(appSrc, "resetTestChrome")),
    "resetTestChrome hides the viewer's bar, so a deletion verdict that tears the screen down can't leak it into a sitting");
  const rqv = extractFn(appSrc, "renderQuestionView");
  check(rqv.indexOf('el("tvBar").classList.toggle("hidden", !viewer);') !== -1 && rqv.indexOf('el("rvBackBtn").classList.toggle("hidden", !review);') !== -1,
    "the bar and the back control follow the viewer / review state on EVERY render, so no other way into a sitting can inherit them");
  const indexSrc = readLf(path.join(repo, "index.html"));
  check(/<div class="tv-bar hidden" id="tvBar">/.test(indexSrc) && !/<form/i.test(indexSrc.slice(indexSrc.indexOf('id="tvBar"'), indexSrc.indexOf('id="tvBar"') + 1500)),
    "the bar ships hidden, and its Go-to is no <form> (a submit would navigate)");
  const bugIdx = appSrc.indexOf('el("bugSend").addEventListener("click", async ()=>{');
  check(bugIdx !== -1 && appSrc.slice(bugIdx, bugIdx + 320).indexOf("if(state.reviewMode && state.reviewMode.viewer === true) return;") !== -1,
    "Report a bug has a second layer: its send handler refuses in the viewer even if the hidden menu item were shown");
  ["viewerGoTo", "viewerJump"].forEach(n => check(/^\s*function \w+\([^)]*\)\{\n\s*if\(!\(state\.reviewMode && state\.reviewMode\.viewer === true\)\) return;/.test(extractFn(appSrc, n)),
    n + " refuses unless the viewer is open (second layer behind the hidden bar)"));
  check(/el\("tvShowAnswers"\)\.addEventListener\("change", \(\)=>\{\n\s*if\(!\(state\.reviewMode && state\.reviewMode\.viewer === true\)\) return;/.test(appSrc),
    "the Show answers toggle refuses unless the viewer is open");

  /* the tutor takes the device: a remembered student session is forgotten,
     and a sitting running behind the sign-in form is stopped */
  const tutorBody = extractConst(appSrc, "SESSION_KEY") + "\n" + extractFn(appSrc, "forgetSession") + "\n" +
    "async " + extractFn(appSrc, "enterTutorSession") + "\nreturn enterTutorSession;";
  const runEntry = async (src, stored, live) => {
    const ls = memStorage();
    if(stored) ls._d["acestem:code"] = stored;
    const calls = [];
    const state = { sessionGen: 4, userName: "AS-STALE234", displayName: "Stale",
      currentTest: live ? { testId: "t" } : null, moduleState: live ? { m: {} } : {}, reviewMode: null,
      timerInterval: live ? 11 : null, breakInterval: null, timerRunning: !!live, readyTimer: live ? 12 : null, moduleOverTimer: null,
      assignments: [{}], pastAttempts: [{}], tombstoned: { x: 1 }, resumeRecords: { y: 1 } };
    const Attempts = { detach: async () => { calls.push("detach:" + (state.currentTest ? "test-still-set" : "test-gone")); } };
    await new Function("localStorage", "state", "clearInterval", "clearTimeout", "resetTestChrome", "Attempts", src)(
      ls, state, id => calls.push("clearInterval:" + id), id => calls.push("clearTimeout:" + id), () => calls.push("resetTestChrome"), Attempts)();
    return { ls, state, calls };
  };
  let r = await runEntry(tutorBody, "AS-VWPRF234");
  check(!("acestem:code" in r.ls._d) && r.state.sessionGen === 5 && r.state.userName === "Student" && r.state.displayName === null,
    "tutor entry forgets a remembered student session, retires the session generation and drops the student identity — so a reload from the dashboard or the viewer can't resume that student's sitting");
  r = await runEntry(tutorBody, null);
  check(r.ls.calls.length === 0, "tutor entry with nothing remembered makes no storage call at all");
  const keeps = tutorBody.replace("    try{ if(localStorage.getItem(SESSION_KEY) !== null) forgetSession(); }catch(e){}\n", "");
  control(keeps !== tutorBody, "the forget line is where this suite expects it");
  r = await runEntry(keeps, "AS-VWPRF234");
  control("acestem:code" in r.ls._d, "without it the remembered code survives the tutor's sign-in — the probe sees it");
  r = await runEntry(tutorBody, null, true);
  check(r.calls.indexOf("clearInterval:11") !== -1 && r.calls.indexOf("clearTimeout:12") !== -1 && r.state.timerRunning === false
    && r.calls.indexOf("resetTestChrome") !== -1 && r.calls.indexOf("detach:test-still-set") !== -1 && r.state.currentTest === null
    && r.state.assignments === null && Object.keys(r.state.resumeRecords).length === 0,
    "a sitting running behind the sign-in form (a boot crash-resume that landed behind the tutor dialog) is stopped: clocks off, chrome reset, recorder let go after its last save, student state dropped", r.calls.join(" > "));
  const noStop = tutorBody.replace("    try{ await Attempts.detach(); }catch(e){}    // while currentTest is still set, as endDeletedSession does\n", "")
    .replace("    clearInterval(state.timerInterval); state.timerInterval = null;\n", "");
  control(noStop !== tutorBody, "the stop lines are where this suite expects them");
  r = await runEntry(noStop, null, true);
  control(r.calls.indexOf("clearInterval:11") === -1 && !r.calls.some(c => /^detach/.test(c)), "without them the student's clock keeps running and the recorder stays attached — the probe sees it");

  /* every route into the dashboard: the two sign-ins (each after the tutor's
     entry) and three Back exits that only exist on a surface the dashboard
     itself opened (origin "dashboard") — nothing else, in any spelling */
  const lines = strip(appSrc).split("\n");
  const sites = lines.map((l, i) => ({ l: l.trim(), i })).filter(x => /Dashboard\s*\.\s*open\s*\(/.test(x.l));
  const SIGN_IN = "if(window.Dashboard) Dashboard.open(showOnly);";
  const BACKS = [
    'if(sdCtx && sdCtx.origin === "dashboard" && window.Dashboard){ Dashboard.open(showOnly); return; }',
    'if(setOrigin === "dashboard" && window.Dashboard){ Dashboard.open(showOnly); return; }',
    'if(scCtx && scCtx.origin === "dashboard" && window.Dashboard){ Dashboard.open(showOnly); return; }'];
  const signIns = sites.filter(x => x.l === SIGN_IN);
  const backs = sites.filter(x => BACKS.indexOf(x.l) !== -1);
  check(sites.length === 5 && signIns.length === 2 && backs.length === 3 && signIns.every(x => lines[x.i - 1].trim() === "await enterTutorSession();"),
    "every Dashboard.open in app.js is one of the two sign-ins (each right after await enterTutorSession()) or one of the three dashboard-origin Back exits",
    sites.map(x => (x.i + 1) + ":" + x.l.slice(0, 60)).join(" | "));
  const thirdRoute = appSrc.replace('    } else if(v.toLowerCase() === "acestem-admin"){', '    } else if(v === "zz"){ window.Dashboard.open(showOnly); return;\n    } else if(v.toLowerCase() === "acestem-admin"){');
  control(thirdRoute !== appSrc, "the acestem-admin branch is where this suite expects it");
  const tSites = strip(thirdRoute).split("\n").filter(l => /Dashboard\s*\.\s*open\s*\(/.test(l));
  control(tSites.length === 6, "a third, differently spelled route into the dashboard is counted — the probe sees it");
}

/* ================= §9 the viewer's branches in the shared renderer ================= */
console.log("--- 9. what the viewer renders, against review and a live sitting ---");
{
  /* buildQuestionHtml + sprReviewHtml + sprKeyHtml, the REAL functions, with
     the content helpers stubbed to plain text (their own suites cover them) */
  const RENDER_BODY = src => "let viewerShowAnswers = SHOW;\n" + extractFn(src, "buildQuestionHtml") + "\n" +
    extractFn(src, "sprReviewHtml") + "\n" + extractFn(src, "sprKeyHtml") + "\nreturn buildQuestionHtml;";
  const render = (src, mode, show, q) => {
    const mod = { moduleId: "m", section: q.type === "spr" ? "Math" : "Reading and Writing", moduleLabel: "Module 1", questions: [q] };
    const state = { elimMode: false, questionIndex: 0,
      reviewMode: mode === "live" ? null : mode === "review" ? { record: { answers: {} }, rowByQid: { [q.id]: { noKey: false, given: null, correct: false } } }
        : { record: { attemptId: "viewer:t", answers: {} }, rowByQid: {}, viewer: true } };
    const deps = { state, currentModule: () => mod, figureGoesLeft: () => false, figureFrameHtml: () => "", replaysAnnotations: () => false,
      sanitizeSavedHtml: s => s, fmt: s => escapeHtml(s), escapeHtml, sprPreviewHtml: () => "", hasKey,
      choiceBodyHtml: c => '<span class="ctext">' + escapeHtml(c) + "</span>", reviewTimeHtml: () => '<span class="rv-time">Time</span>', stemHtml: () => "",
      SHOW: show };
    const names = Object.keys(deps);
    const ms = { answers: {}, flags: new Set(), eliminated: {}, passageHtml: {}, stemHtml: {}, choiceHtml: {}, notes: {} };
    return new Function(...names, RENDER_BODY(src))(...names.map(n => deps[n]))(q, ms);
  };
  const MCQ = { id: "re1-q1", type: "mcq", choices: ["a", "b", "c", "d"], correctAnswer: 1, rationale: "Because." };
  const SPR = { id: "ma1-q4", type: "spr", correctAnswer: "3/4", altAnswers: [".75"] };
  const has = (h, s) => h.indexOf(s) !== -1;
  const keyOn = h => /class="choice rv[^"]*rv-key[^"]*" data-idx="1"/.test(h) && (h.match(/rv-key/g) || []).length === 1 && has(h, "✓ Correct answer");
  const live = h => has(h, 'id="abcToggle"') && !/id="flagBtn" disabled/.test(h);
  const viewerChecks = (src) => {
    const on = render(src, "viewer", true, MCQ), off = render(src, "viewer", false, MCQ);
    const sOn = render(src, "viewer", true, SPR), sOff = render(src, "viewer", false, SPR);
    return {
      onKey: keyOn(on), onRationale: has(on, "rv-rationale"),
      offClean: !/rv-key|rv-mark|rv-rationale/.test(off),
      noOmitted: !has(on, "rv-omitted") && !has(off, "rv-omitted"), noTime: !has(on, "rv-time") && !has(off, "rv-time"),
      parity: live(on) && live(off),
      sprOn: has(sOn, 'id="kpToggle"') && has(sOn, "Correct answer:</b> 3/4") && has(sOn, ".75") && !has(sOn, "rv-banner"),
      sprOff: has(sOff, 'id="kpToggle"') && !has(sOff, "rv-spr-key") && !has(sOff, "rv-banner")
    };
  };
  const v = viewerChecks(appSrc);
  check(v.onKey && v.onRationale, "viewer, Show answers ON: the keyed choice alone is marked as review marks it (✓ Correct answer), rationale shown");
  check(v.offClean, "viewer, Show answers OFF: no key mark, no rationale — nothing a student would not see");
  check(v.noOmitted && v.noTime, "viewer: no \"You omitted this question.\" and no time (there was no sitting), ON or OFF");
  check(v.parity, "viewer: the question header's markup is a sitting's — Mark for Review not greyed, the ABC toggle shown (that they are INERT is the browser proof's click probe, red against the `handlers` mutant)");
  check(/function attachQuestionHandlers\(\)\{[\s\S]*?attachFigureHandlers\(q\);[\s\S]*?\n    if\(state\.reviewMode\) return;\n/.test(appSrc),
    "attachQuestionHandlers still returns before wiring answers, flags, cross-outs and the keypad whenever reviewMode is set (the viewer included)");
  check(v.sprOn && v.sprOff, "viewer SPR: Show Keypad as a sitting shows it; with answers ON the key and its alternates beneath, no verdict; OFF nothing more");
  const rv = render(appSrc, "review", true, MCQ), lv = render(appSrc, "live", true, MCQ), rs = render(appSrc, "review", true, SPR);
  check(keyOn(rv) && has(rv, "rv-omitted") && has(rv, "rv-time") && /id="flagBtn" disabled/.test(rv) && !has(rv, "abcToggle") && has(rs, "rv-banner") && !has(rs, "kpToggle"),
    "(ordinary review is unchanged: key marked, omitted banner, time, flag disabled, no ABC; SPR verdict + key, no keypad)");
  check(!/rv-key|rv-mark|rv-omitted|rv-time/.test(lv) && live(lv), "(a live sitting is unchanged: no marks, live header)");
  const MUT = [
    ["key shown with answers off", "    const keyShown = !viewer || viewerShowAnswers;", "    const keyShown = true;", x => !x.offClean],
    ["omitted banner in the viewer", "(review && !viewer && !isSpr && !ms.answers.hasOwnProperty(q.id))", "(review && !isSpr && !ms.answers.hasOwnProperty(q.id))", x => !x.noOmitted],
    ["time in the viewer", "${review && !viewer ? reviewTimeHtml(q) : \"\"}", "${review ? reviewTimeHtml(q) : \"\"}", x => !x.noTime],
    ["rationale with answers off", "(review && keyShown && q.rationale)", "(review && q.rationale)", x => !x.offClean],
    ["flag greyed in the viewer", "${review && !viewer ? \" disabled\" : \"\"}", "${review ? \" disabled\" : \"\"}", x => !x.parity],
    ["SPR key with answers off", "      if(!viewerShowAnswers) return \"\";\n", "", x => !x.sprOff]
  ];
  MUT.forEach(([what, a, b, red]) => {
    const n = appSrc.split(a).length - 1;
    const m = appSrc.replace(a, b);
    control(n === 1 && red(viewerChecks(m)), "mutant (" + what + ") turns its check red", "needle x" + n);
  });

  /* updateHeaderTools, REAL, over a DOM whose innerHTML registers the ids it sets */
  const headerWorld = (src, mode, section) => {
    const reg = {};
    const wired = [];
    const mk = id => {
      const cls = new Set();
      const n = { id, _html: "", title: "", classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c); }, contains: c => cls.has(c) },
        addEventListener(type){ wired.push(id + ":" + type); }, remove(){ delete reg[id]; } };
      Object.defineProperty(n, "innerHTML", { get(){ return n._html; }, set(h){ n._html = h; (String(h).match(/id="([^"]+)"/g) || []).forEach(m => { const k = m.slice(4, -1); reg[k] = mk(k); }); } });
      return n;
    };
    ["thTools", "tBody"].forEach(k => { reg[k] = mk(k); });
    const state = { hlMode: false, reviewMode: mode === "live" ? null : mode === "review" ? { record: {} } : { viewer: true } };
    const body = extractConst(src, "MORE_MENU_HTML") + "\n" + extractFn(src, "updateHeaderTools") + "\nreturn updateHeaderTools;";
    let hlWired = 0;
    new Function("el", "state", "wireMoreMenu", "wireHlModeBtn", "toggleCalc", "toggleRef", body)(id => reg[id], state, () => {}, () => { hlWired++; }, () => {}, () => {})({ section });
    return { calc: !!reg.toolCalc, calcWired: wired.indexOf("toolCalc:click") !== -1, hl: !!reg.hlModeBtn, hlWired: hlWired > 0,
      bugHidden: !!reg.miBugReport && reg.miBugReport.classList.contains("hidden"),
      saveHidden: !!reg.miSaveExit && reg.miSaveExit.classList.contains("hidden"), lineReader: !!reg.miLineReader };
  };
  const hv = headerWorld(appSrc, "viewer", "Math"), hvr = headerWorld(appSrc, "viewer", "Reading and Writing");
  check(hv.calc && !hv.calcWired && hvr.hl && !hvr.hlWired && hv.bugHidden && hv.saveHidden && hv.lineReader && hvr.bugHidden,
    "viewer header: a sitting's tools as a student sees them — Calculator and Highlights & Notes shown but never wired (Desmos never loads); Report a bug and Save and Exit hidden; Line Reader kept",
    JSON.stringify({ math: hv, rw: hvr }));
  const hr = headerWorld(appSrc, "review", "Math"), hl = headerWorld(appSrc, "live", "Math"), hlr = headerWorld(appSrc, "live", "Reading and Writing");
  check(hr.calc && hr.calcWired && !hr.bugHidden && hr.saveHidden && hl.calc && hl.calcWired && !hl.bugHidden && !hl.saveHidden && hlr.hl && hlr.hlWired
    && !headerWorld(appSrc, "review", "Reading and Writing").hl,
    "(review and a live sitting keep their tools, wired: Calculator and Report a bug; review hides only Save and Exit and Highlights & Notes)");
  const calcMut = appSrc.replace("      if(!viewer) el(\"toolCalc\").addEventListener(\"click\", toggleCalc);", "      el(\"toolCalc\").addEventListener(\"click\", toggleCalc);");
  control(calcMut !== appSrc && headerWorld(calcMut, "viewer", "Math").calcWired, "mutant (Calculator wired in the viewer) — the probe sees it");
  const bugMut = appSrc.replace("      el(\"miBugReport\").classList.add(\"hidden\");\n      [\"toolCalc\"", "      [\"toolCalc\"");
  control(bugMut !== appSrc && !headerWorld(bugMut, "viewer", "Math").bugHidden, "mutant (Report a bug left in the viewer) — the probe sees it");
}

/* ================= §8 a restore in flight when the tutor signs in ================= */
console.log("--- 8. a boot-time student restore that the tutor's sign-in overtakes ---");
{
  /* signInWithCode, run for real: the tutor's entry (sessionGen bump) lands
     while it awaits — after the profile read, the assignments read, or the
     records read — and from then on the restore must land nowhere */
  /* each fence is probed by what ONLY it prevents (the later fences would
     otherwise mask its removal): after the profile read, the student's name
     painted into the header/footer and the next read; after the assignments
     read, that student's deletion landing (assignments answer "deleted");
     after the records read, the remembered code */
  const runSignIn = async (src, bumpAt, assignAnswer) => {
    const calls = [];
    const state = { sessionGen: 0, userName: "Student", displayName: null, tests: [{ testId: "t" }] };
    const els = {};
    const node = id => ({ set textContent(v){ calls.push("paint:" + id); }, get textContent(){ return ""; }, classList: { add(){}, remove(){} } });
    const step = (name, answer) => async () => { if(bumpAt === name) state.sessionGen++; calls.push(name); return answer; };
    const deps = {
      StudentCode: { valid: () => true }, el: id => els[id] || (els[id] = node(id)), state,
      AttemptStore: { getProfile: step("profile", null), clearRefused: () => calls.push("clearRefused") },
      Attempts: { assignments: step("assign", assignAnswer === undefined ? [] : assignAnswer) }, refreshStudentState: step("refresh", true),
      displayLabel: () => "X", firstName: () => "X", manifestLoaded: () => true,
      showOnly: id => calls.push("show:" + id), endDeletedSession: async () => calls.push("endDeleted"),
      rememberSession: () => calls.push("REMEMBER"), crashResumeCandidate: () => null,
      renderHome: () => calls.push("renderHome"), resumeSetFlow: () => calls.push("RESUME"), resumeTestFlow: () => calls.push("RESUME")
    };
    const names = Object.keys(deps);
    const fn = new Function(...names, "return async " + extractFn(src, "signInWithCode"))(...names.map(n => deps[n]));
    const ok = await fn("AS-VWPRF234");
    return { ok, calls, state };
  };
  const paintsName = c => /^paint:(homeUserName|homeAvatar|welcomeMsg|tfName)$/.test(c);
  let r = await runSignIn(appSrc, null);
  check(r.ok === true && r.calls.indexOf("REMEMBER") !== -1 && r.calls.indexOf("show:screen-home") !== -1 && r.calls.some(paintsName),
    "(an uninterrupted restore signs the student in, paints their name, remembers the code and shows home — unchanged)", r.calls.join(" > "));
  r = await runSignIn(appSrc, "profile");
  check(r.ok === false && !r.calls.some(paintsName) && r.calls.indexOf("assign") === -1,
    "overtaken during the profile read: no student name painted into the tutor's page, no further reads", r.calls.join(" > "));
  r = await runSignIn(appSrc, "assign", "deleted");
  check(r.ok === false && r.calls.indexOf("endDeleted") === -1 && !r.calls.some(c => /^show:/.test(c)),
    "overtaken during the assignments read: even a \"deleted\" answer lands no deletion screen on the tutor", r.calls.join(" > "));
  r = await runSignIn(appSrc, "refresh");
  check(r.ok === false && r.calls.indexOf("REMEMBER") === -1 && !r.calls.some(c => /^show:|renderHome|RESUME|clearRefused/.test(c)),
    "overtaken during the records read: the restore remembers nothing, paints nothing, resumes nothing", r.calls.join(" > "));
  const FENCES = {
    profile: /(    try\{ prof = await AttemptStore\.getProfile\(code\); \}catch\(e\)\{\}\n)    if\(gen !== state\.sessionGen\) return false;\n/,
    assign: /(    const assigns = await Attempts\.assignments\(code\);\n)    if\(gen !== state\.sessionGen\) return false;\n/,
    refresh: /(    if\(refreshed === "deleted"\) return false;[^\n]*\n)    if\(gen !== state\.sessionGen\) return false;\n/
  };
  const without = name => appSrc.replace(FENCES[name], "$1");
  control(Object.keys(FENCES).every(n => without(n) !== appSrc), "each of the three sign-in fences is where this suite expects it");
  r = await runSignIn(without("profile"), "profile");
  control(r.calls.some(paintsName), "without the profile fence the overtaken restore paints the student's name over the tutor — the probe sees it");
  r = await runSignIn(without("assign"), "assign", "deleted");
  control(r.calls.indexOf("endDeleted") !== -1, "without the assignments fence an overtaken \"deleted\" answer lands its deletion screen — the probe sees it");
  r = await runSignIn(without("refresh"), "refresh");
  control(r.calls.indexOf("REMEMBER") !== -1, "without the records fence the overtaken restore re-remembers the code and paints home — the probe sees it");

  /* a tutor sign-in cancelled while its request is in flight opens nothing
     when the answer arrives: the page may be a student's by then */
  const authHandler = src => {
    const at = src.indexOf('el("tutorAuthGo").addEventListener("click", async ()=>{');
    if(at === -1) throw new Error("tutorAuthGo handler not found");
    let i = src.indexOf("{", src.indexOf("=>", at)) + 1, depth = 1;
    const start = i;
    while(depth > 0 && i < src.length){ if(src[i] === "{") depth++; else if(src[i] === "}") depth--; i++; }
    return src.slice(start, i - 1);
  };
  /* opts.cancel: the tutor presses Cancel while the request is in flight;
     opts.reopen: and opens the dialog again before it answers;
     opts.sitting: a student's sitting is running behind the dialog */
  const runAuth = async (src, opts) => {
    opts = opts || {};
    const calls = [];
    const node = id => ({ id, value: id === "tutorEmail" ? "tutor@example.test" : id === "tutorPassword" ? "pw" : "",
      disabled: false, textContent: "", focus(){},
      classList: { contains: () => false, add(){}, remove: c => { if(id === "tutorAuthError" && c === "hidden") calls.push("ERROR-SHOWN"); } } });
    const els = {};
    const el = id => els[id] || (els[id] = node(id));
    const hooks = {};
    const AttemptStore = {
      signInTutor: async () => { calls.push("signIn"); if(opts.cancel) hooks.cancel(); },
      signOutTutor: () => calls.push("signOut")
    };
    const deps = { el, AttemptStore, enterTutorSession: () => calls.push("ENTER"), hide(){}, hooks,
      Dashboard: { open: () => calls.push("DASHBOARD") }, window: { Dashboard: { open: () => calls.push("DASHBOARD") } }, showOnly: () => {},
      sittingInFlight: () => !!opts.sitting, SITTING_IN_FLIGHT_MSG: "running" };
    const names = Object.keys(deps);
    const body = "let tutorAuthAttempt = 0;\n" + extractFn(src, "closeTutorAuth") +
      "\nhooks.cancel = () => closeTutorAuth();\nreturn async ()=>{" + authHandler(src) + "}";
    await new Function(...names, body)(...names.map(n => deps[n]))();
    return calls;
  };
  let ac = await runAuth(appSrc, {});
  check(ac.join(">") === "signIn>ENTER>DASHBOARD", "(a tutor sign-in that is not cancelled enters and opens the dashboard — unchanged)", ac.join(">"));
  ac = await runAuth(appSrc, { cancel: true });
  check(ac.indexOf("DASHBOARD") === -1 && ac.indexOf("ENTER") === -1 && ac.indexOf("signOut") !== -1,
    "a tutor sign-in Cancelled while in flight opens no dashboard (and so no viewer) for whoever is on the page when it answers, and keeps no token — reopening the dialog meanwhile does not revive it", ac.join(">"));
  ac = await runAuth(appSrc, { sitting: true });
  check(ac.indexOf("DASHBOARD") === -1 && ac.indexOf("ENTER") === -1 && ac.indexOf("signOut") !== -1 && ac.indexOf("ERROR-SHOWN") !== -1,
    "a student's sitting running behind the dialog: the tutor's sign-in is refused with a message — nothing torn down, no token kept", ac.join(">"));
  const noCancel = appSrc.replace("      if(attempt !== tutorAuthAttempt){ AttemptStore.signOutTutor(); return; }\n", "");
  control(noCancel !== appSrc, "the cancelled-sign-in line is where this suite expects it");
  ac = await runAuth(noCancel, { cancel: true });
  control(ac.indexOf("DASHBOARD") !== -1, "without it a cancelled sign-in's late answer opens the dashboard — the probe sees it");
  const noRefuse = appSrc.replace("      if(sittingInFlight()){\n        AttemptStore.signOutTutor();", "      if(false){\n        AttemptStore.signOutTutor();");
  control(noRefuse !== appSrc, "the sitting-in-flight refusal is where this suite expects it");
  ac = await runAuth(noRefuse, { sitting: true });
  control(ac.indexOf("ENTER") !== -1, "without it the tutor's entry goes ahead over a running sitting — the probe sees it");
  /* the acestem-admin route refuses the same way, and a typed code retires
     a boot restore still in flight */
  const doSign = extractFn(appSrc, "doSignin");
  check(/v\.toLowerCase\(\) === "acestem-admin"\)\{[^\n]*\n\s*if\(sittingInFlight\(\)\)\{\s*el\("signinError"\)\.textContent = SITTING_IN_FLIGHT_MSG;/.test(doSign)
    && /state\.sessionGen\+\+;\s*await signInWithCode\(code\);/.test(doSign),
    "acestem-admin refuses over a running sitting; a typed student code supersedes a boot restore in flight (sessionGen++ before it signs in)");
  check(/return !!\(state\.timerRunning \|\| state\.readyTimer \|\| state\.moduleOverTimer \|\| state\.breakInterval\);/.test(extractFn(appSrc, "sittingInFlight")),
    "sittingInFlight covers the module clock, the Ready/resume beat (where a teardown would save the record without its checkpoint), module-over and the break");

  /* refreshStudentState: an answer for a session that has ended lands nowhere */
  const runRefresh = async (src, endMidway, payload) => {
    const ended = [];
    const state = { sessionGen: 1, tombstoned: { keep: 1 }, pastAttempts: ["keep"] };
    const body = "async " + extractFn(src, "refreshStudentState") + "\nreturn refreshStudentState;";
    const fn = new Function("state", "Attempts", "endDeletedSession", "buildAssignmentIndex", "byStartDesc", body)(state,
      { loadStudentRecords: async () => { if(endMidway) state.sessionGen++; return payload; } }, async () => ended.push(1), () => {}, () => 0);
    const r = await fn("AS-VWPRF234");
    return { r, ended, state };
  };
  let rr = await runRefresh(appSrc, true, "deleted");
  check(rr.r === false && rr.ended.length === 0, "an overtaken restore's \"deleted\" answer paints no deletion landing over the tutor (the session that asked is gone)");
  rr = await runRefresh(appSrc, true, { live: [{ status: "completed" }], tombstones: [] });
  check(rr.r === false && rr.state.pastAttempts[0] === "keep", "...and its records refill no student state under the tutor");
  rr = await runRefresh(appSrc, false, "deleted");
  check(rr.r === "deleted" && rr.ended.length === 1, "(an answer for the live session still ends a deleted student's session — unchanged)");
  const noRF = appSrc.replace("    const res = await Attempts.loadStudentRecords(code);\n    if(gen !== state.sessionGen) return false;\n", "    const res = await Attempts.loadStudentRecords(code);\n");
  control(noRF !== appSrc, "the refreshStudentState fence is where this suite expects it");
  rr = await runRefresh(noRF, true, "deleted");
  control(rr.ended.length === 1, "without it the overtaken \"deleted\" answer ends the tutor's session — the probe sees it");

  /* boot answers a false restore with sign-in only if the session is still its own */
  const boot = extractFn(appSrc, "boot");
  check(/const gen = state\.sessionGen;\s*signInWithCode\(code\)\.then\(ok => \{ if\(!ok && gen === state\.sessionGen\) showOnly\("screen-signin"\); \}\)\s*\.catch\(\(\)=> \{ if\(gen === state\.sessionGen\) showOnly\("screen-signin"\); \}\);/.test(boot),
    "boot never paints sign-in over a tutor who took the device while the restore was in flight");
}

console.log("\n" + (fail === 0 ? "ALL PASS — " : "FAILURES — ") + pass + " passed, " + fail + " failed");
if(fail){ failures.forEach(f => console.log("  - " + f)); process.exit(1); }
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
