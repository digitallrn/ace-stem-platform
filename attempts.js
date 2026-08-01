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

  /* Resolved per call, never cached: a host may install window.storage after
     these scripts run, and the test harness swaps it at runtime. */
  function backend(){
    if(forcedLocal) return localBackend;
    return window.storage || localBackend;   // static host -> local mode
  }
  function isLocal(){ return forcedLocal || !window.storage; }

  return {
    /* Storage is now always available in some form; available() stays for
       callers that only care that reads/writes can be attempted. */
    available(){ return !!backend(); },
    isLocal: isLocal,
    isDev: isLocal,          // deprecated alias, kept for older call sites

    /* All four return-or-null / return-false, never throw. */
    async set(key, obj){
      const b = backend();
      if(!b) return false;
      try{
        await b.set(key, JSON.stringify(obj), true);
        return true;
      }catch(e){ return false; }
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
      // a genuine read failure must NOT collapse to "no key -> all published
      // tests as practice": that would expose a proctored, start-code-gated
      // test as an ungated practice card. Retry the transient blip; only a
      // clean missing/no-storage result means "default".
      let res = null;
      for(let attempt = 0; attempt < 3; attempt++){
        res = await AttemptStore.getResult("assign:" + key);
        if(res.status !== "error") break;
      }
      if(res.status === "error") return "unavailable";     // caller shows a retry, not a downgrade
      if(res.status !== "ok" || !Array.isArray(res.value)) return null;   // missing/nostorage -> default
      return res.value.filter(Boolean).map(item => (typeof item === "string")
        ? { assignmentId: "legacy-" + item, testId: item, category: "practice",
            startCode: null, windowOpens: null, expiresAt: null,
            assignedAt: null, completedAttemptId: null }
        : item);
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

    /* completed/timed-out attempts for this code, newest first */
    async pastAttempts(code){
      try{
        const key = String(code || "").trim().toUpperCase();
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
