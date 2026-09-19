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
   the rest run their OLD bodies and fail on the mirror/message checks.) */
"use strict";
const fs = require("fs");
const { extractFn } = require("./extract-helper");

const SRC_PATH = process.env.DASHBOARD_SRC || "dashboard.js";
const src = fs.readFileSync(SRC_PATH, "utf8");

let pass = 0, fail = 0;
const failures = [];
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
  }
}

/* ---------- fake storage: a mirror, a server, and a call log ---------- */
function makeStore(opts){
  opts = opts || {};
  const mirror = new Map(), server = new Map(), calls = [], ops = [];
  const clone = v => JSON.parse(JSON.stringify(v));
  const rejecting = (op, key) => typeof opts.reject === "function" ? !!opts.reject(op, key) : !!opts.reject;
  const expired = () => { const e = new Error(opts.errorMessage || "JWT expired"); e.status = opts.errorStatus === undefined ? 401 : opts.errorStatus; return e; };
  const AS = {
    isRemote: () => opts.remote !== false,
    hasAuthToken: () => true,
    async setLocal(k, v){ calls.push(["setLocal", k]); ops.push(["mirror:set", k]); if(opts.localFail) return false; mirror.set(k, clone(v)); return true; },
    async remove(k){ calls.push(["remove", k]); ops.push(["mirror:remove", k]); if(opts.localFail) return false; mirror.delete(k); return true; },
    async get(k){ return mirror.has(k) ? clone(mirror.get(k)) : null; },
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
       existing marker returned untouched, finished-only for the per-attempt
       call, every attempt the code owns for the per-student call. Each
       marker written counts as an accepted server op on THAT key, which is
       what licenses the mirror write that must follow it. */
    async adminRpc(fn, args){
      calls.push(["adminRpc", fn, JSON.stringify(args)]);
      /* assignmentsAtDeletion: as the SQL computes it — for an untagged
         record, every assignment row the owner holds for that testId */
      const atDeletion = r => (r.value && r.value.assignmentId) ? [] :
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
        const st = rec.value && rec.value.status;
        if(st !== "completed" && st !== "timed-out") refuse(k, "attempt is in progress");
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
  const store = { AS, mirror, server, calls, ops, seedBoth, snapshot, serverFirstViolations, divergences, remote: opts.remote !== false };
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
  "isFinishedAttempt", "isTombstoned", "isDeletedStudent", "tombFor", "orphanStubs", "localTombstone",
  "isTombValue", "tutorTombstone", "deleteStudent", "deleteGateOk", "adoptArchive",
  "tombstoneRejectedText", "assignmentsAtDeletion", "sameTest"];
const ASYNC = new Set(["tutorPut", "tutorDelete", "saveProfiles", "saveNameOnly", "createAssignment",
  "deleteAssignment", "clearAssignments", "deleteSet", "deleteArchived", "dismissBug", "deleteAttempt",
  "toggleRelease", "freshAssignmentRow", "saveSetFromBuilder", "assignSetFromForm", "migrateLocalToServer",
  "tutorTombstone", "deleteStudent"]);
function tryExtract(name){
  try{ return (ASYNC.has(name) ? "async " : "") + extractFn(src, name); }
  catch(e){ return "";  /* absent in this source — the path's check will fail */ }
}
const BODY = NAMES.map(tryExtract).join("\n");
const PRESENT = NAMES.filter(n => tryExtract(n) !== "");

function build(store){
  const els = {};
  const $ = id => els[id] || (els[id] = { value: "", textContent: "", checked: false, disabled: false,
    selectedOptions: [], classList: { add(){}, remove(){}, toggle(){} } });
  /* render()/renderAll() rebuild #dashBody in the real dashboard, which wipes
     any textContent written to a node INSIDE it (saMsg, sbMsg, afMsg) — model
     that, so a message delivered only to a soon-to-be-replaced node does not
     pass here while the page shows nothing. dashStatus lives outside. */
  const wipeBody = () => { ["saMsg", "sbMsg", "afMsg"].forEach(id => { if(els[id]) els[id].textContent = ""; }); };
  /* exportAll's download plumbing, stubbed: it only needs an anchor to click.
     The Blob RECORDS its parts so the payload can be asserted on. */
  const documentStub = { createElement: () => ({ href: "", download: "", click(){}, remove(){} }), body: { appendChild(){} } };
  const URLStub = { createObjectURL: () => "blob:stub", revokeObjectURL(){} };
  const blobs = [];
  function BlobStub(parts){ this.text = (parts || []).join(""); blobs.push(this); }
  const factory = new Function("AttemptStore", "$", "StudentCode", "confirm", "window", "escapeHtml", "wipeBody", "document", "URL", "Blob", `
    let recs = [], assigns = [], bugs = [], lastStartCode = null, profiles = {}, source = "storage", lastExport = null;
    let sets = [], builder = null, setsMsg = "", saMsg = "", openAttemptId = null, tombs = {};
    const testsById = {};
    const loads = { assigns: 0, sets: 0, storage: 0, render: 0 };
    async function loadAssignsAndBugs(){ loads.assigns++; }
    async function loadSets(){ loads.sets++; }
    async function loadFromStorage(){ loads.storage++; }
    function render(){ loads.render++; wipeBody(); }
    function renderAll(){ loads.render++; wipeBody(); }
    /* canonical-id awareness (2026-09-07): createAssignment appends the
       overlap notes to its status line. The derivation itself is covered by
       tests/canonical-index.test.js; here the stub returns one sentinel note
       per assigned code so the STATUS-LINE edge is pinned (see the
       createAssignment control case). */
    function overlapNotes(codes, testId){ return codes.map(c => "OVERLAP-NOTE " + c + " " + testId); }
    ${BODY}
    const fns = {};
    ${PRESENT.map(n => `fns[${JSON.stringify(n)}] = ${n};`).join("\n")}
    return {
      fns,
      state: () => ({ recs, assigns, lastStartCode, profiles, lastExport, sets, builder, setsMsg, saMsg, openAttemptId, loads, tombs }),
      seed: o => {
        if("recs" in o) recs = o.recs; if("assigns" in o) assigns = o.assigns; if("profiles" in o) profiles = o.profiles;
        if("lastExport" in o) lastExport = o.lastExport; if("sets" in o) sets = o.sets; if("builder" in o) builder = o.builder;
        if("source" in o) source = o.source; if("lastStartCode" in o) lastStartCode = o.lastStartCode;
        if("tombs" in o) tombs = o.tombs;
      }
    };
  `);
  const d = factory(store.AS, $, StudentCode, () => true, { confirm: () => true }, s => String(s), wipeBody, documentStub, URLStub, BlobStub);
  d.els = els; d.$ = $;
  Object.defineProperty(d, "lastBlob", { get(){ return blobs[blobs.length - 1] || null; } });
  return d;
}
const C1 = "AS-ABCDEFGH", C2 = "AS-JKLMNPQR";
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
    check(s.snapshot() === before && Object.keys(d.state().profiles).length === 0,
      "rejected with a name typed: no student: row in the mirror and the in-memory profiles map is unchanged");
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
    check(s.snapshot() === before && Object.keys(d.state().profiles).length === 0,
      "rejected name save: mirror unchanged, profiles map unchanged (the dashboard does not render the name as saved)");
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
    check(s.snapshot() === before && s.server.has("student:" + C1) && d.state().profiles[C1] === "Erin K",
      "rejected name CLEAR: the row stays in mirror and server, profiles map still has the name");
    check(/^Not deleted — the display name for AS-ABCDEFGH/.test(t) && noSync(t), "rejected name clear: message names the row", t);
  });
  await run(async () => {
    const s = makeStore({}); const d = build(s);
    s.seedBoth("student:" + C1, { displayName: "Erin K" }, C1); d.seed({ profiles: { [C1]: "Erin K" } });
    d.els.afCodes = { selectedOptions: [{ value: C1 }] }; d.$("afName").value = "";
    await d.fns.saveNameOnly();
    check(!s.server.has("student:" + C1) && !s.mirror.has("student:" + C1) && !(C1 in d.state().profiles) && /Name cleared for AS-ABCDEFGH/.test(status(d)),
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
    /* finished-only, on both sides: the client gate refuses an in-progress
       record without a server call; the server (modelled) refuses one too */
    const s = makeStore({}); const d = build(s);
    const live = Object.assign(REC(), { status: "in-progress" });
    s.seedBoth(live.attemptId, live, C1); d.seed({ recs: [live] });
    const r = await d.fns.deleteAttempt(live);
    check(r.ok === false && !s.calls.some(c => c[0] === "adminRpc") && !s.server.has("tomb:" + live.attemptId),
      "an in-progress sitting is never tombstoned individually — refused before any server call");
    const r2 = await d.fns.tutorTombstone("attempt", live.attemptId);
    check(r2.ok === false && /^Not deleted — the deletion marker for attempt/.test(r2.message) && !s.server.has("tomb:" + live.attemptId) && !s.mirror.has("tomb:" + live.attemptId),
      "control: the helper called directly on an in-progress record is refused by the server and mirrors nothing", r2.message);
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
       for it, before any write; and the upload button never sends its rows */
    const s = makeStore({}); const d = build(s);
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
      && /^Upload finished — 1 sent, 0 already on the server, 3 belonging to deleted student\(s\) or marked deleted not sent\.$/.test(t),
      "upload: nothing of a deleted student's and no tomb: row is sent; the count says so", t + " | " + sent.join(","));
    /* the retired set comes from the SERVER it just read, not only from this
       browser's last load: a student retired elsewhere is skipped too, and a
       marked attempt never goes up */
    const s2 = makeStore({}); const d2 = build(s2);
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
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    d.seed({ builder: { setId: null, name: "New set", subject: "math", refs: [REF] }, sets: [], assigns: [] });
    d.$("sbName").value = "New set";
    const before = s.snapshot();
    await d.fns.saveSetFromBuilder();
    const m = d.state().setsMsg; everyMessage.push(m);
    check(s.snapshot() === before && s.server.size === 0 && d.state().builder !== null,
      "rejected new set: no pset: row anywhere, the builder stays open");
    check(/^Not saved — set pset-\S+: the tutor sign-in has expired/.test(m) && noSync(m), "rejected new set: message names the set row", m);
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
    check(!s.calls.some(c => c[0] === "adminSelectKey") && !s.calls.some(c => c[0] === "adminUpsert" && c[1].indexOf("assign:") === 0),
      "rejected set EDIT: the card patch never runs (no server read, no assignment write)");
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
    const s = makeStore({ reject: (op) => op === "select" }); const d = build(s);
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

  /* =================== 9e. the upload button: mirror → server, never the other way =================== */
  await run(async () => {
    const s = makeStore({}); const d = build(s);
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
    check(s.snapshot() === before && /^Upload finished — 5 sent, 1 already on the server\./.test(t), "upload: the mirror is untouched and the count is honest", t);
  });
  await run(async () => {
    const s = makeStore({ reject: true }); const d = build(s);
    s.mirror.set("student:" + C1, { displayName: "Erin K" });
    s.mirror.set("assign:" + C1 + ":a-1", { assignmentId: "a-1" });
    const before = s.snapshot();
    await d.fns.migrateLocalToServer();
    check(s.snapshot() === before && s.server.size === 0 && /2 failed\./.test(status(d)), "upload rejected: nothing changes anywhere, failures counted", status(d));
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
    const pullLine = (rest.match(/^\s*const n = await AttemptStore\.pullAllForTutor\(\);\r?$/m) || [])[0];
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
