/* tests/tutor-writes.test.js — run: node tests/tutor-writes.test.js (repo root)

   Every tutor mutation in dashboard.js is remote-confirmed: in remote mode
   the SERVER is written first and this browser's mirror follows only on
   success (tutorPut / tutorDelete). This suite drives EVERY caller through a
   server that rejects the write (expired tutor session → 401) and checks:

     - a rejected WRITE leaves the mirror byte-for-byte as it was before the
       call, and the message starts "Not saved" and names the row;
     - a rejected DELETE leaves the row present (mirror AND server), and the
       message starts "Not deleted" and names the row;
     - no tutor message ever says "sync" in any form — nothing syncs these;
     - with an accepting server the same path really reaches it (control), so
       the archive delete and the bug dismiss — which used to be mirror-only —
       are proven to delete on the server.

   The mirror comparison is against a snapshot TAKEN BEFORE THE CALL from the
   fake store, never against a constant this file defines (the verify()
   tautology rule): if a path writes anything, the snapshots differ.

   To watch these checks fail on the pre-fix code:
     git show <pre-fix-commit>:dashboard.js > <scratch>/dashboard-prefix.js
     DASHBOARD_SRC=<scratch>/dashboard-prefix.js node tests/tutor-writes.test.js
   (functions missing there — tutorPut, dismissBug — fail as "not a function";
   the rest run their OLD bodies and fail on the mirror/message checks.)

   §12 (2026-10-06) is the other half of the contract: a Refresh pull whose
   server snapshot predates a tutor write must not put the pre-write row
   back (or revive a deleted one) when it lands. Those cases run the REAL
   loadFromStorage and the REAL attempts.js pull loop (pullAllForTutor,
   extracted from attempts.js — ATTEMPTS_SRC=<file> points it elsewhere, as
   DASHBOARD_SRC does for the dashboard), with the fake server handing the
   snapshot back only when the case releases it. */
"use strict";
const fs = require("fs");
const vm = require("vm");
const { extractFn, extractConst } = require("./extract-helper");
/* the real bank index: the dashboard page always has it (index.html loads
   testdata/bank-index.js at startup), and the set save reads it */
const REAL_BANK_INDEX = (() => { const c = { window: {} }; vm.createContext(c);
  vm.runInContext(fs.readFileSync("testdata/bank-index.js", "utf8"), c); return c.window.BANK_INDEX; })();

const SRC_PATH = process.env.DASHBOARD_SRC || "dashboard.js";
const src = fs.readFileSync(SRC_PATH, "utf8");
/* The REAL pull loop (attempts.js AttemptStore.pullAllForTutor), so the §12
   cases exercise the predicate check where it lives rather than a copy of
   it in this file. It is an object-literal method — `async pullAllForTutor(
   … ){` — closing over selectAllRows() and backend(), so it is lifted by
   brace-matching and rebound to a store's snapshot and mirror (realPull). */
const ATTEMPTS_PATH = process.env.ATTEMPTS_SRC || "attempts.js";
const attemptsSrc = fs.readFileSync(ATTEMPTS_PATH, "utf8");
function extractMethod(source, name){
  const m = new RegExp("async\\s+" + name + "\\s*\\(([^)]*)\\)\\s*\\{").exec(source);
  if(!m) throw new Error("method not found in " + ATTEMPTS_PATH + ": " + name);
  let i = m.index + m[0].length, depth = 1;
  while(depth > 0 && i < source.length){
    if(source[i] === "{") depth++;
    else if(source[i] === "}") depth--;
    i++;
  }
  return { params: m[1], body: source.slice(m.index + m[0].length, i - 1) };
}
const PULL_SRC = extractMethod(attemptsSrc, "pullAllForTutor");
const realPull = new Function("selectAllRows", "backend",
  "return async function pullAllForTutor(" + PULL_SRC.params + "){" + PULL_SRC.body + "\n}");

let pass = 0, fail = 0;
const failures = [];
/* A case that awaits a call stuck behind its own closed gate never settles:
   node drains the event loop and would exit 0 with no summary. process.exit()
   never fires beforeExit, so reaching it means the suite did not finish. */
process.on("beforeExit", () => {
  if(process.exitCode) return;
  console.log("HARNESS HUNG — a case never settled (a gated call awaited behind its own gate?). " + pass + " passed, " + fail + " failed before it.");
  process.exitCode = 2;
});
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}
const everyMessage = [];      // every status text any path produced, for the no-"sync" sweep
const STORES = [];            // every store built inside the current run(), for the order invariant
/* each case runs guarded, so on a source that lacks the fix (or a path) the
   case FAILS with the reason instead of aborting the whole suite. After the
   case, every remote-mode store it built is held to the SERVER-FIRST
   invariant per key (see serverFirstViolations) — the mirror-snapshot checks
   alone would also pass a mirror-first-then-rollback implementation. */
async function run(fn){
  const start = STORES.length;
  try{ await fn(); }
  catch(e){ check(false, "case could not run — " + (e && e.message || e)); }
  for(const s of STORES.slice(start)){
    if(!s.remote || !s.ops.some(o => o[0] !== "select")) continue;
    const v = s.serverFirstViolations();
    check(v.length === 0, "server-first order held for every key this case touched", v.join("; "));
    const dv = s.divergences();
    check(dv.length === 0, "mirror and server agree on every key they both hold", dv.join(", "));
    /* a Refresh pull may only ever copy what the server holds at that
       moment (see pullAllForTutor in makeStore) */
    if(s.ops.some(o => o[0] === "mirror:pull")){
      const stale = s.ops.filter(o => o[0] === "mirror:pull" && o[2] === "stale").map(o => o[1]);
      check(stale.length === 0, "no Refresh pull wrote a row the server did not hold with that value when it landed", stale.join(", "));
    }
  }
}
/* a rejection nothing awaited (a case's unawaited call failing after the
   case moved on) must not kill the run without its summary */
process.on("unhandledRejection", e => { check(false, "unhandled rejection — " + (e && e.stack || e)); });

/* ---------- fake storage: a mirror, a server, and a call log ---------- */
function makeStore(opts){
  opts = opts || {};
  const mirror = new Map(), server = new Map(), calls = [], ops = [];
  const clone = v => JSON.parse(JSON.stringify(v));
  const rejecting = (op, key) => typeof opts.reject === "function" ? !!opts.reject(op, key) : !!opts.reject;
  const expired = () => { const e = new Error(opts.errorMessage || "JWT expired"); e.status = opts.errorStatus === undefined ? 401 : opts.errorStatus; return e; };
  /* the Refresh pull's two moments, for §12: `pullStarted` resolves when the
     FIRST snapshot has been TAKEN (the rows as they are at that instant);
     with opts.holdPull every pull's snapshot is handed back only when the
     case calls releasePull() — one release per pull, in start order, so two
     pulls in flight settle one after the other, as two page responses do
     (each tail runs whole in its own macrotask on the page; resuming both
     from one promise would interleave them at microtask grain, a fake's
     artifact the page cannot produce) */
  let pullStartedRes;
  const pullStarted = new Promise(res => { pullStartedRes = res; });
  const holds = [];
  const releasePull = () => { const h = holds.shift(); if(h) h(); };
  const AS = {
    isRemote: () => opts.remote !== false,
    isLocal: () => opts.remote === false && !opts.shared,        // artifact ("shared") mode is neither remote nor local
    hasAuthToken: () => true,
    /* Refresh's pull (2026-10-06): the REAL attempts.js loop (realPull) over
       THIS store — selectAllRows is the server snapshot, backend() the
       mirror. A pull's mirror writes are tagged mirror:pull: a server→mirror
       copy, which the server-first invariant neither flags (it is not a
       tutor write) nor treats as a server call that licenses one. Each is
       also judged by VALUE at the moment it lands — "fresh" when the server
       holds that key with that exact value right now, "stale" otherwise —
       and run() fails a case on any stale one: the pull put back a row the
       server no longer holds, or holds differently. That rule is what
       catches a revived delete the divergences() check cannot see (it
       compares only keys both sides hold), and it never trips on an
       idempotent re-mark of a tombstone. The Map write stays synchronous,
       as localBackend.set's localStorage.setItem is. */
    pullAllForTutor: realPull(
      async () => {
        calls.push(["selectAll"]);
        if(opts.pullFail){ pullStartedRes(); throw new Error("network down"); }
        const snap = [...server.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
          .map(([k, r]) => ({ key: k, owner_code: r.owner, value: clone(r.value) }));
        pullStartedRes();
        if(opts.holdPull) await new Promise(res => { holds.push(res); });
        return snap;
      },
      () => ({ async set(k, v){
        const cur = server.get(k);
        ops.push(["mirror:pull", k, (cur && JSON.stringify(cur.value) === v) ? "fresh" : "stale"]);
        mirror.set(k, JSON.parse(v));
      } })),
    async setLocal(k, v){ calls.push(["setLocal", k]); ops.push(["mirror:set", k]); if(opts.localThrow) throw new Error("storage exploded"); if(opts.localFail) return false; mirror.set(k, clone(v)); return true; },
    async remove(k){ calls.push(["remove", k]); ops.push(["mirror:remove", k]); if(opts.localFail) return false; mirror.delete(k); return true; },
    async get(k){ return mirror.has(k) ? clone(mirror.get(k)) : null; },
    /* attempts.js getResult: the three outcomes get() flattens to null */
    async getResult(k){ calls.push(["getResult", k]);
      if(opts.localReadFail) return { status: "error", value: null };
      return mirror.has(k) ? { status: "ok", value: clone(mirror.get(k)) } : { status: "missing", value: null }; },
    async list(prefix){ return [...mirror.keys()].filter(k => k.indexOf(prefix) === 0).sort(); },
    async adminUpsert(k, owner, v){ calls.push(["adminUpsert", k]);
      if(rejecting("put", k)){ ops.push(["admin", k, "rejected"]); throw expired(); }
      ops.push(["admin", k, "ok"]); server.set(k, { owner: owner, value: clone(v) }); return null; },
    async adminDelete(k){ calls.push(["adminDelete", k]);
      if(rejecting("delete", k)){ ops.push(["admin", k, "rejected"]); throw expired(); }
      ops.push(["admin", k, "ok"]); server.delete(k); return null; },
    async adminSelectKey(k){ calls.push(["adminSelectKey", k]);
      if(rejecting("select", k)){ ops.push(["select", k, "rejected"]); throw expired(); }
      ops.push(["select", k, server.has(k) ? "found" : "missing"]);
      return server.has(k) ? [{ key: k, owner_code: server.get(k).owner, value: clone(server.get(k).value) }] : []; },
    async adminSelectAll(){ return [...server.entries()].map(([k, r]) => ({ key: k, owner_code: r.owner, value: clone(r.value) })); },
    /* the tutor-only tombstone RPCs (2026-09-18), modelled on the migration:
       a marker row per key, never an edit or a delete of the record, an
       existing marker returned untouched, any status for the per-attempt
       call (2026-09-21), every attempt the code owns for the per-student
       call. Each
       marker written counts as an accepted server op on THAT key, which is
       what licenses the mirror write that must follow it. */
    async adminRpc(fn, args){
      calls.push(["adminRpc", fn, JSON.stringify(args)]);
      /* assignmentsAtDeletion: as the SQL computes it — for an untagged
         record, every assignment row the owner holds for that testId */
      /* v_at defaults to [] and is filled ONLY inside the untagged AND
         FINISHED branch, so a tagged record and an in-progress one (which
         closes no assignment, 2026-09-21) both get [] */
      const FINISHED = new Set(["completed", "timed-out"]);
      const atDeletion = r => (!r.value || r.value.assignmentId || !FINISHED.has(String(r.value.status))) ? [] :
        [...server.entries()].filter(([k, a]) => k.indexOf("assign:" + r.owner + ":") === 0 && !/:__none$/.test(k) && a.value && a.value.testId === (r.value && r.value.testId))
          .map(([k]) => k.split(":")[2]).sort();
      const tombOf = (k, r, reason) => ({ kind: "tombstone", targetKind: "attempt", target: k, code: r.owner,
        deletedAt: "2026-09-18T00:00:00Z", deletedBy: "tutor@test", reason: reason, assignmentsAtDeletion: atDeletion(r),
        testId: r.value.testId == null ? null : r.value.testId, assignmentId: r.value.assignmentId == null ? null : r.value.assignmentId,
        status: r.value.status == null ? null : r.value.status, attemptKind: r.value.kind === "set" ? "set" : "form",
        setId: r.value.setId == null ? null : r.value.setId, conditions: r.value.conditions == null ? null : r.value.conditions,
        startedAt: r.value.startedAt == null ? null : r.value.startedAt, submittedAt: r.value.submittedAt == null ? null : r.value.submittedAt });
      const refuse = (k, msg) => { ops.push(["admin", k, "rejected"]); const e = new Error(msg); e.status = 400; throw e; };
      if(fn === "fn_tombstone_attempt"){
        const k = "tomb:" + args.p_key;
        if(rejecting("rpc", k)){ ops.push(["admin", k, "rejected"]); throw expired(); }
        const rec = server.get(args.p_key);
        if(!rec) refuse(k, "no such attempt");
        /* 2026-09-21: no status check — finished AND in-progress attempts are
           markable. The marker copies whatever status the record has, which
           is what the client keys the assignment on. */
        if(!server.has(k)) server.set(k, { owner: rec.owner, value: tombOf(args.p_key, rec, "attempt") });
        ops.push(["admin", k, "ok"]);
        return clone(server.get(k).value);
      }
      if(fn === "fn_tombstone_student"){
        const code = args.p_code, sk = "tomb:student:" + code;
        if(rejecting("rpc", sk)){ ops.push(["admin", sk, "rejected"]); throw expired(); }
        const attempts = [];
        for(const [k, r] of [...server.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)){
          if(k.indexOf("attempt:") !== 0 || r.owner !== code) continue;
          const tk = "tomb:" + k;
          if(!server.has(tk)) server.set(tk, { owner: code, value: tombOf(k, r, "student") });
          ops.push(["admin", tk, "ok"]);
          attempts.push({ key: tk, value: clone(server.get(tk).value) });
        }
        if(!server.has(sk)) server.set(sk, { owner: code, value: { kind: "tombstone", targetKind: "student", target: code, code: code,
          deletedAt: "2026-09-18T00:00:00Z", deletedBy: "tutor@test", attemptsTombstoned: attempts.length, hadProfile: server.has("student:" + code) } });
        ops.push(["admin", sk, "ok"]);
        return { student: clone(server.get(sk).value), attempts: attempts };
      }
      throw new Error("unknown rpc " + fn);
    },
    tutorIdentity(){ return opts.remote === false ? "acestem-admin (local)" : "tutor@test"; }
  };
  const seedBoth = (k, v, owner) => { mirror.set(k, clone(v)); server.set(k, { owner: owner || null, value: clone(v) }); };
  const snapshot = () => JSON.stringify([...mirror.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1));
  /* SERVER-FIRST, per key, in remote mode: a mirror SET must follow an
     accepted server call on that same key with no rejection since; a mirror
     REMOVE must follow an accepted server call OR a server read that came
     back EMPTY (the one heal-the-mirror path: a row the server never had —
     a read that found the row licenses nothing). Any mirror write on a key
     whose last server call was rejected, or with no server call at all, is
     the pre-fix shape and is a violation. */
  const serverFirstViolations = () => {
    const last = new Map(), out = [];
    for(const [op, k, outcome] of ops){
      if(op === "admin") last.set(k, outcome);
      else if(op === "select") last.set(k, "select-" + outcome);
      else if(op === "mirror:set"){ if(last.get(k) !== "ok") out.push("mirror SET of " + k + " " + (last.has(k) ? "after a " + last.get(k) + " server call" : "with no server call")); }
      else if(op === "mirror:remove"){ if(last.get(k) !== "ok" && last.get(k) !== "select-missing") out.push("mirror REMOVE of " + k + " " + (last.has(k) ? "after a " + last.get(k) + " server call" : "with no server call")); }
    }
    return out;
  };
  /* after a case, every key on BOTH sides must hold the same value — the
     mirror is a copy of what the server accepted, never a variant of it
     (unless this store was told the mirror can't be written at all) */
  const divergences = () => {
    if(opts.localFail) return [];
    const out = [];
    for(const [k, r] of server.entries()){
      if(mirror.has(k) && JSON.stringify(mirror.get(k)) !== JSON.stringify(r.value)) out.push(k);
    }
    return out;
  };
  const store = { AS, mirror, server, calls, ops, seedBoth, snapshot, serverFirstViolations, divergences, remote: opts.remote !== false,
                  pullStarted, releasePull: () => releasePull() };
  STORES.push(store);
  return store;
}

/* ---------- fake DOM + the dashboard closure, rebuilt per case ---------- */
/* the same two rules attempts.js's StudentCode applies (normalize strips
   inner whitespace too — "AS-ABCD EFGH" as read aloud) */
const StudentCode = {
  valid: c => /^AS-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(String(c || "").trim().toUpperCase()),
  normalize: c => String(c || "").trim().toUpperCase().replace(/\s+/g, "")
};
const NAMES = ["describeRow", "rejectedText", "tutorPut", "tutorDelete", "saveProfiles", "saveNameOnly",
  "formCodes", "createAssignment", "deleteAssignment", "clearAssignments", "deleteSet", "exportAll", "deleteArchived",
  "dismissBug", "deleteAttempt", "toggleRelease", "assignmentsForSet", "isDeletableAttempt", "nameFor",
  "fmtDate", "freshAssignmentRow", "newSetId", "saveSetFromBuilder", "assignSetFromForm", "migrateLocalToServer",
  // tombstones (2026-09-18): the third helper and the two deletion actions
  "isFinishedAttempt", "isInProgressAttempt", "isTombstoned", "isDeletedStudent", "tombFor", "orphanStubs", "localTombstone",
  "isTombValue", "tutorTombstone", "deleteStudent", "deleteGateOk", "adoptArchive",
  "tombstoneRejectedText", "assignmentsAtDeletion", "sameTest",
  // the set save's retired-item refusal (2026-09-30)
  "refKey", "bankEntryIn", "bankEntryOf", "isRetiredBankRef", "liveReplacement", "bankIndexReReadable",
  "freshestBankIndex", "refusedBankRefs", "storedSetRefKeys",
  // the builder's own edits and the renderer the save uses (second review, 2026-09-30)
  "renderKeepingInputs", "pushRef", "builderHeldAs", "canonRef", "splitRef", "manifestEntry",
  "builderAddModule", "builderRemoveRef", "builderMoveRef", "builderFromSet", "openSetInBuilder", "newSetInBuilder", "deleteSetFromList",
  // the kept-as-a-new-set advice (final check, 2026-09-30)
  "keptAsNewSetText", "retiredRefsOf", "refText",
  // the REAL reloads (a counting stub let a check pass on state it seeded — final check, finding 7)
  "loadSets", "loadAssignsAndBugs",
  // the Refresh pull vs a concurrent write (2026-10-06): the helpers' note to an in-flight pull
  "notePulledWrite"];
const ASYNC = new Set(["tutorPut", "tutorDelete", "saveProfiles", "saveNameOnly", "createAssignment",
  "deleteAssignment", "clearAssignments", "deleteSet", "deleteArchived", "dismissBug", "deleteAttempt",
  "toggleRelease", "freshAssignmentRow", "saveSetFromBuilder", "assignSetFromForm", "migrateLocalToServer",
  "tutorTombstone", "deleteStudent", "freshestBankIndex", "refusedBankRefs", "storedSetRefKeys", "loadSets", "loadAssignsAndBugs"]);
function tryExtract(name){
  try{ return (ASYNC.has(name) ? "async " : "") + extractFn(src, name); }
  catch(e){ return "";  /* absent in this source — the path's check will fail */ }
}
/* The bank-index URL is the real one; the re-read DEADLINE is shortened so
   the hang case settles in milliseconds — the real value is pinned to a sane
   range by its own check in §9f. */
const REAL_TIMEOUT_SRC = (() => { try{ return extractConst(src, "BANK_INDEX_TIMEOUT_MS"); }catch(e){ return ""; } })();
const URL_SRC = (() => { try{ return extractConst(src, "BANK_INDEX_URL"); }catch(e){ return ""; } })();
const KEPT_SRC = ["KEPT_VALUES", "KEPT_CHECKS", "KEPT_MULTI"].map(n => { try{ return extractConst(src, n); }catch(e){ return ""; } }).join("\n");
/* Module state the new code relies on is taken FROM dashboard.js, never
   declared by this harness: a declaration missing from the page must fail
   here, not only in the browser (second review, finding 21). */
function decl(name){
  const m = src.match(new RegExp("^[ \\t]*(?:let|const)[ \\t]+" + name + "[ \\t]*=[^;\\n]*;", "m"));
  return m ? m[0] : "/* dashboard.js no longer declares " + name + " */";
}
const STATE_SRC = [decl("bankIndexFresh"), decl("builderTestId"), decl("fullTests"), decl("setSaveInFlight"), decl("pullsInFlight")].join("\n");
const BODY = NAMES.map(tryExtract).join("\n") + "\n" + URL_SRC + "\n" + KEPT_SRC + "\n" + STATE_SRC +
  "\nconst BANK_INDEX_TIMEOUT_MS = 60;\n";
/* the REAL loadFromStorage, for the §12 cases only (build's opts.realLoad):
   everywhere else it stays the counting stub, so a case that merely counts
   reloads does not run a pull it never seeded a server for */
const REAL_LOAD_SRC = (() => { try{ return "async " + extractFn(src, "loadFromStorage"); }catch(e){ return ""; } })();
/* The page kinds the re-read decision depends on, built from the REAL
   markup (second review, findings 7/19/24): the split tree's index.html as
   served over http(s) ("origin") and as a file:// copy ("file"), and the
   single-file build ("inlined": assemble.py inlines every local <script src>
   except config.js). document.querySelector here EVALUATES the selector it
   is given against those tags — an unsupported selector throws, as a
   browser's would for invalid CSS. */
const INDEX_HTML = fs.readFileSync("index.html", "utf8");
const SCRIPT_SRCS = [...INDEX_HTML.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)].map(m => m[1]);
/* the single-file build's scripts, by assemble.py's OWN rule read from
   assemble.py (LOCAL_JS_RE + SKIP_INLINE): a <script src> survives inlining
   unless its whole tag matches that pattern and it isn't skipped — so a tag
   that grows an attribute stays a <script src> here exactly as in the build */
const ASSEMBLE_PY = fs.readFileSync("assemble.py", "utf8");
const LOCAL_JS_RE_SRC = (ASSEMBLE_PY.match(/LOCAL_JS_RE = re\.compile\(r'([^']+)'\)/) || [])[1];
const SKIP_INLINE = ((ASSEMBLE_PY.match(/SKIP_INLINE = \{([^}]*)\}/) || [])[1] || "").split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
const INLINED_AWAY = LOCAL_JS_RE_SRC ? [...INDEX_HTML.matchAll(new RegExp(LOCAL_JS_RE_SRC, "g"))].map(m => m[1]).filter(u => SKIP_INLINE.indexOf(u) === -1) : [];
const INLINED_SRCS = SCRIPT_SRCS.filter(u => INLINED_AWAY.indexOf(u) === -1);
const PAGE_KINDS = { origin: { srcs: SCRIPT_SRCS, protocol: "https:" }, file: { srcs: SCRIPT_SRCS, protocol: "file:" },
                     inlined: { srcs: INLINED_SRCS, protocol: "https:" } };
function selectorQuery(srcs){
  return sel => {
    const m = /^script\[src(\$=|\^=|\*=|=)"([^"]*)"\]$/.exec(String(sel));
    if(!m){ const e = new Error("unsupported selector in the harness: " + sel); e.name = "SyntaxError"; throw e; }
    const op = m[1], v = m[2];
    const hit = srcs.find(u => op === "$=" ? u.endsWith(v) : op === "^=" ? u.startsWith(v) : op === "*=" ? u.indexOf(v) !== -1 : u === v);
    return hit ? { tagName: "SCRIPT", src: hit } : null;
  };
}
const PRESENT = NAMES.filter(n => tryExtract(n) !== "");

function build(store, win, doc, opts){
  opts = opts || {};
  const els = {};
  const $ = id => els[id] || (els[id] = { value: "", textContent: "", checked: false, disabled: false,
    selectedOptions: [], classList: { add(){}, remove(){}, toggle(){} } });
  /* render()/renderAll() rebuild #dashBody in the real dashboard, which wipes
     any textContent written to a node INSIDE it (saMsg, sbMsg, afMsg) — model
     that, so a message delivered only to a soon-to-be-replaced node does not
     pass here while the page shows nothing. dashStatus lives outside. */
  const wipeBody = () => {
    ["saMsg", "sbMsg", "afMsg"].forEach(id => { if(els[id]) els[id].textContent = ""; });
    /* …and every DOM-only form value in it: the two assign forms keep
       theirs only in the DOM, which is what renderKeepingInputs exists for */
    ["afFree", "afName", "afTest", "afCat", "afTiming", "afOpens", "afExpires", "afResetCode",
     "saSet", "saFree", "saLimit", "saExpires"].forEach(id => { if(els[id]) els[id].value = ""; });
    if(els.saHold) els.saHold.checked = false;
    ["afCodes", "saCodes"].forEach(id => { const el = els[id]; if(el && el.options) el.options.forEach(o => { o.selected = false; }); });
  };
  /* exportAll's download plumbing, stubbed: it only needs an anchor to click.
     The Blob RECORDS its parts so the payload can be asserted on. */
  const documentStub = { createElement: () => ({ href: "", download: "", click(){}, remove(){} }), body: { appendChild(){} } };
  /* doc.page: "origin" (index.html over http(s)), "file" (index.html as a
     file:// copy) or "inlined" (the single-file build) — the default */
  const kind = PAGE_KINDS[(doc && doc.page) || "inlined"];
  documentStub.querySelector = selectorQuery(kind.srcs);
  const warns = [];
  const consoleStub = { log: (...a) => console.log(...a), error: (...a) => console.error(...a),
    warn: (...a) => { warns.push(a.map(String).join(" ")); } };
  const URLStub = { createObjectURL: () => "blob:stub", revokeObjectURL(){} };
  const blobs = [];
  function BlobStub(parts){ this.text = (parts || []).join(""); blobs.push(this); }
  const factory = new Function("AttemptStore", "$", "StudentCode", "confirm", "window", "escapeHtml", "wipeBody", "document", "URL", "Blob", "console", `
    let recs = [], assigns = [], bugs = [], lastStartCode = null, profiles = {}, source = "storage", lastExport = null;
    let sets = [], builder = null, setsMsg = "", saMsg = "", openAttemptId = null, tombs = {}, tab = "sets";
    let dedup = null;                      // canonical grouping is canonical-index.test.js's; here: exact keys only
    const testsById = {};
    const loads = { assigns: 0, sets: 0, storage: 0, render: 0, setsLock: [], assignsLock: [], profilesAtReload: [] };
    async function loadFromStorage(){ loads.storage++; }
    /* render paints what viewSetBuilder paints for the builder's outcome
       line and Save button (so a check can see a render happened, and what
       it showed), after wiping the body as the real one does */
    const paints = [];
    /* the page lock as this source has it — undefined when it declares none
       (a pre-fix source must fail its checks, not crash every paint) */
    function inFlightNow(){ return typeof setSaveInFlight === "undefined" ? undefined : setSaveInFlight; }
    function paintBuilder(){
      $("sbMsg").textContent = builder ? (builder.msg || "") : ""; $("sbSaveBtn").disabled = !!(builder && builder.saving) || inFlightNow() > 0;
      $("setNewBtn").disabled = inFlightNow() > 0;         // viewSets' listBusy
      paints.push({ msg: builder ? (builder.msg || "") : null, setId: builder ? builder.setId : undefined,
                    storedKeys: builder && builder.storedKeys ? builder.storedKeys.slice() : null, inFlight: inFlightNow() });
    }
    function render(){ loads.render++; wipeBody(); paintBuilder(); }
    function renderAll(){ loads.render++; wipeBody(); paintBuilder(); }
    /* canonical-id awareness (2026-09-07): createAssignment appends the
       overlap notes to its status line. The derivation itself is covered by
       tests/canonical-index.test.js; here the stub returns one sentinel note
       per assigned code so the STATUS-LINE edge is pinned (see the
       createAssignment control case). */
    function overlapNotes(codes, testId){ return codes.map(c => "OVERLAP-NOTE " + c + " " + testId); }
    function rearmDedup(){}                // the canonical-index retry: nothing to re-arm here
    ${BODY}
    ${opts.realLoad ? REAL_LOAD_SRC + `
    /* the real load, declared after the stub so it is the binding; wrapped to keep the count */
    { const realLoad = loadFromStorage; loadFromStorage = async function(){ loads.storage++; return realLoad(); }; }` : ""}
    /* loadSets / loadAssignsAndBugs are dashboard.js's own (they read the
       fake store like the real one); wrapped only to count the calls and
       record the page lock each ran under */
    if(typeof loadSets === "function"){ const realLoadSets = loadSets; loadSets = async function(){ loads.sets++; loads.setsLock.push(inFlightNow()); return realLoadSets(); }; }
    if(typeof loadAssignsAndBugs === "function"){ const realLoadAB = loadAssignsAndBugs; loadAssignsAndBugs = async function(){ loads.assigns++; loads.assignsLock.push(inFlightNow()); loads.profilesAtReload.push(JSON.parse(JSON.stringify(profiles))); return realLoadAB(); }; }
    const fns = {};
    ${PRESENT.map(n => `fns[${JSON.stringify(n)}] = ${n};`).join("\n")}
    ${opts.realLoad ? "fns.loadFromStorage = loadFromStorage;" : ""}
    return {
      fns,
      state: () => ({ recs, assigns, lastStartCode, profiles, lastExport, sets, builder, setsMsg, saMsg, openAttemptId, loads, tombs, paints, setSaveInFlight: inFlightNow(),
                      pullsInFlight: typeof pullsInFlight === "undefined" ? undefined : pullsInFlight.size }),
      setTab: t => { tab = t; },
      seed: o => {
        if("recs" in o) recs = o.recs; if("assigns" in o) assigns = o.assigns; if("profiles" in o) profiles = o.profiles;
        if("lastExport" in o) lastExport = o.lastExport; if("sets" in o) sets = o.sets; if("builder" in o) builder = o.builder;
        if("source" in o) source = o.source; if("lastStartCode" in o) lastStartCode = o.lastStartCode;
        if("tombs" in o) tombs = o.tombs;
        if("builderTestId" in o) builderTestId = o.builderTestId; if("fullTest" in o) fullTests[o.fullTest.testId] = o.fullTest;
        if("setSaveInFlight" in o){
          if(typeof setSaveInFlight === "undefined") throw new Error("this dashboard.js declares no setSaveInFlight (no page lock)");
          setSaveInFlight = o.setSaveInFlight;
        }
      }
    };
  `);
  const windowStub = Object.assign({ confirm: () => true, BANK_INDEX: REAL_BANK_INDEX, location: { protocol: kind.protocol } }, win || {});
  /* the bare confirm() the dashboard calls answers as win.confirm does (yes by default) */
  const d = factory(store.AS, $, StudentCode, (...a) => windowStub.confirm(...a), windowStub, s => String(s), wipeBody, documentStub, URLStub, BlobStub, consoleStub);
  d.warns = warns;
  d.els = els; d.$ = $;
  Object.defineProperty(d, "lastBlob", { get(){ return blobs[blobs.length - 1] || null; } });
  return d;
}
const C1 = "AS-ABCDEFGH", C2 = "AS-JKLMNPQR";
/* the profiles map as the write left it: the real reload rebuilds it from the
   mirror, so a check on the map AFTER the reload can't see saveProfiles' own
   rule (review round 6, finding 6) */
const mapBeforeReload = d => { const a = d.state().loads.profilesAtReload; return a.length ? a[a.length - 1] : d.state().profiles; };
const status = d => { const t = d.$("dashStatus").textContent; everyMessage.push(t); return t; };
const noSync = t => !/sync/i.test(t);

(async () => {
  /* =================== 0. the helper itself =================== */
  console.log("--- 0. tutorPut / tutorDelete: server first, mirror on success ---");
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    const before = s.snapshot();
    const r = await d.fns.tutorPut("assign:" + C1 + ":a-9", C1, { assignmentId: "a-9" });
    check(r.ok === false && s.snapshot() === before && !s.calls.some(c => c[0] === "setLocal"),
      "remote PUT rejected: mirror untouched and setLocal never called", JSON.stringify(s.calls));
    check(/^Not saved — assignment a-9 for AS-ABCDEFGH: the tutor sign-in has expired/.test(r.message) && noSync(r.message),
      "rejected PUT message: 'Not saved', names the row, gives the 401 reason, never says sync", r.message);
    everyMessage.push(r.message);
    s.seedBoth("pset:pset-1", { setId: "pset-1" });
    const before2 = s.snapshot();
    const r2 = await d.fns.tutorDelete("pset:pset-1");
    check(r2.ok === false && s.snapshot() === before2 && s.server.has("pset:pset-1") && !s.calls.some(c => c[0] === "remove"),
      "remote DELETE rejected: row still in mirror and server, remove never called");
    check(/^Not deleted — set pset-1: /.test(r2.message) && noSync(r2.message), "rejected DELETE message names the row", r2.message);
    everyMessage.push(r2.message);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    await d.fns.tutorPut("student:" + C1, C1, { displayName: "E" });
    const order = s.calls.map(c => c[0]);
    check(order.indexOf("adminUpsert") !== -1 && order.indexOf("adminUpsert") < order.indexOf("setLocal"),
      "accepting PUT: server written BEFORE the mirror", order.join(","));
    check(s.server.has("student:" + C1) && s.mirror.has("student:" + C1) && s.server.get("student:" + C1).owner === C1,
      "accepting PUT: both hold the row, owner_code carried");
    await d.fns.tutorDelete("student:" + C1);
    const o2 = s.calls.map(c => c[0]);
    check(o2.lastIndexOf("adminDelete") < o2.lastIndexOf("remove") && !s.server.has("student:" + C1) && !s.mirror.has("student:" + C1),
      "accepting DELETE: server deleted BEFORE the mirror, then both gone");
  });
  await run(async () => {
    const s = makeStore({ remote: false, localFail: true }); const d = build(s);
    const r = await d.fns.tutorPut("pset:pset-2", null, { setId: "pset-2" });
    check(r.ok === false && /^Not saved — set pset-2: storage isn't writable/.test(r.message) && !s.calls.some(c => /^admin/.test(c[0])),
      "local mode: no server call, a failed local write is 'Not saved' naming the row", r.message);
    const r2 = await d.fns.tutorDelete("pset:pset-2");
    check(r2.ok === false && /^Not deleted — set pset-2/.test(r2.message), "local mode: a failed local delete is 'Not deleted' naming the row");
  });
  await run(async () => {
    const s = makeStore({ localFail: true }); const d = build(s);   // server accepts, mirror can't be written
    const r = await d.fns.tutorPut("pset:pset-3", null, { setId: "pset-3" });
    check(r.ok === true && /Saved on the server, but this browser's copy of set pset-3/.test(r.warning) && s.server.has("pset:pset-3"),
      "server accepted but the mirror failed: ok with a warning (the server is the truth)", r.warning);
    everyMessage.push(r.warning);
  });

  /* =================== 1. createAssignment (form tests) =================== */
  console.log("--- 1. createAssignment: a rejected form assignment is not shown as assigned ---");
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afFree").value = "";
    d.$("afTest").value = "202606asiav1"; d.$("afCat").value = "test"; d.$("afTiming").value = "1";
    const before = s.snapshot();
    await d.fns.createAssignment();
    const t = status(d);
    check(s.snapshot() === before && s.server.size === 0, "rejected: mirror unchanged, nothing on the server");
    check(d.state().lastStartCode === null, "rejected: no start code is offered for a sitting that doesn't exist", String(d.state().lastStartCode));
    check(/^Not saved — assignment a-\S+ for AS-ABCDEFGH: the tutor sign-in has expired/.test(t) && noSync(t),
      "rejected: message is 'Not saved', names the assignment row and the code, never says sync", t);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afTest").value = "202606asiav1"; d.$("afCat").value = "test"; d.$("afTiming").value = "1";
    await d.fns.createAssignment();
    const t = status(d);
    const k = [...s.server.keys()].find(x => x.indexOf("assign:" + C1 + ":a-") === 0);
    check(!!k && s.mirror.has(k) && s.server.get(k).owner === C1 && /^\d{6}$/.test(d.state().lastStartCode) && /^Assigned 202606asiav1 to AS-ABCDEFGH/.test(t) && noSync(t),
      "control: an accepted form assignment lands on the server, then the mirror, with a start code", t);
    check(t.indexOf("OVERLAP-NOTE " + C1 + " 202606asiav1") !== -1,
      "control: the canonical-id overlap note for the assigned code reaches the status line (createAssignment -> overlapNotes)", t);
  });
  await run(async () => {
    const s = makeStore({ reject: (op, k) => k.indexOf(C2) !== -1 }); const d = build(s);
    d.els.afCodes = { selectedOptions: [{ value: C1 }, { value: C2 }] }; d.$("afTest").value = "202606asiav1"; d.$("afCat").value = "practice"; d.$("afTiming").value = "untimed";
    await d.fns.createAssignment();
    const t = status(d);
    const keys = [...s.server.keys()];
    check(keys.length === 1 && keys[0].indexOf("assign:" + C1) === 0 && ![...s.mirror.keys()].some(k => k.indexOf(C2) !== -1),
      "partial: the accepted code is on the server, the rejected code is nowhere");
    check(/Assigned 202606asiav1 to AS-ABCDEFGH/.test(t) && /Not saved — assignment a-\S+ for AS-JKLMNPQR/.test(t),
      "partial: message names the assigned code AND the rejected row (no blanket retry)", t);
    check(t.indexOf("OVERLAP-NOTE " + C1 + " ") !== -1 && t.indexOf("OVERLAP-NOTE " + C2 + " ") === -1,
      "partial: the overlap note is computed for the ASSIGNED code only, never for the rejected one", t);
  });
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afTest").value = "202606asiav1"; d.$("afCat").value = "practice"; d.$("afTiming").value = "untimed";
    d.$("afName").value = "Erin K";
    const before = s.snapshot();
    await d.fns.createAssignment();
    const t = status(d);
    check(s.snapshot() === before && Object.keys(mapBeforeReload(d)).length === 0 && d.state().loads.profilesAtReload.length > 0 && Object.keys(d.state().profiles).length === 0,
      "rejected with a name typed: no student: row in the mirror and the in-memory profiles map is unchanged (before AND after the reload)");
    check(/Not saved — the display name for AS-ABCDEFGH/.test(t) && /Not saved — assignment a-/.test(t),
      "rejected with a name typed: BOTH rejections are reported (the name used to be silent)", t);
  });

  await run(async () => {
    /* the vestigial assign:<CODE>:__none marker: tidied through the helper
       after the assignment lands; its own failure is reported, not counted */
    const s = makeStore({}); const d = build(s);
    s.seedBoth("assign:" + C1 + ":__none", { none: true }, C1);
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afTest").value = "202606asiav1"; d.$("afCat").value = "practice"; d.$("afTiming").value = "untimed";
    await d.fns.createAssignment();
    check(s.calls.some(c => c[0] === "adminDelete" && c[1] === "assign:" + C1 + ":__none") && !s.server.has("assign:" + C1 + ":__none") && !s.mirror.has("assign:" + C1 + ":__none"),
      "sentinel: an accepted assignment deletes the __none marker on the server, then the mirror");
  });
  await run(async () => {
    const s = makeStore({ reject: (op) => op === "delete" }); const d = build(s);
    s.seedBoth("assign:" + C1 + ":__none", { none: true }, C1);
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afTest").value = "202606asiav1"; d.$("afCat").value = "practice"; d.$("afTiming").value = "untimed";
    await d.fns.createAssignment();
    const t = status(d);
    check([...s.server.keys()].some(k => k.indexOf("assign:" + C1 + ":a-") === 0) && s.mirror.has("assign:" + C1 + ":__none") && s.server.has("assign:" + C1 + ":__none"),
      "sentinel: a rejected marker delete still leaves the assignment landed and the marker in place on both sides");
    check(/^Assigned 202606asiav1 to AS-ABCDEFGH/.test(t) && /Not deleted — the empty-assignments marker for AS-ABCDEFGH/.test(t),
      "sentinel: the message reports the assignment AND the marker that couldn't go", t);
  });

  /* =================== 2. saveNameOnly / saveProfiles =================== */
  console.log("--- 2. display names: set and clear ---");
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afName").value = "Erin K";
    const before = s.snapshot();
    await d.fns.saveNameOnly();
    const t = status(d);
    check(s.snapshot() === before && Object.keys(mapBeforeReload(d)).length === 0 && Object.keys(d.state().profiles).length === 0,
      "rejected name save: mirror unchanged, profiles map unchanged before AND after the reload (the dashboard does not render the name as saved)");
    check(/^Not saved — the display name for AS-ABCDEFGH: the tutor sign-in has expired/.test(t) && noSync(t), "rejected name save: message names the row", t);
  });
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    s.seedBoth("student:" + C1, { displayName: "Erin K" }, C1);
    d.seed({ profiles: { [C1]: "Erin K" } });
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afName").value = "";
    const before = s.snapshot();
    await d.fns.saveNameOnly();
    const t = status(d);
    check(s.snapshot() === before && s.server.has("student:" + C1) && mapBeforeReload(d)[C1] === "Erin K" && d.state().profiles[C1] === "Erin K",
      "rejected name CLEAR: the row stays in mirror and server, profiles map still has the name (before AND after the reload)");
    check(/^Not deleted — the display name for AS-ABCDEFGH/.test(t) && noSync(t), "rejected name clear: message names the row", t);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    s.seedBoth("student:" + C1, { displayName: "Erin K" }, C1); d.seed({ profiles: { [C1]: "Erin K" } });
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afName").value = "";
    await d.fns.saveNameOnly();
    check(!s.server.has("student:" + C1) && !s.mirror.has("student:" + C1) && !(C1 in mapBeforeReload(d)) && !(C1 in d.state().profiles) && /Name cleared for AS-ABCDEFGH/.test(status(d)),
      "control: an accepted clear removes server, mirror and the profiles entry");
  });

  /* =================== 3. toggleRelease =================== */
  console.log("--- 3. toggleRelease ---");
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    const rec = { attemptId: "attempt:202606asiav1:1:aa", status: "completed", released: false, student: { key: C1, code: C1 } };
    s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [JSON.parse(JSON.stringify(rec))] });
    const before = s.snapshot();
    await d.fns.toggleRelease(rec.attemptId);
    const t = status(d);
    check(s.snapshot() === before && s.mirror.get(rec.attemptId).released === false && d.state().recs[0].released === false,
      "rejected release: mirror record still unreleased, in-memory record reverted");
    check(/^Not saved — attempt attempt:202606asiav1:1:aa: the tutor sign-in has expired/.test(t) && noSync(t), "rejected release: message names the attempt", t);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    const rec = { attemptId: "attempt:202606asiav1:1:aa", status: "completed", released: false, student: { key: C1, code: C1 } };
    s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [JSON.parse(JSON.stringify(rec))] });
    await d.fns.toggleRelease(rec.attemptId);
    check(s.server.get(rec.attemptId).value.released === true && s.mirror.get(rec.attemptId).released === true && /^Released — /.test(status(d)),
      "control: an accepted release reaches the server and the mirror");
  });

  /* =================== 4. deleteAssignment / clearAssignments =================== */
  console.log("--- 4. deleteAssignment / clearAssignments ---");
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    s.seedBoth("assign:" + C1 + ":a-1", { assignmentId: "a-1", testId: "t" }, C1);
    s.seedBoth("assign:" + C1 + ":a-2", { assignmentId: "a-2", testId: "t" }, C1);
    const before = s.snapshot();
    await d.fns.deleteAssignment(C1, "a-1");
    const t = status(d);
    check(s.snapshot() === before && s.server.has("assign:" + C1 + ":a-1"), "rejected delete: the assignment row stays in mirror and server");
    check(/^Not deleted — assignment a-1 for AS-ABCDEFGH: the tutor sign-in has expired/.test(t) && noSync(t), "rejected delete: message names the row (used to be silent)", t);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    s.seedBoth("assign:" + C1 + ":a-1", { assignmentId: "a-1", testId: "t" }, C1);
    await d.fns.deleteAssignment(C1, "a-1");
    check(!s.server.has("assign:" + C1 + ":a-1") && !s.mirror.has("assign:" + C1 + ":a-1") && /^Deleted assignment a-1 for AS-ABCDEFGH\./.test(status(d)),
      "control: an accepted delete removes server then mirror");
  });
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    s.seedBoth("assign:" + C1 + ":a-1", { assignmentId: "a-1" }, C1);
    s.seedBoth("assign:" + C1 + ":a-2", { assignmentId: "a-2" }, C1);
    s.seedBoth("assign:" + C1, ["legacy"], C1);
    const before = s.snapshot();
    await d.fns.clearAssignments(C1);
    const t = status(d);
    check(s.snapshot() === before && s.server.size === 3, "rejected clear: every row stays in mirror and server");
    check(/Not deleted — assignment a-1 for AS-ABCDEFGH/.test(t) && /Not deleted — assignment a-2 for AS-ABCDEFGH/.test(t) && /Not deleted — the legacy assignment list for AS-ABCDEFGH/.test(t) && !/Cleared every/.test(t) && noSync(t),
      "rejected clear: message names every row that is still there and never claims success", t);
  });
  await run(async () => {
    const s = makeStore({ reject: (op, k) => k === "assign:" + C1 + ":a-2" }); const d = build(s);
    s.seedBoth("assign:" + C1 + ":a-1", { assignmentId: "a-1" }, C1);
    s.seedBoth("assign:" + C1 + ":a-2", { assignmentId: "a-2" }, C1);
    await d.fns.clearAssignments(C1);
    const t = status(d);
    check(!s.server.has("assign:" + C1 + ":a-1") && s.server.has("assign:" + C1 + ":a-2") && s.mirror.has("assign:" + C1 + ":a-2") && !s.mirror.has("assign:" + C1 + ":a-1"),
      "partial clear: the accepted row is gone from both, the rejected row stays in both");
    check(/^Cleared 1 of 2 assignment row\(s\) for AS-ABCDEFGH\. Not deleted — assignment a-2/.test(t), "partial clear: message counts honestly and names the surviving row", t);
  });

  /* =================== 5. deleteSet =================== */
  console.log("--- 5. deleteSet ---");
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    s.seedBoth("pset:pset-1", { setId: "pset-1", name: "Set A", subject: "math", refs: [] });
    d.seed({ sets: [{ setId: "pset-1", name: "Set A", subject: "math", refs: [] }], assigns: [] });
    const before = s.snapshot();
    await d.fns.deleteSet("pset-1");
    const m = d.state().setsMsg; everyMessage.push(m);
    check(s.snapshot() === before && s.server.has("pset:pset-1"), "rejected set delete: the set stays in mirror and server");
    check(/^Not deleted — set pset-1: the tutor sign-in has expired/.test(m) && !/Deleted/.test(m) && noSync(m), "rejected set delete: message names the set and never says Deleted (used to)", m);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    s.seedBoth("pset:pset-1", { setId: "pset-1", name: "Set A" }); d.seed({ sets: [{ setId: "pset-1", name: "Set A" }], assigns: [] });
    await d.fns.deleteSet("pset-1");
    check(!s.server.has("pset:pset-1") && !s.mirror.has("pset:pset-1") && /^Deleted “Set A”\./.test(d.state().setsMsg), "control: an accepted set delete removes server then mirror");
  });

  /* =================== 6. deleteArchived =================== */
  console.log("--- 6. deleteArchived: reaches the server; stays armed for what is still there ---");
  const archRec = (n) => ({ attemptId: "attempt:202606asiav1:" + (1700000000 + n) + ":a" + n, status: "completed", student: { key: C1, code: C1 } });
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    const r1 = archRec(1), r2 = archRec(2);
    s.seedBoth(r1.attemptId, r1, C1); s.seedBoth(r2.attemptId, r2, C1);
    d.seed({ recs: [r1, r2], lastExport: { ids: [r1.attemptId, r2.attemptId], when: new Date(0) } });
    const before = s.snapshot();
    await d.fns.deleteArchived();
    const t = status(d);
    check(s.snapshot() === before && s.server.has(r1.attemptId) && s.server.has(r2.attemptId), "rejected archive delete: both records stay in mirror and server");
    const le = d.state().lastExport;
    check(!!le && le.ids.length === 2 && d.$("dashDeleteBtn").disabled === false, "rejected archive delete: stays armed for exactly the two surviving rows");
    check(/^Deleted 0 of 2 archived record\(s\)\. 2 NOT deleted — still in storage\. Not deleted — attempt attempt:202606asiav1:1700000001:a1/.test(t) && noSync(t),
      "rejected archive delete: message counts and names the rows", t);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    const r1 = archRec(1), r2 = archRec(2);
    s.seedBoth(r1.attemptId, r1, C1); s.seedBoth(r2.attemptId, r2, C1);
    d.seed({ recs: [r1, r2], lastExport: { ids: [r1.attemptId, r2.attemptId], when: new Date(0) } });
    await d.fns.deleteArchived();
    check(s.calls.filter(c => c[0] === "adminDelete").map(c => c[1]).sort().join() === [r1.attemptId, r2.attemptId].sort().join(),
      "ARCHIVE DELETE REACHES THE SERVER: one adminDelete per archived record (used to be mirror-only)");
    check(!s.server.has(r1.attemptId) && !s.server.has(r2.attemptId) && !s.mirror.has(r1.attemptId) && !s.mirror.has(r2.attemptId)
      && d.state().lastExport === null && d.$("dashDeleteBtn").disabled === true && /^Deleted 2 of 2 archived record\(s\)\./.test(status(d)),
      "accepted archive delete: gone from server and mirror, disarmed, reported");
  });
  await run(async () => {
    const s = makeStore({ reject: (op, k) => k.slice(-2) === "a2" }); const d = build(s);
    const r1 = archRec(1), r2 = archRec(2);
    s.seedBoth(r1.attemptId, r1, C1); s.seedBoth(r2.attemptId, r2, C1);
    d.seed({ recs: [r1, r2], lastExport: { ids: [r1.attemptId, r2.attemptId], when: new Date(0) } });
    await d.fns.deleteArchived();
    const le = d.state().lastExport;
    check(!s.server.has(r1.attemptId) && s.server.has(r2.attemptId) && s.mirror.has(r2.attemptId) && !!le && le.ids.join() === r2.attemptId,
      "partial archive delete: re-armed for exactly the row that is still there");
  });

  await run(async () => {
    /* an in-progress sitting must never be deleted by the archive button —
       exportAll doesn't arm it, and deleteArchived skips it even if armed */
    const s = makeStore({}); const d = build(s);
    const done = archRec(1), live = Object.assign(archRec(2), { status: "in-progress" });
    s.seedBoth(done.attemptId, done, C1); s.seedBoth(live.attemptId, live, C1);
    d.seed({ recs: [done, live], lastExport: { ids: [done.attemptId, live.attemptId], when: new Date(0) } });
    await d.fns.deleteArchived();
    const t = status(d);
    check(!s.calls.some(c => c[0] === "adminDelete" && c[1] === live.attemptId) && s.server.has(live.attemptId) && s.mirror.has(live.attemptId),
      "an in-progress sitting armed by a stale export is SKIPPED — never sent to adminDelete, still on both sides");
    check(!s.server.has(done.attemptId) && /^Deleted 1 of 2 archived record\(s\)\. 1 skipped — not a finished attempt any more/.test(t),
      "the finished one is deleted and the skip is reported", t);
  });
  await run(async () => {
    /* exportAll itself, driven: arms the delete with FINISHED attempts only */
    const s = makeStore({}); const d = build(s);
    const done = archRec(1), live = Object.assign(archRec(2), { status: "in-progress" });
    d.seed({ recs: [done, live], source: "storage" });
    d.fns.exportAll();
    const le = d.state().lastExport, t = status(d);
    check(!!le && JSON.stringify(le.ids) === JSON.stringify([done.attemptId]) && d.$("dashDeleteBtn").disabled === false,
      "exportAll arms exactly the finished attempt, not the in-progress sitting", JSON.stringify(le && le.ids));
    check(/^Archive downloaded \(2 attempts\)\. Verify the file opened correctly, then “Delete archived attempts” removes exactly the 1 finished attempt\(s\) from storage\. 1 in-progress sitting\(s\) are in the file but stay in storage\.$/.test(t),
      "exportAll says how many live sittings are in the file but stay", t);
    const d2 = build(makeStore({}));
    d2.seed({ recs: [Object.assign(archRec(3), { status: "in-progress" })], source: "storage" });
    d2.fns.exportAll();
    check(d2.state().lastExport === null && d2.$("dashDeleteBtn").disabled === true && /^Archive downloaded \(1 attempts\)\. Nothing to delete — 1 in-progress sitting\(s\) are in the file but stay in storage\.$/.test(status(d2)),
      "exportAll with only live sittings arms nothing and leaves the button disabled", status(d2));
  });
  await run(async () => {
    /* an armed id that is not currently listed is never sent to the server,
       never reported as skipped-unfinished, and never claimed gone */
    const s = makeStore({}); const d = build(s);
    const a = archRec(1), b = archRec(2);
    s.seedBoth(a.attemptId, a, C1); s.seedBoth(b.attemptId, b, C1);   // b is in storage but not in recs (excluded on load)
    d.seed({ recs: [a], lastExport: { ids: [a.attemptId, b.attemptId], when: new Date(0) } });
    await d.fns.deleteArchived();
    const t = status(d);
    check(!s.calls.some(c => c[0] === "adminDelete" && c[1] === b.attemptId) && s.server.has(b.attemptId) && !s.server.has(a.attemptId)
      && !/skipped/.test(t) && !/already removed/.test(t) && /1 not listed right now — left in storage/.test(t),
      "a not-listed id is neither deleted, nor reported as skipped-unfinished, nor claimed gone", t);
    /* deleteAttempt (a TOMBSTONE since 2026-09-18) leaves the record in
       storage, so the armed archive delete still covers it: the exported
       file holds the record AND its marker, and rotating the row away later
       is the archive flow's business, unchanged */
    const s2 = makeStore({}); const d2 = build(s2);
    const c = archRec(3), e = archRec(4);
    s2.seedBoth(c.attemptId, c, C1); s2.seedBoth(e.attemptId, e, C1);
    d2.seed({ recs: [c, e], lastExport: { ids: [c.attemptId, e.attemptId], when: new Date(0) } });
    await d2.fns.deleteAttempt(c);
    const le = d2.state().lastExport;
    check(!!le && le.ids.slice().sort().join() === [c.attemptId, e.attemptId].sort().join() && d2.$("dashDeleteBtn").disabled === false
      && s2.server.has(c.attemptId) && s2.server.has("tomb:" + c.attemptId),
      "tombstoning an attempt from the detail pane leaves the archive delete armed for it (the record is still there, marked)", JSON.stringify(le && le.ids));
  });
  await run(async () => {
    /* the realistic sequence: tombstone, then the export-gated archive
       delete removes the finished rows — the marker row is NEVER touched */
    const s = makeStore({}); const d = build(s);
    const c = archRec(5), e = archRec(6);
    s.seedBoth(c.attemptId, c, C1); s.seedBoth(e.attemptId, e, C1);
    d.seed({ recs: [c, e], lastExport: { ids: [c.attemptId, e.attemptId], when: new Date(0) } });
    await d.fns.deleteAttempt(c);
    await d.fns.deleteArchived();
    check(!s.server.has(c.attemptId) && !s.server.has(e.attemptId) && s.server.has("tomb:" + c.attemptId) && s.mirror.has("tomb:" + c.attemptId)
      && !s.calls.some(x => x[0] === "adminDelete" && x[1].indexOf("tomb:") === 0)
      && d.state().lastExport === null && /^Deleted 2 of 2 archived record\(s\)\./.test(status(d)),
      "deleteAttempt then deleteArchived: both finished rows go, the deletion marker stays on both sides and is never sent to adminDelete", status(d));
    let reject = true;
    const s2 = makeStore({ reject: () => reject }); const d2 = build(s2);
    const f = archRec(7);
    s2.seedBoth(f.attemptId, f, C1);
    d2.seed({ recs: [f], lastExport: { ids: [f.attemptId], when: new Date(0) } });
    await d2.fns.deleteArchived();                             // rejected → re-armed
    reject = false;
    await d2.fns.deleteArchived();                             // signed in again → retry
    check(!s2.server.has(f.attemptId) && d2.state().lastExport === null && /^Deleted 1 of 1 archived record\(s\)\./.test(status(d2)),
      "rejected then retried: the re-armed export deletes on the second attempt", status(d2));
  });
  await run(async () => {
    /* armed ids that are not currently listed (a failed load, an excluded
       row) are left in storage, stay armed, and are never claimed gone */
    const s = makeStore({}); const d = build(s);
    const a = archRec(8);
    s.seedBoth(a.attemptId, a, C1);
    d.seed({ recs: [], lastExport: { ids: [a.attemptId], when: new Date(0) } });
    const before = s.snapshot();
    await d.fns.deleteArchived();
    const t = status(d);
    check(s.snapshot() === before && s.server.has(a.attemptId) && !!d.state().lastExport && d.state().lastExport.ids.join() === a.attemptId && d.$("dashDeleteBtn").disabled === false,
      "nothing listed: nothing deleted, still armed, button still enabled");
    check(/^Nothing to delete right now — none of the 1 archived record\(s\) are listed\. Press Refresh/.test(t) && !/already removed/.test(t), "nothing listed: the message says so and never claims the rows are gone", t);
    const s2 = makeStore({}); const d2 = build(s2);
    const b = archRec(9), c = archRec(10);
    s2.seedBoth(b.attemptId, b, C1); s2.seedBoth(c.attemptId, c, C1);
    d2.seed({ recs: [b], lastExport: { ids: [b.attemptId, c.attemptId], when: new Date(0) } });
    await d2.fns.deleteArchived();
    const t2 = status(d2);
    check(!s2.server.has(b.attemptId) && s2.server.has(c.attemptId) && d2.state().lastExport.ids.join() === c.attemptId && /^Deleted 1 of 1 archived record\(s\)\. 1 not listed right now — left in storage \(press Refresh\)\./.test(t2),
      "one listed, one not: the listed one goes, the other stays armed and is reported as not listed", t2);
  });
  await run(async () => {
    /* server accepted, mirror couldn't be written: the warning must reach the
       status line even though nothing was rejected */
    const s = makeStore({ localFail: true }); const d = build(s);
    const r1 = archRec(1);
    s.seedBoth(r1.attemptId, r1, C1);
    d.seed({ recs: [r1], lastExport: { ids: [r1.attemptId], when: new Date(0) } });
    await d.fns.deleteArchived();
    const t = status(d);
    check(!s.server.has(r1.attemptId) && s.mirror.has(r1.attemptId) && /Deleted on the server, but this browser's copy of attempt attempt:202606asiav1:1700000001:a1 couldn't be removed — press Refresh\./.test(t),
      "archive delete: a mirror-write warning is shown even with zero rejections", t);
  });
  await run(async () => {
    /* mixed reasons: a 401 and a timeout must both be named, no 'same reason' */
    let n = 0;
    const s = makeStore({ reject: () => true }); const d = build(s);
    const rs = [1, 2, 3, 4, 5].map(archRec);
    rs.forEach(r => s.seedBoth(r.attemptId, r, C1));
    s.AS.adminDelete = async (k) => { n++; const e = n === 1 ? Object.assign(new Error("aborted"), { name: "AbortError" }) : Object.assign(new Error("JWT expired"), { status: 401 }); s.ops.push(["admin", k, "rejected"]); throw e; };
    d.seed({ recs: rs, lastExport: { ids: rs.map(r => r.attemptId), when: new Date(0) } });
    await d.fns.deleteArchived();
    const t = status(d);
    check(/didn't answer in time/.test(t) && /sign-in has expired/.test(t) && !/same reason/.test(t) && /\(\+2 more\.\)/.test(t),
      "archive delete with mixed reasons: both reasons appear, the overflow count never claims 'same reason'", t);
  });

  /* =================== 7. dismissBug =================== */
  console.log("--- 7. dismissBug: a real server delete ---");
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    s.seedBoth("bug:" + C1 + ":1", { studentCode: C1, text: "x" }, C1);
    const before = s.snapshot();
    await d.fns.dismissBug("bug:" + C1 + ":1");
    const t = status(d);
    check(s.snapshot() === before && s.server.has("bug:" + C1 + ":1"), "rejected dismiss: the bug row stays in mirror and server");
    check(/^Not deleted — bug report bug:AS-ABCDEFGH:1: the tutor sign-in has expired/.test(t) && noSync(t), "rejected dismiss: message names the row", t);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    s.seedBoth("bug:" + C1 + ":1", { studentCode: C1 }, C1);
    await d.fns.dismissBug("bug:" + C1 + ":1");
    check(s.calls.some(c => c[0] === "adminDelete" && c[1] === "bug:" + C1 + ":1") && !s.server.has("bug:" + C1 + ":1") && !s.mirror.has("bug:" + C1 + ":1"),
      "BUG DISMISS REACHES THE SERVER (used to be mirror-only)");
  });

  /* =================== 8. deleteAttempt / deleteStudent — TOMBSTONES (2026-09-18) =================== */
  console.log("--- 8. deleteAttempt / deleteStudent: a marker row, never an edit, never a delete ---");
  const REC = () => ({ attemptId: "attempt:202606asiav1:1:aa", status: "completed", assignmentId: "a-1", testId: "202606asiav1",
    conditions: "proctored", startedAt: "2026-09-01T00:00:00Z", submittedAt: "2026-09-01T02:00:00Z",
    student: { key: C1, code: C1 }, answers: { q1: { given: 2 } }, score: { correct: 1, graded: 1 } });
  const rowJson = (s, k) => JSON.stringify(s.server.has(k) ? s.server.get(k).value : null) + "|" + JSON.stringify(s.mirror.has(k) ? s.mirror.get(k) : null);
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    const rec = REC();
    s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [rec] });
    const before = s.snapshot();
    const r = await d.fns.deleteAttempt(rec);
    const t = status(d);
    check(r.ok === false && s.snapshot() === before && s.server.has(rec.attemptId) && !s.server.has("tomb:" + rec.attemptId)
      && !s.mirror.has("tomb:" + rec.attemptId) && d.state().recs.length === 1 && Object.keys(d.state().tombs).length === 0,
      "rejected tombstone: no marker on server or mirror, the record and the table row untouched");
    check(/^Not deleted — the deletion marker for attempt attempt:202606asiav1:1:aa: the tutor sign-in has expired/.test(t) && noSync(t),
      "rejected tombstone: message is 'Not deleted', names the marker row, never says sync", t);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    const rec = REC();
    s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [rec] });
    const recBefore = rowJson(s, rec.attemptId);
    const r = await d.fns.deleteAttempt(rec);
    const t = status(d);
    const tk = "tomb:" + rec.attemptId;
    const tv = s.server.has(tk) ? s.server.get(tk).value : null;
    check(r.ok === true && !!tv && tv.kind === "tombstone" && tv.target === rec.attemptId && tv.reason === "attempt"
      && tv.assignmentId === "a-1" && tv.status === "completed" && !("answers" in tv) && !("score" in tv),
      "accepted: the marker lands on the server with the identity summary and no answers/score", JSON.stringify(tv));
    check(JSON.stringify(s.mirror.get(tk)) === JSON.stringify(tv) && d.state().tombs[tk] && d.state().tombs[tk].target === rec.attemptId,
      "accepted: the mirror and the dashboard's tomb map carry exactly the server's marker");
    check(rowJson(s, rec.attemptId) === recBefore && d.state().recs.length === 1,
      "IMMUTABLE: the attempt row is byte-identical on server and mirror, and stays listed (present-but-marked)");
    check(!s.calls.some(c => c[0] === "adminDelete") && !s.calls.some(c => c[0] === "adminUpsert"),
      "accepted: no adminDelete and no adminUpsert — the only server verb was the tombstone RPC");
    const o = s.calls.map(c => c[0]);
    check(o.indexOf("adminRpc") !== -1 && o.indexOf("adminRpc") < o.indexOf("setLocal"), "accepted: server FIRST, then the mirror", o.join(","));
    check(/^Marked the attempt for AS-ABCDEFGH deleted/.test(t) && !/Deleted the attempt/.test(t) && noSync(t),
      "accepted: the message says MARKED, never claims the record is gone", t);
  });
  await run(async () => {
    /* idempotent: a second delete of the same attempt is refused on the
       client (already marked) and never reaches the server; the original
       marker's who/when stands */
    const s = makeStore({}); const d = build(s);
    const rec = REC();
    s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [rec] });
    await d.fns.deleteAttempt(rec);
    const first = JSON.stringify(s.server.get("tomb:" + rec.attemptId).value);
    const n = s.calls.filter(c => c[0] === "adminRpc").length;
    const r2 = await d.fns.deleteAttempt(rec);
    check(r2.ok === false && s.calls.filter(c => c[0] === "adminRpc").length === n && JSON.stringify(s.server.get("tomb:" + rec.attemptId).value) === first,
      "already marked: refused on the client, no second server call, the original marker untouched");
  });
  await run(async () => {
    /* 2026-09-21: an IN-PROGRESS sitting is markable — that is the case the
       tutor needs (a stale sitting blocking a testVersion bump). The marker
       carries status "in-progress", which is what leaves the assignment
       startable; the record itself is untouched, as always. */
    const s = makeStore({}); const d = build(s);
    const live = Object.assign(REC(), { status: "in-progress", submittedAt: null, attemptId: "attempt:202606asiav1:9:live" });
    s.seedBoth(live.attemptId, live, C1); d.seed({ recs: [live] });
    const recBefore = rowJson(s, live.attemptId);
    const r = await d.fns.deleteAttempt(live);
    const tk = "tomb:" + live.attemptId;
    const tv = s.server.has(tk) ? s.server.get(tk).value : null;
    check(r.ok === true && !!tv && tv.status === "in-progress" && tv.reason === "attempt" && tv.assignmentId === "a-1",
      "an in-progress sitting IS marked, and the marker reports status in-progress", JSON.stringify(tv));
    /* an UNTAGGED in-progress sitting records no assignmentsAtDeletion — it
       closed nothing, so the list would be a claim with nothing behind it */
    const sU = makeStore({}); const dU = build(sU);
    const untag = Object.assign(REC(), { status: "in-progress", submittedAt: null, assignmentId: null, attemptId: "attempt:202606asiav1:6:unt" });
    sU.seedBoth("assign:" + C1 + ":a-1", { assignmentId: "a-1", testId: untag.testId }, C1);
    sU.seedBoth(untag.attemptId, untag, C1); dU.seed({ recs: [untag] });
    await dU.fns.deleteAttempt(untag);
    const tvU = sU.server.get("tomb:" + untag.attemptId).value;
    check(JSON.stringify(tvU.assignmentsAtDeletion) === "[]", "an untagged IN-PROGRESS marker carries an empty assignmentsAtDeletion", JSON.stringify(tvU.assignmentsAtDeletion));
    const sF = makeStore({}); const dF = build(sF);
    const untagDone = Object.assign(REC(), { assignmentId: null, attemptId: "attempt:202606asiav1:6:und" });
    sF.seedBoth("assign:" + C1 + ":a-1", { assignmentId: "a-1", testId: untagDone.testId }, C1);
    sF.seedBoth(untagDone.attemptId, untagDone, C1); dF.seed({ recs: [untagDone] });
    await dF.fns.deleteAttempt(untagDone);
    check(JSON.stringify(sF.server.get("tomb:" + untagDone.attemptId).value.assignmentsAtDeletion) === '["a-1"]',
      "control: the same record FINISHED records the assignment it may keep closed");
    check(rowJson(s, live.attemptId) === recBefore && d.state().recs.length === 1,
      "IMMUTABLE: the partial record is byte-identical on server and mirror, and stays listed");
    check(JSON.stringify(s.mirror.get(tk)) === JSON.stringify(tv) && !s.calls.some(c => c[0] === "adminDelete" || c[0] === "adminUpsert"),
      "the marker is mirrored and no row was deleted or upserted");
    const t = status(d);
    check(/^Marked the attempt for AS-ABCDEFGH deleted/.test(t)
      && /It was IN PROGRESS: it can no longer be resumed, and their device ends the sitting as soon as it sees the marker\. Its assignment is startable again\./.test(t)
      && !/Note: this browser showed it as/.test(t) && noSync(t),
      "the status line says what an in-progress deletion means, from the MARKER, without the word 'sync' (nothing syncs a tutor write)", t);
    /* the same line, derived from the marker rather than this browser's copy:
       an untagged sitting must not be told its assignment reopened */
    const sUn = makeStore({}); const dUn = build(sUn);
    const untagged = Object.assign(REC(), { status: "in-progress", submittedAt: null, assignmentId: null, attemptId: "attempt:202606asiav1:8:unt" });
    sUn.seedBoth(untagged.attemptId, untagged, C1); dUn.seed({ recs: [untagged] });
    await dUn.fns.deleteAttempt(untagged);
    const tUn = status(dUn);
    check(/It wasn't tied to an assignment; if it was standing in for one, that assignment is startable again\./.test(tUn) && !/Its assignment is startable again/.test(tUn),
      "an untagged in-progress deletion never names an assignment it does not have", tUn);
    /* and when the sitting was submitted between the last Refresh and the
       delete, the line reports the SERVER's status and says so */
    const sRace = makeStore({}); const dRace = build(sRace);
    const stale = Object.assign(REC(), { status: "in-progress", submittedAt: null, attemptId: "attempt:202606asiav1:7:race" });
    sRace.seedBoth(stale.attemptId, Object.assign({}, stale, { status: "completed" }), C1);   // the server has moved on
    dRace.seed({ recs: [stale] });                                                            // this browser has not
    await dRace.fns.deleteAttempt(stale);
    const tRace = status(dRace);
    check(!/It was IN PROGRESS/.test(tRace) && /Note: this browser showed it as in-progress, but the server recorded it as completed/.test(tRace),
      "a sitting submitted since the last Refresh is reported from the marker, and the disagreement is said out loud", tRace);
    /* and a second one is refused on the client, like any marked record */
    const n = s.calls.filter(c => c[0] === "adminRpc").length;
    const r2 = await d.fns.deleteAttempt(live);
    check(r2.ok === false && s.calls.filter(c => c[0] === "adminRpc").length === n, "already marked: the second in-progress delete never reaches the server");
  });
  await run(async () => {
    /* deleteStudent rejected: nothing anywhere */
    const s = makeStore({ reject: true }); const d = build(s);
    const rec = REC();
    s.seedBoth(rec.attemptId, rec, C1); s.seedBoth("student:" + C1, { displayName: "Erin K" }, C1);
    d.seed({ recs: [rec], profiles: { [C1]: "Erin K" } });
    const before = s.snapshot();
    const r = await d.fns.deleteStudent(C1);
    const t = status(d);
    check(r.ok === false && s.snapshot() === before && s.server.size === 2 && Object.keys(d.state().tombs).length === 0 && d.state().loads.storage === 0,
      "rejected student delete: no marker anywhere, nothing reloaded, the profile and the record untouched");
    check(/^Not deleted — the deletion marker for student AS-ABCDEFGH: the tutor sign-in has expired/.test(t) && noSync(t),
      "rejected student delete: message names the student marker", t);
  });
  await run(async () => {
    /* deleteStudent accepted: one marker per attempt (in-progress included)
       then the student marker, server first; every record and the profile
       row byte-identical; the dashboard reloads */
    const s = makeStore({}); const d = build(s);
    const done = REC(), live = Object.assign(REC(), { attemptId: "attempt:202606asiav1:2:bb", status: "in-progress", assignmentId: "a-2" });
    s.seedBoth(done.attemptId, done, C1); s.seedBoth(live.attemptId, live, C1); s.seedBoth("student:" + C1, { displayName: "Erin K" }, C1);
    d.seed({ recs: [done, live], profiles: { [C1]: "Erin K" } });
    const doneBefore = rowJson(s, done.attemptId), liveBefore = rowJson(s, live.attemptId), profBefore = rowJson(s, "student:" + C1);
    const r = await d.fns.deleteStudent(C1);
    const t = status(d);
    const sk = "tomb:student:" + C1;
    check(r.ok === true && s.server.has(sk) && s.mirror.has(sk) && s.server.get(sk).value.attemptsTombstoned === 2 && s.server.get(sk).value.hadProfile === true
      && !("displayName" in s.server.get(sk).value),
      "accepted student delete: the student marker is on server and mirror, counts both attempts, carries NO display name");
    check(s.server.has("tomb:" + done.attemptId) && s.server.has("tomb:" + live.attemptId) && s.mirror.has("tomb:" + live.attemptId)
      && s.server.get("tomb:" + live.attemptId).value.reason === "student" && s.server.get("tomb:" + live.attemptId).value.status === "in-progress",
      "accepted student delete: every attempt gets a marker, the in-progress one included, reason 'student'");
    check(rowJson(s, done.attemptId) === doneBefore && rowJson(s, live.attemptId) === liveBefore && rowJson(s, "student:" + C1) === profBefore,
      "IMMUTABLE: both attempt rows and the profile row are byte-identical on server and mirror");
    check(!s.calls.some(c => c[0] === "adminDelete") && !s.calls.some(c => c[0] === "adminUpsert"), "accepted student delete: no adminDelete, no adminUpsert");
    const o = s.calls.map(c => c[0]);
    check(o.indexOf("adminRpc") < o.indexOf("setLocal") && d.state().loads.storage === 1, "accepted student delete: server first, mirror after, then one reload");
    check(/^Deleted student Erin K \(AS-ABCDEFGH\) — the code is retired and can't sign in; 2 attempt\(s\) marked deleted/.test(t) && noSync(t),
      "accepted student delete: message names the student, the retirement, and the count", t);
  });
  await run(async () => {
    /* a mirror-only attempt (never synced) cannot be marked by the server:
       counted and named, never silently left as live */
    const s = makeStore({}); const d = build(s);
    const synced = REC(), local = Object.assign(REC(), { attemptId: "attempt:202606asiav1:3:cc" });
    s.seedBoth(synced.attemptId, synced, C1); s.mirror.set(local.attemptId, JSON.parse(JSON.stringify(local)));
    d.seed({ recs: [synced, local] });
    const r = await d.fns.deleteStudent(C1);
    const t = status(d);
    check(r.ok === true && r.unmarked.join() === local.attemptId && !s.server.has("tomb:" + local.attemptId) && !s.mirror.has("tomb:" + local.attemptId)
      && /1 attempt\(s\) listed here were NOT marked on the server — it has no copy of them \(never uploaded from the device that recorded them, or archived away\); here they read deleted only by the student marker, and the server will refuse them if they ever arrive\./.test(t),
      "a never-synced attempt is reported as NOT marked (no marker is invented for a row the server never had)", t);
  });
  await run(async () => {
    /* server accepted, mirror can't be written: ok with the warning */
    const s = makeStore({ localFail: true }); const d = build(s);
    const rec = REC();
    s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [rec] });
    const r = await d.fns.deleteAttempt(rec);
    check(r.ok === true && s.server.has("tomb:" + rec.attemptId) && !s.mirror.has("tomb:" + rec.attemptId) && /1 marker\(s\) couldn't be written to this browser's copy/.test(status(d)),
      "server accepted but the mirror failed: ok with a warning naming the miss", status(d));
  });
  await run(async () => {
    /* local / artifact mode: the same rows are written here, with the local
       identity, no server call, and the record stays untouched */
    const s = makeStore({ remote: false }); const d = build(s);
    const rec = REC();
    s.mirror.set(rec.attemptId, JSON.parse(JSON.stringify(rec))); d.seed({ recs: [rec] });
    const before = JSON.stringify(s.mirror.get(rec.attemptId));
    const r = await d.fns.deleteAttempt(rec);
    const tv = s.mirror.get("tomb:" + rec.attemptId);
    check(r.ok === true && !!tv && tv.kind === "tombstone" && tv.target === rec.attemptId && tv.deletedBy === "acestem-admin (local)" && tv.assignmentId === "a-1"
      && !s.calls.some(c => /^admin/.test(c[0])) && JSON.stringify(s.mirror.get(rec.attemptId)) === before && s.mirror.has(rec.attemptId),
      "local mode: a marker with the local identity, no server call, the record untouched and still present", JSON.stringify(tv));
    /* the student delete in local mode: attempt markers first (the one
       written above is REUSED byte-for-byte, never overwritten), then the
       student marker with the local identity; no server call; the record
       and its profile untouched */
    const firstMarker = JSON.stringify(tv);
    s.mirror.set("student:" + C1, { displayName: "Erin K" }); d.seed({ profiles: { [C1]: "Erin K" } });
    const profBefore = JSON.stringify(s.mirror.get("student:" + C1));
    const r2 = await d.fns.deleteStudent(C1);
    const st = s.mirror.get("tomb:student:" + C1);
    check(r2.ok === true && !!st && st.kind === "tombstone" && st.targetKind === "student" && st.target === C1
      && st.deletedBy === "acestem-admin (local)" && st.attemptsTombstoned === 1 && st.hadProfile === true && !("displayName" in st),
      "local mode: the student marker lands in the mirror with the local identity, the count and hadProfile, no name", JSON.stringify(st));
    check(JSON.stringify(s.mirror.get("tomb:" + rec.attemptId)) === firstMarker && JSON.stringify(s.mirror.get(rec.attemptId)) === before
      && JSON.stringify(s.mirror.get("student:" + C1)) === profBefore && !s.calls.some(c => /^admin/.test(c[0])),
      "local mode: the earlier attempt marker is reused unchanged, the record and profile rows are untouched, no server call");
    const r3 = await d.fns.deleteStudent(C1);
    check(r3.ok === false && /^Not deleted — AS-ABCDEFGH was already deleted\./.test(r3.message),
      "local mode: a second delete of the same student is refused with a reason", r3.message);
  });
  await run(async () => {
    /* local mode, partial failure: the mirror stops taking writes after the
       first marker — the message counts what landed and never claims the
       student is gone; the student marker is absent */
    let writes = 0;
    const s = makeStore({ remote: false }); const d = build(s);
    const a = REC(), b = Object.assign(REC(), { attemptId: "attempt:202606asiav1:2:bb" });
    s.mirror.set(a.attemptId, JSON.parse(JSON.stringify(a))); s.mirror.set(b.attemptId, JSON.parse(JSON.stringify(b)));
    d.seed({ recs: [a, b] });
    const realSetLocal = s.AS.setLocal;
    s.AS.setLocal = async (k, v) => { if(++writes > 1) return false; return realSetLocal(k, v); };
    const r = await d.fns.deleteStudent(C1);
    check(r.ok === false && /^Not deleted — the deletion marker for attempt attempt:202606asiav1:2:bb: storage isn't writable in this browser\. 1 attempt marker\(s\) were written before it failed/.test(r.message)
      && !s.mirror.has("tomb:student:" + C1) && s.mirror.has("tomb:" + a.attemptId),
      "local mode, mirror fails mid-way: refused, counts the markers that landed, the student marker is NOT written", r.message);
  });
  await run(async () => {
    /* a retired code is refused by every form that would create or rename
       for it, before any write; and the upload button never sends its rows.
       The REAL loadFromStorage runs here (realLoad): the upload ends with a
       reload whose own status line used to REPLACE the upload summary, so
       the counting stub would have hidden exactly that */
    const s = makeStore({}); const d = build(s, null, null, { realLoad: true });
    const stTomb = { kind: "tombstone", targetKind: "student", target: C2, code: C2, deletedAt: "2026-09-18T00:00:00Z", deletedBy: "tutor@test", attemptsTombstoned: 0, hadProfile: false };
    d.seed({ tombs: { ["tomb:student:" + C2]: stTomb } });
    d.els.afCodes = { selectedOptions: [{ value: C2 }] }; d.$("afFree").value = ""; d.$("afTest").value = "202606asiav1"; d.$("afCat").value = "practice"; d.$("afTiming").value = "1";
    const before = s.snapshot();
    await d.fns.createAssignment();
    check(s.snapshot() === before && s.server.size === 0 && /^Deleted — a retired code can't be assigned to: AS-JKLMNPQR$/.test(d.$("afMsg").textContent),
      "createAssignment refuses a retired code before any write", d.$("afMsg").textContent);
    d.$("afName").value = "New Name";
    await d.fns.saveNameOnly();
    check(s.snapshot() === before && s.server.size === 0 && /^Deleted — a retired code can't be renamed: AS-JKLMNPQR$/.test(d.$("afMsg").textContent),
      "saveNameOnly refuses a retired code before any write", d.$("afMsg").textContent);
    d.seed({ sets: [{ setId: "pset-1", name: "Set A", subject: "math", refs: [{ type: "bank", bankId: "bank-david-core", qid: "q0001" }] }], assigns: [] });
    d.$("saSet").value = "pset-1"; d.els.saCodes = { selectedOptions: [{ value: C2 }] }; d.$("saFree").value = "";
    await d.fns.assignSetFromForm();
    check(s.snapshot() === before && s.server.size === 0 && /^Deleted — a retired code can't be assigned to: AS-JKLMNPQR$/.test(d.$("saMsg").textContent),
      "assignSetFromForm refuses a retired code before any write", d.$("saMsg").textContent);
    /* the upload button: C2's rows stay on the device, C1's go up, tomb rows never go up */
    s.mirror.set("attempt:202606asiav1:1:aa", { attemptId: "attempt:202606asiav1:1:aa", student: { key: C2, code: C2 } });
    s.mirror.set("student:" + C2, { displayName: "Gone" });
    s.mirror.set("assign:" + C2 + ":a-1", { assignmentId: "a-1" });
    s.mirror.set("attempt:202606asiav1:2:bb", { attemptId: "attempt:202606asiav1:2:bb", student: { key: C1, code: C1 } });
    s.mirror.set("tomb:student:" + C2, stTomb);
    await d.fns.migrateLocalToServer();
    const t = status(d);
    const sent = s.calls.filter(c => c[0] === "adminUpsert").map(c => c[1]);
    check(sent.join() === "attempt:202606asiav1:2:bb" && !sent.some(k => k.indexOf(C2) !== -1 || k.indexOf("tomb:") === 0)
      && /^Upload finished — 1 sent, 0 already on the server, 3 belonging to deleted student\(s\) or marked deleted not sent\. \d+ attempt\(s\) in shared storage\./.test(t)
      && t.indexOf("Upload finished") === t.lastIndexOf("Upload finished"),
      "upload: nothing of a deleted student's and no tomb: row is sent; the count says so, in FRONT of the reload's own line, once", t + " | " + sent.join(","));
    /* the retired set comes from the SERVER it just read, not only from this
       browser's last load: a student retired elsewhere is skipped too, and a
       marked attempt never goes up */
    const s2 = makeStore({}); const d2 = build(s2, null, null, { realLoad: true });
    s2.server.set("tomb:student:" + C1, { owner: C1, value: stTomb });                        // retired from another browser; d2's tombs is empty
    s2.server.set("tomb:attempt:202606asiav1:9:zz", { owner: C2, value: { kind: "tombstone", targetKind: "attempt", target: "attempt:202606asiav1:9:zz" } });
    s2.mirror.set("attempt:202606asiav1:3:cc", { attemptId: "attempt:202606asiav1:3:cc", student: { key: C1, code: C1 } });
    s2.mirror.set("attempt:202606asiav1:9:zz", { attemptId: "attempt:202606asiav1:9:zz", student: { key: C2, code: C2 } });
    s2.mirror.set("attempt:202606asiav1:4:dd", { attemptId: "attempt:202606asiav1:4:dd", student: { key: C2, code: C2 } });
    await d2.fns.migrateLocalToServer();
    const sent2 = s2.calls.filter(c => c[0] === "adminUpsert").map(c => c[1]);
    check(sent2.join() === "attempt:202606asiav1:4:dd" && /1 sent, 0 already on the server, 2 belonging to deleted student\(s\) or marked deleted not sent/.test(status(d2)),
      "upload: a student retired on the server since this browser's last load, and an attempt marked on the server, are both skipped", sent2.join(",") + " | " + status(d2));
  });
  await run(async () => {
    /* exportAll carries the markers; adoptArchive reads them back */
    const s = makeStore({}); const d = build(s);
    const rec = REC(); const tk = "tomb:" + rec.attemptId;
    const tv = { kind: "tombstone", targetKind: "attempt", target: rec.attemptId, code: C1, deletedAt: "2026-09-18T00:00:00Z", deletedBy: "tutor@test", reason: "attempt" };
    d.seed({ recs: [rec], tombs: { [tk]: tv, ["tomb:student:" + C2]: { kind: "tombstone", targetKind: "student", target: C2, code: C2 } } });
    d.fns.exportAll();
    const payload = JSON.parse(d.lastBlob.text);
    check(payload.schema === "acestem-attempt-archive-v1" && JSON.stringify(payload.records) === JSON.stringify([rec])
      && JSON.stringify(payload.tombstones) === JSON.stringify([{ key: tk, value: tv }, { key: "tomb:student:" + C2, value: { kind: "tombstone", targetKind: "student", target: C2, code: C2 } }]),
      "exportAll: records byte-identical, tombstones carried as sorted {key, value} rows", JSON.stringify(payload.tombstones));
    const d2 = build(makeStore({}));
    d2.fns.adoptArchive(payload);
    const st = d2.state();
    check(st.recs.length === 1 && st.tombs[tk] && st.tombs[tk].target === rec.attemptId && st.tombs["tomb:student:" + C2] && d2.fns.isTombstoned(rec) && d2.fns.isDeletedStudent(C2),
      "adoptArchive: the file's markers are read back and mark the file view", JSON.stringify(Object.keys(st.tombs)));
    const d3 = build(makeStore({}));
    d3.fns.adoptArchive({ records: [rec], tombstones: [{ key: "tomb:x", value: { kind: "tombstone" } }, { key: 7, value: tv }, "junk"] });
    check(Object.keys(d3.state().tombs).length === 0 && !d3.fns.isTombstoned(rec), "adoptArchive: malformed marker entries are ignored");
  });
  await run(async () => {
    /* the confirmation gate: exact code, case and spaces forgiven, nothing else */
    const d = build(makeStore({}));
    check(d.fns.deleteGateOk("as-abcdefgh", C1) && d.fns.deleteGateOk(" AS-ABCD EFGH ", C1) && d.fns.deleteGateOk(C1, C1),
      "gate: the code typed back (any case, stray spaces) opens it");
    check(!d.fns.deleteGateOk("", C1) && !d.fns.deleteGateOk("AS-ABCDEFG", C1) && !d.fns.deleteGateOk(C2, C1) && !d.fns.deleteGateOk(C1, "not-a-code"),
      "gate: empty, truncated, another student's code, or a target that is not a code all stay shut");
  });

  /* =================== 9. saveSetFromBuilder =================== */
  console.log("--- 9. saveSetFromBuilder: the set row and the assignment-card patch ---");
  const REF = { type: "bank", bankId: "bank-david-core", qid: "q0001" };
  /* §9 is about the SERVER rejecting a set write, not about bank retirement:
     it gets its own one-entry bank index, so a later export retiring
     bank-david-core q0001 cannot turn it red for an unrelated reason */
  const MINI_INDEX = { entries: [{ ref: "bank-david-core:q0001", containerType: "bank", bankId: "bank-david-core", qid: "q0001", retired: false }] };
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s, { BANK_INDEX: MINI_INDEX });
    d.seed({ builder: { setId: null, name: "New set", subject: "math", refs: [REF] }, sets: [], assigns: [] });
    d.$("sbName").value = "New set";
    const before = s.snapshot();
    await d.fns.saveSetFromBuilder();
    const m = d.state().setsMsg + ((d.state().builder && d.state().builder.msg) ? " [builder: " + d.state().builder.msg + "]" : ""); everyMessage.push(m);
    check(s.snapshot() === before && s.server.size === 0 && d.state().builder !== null,
      "rejected new set: no pset: row anywhere, the builder stays open");
    check(/^Not saved — set pset-\S+: the tutor sign-in has expired/.test(m) && noSync(m), "rejected new set: message names the set row", m);
    check(/^Not saved — set pset-\S+: the tutor sign-in has expired/.test((d.state().builder || {}).msg || "") && d.state().builder.saving === false,
      "rejected new set: the reason is also BESIDE Save (builder.msg), and the builder is unlocked", (d.state().builder || {}).msg);
  });
  await run(async () => {
    const old = { setId: "pset-1", name: "Old name", subject: "math", refs: [REF], createdAt: "2026-09-01T00:00:00Z" };
    const assignRow = { assignmentId: "a-1", kind: "set", category: "practice", setId: "pset-1", setName: "Old name", questionCount: 1, holdRelease: true, completedAttemptId: "attempt:pset-1:1:zz" };
    const s = makeStore({ reject: (op, k) => k.indexOf("assign:") === 0 && op === "put" }); const d = build(s);
    s.seedBoth("pset:pset-1", old); s.seedBoth("assign:" + C1 + ":a-1", assignRow, C1);
    d.seed({ sets: [JSON.parse(JSON.stringify(old))], assigns: [{ code: C1, list: [JSON.parse(JSON.stringify(assignRow))] }],
      builder: { setId: "pset-1", name: "New name", subject: "math", refs: [REF, { type: "form", testId: "202606asiav2", moduleId: "m", qid: "q" }], createdAt: old.createdAt } });
    d.$("sbName").value = "New name";
    const mirrorAssignBefore = JSON.stringify(s.mirror.get("assign:" + C1 + ":a-1"));
    await d.fns.saveSetFromBuilder();
    const m = d.state().setsMsg; everyMessage.push(m);
    check(s.server.get("pset:pset-1").value.name === "New name" && s.mirror.get("pset:pset-1").name === "New name", "edit: the set itself saved (server, then mirror)");
    check(JSON.stringify(s.mirror.get("assign:" + C1 + ":a-1")) === mirrorAssignBefore && s.server.get("assign:" + C1 + ":a-1").value.setName === "Old name",
      "edit with the card patch rejected: the assignment row is unchanged in mirror and server");
    check(/Saved “New name”/.test(m) && /1 assignment card couldn't be updated/.test(m) && /Not saved — assignment a-1 for AS-ABCDEFGH/.test(m) && noSync(m),
      "edit with the card patch rejected: message says which row", m);
  });
  await run(async () => {
    const old = { setId: "pset-1", name: "Old name", subject: "math", refs: [REF], createdAt: "2026-09-01T00:00:00Z" };
    const assignRow = { assignmentId: "a-1", kind: "set", category: "practice", setId: "pset-1", setName: "Old name", questionCount: 1, holdRelease: true, completedAttemptId: "attempt:pset-1:1:zz" };
    const s = makeStore({}); const d = build(s);
    s.seedBoth("pset:pset-1", old); s.seedBoth("assign:" + C1 + ":a-1", assignRow, C1);
    d.seed({ sets: [JSON.parse(JSON.stringify(old))], assigns: [{ code: C1, list: [JSON.parse(JSON.stringify(assignRow))] }],
      builder: { setId: "pset-1", name: "New name", subject: "math", refs: [REF, REF], createdAt: old.createdAt } });
    d.$("sbName").value = "New name";
    await d.fns.saveSetFromBuilder();
    const srv = s.server.get("assign:" + C1 + ":a-1").value;
    check(srv.setName === "New name" && srv.questionCount === 2 && srv.holdRelease === true && srv.completedAttemptId === "attempt:pset-1:1:zz"
      && JSON.stringify(s.mirror.get("assign:" + C1 + ":a-1")) === JSON.stringify(srv),
      "control: an accepted patch changes exactly name/count on the server row, keeps holdRelease and completedAttemptId, mirror follows");
    check(/Updated 1 assignment card\./.test(d.state().setsMsg), "control: the patch is reported");
  });

  await run(async () => {
    /* EDIT with the set row itself rejected: nothing else may happen — no
       card patch (it would point live cards at a set the server never got),
       no server read, builder stays open */
    const old = { setId: "pset-1", name: "Old name", subject: "math", refs: [REF], createdAt: "2026-09-01T00:00:00Z" };
    const assignRow = { assignmentId: "a-1", kind: "set", category: "practice", setId: "pset-1", setName: "Old name", questionCount: 1, holdRelease: false, completedAttemptId: null };
    const s = makeStore({ reject: (op, k) => op === "put" && k.indexOf("pset:") === 0 }); const d = build(s);
    s.seedBoth("pset:pset-1", old); s.seedBoth("assign:" + C1 + ":a-1", assignRow, C1);
    d.seed({ sets: [JSON.parse(JSON.stringify(old))], assigns: [{ code: C1, list: [JSON.parse(JSON.stringify(assignRow))] }],
      builder: { setId: "pset-1", name: "New name", subject: "math", refs: [REF, REF], createdAt: old.createdAt } });
    d.$("sbName").value = "New name";
    const before = s.snapshot();
    await d.fns.saveSetFromBuilder();
    const m = d.state().setsMsg; everyMessage.push(m);
    check(s.snapshot() === before && s.server.get("assign:" + C1 + ":a-1").value.setName === "Old name" && s.server.get("pset:pset-1").value.name === "Old name",
      "rejected set EDIT: mirror unchanged, the assignment row untouched on the server, the set still the old one");
    /* the save itself now reads the SET row fresh (§9f: "already held" is
       judged against it) — the card patch's reads are the assignment rows */
    check(!s.calls.some(c => c[0] === "adminSelectKey" && c[1].indexOf("assign:") === 0) && !s.calls.some(c => c[0] === "adminUpsert" && c[1].indexOf("assign:") === 0),
      "rejected set EDIT: the card patch never runs (no assignment read, no assignment write)");
    check(d.state().builder !== null && /^Not saved — set pset-1: the tutor sign-in has expired/.test(m) && noSync(m),
      "rejected set EDIT: builder stays open, message names the set", m);
  });

  await run(async () => {
    /* the heal: an assignment row this browser holds but the server never
       had is dropped from the mirror (the one sanctioned mirror write
       outside the helper) — and only then */
    const old = { setId: "pset-1", name: "Old name", subject: "math", refs: [REF], createdAt: "2026-09-01T00:00:00Z" };
    const ghost = { assignmentId: "a-9", kind: "set", category: "practice", setId: "pset-1", setName: "Old name", questionCount: 1 };
    const s = makeStore({}); const d = build(s);
    s.seedBoth("pset:pset-1", old); s.mirror.set("assign:" + C1 + ":a-9", JSON.parse(JSON.stringify(ghost)));   // mirror only
    d.seed({ sets: [JSON.parse(JSON.stringify(old))], assigns: [{ code: C1, list: [JSON.parse(JSON.stringify(ghost))] }],
      builder: { setId: "pset-1", name: "New name", subject: "math", refs: [REF, REF], createdAt: old.createdAt } });
    d.$("sbName").value = "New name";
    await d.fns.saveSetFromBuilder();
    const m = d.state().setsMsg; everyMessage.push(m);
    check(!s.mirror.has("assign:" + C1 + ":a-9") && !s.calls.some(c => c[0] === "adminUpsert" && c[1] === "assign:" + C1 + ":a-9"),
      "heal: a mirror-only assignment row is removed from the mirror and never written to the server");
    check(/^Saved “New name”\./.test(m) && !/assignment card/.test(m), "heal: reported as a plain save — nothing was patched", m);
  });
  await run(async () => {
    /* a server READ that fails must not heal anything: the row stays, and
       it counts as a card that couldn't be updated */
    const old = { setId: "pset-1", name: "Old name", subject: "math", refs: [REF], createdAt: "2026-09-01T00:00:00Z" };
    const row = { assignmentId: "a-1", kind: "set", category: "practice", setId: "pset-1", setName: "Old name", questionCount: 1 };
    const s = makeStore({ reject: (op, k) => op === "select" && k.indexOf("assign:") === 0 }); const d = build(s);   // the ASSIGNMENT read fails; the set's own read is §9f's
    s.seedBoth("pset:pset-1", old); s.seedBoth("assign:" + C1 + ":a-1", row, C1);
    d.seed({ sets: [JSON.parse(JSON.stringify(old))], assigns: [{ code: C1, list: [JSON.parse(JSON.stringify(row))] }],
      builder: { setId: "pset-1", name: "New name", subject: "math", refs: [REF, REF], createdAt: old.createdAt } });
    d.$("sbName").value = "New name";
    const mirrorRowBefore = JSON.stringify(s.mirror.get("assign:" + C1 + ":a-1"));
    await d.fns.saveSetFromBuilder();
    const m = d.state().setsMsg; everyMessage.push(m);
    check(JSON.stringify(s.mirror.get("assign:" + C1 + ":a-1")) === mirrorRowBefore && s.server.get("assign:" + C1 + ":a-1").value.setName === "Old name",
      "rejected server read: the assignment row is untouched in mirror and server (no heal, no patch)");
    check(/1 assignment card couldn't be updated/.test(m) && /Couldn't read assignment a-1 for AS-ABCDEFGH from the server/.test(m),
      "rejected server read: counted and named as a card that couldn't be updated", m);
  });
  await run(async () => {
    /* server accepted the patch but this browser's mirror couldn't be
       written: the warning must reach setsMsg even with nothing rejected */
    const old = { setId: "pset-1", name: "Old name", subject: "math", refs: [REF], createdAt: "2026-09-01T00:00:00Z" };
    const row = { assignmentId: "a-1", kind: "set", category: "practice", setId: "pset-1", setName: "Old name", questionCount: 1 };
    const s = makeStore({ localFail: true }); const d = build(s);
    s.seedBoth("pset:pset-1", old); s.seedBoth("assign:" + C1 + ":a-1", row, C1);
    d.seed({ sets: [JSON.parse(JSON.stringify(old))], assigns: [{ code: C1, list: [JSON.parse(JSON.stringify(row))] }],
      builder: { setId: "pset-1", name: "New name", subject: "math", refs: [REF, REF], createdAt: old.createdAt } });
    d.$("sbName").value = "New name";
    await d.fns.saveSetFromBuilder();
    const m = d.state().setsMsg; everyMessage.push(m);
    check(s.server.get("assign:" + C1 + ":a-1").value.setName === "New name" && /Updated 1 assignment card\./.test(m)
      && /Saved on the server, but this browser's copy of assignment a-1 for AS-ABCDEFGH couldn't be updated — press Refresh\./.test(m),
      "card patch accepted, mirror failed: the card's warning is shown alongside the count", m);
  });

  /* =================== 9f. a retired bank item never ENTERS a set (2026-09-30) =================== */
  console.log("--- 9f. saveSetFromBuilder refuses a retired (or unknown) bank item the STORED set does not already hold ---");
  const RETIRED = { type: "bank", bankId: "bank-202608-salvage", qid: "q0032" };     // retired 2026-09-12, supersededBy q0202
  const ACTIVE = { type: "bank", bankId: "bank-202608-salvage", qid: "q0049" };
  const FORMREF = { type: "form", testId: "202606asiav2", moduleId: "m", qid: "q" };
  const REAL_BANK_BYTES = fs.readFileSync("testdata/bank-index.js", "utf8");
  const idxWith = (qid, patch) => JSON.parse(JSON.stringify(REAL_BANK_INDEX, (k, v) =>
    (v && typeof v === "object" && v.bankId === "bank-202608-salvage" && v.qid === qid) ? Object.assign({}, v, patch) : v));
  const bodyFetch = (body, log) => async (url, o) => { if(log) log.push([url, o && o.cache, !!(o && o.signal)]);
    return { ok: true, status: 200, text: async () => body }; };
  const fetchOf = (idx, log) => bodyFetch("/* bank-index */\nwindow.BANK_INDEX = " + JSON.stringify(idx, null, 1) + ";\n", log);
  const realFetch = log => bodyFetch(REAL_BANK_BYTES, log);
  const msgOf = d => (d.state().builder && d.state().builder.msg) || "";
  const psetRows = st => [...st.server.keys()].filter(k => k.indexOf("pset:") === 0);
  const gateOf = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
  check(REAL_BANK_INDEX.entries.some(e => e.ref === "bank-202608-salvage:q0032" && e.retired === true && e.supersededBy === "q0202") &&
        REAL_BANK_INDEX.entries.some(e => e.ref === "bank-202608-salvage:q0049" && !e.retired),
    "fixture: the real bank index has q0032 retired (→ q0202) and q0049 active");
  const realTimeout = REAL_TIMEOUT_SRC ? new Function(REAL_TIMEOUT_SRC + "\nreturn BANK_INDEX_TIMEOUT_MS;")() : NaN;
  check(realTimeout >= 1000 && realTimeout <= 30000,
    "the real re-read deadline (BANK_INDEX_TIMEOUT_MS) is a bounded few seconds — this harness runs it at 60 ms", String(realTimeout));
  check(/^\s*let bankIndexFresh = null;/m.test(src) && /^\s*let builderTestId = "";/m.test(src) && /^\s*const fullTests = \{\};/m.test(src),
    "dashboard.js itself declares the module state this harness takes from it (bankIndexFresh, builderTestId, fullTests)");

  /* which pages re-read the index — decided on the REAL markup */
  await run(async () => {
    check(!!LOCAL_JS_RE_SRC && SKIP_INLINE.indexOf("config.js") !== -1, "assemble.py's inlining rule (LOCAL_JS_RE, SKIP_INLINE) was read from assemble.py", String(LOCAL_JS_RE_SRC));
    check(SCRIPT_SRCS.indexOf("testdata/bank-index.js") !== -1 && INLINED_AWAY.indexOf("testdata/bank-index.js") !== -1 && INLINED_SRCS.indexOf("testdata/bank-index.js") === -1,
      "index.html loads testdata/bank-index.js by <script src>, and by assemble.py's own rule that tag is inlined into the single-file build", SCRIPT_SRCS.join(", "));
    const withAttr = INDEX_HTML.replace('<script src="testdata/bank-index.js"></script>', '<script src="testdata/bank-index.js" defer></script>');
    check(withAttr !== INDEX_HTML && [...withAttr.matchAll(new RegExp(LOCAL_JS_RE_SRC, "g"))].map(m => m[1]).indexOf("testdata/bank-index.js") === -1,
      "control: the same rule would NOT inline a tag that grew an attribute (so this model can't hide that change)");
    const kinds = {};
    for(const page of ["origin", "file", "inlined"]) kinds[page] = build(makeStore({}), {}, { page: page }).fns.bankIndexReReadable();
    check(kinds.origin === true && kinds.file === false && kinds.inlined === false,
      "bankIndexReReadable: true for index.html over http(s), false for a file:// copy and for the single-file build", JSON.stringify(kinds));
    /* …and the REAL build: assemble.py run into a temp file, its surviving
       <script src> tags compared with the model the page kinds use */
    const os = require("os"), path = require("path"), { spawnSync } = require("child_process");
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tw-assemble-")), "index-live.html");
    let built = null;
    for(const py of ["python", "python3"]){
      const r = spawnSync(py, ["assemble.py", "--out", outFile], { encoding: "utf8" });
      if(r.status === 0 && fs.existsSync(outFile)){ built = fs.readFileSync(outFile, "utf8"); break; }
    }
    if(built === null){
      console.log("SKIP | no python could run assemble.py — the real single-file build was not checked (the model follows assemble.py's regex)");
    } else {
      const realSrcs = [...built.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)].map(m => m[1]);
      check(realSrcs.indexOf("testdata/bank-index.js") === -1 && JSON.stringify(realSrcs.slice().sort()) === JSON.stringify(INLINED_SRCS.slice().sort()),
        "the REAL single-file build (assemble.py, run now) keeps exactly the <script src> tags the 'inlined' page model keeps — and not the bank index's",
        JSON.stringify({ real: realSrcs, model: INLINED_SRCS }));
    }
    try{ fs.rmSync(path.dirname(outFile), { recursive: true, force: true }); }catch(e){}
    check(/id="dashMigrateBtn"[^>]*>[^<]*Upload local records to server</.test(INDEX_HTML),
      "the button the no-stored-row advice names ('Upload local records to server') exists in index.html under that label");
  });

  await run(async () => {
    const s = makeStore({}); const d = build(s);
    d.seed({ builder: { setId: null, name: "New set", subject: "rw", refs: [ACTIVE, RETIRED] }, sets: [], assigns: [] });
    d.$("sbName").value = "New set";
    const before = s.snapshot();
    await d.fns.saveSetFromBuilder();
    const m = msgOf(d); everyMessage.push(m);
    check(s.snapshot() === before && s.server.size === 0 && !s.calls.some(c => c[0] === "adminUpsert") && d.state().builder !== null && d.state().builder.saving === false,
      "new set with a retired item: nothing written anywhere, the builder stays open and unlocked");
    check(m === "Not saved — this bank item can't be added to a set: bank-202608-salvage:q0032 (retired — replaced by q0202). Remove it and save again." && noSync(m),
      "…and the outcome line (builder.msg, which viewSetBuilder renders — canonical-index §11) names the item, says retired, names the replacement", m);
  });

  await run(async () => {
    /* the Assign-a-set form below the builder keeps its values only in the
       DOM: a save's outcome re-render must not wipe it (finding 3) */
    const s = makeStore({}); const d = build(s);
    d.seed({ builder: { setId: null, name: "N", subject: "rw", refs: [RETIRED] }, sets: [], assigns: [] });
    d.$("sbName").value = "N";
    d.$("saFree").value = "AS-ABCDEFGH"; d.$("saLimit").value = "25"; d.$("saHold").checked = true;
    await d.fns.saveSetFromBuilder();
    check(/can't be added/.test(msgOf(d)) && d.$("sbMsg").textContent === msgOf(d) && d.$("sbSaveBtn").disabled === false &&
          d.$("saFree").value === "AS-ABCDEFGH" && d.$("saLimit").value === "25" && d.$("saHold").checked === true,
      "a refused save RE-RENDERS (the refusal is painted, Save enabled) keeping the Assign-a-set form (codes, limit, hold)",
      JSON.stringify([d.$("sbMsg").textContent, d.$("saFree").value, d.$("saLimit").value, d.$("saHold").checked]));
    /* the same at the WRITE: a save the server rejects, and a save that succeeds */
    for(const reject of [true, false]){
      const s2 = makeStore(reject ? { reject: (op, k) => op === "put" && k.indexOf("pset:") === 0 } : {}); const d2 = build(s2);
      d2.seed({ builder: { setId: null, name: "W", subject: "rw", refs: [FORMREF] }, sets: [], assigns: [] });
      d2.$("sbName").value = "W";
      d2.$("saFree").value = "AS-ABCDEFGH"; d2.$("saLimit").value = "25"; d2.$("saHold").checked = true;
      await d2.fns.saveSetFromBuilder();
      check(d2.$("saFree").value === "AS-ABCDEFGH" && d2.$("saLimit").value === "25" && d2.$("saHold").checked === true &&
            (reject ? /^Not saved — set pset-/.test(d2.$("sbMsg").textContent)
                    : (d2.state().builder === null && d2.$("sbMsg").textContent === "" && d2.$("sbSaveBtn").disabled === false && d2.$("setNewBtn").disabled === false)),
        (reject ? "a save the server rejects" : "a save that succeeds") + " re-renders keeping the Assign-a-set form" + (reject ? ", with the reason painted beside Save" : ""),
        JSON.stringify([d2.$("sbMsg").textContent, d2.$("saFree").value]));
    }
  });

  await run(async () => {
    /* a set whose STORED row holds q0032: edited and re-saved, it keeps it */
    const old = { setId: "pset-7", name: "Old", subject: "rw", refs: [RETIRED, ACTIVE], createdAt: "2026-09-01T00:00:00Z" };
    const log = [];
    const s = makeStore({}); const d = build(s, { fetch: realFetch(log) }, { page: "origin" });
    s.seedBoth("pset:pset-7", old);
    d.seed({ sets: [JSON.parse(JSON.stringify(old))], assigns: [],
      builder: { setId: "pset-7", name: "Renamed", subject: "rw", refs: JSON.parse(JSON.stringify(old.refs)), createdAt: old.createdAt } });
    d.$("sbName").value = "Renamed";
    await d.fns.saveSetFromBuilder();
    const row = s.server.get("pset:pset-7").value;
    check(row.name === "Renamed" && JSON.stringify(row.refs) === JSON.stringify(old.refs) && d.state().builder === null,
      "edit of a set whose STORED row holds a retired item: saved, the ref kept as it was (same place, same ref)", JSON.stringify(row.refs));
    check(s.calls.some(c => c[0] === "adminSelectKey" && c[1] === "pset:pset-7") && log.length === 0,
      "…judged against the stored row read fresh from the server; nothing to add, so no bank-index read");
  });

  await run(async () => {
    /* the STALE `sets` (first review, finding 1) */
    const stored = { setId: "pset-9", name: "S", subject: "rw", refs: [ACTIVE], createdAt: "2026-09-01T00:00:00Z" };
    const stale = { setId: "pset-9", name: "S", subject: "rw", refs: [RETIRED, ACTIVE], createdAt: "2026-09-01T00:00:00Z" };
    for(const remote of [true, false]){
      const s = makeStore({ remote: remote }); const d = build(s, { fetch: realFetch() }, { page: "origin" });
      s.seedBoth("pset:pset-9", stored);
      d.seed({ sets: [JSON.parse(JSON.stringify(stale))], assigns: [],
        builder: { setId: "pset-9", name: "S (renamed)", subject: "rw", refs: JSON.parse(JSON.stringify(stale.refs)), createdAt: stale.createdAt } });
      d.$("sbName").value = "S (renamed)";
      await d.fns.saveSetFromBuilder();
      const m = msgOf(d); everyMessage.push(m);
      const after = remote ? s.server.get("pset:pset-9").value : s.mirror.get("pset:pset-9");
      check(JSON.stringify(after.refs) === JSON.stringify(stored.refs) && after.name === "S" && /q0032 \(retired — replaced by q0202\)/.test(m) &&
            JSON.stringify(d.state().builder.storedKeys) === JSON.stringify(["bank-202608-salvage:q0049"]),
        (remote ? "remote" : "local") + ": a page whose `sets` still holds a ref the STORED set no longer has cannot write that retired ref back (and learns what the set holds)",
        m + " | " + JSON.stringify(after.refs));
    }
  });

  await run(async () => {
    /* the stored-row read fails: WHY decides the advice (second review, finding 2) */
    const stored = { setId: "pset-9", name: "S", subject: "rw", refs: [ACTIVE], createdAt: "2026-09-01T00:00:00Z" };
    const cases = [
      ["401", { reject: (op, k) => op === "select" && k === "pset:pset-9" }, /sign-in has expired — sign in again, then save/],
      ["503", { reject: (op, k) => op === "select" && k === "pset:pset-9", errorStatus: 503 }, /HTTP 503\) — press Save set again, or Refresh/]];
    for(const [why, opts, want] of cases){
      const s = makeStore(opts); const d = build(s, { fetch: realFetch() }, { page: "origin" });
      s.seedBoth("pset:pset-9", stored);
      d.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [], builder: { setId: "pset-9", name: "S2", subject: "rw", refs: [ACTIVE], createdAt: stored.createdAt } });
      d.$("sbName").value = "S2";
      await d.fns.saveSetFromBuilder();
      const m = msgOf(d); everyMessage.push(m);
      check(s.server.get("pset:pset-9").value.name === "S" && /^Not saved — couldn't read set pset-9 as it is stored now/.test(m) && want.test(m) &&
            (why !== "401" || m.indexOf("Press Save set again") === -1) && d.state().builder.saving === false,
        "the stored-row read fails (" + why + "): refused, nothing written, and the advice fits the cause", m);
    }
    const s3 = makeStore({ remote: false, localReadFail: true }); const d3 = build(s3, { fetch: realFetch() }, { page: "origin" });
    s3.mirror.set("pset:pset-9", JSON.parse(JSON.stringify(stored)));
    d3.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [], builder: { setId: "pset-9", name: "S3", subject: "rw", refs: [ACTIVE], createdAt: stored.createdAt } });
    d3.$("sbName").value = "S3";
    await d3.fns.saveSetFromBuilder();
    check(s3.mirror.get("pset:pset-9").name === "S" && /^Not saved — couldn't read set pset-9 as it is stored now.*the read failed/.test(msgOf(d3)),
      "the stored-row read fails (local): refused the same way", msgOf(d3));
    /* a real expired session rejects EVERY call, the read included */
    const s4 = makeStore({ reject: true }); const d4 = build(s4, { fetch: realFetch() }, { page: "origin" });
    s4.seedBoth("pset:pset-9", stored);
    d4.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [], builder: { setId: "pset-9", name: "S4", subject: "rw", refs: [ACTIVE], createdAt: stored.createdAt } });
    d4.$("sbName").value = "S4";
    await d4.fns.saveSetFromBuilder();
    check(/sign-in has expired/.test(msgOf(d4)) && !s4.calls.some(c => c[0] === "adminUpsert"),
      "an expired session (every call 401) on an edit holding a bank item says to sign in again, and writes nothing", msgOf(d4));
  });

  await run(async () => {
    /* deleted in another browser or tab (second review, finding 9): gone is
       not "holds nothing" — the save must not recreate it */
    const gone = { setId: "pset-X", name: "Deleted elsewhere", subject: "rw", refs: [RETIRED, ACTIVE], createdAt: "2026-09-01T00:00:00Z" };
    for(const mode of ["remote", "local", "shared"]){
      const remote = mode === "remote";
      const s = makeStore({ remote: remote, shared: mode === "shared" }); const d = build(s, { fetch: realFetch() }, { page: "origin" });
      d.seed({ sets: [JSON.parse(JSON.stringify(gone))], assigns: [], builder: d.fns.builderFromSet(gone) });
      const sets0 = d.state().loads.sets;
      d.$("sbName").value = "Deleted elsewhere";
      await d.fns.saveSetFromBuilder();
      const m = msgOf(d); everyMessage.push(m);
      /* the paints made WHILE the save still held the lock — the finally's
         repaint shows the same text after the fact, so it proves nothing */
      const refusalPaints = d.state().paints.filter(p => p.msg === m && p.inFlight > 0);
      check(!s.server.has("pset:pset-X") && !s.mirror.has("pset:pset-X") && !s.calls.some(c => (c[0] === "adminUpsert" || c[0] === "setLocal") && c[1] === "pset:pset-X") &&
            (remote ? /isn't on the server: it was deleted in another browser or tab, or it was built on this device and never uploaded\. Only if you're sure it was never uploaded.*Upload local records to server.*brings it back and re-opens its unstarted assignments/.test(m)
                    : mode === "shared" ? /no longer exists \(deleted in another browser or tab\)/.test(m) : /no longer exists \(deleted in another tab\)/.test(m)) &&
            /kept here as a NEW set/.test(m) && d.state().builder.setId === null && d.state().builder.refs.length === 2 &&
            JSON.stringify(d.state().builder.storedKeys) === "[]" && !("createdAt" in d.state().builder) &&
            refusalPaints.length > 0 && refusalPaints.every(p => p.setId === null && JSON.stringify(p.storedKeys) === "[]") &&
            (remote ? d.state().loads.sets === sets0 : d.state().loads.sets === sets0 + 1),
        mode + ": a set with no stored row is not recreated; the builder becomes an unsaved NEW set keeping ALL its questions (already so when the refusal is painted)" +
        (remote ? ", and the Upload advice carries its warning" : ", and the list is reloaded"), m);
      check(/Its questions are kept here as a NEW set\. A retired bank item can't go into a new set: remove bank-202608-salvage q0032 first, then press Save set to save the rest under a new id, or Cancel to drop them\.$/.test(m) &&
            m.indexOf("press Save set to save them") === -1,
        mode + ": the kept questions include a retired item, so the advice says to remove it first — never a bare 'press Save set' that would be refused (final check, finding 6)", m);
      d.fns.builderRemoveRef(0);                          // the retired item can't go into a new set
      await d.fns.saveSetFromBuilder();
      const rows = [...(remote ? s.server.keys() : s.mirror.keys())].filter(k => k.indexOf("pset:") === 0);
      check(rows.length === 1 && rows[0] !== "pset:pset-X" && d.state().builder === null,
        mode + ": the next Save set saves those questions under a NEW id — the deleted id is never recreated", rows.join(", "));
    }
  });

  await run(async () => {
    /* the STALE PAGE: this page's index says q0049 active; the fresh read says retired */
    const log = [];
    const s = makeStore({}); const d = build(s, { fetch: fetchOf(idxWith("q0049", { retired: true, supersededBy: "q0202" }), log) }, { page: "origin" });
    check(d.fns.isRetiredBankRef(ACTIVE) === false, "stale page: before any save, this page believes q0049 is active");
    d.seed({ builder: { setId: null, name: "Stale", subject: "rw", refs: [ACTIVE] }, sets: [], assigns: [] });
    d.$("sbName").value = "Stale";
    await d.fns.saveSetFromBuilder();
    const m = msgOf(d); everyMessage.push(m);
    check(s.server.size === 0 && log.length === 1 && log[0][0] === "testdata/bank-index.js" && log[0][1] === "no-store" && log[0][2] === true,
      "stale page: the save re-reads testdata/bank-index.js (cache bypassed, with an abort signal), and writes nothing", JSON.stringify(log));
    check(/bank-202608-salvage:q0049 \(retired — replaced by q0202, since this page loaded — reload the dashboard\)/.test(m),
      "…says the item was retired since this page loaded, names the live replacement, and says to reload", m);
    check(d.fns.isRetiredBankRef(ACTIVE) === true && d.warns.length === 0,
      "…the page now KNOWS (the re-read is kept for the picker and pushRef), and a successful read logs no warning");
  });

  await run(async () => {
    /* the REAL bytes through the parser, and a planted trailer */
    const d = build(makeStore({}), { fetch: realFetch() }, { page: "origin" });
    const got = await d.fns.freshestBankIndex();
    check(got.fresh === true && got.idx.entries.length === REAL_BANK_INDEX.entries.length,
      "the committed testdata/bank-index.js, byte for byte, parses as a fresh index (" + REAL_BANK_INDEX.entries.length + " entries)");
    const planted = REAL_BANK_BYTES.replace(/\s*$/, "") + "\n/* 246 entries */\n";
    const s3 = makeStore({}); const d3 = build(s3, { fetch: bodyFetch(planted) }, { page: "origin" });
    d3.seed({ builder: { setId: null, name: "T", subject: "rw", refs: [ACTIVE] }, sets: [], assigns: [] });
    d3.$("sbName").value = "T";
    await d3.fns.saveSetFromBuilder();
    check(s3.server.size === 0 && /couldn't be re-read to check bank-202608-salvage:q0049/.test(msgOf(d3)) &&
          d3.warns.some(w => /bank-index\.js was read but is not `window\.BANK_INDEX = \{…\};`/.test(w)),
      "a planted trailer does not parse: the save is refused as unverified AND the console says why (the tutor is pointed there)", msgOf(d3) + " | " + d3.warns.join(" / "));
  });

  await run(async () => {
    /* the re-read fails: refuse on an http(s) page that loaded the index;
       its own copy decides on the single-file build and a file:// copy */
    const never = () => new Promise(() => {});
    const variants = [
      ["fetch rejects", async () => { throw new TypeError("Failed to fetch"); }, /couldn't re-read.*Failed to fetch/],
      ["503", async () => ({ ok: false, status: 503, text: async () => "Service Unavailable" }), /couldn't re-read.*HTTP 503/],
      ["unparseable body", async () => ({ ok: true, text: async () => "window.BANK_INDEX = {oops" }), /was read but is not/],
      ["a read that never settles (deadline)", never, /couldn't re-read.*timed out/],
      ["no fetch at all", undefined, /has no fetch/]];
    for(const [why, fetch, warnRe] of variants){
      for(const page of ["origin", "inlined", "file"]){
        const s1 = makeStore({}); const d1 = build(s1, { fetch: fetch }, { page: page });
        d1.seed({ builder: { setId: null, name: "R", subject: "rw", refs: [RETIRED] }, sets: [], assigns: [] });
        d1.$("sbName").value = "R";
        const s2 = makeStore({}); const d2 = build(s2, { fetch: fetch }, { page: page });
        d2.seed({ builder: { setId: null, name: "A", subject: "rw", refs: [ACTIVE] }, sets: [], assigns: [] });
        d2.$("sbName").value = "A";
        let timedOut = false;
        const guard = new Promise(r => setTimeout(() => { timedOut = true; r(); }, 3000));
        await Promise.race([Promise.all([d1.fns.saveSetFromBuilder(), d2.fns.saveSetFromBuilder()]), guard]);
        if(page === "origin"){
          check(!timedOut && s1.server.size === 0 && s2.server.size === 0 &&
                /couldn't be re-read/.test(msgOf(d1)) && /couldn't be re-read/.test(msgOf(d2)) &&
                d1.state().builder.saving === false && d2.state().builder.saving === false && d2.warns.some(w => warnRe.test(w)),
            "re-read failed (" + why + ") on index.html over http(s): both saves settle, are refused as unverified, and the console names the cause",
            [timedOut, msgOf(d1), msgOf(d2), d2.warns.join(" / ")].join(" | "));
        } else {
          check(!timedOut && s1.server.size === 0 && /q0032 \(retired — replaced by q0202\)/.test(msgOf(d1)) && psetRows(s2).length === 1 && d2.warns.length === 0,
            "re-read failed (" + why + ") on the " + (page === "file" ? "file:// copy" : "single-file build") + ": no re-read is tried, its own copy decides — retired refused, active saved",
            [timedOut, msgOf(d1), psetRows(s2).join(","), d2.warns.join(" / ")].join(" | "));
        }
      }
    }
    /* the deadline really ABORTS the hung request, not just stops waiting */
    let sig = null;
    const hung = (url, o) => new Promise((_, reject) => { sig = o && o.signal;
      if(sig) sig.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); }); });
    const dA = build(makeStore({}), { fetch: hung }, { page: "origin" });
    const gotA = await dA.fns.freshestBankIndex();
    check(gotA.fresh === false && !!sig && sig.aborted === true, "the deadline aborts the hung request (its signal fires), and the read reports not-fresh");
  });

  await run(async () => {
    const s = makeStore({}); const d = build(s, { fetch: realFetch() }, { page: "origin" });
    d.seed({ builder: { setId: null, name: "U", subject: "rw", refs: [{ type: "bank", bankId: "bank-nowhere", qid: "q1" }, FORMREF] }, sets: [], assigns: [] });
    d.$("sbName").value = "U";
    await d.fns.saveSetFromBuilder();
    const m = msgOf(d); everyMessage.push(m);
    check(s.server.size === 0 && m.indexOf("bank-nowhere:q1 (not in the bank index)") !== -1,
      "a bank ref the index doesn't list can't be checked, so it is refused (a student's set would not resolve)", m);
    /* a form-only EDIT does no stored-row read: a failing read can't refuse it (finding 25) */
    for(const remote of [true, false]){
      const log = [];
      const f0 = { setId: "pset-f", name: "F", subject: "rw", refs: [FORMREF], createdAt: "2026-09-01T00:00:00Z" };
      const s2 = makeStore({ remote: remote, reject: (op) => op === "select", localReadFail: true }); const d2 = build(s2, { fetch: realFetch(log) }, { page: "origin" });
      s2.seedBoth("pset:pset-f", f0);
      d2.seed({ sets: [JSON.parse(JSON.stringify(f0))], assigns: [], builder: { setId: "pset-f", name: "F2", subject: "rw", refs: [FORMREF], createdAt: f0.createdAt } });
      d2.$("sbName").value = "F2";
      await d2.fns.saveSetFromBuilder();
      const saved = remote ? s2.server.get("pset:pset-f").value : s2.mirror.get("pset:pset-f");
      check(log.length === 0 && saved.name === "F2" && !s2.calls.some(c => (c[0] === "adminSelectKey" || c[0] === "getResult") && c[1] === "pset:pset-f"),
        (remote ? "remote" : "local") + ": a form-only EDIT saves with no stored-row read and no bank-index read (a failing read can't refuse it)");
    }
    const chain = d.fns.liveReplacement({ type: "bank", bankId: "bank-202608-salvage", qid: "q0098" });
    check(chain === "q0239", "a retired item whose replacement is itself retired names the LIVE end of the chain (q0098 → q0209 → q0239)", String(chain));
  });

  await run(async () => {
    /* the file:// copy (second review, findings 6/8/24): no re-read is
       possible, so its own copy decides — no permanent refusal */
    const log = [];
    const failing = async (url, o) => { log.push(url); throw new TypeError("Failed to fetch"); };
    const s = makeStore({ remote: false }); const d = build(s, { fetch: failing }, { page: "file" });
    d.seed({ builder: { setId: null, name: "Disk", subject: "rw", refs: [ACTIVE] }, sets: [], assigns: [] });
    d.$("sbName").value = "Disk";
    await d.fns.saveSetFromBuilder();
    const s2 = makeStore({ remote: false }); const d2 = build(s2, { fetch: failing }, { page: "file" });
    d2.seed({ builder: { setId: null, name: "Disk2", subject: "rw", refs: [RETIRED] }, sets: [], assigns: [] });
    d2.$("sbName").value = "Disk2";
    await d2.fns.saveSetFromBuilder();
    check([...s.mirror.keys()].filter(k => k.indexOf("pset:") === 0).length === 1 && s2.mirror.size === 0 && /q0032 \(retired/.test(msgOf(d2)) && log.length === 0,
      "a file:// copy saves an active bank item and refuses a retired one against its own copy, without ever trying fetch()", [msgOf(d2), log.join(",")].join(" | "));
  });

  await run(async () => {
    /* while a save runs the builder is read-only, and whatever happens to
       the builder meanwhile, the checked snapshot is what's written or nothing is */
    const g = gateOf();
    const slow = async () => { await g.p; return { ok: true, text: async () => REAL_BANK_BYTES }; };
    const MINI_TEST = { testId: "tMini", modules: [{ moduleId: "mMini", questions: [{ id: "x1" }, { id: "x2" }] }] };
    const OTHER_ACTIVE = { type: "bank", bankId: "bank-202608-salvage", qid: "q0202" };     // active, not in the set
    const s = makeStore({}); const d = build(s, { fetch: slow }, { page: "origin" });
    d.seed({ builder: { setId: null, name: "Race", subject: "rw", refs: [ACTIVE, FORMREF] }, sets: [], assigns: [], fullTest: MINI_TEST, builderTestId: "tMini" });
    d.$("sbName").value = "Race";
    const p = d.fns.saveSetFromBuilder();
    const locked = d.state().builder.saving === true && /Checking the bank items/.test(msgOf(d)) && d.$("sbSaveBtn").disabled === true &&
      d.fns.pushRef(OTHER_ACTIVE) === false && d.fns.builderRemoveRef(0) === false && d.fns.builderMoveRef(0, 1) === false &&
      d.fns.builderAddModule("mMini") === false && d.state().builder.refs.length === 2;
    check(locked, "while the check runs the builder is locked (Save painted disabled): adding an ACTIVE item, remove, reorder and Add whole module all refuse",
      JSON.stringify(d.state().builder.refs.map(r => r.qid)));
    const dIdle = build(makeStore({}), {}, { page: "origin" });
    dIdle.seed({ builder: { setId: null, name: "Idle", subject: "rw", refs: [ACTIVE, FORMREF] }, fullTest: MINI_TEST, builderTestId: "tMini" });
    check(dIdle.fns.pushRef(OTHER_ACTIVE) === true && dIdle.fns.builderMoveRef(0, 1) === true && dIdle.fns.builderRemoveRef(0) === true &&
          dIdle.fns.builderAddModule("mMini") === true && dIdle.state().builder.refs.length === 4,
      "control: the same four calls succeed when no save is running — each refusal above came from the lock");
    const second = d.fns.saveSetFromBuilder();          // a double click while the first is in flight
    d.state().builder.refs.push(RETIRED);              // …and the refs change anyway (the case the re-check exists for)
    g.open(); await p; await second;
    check(s.server.size === 0 && /changed while the set was being checked/.test(msgOf(d)) && d.state().builder !== null && d.state().builder.saving === false,
      "refs changed during the check: nothing saved, 'press Save set again', builder unlocked", msgOf(d));
    /* Cancel during the check: the re-read SUCCEEDS here, so only the cancel
       guard can stop the write (finding 18) — control first */
    for(const cancel of [false, true]){
      const g2 = gateOf();
      const s2 = makeStore({}); const d2 = build(s2, { fetch: async () => { await g2.p; return { ok: true, text: async () => REAL_BANK_BYTES }; } }, { page: "origin" });
      d2.seed({ builder: { setId: null, name: "Gone", subject: "rw", refs: [ACTIVE] }, sets: [], assigns: [] });
      d2.$("sbName").value = "Gone";
      const p2 = d2.fns.saveSetFromBuilder();
      if(cancel) d2.seed({ builder: null });            // Cancel while the index is read
      g2.open(); await p2;
      check(cancel ? (s2.server.size === 0 && !s2.calls.some(c => c[0] === "adminUpsert")) : psetRows(s2).length === 1,
        cancel ? "builder cancelled during the check (the re-read succeeds): nothing saved" : "control: the same save, not cancelled, writes the set");
    }
    const g3 = gateOf();
    const s3 = makeStore({}); const d3 = build(s3, { fetch: async () => { await g3.p; return { ok: true, text: async () => REAL_BANK_BYTES }; } }, { page: "origin" });
    d3.seed({ builder: { setId: null, name: "Twice", subject: "rw", refs: [ACTIVE] }, sets: [], assigns: [] });
    d3.$("sbName").value = "Twice";
    const a1 = d3.fns.saveSetFromBuilder(), a2 = d3.fns.saveSetFromBuilder();
    d3.$("sbName").value = "";                          // a tab switch after the click: the name was read at the click
    g3.open(); await a1; await a2;
    const rows3 = psetRows(s3);
    check(rows3.length === 1 && s3.server.get(rows3[0]).value.name === "Twice",
      "a double click on Save set creates ONE set, named as it was when clicked (the name is read before any await)", rows3.join(", "));
  });

  await run(async () => {
    /* the WRITE awaits too: a ref pushed into the live array reaches neither
       side, and a builder opened meanwhile survives the save (finding 1/13) */
    const s = makeStore({}); const d = build(s, { fetch: realFetch() }, { page: "origin" });
    const put = gateOf();
    const realUpsert = s.AS.adminUpsert;
    s.AS.adminUpsert = async function(k, owner, v){ const body = JSON.parse(JSON.stringify(v)); await put.p; return realUpsert.call(this, k, owner, body); };
    d.seed({ builder: { setId: null, name: "Snap", subject: "rw", refs: [ACTIVE] }, sets: [], assigns: [] });
    d.$("sbName").value = "Snap";
    const p = d.fns.saveSetFromBuilder();
    for(let i = 0; i < 40 && !s.calls.some(c => c[0] === "adminUpsert"); i++) await new Promise(r => setTimeout(r, 5));
    check(msgOf(d) === "Saving…", "during the server write the builder says 'Saving…', not 'Checking…'", msgOf(d));
    const first = d.state().builder;
    first.refs.push(RETIRED);                           // lands in the live array mid-write
    const other = { setId: null, name: "Opened meanwhile", subject: "math", refs: [] };
    d.seed({ builder: other });                         // New set clicked while the first save writes
    put.open(); await p;
    const k = psetRows(s)[0];
    check(!!k && JSON.stringify(s.server.get(k).value.refs) === JSON.stringify([ACTIVE]) && JSON.stringify(s.mirror.get(k).refs) === JSON.stringify([ACTIVE]),
      "a ref pushed into the live array during the server write reaches neither the server nor the mirror — both hold the checked snapshot",
      k ? JSON.stringify([s.server.get(k).value.refs, s.mirror.get(k).refs]) : "no row");
    check(d.state().builder === other, "a builder opened while a save was writing is NOT closed when that save succeeds");
    /* …but Edit on the SAME set during the write is refused (the list copy is
       pre-save), and a builder on that set left over by a stale click closes */
    const stored = { setId: "pset-same", name: "Same", subject: "rw", refs: [ACTIVE, FORMREF], createdAt: "2026-09-01T00:00:00Z" };
    const s2 = makeStore({}); const d2 = build(s2, { fetch: realFetch() }, { page: "origin" });
    s2.seedBoth("pset:pset-same", stored);
    const put2 = gateOf();
    const up2 = s2.AS.adminUpsert;
    s2.AS.adminUpsert = async function(k, owner, v){ const body = JSON.parse(JSON.stringify(v)); await put2.p; return up2.call(this, k, owner, body); };
    d2.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [], builder: d2.fns.builderFromSet(Object.assign({}, stored, { refs: [FORMREF] })) });
    d2.$("sbName").value = "Same";
    const pSame = d2.fns.saveSetFromBuilder();
    for(let i = 0; i < 40 && !s2.calls.some(c => c[0] === "adminUpsert"); i++) await new Promise(r => setTimeout(r, 5));
    const saving = d2.state().builder;
    const reopened = d2.fns.openSetInBuilder("pset-same");
    const stale = d2.fns.builderFromSet(stored);        // what a stale Edit click would have opened
    d2.seed({ builder: stale });
    put2.open(); await pSame;
    check(reopened === false && d2.state().builder === null && JSON.stringify(s2.server.get("pset:pset-same").value.refs) === JSON.stringify([FORMREF]),
      "Edit on the set being written is refused, and a builder on that set opened from the pre-save copy is closed when the save lands",
      JSON.stringify([reopened, d2.state().builder && d2.state().builder.refs]));
    void saving;
    /* Cancel does not end a save: after it, Edit / New set / Delete still
       wait for the save (the lock is page-wide), then come back */
    const s3 = makeStore({}); const d3 = build(s3, { fetch: realFetch() }, { page: "origin" });
    s3.seedBoth("pset:pset-same", stored);
    const put3 = gateOf();
    const up3 = s3.AS.adminUpsert;
    s3.AS.adminUpsert = async function(k, owner, v){ const body = JSON.parse(JSON.stringify(v)); await put3.p; return up3.call(this, k, owner, body); };
    d3.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [], builder: d3.fns.builderFromSet(Object.assign({}, stored, { refs: [FORMREF] })) });
    d3.$("sbName").value = "Same";
    const p3 = d3.fns.saveSetFromBuilder();
    for(let i = 0; i < 40 && !s3.calls.some(c => c[0] === "adminUpsert"); i++) await new Promise(r => setTimeout(r, 5));
    d3.seed({ builder: null });                         // Cancel mid-write
    const afterCancel = [d3.fns.openSetInBuilder("pset-same"), d3.fns.newSetInBuilder(), d3.fns.deleteSetFromList("pset-same")];
    const deletesDuring = s3.calls.filter(c => c[0] === "adminDelete").length;
    put3.open(); await p3;
    const afterSave = d3.fns.openSetInBuilder("pset-same");
    check(JSON.stringify(afterCancel) === "[false,false,false]" && deletesDuring === 0 && d3.state().setSaveInFlight === 0 && afterSave === true &&
          d3.$("setNewBtn").disabled === false,
      "Cancel during a write doesn't end the save: Edit, New set and Delete still refuse until it settles (the page lock), then the list works again",
      JSON.stringify({ afterCancel, deletesDuring, inFlight: d3.state().setSaveInFlight, afterSave }));
  });

  await run(async () => {
    /* final check (2026-09-30): the save's page lock also holds off the other
       writes it races — an assignment Delete (the save's card patch would
       write the row back as a startable card: finding 1) and Assign set (it
       would stamp the pre-save name and count: finding 2) */
    const stored = { setId: "pset-L", name: "Old name", subject: "rw", refs: [ACTIVE], createdAt: "2026-09-01T00:00:00Z" };
    const card = { assignmentId: "a-L", kind: "set", category: "practice", setId: "pset-L", setName: "Old name", questionCount: 1, completedAttemptId: null };
    const ak = "assign:" + C1 + ":a-L";
    const s = makeStore({}); const d = build(s, { fetch: realFetch() }, { page: "origin" });
    s.seedBoth("pset:pset-L", stored); s.seedBoth(ak, card, C1);
    /* hold the CARD PATCH — the save's last write — mid-flight */
    const gate = gateOf(); let reached = false;
    const up = s.AS.adminUpsert;
    s.AS.adminUpsert = async function(k, owner, v){ const body = JSON.parse(JSON.stringify(v)); if(k === ak){ reached = true; await gate.p; } return up.call(this, k, owner, body); };
    d.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [{ code: C1, list: [JSON.parse(JSON.stringify(card))] }],
             builder: d.fns.builderFromSet(Object.assign({}, stored, { refs: [ACTIVE, FORMREF] })) });
    d.$("sbName").value = "New name";
    const p = d.fns.saveSetFromBuilder();
    for(let i = 0; i < 200 && !reached; i++) await new Promise(r => setTimeout(r, 5));
    await d.fns.deleteAssignment(C1, "a-L");
    const delMsg = status(d);
    const deletesDuring = s.calls.filter(c => c[0] === "adminDelete").length;
    d.$("saSet").value = "pset-L"; d.els.saCodes = { selectedOptions: [{ value: C2 }] };
    d.$("saFree").value = ""; d.$("saLimit").value = ""; d.$("saExpires").value = ""; d.$("saHold").checked = false;
    await d.fns.assignSetFromForm();
    const saDuring = d.state().saMsg; everyMessage.push(saDuring);
    const assignsDuring = [...s.server.keys()].filter(k => k.indexOf("assign:" + C2 + ":") === 0).length;
    await d.fns.clearAssignments(C1);
    const clearMsg = status(d);
    const clearsDuring = s.calls.filter(c => c[0] === "adminDelete").length;
    gate.open(); await p;
    const LOCKED = "Another set or assignment change is still being saved — ";
    check(reached && deletesDuring === 0 && delMsg === LOCKED + "delete the assignment once it finishes." &&
          s.server.has(ak) && s.server.get(ak).value.setName === "New name" && s.server.get(ak).value.questionCount === 2,
      "an assignment Delete while the set save is patching that card is refused (the patch would have written the row back as a startable card)",
      JSON.stringify({ reached, deletesDuring, delMsg }));
    check(clearsDuring === 0 && clearMsg === LOCKED + "clear the assignments once it finishes." && s.server.has(ak) && s.mirror.has(ak),
      "Clear all assignments while the save is patching is refused the same way (review round 5, finding 1)", clearMsg);
    check(assignsDuring === 0 && saDuring === LOCKED + "assign once it finishes.",
      "Assign set while a set save runs is refused (it would stamp the pre-save name and count)", saDuring);
    /* the save's OWN reload put the saved set into `sets`, before the lock
       came off — nothing here seeds it (review round 5, finding 7) */
    const sL = d.state().sets.find(x => x.setId === "pset-L");
    check(!!sL && sL.name === "New name" && sL.refs.length === 2 && d.state().loads.setsLock.indexOf(1) !== -1 &&
          d.state().loads.setsLock.every(v => v === 1),
      "the edit save reloads `sets` itself, under the lock: the page holds the saved name and count before any other set write can start",
      JSON.stringify({ sL: sL && [sL.name, sL.refs.length], setsLock: d.state().loads.setsLock }));
    /* once the save settles both go through, Assign set with the SAVED name and count */
    await d.fns.assignSetFromForm();
    const c2 = [...s.server.keys()].filter(k => k.indexOf("assign:" + C2 + ":") === 0);
    check(d.state().setSaveInFlight === 0 && c2.length === 1 && s.server.get(c2[0]).value.setName === "New name" && s.server.get(c2[0]).value.questionCount === 2,
      "control: once the save settled, Assign set writes the saved name and count", c2.join(","));
    await d.fns.deleteAssignment(C1, "a-L");
    check(!s.server.has(ak) && !s.mirror.has(ak), "control: once the save settled, the assignment Delete goes through", status(d));
  });

  await run(async () => {
    /* final check, finding 3: a set Delete holds the page lock while it runs,
       and a builder left open on the deleted set becomes an unsaved NEW set,
       so its Save can't write the deleted id back (re-opening the unstarted
       assignments the confirm said would stop) */
    const stored = { setId: "pset-D", name: "Doomed", subject: "rw", refs: [ACTIVE, FORMREF], createdAt: "2026-09-01T00:00:00Z" };
    const s = makeStore({}); const d = build(s, { fetch: realFetch() }, { page: "origin" });
    s.seedBoth("pset:pset-D", stored);
    const gate = gateOf(); let reached = false;
    const del = s.AS.adminDelete;
    s.AS.adminDelete = async function(){ reached = true; await gate.p; return del.apply(this, arguments); };
    d.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [], builder: d.fns.builderFromSet(stored) });
    d.$("sbName").value = "Doomed";
    const p = d.fns.deleteSet("pset-D");
    for(let i = 0; i < 200 && !reached; i++) await new Promise(r => setTimeout(r, 5));
    const lockDuring = d.state().setSaveInFlight;
    const paintedLocked = d.state().paints.some(x => x.inFlight === 1) && d.$("setNewBtn").disabled === true && d.$("sbSaveBtn").disabled === true;
    await d.fns.saveSetFromBuilder();
    const upsertsDuring = s.calls.filter(c => c[0] === "adminUpsert").length;
    const listDuring = [d.fns.openSetInBuilder("pset-D"), d.fns.newSetInBuilder(), d.fns.deleteSetFromList("pset-D")];
    gate.open(); await p;
    const b = d.state().builder;
    check(reached && lockDuring === 1 && paintedLocked && upsertsDuring === 0 && JSON.stringify(listDuring) === "[false,false,false]",
      "a set Delete holds the page lock while it runs (painted locked): Save, Edit, New set and Delete all wait",
      JSON.stringify({ reached, lockDuring, paintedLocked, upsertsDuring, listDuring }));
    everyMessage.push(b ? b.msg : "");
    check(!s.server.has("pset:pset-D") && d.state().setSaveInFlight === 0 && d.$("setNewBtn").disabled === false &&
          !!b && b.setId === null && !("createdAt" in b) && JSON.stringify(b.storedKeys) === "[]" && b.refs.length === 2 &&
          b.msg === "This set was just deleted. Its questions are kept here as a NEW set: press Save set to save them under a new id, or Cancel to drop them.",
      "the builder open on the deleted set becomes an unsaved NEW set keeping its questions, says so, and the lock comes off", b && b.msg);
    await d.fns.saveSetFromBuilder();
    const rows = psetRows(s);
    check(rows.length === 1 && rows[0] !== "pset:pset-D" && d.state().builder === null,
      "its next Save set writes a NEW id — the deleted set is never recreated", rows.join(","));

    /* a rejected Delete deleted nothing: the builder stays on its set; a
       builder on ANOTHER set is untouched by a Delete that lands */
    const s2 = makeStore({ reject: true }); const d2 = build(s2);
    s2.seedBoth("pset:pset-D", stored);
    d2.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [], builder: d2.fns.builderFromSet(stored) });
    await d2.fns.deleteSet("pset-D");
    check(d2.state().builder.setId === "pset-D" && !d2.state().builder.msg && d2.state().setSaveInFlight === 0 && s2.server.has("pset:pset-D"),
      "a rejected Delete leaves the builder on its set and releases the lock", JSON.stringify(d2.state().builder));
    const keep = { setId: "pset-K", name: "Kept", subject: "rw", refs: [ACTIVE], createdAt: "2026-09-01T00:00:00Z" };
    const s3 = makeStore({}); const d3 = build(s3);
    s3.seedBoth("pset:pset-D", stored); s3.seedBoth("pset:pset-K", keep);
    d3.seed({ sets: [JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(keep))], assigns: [], builder: d3.fns.builderFromSet(keep) });
    await d3.fns.deleteSet("pset-D");
    check(!s3.server.has("pset:pset-D") && d3.state().builder.setId === "pset-K" && !d3.state().builder.msg,
      "a Delete of one set leaves a builder open on another set alone");
    /* the kept questions include a retired item: the advice says to remove
       it first (a bare "press Save set" would be refused — finding 6) */
    const withRetired = { setId: "pset-R", name: "Legacy", subject: "rw", refs: [RETIRED, ACTIVE], createdAt: "2026-09-01T00:00:00Z" };
    const s4 = makeStore({}); const d4 = build(s4);
    s4.seedBoth("pset:pset-R", withRetired);
    d4.seed({ sets: [JSON.parse(JSON.stringify(withRetired))], assigns: [], builder: d4.fns.builderFromSet(withRetired) });
    await d4.fns.deleteSet("pset-R");
    const m4 = d4.state().builder && d4.state().builder.msg; everyMessage.push(m4 || "");
    check(/^This set was just deleted\. Its questions are kept here as a NEW set\. A retired bank item can't go into a new set: remove bank-202608-salvage q0032 first, then press Save set to save the rest under a new id, or Cancel to drop them\.$/.test(m4 || ""),
      "…and when those questions include a retired item, the advice names it to remove first", m4);
    /* a bank item missing from the index is refused by a new set's save just
       the same, so the advice names it too */
    const UNKNOWN = { type: "bank", bankId: "bank-202608-salvage", qid: "q9999" };
    const withUnknown = { setId: "pset-U", name: "Odd", subject: "rw", refs: [ACTIVE, UNKNOWN], createdAt: "2026-09-01T00:00:00Z" };
    const s5 = makeStore({}); const d5 = build(s5, { fetch: realFetch() }, { page: "origin" });
    s5.seedBoth("pset:pset-U", withUnknown);
    d5.seed({ sets: [JSON.parse(JSON.stringify(withUnknown))], assigns: [], builder: d5.fns.builderFromSet(withUnknown) });
    await d5.fns.deleteSet("pset-U");
    const m5 = d5.state().builder && d5.state().builder.msg; everyMessage.push(m5 || "");
    check(/Its questions are kept here as a NEW set\. A bank item that is retired or not in the bank index can't go into a new set: remove bank-202608-salvage q9999 first, then press Save set/.test(m5 || ""),
      "…and a bank item missing from the index is named the same way", m5);
    d5.$("sbName").value = "Odd";
    await d5.fns.saveSetFromBuilder();
    check(/q9999 \(not in the bank index\)/.test(msgOf(d5)) && psetRows(s5).length === 0,
      "control: the advice is true — that item really is refused by the new set's save", msgOf(d5));
  });

  await run(async () => {
    /* review round 5, findings 3/5/8: the lock works BOTH ways — Assign set,
       Clear all and an assignment Delete each TAKE it, so a Save or Delete of
       a set pressed during their writes is refused (the save would patch, and
       the delete would confirm, from a list without the cards being written) */
    const stored = { setId: "pset-A", name: "Old name", subject: "rw", refs: [ACTIVE], createdAt: "2026-09-01T00:00:00Z" };
    const s = makeStore({}); const d = build(s, { fetch: realFetch() }, { page: "origin" });
    s.seedBoth("pset:pset-A", stored);
    const gate = gateOf(); let reached = false;
    const up = s.AS.adminUpsert;
    s.AS.adminUpsert = async function(k, owner, v){ const body = JSON.parse(JSON.stringify(v)); if(k.indexOf("assign:" + C2 + ":") === 0){ reached = true; await gate.p; } return up.call(this, k, owner, body); };
    d.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [],
             builder: d.fns.builderFromSet(Object.assign({}, stored, { refs: [ACTIVE, FORMREF] })) });
    d.$("sbName").value = "New name";
    d.$("saSet").value = "pset-A"; d.els.saCodes = { selectedOptions: [{ value: C1 }, { value: C2 }] };
    d.$("saFree").value = ""; d.$("saLimit").value = ""; d.$("saExpires").value = ""; d.$("saHold").checked = true;
    const pA = d.fns.assignSetFromForm();
    for(let i = 0; i < 200 && !reached; i++) await new Promise(r => setTimeout(r, 5));
    const lockDuring = d.state().setSaveInFlight;
    const saveBtnDuring = d.$("sbSaveBtn").disabled, newBtnDuring = d.$("setNewBtn").disabled;
    await d.fns.saveSetFromBuilder();
    const setUpsertsDuring = s.calls.filter(c => c[0] === "adminUpsert" && c[1] === "pset:pset-A").length;
    const delDuring = d.fns.deleteSetFromList("pset-A");
    await d.fns.clearAssignments(C1);
    const clearMsg = status(d);
    const pSecond = d.fns.assignSetFromForm();       // never awaited behind the closed gate: a regressed refusal would hang there
    const secondSettled = await Promise.race([pSecond.then(() => true), new Promise(r => setTimeout(() => r(false), 500))]);
    const secondAssign = d.state().saMsg;
    gate.open(); await pA; await pSecond;
    const cards = [...s.server.entries()].filter(([k]) => k.indexOf("assign:") === 0).map(([, r]) => r.value);
    check(reached && lockDuring === 1 && saveBtnDuring === true && newBtnDuring === true && setUpsertsDuring === 0 && delDuring === false &&
          s.server.has("pset:pset-A") && s.calls.filter(c => c[0] === "adminDelete").length === 0 &&
          clearMsg === "Another set or assignment change is still being saved — clear the assignments once it finishes." &&
          secondSettled === true && secondAssign === "Another set or assignment change is still being saved — assign once it finishes.",
      "while Assign set is writing, it holds the page lock (painted): Save set, set Delete, Clear all and a second Assign are all refused",
      JSON.stringify({ reached, lockDuring, saveBtnDuring, newBtnDuring, setUpsertsDuring, delDuring, clearMsg, secondSettled, secondAssign }));
    check(cards.length === 2 && cards.every(a => a.setId === "pset-A" && a.setName === "Old name" && a.questionCount === 1 && a.holdRelease === true) &&
          d.state().setSaveInFlight === 0 && /^Assigned “Old name” to AS-ABCDEFGH, AS-JKLMNPQR \(on the server\)\.$/.test(d.state().saMsg) &&
          d.state().assigns.reduce((n, e) => n + e.list.length, 0) === 2 && d.state().loads.assignsLock.slice(-1)[0] === 1,
      "…both cards land with the name and count the set had, `assigns` holds them BEFORE the lock comes off, then the lock is released",
      JSON.stringify({ cards: cards.map(a => [a.setName, a.questionCount]), saMsg: d.state().saMsg, assignsLock: d.state().loads.assignsLock }));
    /* now the Save goes through, and its card patch reaches BOTH new cards */
    await d.fns.saveSetFromBuilder();
    const after = [...s.server.entries()].filter(([k]) => k.indexOf("assign:") === 0).map(([, r]) => r.value);
    check(s.server.get("pset:pset-A").value.name === "New name" && after.length === 2 && after.every(a => a.setName === "New name" && a.questionCount === 2),
      "control: once Assign set settled, Save set goes through and patches every card it wrote", JSON.stringify(after.map(a => [a.setName, a.questionCount])));

    /* the form is read ONCE, before the loop: a tab switch mid-loop takes the
       form's nodes away (the old code read #saHold per card, and on a real
       page a missing node throws) — every card keeps what was pressed */
    const s5 = makeStore({}); const d5 = build(s5, { fetch: realFetch() }, { page: "origin" });
    s5.seedBoth("pset:pset-A", stored);
    const g5 = gateOf(); let r5 = false;
    const up5 = s5.AS.adminUpsert;
    s5.AS.adminUpsert = async function(k, owner, v){ const body = JSON.parse(JSON.stringify(v)); if(!r5 && k.indexOf("assign:") === 0){ r5 = true; await g5.p; } return up5.call(this, k, owner, body); };
    d5.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [] });
    d5.$("saSet").value = "pset-A"; d5.els.saCodes = { selectedOptions: [{ value: C1 }, { value: C2 }] };
    d5.$("saFree").value = ""; d5.$("saLimit").value = "35"; d5.$("saExpires").value = ""; d5.$("saHold").checked = true;
    const p5 = d5.fns.assignSetFromForm();
    for(let i = 0; i < 200 && !r5; i++) await new Promise(r => setTimeout(r, 5));
    d5.setTab("students"); ["saSet", "saHold", "saLimit", "saExpires", "saFree", "saCodes"].forEach(id => { delete d5.els[id]; });   // the Sets tab's form is gone
    g5.open(); await p5;
    const c5 = [...s5.server.entries()].filter(([k]) => k.indexOf("assign:") === 0).map(([, r]) => r.value);
    check(r5 && c5.length === 2 && c5.every(a => a.holdRelease === true && a.timeLimitMinutes === 35 && a.setId === "pset-A"),
      "Assign set reads the form once, before its loop: a tab switch mid-loop can't change (or break) the later cards",
      JSON.stringify(c5.map(a => [a.holdRelease, a.timeLimitMinutes])));

    /* Clear all and an assignment Delete hold the lock while they write */
    const s2 = makeStore({}); const d2 = build(s2, { fetch: realFetch() }, { page: "origin" });
    s2.seedBoth("pset:pset-A", stored);
    s2.seedBoth("assign:" + C1 + ":a-1", { assignmentId: "a-1", kind: "set", setId: "pset-A", setName: "Old name", questionCount: 1 }, C1);
    s2.seedBoth("assign:" + C1 + ":a-2", { assignmentId: "a-2", kind: "set", setId: "pset-A", setName: "Old name", questionCount: 1 }, C1);
    const g2 = gateOf(); let r2 = false;
    const del2 = s2.AS.adminDelete;
    s2.AS.adminDelete = async function(){ if(!r2){ r2 = true; await g2.p; } return del2.apply(this, arguments); };
    d2.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [],
              builder: d2.fns.builderFromSet(Object.assign({}, stored, { refs: [ACTIVE, FORMREF] })) });
    d2.$("sbName").value = "New name";
    await d2.fns.loadAssignsAndBugs();                  // the page's real list: both cards (a seeded [] can't tell a reload from none)
    const preC = d2.state().assigns.reduce((n, e) => n + e.list.length, 0);
    const pC = d2.fns.clearAssignments(C1);
    for(let i = 0; i < 200 && !r2; i++) await new Promise(r => setTimeout(r, 5));
    const lockC = d2.state().setSaveInFlight;
    await d2.fns.saveSetFromBuilder();
    const upsC = s2.calls.filter(c => c[0] === "adminUpsert").length;
    g2.open(); await pC;
    check(r2 && lockC === 1 && upsC === 0 && d2.state().setSaveInFlight === 0 && ![...s2.server.keys()].some(k => k.indexOf("assign:") === 0) &&
          /^Cleared every assignment for AS-ABCDEFGH/.test(status(d2)),
      "Clear all holds the page lock while it deletes: a Save pressed meanwhile is refused; the clear completes and releases it",
      JSON.stringify({ r2, lockC, upsC }));
    const nowC = d2.state().assigns.reduce((n, e) => n + e.list.length, 0);
    check(preC === 2 && nowC === 0 && d2.state().loads.assignsLock.slice(-1)[0] === 1,
      "Clear all reloads `assigns` BEFORE it releases the lock (the cleared cards leave the page's list)",
      JSON.stringify({ preC, nowC, lk: d2.state().loads.assignsLock }));
    const s3 = makeStore({}); const d3 = build(s3, { fetch: realFetch() }, { page: "origin" });
    s3.seedBoth("pset:pset-A", stored);
    s3.seedBoth("assign:" + C1 + ":a-1", { assignmentId: "a-1", kind: "set", setId: "pset-A", setName: "Old name", questionCount: 1 }, C1);
    s3.seedBoth("assign:" + C1 + ":a-2", { assignmentId: "a-2", kind: "set", setId: "pset-A", setName: "Old name", questionCount: 1 }, C1);
    const g3 = gateOf(); let r3 = false;
    const del3 = s3.AS.adminDelete;
    s3.AS.adminDelete = async function(){ r3 = true; await g3.p; return del3.apply(this, arguments); };
    d3.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [],
              builder: d3.fns.builderFromSet(Object.assign({}, stored, { refs: [ACTIVE, FORMREF] })) });
    d3.$("sbName").value = "New name";
    await d3.fns.loadAssignsAndBugs();
    const preD = d3.state().assigns.reduce((n, e) => n + e.list.length, 0);
    const pD = d3.fns.deleteAssignment(C1, "a-1");
    for(let i = 0; i < 200 && !r3; i++) await new Promise(r => setTimeout(r, 5));
    const lockD = d3.state().setSaveInFlight;
    await d3.fns.saveSetFromBuilder();
    const upsD = s3.calls.filter(c => c[0] === "adminUpsert").length;
    g3.open(); await pD;
    check(r3 && lockD === 1 && upsD === 0 && d3.state().setSaveInFlight === 0 && !s3.server.has("assign:" + C1 + ":a-1") && s3.server.has("assign:" + C1 + ":a-2"),
      "an assignment Delete holds the page lock while it writes: a Save pressed meanwhile is refused; the delete completes and releases it",
      JSON.stringify({ r3, lockD, upsD }));
    const idsD = [].concat(...d3.state().assigns.map(e => (e.list || []).map(a => a.assignmentId)));
    check(preD === 2 && idsD.length === 1 && idsD[0] === "a-2" && d3.state().loads.assignsLock.slice(-1)[0] === 1,
      "an assignment Delete reloads `assigns` BEFORE it releases the lock (the deleted card leaves the page's list)",
      JSON.stringify({ preD, idsD, lk: d3.state().loads.assignsLock }));

    /* a cancelled confirm leaves no lock behind */
    const s4 = makeStore({}); const d4 = build(s4, { confirm: () => false });
    s4.seedBoth("assign:" + C1 + ":a-1", { assignmentId: "a-1", kind: "set", setId: "pset-A" }, C1);
    s4.seedBoth("pset:pset-A", stored);
    d4.seed({ sets: [JSON.parse(JSON.stringify(stored))], assigns: [] });
    await d4.fns.deleteAssignment(C1, "a-1");               // its last assignment: the confirm is asked, and declined
    await d4.fns.clearAssignments(C1);
    await d4.fns.deleteSet("pset-A");
    check(d4.state().setSaveInFlight === 0 && s4.server.has("assign:" + C1 + ":a-1") && s4.server.has("pset:pset-A") &&
          !s4.calls.some(c => c[0] === "adminDelete") && d4.$("setNewBtn").disabled === false,
      "a declined confirm (last-assignment Delete, Clear all, set Delete) deletes nothing and leaves the page unlocked");
  });

  await run(async () => {
    /* an exception after the lock must never leave the builder locked (finding 22) */
    const s = makeStore({ remote: false, localThrow: true }); const d = build(s);
    d.seed({ builder: { setId: null, name: "Boom", subject: "rw", refs: [FORMREF] }, sets: [], assigns: [] });
    d.$("sbName").value = "Boom";
    let threw = false;
    try{ await d.fns.saveSetFromBuilder(); }catch(e){ threw = true; }
    check(threw && d.state().builder !== null && d.state().builder.saving === false && /something went wrong/.test(msgOf(d)) &&
          /something went wrong/.test(d.$("sbMsg").textContent) && d.$("sbSaveBtn").disabled === false,
      "a storage exception mid-save still unlocks the builder and RE-RENDERS it (Save enabled, 'something went wrong' shown)",
      [threw, d.$("sbMsg").textContent, d.$("sbSaveBtn").disabled].join(" | "));
  });

  /* =================== 9e. the upload button: mirror → server, never the other way =================== */
  await run(async () => {
    /* the REAL loadFromStorage (realLoad): the upload's reload must keep the
       summary in front of its own status line — a counting stub hid that */
    const s = makeStore({}); const d = build(s, null, null, { realLoad: true });
    /* realistic shapes, so the owner derivation is actually tested: a record
       keeps the code AS TYPED in student.code and the normalised key in
       student.key (the owner); a bug row is keyed bug:<ts>-<rand> and carries
       its code only in studentCode */
    const att = { attemptId: "attempt:202606asiav1:1:aa", status: "completed", student: { key: C1, code: "as-abcdefgh" } };
    s.mirror.set(att.attemptId, att);
    s.mirror.set("assign:" + C1 + ":a-1", { assignmentId: "a-1" });
    s.mirror.set("bug:1700000000-abcd", { studentCode: C1, text: "x" });
    s.mirror.set("pset:pset-1", { setId: "pset-1", name: "S" });
    s.mirror.set("student:" + C1, { displayName: "Erin K" });
    s.seedBoth("attempt:202606asiav1:2:bb", { attemptId: "attempt:202606asiav1:2:bb", student: { key: C1 } }, C1);   // already on the server → skipped
    const before = s.snapshot();
    await d.fns.migrateLocalToServer();
    const t = status(d);
    const owner = k => s.server.has(k) ? s.server.get(k).owner : "ABSENT";
    check(owner(att.attemptId) === C1 && owner("assign:" + C1 + ":a-1") === C1 && owner("bug:1700000000-abcd") === C1 && owner("pset:pset-1") === null && owner("student:" + C1) === C1,
      "upload: every prefix reaches the server with the right owner (the normalised key, never a timestamp or the code as typed), display names included",
      JSON.stringify({ att: owner(att.attemptId), bug: owner("bug:1700000000-abcd") }));
    check(s.snapshot() === before && /^Upload finished — 5 sent, 1 already on the server\. \d+ attempt\(s\) in shared storage\./.test(t) &&
          t.indexOf("Upload finished") === t.lastIndexOf("Upload finished") && d.state().loads.storage === 1,
      "upload: the mirror is untouched (the reload's pull copies back exactly what went up), the count is honest, and the summary stays in front of the reload's line, once", t);
  });
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s, null, null, { realLoad: true });
    s.mirror.set("student:" + C1, { displayName: "Erin K" });
    s.mirror.set("assign:" + C1 + ":a-1", { assignmentId: "a-1" });
    const before = s.snapshot();
    await d.fns.migrateLocalToServer();
    check(s.snapshot() === before && s.server.size === 0 && /^Upload finished — 0 sent, 0 already on the server, 2 failed\. \d+ attempt\(s\) in shared storage\./.test(status(d)),
      "upload rejected: nothing changes anywhere, failures counted, summary in front of the reload's line", status(d));
  });

  /* =================== 10. assignSetFromForm =================== */
  console.log("--- 10. assignSetFromForm ---");
  await run(async () => {
    const s = makeStore({ reject: (op, k) => k.indexOf(C2) !== -1 }); const d = build(s);
    d.seed({ sets: [{ setId: "pset-1", name: "Set A", subject: "math", refs: [REF] }], assigns: [] });
    d.$("saSet").value = "pset-1"; d.els.saCodes = { selectedOptions: [{ value: C1 }, { value: C2 }] };
    d.$("saFree").value = ""; d.$("saLimit").value = ""; d.$("saExpires").value = ""; d.$("saHold").checked = true;
    await d.fns.assignSetFromForm();
    const t = d.state().saMsg; everyMessage.push(t);   // the module var render() re-emits — the old node is wiped
    const keys = [...s.server.keys()];
    check(keys.length === 1 && keys[0].indexOf("assign:" + C1 + ":a-") === 0 && s.server.get(keys[0]).value.holdRelease === true
      && ![...s.mirror.keys()].some(k => k.indexOf(C2) !== -1),
      "partial set assignment: the accepted code is on server and mirror, the rejected code is nowhere");
    check(/^Assigned “Set A” to AS-ABCDEFGH \(on the server\)\. Not saved — assignment a-\S+ for AS-JKLMNPQR/.test(t) && noSync(t),
      "partial set assignment: message names the assigned code and the rejected row", t);
  });
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    d.seed({ sets: [{ setId: "pset-1", name: "Set A", subject: "math", refs: [REF] }], assigns: [] });
    d.$("saSet").value = "pset-1"; d.els.saCodes = { selectedOptions: [{ value: C1 }] };
    const before = s.snapshot();
    await d.fns.assignSetFromForm();
    const t = d.state().saMsg; everyMessage.push(t);   // the module var render() re-emits — the old node is wiped
    check(s.snapshot() === before && s.server.size === 0 && /^Not saved — assignment a-\S+ for AS-ABCDEFGH/.test(t),
      "rejected set assignment: nothing anywhere, message names the row", t);
  });
  await run(async () => {
    /* review round 6, finding 1: after an assign the form is EMPTIED (as
       before the lock), so pressing Assign again — a retry after a partial
       rejection, or one more code added — can't re-send codes that landed */
    const s = makeStore({ reject: (op, k) => k.indexOf(C2) !== -1 }); const d = build(s);
    s.seedBoth("pset:pset-1", { setId: "pset-1", name: "Set A", subject: "math", refs: [REF] });
    d.seed({ sets: [{ setId: "pset-1", name: "Set A", subject: "math", refs: [REF] }], assigns: [] });
    d.$("saSet").value = "pset-1"; d.$("saFree").value = C1 + ", " + C2; d.$("saLimit").value = "30"; d.$("saExpires").value = ""; d.$("saHold").checked = true;
    await d.fns.assignSetFromForm();
    const t1 = d.state().saMsg; everyMessage.push(t1);
    const form = { saFree: d.$("saFree").value, saSet: d.$("saSet").value, saLimit: d.$("saLimit").value, saHold: d.$("saHold").checked };
    await d.fns.assignSetFromForm();                    // the tutor presses Assign again
    const mine = [...s.server.keys()].filter(k => k.indexOf("assign:" + C1 + ":") === 0);
    check(/^Assigned “Set A” to AS-ABCDEFGH/.test(t1) && form.saFree === "" && form.saSet === "" && form.saLimit === "" && form.saHold === false && mine.length === 1,
      "after an assign (partial rejection here) the form is emptied, so a second press can't give a code that landed a duplicate card",
      JSON.stringify({ form, cardsForC1: mine.length }));
  });

  /* =================== 12. a Refresh pull vs a concurrent tutor write (2026-10-06) =================== */
  console.log("--- 12. Refresh pull vs a concurrent tutor write: the stale snapshot must not land on the written key ---");
  /* THE MODEL. Remote mode's mirror is localStorage, so on the page a pull's
     tail (its row loop, list/get, loadAssignsAndBugs, renderAll) runs whole
     inside the macrotask of its last page response, and a write's tail
     (the note, setLocal/remove, the action's own reload) inside its own.
     Only two orderings exist. A: the snapshot predates the write and its
     rows land AFTER it — the skip Set's job: the stale row must not land.
     B: the rows land BEFORE the server accepts — the write's mirror step
     wins, and the action's own reload repairs the page's lists
     (toggleRelease and deleteAttempt, the two actions with no reload, write
     into the record / the tombs map the page holds now). Each case here:
     Refresh starts and its
     snapshot is TAKEN (the pre-write rows); the tutor writes; THEN the
     snapshot lands (A) — or, with the server call gated, the snapshot lands
     first and the call is opened afterwards (B). The mirror, and the page's
     lists reloaded from it, must hold the write. Every case also seeds a
     SERVER-ONLY control row (student:C2) and checks it reached the mirror
     and the profiles map, so a pull that lands nothing cannot pass; and
     run()'s stale-pull rule fails any pull write the server does not hold
     at that moment. On the pre-fix dashboard (DASHBOARD_SRC) the snapshot
     wins; with the pull ignoring its predicate (ATTEMPTS_SRC=<mutant>) it
     wins too. The realPull rebinding takes ONE unpaged snapshot; paging is
     proven in tests/tombstone.test.js. loadFromStorage here is the REAL one
     (build's realLoad). */
  const RACE = o => {
    const s = makeStore(Object.assign({ holdPull: true }, o || {}));
    const d = build(s, null, null, { realLoad: true });
    s.server.set("student:" + C2, { owner: C2, value: { displayName: "Other" } });   // the control row: server-only until the pull lands it
    return { s, d };
  };
  /* the pull itself landed: the control row is in the mirror and in the reloaded profiles map */
  const landed = (s, d) => !!s.mirror.get("student:" + C2) && s.mirror.get("student:" + C2).displayName === "Other" && d.state().profiles[C2] === "Other";
  const FREF = { type: "form", testId: "202606asiav1", moduleId: "2026-june-asia-v1-rw1", qid: "re1-q1" };
  const OLD_SET = { setId: "pset-1", name: "Old name", subject: "rw", refs: [FREF], createdAt: "2026-09-01T00:00:00Z" };
  const OLD_CARD = { assignmentId: "a-1", kind: "set", category: "practice", setId: "pset-1", setName: "Old name", questionCount: 1, holdRelease: true, completedAttemptId: null };
  const CARD_KEY = "assign:" + C1 + ":a-1";
  const cl = v => JSON.parse(JSON.stringify(v));
  /* gate one kind of server call by key prefix: it waits until the case
     opens the gate (ordering B); the gated call is logged as "gated:<op>"
     the moment it is made, since the real call (and its log line) only
     happens once the gate opens */
  const gatePut = (s, prefix) => { const g = gateOf(); const real = s.AS.adminUpsert;
    s.AS.adminUpsert = async function(k, o, v){ const body = cl(v); if(k.indexOf(prefix) === 0){ s.calls.push(["gated:adminUpsert", k]); await g.p; } return real.call(this, k, o, body); }; return g; };
  const gateDelete = (s, prefix) => { const g = gateOf(); const real = s.AS.adminDelete;
    s.AS.adminDelete = async function(k){ if(k.indexOf(prefix) === 0){ s.calls.push(["gated:adminDelete", k]); await g.p; } return real.call(this, k); }; return g; };
  const until = async pred => { for(let i = 0; i < 200 && !pred(); i++) await new Promise(r => setTimeout(r, 2)); return pred(); };
  const inFlight = (s, op, key) => s.calls.some(c => c[0] === "gated:" + op && c[1] === key);

  await run(async () => {
    /* Save set (a rename, with its assignment-card patch), ordering A: the
       three harms the limit named — the page SHOWS, then RE-SAVES, the
       pre-write copy */
    const { s, d } = RACE();
    s.seedBoth("pset:pset-1", OLD_SET); s.seedBoth(CARD_KEY, OLD_CARD, C1);
    d.seed({ sets: [cl(OLD_SET)], assigns: [{ code: C1, list: [cl(OLD_CARD)] }], builder: d.fns.builderFromSet(cl(OLD_SET)) });
    d.$("sbName").value = "New name";
    const pull = d.fns.loadFromStorage();                 // Refresh: the snapshot is taken now — Old name
    await s.pullStarted;
    check(d.state().pullsInFlight === 1, "while the pull is held, one key set is registered", String(d.state().pullsInFlight));
    await d.fns.saveSetFromBuilder();                     // server first, then mirror: New name; the card patched
    check(s.server.get("pset:pset-1").value.name === "New name" && s.mirror.get("pset:pset-1").name === "New name" &&
          s.server.get(CARD_KEY).value.setName === "New name",
      "the save landed on the server and the mirror while the pull was in flight");
    s.releasePull(); await pull;                          // the stale snapshot lands
    check(landed(s, d), "the pull landed: its server-only control row reached the mirror and the profiles map");
    check(s.mirror.get("pset:pset-1").name === "New name", "the stale pull did not put the pre-save set back into the mirror", JSON.stringify(s.mirror.get("pset:pset-1")));
    check(s.mirror.get(CARD_KEY).setName === "New name", "…nor the pre-patch assignment card", JSON.stringify(s.mirror.get(CARD_KEY)));
    const st = d.state();
    check(st.sets.length === 1 && st.sets[0].name === "New name", "the Sets list, reloaded after the pull, shows the saved name", JSON.stringify(st.sets));
    check(st.assigns.length === 1 && st.assigns[0].list[0].setName === "New name", "the assignment card, reloaded after the pull, shows the patched name");
    check(st.pullsInFlight === 0, "the pull's key set is released once it settled", String(st.pullsInFlight));
    /* the RE-SAVE harm: Edit from the list, Save unchanged — the server must keep the saved name */
    check(d.fns.openSetInBuilder("pset-1") === true, "Edit opens the set from the reloaded list");
    d.$("sbName").value = d.state().builder.name;
    await d.fns.saveSetFromBuilder();
    check(s.server.get("pset:pset-1").value.name === "New name", "an Edit-then-Save after the pull keeps the saved name on the server (the revert the limit described)", JSON.stringify(s.server.get("pset:pset-1").value));
  });
  await run(async () => {
    /* Save set, ordering B: the snapshot lands while the server call is in
       flight; once the server accepts, the write's mirror step wins and the
       save's own reload shows it */
    const { s, d } = RACE();
    s.seedBoth("pset:pset-1", OLD_SET);
    d.seed({ sets: [cl(OLD_SET)], assigns: [], builder: d.fns.builderFromSet(cl(OLD_SET)) });
    d.$("sbName").value = "New name";
    const g = gatePut(s, "pset:");
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    const save = d.fns.saveSetFromBuilder();
    check(await until(() => inFlight(s, "adminUpsert", "pset:pset-1")), "the set write is in flight");
    s.releasePull(); await pull;
    check(s.mirror.get("pset:pset-1").name === "Old name" && landed(s, d),
      "before the server accepts, the mirror still holds the pre-save copy (the snapshot was the truth then)", JSON.stringify(s.mirror.get("pset:pset-1")));
    g.open(); await save;
    check(s.server.get("pset:pset-1").value.name === "New name" && s.mirror.get("pset:pset-1").name === "New name" &&
          d.state().sets[0].name === "New name" && d.state().pullsInFlight === 0,
      "once the server accepts, the write's mirror step wins and the save's own reload shows the saved name", JSON.stringify(d.state().sets));
  });
  await run(async () => {
    /* the ASSIGN harm: Assign set after the pull must stamp the SAVED name */
    const { s, d } = RACE();
    s.seedBoth("pset:pset-1", OLD_SET);
    d.seed({ sets: [cl(OLD_SET)], assigns: [], builder: d.fns.builderFromSet(cl(OLD_SET)) });
    d.$("sbName").value = "New name";
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    await d.fns.saveSetFromBuilder();
    s.releasePull(); await pull;
    check(landed(s, d), "the pull landed");
    d.$("saSet").value = "pset-1"; d.els.saCodes = { selectedOptions: [{ value: C1 }] };
    d.$("saFree").value = ""; d.$("saLimit").value = ""; d.$("saExpires").value = ""; d.$("saHold").checked = false;
    await d.fns.assignSetFromForm();
    const k = [...s.server.keys()].find(x => x.indexOf("assign:" + C1 + ":a-") === 0);
    check(!!k && s.server.get(k).value.setName === "New name" && s.mirror.get(k).setName === "New name",
      "Assign set after the pull stamps the saved name on the card, not the snapshot's", k ? JSON.stringify(s.server.get(k).value) : "no card");
  });
  await run(async () => {
    /* set Delete, ordering A: the stale snapshot must not revive it */
    const { s, d } = RACE();
    s.seedBoth("pset:pset-2", { setId: "pset-2", name: "Set B", subject: "math", refs: [] });
    d.seed({ sets: [{ setId: "pset-2", name: "Set B", subject: "math", refs: [] }], assigns: [] });
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    await d.fns.deleteSet("pset-2");
    check(!s.server.has("pset:pset-2") && !s.mirror.has("pset:pset-2"), "the delete landed while the pull was in flight");
    s.releasePull(); await pull;
    check(landed(s, d), "the pull landed");
    check(!s.mirror.has("pset:pset-2"), "the stale pull did not revive the deleted set in the mirror");
    check(!d.state().sets.some(x => x.setId === "pset-2"), "the Sets list, reloaded after the pull, does not list it", JSON.stringify(d.state().sets));
  });
  await run(async () => {
    /* set Delete, ordering B: the snapshot lands while the server delete is in flight */
    const { s, d } = RACE();
    s.seedBoth("pset:pset-2", { setId: "pset-2", name: "Set B", subject: "math", refs: [] });
    d.seed({ sets: [{ setId: "pset-2", name: "Set B", subject: "math", refs: [] }], assigns: [] });
    const g = gateDelete(s, "pset:");
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    const del = d.fns.deleteSet("pset-2");
    check(await until(() => inFlight(s, "adminDelete", "pset:pset-2")), "the set delete is in flight");
    s.releasePull(); await pull;
    check(s.mirror.has("pset:pset-2") && landed(s, d), "before the server accepts, the mirror still holds the set (the snapshot was the truth then)");
    g.open(); await del;
    check(!s.server.has("pset:pset-2") && !s.mirror.has("pset:pset-2") && !d.state().sets.some(x => x.setId === "pset-2") && d.state().pullsInFlight === 0,
      "once the server accepts, the mirror drops the set and the delete's own reload drops it from the list", JSON.stringify(d.state().sets));
  });
  await run(async () => {
    /* an assignment Delete: same, and the sibling row the snapshot carries still lands */
    const { s, d } = RACE();
    s.seedBoth(CARD_KEY, { assignmentId: "a-1", testId: "202606asiav1" }, C1);
    s.seedBoth("assign:" + C1 + ":a-2", { assignmentId: "a-2", testId: "202606asiav1" }, C1);
    s.mirror.delete("assign:" + C1 + ":a-2");             // only the server has a-2: the pull must still bring it
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    await d.fns.deleteAssignment(C1, "a-1");
    s.releasePull(); await pull;
    check(landed(s, d), "the pull landed");
    check(!s.mirror.has(CARD_KEY) && s.mirror.has("assign:" + C1 + ":a-2"),
      "the stale pull did not revive the deleted assignment, and its untouched sibling still landed");
    const mine = (d.state().assigns.find(e => e.code === C1) || { list: [] }).list.map(a => a.assignmentId);
    check(mine.indexOf("a-1") === -1 && mine.indexOf("a-2") !== -1, "the assignments list, reloaded after the pull, shows the sibling and not the deleted card", mine.join(","));
  });
  await run(async () => {
    /* Clear all assignments: every row it deleted stays gone */
    const { s, d } = RACE();
    s.seedBoth(CARD_KEY, { assignmentId: "a-1", testId: "202606asiav1" }, C1);
    s.seedBoth("assign:" + C1 + ":a-2", { assignmentId: "a-2", testId: "202606asiav1" }, C1);
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    await d.fns.clearAssignments(C1);
    s.releasePull(); await pull;
    check(landed(s, d) && !s.mirror.has(CARD_KEY) && !s.mirror.has("assign:" + C1 + ":a-2"),
      "the stale pull revived neither cleared row");
    const mine = (d.state().assigns.find(e => e.code === C1) || { list: [] }).list;
    check(mine.length === 0, "the assignments list, reloaded after the pull, has no card for the code", JSON.stringify(mine));
  });
  await run(async () => {
    /* a release, ordering A: the stale snapshot must not un-release it (the
       key-based skip is direction-blind, so one direction pins it here; the
       re-apply, which carries a direction, is pinned both ways in B) */
    const { s, d } = RACE();
    const rec = { attemptId: "attempt:202606asiav1:1:aa", status: "completed", released: false, student: { key: C1, code: C1 } };
    s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [cl(rec)] });
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    await d.fns.toggleRelease(rec.attemptId);
    check(s.server.get(rec.attemptId).value.released === true && s.mirror.get(rec.attemptId).released === true, "the release landed while the pull was in flight");
    s.releasePull(); await pull;
    check(landed(s, d), "the pull landed");
    check(s.mirror.get(rec.attemptId).released === true, "the stale pull did not un-release the attempt in the mirror");
    check(d.state().recs.length === 1 && d.state().recs[0].released === true, "the attempts table, reloaded after the pull, shows it released");
  });
  await run(async () => {
    /* a release, ordering B: the snapshot lands while the server call is in
       flight and replaces `recs` under the toggle — toggleRelease has no
       reload after its write, so it re-applies the flip to the record the
       page holds now. Both directions, since the re-apply carries one: a
       re-apply hard-coded to `true` would pass the release and ship an
       un-release that shows Released while server and mirror hold false. */
    for(const from of [false, true]){
      const { s, d } = RACE();
      const rec = { attemptId: "attempt:202606asiav1:1:aa", status: "completed", released: from, student: { key: C1, code: C1 } };
      s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [cl(rec)] });
      const g = gatePut(s, "attempt:");
      const pull = d.fns.loadFromStorage(); await s.pullStarted;
      const tog = d.fns.toggleRelease(rec.attemptId);
      const word = from ? "un-release" : "release";
      check(await until(() => inFlight(s, "adminUpsert", rec.attemptId)), "the " + word + " write is in flight");
      s.releasePull(); await pull;
      check(d.state().recs[0].released === from && landed(s, d), word + ": before the server accepts, the reloaded table shows the pre-flip copy (the snapshot was the truth then)");
      g.open(); await tog;
      check(s.server.get(rec.attemptId).value.released === !from && s.mirror.get(rec.attemptId).released === !from && d.state().recs[0].released === !from,
        word + ": once the server accepts, the mirror holds the flip and the record the page holds NOW carries it too", JSON.stringify(d.state().recs[0]));
      check((from ? /^Un-released — / : /^Released — /).test(status(d)), word + ": …and the status says so", status(d));
    }
  });
  await run(async () => {
    /* createAssignment with a name typed: the profile write is its first
       await, and a Refresh landing meanwhile ends in a plain render that
       rebuilds the Assignments form with its defaults — the form must have
       been read BEFORE that await, or the card lands for the wrong test */
    const { s, d } = RACE();
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afFree").value = ""; d.$("afName").value = "Erin K";
    d.$("afTest").value = "202606asiav1"; d.$("afCat").value = "test"; d.$("afTiming").value = "1.5";
    d.$("afOpens").value = "2026-10-10"; d.$("afExpires").value = "2026-12-31";
    const g = gatePut(s, "student:");
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    const create = d.fns.createAssignment();
    check(await until(() => inFlight(s, "adminUpsert", "student:" + C1)), "the profile write is in flight");
    s.releasePull(); await pull;
    check(d.$("afTest").value === "" && d.$("afExpires").value === "" && landed(s, d), "the Refresh's render emptied the form while the profile write was in flight");
    g.open(); await create;
    const k = [...s.server.keys()].find(x => x.indexOf("assign:" + C1 + ":a-") === 0);
    const card = k ? s.server.get(k).value : null;
    check(!!card && card.testId === "202606asiav1" && card.category === "test" && card.timing === 1.5 && /^\d{6}$/.test(String(card.startCode)) &&
          card.windowOpens === new Date("2026-10-10T00:00:00").toISOString() && card.expiresAt === new Date("2026-12-31T23:59:00").toISOString(),
      "the card lands with EVERY field as picked BEFORE the write — test, category, timing, start code, window — not the emptied form (createAssignment reads its form before its first await)", JSON.stringify(card));
    check(/^\d{6}$/.test(String(d.state().lastStartCode)), "…and the start code offered is the card's", String(d.state().lastStartCode));
  });
  await run(async () => {
    /* the save's mirror HEAL — the one prune of the mirror: a card the server
       no longer has (deleted in another browser after the snapshot) is
       dropped by the card patch; the stale snapshot must not put it back */
    const { s, d } = RACE();
    s.seedBoth("pset:pset-1", OLD_SET); s.seedBoth(CARD_KEY, OLD_CARD, C1);
    d.seed({ sets: [cl(OLD_SET)], assigns: [{ code: C1, list: [cl(OLD_CARD)] }], builder: d.fns.builderFromSet(cl(OLD_SET)) });
    d.$("sbName").value = "New name";
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    s.server.delete(CARD_KEY);                             // another browser deleted the card after the snapshot was taken
    await d.fns.saveSetFromBuilder();                      // the card patch re-reads the server, finds nothing, heals the mirror
    check(!s.mirror.has(CARD_KEY), "the save's card patch healed the mirror (the server has no such row)");
    s.releasePull(); await pull;
    check(landed(s, d), "the pull landed");
    check(!s.mirror.has(CARD_KEY), "the stale pull did not revive the healed-away card (the heal notes its key like a delete does)");
    const mine = (d.state().assigns.find(e => e.code === C1) || { list: [] }).list.map(a => a.assignmentId);
    check(mine.indexOf("a-1") === -1, "the assignments list, reloaded after the pull, does not show it", mine.join(","));
  });
  await run(async () => {
    /* a tombstone under a stale pull: the marker is a NEW row the snapshot
       lacks and the record row is not edited, so there is nothing to put
       back — tutorTombstone needs no note (pinned, since it is the one
       helper left out) */
    const { s, d } = RACE();
    const rec = { attemptId: "attempt:202606asiav1:1:aa", status: "completed", released: false, testId: "202606asiav1", student: { key: C1, code: C1 }, answers: {} };
    s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [cl(rec)] });
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    const r = await d.fns.deleteAttempt(d.state().recs[0]);
    check(!!r && r.ok !== false && s.mirror.has("tomb:" + rec.attemptId), "the marker landed while the pull was in flight");
    s.releasePull(); await pull;
    check(landed(s, d), "the pull landed");
    check(s.mirror.has("tomb:" + rec.attemptId) && !!d.state().tombs["tomb:" + rec.attemptId] &&
          JSON.stringify(s.mirror.get(rec.attemptId)) === JSON.stringify(s.server.get(rec.attemptId).value),
      "the marker survives the stale pull, the reloaded page reads the attempt as deleted, and the record row is byte-identical on both sides");
  });
  await run(async () => {
    /* a tombstone, ordering B: the snapshot lands while the marker RPC is
       in flight and rebuilds `tombs` from the mirror (no marker yet);
       deleteAttempt has no reload after its write, so it writes the marker
       into the tombs map the page holds now */
    const { s, d } = RACE();
    const rec = { attemptId: "attempt:202606asiav1:1:aa", status: "completed", released: false, testId: "202606asiav1", student: { key: C1, code: C1 }, answers: {} };
    s.seedBoth(rec.attemptId, rec, C1); d.seed({ recs: [cl(rec)] });
    const g = gateOf(); const realRpc = s.AS.adminRpc;
    s.AS.adminRpc = async function(fn, args){ if(fn === "fn_tombstone_attempt"){ s.calls.push(["gated:adminRpc", fn]); await g.p; } return realRpc.call(this, fn, args); };
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    const del = d.fns.deleteAttempt(d.state().recs[0]);
    check(await until(() => s.calls.some(c => c[0] === "gated:adminRpc")), "the marker RPC is in flight");
    s.releasePull(); await pull;
    check(!d.state().tombs["tomb:" + rec.attemptId] && landed(s, d), "before the server answers, the reloaded page has no marker (the snapshot was the truth then)");
    g.open(); const r = await del;
    check(!!r && r.ok !== false && s.mirror.has("tomb:" + rec.attemptId) && !!d.state().tombs["tomb:" + rec.attemptId] && d.state().recs.length === 1,
      "once the server answers, the marker is in the mirror AND in the tombs map the page holds now; the record stays listed, marked");
  });
  await run(async () => {
    /* the pull's own contract for a predicate that THROWS: the row is not
       skipped (the pre-fix behaviour), never dropped — pinned at the store,
       since no page predicate can throw today (Set.has) */
    const s = makeStore({});
    s.server.set("pset:px", { owner: null, value: { setId: "px", name: "P", subject: "math", refs: [] } });
    const n = await s.AS.pullAllForTutor(k => { throw new Error("boom"); });
    check(n === 1 && !!s.mirror.get("pset:px") && s.mirror.get("pset:px").name === "P", "a predicate that throws counts as not skipped: the row lands and is counted", String(n));
  });
  await run(async () => {
    /* a REJECTED write shields nothing: the pull's row is still the server's
       truth there and must land (the key is noted only once the server accepts) */
    const { s, d } = RACE({ reject: op => op === "put" });
    s.server.set("pset:pset-3", { owner: null, value: { setId: "pset-3", name: "Server name", subject: "math", refs: [] } });
    s.mirror.set("pset:pset-3", { setId: "pset-3", name: "Stale mirror copy", subject: "math", refs: [] });
    const pull = d.fns.loadFromStorage(); await s.pullStarted;
    const r = await d.fns.tutorPut("pset:pset-3", null, { setId: "pset-3", name: "Mine", subject: "math", refs: [] });
    check(r.ok === false, "the write was rejected");
    everyMessage.push(r.message);
    s.releasePull(); await pull;
    check(landed(s, d), "the pull landed");
    check(s.mirror.get("pset:pset-3").name === "Server name", "after a rejected write the pull's row for that key lands (nothing newer exists)", JSON.stringify(s.mirror.get("pset:pset-3")));
    check(d.state().pullsInFlight === 0, "the key set is released");
  });
  await run(async () => {
    /* two Refreshes in flight: each keeps its own key set; both leave the
       written row alone; the two tails settle one after the other (two page
       responses) and the lists hold each row ONCE */
    const { s, d } = RACE();
    const SET9 = { setId: "pset-9", name: "Set 9", subject: "math", refs: [] };
    s.seedBoth("pset:pset-1", OLD_SET); s.seedBoth("pset:pset-9", SET9); s.seedBoth(CARD_KEY, OLD_CARD, C1);
    d.seed({ sets: [cl(OLD_SET), cl(SET9)], assigns: [{ code: C1, list: [cl(OLD_CARD)] }], builder: d.fns.builderFromSet(cl(OLD_SET)) });
    const p1 = d.fns.loadFromStorage(); await s.pullStarted;
    const p2 = d.fns.loadFromStorage();
    check(d.state().pullsInFlight === 2, "two pulls in flight register two key sets", String(d.state().pullsInFlight));
    d.$("sbName").value = "New name"; await d.fns.saveSetFromBuilder();
    s.releasePull(); await p1;
    s.releasePull(); await p2;
    const st = d.state();
    check(s.mirror.get("pset:pset-1").name === "New name" && st.sets.length === 2 && st.sets.find(x => x.setId === "pset-1").name === "New name",
      "both stale snapshots left the saved row alone, and the Sets list holds each set once", JSON.stringify(st.sets.map(x => [x.setId, x.name])));
    const cards = (st.assigns.find(e => e.code === C1) || { list: [] }).list;
    check(cards.length === 1 && cards[0].setName === "New name", "…and the one card once, patched", JSON.stringify(cards));
    check(st.pullsInFlight === 0 && landed(s, d), "…both key sets are released and the control row landed");
  });
  await run(async () => {
    /* a pull that FAILS (the server unreachable) releases its key set, and
       the failure stays in the FINAL status line — the reload's own line
       used to overwrite it, so the tutor read a success */
    const s = makeStore({ pullFail: true }); const d = build(s, null, null, { realLoad: true });
    await d.fns.loadFromStorage();
    const t = status(d);
    check(/^Couldn't reach the server — showing what's cached on this device\. 0 attempt\(s\) in shared storage\./.test(t),
      "a failed pull is reported in the final status line, in front of the reload's own", t);
    check(d.state().pullsInFlight === 0, "a failed pull releases its key set", String(d.state().pullsInFlight));
  });
  await run(async () => {
    /* control: a write AFTER the pull settled lands as always — there is no pull to tell, and nothing is skipped */
    const { s, d } = RACE({ holdPull: false });
    s.seedBoth("pset:pset-1", OLD_SET);
    d.seed({ sets: [cl(OLD_SET)], assigns: [], builder: d.fns.builderFromSet(cl(OLD_SET)) });
    await d.fns.loadFromStorage();
    check(d.state().loads.storage === 1 && d.state().sets[0].name === "Old name" && landed(s, d), "control: the pull landed its rows and the list shows them");
    d.$("sbName").value = "New name"; await d.fns.saveSetFromBuilder();
    check(s.server.get("pset:pset-1").value.name === "New name" && s.mirror.get("pset:pset-1").name === "New name" && d.state().pullsInFlight === 0,
      "control: a write after the pull settled lands on server and mirror with no key set left behind");
  });

  /* =================== 11. sweeps =================== */
  console.log("--- 11. sweeps: no tutor message says sync; no path bypasses the helper ---");
  await run(async () => {
    /* the message must actually be RENDERED: render() rebuilds #dashBody, so
       viewSetAssign has to emit the module var into the span (a textContent
       write to the old node is wiped — the bug this guards) */
    check(/id="saMsg">\$\{esc\(saMsg\)\}<\/span>/.test(extractFn(src, "viewSetAssign")),
      "viewSetAssign renders saMsg (escaped) into the span, so the outcome survives the re-render");
  });
  check(everyMessage.length >= 20 && everyMessage.every(noSync), "none of the " + everyMessage.length + " captured tutor messages says 'sync' in any form",
    everyMessage.filter(m => !noSync(m)).join(" | "));
  await run(async () => {
    /* Source tripwire (the behavioural guard is the per-key order invariant
       run() applies to every case): outside the helper bodies, the upload
       button, and the one heal-the-mirror remove, NO use of AttemptStore may
       be anything but a read. Done by REMOVING those allowed bodies from the
       source and then flagging every AttemptStore token in the remainder
       that is not immediately a call to a read-only member — so an alias
       (const AS2 = AttemptStore), bracket access (AttemptStore["setLocal"]),
       the student-path set()/delete(), or a new mutator name all trip it. */
    /* READS is the closed list of members that neither write the server nor
       the mirror. rpc() is the sync queue's write primitive and
       pullAllForTutor() writes the mirror — neither belongs here; the one
       sanctioned pull (loadFromStorage's) is stripped by line, like the heal. */
    const READS = ["isRemote", "isLocal", "hasAuthToken", "available", "get", "list", "getResult",
      "adminSelectKey", "adminSelectAll", "signOutTutor", "tutorIdentity"];
    let rest = src;
    /* tutorTombstone (2026-09-18) is the third sanctioned helper: it is the
       only body allowed to call adminRpc, and its mirror writes are
       server-first like the other two (section 8 proves it) */
    for(const fn of ["tutorPut", "tutorDelete", "tutorTombstone", "migrateLocalToServer"]){
      try{ rest = rest.replace(extractFn(src, fn), ""); }catch(e){ /* absent: nothing to strip */ }
    }
    /* the two sanctioned lines are stripped only in their EXACT expected
       form — anything smuggled onto the same line breaks the match, stays in
       the remainder, and is flagged */
    const healLine = (rest.match(/^\s*try\{ await AttemptStore\.remove\(ak\); \}catch\(e\)\{\}\s*\/\/ heal the stale mirror \(server never had it\)\r?$/m) || [])[0];
    if(healLine) rest = rest.replace(healLine, "");
    /* the pull carries the keys-written predicate (2026-10-06); only that
       exact shape is sanctioned, so a pull without it is flagged here */
    const pullLine = (rest.match(/^\s*const n = await AttemptStore\.pullAllForTutor\(k => written\.has\(k\)\);\r?$/m) || [])[0];
    if(pullLine) rest = rest.replace(pullLine, "");
    const readRe = new RegExp("^\\.(?:" + READS.join("|") + ")\\(");
    const tokRe = /AttemptStore\b/g;
    const offenders = [];
    let m;
    while((m = tokRe.exec(rest))){
      const after = rest.slice(m.index + m[0].length, m.index + m[0].length + 40);
      if(readRe.test(after)) continue;
      const line = rest.slice(0, m.index).split("\n").length;
      offenders.push("line~" + line + ": AttemptStore" + after.slice(0, 24).replace(/\s+/g, " "));
    }
    check(offenders.length === 0, "outside tutorPut/tutorDelete/upload/mirror-heal, every AttemptStore use in dashboard.js is a read-only member call (no alias, bracket, set/delete, or mutator)", offenders.join(" | "));
    check(/for\(const prefix of \[[^\]]*"student:"[^\]]*\]\)/.test(extractFn(src, "migrateLocalToServer") || ""),
      "the upload button carries student: (display-name) rows");
  });

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed` + (SRC_PATH !== "dashboard.js" ? "  (source: " + SRC_PATH + ")" : ""));
  if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
