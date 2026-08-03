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
  let profiles = {};             // CODE -> displayName, from student:<CODE> rows
  let source = "storage";        // "storage" | "file"
  let tab = "attempts";
  let sortKey = "startedAt", sortDir = -1;
  let lastExport = null;         // {ids:[attemptId], when} — unlocks delete
  /* Manifest entries — names and versions, no questions. Keyed under every id
     a test has carried so records written before a rename still resolve. */
  const testsById = {};
  (window.TEST_MANIFEST || []).forEach(t => {
    testsById[t.testId] = t;
    (t.legacyIds || []).forEach(old => { testsById[old] = t; });
  });

  /* Question-level views (item analysis, the per-question detail pane) need the
     full file, which is lazy-loaded. Ask for it, then re-render once it lands;
     until then the existing "question text unavailable" fallbacks apply, so a
     slow or failed load degrades rather than blanking the dashboard. */
  const fullTests = {};
  const loadingTests = {};
  function ensureTestLoaded(testId){
    const entry = testsById[testId];
    if(!entry || fullTests[entry.testId] || loadingTests[entry.testId]) return;
    if(!window.AppTestLoader) return;
    loadingTests[entry.testId] = true;
    window.AppTestLoader.load(entry).then(full => {
      fullTests[entry.testId] = full;
      loadingTests[entry.testId] = false;
      render();
      /* the attempt-detail pane lives outside render()'s output, so it would
         otherwise keep showing "question text unavailable" until reopened */
      if(openAttemptId && !$("dashDetail").classList.contains("hidden")) openDetail(openAttemptId);
    }).catch(()=>{
      /* leave loadingTests true: a failed fetch must not be re-issued on every
         subsequent render, which would hammer the network silently */
      loadingTests[entry.testId] = "failed";
    });
  }

  /* ---------- helpers ---------- */
  /* The index lives HERE, not on the test object. Hanging it off the test
     mutated the same object app.js keeps in window.__TESTDATA__ and re-caches,
     and because every entry points back at its whole parent module,
     JSON.stringify blew a 100 KB test up to ~2.6 MB — enough to blow the
     localStorage quota, whose failure is swallowed, silently killing the
     offline cache that keeps a sitting alive when the network drops. */
  const qIndexes = {};
  function qIndex(testId){
    const entry = testsById[testId];
    if(!entry) return null;
    const t = fullTests[entry.testId];
    if(!t){ ensureTestLoaded(testId); return null; }
    if(!qIndexes[entry.testId]){
      const idx = {};
      t.modules.forEach(mod => mod.questions.forEach(q => { idx[q.id] = { q, mod }; }));
      qIndexes[entry.testId] = idx;
    }
    return qIndexes[entry.testId];
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
  /* Counts read back out of a record are untrusted like any other record value
     (ATTEMPTS-SPEC §7): a crafted record can put markup where a number belongs,
     and these reach markup without esc(). Coerce rather than escape — they are
     numbers or they are nothing. */
  function num(v){ return typeof v === "number" && isFinite(v) ? v : null; }
  /* a single count straight off a record, rendered inertly */
  function cnt(v){ const n = num(v); return n === null ? "?" : n; }
  function countPair(o){
    const c = num(o && o.correct), g = num(o && o.graded);
    return (c === null || g === null) ? "—" : c + "/" + g;
  }
  function scoreStr(r){
    return num(r.score && r.score.graded) ? countPair(r.score) : "—";
  }
  function scorePct(r){
    const c = num(r.score && r.score.correct), g = num(r.score && r.score.graded);
    return g ? c / g : -1;
  }
  function statusBadge(r){
    const cls = { "completed":"ok", "in-progress":"warn", "timed-out":"to" }[r.status] || "";
    return `<span class="dstatus ${cls}">${esc(r.status || "?")}</span>`;
  }
  // Phase G §1: extended-time / untimed badge (blank for standard timing)
  function timingLabel(t){
    if(t === "untimed") return "Untimed";
    if(t === 1.5) return "Extended time 1.5×";
    if(t === 2) return "Extended time 2×";
    return "";
  }
  function timingBadgeHtml(t){
    const lbl = timingLabel(t);
    return lbl ? ` <span class="dstatus tm">${esc(lbl)}</span>` : "";
  }
  /* Codes resolve to names for display only. The code is always shown too, so
     both stay searchable and a row can still be matched to the pseudonymous
     records — the name never lives in an attempt. */
  function nameFor(code){ return profiles[String(code || "").toUpperCase()] || null; }
  function studentCell(code){
    const c = String(code || "?");
    const n = nameFor(c);
    return n ? `<b>${esc(n)}</b> <span class="dcode">${esc(c)}</span>` : esc(c);
  }

  function givenLabel(entry, q){
    if(entry.given === null || entry.given === undefined) return "—";
    if(q && q.type === "mcq" && typeof entry.given === "number") return String.fromCharCode(65 + entry.given);
    return String(entry.given);
  }
  function filtered(){
    const ft = $("dashFilterTest").value;
    const fs = $("dashFilterStudent").value;
    // match through the manifest so a renamed test's older attempts still match
    return recs.filter(r => (!ft || sameTest(r.testId, ft)) && (!fs || (r.student && r.student.key) === fs));
  }

  /* ---------- data load ---------- */
  async function loadFromStorage(){
    source = "storage";
    const local = AttemptStore.isLocal();
    $("dashStatus").textContent = local
      ? "Loading attempts saved on this device…"
      : "Loading attempts from shared storage…";
    /* Remote: pull the server's rows into the local cache first, or the
       dashboard would only ever list what THIS browser happened to write —
       records from students' own devices would be invisible. */
    if(AttemptStore.isRemote() && AttemptStore.hasAuthToken()){
      try{
        const n = await AttemptStore.pullAllForTutor();
        $("dashStatus").textContent = "Pulled " + n + " row(s) from the server…";
      }catch(e){
        $("dashStatus").textContent = "Couldn't reach the server — showing what's cached on this device.";
      }
    }
    const keys = await AttemptStore.list("attempt:");
    if(keys === null){
      // only reachable when even localStorage is unusable (private mode, quota)
      recs = [];
      $("dashStatus").innerHTML = "<b>Storage isn't readable in this browser.</b> Attempts can't be listed here. You can still inspect a downloaded archive: use “Load archive file”.";
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
    $("dashStatus").textContent = recs.length +
      (local ? " attempt(s) saved on this device (local mode — not synced)."
             : " attempt(s) in shared storage.") +
      (failed ? " (" + failed + " unreadable — see console.)" : "") +
      (lastExport ? "" : " Download an archive before deleting anything.");
    renderAll();
  }

  async function loadAssignsAndBugs(){
    assigns = []; bugs = []; profiles = {};
    /* display-name profiles live in their own rows, never inside attempts */
    const pKeys = await AttemptStore.list("student:");
    if(pKeys){
      for(const k of pKeys){
        const v = await AttemptStore.get(k);
        const nm = v && typeof v.displayName === "string" ? v.displayName.trim() : "";
        if(nm) profiles[k.slice("student:".length).toUpperCase()] = nm;
      }
    }
    /* Phase H §3: assignments are one row per assignment
       (assign:<CODE>:<assignmentId>), which is what removes the Phase F
       read-modify-write clobber. Legacy assign:<CODE> arrays still load. */
    const byCode = {};
    const entry = c => (byCode[c] = byCode[c] || { code: c, list: [], sentinel: false });
    const aKeys = await AttemptStore.list("assign:");
    if(aKeys){
      for(const k of aKeys){
        const rest = k.slice("assign:".length);
        const sep = rest.indexOf(":");
        const code = sep === -1 ? rest : rest.slice(0, sep);
        const e = entry(code);
        const v = await AttemptStore.get(k);
        if(sep === -1){
          if(Array.isArray(v)) e.list = e.list.concat(v.filter(Boolean));   // legacy array
        } else if(rest.slice(sep) === ":__none"){
          // vestigial: nothing writes these any more (absent == empty since
          // 2026-08-01). Still read so pre-existing rows behave, and so the
          // code still appears in the clear-assignments picker to tidy them.
          e.sentinel = true;
        } else if(v && v.assignmentId){
          e.list.push(v);
        }
      }
    }
    Object.keys(byCode).forEach(c => assigns.push(byCode[c]));
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
    /* Collapse legacy ids onto the canonical one, or a renamed test appears as
       two rows in the filter and each shows only half its attempts. */
    const tests = [...new Set(recs.map(r => (testsById[r.testId] || {}).testId || r.testId))];
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
    /* setLocal, not set(): set() would enqueue this through the STUDENT RPC,
       and fn_upsert_attempt deliberately ignores `released` so students can't
       self-release. The tutor's authenticated table write is the only path
       that can actually flip it. */
    let ok = await AttemptStore.setLocal(r.attemptId, r);
    if(ok && AttemptStore.isRemote()){
      try{
        await AttemptStore.adminUpsert(r.attemptId, (r.student && r.student.key) || null, r);
      }catch(e){ ok = false; }
    }
    if(!ok){
      r.released = !r.released;                 // roll back — nothing persisted
      $("dashStatus").textContent = AttemptStore.isRemote()
        ? "Release didn't save to the server — check your tutor sign-in and try again."
        : "Release toggle didn't save — storage unavailable.";
    } else if(AttemptStore.isRemote()){
      $("dashStatus").textContent = r.released
        ? "Released — the student sees Score Details at their next sign-in or refresh."
        : "Un-released — Score Details hidden from the student again.";
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
          <td>${studentCell(r.student && r.student.code)}</td>
          <td>${esc(r.testName || r.testId)}</td>
          <td>${fmtDate(r.startedAt)}</td>
          <td><b>${scoreStr(r)}</b></td>
          <td>${statusBadge(r)}</td>
          <td>${releaseCell(r)}</td>
          <td>${esc(r.conditions || "unknown")}${timingBadgeHtml(r.timing)}</td>
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
    /* Union in codes known only from assignments or profile rows. A student
       onboarded as generate code → save name → copy link has neither an
       attempt nor an assignment yet, and used to be invisible here until
       their first attempt — a dead end right after "Save name only". The
       student filter still applies; the test filter only narrows the attempt
       lists, so a filtered-out student shows an empty card, not no card. */
    const fs = $("dashFilterStudent").value;
    const addCode = c => { if(c && (!fs || c === fs)) byStudent[c] = byStudent[c] || []; };
    recs.forEach(r => addCode(r.student && r.student.key));   // attempts hidden by the test filter
    /* live-roster students only in the live view — an archive file is a
       self-contained snapshot, and assigns/profiles still hold live storage */
    if(source === "storage"){
      assigns.forEach(a => addCode(a.code));
      Object.keys(profiles).forEach(addCode);
    }
    const keys = Object.keys(byStudent).sort();
    if(!keys.length) return '<p class="dash-empty">No students yet — add codes in the Assign tab.</p>';
    return keys.map(k => {
      const list = byStudent[k].slice().sort((a,b) => (a.startedAt||"").localeCompare(b.startedAt||""));
      /* No sign-in link for keys that aren't real codes ("?" grouping, or a
         hand-written storage key) — parseFragmentCode would reject the link
         anyway. valid() normalizes before testing, so the link carries the
         canonical form rather than whatever casing the key happened to use. */
      const linkBtn = StudentCode.valid(k)
        ? `<button class="dash-rel copy-link" data-code="${escAttr(StudentCode.normalize(k))}"
            title="Copy a link that signs this student in">Copy sign-in link</button>` : "";
      let body;
      if(list.length){
        body = `<table class="dtable slim"><thead><tr><th>Date</th><th>Test</th><th>Score</th><th>RW</th><th>Math</th><th>Status</th><th>Conditions</th></tr></thead><tbody>` +
        list.map(r => {
          const bs = (r.score && r.score.bySection) || {};
          const rw = bs["Reading and Writing"], ma = bs["Math"];
          return `<tr data-att="${escAttr(r.attemptId)}">
            <td>${fmtDate(r.startedAt)}</td><td>${esc(r.testName || r.testId)}</td>
            <td><b>${scoreStr(r)}</b></td>
            <td>${countPair(rw)}</td>
            <td>${countPair(ma)}</td>
            <td>${statusBadge(r)}</td><td>${esc(r.conditions || "unknown")}</td></tr>`;
        }).join("") + `</tbody></table>`;
      } else {
        const hasAny = recs.some(r => r.student && r.student.key === k);
        const ae = source === "storage" ? assigns.find(a => a.code === k) : null;
        const assigned = ae ? ae.list.length : 0;
        body = `<p class="dash-hint">${
          hasAny ? "No attempts match the current filter."
          : assigned ? "No attempts yet — " + assigned + " test(s) assigned."
          : "No attempts yet — nothing assigned, so their home screen is empty."}</p>`;
      }
      return `<div class="dcard">
        <h3>${studentCell(k)} <span class="dcard-sub">${list.length} attempt(s)</span>
          ${linkBtn}</h3>` + body + `</div>`;
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
          /* Both sides must come from the SAME rule. This recomputed
             firstGiven while reading the final verdict off the record, so for
             any attempt recorded before the SPR rule changed (2026-08-02) the
             halves disagreed: a second-guess could be counted as
             wrong->right when the record says it never was, and the
             right->wrong counter — the one this panel exists to surface —
             read zero in exactly the case it should have caught. */
          const firstCorrect = answerMatches(idx[qid].q, a.firstGiven);
          const finalCorrect = answerMatches(idx[qid].q, a.given);
          if(firstCorrect && !finalCorrect) changes.rw++;
          else if(!firstCorrect && finalCorrect) changes.wr++;
          else if(!firstCorrect && !finalCorrect) changes.ww++;
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
  /* Two testIds can name the SAME test across a rename, so compare through the
     manifest. Matching raw ids missed an in-progress attempt written under the
     other id, which showed the row as "pending" — and pending rows offer
     Delete, i.e. the dashboard would offer to delete an assignment a student
     was sitting at that moment. */
  function sameTest(a, b){
    if(!a || !b) return false;
    if(a === b) return true;
    const ea = testsById[a], eb = testsById[b];
    return !!(ea && eb && ea.testId === eb.testId);
  }
  /* How many assignments a code has for a given canonical test — gates the
     untagged-attempt fallback below, exactly as the student app does, so the
     two views agree. */
  function assignCountFor(code, testId){
    const canon = (testsById[testId] || {}).testId || testId;
    let n = 0;
    assigns.forEach(entry => {
      if(entry.code !== code || !Array.isArray(entry.list)) return;
      entry.list.forEach(x => {
        if(typeof x === "string") return;       // legacy bare-testId, not a real row
        if(((testsById[x.testId] || {}).testId || x.testId) === canon) n++;
      });
    });
    return n;
  }
  /* Attempts belonging to THIS assignment. Prefer the explicit assignmentId
     the record carries; fall back to same-test untagged records only when the
     code has a single assignment for that test AND the attempt was
     administered the way the assignment's category implies (a practice run
     must not be counted against a proctored assignment) — the same migration
     rule the student home uses, so the two views agree. */
  function attemptCategoryMatches(category, conditions){
    return category === "test" ? conditions === "proctored" : conditions !== "proctored";
  }
  function attemptsForAssignment(code, a){
    const explicit = recs.filter(r => r.student && r.student.key === code &&
      r.assignmentId && r.assignmentId === a.assignmentId);
    if(explicit.length) return explicit;
    if(assignCountFor(code, a.testId) === 1){
      return recs.filter(r => r.student && r.student.key === code &&
        !r.assignmentId && sameTest(r.testId, a.testId) &&
        attemptCategoryMatches(a.category, r.conditions));
    }
    return [];
  }
  function assignRowStatus(code, a){
    const mine = attemptsForAssignment(code, a);
    // completion is DERIVED from the attempt records (the flag is a hint that
    // was silently never written before 2026-08-02); either signal counts
    if(a.completedAttemptId ||
       mine.some(r => r.status === "completed" || r.status === "timed-out")) return "completed";
    if(mine.some(r => r.status === "in-progress")) return "in-progress";
    if(a.expiresAt && Date.now() > Date.parse(a.expiresAt)) return "expired";
    return "pending";
  }
  function fmtDay(isoStr){
    if(!isoStr) return "—";
    return new Date(isoStr).toLocaleDateString(undefined, {month:"short", day:"numeric", year:"2-digit"});
  }

  function viewAssign(){
    if(!AttemptStore.available()){
      return '<p class="dash-empty">Storage isn\'t usable in this browser, so assignments can\'t be managed here.</p>';
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
    // codes that currently HAVE an assign key (non-empty list) — reset targets
    // reset targets: any code that has rows OR an explicit "assigned nothing"
    const assignedCodes = assigns
      .filter(e => (Array.isArray(e.list) && e.list.length) || e.sentinel)
      .map(e => e.code).sort();
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
        return `<tr><td>${studentCell(r.code)}</td><td>${esc(r.a.testId)}</td><td>practice (legacy)</td><td>Standard</td><td>—</td><td>—</td><td>—</td><td>—</td><td></td></tr>`;
      }
      const a = r.a;
      const st = assignRowStatus(r.code, a);
      const deletable = st === "pending" || st === "expired";
      return `<tr>
        <td>${studentCell(r.code)} <button class="dash-rel copy-link" data-code="${escAttr(r.code)}" title="Copy a link that signs this student in">Link</button></td>
        <td>${esc((testsById[a.testId] && testsById[a.testId].testName) || a.testId)}</td>
        <td>${esc(a.category || "?")}</td>
        <td>${esc(timingLabel(a.timing) || "Standard")}</td>
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
              <span class="af-codegen">
                <input id="afFree" placeholder="AS-XXXXXXXX, AS-XXXXXXXX" autocomplete="off">
                <button type="button" class="pill ghost" id="afGenBtn"
                  title="Generate a new unused code (unambiguous alphabet, no O/0/I/1)">Generate</button>
              </span></label>
            <label>Student name (display)
              <input id="afName" placeholder="Erin K" autocomplete="off"
                title="Shown to the student and in this dashboard. Stored in its own profile row — never inside an attempt record."></label>
            <label>Test
              <select id="afTest">${(window.TEST_MANIFEST || []).map(t => `<option value="${escAttr(t.testId)}">${esc(t.testName)}</option>`).join("")}</select></label>
            <label>Category
              <select id="afCat">
                <option value="test">Test — proctored, start code</option>
                <option value="practice">Practice — self-administered</option>
              </select></label>
            <label>Timing
              <select id="afTiming">
                <option value="1">Standard</option>
                <option value="1.5">Time and a half (1.5×)</option>
                <option value="2">Double time (2×)</option>
                <option value="untimed">Untimed</option>
              </select></label>
            <label>Window opens (optional)
              <input type="date" id="afOpens"></label>
            <label>Expires (end of day)
              <input type="date" id="afExpires" value="${today}"></label>
          </div>
          <div class="af-actions">
            <button class="pill" id="afCreateBtn" style="padding:10px 26px;">Create assignment</button>
            <button class="pill ghost" id="afNameBtn" style="padding:10px 20px;"
              title="Save just the display name for the selected code(s) — leaves assignments untouched">Save name only</button>
            <span class="dash-hint" id="afMsg"></span>
          </div>
          ${lastStartCode ? `<div class="af-code">Start code — read this aloud<div class="af-code-big">${esc(lastStartCode)}</div></div>` : ""}
        </div>
        ${rows.length ? `<table class="dtable"><thead><tr>
            <th>Student</th><th>Test</th><th>Category</th><th>Timing</th><th>Start code</th><th>Opens</th><th>Expires</th><th>Status</th><th></th>
          </tr></thead><tbody>${rowsHtml}</tbody></table>
          <p class="dash-hint">Assignments with an attempt (in-progress or completed) can't be deleted.</p>`
          : '<p class="dash-empty">No assignments yet. A student with no assignments sees an empty home screen — everything has to be assigned.</p>'}
        ${assignedCodes.length ? `
          <div class="assign-reset">
            <h3>Clear a student's assignments</h3>
            <p class="dash-hint">Removes every assignment for that student. Their home screen goes empty until something new is assigned; recorded attempts are untouched.</p>
            <div class="af-actions">
              <select id="afResetCode">${assignedCodes.map(c => `<option value="${escAttr(c)}">${esc(c)}</option>`).join("")}</select>
              <button class="pill ghost" id="afResetBtn" style="padding:9px 22px;">Clear all assignments</button>
            </div>
          </div>` : ""}
      </div>`;
  }

  /* Every code this dashboard has seen — attempts, assignments and profiles.
     Used to guarantee a generated code is unused. */
  function knownCodeSet(){
    const s = Object.create(null);
    recs.forEach(r => { const k = r.student && r.student.key; if(k) s[String(k).toUpperCase()] = true; });
    assigns.forEach(a => { if(a.code) s[String(a.code).toUpperCase()] = true; });
    Object.keys(profiles).forEach(c => { s[c.toUpperCase()] = true; });
    return s;
  }

  /* Generate an unused code. 32^8 ≈ 1.1e12, so a collision is vanishingly
     unlikely, but checking is free and the failure it prevents — two students
     sharing a code, and therefore each other's records — is severe. */
  function generateUnusedCode(){
    const taken = knownCodeSet();
    for(let i = 0; i < 50; i++){
      const c = StudentCode.generate();
      if(!taken[c]) return c;
    }
    return null;
  }

  function appendGeneratedCode(){
    const c = generateUnusedCode();
    if(!c){ $("afMsg").textContent = "Couldn't find an unused code — try again."; return; }
    const cur = $("afFree").value.trim();
    $("afFree").value = cur ? cur.replace(/[\s,;]+$/, "") + ", " + c : c;
    $("afMsg").textContent = "Generated " + c + " — give this to the student.";
  }

  /* Magic sign-in link. The code goes in the FRAGMENT, never a query string,
     so it is not sent to the server and stays out of access logs. */
  function signInLink(code){
    const base = location.origin + location.pathname.replace(/[^/]*$/, "");
    return base + "#" + code;
  }
  async function copySignInLink(code){
    const url = signInLink(code);
    let ok = false;
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){
        await navigator.clipboard.writeText(url); ok = true;
      }
    }catch(e){}
    if(!ok){                                   // clipboard blocked: show it to copy by hand
      window.prompt("Copy this sign-in link for " + code + ":", url);
    }
    $("dashStatus").textContent = ok
      ? "Sign-in link for " + code + " copied — it signs them in and clears itself from the address bar."
      : "Clipboard unavailable — the link is in the dialog.";
  }

  /* Codes chosen in the form: multi-select plus free entry. */
  function formCodes(){
    const sel = Array.from($("afCodes").selectedOptions).map(o => o.value);
    const free = $("afFree").value.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    return { codes: Array.from(new Set(sel.concat(free))),
             bad: free.filter(c => !StudentCode.valid(c)) };
  }

  /* Write the display-name profile row. Its own key, its own row — never
     merged into an attempt (ATTEMPTS-SPEC §7a). Writing goes through the
     tutor's authenticated table access; there is deliberately no anon RPC for
     this, so a student can't rename themselves or anyone else. */
  async function saveProfiles(codes, name){
    const clean = String(name || "").trim().slice(0, 60);
    let ok = true;
    for(const code of codes){
      const key = "student:" + code;
      if(clean){
        if(!(await AttemptStore.setLocal(key, { displayName: clean }))) ok = false;
        if(AttemptStore.isRemote()){
          try{ await AttemptStore.adminUpsert(key, code, { displayName: clean }); }
          catch(e){ ok = false; }
        }
        profiles[code] = clean;
      } else {
        await AttemptStore.remove(key);                 // blank clears the name
        if(AttemptStore.isRemote()){
          try{ await AttemptStore.adminDelete(key); }catch(e){ ok = false; }
        }
        delete profiles[code];
      }
    }
    return ok;
  }

  async function saveNameOnly(){
    const { codes, bad } = formCodes();
    if(bad.length){ $("afMsg").textContent = "These codes don't look right: " + bad.join(", "); return; }
    if(!codes.length){ $("afMsg").textContent = "Pick or enter at least one student code."; return; }
    const name = $("afName").value.trim();
    const ok = await saveProfiles(codes, name);
    $("dashStatus").textContent = ok
      ? (name ? "Name saved for " + codes.join(", ") + " — assignments untouched."
              : "Name cleared for " + codes.join(", ") + " — they'll see their code again.")
      : "Couldn't save the name — check your tutor sign-in and try again.";
    await loadAssignsAndBugs();
    render();
  }

  async function createAssignment(){
    const { codes, bad } = formCodes();
    if(bad.length){ $("afMsg").textContent = "These codes don't look right: " + bad.join(", "); return; }
    if(!codes.length){ $("afMsg").textContent = "Pick or enter at least one student code."; return; }
    // a name typed here is saved as a profile row, separate from the assignment
    const nameIn = $("afName").value.trim();
    if(nameIn) await saveProfiles(codes, nameIn);
    const testId = $("afTest").value;
    const category = $("afCat").value;
    const timingRaw = $("afTiming").value;                       // Phase G §1
    const timing = timingRaw === "untimed" ? "untimed" : parseFloat(timingRaw);
    const startCode = category === "test"
      ? String(Math.floor(100000 + Math.random() * 900000)) : null;
    const opens = $("afOpens").value ? new Date($("afOpens").value + "T00:00:00").toISOString() : null;
    const expires = $("afExpires").value ? new Date($("afExpires").value + "T23:59:00").toISOString() : null;
    /* Phase H §3: one row per assignment. No read-modify-write, so the
       Phase F clobber is gone — concurrent writers touch different keys. */
    let okAll = true, remoteFailed = false;
    for(const code of codes){
      const a = {
        assignmentId: "a-" + Math.floor(Date.now()/1000) + "-" + Math.random().toString(16).slice(2, 6),
        testId, category, startCode, timing,
        windowOpens: opens, expiresAt: expires,
        assignedAt: new Date().toISOString(),
        completedAttemptId: null
      };
      const key = "assign:" + code + ":" + a.assignmentId;
      if(!(await AttemptStore.setLocal(key, a))) okAll = false;
      await AttemptStore.remove("assign:" + code + ":__none");   // tidy any vestigial sentinel
      if(AttemptStore.isRemote()){
        try{
          await AttemptStore.adminUpsert(key, code, a);
          await AttemptStore.adminDelete("assign:" + code + ":__none");
        }catch(e){ remoteFailed = true; }
      }
    }
    lastStartCode = startCode;
    $("dashStatus").textContent = !okAll
      ? "Some assignment writes failed — storage problem."
      : remoteFailed
        ? "Saved locally, but the server write failed — students won't see this until it syncs. Check your tutor sign-in and try again."
        : "Assigned " + testId + " to " + codes.join(", ") +
          (AttemptStore.isRemote() ? " (synced)." : ".");
    await loadAssignsAndBugs();
    render();
  }

  async function deleteAssignment(code, assignmentId){
    const key = "assign:" + code + ":" + assignmentId;
    const keys = (await AttemptStore.list("assign:" + code + ":")) || [];
    const remaining = keys.filter(k => k !== key && k.slice(-7) !== ":__none");
    // "assigned nothing" and "never configured" are the same thing now, so
    // deleting the last assignment needs no sentinel to record the difference —
    // it just leaves the student with an empty home screen, which is still
    // worth confirming since it is easy to do by accident.
    if(remaining.length === 0 &&
       !confirm("This is " + code + "'s last assignment.\n\nDeleting it leaves them with NOTHING on their home screen until you assign something new.\n\nDelete anyway?")){
      return;
    }
    await AttemptStore.remove(key);
    if(AttemptStore.isRemote()){ try{ await AttemptStore.adminDelete(key); }catch(e){} }
    await loadAssignsAndBugs();
    render();
  }

  /* Clears every assignment row for a student, including any legacy array and
     the vestigial __none sentinel. There is no default set to fall back to, so
     the confirmation says plainly what the student will see. */
  async function clearAssignments(code){
    if(!code) return;
    if(!confirm("Clear all assignments for " + code + "?\n\nThey will see NOTHING on their home screen — both Your Tests and Practice and Prepare will be empty — until you assign something new.\n\nTheir recorded attempts are not affected.")) return;
    const keys = (await AttemptStore.list("assign:" + code)) || [];   // rows + legacy array
    let ok = true;
    for(const k of keys){
      if(!(await AttemptStore.remove(k))) ok = false;
      if(AttemptStore.isRemote()){ try{ await AttemptStore.adminDelete(k); }catch(e){ ok = false; } }
    }
    $("dashStatus").textContent = ok
      ? "Cleared every assignment for " + code + " — their home screen is now empty."
      : "Clear partly failed — check the connection and try again.";
    await loadAssignsAndBugs();
    render();
  }

  /* ---------- Phase H §7: one-time migration ----------
     Push records this device recorded during local-mode use up to the server,
     skipping any key that already exists remotely so re-running is harmless. */
  async function migrateLocalToServer(){
    if(!AttemptStore.isRemote()){
      $("dashStatus").textContent = "No server configured — nothing to upload to.";
      return;
    }
    if(!AttemptStore.hasAuthToken()){
      $("dashStatus").textContent = "Sign in as tutor first — uploading needs an authenticated session.";
      return;
    }
    $("dashStatus").textContent = "Checking what the server already has…";
    let remoteKeys;
    try{
      const rows = await AttemptStore.adminSelectAll();
      remoteKeys = {};
      (rows || []).forEach(r => { remoteKeys[r.key] = true; });
    }catch(e){
      $("dashStatus").textContent = "Couldn't read the server: " + (e.message || e);
      return;
    }
    let sent = 0, skipped = 0, failed = 0;
    for(const prefix of ["attempt:", "assign:", "bug:"]){
      const keys = (await AttemptStore.list(prefix)) || [];
      for(const k of keys){
        if(remoteKeys[k]){ skipped++; continue; }
        const v = await AttemptStore.get(k);
        if(!v) { failed++; continue; }
        // owner: attempts carry student.code; assignment keys embed the code
        let owner = null;
        if(k.indexOf("attempt:") === 0) owner = (v.student && v.student.key) || null;
        else if(k.indexOf("assign:") === 0) owner = k.split(":")[1] || null;
        else if(k.indexOf("bug:") === 0) owner = v.studentCode || null;
        try{ await AttemptStore.adminUpsert(k, owner, v); sent++; }
        catch(e){ failed++; }
      }
    }
    $("dashStatus").textContent =
      "Upload finished — " + sent + " sent, " + skipped + " already on the server" +
      (failed ? ", " + failed + " failed" : "") + ".";
    await loadFromStorage();
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

  let openAttemptId = null;      // so a lazy test load can refresh this pane
  function openDetail(attemptId){
    const r = recs.find(x => x.attemptId === attemptId);
    if(!r) return;
    openAttemptId = attemptId;
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
          ${a.firstGiven !== null && a.firstGiven !== a.given ? ` <span class="dash-hint">(first: ${esc(givenLabel({given:a.firstGiven}, q))}, changed ×${cnt(a.changeCount)})</span>` : ""}
          &nbsp;·&nbsp; <b>Key:</b> ${esc(correctLbl)}
          &nbsp;·&nbsp; ${mmss(a.timeSpentSeconds)} · ${cnt(a.visitCount)} visit(s)
          ${a.eliminated && a.eliminated.length ? " · crossed out " + a.eliminated.map(i=>String.fromCharCode(65+i)).join(",") : ""}
          ${a.blankReason ? " · " + esc(a.blankReason) : ""}
        </div>
      </div>`;
    }).join("");
    // §6: jump to the student-facing Score Details page (admin-only, works
    // regardless of release). Only when this build carries the matching test.
    // (reuses `test` declared above.)
    const canOpen = source === "storage" && test &&
      (test.testVersion || "unversioned") === r.testVersion;
    $("dashDetailBody").innerHTML = `
      <h2>${studentCell(r.student && r.student.code)} — ${esc(r.testName || r.testId)}</h2>
      <p class="dash-hint">${fmtDate(r.startedAt)} · ${esc(r.conditions||"unknown")}${timingBadgeHtml(r.timing)} · ${statusBadge(r)} · score <b>${scoreStr(r)}</b>
        ${num(r.score && r.score.noKey) ? " · " + num(r.score.noKey) + " keyless" : ""} · version ${esc(r.testVersion||"?")}</p>
      ${canOpen ? '<p><button class="dash-rel" id="dashStudentView">Open student view →</button></p>' : ""}
      ${versionNote}
      ${(r.modules||[]).map(m => `<span class="dmod">${esc(m.section)} ${esc(m.moduleLabel)}: ${mmss(m.timeSpentSeconds)} (${esc(m.endedBy||"?")})</span>`).join(" ")}
      <div class="dash-qlist">${qRows || '<p class="dash-empty">No answers recorded.</p>'}</div>`;
    if(canOpen){
      const btn = $("dashStudentView");
      if(btn) btn.addEventListener("click", ()=>{
        $("dashDetail").classList.add("hidden");
        if(window.AppScoreView) AppScoreView.open(r.testId, r);
      });
    }
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
    const gb = $("afGenBtn");
    if(gb) gb.addEventListener("click", appendGeneratedCode);
    document.querySelectorAll("#dashBody .copy-link").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();                   // don't open the row's detail view
        copySignInLink(btn.dataset.code);
      }));
    const nb = $("afNameBtn");
    if(nb) nb.addEventListener("click", saveNameOnly);
    const rb = $("afResetBtn");
    if(rb) rb.addEventListener("click", () => clearAssignments($("afResetCode").value));
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
    $("dashMigrateBtn").addEventListener("click", migrateLocalToServer);
    $("dashMigrateBtn").classList.toggle("hidden", !AttemptStore.isRemote());
    $("dashExportBtn").addEventListener("click", exportAll);
    $("dashDeleteBtn").addEventListener("click", deleteArchived);
    $("dashSignoutBtn").addEventListener("click", () => {
      AttemptStore.signOutTutor();          // drop the tutor session with the view
      if(showOnlyFn) showOnlyFn("screen-signin");
    });
    $("dashDetailClose").addEventListener("click", () => {
      openAttemptId = null;
      $("dashDetail").classList.add("hidden");
    });
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
    nameFor: nameFor,
    open(showOnly){
      showOnlyFn = showOnly;
      wire();
      showOnly("screen-dashboard");
      loadFromStorage();
    }
  };
})();
