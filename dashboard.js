/* dashboard.js — tutor dashboard per ATTEMPTS-SPEC.md §5–§7.
   Loads after app.js. Entered only via the hidden admin sign-in
   (acestem-admin); never creates attempt records. Reads records written by
   attempts.js (records store student CODES, never names — spec §7a).
   Archive-then-delete (§7b): "Delete archived attempts" only unlocks after
   a successful "Download all attempts" in the same session, and deletes
   exactly the keys that download contained. */
window.Dashboard = (function(){
  "use strict";

  const $ = id => document.getElementById(id);
  const esc = s => escapeHtml(s);
  // escapeHtml (textContent->innerHTML) escapes & < > but NOT quotes, so it is
  // unsafe inside a quoted attribute. All these values (bug keys, student
  // codes, assignmentIds) are shared-storage writable by anyone running the
  // artifact — a crafted key with a `"` would break out of a data-* attribute
  // and run script in the tutor's dashboard. escAttr adds quote escaping.
  const escAttr = s => escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  let showOnlyFn = null;
  let recs = [];                 // loaded attempt records
  let assigns = [];              // Phase F §3: [{code, list:[assignment...]}]
  let bugs = [];                 // Phase F §9: bug reports, newest first
  let lastStartCode = null;      // the code David reads aloud, shown big
  let source = "storage";        // "storage" | "file"
  let tab = "attempts";
  let sortKey = "startedAt", sortDir = -1;
  let lastExport = null;         // {ids:[attemptId], when} — unlocks delete
  const testsById = {};
  (window.TEST_DATA || []).forEach(t => { testsById[t.testId] = t; });

  /* ---------- helpers ---------- */
  function qIndex(testId){
    const t = testsById[testId];
    if(!t) return null;
    if(!t.__qIndex){
      t.__qIndex = {};
      t.modules.forEach(mod => mod.questions.forEach(q => { t.__qIndex[q.id] = { q, mod }; }));
    }
    return t.__qIndex;
  }
  function fmtDate(isoStr){
    if(!isoStr) return "—";
    const d = new Date(isoStr);
    return d.toLocaleDateString(undefined, {year:"2-digit", month:"short", day:"numeric"}) +
      " " + d.toLocaleTimeString(undefined, {hour:"numeric", minute:"2-digit"});
  }
  function mmss(sec){
    if(sec == null) return "—";
    return Math.floor(sec/60) + ":" + String(Math.round(sec) % 60).padStart(2, "0");
  }
  function median(arr){
    if(!arr.length) return null;
    const s = arr.slice().sort((a,b)=>a-b);
    const mid = Math.floor(s.length/2);
    return s.length % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
  }
  function scoreStr(r){
    return (r.score && r.score.graded) ? r.score.correct + "/" + r.score.graded : "—";
  }
  function scorePct(r){
    return (r.score && r.score.graded) ? r.score.correct / r.score.graded : -1;
  }
  function statusBadge(r){
    const cls = { "completed":"ok", "in-progress":"warn", "timed-out":"to" }[r.status] || "";
    return `<span class="dstatus ${cls}">${esc(r.status || "?")}</span>`;
  }
  function givenLabel(entry, q){
    if(entry.given === null || entry.given === undefined) return "—";
    if(q && q.type === "mcq" && typeof entry.given === "number") return String.fromCharCode(65 + entry.given);
    return String(entry.given);
  }
  function filtered(){
    const ft = $("dashFilterTest").value;
    const fs = $("dashFilterStudent").value;
    return recs.filter(r => (!ft || r.testId === ft) && (!fs || (r.student && r.student.key) === fs));
  }

  /* ---------- data load ---------- */
  async function loadFromStorage(){
    source = "storage";
    $("dashStatus").textContent = "Loading attempts from shared storage…";
    const keys = await AttemptStore.list("attempt:");
    if(keys === null){
      recs = [];
      $("dashStatus").innerHTML = "<b>No shared storage in this copy.</b> Records are only written in the published app. You can still inspect a downloaded archive: use “Load archive file”." +
        (AttemptStore.isDev() ? "" : " (For local testing, reopen with ?devstorage=1.)");
      renderAll();
      return;
    }
    const loaded = [];
    let failed = 0;
    for(const k of keys){
      const r = await AttemptStore.get(k);
      if(r && r.attemptId) loaded.push(r); else failed++;
    }
    recs = loaded;
    await loadAssignsAndBugs();
    $("dashStatus").textContent = recs.length + " attempt(s) in storage." +
      (failed ? " (" + failed + " unreadable — see console.)" : "") +
      (lastExport ? "" : " Download an archive before deleting anything.");
    renderAll();
  }

  async function loadAssignsAndBugs(){
    assigns = []; bugs = [];
    const aKeys = await AttemptStore.list("assign:");
    if(aKeys){
      for(const k of aKeys){
        const list = await AttemptStore.get(k);
        if(Array.isArray(list)) assigns.push({ code: k.slice("assign:".length), list });
      }
    }
    const bKeys = await AttemptStore.list("bug:");
    if(bKeys){
      for(const k of bKeys){
        const b = await AttemptStore.get(k);
        if(b) bugs.push(Object.assign({ __key: k }, b));
      }
    }
    bugs.sort((x, y) => (y.at || y.__key || "").localeCompare(x.at || x.__key || ""));
  }

  function loadFromFile(file){
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const data = JSON.parse(reader.result);
        const arr = Array.isArray(data) ? data : (data.records || []);
        recs = arr.filter(r => r && r.attemptId);
        source = "file";
        lastExport = null;
        $("dashDeleteBtn").disabled = true;
        $("dashStatus").textContent = recs.length + " attempt(s) loaded from " + file.name +
          " (read-only archive view — delete/export act on storage, not this file).";
        renderAll();
      }catch(e){
        $("dashStatus").textContent = "Couldn't parse " + file.name + " — is it an attempts archive JSON?";
      }
    };
    reader.readAsText(file);
  }

  /* ---------- export + archive-then-delete (§6, §7b) ---------- */
  function exportAll(){
    if(!recs.length){ $("dashStatus").textContent = "Nothing to export."; return; }
    const payload = {
      schema: "acestem-attempt-archive-v1",
      exportedAt: new Date().toISOString(),
      records: recs
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "attempts-archive-" + new Date().toISOString().slice(0,10) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    if(source === "storage"){
      lastExport = { ids: recs.map(r => r.attemptId), when: new Date() };
      $("dashDeleteBtn").disabled = false;
      $("dashStatus").textContent = "Archive downloaded (" + recs.length + " attempts). Verify the file opened correctly, then “Delete archived attempts” removes exactly those from storage.";
    }
  }

  async function deleteArchived(){
    if(!lastExport || source !== "storage") return;
    const ids = lastExport.ids;
    const codes = [...new Set(recs.filter(r => ids.includes(r.attemptId))
      .map(r => r.student && r.student.code || "?"))];
    const dates = ids.map(id => parseInt(id.split(":")[2], 10)*1000).filter(n => !isNaN(n));
    const range = dates.length ?
      new Date(Math.min(...dates)).toLocaleDateString() + " – " + new Date(Math.max(...dates)).toLocaleDateString() : "?";
    const msg = "Delete " + ids.length + " attempt record(s) from shared storage?\n\n" +
      "Students: " + codes.join(", ") + "\nDates: " + range + "\n\n" +
      "These are the attempts in the archive you downloaded at " + lastExport.when.toLocaleTimeString() + ". " +
      "Only proceed if you've verified that file. The archive file itself is not touched.";
    if(!window.confirm(msg)) return;
    let ok = 0, fail = 0;
    for(const id of ids){
      (await AttemptStore.remove(id)) ? ok++ : fail++;
    }
    lastExport = null;
    $("dashDeleteBtn").disabled = true;
    $("dashStatus").textContent = "Deleted " + ok + " record(s)" + (fail ? " — " + fail + " FAILED (still in storage, refresh and retry)" : "") + ".";
    loadFromStorage();
  }

  /* ---------- views ---------- */
  function renderAll(){
    // (re)build filter options, preserving selection
    const keepT = $("dashFilterTest").value, keepS = $("dashFilterStudent").value;
    const tests = [...new Set(recs.map(r => r.testId))];
    const students = [...new Set(recs.map(r => r.student && r.student.key).filter(Boolean))].sort();
    $("dashFilterTest").innerHTML = '<option value="">All tests</option>' +
      tests.map(t => `<option value="${escAttr(t)}">${esc((recs.find(r=>r.testId===t)||{}).testName || t)}</option>`).join("");
    $("dashFilterStudent").innerHTML = '<option value="">All students</option>' +
      students.map(s => `<option value="${escAttr(s)}">${esc(s)}</option>`).join("");
    $("dashFilterTest").value = keepT; $("dashFilterStudent").value = keepS;
    render();
  }

  function render(){
    const body = $("dashBody");
    const rows = filtered();
    if(tab === "attempts") body.innerHTML = viewAttempts(rows);
    else if(tab === "students") body.innerHTML = viewStudents(rows);
    else if(tab === "items") body.innerHTML = viewItems(rows);
    else if(tab === "assign") body.innerHTML = viewAssign();
    else if(tab === "bugs") body.innerHTML = viewBugs();
    else body.innerHTML = viewInsights(rows);
    attachBodyHandlers();
  }

  /* Phase D score-visibility (b): per-attempt release toggle. Students see
     scores in their Past view only after this flips released:true. */
  function releaseCell(r){
    if(r.status === "in-progress") return "—";
    return `<button class="dash-rel ${r.released ? "rel-on" : ""}" data-rel="${escAttr(r.attemptId)}"
      title="${r.released ? "Hide scores from the student again" : "Let the student see this attempt in their Past view"}">${
      r.released ? "Released ✓" : "Release"}</button>`;
  }
  async function toggleRelease(attemptId){
    const r = recs.find(x => x.attemptId === attemptId);
    if(!r) return;
    if(source !== "storage"){
      $("dashStatus").textContent = "Release only works on storage-loaded attempts — archive files are read-only.";
      return;
    }
    r.released = !r.released;
    const ok = await AttemptStore.set(r.attemptId, r);
    if(!ok){
      r.released = !r.released;                 // roll back — nothing persisted
      $("dashStatus").textContent = "Release toggle didn't save — storage unavailable.";
    }
    render();
  }

  function viewAttempts(rows){
    const cols = [
      ["student", "Student"], ["testName", "Test"], ["startedAt", "Date"],
      ["score", "Score"], ["status", "Status"], ["released", "Scores"], ["conditions", "Conditions"]
    ];
    const sorted = rows.slice().sort((a,b) => {
      const va = sortVal(a, sortKey), vb = sortVal(b, sortKey);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
    });
    if(!sorted.length) return '<p class="dash-empty">No attempts match.</p>';
    return `<table class="dtable"><thead><tr>` +
      cols.map(([k, lbl]) => `<th data-sort="${k}" class="${sortKey===k?'sorted':''}">${lbl}${sortKey===k ? (sortDir>0?" ▲":" ▼") : ""}</th>`).join("") +
      `</tr></thead><tbody>` +
      sorted.map((r, i) => `
        <tr data-att="${escAttr(r.attemptId)}">
          <td>${esc(r.student && r.student.code || "?")}</td>
          <td>${esc(r.testName || r.testId)}</td>
          <td>${fmtDate(r.startedAt)}</td>
          <td><b>${scoreStr(r)}</b></td>
          <td>${statusBadge(r)}</td>
          <td>${releaseCell(r)}</td>
          <td>${esc(r.conditions || "unknown")}</td>
        </tr>`).join("") +
      `</tbody></table><p class="dash-hint">Click a row for the full question-by-question review.</p>`;
  }
  function sortVal(r, k){
    if(k === "student") return (r.student && r.student.key) || "";
    if(k === "score") return scorePct(r);
    if(k === "status") return r.status || "";
    if(k === "released") return r.released ? 1 : 0;
    if(k === "conditions") return r.conditions || "";
    if(k === "testName") return r.testName || "";
    return r.startedAt || "";
  }

  function viewStudents(rows){
    const byStudent = {};
    rows.forEach(r => {
      const k = (r.student && r.student.key) || "?";
      (byStudent[k] = byStudent[k] || []).push(r);
    });
    const keys = Object.keys(byStudent).sort();
    if(!keys.length) return '<p class="dash-empty">No attempts match.</p>';
    return keys.map(k => {
      const list = byStudent[k].slice().sort((a,b) => (a.startedAt||"").localeCompare(b.startedAt||""));
      return `<div class="dcard">
        <h3>${esc(k)} <span class="dcard-sub">${list.length} attempt(s)</span></h3>
        <table class="dtable slim"><thead><tr><th>Date</th><th>Test</th><th>Score</th><th>RW</th><th>Math</th><th>Status</th><th>Conditions</th></tr></thead><tbody>` +
        list.map(r => {
          const bs = (r.score && r.score.bySection) || {};
          const rw = bs["Reading and Writing"], ma = bs["Math"];
          return `<tr data-att="${escAttr(r.attemptId)}">
            <td>${fmtDate(r.startedAt)}</td><td>${esc(r.testName || r.testId)}</td>
            <td><b>${scoreStr(r)}</b></td>
            <td>${rw ? rw.correct + "/" + rw.graded : "—"}</td>
            <td>${ma ? ma.correct + "/" + ma.graded : "—"}</td>
            <td>${statusBadge(r)}</td><td>${esc(r.conditions || "unknown")}</td></tr>`;
        }).join("") + `</tbody></table></div>`;
    }).join("");
  }

  function viewItems(rows){
    const ft = $("dashFilterTest").value;
    const testIds = [...new Set(rows.map(r => r.testId))];
    if(testIds.length > 1 && !ft) return '<p class="dash-empty">Item analysis is per test — pick one in the Test filter.</p>';
    const testId = ft || testIds[0];
    if(!testId) return '<p class="dash-empty">No attempts match.</p>';
    const idx = qIndex(testId);
    const use = rows.filter(r => r.testId === testId);
    const stats = {};   // qid -> {answered, correct, wrongGiven:[], times:[]}
    use.forEach(r => {
      Object.entries(r.answers || {}).forEach(([qid, a]) => {
        const s = stats[qid] = stats[qid] || { answered:0, correct:0, wrongGiven:[], times:[] };
        if(a.timeSpentSeconds) s.times.push(a.timeSpentSeconds);
        if(a.given === null || a.given === undefined) return;
        if(a.correct === null) return;                    // keyless — not analyzable
        s.answered++;
        if(a.correct) s.correct++;
        else s.wrongGiven.push(a.given);
      });
    });
    const items = Object.entries(stats)
      .filter(([, s]) => s.answered > 0)
      .map(([qid, s]) => {
        const info = idx && idx[qid];
        const pct = s.correct / s.answered;
        const modeMap = {};
        s.wrongGiven.forEach(g => { const k = String(g); modeMap[k] = (modeMap[k]||0)+1; });
        const topWrong = Object.entries(modeMap).sort((a,b)=>b[1]-a[1])[0];
        return { qid, s, info, pct, topWrong };
      })
      .sort((a,b) => a.pct - b.pct);                      // hardest first (§5)
    if(!items.length) return '<p class="dash-empty">No graded answers yet for this test.</p>';
    return `<p class="dash-hint">${esc((testsById[testId]||{}).testName || testId)} — ${use.length} attempt(s), hardest questions first.</p>` +
      items.map(it => {
        const q = it.info && it.info.q;
        const wrongLbl = it.topWrong
          ? (q && q.type === "mcq" && !isNaN(+it.topWrong[0]) ? String.fromCharCode(65 + +it.topWrong[0]) : it.topWrong[0]) +
            " (" + it.topWrong[1] + "×)"
          : "—";
        return `<div class="ditem ${it.pct < 0.5 ? "hard" : ""}">
          <div class="ditem-head">
            <b>${esc(it.qid)}</b>
            ${q && q.skill ? `<span class="ditem-skill">${esc(q.skill)}</span>` : ""}
            <span class="ditem-stats">${Math.round(it.pct*100)}% correct (${it.s.correct}/${it.s.answered}) · top wrong: ${esc(wrongLbl)} · median ${mmss(median(it.s.times))}</span>
          </div>
          ${q ? `<div class="ditem-q">${fmt(q.questionText)}</div>` : '<div class="ditem-q dash-empty">question text unavailable (test not loaded in this build)</div>'}
        </div>`;
      }).join("");
  }

  function viewInsights(rows){
    const use = rows.filter(r => r.answers && Object.keys(r.answers).length);
    if(!use.length) return '<p class="dash-empty">No attempts match.</p>';

    const quad = { fw:[], nw:[], fr:0, nr:0 };            // flagged/not × wrong/right
    const changes = { rw:0, wr:0, ww:0 };
    const fastWrong = [];
    const pacing = [];

    use.forEach(r => {
      const idx = qIndex(r.testId);
      const times = Object.values(r.answers).map(a => a.timeSpentSeconds).filter(t => t > 0);
      const med = median(times) || 0;
      Object.entries(r.answers).forEach(([qid, a]) => {
        if(a.correct === null) return;
        const code = r.student && r.student.code || "?";
        if(a.correct){
          a.markedForReview ? quad.fr++ : quad.nr++;
        } else if(a.given !== null && a.given !== undefined){
          (a.markedForReview ? quad.fw : quad.nw).push({ code, qid, r, a });
          if(med && a.timeSpentSeconds > 0 && a.timeSpentSeconds < med * 0.5){
            fastWrong.push({ code, qid, t: a.timeSpentSeconds, med });
          }
        }
        if(a.changeCount > 0 && a.firstGiven !== null && a.firstGiven !== undefined &&
           a.given !== null && a.given !== undefined && a.firstGiven !== a.given && idx && idx[qid]){
          const firstCorrect = answerMatches(idx[qid].q, a.firstGiven);
          if(firstCorrect && !a.correct) changes.rw++;
          else if(!firstCorrect && a.correct) changes.wr++;
          else if(!firstCorrect && !a.correct) changes.ww++;
        }
      });
      (r.modules || []).forEach(m => {
        if(m.timeSpentSeconds) pacing.push({
          code: r.student && r.student.code || "?", label: (m.section === "Math" ? "Math " : "RW ") + (m.moduleLabel||""),
          used: m.timeSpentSeconds, limit: (m.timeLimitMinutes||0)*60, endedBy: m.endedBy
        });
      });
    });

    const blind = quad.nw.map(x =>
      `<tr><td>${esc(x.code)}</td><td>${esc(x.qid)}</td><td>${esc(x.r.testName || x.r.testId)}</td><td>${esc(givenLabel(x.a, (qIndex(x.r.testId)||{})[x.qid] && qIndex(x.r.testId)[x.qid].q))}</td><td>${mmss(x.a.timeSpentSeconds)}</td></tr>`).join("");

    return `
      <div class="dcard lead">
        <h3>⚠ Blind spots — confident and wrong (not flagged + incorrect)</h3>
        <p class="dash-hint">The highest-value list here: questions students got wrong without sensing trouble. Teach these first.</p>
        ${quad.nw.length ? `<table class="dtable slim"><thead><tr><th>Student</th><th>Question</th><th>Test</th><th>Their answer</th><th>Time</th></tr></thead><tbody>${blind}</tbody></table>` : '<p class="dash-empty">None — nice.</p>'}
      </div>
      <div class="dcard">
        <h3>Confidence quadrants</h3>
        <div class="quad-grid">
          <div class="quad q-nw"><b>${quad.nw.length}</b>not flagged + wrong<span>blind spots — see above</span></div>
          <div class="quad q-fw"><b>${quad.fw.length}</b>flagged + wrong<span>knows what they don't know</span></div>
          <div class="quad q-fr"><b>${quad.fr}</b>flagged + right<span>anxiety, not knowledge — costs time</span></div>
          <div class="quad q-nr"><b>${quad.nr}</b>not flagged + right<span>solid</span></div>
        </div>
      </div>
      <div class="dcard">
        <h3>Answer changes (first answer → final answer)</h3>
        <p>right → wrong: <b>${changes.rw}</b> &nbsp;·&nbsp; wrong → right: <b>${changes.wr}</b> &nbsp;·&nbsp; wrong → wrong: <b>${changes.ww}</b></p>
        <p class="dash-hint">A bad right→wrong ratio = tell them to stop second-guessing. A good wrong→right ratio = their instinct to re-check is working. Opposite advice — this is how you tell.</p>
      </div>
      <div class="dcard">
        <h3>Fast and wrong (under half the student's median time)</h3>
        ${fastWrong.length ? `<table class="dtable slim"><thead><tr><th>Student</th><th>Question</th><th>Time</th><th>Their median</th></tr></thead><tbody>` +
          fastWrong.map(x => `<tr><td>${esc(x.code)}</td><td>${esc(x.qid)}</td><td>${mmss(x.t)}</td><td>${mmss(x.med)}</td></tr>`).join("") +
          `</tbody></table><p class="dash-hint">Rushing, not misunderstanding — different fix.</p>` : '<p class="dash-empty">None.</p>'}
      </div>
      <div class="dcard">
        <h3>Pacing (module time used vs limit)</h3>
        ${pacing.map(p => {
          const pct = p.limit ? Math.min(100, Math.round(p.used/p.limit*100)) : 0;
          return `<div class="pace-row"><span>${esc(p.code)} · ${esc(p.label)}</span>
            <div class="pace-bar"><div style="width:${pct}%" class="${p.endedBy==='timer-expired'?'over':''}"></div></div>
            <span>${mmss(p.used)} / ${mmss(p.limit)}${p.endedBy==="timer-expired" ? " ⏰" : ""}</span></div>`;
        }).join("") || '<p class="dash-empty">No module timing yet.</p>'}
      </div>`;
  }

  /* ---------- attempt detail ---------- */
  /* ---------- Phase F §3: assignments ---------- */
  function assignRowStatus(code, a){
    if(a.completedAttemptId) return "completed";
    if(recs.some(r => r.status === "in-progress" && r.testId === a.testId &&
        r.student && r.student.key === code)) return "in-progress";
    if(a.expiresAt && Date.now() > Date.parse(a.expiresAt)) return "expired";
    return "pending";
  }
  function fmtDay(isoStr){
    if(!isoStr) return "—";
    return new Date(isoStr).toLocaleDateString(undefined, {month:"short", day:"numeric", year:"2-digit"});
  }

  function viewAssign(){
    if(!AttemptStore.available()){
      return '<p class="dash-empty">No storage in this copy — assignments can only be managed where records live (published app, or ?devstorage=1 locally).</p>';
    }
    if(source === "file"){
      // statuses/delete-gating are computed from recs; against an archive file
      // they'd be stale, and deleting could orphan a live in-progress attempt
      return '<p class="dash-empty">You\'re viewing a loaded archive file. Assignment statuses are computed from live attempts, so managing assignments is disabled — reload from storage first.</p>';
    }
    const knownCodes = Array.from(new Set(
      recs.map(r => r.student && r.student.key).filter(Boolean)
        .concat(assigns.map(a => a.code))
    )).sort();
    const d = new Date();
    const today = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    const rows = [];
    assigns.forEach(entry => entry.list.forEach(a => {
      if(typeof a === "string"){
        rows.push({ code: entry.code, legacy: true, a: { testId: a } });
      } else {
        rows.push({ code: entry.code, legacy: false, a });
      }
    }));
    const rowsHtml = rows.map(r => {
      if(r.legacy){
        return `<tr><td>${esc(r.code)}</td><td>${esc(r.a.testId)}</td><td>practice (legacy)</td><td>—</td><td>—</td><td>—</td><td>—</td><td></td></tr>`;
      }
      const a = r.a;
      const st = assignRowStatus(r.code, a);
      const deletable = st === "pending" || st === "expired";
      return `<tr>
        <td>${esc(r.code)}</td>
        <td>${esc((testsById[a.testId] && testsById[a.testId].testName) || a.testId)}</td>
        <td>${esc(a.category || "?")}</td>
        <td>${a.startCode ? "<b>" + esc(String(a.startCode)) + "</b>" : "—"}</td>
        <td>${fmtDay(a.windowOpens)}</td>
        <td>${fmtDay(a.expiresAt)}</td>
        <td><span class="dstatus ${ {completed:"ok", "in-progress":"warn", expired:"to"}[st] || "" }">${st}</span></td>
        <td>${deletable ? `<button class="dash-rel assign-del" data-code="${escAttr(r.code)}" data-aid="${escAttr(a.assignmentId)}">Delete</button>` : ""}</td>
      </tr>`;
    }).join("");
    return `
      <div class="dash-assign">
        <div class="dcard assign-form">
          <h3>New assignment</h3>
          <div class="af-grid">
            <label>Student codes (seen in storage)
              <select id="afCodes" multiple size="4">${knownCodes.map(c => `<option value="${escAttr(c)}">${esc(c)}</option>`).join("")}</select></label>
            <label>More codes (comma-separated)
              <input id="afFree" placeholder="AS-1234, AS-9XYZ" autocomplete="off"></label>
            <label>Test
              <select id="afTest">${(window.TEST_DATA || []).map(t => `<option value="${escAttr(t.testId)}">${esc(t.testName)}</option>`).join("")}</select></label>
            <label>Category
              <select id="afCat">
                <option value="test">Test — proctored, start code</option>
                <option value="practice">Practice — self-administered</option>
              </select></label>
            <label>Window opens (optional)
              <input type="date" id="afOpens"></label>
            <label>Expires (end of day)
              <input type="date" id="afExpires" value="${today}"></label>
          </div>
          <div class="af-actions">
            <button class="pill" id="afCreateBtn" style="padding:10px 26px;">Create assignment</button>
            <span class="dash-hint" id="afMsg"></span>
          </div>
          ${lastStartCode ? `<div class="af-code">Start code — read this aloud<div class="af-code-big">${esc(lastStartCode)}</div></div>` : ""}
        </div>
        ${rows.length ? `<table class="dtable"><thead><tr>
            <th>Student</th><th>Test</th><th>Category</th><th>Start code</th><th>Opens</th><th>Expires</th><th>Status</th><th></th>
          </tr></thead><tbody>${rowsHtml}</tbody></table>
          <p class="dash-hint">Assignments with an attempt (in-progress or completed) can't be deleted.</p>`
          : '<p class="dash-empty">No assignments yet. Students with no assignments see every published test as practice.</p>'}
      </div>`;
  }

  async function createAssignment(){
    const sel = Array.from($("afCodes").selectedOptions).map(o => o.value);
    const free = $("afFree").value.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    const bad = free.filter(c => !/^AS-[A-Z0-9]{4}$/.test(c));
    if(bad.length){ $("afMsg").textContent = "These codes don't look right: " + bad.join(", "); return; }
    const codes = Array.from(new Set(sel.concat(free)));
    if(!codes.length){ $("afMsg").textContent = "Pick or enter at least one student code."; return; }
    const testId = $("afTest").value;
    const category = $("afCat").value;
    const startCode = category === "test"
      ? String(Math.floor(100000 + Math.random() * 900000)) : null;
    const opens = $("afOpens").value ? new Date($("afOpens").value + "T00:00:00").toISOString() : null;
    const expires = $("afExpires").value ? new Date($("afExpires").value + "T23:59:00").toISOString() : null;
    let okAll = true, readFailed = false;
    for(const code of codes){
      const key = "assign:" + code;
      // read-modify-write: a failed READ must not be treated as "no
      // assignments" — appending to [] would clobber every existing
      // assignment (including a live proctored one). Skip this code on a
      // read error rather than destroy its list.
      const res = await AttemptStore.getResult(key);
      if(res.status === "error" || res.status === "nostorage"){ readFailed = true; continue; }
      const list = Array.isArray(res.value) ? res.value : [];
      list.push({
        assignmentId: "a-" + Math.floor(Date.now()/1000) + "-" + Math.random().toString(16).slice(2, 6),
        testId, category, startCode,
        windowOpens: opens, expiresAt: expires,
        assignedAt: new Date().toISOString(),
        completedAttemptId: null
      });
      if(!(await AttemptStore.set(key, list))) okAll = false;
    }
    lastStartCode = startCode;
    $("dashStatus").textContent = readFailed
      ? "Couldn't read some students' existing assignments — those were skipped to avoid overwriting. Try again."
      : okAll
        ? "Assigned " + testId + " to " + codes.join(", ") + "."
        : "Some assignment writes failed — storage problem.";
    await loadAssignsAndBugs();
    render();
  }

  async function deleteAssignment(code, assignmentId){
    const key = "assign:" + code;
    const list = await AttemptStore.get(key);
    if(!Array.isArray(list)) return;
    await AttemptStore.set(key, list.filter(x => !(x && x.assignmentId === assignmentId)));
    await loadAssignsAndBugs();
    render();
  }

  /* ---------- Phase F §9: bug reports ---------- */
  function viewBugs(){
    if(!bugs.length) return '<p class="dash-empty">No bug reports.</p>';
    return bugs.map(b => `
      <div class="dcard bug-card">
        <div class="bug-head"><b>${esc(b.studentCode || "?")}</b> · ${fmtDate(b.at)}
          <button class="dash-rel bug-dismiss" data-bug="${escAttr(b.__key)}">Dismiss</button></div>
        <div class="dash-hint">${esc(b.testId || "not in a test")}${b.testVersion ? " @ " + esc(b.testVersion) : ""}${b.moduleId ? " · " + esc(b.moduleId) : ""}${b.questionId ? " · " + esc(b.questionId) : ""}${b.timerRemainingSeconds != null ? " · " + mmss(b.timerRemainingSeconds) + " left" : ""}</div>
        <p class="bug-text">${esc(b.text || "")}</p>
      </div>`).join("");
  }

  function openDetail(attemptId){
    const r = recs.find(x => x.attemptId === attemptId);
    if(!r) return;
    const idx = qIndex(r.testId);
    const test = testsById[r.testId];
    const versionNote = (test && test.testVersion && r.testVersion !== (test.testVersion || "unversioned"))
      ? `<p class="dash-warn">⚠ This attempt was served test version “${esc(r.testVersion)}”, but this build carries “${esc(test.testVersion)}” — the review below may not match what the student saw (ATTEMPTS-SPEC §9).</p>` : "";
    const qRows = Object.entries(r.answers || {}).map(([qid, a]) => {
      const info = idx && idx[qid];
      const q = info && info.q;
      const status = a.correct === null ? "nokey" : (a.given === null ? "skipped" : (a.correct ? "correct" : "wrong"));
      const statusLabel = { nokey:"No key", skipped:"Skipped", correct:"Correct", wrong:"Incorrect" }[status];
      const correctLbl = q ? (q.type === "mcq" && hasKey(q) ? String.fromCharCode(65+q.correctAnswer) : String(q.correctAnswer ?? "—")) : "?";
      return `<div class="qreview-item">
        <div class="qri-head">
          <span class="qri-badge ${status}">${statusLabel}</span>
          <span class="qri-skill">${esc(qid)}${q && q.skill ? " · " + esc(q.skill) : ""}
            ${a.markedForReview ? ' · <span class="dflag">⚑ flagged</span>' : ""}</span>
        </div>
        ${q ? `<div class="qri-qtext">${fmt(q.questionText)}</div>` : ""}
        <div class="qri-meta">
          <b>Answer:</b> ${esc(givenLabel(a, q))}
          ${a.firstGiven !== null && a.firstGiven !== a.given ? ` <span class="dash-hint">(first: ${esc(givenLabel({given:a.firstGiven}, q))}, changed ×${a.changeCount})</span>` : ""}
          &nbsp;·&nbsp; <b>Key:</b> ${esc(correctLbl)}
          &nbsp;·&nbsp; ${mmss(a.timeSpentSeconds)} · ${a.visitCount} visit(s)
          ${a.eliminated && a.eliminated.length ? " · crossed out " + a.eliminated.map(i=>String.fromCharCode(65+i)).join(",") : ""}
          ${a.blankReason ? " · " + esc(a.blankReason) : ""}
        </div>
      </div>`;
    }).join("");
    $("dashDetailBody").innerHTML = `
      <h2>${esc(r.student && r.student.code || "?")} — ${esc(r.testName || r.testId)}</h2>
      <p class="dash-hint">${fmtDate(r.startedAt)} · ${esc(r.conditions||"unknown")} · ${statusBadge(r)} · score <b>${scoreStr(r)}</b>
        ${r.score && r.score.noKey ? " · " + r.score.noKey + " keyless" : ""} · version ${esc(r.testVersion||"?")}</p>
      ${versionNote}
      ${(r.modules||[]).map(m => `<span class="dmod">${esc(m.section)} ${esc(m.moduleLabel)}: ${mmss(m.timeSpentSeconds)} (${esc(m.endedBy||"?")})</span>`).join(" ")}
      <div class="dash-qlist">${qRows || '<p class="dash-empty">No answers recorded.</p>'}</div>`;
    $("dashDetail").classList.remove("hidden");
  }

  /* ---------- events ---------- */
  function attachBodyHandlers(){
    document.querySelectorAll("#dashBody [data-att]").forEach(tr =>
      tr.addEventListener("click", () => openDetail(tr.dataset.att)));
    document.querySelectorAll("#dashBody .dash-rel[data-rel]").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();                    // don't open the row's detail view
        toggleRelease(btn.dataset.rel);
      }));
    const cb = $("afCreateBtn");
    if(cb) cb.addEventListener("click", createAssignment);
    document.querySelectorAll("#dashBody .assign-del").forEach(btn =>
      btn.addEventListener("click", () => deleteAssignment(btn.dataset.code, btn.dataset.aid)));
    document.querySelectorAll("#dashBody .bug-dismiss").forEach(btn =>
      btn.addEventListener("click", async () => {
        await AttemptStore.remove(btn.dataset.bug);
        await loadAssignsAndBugs();
        render();
      }));
    document.querySelectorAll("#dashBody th[data-sort]").forEach(th =>
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if(sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === "startedAt" ? -1 : 1; }
        render();
      }));
  }

  let wired = false;
  function wire(){
    if(wired) return;
    wired = true;
    $("dashRefreshBtn").addEventListener("click", loadFromStorage);
    $("dashExportBtn").addEventListener("click", exportAll);
    $("dashDeleteBtn").addEventListener("click", deleteArchived);
    $("dashSignoutBtn").addEventListener("click", () => { if(showOnlyFn) showOnlyFn("screen-signin"); });
    $("dashDetailClose").addEventListener("click", () => $("dashDetail").classList.add("hidden"));
    $("dashDetail").addEventListener("click", e => { if(e.target.id === "dashDetail") $("dashDetail").classList.add("hidden"); });
    $("dashFilterTest").addEventListener("change", render);
    $("dashFilterStudent").addEventListener("change", render);
    $("dashLoadFile").addEventListener("change", e => { if(e.target.files[0]) loadFromFile(e.target.files[0]); });
    $("dashTabs").querySelectorAll("button").forEach(b =>
      b.addEventListener("click", () => {
        tab = b.dataset.tab;
        $("dashTabs").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
        render();
      }));
  }

  return {
    open(showOnly){
      showOnlyFn = showOnly;
      wire();
      showOnly("screen-dashboard");
      loadFromStorage();
    }
  };
})();
