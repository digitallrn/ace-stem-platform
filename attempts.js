/* attempts.js — attempt recording per ATTEMPTS-SPEC.md.
   Load order: test-data.js, render.js, grading.js, THEN attempts.js, THEN
   app.js (which calls Attempts.*), then dashboard.js.
   Plain script, no IIFE-private globals leaked beyond window.AttemptStore
   and window.Attempts.

   Fault tolerance is the design driver (spec §10): every storage call is
   wrapped, saves are retried on the next checkpoint, and nothing here ever
   throws into the test flow. A student's sitting must survive storage being
   absent (local file), flaky, or rate-limited. */

/* ================= storage adapter =================
   Artifact shared storage API (as used by the shipped fork):
     await storage.set(key, jsonString, true)   // true = shared
     await storage.get(key, true)      -> {value: string}
     await storage.list(prefix, true)  -> {keys: [string]}
     await storage.delete(key, true)
   TWO DEPLOYMENT MODES (see CLAUDE.md "Deployment modes"):
     shared — published claude.ai artifact: window.storage exists, records
              are shared, so the tutor dashboard sees every student.
     local  — static host (or a file:// copy): window.storage is absent, so
              the same API is backed by localStorage. Records never leave the
              device, so the JSON download is the student's handoff.
   Local mode engages automatically when window.storage is absent; the older
   ?devstorage=1 switch still forces it and is no longer required. */
window.AttemptStore = (function(){
  "use strict";

  const forcedLocal = /[?&]devstorage=1/.test(location.search);

  const localBackend = {
    async set(key, value){ localStorage.setItem("devstore:" + key, value); return true; },
    async get(key){ const v = localStorage.getItem("devstore:" + key); return v === null ? null : { value: v }; },
    async list(prefix){
      const keys = [];
      for(let i = 0; i < localStorage.length; i++){
        const k = localStorage.key(i);
        if(k && k.indexOf("devstore:" + prefix) === 0) keys.push(k.slice("devstore:".length));
      }
      return { keys };
    },
    async delete(key){ localStorage.removeItem("devstore:" + key); return true; }
  };

  /* ---------------- remote (Supabase) — PHASE-H ----------------
     Local-first, always. Nothing here is ever awaited by the test loop:
     reads during a sitting come from localStorage, and writes go to
     localStorage first and then onto a queue that drains in the background.
     A dead network can therefore delay sync but never a student. */
  const cfg = window.ACESTEM_CONFIG || null;
  const remoteConfigured = !!(cfg && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    cfg.SUPABASE_URL.indexOf("YOUR-") === -1 && cfg.SUPABASE_ANON_KEY.indexOf("YOUR-") === -1);

  /* precedence (spec §2): ?devstorage=1 -> artifact -> remote -> local */
  function mode(){
    if(forcedLocal) return "local";
    if(window.storage) return "artifact";
    if(remoteConfigured) return "remote";
    return "local";
  }
  function isLocal(){ return mode() === "local"; }
  function isRemote(){ return mode() === "remote"; }

  /* Resolved per call, never cached: a host may install window.storage after
     these scripts run, and the test harness swaps it at runtime. Remote mode
     still reads and writes locally — the queue carries it upstream. */
  function backend(){
    return mode() === "artifact" ? window.storage : localBackend;
  }

  const REST_TIMEOUT_MS = 8000;
  let authToken = null;            // tutor session JWT, memory only

  async function httpJson(path, opts){
    if(!remoteConfigured) throw new Error("remote not configured");
    const ctl = new AbortController();
    const timer = setTimeout(()=> ctl.abort(), (opts && opts.timeoutMs) || REST_TIMEOUT_MS);
    try{
      const res = await fetch(cfg.SUPABASE_URL.replace(/\/+$/, "") + path, {
        method: (opts && opts.method) || "GET",
        headers: Object.assign({
          "apikey": cfg.SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + (authToken || cfg.SUPABASE_ANON_KEY),
          "Content-Type": "application/json"
        }, (opts && opts.headers) || {}),
        body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctl.signal
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if(!res.ok){
        const err = new Error((data && (data.message || data.error)) || ("HTTP " + res.status));
        err.status = res.status;
        throw err;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  const rpc = (fn, args, opts) =>
    httpJson("/rest/v1/rpc/" + fn, Object.assign({ method:"POST", body: args }, opts || {}));

  /* ---- sync queue: localStorage-backed so it survives reload ---- */
  const QKEY = "devstore:__syncqueue";
  const BACKOFF_MS = [0, 2000, 8000, 30000, 120000, 600000];
  let draining = false, lastSyncError = null, syncTimer = null;

  function qRead(){
    try{ return JSON.parse(localStorage.getItem(QKEY) || "[]"); }catch(e){ return []; }
  }
  function qWrite(items){
    try{ localStorage.setItem(QKEY, JSON.stringify(items)); }catch(e){}
  }
  function enqueue(item){
    const q = qRead();
    // one pending entry per key: a later write of the same record supersedes
    const i = q.findIndex(x => x.key === item.key);
    if(i >= 0) q[i] = Object.assign(q[i], item, { tries: q[i].tries || 0 });
    else q.push(Object.assign({ tries: 0, nextAt: 0 }, item));
    qWrite(q);
    scheduleDrain(0);
  }
  function scheduleDrain(delayMs){
    if(syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(()=>{ drain(); }, Math.max(0, delayMs || 0));
  }

  async function drain(){
    if(draining || !isRemote()) return;
    if(typeof navigator !== "undefined" && navigator.onLine === false){
      scheduleDrain(15000);
      return;
    }
    draining = true;
    try{
      let q = qRead();
      const now = Date.now();
      for(const item of q.slice()){
        if((item.nextAt || 0) > now) continue;
        try{
          if(item.kind === "bug") await rpc("fn_insert_bug", { p_code: item.code, p_value: item.value });
          else await rpc("fn_upsert_attempt", { p_code: item.code, p_key: item.key, p_value: item.value });
          q = qRead().filter(x => x.key !== item.key);      // re-read: may have been superseded
          qWrite(q);
          lastSyncError = null;
        }catch(e){
          lastSyncError = e.message || String(e);
          const fresh = qRead();
          const j = fresh.findIndex(x => x.key === item.key);
          if(j >= 0){
            fresh[j].tries = (fresh[j].tries || 0) + 1;
            fresh[j].nextAt = Date.now() + BACKOFF_MS[Math.min(fresh[j].tries, BACKOFF_MS.length - 1)];
            qWrite(fresh);
          }
        }
      }
    } finally {
      draining = false;
      const left = qRead();
      if(left.length) scheduleDrain(Math.max(2000, Math.min.apply(null,
        left.map(x => Math.max(0, (x.nextAt || 0) - Date.now())).concat([30000]))));
    }
  }

  if(typeof window !== "undefined" && window.addEventListener){
    window.addEventListener("online", ()=> scheduleDrain(0));
  }

  return {
    /* Storage is now always available in some form; available() stays for
       callers that only care that reads/writes can be attempted. */
    available(){ return !!backend(); },
    isLocal: isLocal,
    isDev: isLocal,          // deprecated alias, kept for older call sites
    isRemote: isRemote,
    mode: mode,

    /* ---- remote plumbing (PHASE-H) ---- */
    rpc: rpc,
    httpJson: httpJson,
    remoteConfigured(){ return remoteConfigured; },
    syncState(){
      const q = qRead();
      return {
        pending: q.length,
        online: typeof navigator === "undefined" || navigator.onLine !== false,
        lastError: lastSyncError,
        syncing: draining
      };
    },
    drainNow(){ scheduleDrain(0); },
    setAuthToken(t){ authToken = t || null; },
    hasAuthToken(){ return !!authToken; },

    /* ---- tutor auth (spec §4). Real Supabase Auth; the token lives in
       memory only, so closing the tab signs the tutor out. ---- */
    async signInTutor(email, password){
      const data = await httpJson("/auth/v1/token?grant_type=password", {
        method: "POST", body: { email: email, password: password }
      });
      if(!data || !data.access_token) throw new Error("no session returned");
      authToken = data.access_token;
      return { email: (data.user && data.user.email) || email };
    },
    signOutTutor(){ authToken = null; },

    /* ---- tutor-only table access. RLS grants the authenticated role full
       read/write; anon has no table privileges at all, so these only work
       once signInTutor() has produced a token. ---- */
    async adminSelectAll(){
      return await httpJson("/rest/v1/records?select=key,owner_code,value", { timeoutMs: 20000 });
    },
    async adminUpsert(key, ownerCode, value){
      return await httpJson("/rest/v1/records", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: [{ key: key, owner_code: ownerCode || null, value: value,
                 updated_at: new Date().toISOString() }]
      });
    },
    async adminDelete(key){
      return await httpJson("/rest/v1/records?key=eq." + encodeURIComponent(key), {
        method: "DELETE", headers: { "Prefer": "return=minimal" }
      });
    },

    /* All four return-or-null / return-false, never throw. */
    async set(key, obj){
      const b = backend();
      if(!b) return false;
      let ok = true;
      try{
        await b.set(key, JSON.stringify(obj), true);
      }catch(e){ ok = false; }
      /* Local-first (spec §1): the local write above is what the student
         depends on. Queueing is fire-and-forget — never awaited, and a
         failure here must not turn a good local write into a failed one. */
      if(ok && isRemote()){
        try{
          if(key.indexOf("attempt:") === 0 && obj && obj.student && obj.student.code){
            enqueue({ key, kind:"attempt", code: obj.student.code, value: obj });
          } else if(key.indexOf("bug:") === 0 && obj && obj.studentCode){
            enqueue({ key, kind:"bug", code: obj.studentCode, value: obj });
          }
        }catch(e){}
      }
      return ok;
    },
    /* Write without enqueueing. Used when caching rows we just PULLED from
       the server — routing those through set() would re-upload every record
       on every pull, a sync loop. */
    async setLocal(key, obj){
      const b = backend();
      if(!b) return false;
      try{ await b.set(key, JSON.stringify(obj), true); return true; }
      catch(e){ return false; }
    },
    async get(key){
      const b = backend();
      if(!b) return null;
      try{
        const r = await b.get(key, true);
        if(!r || typeof r.value !== "string") return null;
        return JSON.parse(r.value);
      }catch(e){ return null; }
    },
    /* like get(), but distinguishes the three outcomes get() flattens to null,
       so callers that gate access can tell "no such key" from "read failed":
       {status:"nostorage"|"missing"|"ok"|"error", value} */
    async getResult(key){
      const b = backend();
      if(!b) return { status:"nostorage", value:null };
      try{
        const r = await b.get(key, true);
        if(!r || typeof r.value !== "string") return { status:"missing", value:null };
        return { status:"ok", value: JSON.parse(r.value) };
      }catch(e){ return { status:"error", value:null }; }
    },
    async list(prefix){
      const b = backend();
      if(!b) return null;                       // null = storage unavailable (≠ empty)
      try{
        const r = await b.list(prefix, true);
        return (r && Array.isArray(r.keys)) ? r.keys : [];
      }catch(e){ return null; }
    },
    async remove(key){
      const b = backend();
      if(!b) return false;
      try{
        const fn = b.delete || b.remove;
        if(!fn) return false;
        await fn.call(b, key, true);
        return true;
      }catch(e){ return false; }
    }
  };
})();

/* ================= student codes (PHASE-H §4) =================
   The code is a bearer secret on remote deployments — the "unguessable link"
   model — so it needs real entropy: AS- plus 8 characters from an alphabet
   with no O/0/I/1 to keep it typable out loud. 32^8 ≈ 1.1e12.
   Kept in sync with fn_valid_code() in supabase/schema.sql. */
window.StudentCode = (function(){
  "use strict";
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const RE = /^AS-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
  return {
    ALPHABET: ALPHABET,
    RE: RE,
    valid(code){ return RE.test(String(code || "").trim().toUpperCase()); },
    normalize(code){ return String(code || "").trim().toUpperCase().replace(/\s+/g, ""); },
    generate(){
      let out = "";
      const buf = (window.crypto && window.crypto.getRandomValues)
        ? window.crypto.getRandomValues(new Uint32Array(8)) : null;
      for(let i = 0; i < 8; i++){
        const n = buf ? buf[i] : Math.floor(Math.random() * 0xffffffff);
        out += ALPHABET.charAt(n % ALPHABET.length);
      }
      return "AS-" + out;
    },
    /* AS-7K4M9PXR -> "AS-7K4M 9PXR" for reading aloud / typing */
    pretty(code){
      const c = String(code || "").toUpperCase();
      return RE.test(c) ? c.slice(0,7) + " " + c.slice(7) : c;
    }
  };
})();

/* ================= attempt recorder ================= */
window.Attempts = (function(){
  "use strict";

  const CHECKPOINT_MS = 45000;                   // spec §3 debounced timer
  const iso = t => new Date(t).toISOString();

  let rec = null;          // the live attempt record (spec §2 shape)
  let appState = null;     // app.js state object (moduleState is read at build time)
  let qMeta = {};          // qid -> {firstGiven, lastCommitted, changeCount, visitCount, timeMs, everAnswered, visited}
  let clock = null;        // {qid, shownAt} while a question is on screen
  let liveSpr = {};        // qid -> current SPR input value (committed on question exit)
  let curModule = null;    // {moduleId, startedAt} while a module is in progress
  let dirty = false;
  let saving = false;
  let ticker = null;
  let lastSaveOk = null;   // null = never tried, true/false = last result

  function meta(qid){
    if(!qMeta[qid]) qMeta[qid] = {
      firstGiven: null, lastCommitted: null, changeCount: 0,
      visitCount: 0, timeMs: 0, everAnswered: false, visited: false
    };
    return qMeta[qid];
  }

  function closeClock(){
    if(!clock) return;
    meta(clock.qid).timeMs += Date.now() - clock.shownAt;
    commitLiveSpr(clock.qid);
    clock = null;
  }

  function commitLiveSpr(qid){
    if(!(qid in liveSpr)) return;
    commitAnswer(qid, liveSpr[qid]);
    delete liveSpr[qid];
  }

  function commitAnswer(qid, value){
    const m = meta(qid);
    const norm = (value === undefined || value === "" ) ? null : value;
    if(norm !== null){
      m.everAnswered = true;
      if(m.firstGiven === null) m.firstGiven = norm;
    }
    if(m.lastCommitted !== null && norm !== null && norm !== m.lastCommitted) m.changeCount++;
    m.lastCommitted = norm;
    dirty = true;
  }

  /* ---- record assembly (reads app state fresh every save) ---- */
  function buildScore(test){
    const score = { correct:0, graded:0, noKey:0, bySection:{}, byModule:{} };
    test.modules.forEach(mod => {
      const ms = (appState.moduleState || {})[mod.moduleId];
      if(!ms) return;
      const bySec = score.bySection[mod.section] = score.bySection[mod.section] || {correct:0, graded:0};
      const byMod = score.byModule[mod.moduleId] = {correct:0, graded:0};
      mod.questions.forEach(q => {
        if(!hasKey(q)){ score.noKey++; return; }
        score.graded++; bySec.graded++; byMod.graded++;
        const given = ms.answers.hasOwnProperty(q.id) ? ms.answers[q.id] : null;
        if(given !== null && answerMatches(q, given)){
          score.correct++; bySec.correct++; byMod.correct++;
        }
      });
    });
    return score;
  }

  function buildAnswers(test){
    const answers = {};
    test.modules.forEach(mod => {
      const ms = (appState.moduleState || {})[mod.moduleId];
      if(!ms) return;
      mod.questions.forEach(q => {
        const m = meta(q.id);
        const inLive = (clock && clock.qid === q.id && (q.id in liveSpr));
        const given = inLive ? (liveSpr[q.id] || null)
          : (ms.answers.hasOwnProperty(q.id) ? ms.answers[q.id] : null);
        const elim = ms.eliminated[q.id] ? Array.from(ms.eliminated[q.id]).sort() : [];
        const openMs = (clock && clock.qid === q.id) ? (Date.now() - clock.shownAt) : 0;
        answers[q.id] = {
          given: given,
          firstGiven: m.firstGiven,
          correct: hasKey(q) ? (given !== null && answerMatches(q, given)) : null,
          markedForReview: ms.flags.has(q.id),
          eliminated: elim,
          timeSpentSeconds: Math.round((m.timeMs + openMs) / 1000),
          visitCount: m.visitCount,
          changeCount: m.changeCount,
          blankReason: given !== null ? null : (m.everAnswered ? "cleared" : "never-answered")
        };
      });
    });
    return answers;
  }

  function build(){
    if(!rec || !appState || !appState.currentTest) return null;
    /* module entries already carry their state: created with
       endedBy:"abandoned"/endedAt:null at moduleStart, finalized by
       moduleEnd — a crash mid-module therefore persists as "abandoned". */
    rec.lastSavedAt = iso(Date.now());
    rec.answers = buildAnswers(appState.currentTest);
    rec.score = buildScore(appState.currentTest);
    return rec;
  }

  let pendingSave = false;
  let drainWaiters = [];                         // resolved when the write loop goes idle
  async function save(){
    if(!rec) return;
    if(saving){
      // queue — a dropped save would lose the final submit if it raced a
      // module-boundary write. Await the drain: suspend() relies on save()
      // only resolving once THIS state (e.g. the resume blob) has been
      // through a write, so lastSaveOk is never a stale read from an
      // earlier in-flight save.
      pendingSave = true;
      return new Promise(res => drainWaiters.push(res));
    }
    saving = true;
    do {
      pendingSave = false;
      const snapshot = build();
      if(!snapshot) break;
      dirty = false;
      const ok = await AttemptStore.set(rec.attemptId, snapshot);
      lastSaveOk = ok;
      if(!ok) dirty = true;                      // retry at the next checkpoint
    } while(pendingSave);
    saving = false;
    drainWaiters.splice(0).forEach(res => res());
  }

  function startTicker(){
    stopTicker();
    ticker = setInterval(() => { if(dirty) save(); }, CHECKPOINT_MS);
  }
  function stopTicker(){ if(ticker){ clearInterval(ticker); ticker = null; } }

  /* best-effort flush when the tab hides or closes (spec §3) */
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "hidden" && rec){ closeClock(); save(); }
  });
  window.addEventListener("beforeunload", () => { if(rec){ closeClock(); save(); } });

  /* ---- per-assignment rows (spec §3) ----
     One row per assignment (assign:<CODE>:<assignmentId>) instead of one array
     per student, which is what removes the Phase F read-modify-write clobber.
     assign:<CODE>:__none is an explicit "assigned nothing" sentinel, so the
     [] vs absent distinction David decided on survives the move to rows. */
  const ASSIGN_SYNC_PREFIX = "devstore:__assignsync:";
  const NONE_SUFFIX = ":__none";

  function assignPrefix(codeKey){ return "assign:" + codeKey + ":"; }

  async function readLocalAssignments(codeKey){
    const keys = await AttemptStore.list(assignPrefix(codeKey));
    if(!keys || !keys.length) return null;              // nothing configured
    if(keys.some(k => k.slice(-NONE_SUFFIX.length) === NONE_SUFFIX) && keys.length === 1){
      return "none";                                    // explicitly assigned nothing
    }
    const out = [];
    for(const k of keys){
      if(k.slice(-NONE_SUFFIX.length) === NONE_SUFFIX) continue;
      const v = await AttemptStore.get(k);
      if(v && v.assignmentId) out.push(v);
    }
    return out.length ? out : null;
  }

  async function cacheRemoteAssignments(codeKey, rows){
    // replace this student's cached rows with what the server just returned
    const existing = (await AttemptStore.list(assignPrefix(codeKey))) || [];
    const fresh = {};
    for(const r of rows){ if(r && r.key) fresh[r.key] = r.value; }
    for(const k of existing){ if(!(k in fresh)) await AttemptStore.remove(k); }
    for(const k of Object.keys(fresh)) await AttemptStore.setLocal(k, fresh[k]);
    try{ localStorage.setItem(ASSIGN_SYNC_PREFIX + codeKey, new Date().toISOString()); }catch(e){}
  }

  return {
    /* ---- lifecycle (called from app.js) ---- */
    begin(test, studentCode, conditions, stateRef, assignmentId, timing){
      try{
        appState = stateRef;
        qMeta = {}; liveSpr = {}; clock = null; curModule = null; lastSaveOk = null;
        const now = Date.now();
        const rand = Math.random().toString(16).slice(2, 6);
        rec = {
          recordVersion: 1,
          attemptId: `attempt:${test.testId}:${Math.floor(now/1000)}:${rand}`,
          student: {
            code: String(studentCode || "").trim(),
            key: String(studentCode || "").trim().toUpperCase()
          },
          testId: test.testId,
          testName: test.testName,
          testVersion: test.testVersion || "unversioned",
          assignmentId: assignmentId || null,   // Phase F: ties the attempt to its assignment across resume
          timing: timing || 1,                  // Phase G §1: 1 | 1.5 | 2 | "untimed"
          conditions: conditions || "unknown",
          startedAt: iso(now),
          lastSavedAt: iso(now),
          submittedAt: null,
          status: "in-progress",
          released: false,        // Phase D score-visibility (b): tutor flips this from the dashboard
          modules: [],
          answers: {},
          score: null,
          client: {
            userAgent: navigator.userAgent,
            screen: (screen && screen.width) ? screen.width + "x" + screen.height : ""
          }
        };
        dirty = true;
        save();
        startTicker();
      }catch(e){ /* recording must never block the test */ }
    },

    moduleStart(mod){
      try{
        closeClock();
        curModule = { moduleId: mod.moduleId, startedAt: Date.now() };
        // a resumed sitting re-enters a module whose entry is still open
        // (endedAt:null from the exited sitting) — reuse it, don't duplicate
        if(rec && !rec.modules.find(x => x.moduleId === mod.moduleId && !x.endedAt)){
          rec.modules.push({
            moduleId: mod.moduleId,
            section: mod.section,
            moduleLabel: mod.moduleLabel,
            timeLimitMinutes: mod.timeLimitMinutes,
            startedAt: iso(Date.now()),
            endedAt: null,
            timeSpentSeconds: 0,
            endedBy: "abandoned"
          });
        }
        dirty = true;
      }catch(e){}
    },

    moduleEnd(mod, endedBy){
      try{
        closeClock();
        if(rec){
          const m = rec.modules.find(x => x.moduleId === mod.moduleId && !x.endedAt);
          if(m){
            m.endedAt = iso(Date.now());
            // accumulate: an exited-then-resumed module already carries the
            // seconds from its earlier sitting(s) (folded in by suspend)
            m.timeSpentSeconds = (m.timeSpentSeconds || 0) +
              (curModule ? Math.round((Date.now() - curModule.startedAt)/1000) : 0);
            m.endedBy = endedBy || "submitted";
          }
        }
        curModule = null;
        save();                                   // module boundary — the important write
      }catch(e){}
    },

    finalize(lastEndedBy){
      try{
        if(!rec) return;
        closeClock();
        stopTicker();
        rec.submittedAt = iso(Date.now());
        rec.status = (lastEndedBy === "timer-expired") ? "timed-out" : "completed";
        delete rec.resume;                        // a completed attempt is not resumable
        save();
      }catch(e){}
    },

    /* ---- Save and Exit + Resume (BLUEBOOK-PARITY Phase C; failure semantics
       Phase F §8: a refused exit keeps recording alive in place) ---- */
    async suspend(resumeBlob){
      try{
        if(!rec) return false;
        const openQid = clock ? clock.qid : null;   // to restore on a refused exit
        closeClock();
        stopTicker();
        if(curModule){
          // fold this sitting's elapsed time into the still-open module entry,
          // and restart the sitting clock so a refused exit can't double-count
          const m = rec.modules.find(x => x.moduleId === curModule.moduleId && !x.endedAt);
          if(m) m.timeSpentSeconds = (m.timeSpentSeconds || 0) +
            Math.round((Date.now() - curModule.startedAt)/1000);
          curModule = { moduleId: curModule.moduleId, startedAt: Date.now() };
        }
        rec.resume = resumeBlob;                  // status stays "in-progress" (spec)
        await save();                             // flush immediately, then leave
        if(lastSaveOk !== true){
          // exit refused — keep recording, but drop the blob: the student is
          // still testing, so a later successful checkpoint must not persist
          // a resume point behind their real position (it would rewind them
          // into an already-finished module after a crash)
          delete rec.resume;
          // reopen the same question's clock so the guard's renderTest() ->
          // questionShown() no-ops instead of booking a phantom re-visit
          if(openQid) clock = { qid: openQid, shownAt: Date.now() };
          startTicker();
          return false;
        }
        rec = null; appState = null;              // stop recording entirely once exited
        qMeta = {}; liveSpr = {}; clock = null; curModule = null;
        return true;
      }catch(e){ try{ startTicker(); }catch(e2){} return false; }
    },

    resume(record, stateRef){
      try{
        appState = stateRef;
        rec = record;
        qMeta = {}; liveSpr = {}; clock = null; curModule = null; lastSaveOk = null;
        // rebuild per-question meta so time/visits/changes keep accumulating
        Object.keys(record.answers || {}).forEach(qid => {
          const a = record.answers[qid];
          qMeta[qid] = {
            firstGiven: a.firstGiven, lastCommitted: a.given,
            changeCount: a.changeCount || 0, visitCount: a.visitCount || 0,
            timeMs: (a.timeSpentSeconds || 0) * 1000,
            everAnswered: a.firstGiven !== null || a.blankReason === "cleared",
            visited: (a.visitCount || 0) > 0
          };
        });
        delete rec.resume;                        // consumed; next save persists without it
        dirty = true;
        startTicker();
      }catch(e){}
    },

    /* ---- Phase D/F: home-screen data ---- */
    /* Phase F assignments v2: assign:<CODE> -> array of assignment objects.
       null (absent/unreadable) = default: all published tests as practice.
       Legacy Phase D arrays of bare testIds normalize to practice
       assignments so old keys keep working. */
    async assignments(code){
      const key = String(code || "").trim().toUpperCase();

      /* Remote mode (spec §2): pull from the server, cache locally, and on an
         unreachable server fall back to cache ONLY if this device has synced
         this student before. With no cache we return "unavailable" rather than
         null — null means "no assignments configured -> all tests as practice",
         and answering that from a failed read would turn a proctored,
         start-code-gated test into an ungated practice card. */
      if(AttemptStore.isRemote()){
        try{
          const rows = await AttemptStore.rpc("fn_get_assignments", { p_code: key });
          await cacheRemoteAssignments(key, Array.isArray(rows) ? rows : []);
          const pulled = await readLocalAssignments(key);
          return pulled === "none" ? [] : pulled;
        }catch(e){
          if(!localStorage.getItem(ASSIGN_SYNC_PREFIX + key)) return "unavailable";
          // fall through to the cached copy below
        }
      }

      // a genuine read failure must NOT collapse to "no key -> all published
      // tests as practice" (same reasoning as above). Retry the transient
      // blip; only a clean missing/no-storage result means "default".
      let res = null;
      for(let attempt = 0; attempt < 3; attempt++){
        res = await AttemptStore.getResult("assign:" + key);
        if(res.status !== "error") break;
      }
      if(res.status === "error") return "unavailable";     // caller shows a retry, not a downgrade
      const legacy = (res.status === "ok" && Array.isArray(res.value)) ? res.value : null;
      const perRow = await readLocalAssignments(key);       // per-assignment rows (spec §3)
      if(perRow === null && legacy === null) return null;   // nothing configured -> default
      if(perRow === "none" ) return [];                     // explicitly assigned nothing
      const merged = (perRow === null ? [] : perRow).concat(
        (legacy || []).filter(Boolean).map(item => (typeof item === "string")
          ? { assignmentId: "legacy-" + item, testId: item, category: "practice",
              startCode: null, windowOpens: null, expiresAt: null,
              assignedAt: null, completedAttemptId: null }
          : item));
      // per-assignment rows win over a legacy array entry for the same id
      const seen = {};
      return merged.filter(a => a && !seen[a.assignmentId] && (seen[a.assignmentId] = 1));
    },

    /* mark an assignment consumed by the attempt that just finalized */
    async completeAssignment(code, assignmentId){
      try{
        if(!assignmentId || assignmentId.indexOf("legacy-") === 0) return;
        const key = String(code || "").trim().toUpperCase();
        const list = await AttemptStore.get("assign:" + key);
        if(!Array.isArray(list)) return;
        const a = list.find(x => x && x.assignmentId === assignmentId);
        if(!a) return;
        a.completedAttemptId = (rec && rec.attemptId) || a.completedAttemptId || "unknown";
        await AttemptStore.set("assign:" + key, list);
      }catch(e){}
    },

    currentAttemptId(){ return rec ? rec.attemptId : null; },

    /* Phase F §9: bug reports — one storage key per report, same
       last-write-wins-safe pattern as attempts */
    async reportBug(report){
      try{
        const key = "bug:" + Math.floor(Date.now()/1000) + "-" +
          Math.random().toString(16).slice(2, 6);
        return await AttemptStore.set(key, report);
      }catch(e){ return false; }
    },

    /* completed/timed-out attempts for this code, newest first.
       In remote mode this is where a tutor's `released` flip reaches the
       student: pull their own rows, merge into local, then read locally.
       A failed pull is non-fatal — they just see the last known state. */
    async pastAttempts(code){
      try{
        const key = String(code || "").trim().toUpperCase();
        if(AttemptStore.isRemote()){
          try{
            const rows = await AttemptStore.rpc("fn_get_own_attempts", { p_code: key });
            if(Array.isArray(rows)){
              for(const r of rows){
                if(r && r.key && r.value) await AttemptStore.setLocal(r.key, r.value);
              }
            }
          }catch(e){ /* offline: fall through to the local copy */ }
        }
        const keys = await AttemptStore.list("attempt:");
        if(!keys) return [];
        const out = [];
        for(const k of keys){
          const r = await AttemptStore.get(k);
          if(!r || !r.student || String(r.student.key || "") !== key) continue;
          if(r.status !== "completed" && r.status !== "timed-out") continue;
          out.push(r);
        }
        out.sort((a,b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
        return out;
      }catch(e){ return []; }
    },

    /* most recent in-progress, resumable attempt for this code + test build */
    async findInProgress(code, testId, testVersion){
      try{
        const key = String(code || "").trim().toUpperCase();
        const keys = await AttemptStore.list("attempt:" + testId + ":");
        if(!keys) return null;
        let best = null;
        for(const k of keys){
          const r = await AttemptStore.get(k);
          if(!r || r.status !== "in-progress" || !r.resume) continue;
          if(!r.student || String(r.student.key || "") !== key) continue;
          // ids/annotations only line up within the same test build (spec §9)
          if(r.testVersion !== (testVersion || "unversioned")) continue;
          if(!best || r.startedAt > best.startedAt) best = r;
        }
        return best;
      }catch(e){ return null; }
    },

    /* ---- instrumentation (spec §8) ---- */
    questionShown(qid){
      try{
        if(clock && clock.qid === qid) return;    // re-render of the same question
        closeClock();
        const m = meta(qid);
        m.visitCount++; m.visited = true;
        clock = { qid, shownAt: Date.now() };
        dirty = true;
      }catch(e){}
    },
    reviewShown(){ try{ closeClock(); }catch(e){} },
    answerCommitted(qid, value){ try{ commitAnswer(qid, value); }catch(e){} },
    answerLive(qid, value){ try{ liveSpr[qid] = value; dirty = true; }catch(e){} },

    /* ---- results-screen support (spec §6 fallback) ---- */
    isRecording(){ return !!rec; },
    storageWorking(){ return lastSaveOk === true; },
    downloadJson(){
      try{
        const snapshot = build();
        if(!snapshot) return;
        const blob = new Blob([JSON.stringify(snapshot, null, 2)], {type: "application/json"});
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = (snapshot.student.code || "student") + "-" + snapshot.testId + "-" +
          snapshot.startedAt.slice(0,10) + ".json";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      }catch(e){}
    }
  };
})();
