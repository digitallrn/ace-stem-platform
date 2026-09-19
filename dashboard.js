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
  /* Tombstones (2026-09-18): key -> value for every tomb:<attemptKey> and
     tomb:student:<CODE> row. A tombstoned record stays LISTED here, marked
     "deleted" — present-but-marked is the whole point (an audit can tell
     "removed" from "never existed"); it is on no student surface. */
  let tombs = {};
  let source = "storage";        // "storage" | "file"
  let tab = "attempts";
  let sortKey = "startedAt", sortDir = -1;
  let lastExport = null;         // {ids:[attemptId], when} — unlocks delete
  /* ---- custom practice sets (2026-08-31) ---- */
  let sets = [];                 // loaded pset:<setId> rows
  let builder = null;            // {setId|null, name, subject, refs:[]} while editing
  let bankFilter = { q: "", subject: "", retired: true };   // Question Bank tab
  let builderTestId = "";        // which form's questions the builder shows
  let setsMsg = "";              // one-line status inside the Sets tab
  let saMsg = "";                // outcome line under the set-assign form — a
                                 // module var, because render() rebuilds
                                 // #dashBody and a textContent write to the
                                 // old #saMsg node would be wiped with it
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

  /* Banks, same lazy pattern, through the shared loader (AppBankLoader) so
     the two apps use one cache. Banks are NOT tests: nothing here ever joins
     them into testsById or the test filter — they exist for the Question
     Bank tab, the set builder, and resolving set-record provenance. */
  const loadedBanks = {};
  const loadingBanks = {};
  function ensureBankLoaded(bankId){
    if(!bankId || loadedBanks[bankId] || loadingBanks[bankId]) return;
    if(!window.AppBankLoader || !AppBankLoader.byId(bankId)) return;
    loadingBanks[bankId] = true;
    AppBankLoader.load(bankId).then(bank => {
      loadedBanks[bankId] = bank;
      loadingBanks[bankId] = false;
      renderKeepingInputs();               // an async settle must not wipe a form the tutor is typing in
      if(openAttemptId && !$("dashDetail").classList.contains("hidden")) openDetail(openAttemptId);
    }).catch(()=>{ loadingBanks[bankId] = "failed"; });
  }
  /* Resolve a SET record's answer key (a fully-qualified ref) to its question
     through the record's own frozen provenance — the dashboard analogue of
     the student app's review rebuild. Returns {q} or null (content not
     loaded yet / unresolvable); callers keep their honest "unavailable"
     fallbacks either way, so set records are handled EXPLICITLY rather than
     falling through the form-only qIndex and reading as missing. */
  function setProvLookup(r, qid){
    if(!r || r.kind !== "set" || !Array.isArray(r.setQuestions)) return null;
    const e = r.setQuestions.find(x => x && x.ref === qid);
    if(!e) return null;
    if(e.source === "bank"){
      const b = loadedBanks[e.bankId];
      if(!b){ ensureBankLoaded(e.bankId); return null; }
      const q = (b.questions || []).find(x => x && x.qid === e.qid);
      return q ? { q: q } : null;
    }
    if(e.source === "form"){
      const ix = qIndex(e.testId);
      return (ix && ix[e.qid]) || null;
    }
    return null;
  }
  function ensureTestLoaded(testId){
    const entry = testsById[testId];
    if(!entry || fullTests[entry.testId] || loadingTests[entry.testId]) return;
    if(!window.AppTestLoader) return;
    loadingTests[entry.testId] = true;
    window.AppTestLoader.load(entry).then(full => {
      fullTests[entry.testId] = full;
      loadingTests[entry.testId] = false;
      renderKeepingInputs();               // an async settle must not wipe a form the tutor is typing in
      /* the attempt-detail pane lives outside render()'s output, so it would
         otherwise keep showing "question text unavailable" until reopened */
      if(openAttemptId && !$("dashDetail").classList.contains("hidden")) openDetail(openAttemptId);
    }).catch(()=>{
      /* leave loadingTests true: a failed fetch must not be re-issued on every
         subsequent render, which would hammer the network silently */
      loadingTests[entry.testId] = "failed";
    });
  }

  /* ================= CANONICAL-ID AWARENESS (2026-09-07) =================
     testdata/dedup-index.js (window.DEDUP_INDEX) is the test-bank repo's
     canonical-id index: for every <testId>:<qid> and <bankId>:<qid>, the
     canonical item it duplicates (first shipped) and, for reskins, its
     family. Everything in this section is a READ-ONLY DERIVATION over that
     index and the loaded attempt records — nothing here writes a record, a
     set or an assignment. The index is loaded lazily, by the dashboard only
     (the Practice Sets and Assignments tabs ask for it), never at startup
     and never by a sitting. Absent or failed, the marks are simply off and
     ONE visible notice says so on each tab that uses them — never silent.
     Index strings (refs, family names) are test-data-derived and record
     refs are record-derived: both are untrusted on the render surface and
     go through esc()/escAttr() at every innerHTML site (CLAUDE.md escaping
     contract), and every map keyed by one of them is prototype-free.
     tests/canonical-index.test.js pins the derivation. */
  let dedup = null;              // normalized index, or null
  let dedupState = "idle";       // "idle" | "loading" | "ready" | "failed"
  let dedupNote = "";            // why it is not ready, for the notice
  let dedupTransient = false;    // failed for a reason Refresh can fix (network), not a missing/malformed file
  let dedupRaw = null;           // the window.DEDUP_INDEX object last adopted (or rejected as malformed)
  /* same deadline as app.js's test/bank fetch: a dead connection often never
     fires onerror — it just hangs */
  const DEDUP_FETCH_TIMEOUT_MS = 20000;

  function ensureDedupLoaded(){
    /* Memory first, on EVERY call: the inlined build (dist/), an earlier
       fetch, or a script that landed after the timeout (removing a script
       element does not cancel its load) — a late index is adopted on the
       next render instead of being ignored for the session. */
    const raw = window.DEDUP_INDEX;
    if(raw && raw !== dedupRaw && dedupState !== "loading"){ adoptDedup(raw); return; }
    if(dedupState !== "idle") return;
    dedupState = "loading";
    const s = document.createElement("script");
    let done = false;
    const finish = fn => { if(done) return; done = true; clearTimeout(timer); s.remove(); fn(); };
    const fail = (why, transient) => { dedupState = "failed"; dedupNote = why; dedupTransient = !!transient; onDedupSettled(); };
    const timer = setTimeout(() => finish(() => fail("timed out", true)), DEDUP_FETCH_TIMEOUT_MS);
    s.src = "testdata/dedup-index.js";
    s.async = true;
    s.onload = () => finish(() => {
      if(!window.DEDUP_INDEX){ fail("the file loaded but registered nothing", false); return; }
      adoptDedup(window.DEDUP_INDEX);
      onDedupSettled();
    });
    s.onerror = () => finish(() => fail("testdata/dedup-index.js could not be fetched", true));
    document.head.appendChild(s);
  }
  function adoptDedup(raw){
    dedupRaw = raw;
    const n = normalizeDedupIndex(raw);
    if(n){ dedup = n; dedupState = "ready"; dedupNote = ""; dedupTransient = false; }
    else { dedup = null; dedupState = "failed"; dedupNote = "the index is malformed"; dedupTransient = false; }
  }
  /* Refresh re-arms a transient failure so the next render fetches again. */
  function rearmDedup(){
    if(dedupState === "failed" && dedupTransient){ dedupState = "idle"; dedupNote = ""; dedupTransient = false; }
  }
  function onDedupSettled(){ renderKeepingInputs(); }

  /* Re-render after an async settle (the index, a test's or a bank's content
     landing) WITHOUT losing what the tutor is typing. The builder is
     module-backed (builder.*), but the two assign forms keep their values
     only in the DOM, so snapshot the known fields, render, restore them and
     put the caret back. The Assignments overlap block is then recomputed
     from the restored codes. */
  const KEPT_VALUES = ["afFree", "afName", "afTest", "afCat", "afTiming", "afOpens", "afExpires", "afResetCode",
                       "saSet", "saFree", "saLimit", "saExpires"];
  const KEPT_CHECKS = ["saHold"];
  const KEPT_MULTI = ["afCodes", "saCodes"];
  function renderKeepingInputs(){
    const vals = {}, checks = {}, multi = {};
    KEPT_VALUES.forEach(id => { const el = $(id); if(el) vals[id] = el.value; });
    KEPT_CHECKS.forEach(id => { const el = $(id); if(el) checks[id] = !!el.checked; });
    KEPT_MULTI.forEach(id => { const el = $(id); if(el && el.selectedOptions) multi[id] = Array.from(el.selectedOptions).map(o => o.value); });
    const activeId = (typeof document !== "undefined" && document.activeElement && document.activeElement.id) || null;
    const activeEl = activeId ? $(activeId) : null;
    const caret = (activeEl && typeof activeEl.selectionStart === "number") ? activeEl.selectionStart : null;
    render();
    Object.keys(vals).forEach(id => { const el = $(id); if(el) el.value = vals[id]; });
    Object.keys(checks).forEach(id => { const el = $(id); if(el) el.checked = checks[id]; });
    Object.keys(multi).forEach(id => {
      const el = $(id);
      if(el && el.options) Array.from(el.options).forEach(o => { o.selected = multi[id].indexOf(o.value) !== -1; });
    });
    if(activeId){
      const el = $(activeId);
      if(el && typeof el.focus === "function"){
        try{ el.focus(); if(caret !== null && el.setSelectionRange) el.setSelectionRange(caret, caret); }catch(e){}
      }
    }
    if(tab === "assign") refreshAssignOverlap();
  }

  /* Shape-defensive normalization: the index is a committed file, but the
     dashboard must not throw on a truncated or hand-edited one. Returns null
     when it is unusable. Class and family members keep the index's own
     order (shipped order), canonical first. The reference list keeps the
     build each form/bank was indexed at, so drift can be named. */
  function normalizeDedupIndex(raw){
    if(!raw || typeof raw !== "object" || !raw.items || typeof raw.items !== "object") return null;
    const items = Object.create(null), classes = Object.create(null),
          fams = Object.create(null), byContainer = Object.create(null);
    Object.keys(raw.items).forEach(ref => {
      const it = raw.items[ref];
      if(!it || typeof it !== "object") return;
      const canonical = (typeof it.canonical === "string" && it.canonical) ? it.canonical : ref;
      const family = (typeof it.family === "string" && it.family) ? it.family : null;
      items[ref] = { canonical: canonical, family: family };
      (classes[canonical] = classes[canonical] || []).push(ref);
      if(family) (fams[family] = fams[family] || []).push(ref);
      const c = splitRef(ref).container;
      (byContainer[c] = byContainer[c] || []).push(ref);
    });
    Object.keys(classes).forEach(c => {
      const m = classes[c], i = m.indexOf(c);
      if(i > 0){ m.splice(i, 1); m.unshift(c); }
    });
    const refd = (raw.reference && typeof raw.reference === "object") ? raw.reference : {};
    const listRefs = (arr, idKey, verKey) => (Array.isArray(arr) ? arr : [])
      .filter(x => x && typeof x[idKey] === "string")
      .map(x => ({ id: x[idKey], version: typeof x[verKey] === "string" ? x[verKey] : null }));
    return { items: items, classes: classes, fams: fams, byContainer: byContainer,
             forms: listRefs(refd.forms, "testId", "testVersion"), banks: listRefs(refd.banks, "bankId", "bankVersion") };
  }
  function splitRef(ref){
    const s = String(ref == null ? "" : ref), i = s.indexOf(":");
    return i === -1 ? { container: s, qid: "" } : { container: s.slice(0, i), qid: s.slice(i + 1) };
  }
  /* testsById is a plain object keyed by manifest ids; a record-derived id
     like "constructor" must read as unknown, not as Object.prototype's. */
  function manifestEntry(id){
    return Object.prototype.hasOwnProperty.call(testsById, id) ? testsById[id] : null;
  }
  /* Every index lookup goes through the manifest first: a record or set ref
     written under a testId the test has since dropped (legacyIds) must find
     the index entry keyed by the CURRENT id. Bank ids never rename. */
  function canonRef(ref){
    const p = splitRef(ref);
    const t = manifestEntry(p.container);
    const container = t ? t.testId : p.container;
    return container + (p.qid ? ":" + p.qid : "");
  }
  function indexItem(ref){ return dedup ? (dedup.items[canonRef(ref)] || null) : null; }
  /* The index's refs for one form (by manifest-resolved id), or []. */
  function formRefs(testId){
    const t = manifestEntry(String(testId == null ? "" : testId));
    return (dedup && dedup.byContainer[t ? t.testId : String(testId == null ? "" : testId)]) || [];
  }
  /* "2026 June Asia v2 re2-q15" for a form ref; "bank-david-core q0001" for
     a bank ref (the bankId is the identifier David knows). An unknown
     container prints its raw id. Test names come from the manifest. */
  function refText(ref){
    const p = splitRef(ref);
    const t = manifestEntry(p.container);
    return (t ? t.testName : p.container) + (p.qid ? " " + p.qid : "");
  }
  /* The exact class and family around one ref, or null when the index is
     not ready or the ref is not in it. alsoIn = the other members of its
     exact class (same canonical id); reskins = family members OUTSIDE that
     class (skeleton siblings). */
  function canonInfo(ref){
    const it = indexItem(ref);
    if(!it) return null;
    const key = canonRef(ref);
    const cls = dedup.classes[it.canonical] || [key];
    const fam = it.family ? (dedup.fams[it.family] || []) : [];
    return { canonical: it.canonical, family: it.family,
             alsoIn: cls.filter(x => x !== key),
             reskins: fam.filter(x => cls.indexOf(x) === -1) };
  }
  /* Provenance for a form question row: "also in <form> <qid>" for every
     exact duplicate, "reskin of <form> <qid>" for every family sibling. */
  function provHtml(ref){
    const ci = canonInfo(ref);
    if(!ci) return "";
    const parts = [];
    if(ci.alsoIn.length) parts.push('<span class="canon-prov">also in ' + ci.alsoIn.map(x => esc(refText(x))).join(", ") + "</span>");
    if(ci.reskins.length) parts.push('<span class="canon-prov reskin">reskin of ' + ci.reskins.map(x => esc(refText(x))).join(", ") + "</span>");
    return parts.join(" ");
  }

  /* ---- the seen set: canonical ids (and family ids) across every COMPLETED
     attempt of one student, forms and sets alike, with provenance ---- */
  /* Deleted (tombstoned) attempts are NOT part of the seen set — same rule
     as a sitting removed by archive-then-delete — and a deleted student has
     no seen set at all. Never silent: seenSetFor counts what it left out and
     seenCaveat prints it. */
  function completedAttemptsOf(code){
    if(isDeletedStudent(code)) return [];
    return recs.filter(r => r && r.student && r.student.key === code &&
      (r.status === "completed" || r.status === "timed-out") && !isTombstoned(r));
  }
  function deletedAttemptsOf(code){
    return recs.filter(r => r && r.student && r.student.key === code && isTombstoned(r));
  }
  function recordAnswerKeys(r){
    const a = r.answers;
    return (a && typeof a === "object" && !Array.isArray(a)) ? Object.keys(a) : [];
  }
  /* The refs an attempt exposed — always from the RECORD, so the list is the
     build the student actually sat. A FORM sitting: every question its
     answers map holds (attempts.js writes an entry for every question of
     every opened module, and a completed or timed-out sitting opened every
     module), qualified with its own testId — canonRef() resolves a legacy
     id at lookup time. A SET sitting: its frozen snapshot (setQuestions[]
     .ref), falling back to the answer keys. Record-derived strings are used
     only as lookup keys and escaped wherever they are shown; a ref the
     index does not know is COUNTED as unindexed and reported, never
     silently treated as unseen. */
  function attemptRefs(r){
    if(r.kind === "set"){
      const snap = Array.isArray(r.setQuestions) ? r.setQuestions.map(x => x && x.ref).filter(x => typeof x === "string") : [];
      return snap.length ? snap : recordAnswerKeys(r);
    }
    const id = String(r.testId == null ? "" : r.testId);
    return recordAnswerKeys(r).map(qid => id + ":" + qid);
  }
  function attemptLabel(r){
    const t = r.kind === "set" ? null : manifestEntry(String(r.testId == null ? "" : r.testId));
    const when = r.submittedAt || r.lastSavedAt || r.startedAt || null;
    return { attemptId: String(r.attemptId || ""),
             name: String((t ? t.testName : (r.kind === "set" ? (r.setName || r.testName) : (r.testName || r.testId))) || "?"),
             when: when, whenText: fmtDay(when),      // formatted once per attempt, not per mark
             status: String(r.status || "") };
  }
  function seenSetFor(code){
    if(!dedup || !code) return null;
    const seen = { canon: Object.create(null), fam: Object.create(null), attempts: 0, unindexed: 0, unindexedAttempts: 0,
                   deleted: deletedAttemptsOf(code).length, deletedStudent: isDeletedStudent(code) };
    completedAttemptsOf(code).forEach(r => {
      seen.attempts++;
      const att = attemptLabel(r);
      let miss = 0;
      attemptRefs(r).forEach(ref => {
        const it = indexItem(ref);
        if(!it){ miss++; return; }
        const via = { att: att, ref: ref };
        (seen.canon[it.canonical] = seen.canon[it.canonical] || []).push(via);
        if(it.family) (seen.fam[it.family] = seen.fam[it.family] || []).push(via);
      });
      seen.unindexed += miss;
      if(miss) seen.unindexedAttempts++;
    });
    return seen;
  }
  /* The caveat every surface prints when part of a student's history could
     not be compared (a form the index predates, a renamed id the manifest
     no longer maps, a crafted ref). Not covered here, said once in the
     hints instead: the seen set is derived from the attempts IN STORAGE —
     a sitting removed by archive-then-delete (§7b) no longer counts. */
  function seenCaveat(seen){
    if(!seen) return "";
    const parts = [];
    if(seen.deletedStudent){
      parts.push("This student was deleted — nothing of theirs counts as seen.");
    } else if(seen.deleted){
      parts.push(seen.deleted + " deleted attempt" + (seen.deleted === 1 ? "" : "s") + " not counted.");
    }
    if(seen.unindexed){
      const which = seen.attempts === 1 ? "their completed attempt"
        : seen.unindexedAttempts + " of their " + seen.attempts + " completed attempts";
      parts.push(seen.unindexed + " question" + (seen.unindexed === 1 ? "" : "s") + " from " + which + " " +
        (seen.unindexed === 1 ? "is" : "are") + " not in the index and could not be compared.");
    }
    return parts.join(" ");
  }
  /* seen: this canonical item was in a completed attempt (the same question,
     or an exact duplicate on another form or in a set). reskin: none of its
     exact class was, but a family sibling (skeleton reskin) was. unseen:
     neither. unindexed: the ref is not in the index (an index older than
     the library) — reported as such, never silently counted as unseen. */
  function markFor(ref, seen){
    if(!dedup || !seen) return null;
    const it = indexItem(ref);
    if(!it) return { mark: "unindexed", via: [] };
    if(seen.canon[it.canonical]) return { mark: "seen", via: seen.canon[it.canonical] };
    if(it.family && seen.fam[it.family]) return { mark: "reskin", via: seen.fam[it.family] };
    return { mark: "unseen", via: [] };
  }
  function seenCounts(refs, seen){
    const c = { seen: 0, reskin: 0, unseen: 0, unindexed: 0, total: refs.length };
    refs.forEach(ref => { const m = markFor(ref, seen); if(m) c[m.mark]++; });
    return c;
  }
  function countsText(c){
    return c.seen + " seen · " + c.reskin + " reskin · " + c.unseen + " unseen" +
      (c.unindexed ? " · " + c.unindexed + " not indexed" : "");
  }
  /* One table: the badge copy and the .dstatus palette class each mark
     borrows (red = seen, amber = reskin, green = unseen). */
  const MARKS = { seen: { label: "seen", cls: "to" }, reskin: { label: "reskin seen", cls: "warn" },
                  unseen: { label: "unseen", cls: "ok" }, unindexed: { label: "not indexed", cls: "" } };
  function viaText(v, mark){
    return (mark === "reskin" ? "reskin in " : "in ") + v.att.name + " (" + splitRef(v.ref).qid + ", " + v.att.status + " " + v.att.whenText + ")";
  }
  function markHtml(m){
    if(!m) return "";
    const k = MARKS[m.mark] || MARKS.unindexed;
    const vias = m.via.map(v => viaText(v, m.mark));
    const title = vias.length ? vias.join("; ")
      : (m.mark === "unindexed" ? "Not in the canonical-id index — regenerate it after the next export" : "");
    const first = vias.length ? ' <span class="canon-via">' + esc(vias[0]) + (vias.length > 1 ? " +" + (vias.length - 1) : "") + "</span>" : "";
    return ` <span class="dstatus ${k.cls} canon-mark ${m.mark}" title="${escAttr(title)}">${k.label}</span>${first}`;
  }
  /* Marks are for the student chosen in the dashboard's Student filter. */
  function selectedStudent(){ const el = $("dashFilterStudent"); return el ? el.value : ""; }
  function setRefKeys(s){
    return (Array.isArray(s.refs) ? s.refs : []).filter(r => r && typeof r === "object").map(refKey);
  }
  /* The one visible notice per tab when marks are off. Ready: nothing —
     unless the index predates a test or bank the manifests list, or was
     built against a different build of one (its marks may be stale). */
  function dedupNoticeHtml(){
    const REGEN = " Regenerate it in the test-bank repo (dedup_gate.py --library --emit-platform) and redeploy.";
    if(dedupState === "ready"){
      const missing = [], drift = [];
      (window.TEST_MANIFEST || []).forEach(t => {
        if(!t) return;
        const f = dedup.forms.find(x => x.id === t.testId);
        if(!f) missing.push(t.testName);
        else if(f.version && t.testVersion && f.version !== t.testVersion)
          drift.push(t.testName + " (index " + f.version + ", library " + t.testVersion + ")");
      });
      (window.BANK_MANIFEST || []).forEach(b => {
        if(!b) return;
        const f = dedup.banks.find(x => x.id === b.bankId);
        if(!f) missing.push(b.bankId);
        else if(f.version && b.bankVersion && f.version !== b.bankVersion)
          drift.push(b.bankId + " (index " + f.version + ", library " + b.bankVersion + ")");
      });
      if(!missing.length && !drift.length) return "";
      return '<p class="canon-notice rv-notice warn">' +
        (missing.length ? "The canonical-id index predates " + esc(missing.join(", ")) + " — those questions show as “not indexed”." : "") +
        (missing.length && drift.length ? " " : "") +
        (drift.length ? "The index was built against a different build of " + esc(drift.join(", ")) + " — its marks and provenance may be stale." : "") +
        esc(REGEN) + "</p>";
    }
    if(dedupState === "failed")
      return '<p class="canon-notice rv-notice warn"><b>Canonical-id index unavailable</b> (' + esc(dedupNote) +
        ') — duplicate provenance and seen/unseen marks are off.' +
        (dedupTransient ? " Click Refresh to try again." : esc(REGEN)) + "</p>";
    return '<p class="canon-notice loading">Loading the canonical-id index…</p>';
  }

  /* ---- full-test assignment warning: how much of a form the student has
     already seen, by canonical id and family, and from which attempts ---- */
  function overlapFor(code, testId){
    const seen = seenSetFor(code);
    if(!seen) return null;
    const refs = formRefs(testId);
    const o = { total: refs.length, attempts: seen.attempts, seenItems: [], reskinItems: [], unindexed: 0,
                sources: [], caveat: seenCaveat(seen) };
    const byAtt = Object.create(null);
    refs.forEach(ref => {
      const m = markFor(ref, seen);
      if(m.mark === "unindexed"){ o.unindexed++; return; }
      if(m.mark !== "seen" && m.mark !== "reskin") return;
      (m.mark === "seen" ? o.seenItems : o.reskinItems).push({ ref: ref, via: m.via });
      m.via.forEach(v => {
        const a = byAtt[v.att.attemptId] = byAtt[v.att.attemptId] || { att: v.att, seen: 0, reskin: 0, refs: Object.create(null) };
        if(a.refs[ref]) return;              // count each form item once per source attempt
        a.refs[ref] = true;
        a[m.mark]++;
      });
    });
    o.sources = Object.keys(byAtt).map(k => byAtt[k])
      .sort((a, b) => String(a.att.when || "").localeCompare(String(b.att.when || "")));
    return o;
  }
  function assignOverlapHtml(codes, testId){
    ensureDedupLoaded();
    if(dedupState !== "ready") return dedupNoticeHtml();
    const t = manifestEntry(String(testId == null ? "" : testId));
    const tname = t ? t.testName : String(testId || "");
    const stale = dedupNoticeHtml();
    if(!codes.length || !testId)
      return stale + '<p class="dash-hint">Pick student codes to see how much of ' + esc(tname) +
        ' each has already seen (by canonical id) in their completed attempts.</p>';
    return stale + codes.map(code => {
      const o = overlapFor(code, testId);
      if(!o) return "";
      const caveat = o.caveat ? ' <span class="dash-hint">' + esc(o.caveat) + "</span>" : "";
      if(!o.total)
        return `<div class="canon-overlap none">${studentCell(code)} — ${esc(tname)} is not in the canonical-id index, so nothing can be compared.${caveat}</div>`;
      if(!o.attempts)
        return `<div class="canon-overlap none">${studentCell(code)} — no completed attempts in storage (sittings archived and deleted no longer count), so nothing of ${esc(tname)} has been seen.</div>`;
      const n = o.seenItems.length + o.reskinItems.length;
      if(!n)
        return `<div class="canon-overlap none">${studentCell(code)} — none of ${esc(tname)}’s ${o.total} items appear in their ${o.attempts} completed attempt${o.attempts === 1 ? "" : "s"}.${
          o.unindexed ? " (" + o.unindexed + " of the form’s questions are not in the index.)" : ""}${caveat}</div>`;
      const src = o.sources.map(a =>
        `<li>${esc(a.att.name)} · ${esc(a.att.status)} ${esc(a.att.whenText)} — ${a.seen} identical, ${a.reskin} reskin</li>`).join("");
      const items = o.seenItems.map(x => `<li>${esc(splitRef(x.ref).qid)} = ${esc(refText(x.via[0].ref))}</li>`).join("") +
                    o.reskinItems.map(x => `<li>${esc(splitRef(x.ref).qid)} ~ reskin of ${esc(refText(x.via[0].ref))}</li>`).join("");
      return `<div class="canon-overlap rv-notice warn">
        <b>${studentCell(code)} has already seen ${n} of ${esc(tname)}’s ${o.total} items</b> —
        ${o.seenItems.length} identical (same canonical id) and ${o.reskinItems.length} reskin item${o.reskinItems.length === 1 ? "" : "s"} (family siblings), from:
        <ul>${src}</ul>
        <details><summary>Which items</summary><ul class="canon-items">${items}</ul></details>
        <span class="dash-hint">For information only — nothing is excluded automatically; assign as usual.</span>${
          o.unindexed ? ' <span class="dash-hint">' + o.unindexed + " of the form’s questions are not in the index.</span>" : ""}${caveat}
      </div>`;
    }).join("");
  }
  /* Status-line notes for createAssignment: one per assigned code that has
     already seen part of the form. Empty when the index is not ready. */
  function overlapNotes(codes, testId){
    if(dedupState !== "ready") return [];
    const out = [];
    codes.forEach(code => {
      const o = overlapFor(code, testId);
      const n = o ? o.seenItems.length + o.reskinItems.length : 0;
      if(n) out.push(code + " had already seen " + n + " of its " + o.total + " items (" +
        o.seenItems.length + " identical, " + o.reskinItems.length + " reskin).");
    });
    return out;
  }
  /* Re-render ONLY the overlap block from the form's current codes + test —
     the same parse as Create assignment (formCodes), minus codes it would
     reject. The form itself is never rebuilt here, so nothing typed is
     lost, and a keystroke that completes no new code does no work. */
  let overlapSig = null;         // viewAssign() clears it: a fresh block always computes
  function refreshAssignOverlap(){
    const box = $("afOverlap"), t = $("afTest");
    if(!box || !t || !$("afCodes") || !$("afFree")) return;
    ensureDedupLoaded();                   // adopt an inlined/late index BEFORE the signature reads dedupState
    const parsed = formCodes();
    const codes = parsed.codes.filter(c => parsed.bad.indexOf(c) === -1);
    const sig = codes.join(",") + "|" + t.value + "|" + dedupState;
    if(sig === overlapSig) return;
    overlapSig = sig;
    box.innerHTML = assignOverlapHtml(codes, t.value);
  }

  /* ---- the builder's ONE rule for what it already holds ----
     Exact key first (after legacy-id resolution). Then, for a FORM
     candidate only, any FORM ref in the same exact class (same canonical
     id): the set holds one entry per canonical item. Bank refs neither
     hold nor are held by a class — "bank rows are unaffected by the
     grouping" — so the outcome never depends on the order the tutor
     clicked. Returns the key the set holds, or null. Used by the view (its
     button label), by builderAddRef and by Add whole module. */
  function builderHeldAs(ref){
    if(!builder || !ref) return null;
    const k = canonRef(refKey(ref));
    const exact = builder.refs.find(r => r && canonRef(refKey(r)) === k);
    if(exact) return k;
    if(ref.type !== "form" || !dedup) return null;
    const it = dedup.items[k];
    if(!it) return null;
    const hit = builder.refs.find(r => {
      if(!r || r.type !== "form") return false;
      const o = dedup.items[canonRef(refKey(r))];
      return !!(o && o.canonical === it.canonical);
    });
    return hit ? canonRef(refKey(hit)) : null;
  }
  function pushRef(ref){
    if(!builder || builderHeldAs(ref)) return false;
    builder.refs.push(ref);
    return true;
  }
  /* Form refs the builder holds twice by canonical id — refs added while the
     index was still loading or failed, or a set saved before grouping
     existed. Shown as a notice so the tutor can remove the extras; nothing
     is removed for them. */
  function builderDuplicateGroups(){
    if(!dedup || !builder) return [];
    const byCanon = Object.create(null);
    builder.refs.forEach(r => {
      if(!r || r.type !== "form") return;
      const k = canonRef(refKey(r));
      const it = dedup.items[k];
      if(!it) return;
      (byCanon[it.canonical] = byCanon[it.canonical] || []).push(k);
    });
    return Object.keys(byCanon).map(c => byCanon[c]).filter(g => g.length > 1);
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
  /* Dates come off records and markers, which are untrusted (ATTEMPTS-SPEC
     §7): a value that is not a date prints an em-dash, never "Invalid Date"
     — inert either way, but a dash reads as "unknown" while the other reads
     like a broken screen. */
  function fmtDate(isoStr){
    if(!isoStr) return "—";
    const d = new Date(isoStr);
    if(isNaN(d.getTime())) return "—";
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
    return `<span class="dstatus ${cls}">${esc(r.status || "?")}</span>` +
      (isTombstoned(r) ? ' <span class="dstatus del" title="Marked deleted by the tutor — kept for audit, shown to no student">deleted</span>' : "");
  }
  /* ---- tombstones (2026-09-18) ---- */
  function tombFor(attemptId){ return (typeof attemptId === "string" && tombs["tomb:" + attemptId]) || null; }
  function isDeletedStudent(code){
    const c = String(code || "").toUpperCase();
    return !!(c && tombs["tomb:student:" + c]);
  }
  /* A record is deleted if it has its own marker OR belongs to a deleted
     student: the second case covers a row that reached the server AFTER the
     student was retired (a never-synced sitting uploaded by the tutor, a row
     pulled from another mirror) — the server refuses the student's own
     writes, but the tutor's REST path does not go through the RPCs. Such a
     row must never read as live here. */
  function isTombstoned(r){
    return !!(r && (tombFor(r.attemptId) || isDeletedStudent(r.student && r.student.key)));
  }
  /* Markers whose record is no longer listed (rotated away by
     archive-then-delete, or never on this mirror): still "removed", never
     "never existed". Shaped like Attempts.tombstoneStub so assignment status
     can read them exactly as the student home does. */
  function orphanStubs(code){
    const listed = {};
    recs.forEach(r => { if(r && r.attemptId) listed[r.attemptId] = true; });
    const out = [];
    Object.keys(tombs).forEach(k => {
      const t = tombs[k];
      if(!t || t.targetKind !== "attempt" || listed[t.target]) return;
      if(code && String(t.code || "").toUpperCase() !== code) return;
      out.push({ attemptId: t.target, tombstoned: true, orphan: true,
        deletedAt: typeof t.deletedAt === "string" ? t.deletedAt : null,
        student: { key: t.code, code: t.code },
        testId: typeof t.testId === "string" ? t.testId : null,
        assignmentId: typeof t.assignmentId === "string" ? t.assignmentId : null,
        status: typeof t.status === "string" ? t.status : "unknown",
        kind: t.attemptKind === "set" ? "set" : undefined,
        conditions: typeof t.conditions === "string" ? t.conditions : "unknown",
        startedAt: typeof t.startedAt === "string" ? t.startedAt : "" });
    });
    return out;
  }
  /* The confirmation gate: the tutor must type the student's code back,
     exactly (case and spaces forgiven, nothing else). One rule for both
     panels, re-checked at the click, so the button state can never be the
     only thing standing between a slip and a deletion. */
  function deleteGateOk(typed, code){
    const want = StudentCode.normalize(code);
    return StudentCode.valid(want) && StudentCode.normalize(typed) === want;
  }
  function tombstoneNoteHtml(r){
    const t = tombFor(r && r.attemptId);
    const code = r && r.student && r.student.key;
    if(!t && !isDeletedStudent(code)) return "";
    const st = t ? null : tombs["tomb:student:" + String(code || "").toUpperCase()];
    const src = t || st || {};
    const when = fmtDate(src.deletedAt);
    return `<p class="dash-warn">🗑 <b>Deleted</b> by ${esc(src.deletedBy || "?")} on ${esc(when)}` +
      (t ? (t.reason === "student" ? " (the student was deleted)" : "")
         : " (the student was deleted; this record arrived without its own marker)") +
      `. The record is kept as it was for audit and is shown to no student; it cannot be un-deleted here.</p>`;
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
    const del = isDeletedStudent(c) ? ' <span class="dstatus del" title="This student was deleted — the code is retired">deleted</span>' : "";
    return (n ? `<b>${esc(n)}</b> <span class="dcode">${esc(c)}</span>` : esc(c)) + del;
  }
  /* Plain-text name+code for a <select><option> — option text can't carry
     studentCell()'s <b>/<span> markup, so this is the same join flattened to
     one string. Falls back to the bare code when there's no profile row. */
  function codeOptionLabel(code){
    const c = String(code || "?");
    const n = nameFor(c);
    return (n ? n + " (" + c + ")" : c) + (isDeletedStudent(c) ? " — deleted" : "");
  }
  /* Finished (completed / timed-out) and loaded from storage. This is the
     ARCHIVE-THEN-DELETE gate (exportAll / deleteArchived, ATTEMPTS-SPEC §7b)
     — unchanged semantics: a live sitting is never armed or removed. */
  function isFinishedAttempt(r){
    return source === "storage" && !!r && (r.status === "completed" || r.status === "timed-out");
  }
  /* The TOMBSTONE gate (the per-attempt "Delete this attempt…" button):
     finished, not already tombstoned, and not a deleted student's (all of a
     deleted student's attempts are already marked). Finished-only is what
     keeps a resumable record from being marked out from under a student who
     could still resume into it; the server enforces the same rule
     (fn_tombstone_attempt refuses an in-progress record). One rule, shared
     by the button's own gate (openDetail) and deleteAttempt's belt-and-braces
     recheck, so the two can never drift apart. */
  function isDeletableAttempt(r){
    return isFinishedAttempt(r) && !isTombstoned(r) && !isDeletedStudent(r.student && r.student.key) &&
      StudentCode.valid(r.student && r.student.key);   // the gate needs a real code to type back
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
    rearmDedup();                          // a Refresh retries a canonical-id index fetch that failed on the network
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
    let failed = 0, mismatched = 0;
    for(const k of keys){
      const r = await AttemptStore.get(k);
      // the storage KEY is authoritative; a record whose attemptId field
      // disagrees with it is forged (every record VALUE is writable in shared
      // storage, ATTEMPTS-SPEC §7). Drop it so a smuggled record can't pollute
      // the tutor's tables/analytics either — matches loadForStudent.
      if(r && r.attemptId === k){ loaded.push(r); continue; }
      failed++;
      // NEVER SILENT: distinguish an attemptId/key mismatch (readable but
      // forged/corrupt) from a genuinely unreadable row, and log the key so
      // the exclusion is always traceable.
      if(r && r.attemptId !== k){
        mismatched++;
        try{ console.warn("[Dashboard] EXCLUDED a record whose attemptId (" + r.attemptId +
          ") does not match its storage key (" + k + ") — forged/corrupt."); }catch(e){}
      }
    }
    recs = loaded;
    await loadAssignsAndBugs();
    $("dashStatus").textContent = recs.length +
      (local ? " attempt(s) saved on this device (local mode — not synced)."
             : " attempt(s) in shared storage.") +
      (failed ? " (" + failed + " excluded" +
        (mismatched ? ", " + mismatched + " for an attemptId/key mismatch" : "") + " — see console.)" : "") +
      (lastExport ? "" : " Download an archive before deleting anything.");
    renderAll();
  }

  /* pset rows: the tutor's editable set objects. Remote mode already mirrors
     every server row locally via pullAllForTutor before this runs. */
  async function loadSets(){
    sets = [];
    const keys = await AttemptStore.list("pset:");
    if(!keys) return;
    for(const k of keys){
      const v = await AttemptStore.get(k);
      if(v && v.setId && typeof v.name === "string") sets.push(v);
    }
    sets.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async function loadAssignsAndBugs(){
    assigns = []; bugs = []; profiles = {}; tombs = {};
    await loadSets();
    /* tombstones: the KEY is authoritative — a marker whose target disagrees
       with the key it sits under is forged/corrupt and is ignored (same rule
       as attemptId-vs-key for records). Loaded before anything renders, so a
       deleted record is never shown unmarked even for a moment. */
    const tKeys = await AttemptStore.list("tomb:");
    if(tKeys){
      for(const k of tKeys){
        const v = await AttemptStore.get(k);
        if(!v || v.kind !== "tombstone" || typeof v.target !== "string") continue;
        const okKey = (v.targetKind === "attempt" && k === "tomb:" + v.target) ||
                      (v.targetKind === "student" && k === "tomb:student:" + v.target);
        if(okKey) tombs[k] = v;
      }
    }
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

  /* An archive file's contents into the dashboard's state: records, and the
     tombstones the archive carries (exportAll), so a deleted record reads
     "deleted" in the file view too, never as a live one. Named so the tests
     can drive it without a FileReader. */
  function adoptArchive(data){
    const arr = Array.isArray(data) ? data : ((data && data.records) || []);
    recs = arr.filter(r => r && r.attemptId);
    tombs = {};
    ((data && Array.isArray(data.tombstones)) ? data.tombstones : []).forEach(t => {
      if(t && typeof t.key === "string" && t.value && t.value.kind === "tombstone" && typeof t.value.target === "string") tombs[t.key] = t.value;
    });
    source = "file";
  }
  function loadFromFile(file){
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const data = JSON.parse(reader.result);
        adoptArchive(data);
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
    /* `records` holds every record exactly as stored — tombstoned ones
       included and UNCHANGED (the record is immutable; deletion is a
       separate row). `tombstones` carries those rows, so the archive can say
       which records were deleted, by whom and when, and the SPR audit
       (tests/spr-grading.test.js §5) can skip them and say how many. */
    const payload = {
      schema: "acestem-attempt-archive-v1",
      exportedAt: new Date().toISOString(),
      records: recs,
      tombstones: Object.keys(tombs).sort().map(k => ({ key: k, value: tombs[k] }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "attempts-archive-" + new Date().toISOString().slice(0,10) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    if(source === "storage"){
      /* Arm the delete for FINISHED attempts only. The archive file holds
         every record, including in-progress sittings, but a live sitting's
         checkpoint is not something an archive can stand in for — deleting
         it would leave a partial snapshot as the only copy (and a sitting
         that finishes between this download and the click would be lost
         outright, since finalize's upload has already drained). Those rows
         stay; the status says how many. */
      const deletable = recs.filter(isFinishedAttempt).map(r => r.attemptId);
      const live = recs.length - deletable.length;
      lastExport = deletable.length ? { ids: deletable, when: new Date() } : null;
      $("dashDeleteBtn").disabled = !lastExport;
      $("dashStatus").textContent = "Archive downloaded (" + recs.length + " attempts). " +
        (deletable.length
          ? "Verify the file opened correctly, then “Delete archived attempts” removes exactly the " + deletable.length + " finished attempt(s) from storage."
          : "Nothing to delete — ") +
        (live ? (deletable.length ? " " : "") + live + " in-progress sitting(s) are in the file but stay in storage." : "");
    }
  }

  async function deleteArchived(){
    if(!lastExport || source !== "storage") return;
    /* An armed id that is not currently LISTED is left alone and stays
       armed. Deleting it here un-arms it (deleteAttempt), and a delete from
       another browser never prunes this mirror, so the ways to get here are a
       failed load (recs empty) or an excluded forged row — in both the row
       is still in storage, so it is neither deleted nor claimed gone. */
    const notListed = lastExport.ids.filter(id => !recs.some(x => x.attemptId === id));
    const ids = lastExport.ids.filter(id => recs.some(x => x.attemptId === id));
    if(!ids.length){
      $("dashStatus").textContent = "Nothing to delete right now — none of the " + notListed.length +
        " archived record(s) are listed. Press Refresh and try again; they are still armed.";
      return;
    }
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
    /* Server first, per row (tutorDelete): in remote mode this used to remove
       only the mirror, so the server kept every archived record and the very
       next load pulled them all straight back. */
    let ok = 0, skipped = 0;
    const stillThere = [], skippedIds = [], rejections = [], warnings = [];
    for(const id of ids){
      /* belt and braces under the exportAll guard: never delete a row that
         is not a finished attempt as of THIS load — a sitting that was
         in-progress when the archive was downloaded, or that has changed
         since, stays; the archive is not a backup of a live sitting */
      const cur = recs.find(x => x.attemptId === id);
      if(!isFinishedAttempt(cur)){ skipped++; skippedIds.push(id); continue; }
      const res = await tutorDelete(id);
      if(res.ok){ ok++; if(res.warning) warnings.push(res.warning); }
      else { stillThere.push(id); rejections.push(res.message); }
    }
    /* stay armed for exactly the rows that are still there — rejected,
       not listed, or no longer finished — so a retry after signing in again
       (or a Refresh) deletes those and nothing else */
    const remaining = stillThere.concat(notListed, skippedIds);
    lastExport = remaining.length ? { ids: remaining, when: lastExport.when } : null;
    $("dashDeleteBtn").disabled = !lastExport;
    const summary = "Deleted " + ok + " of " + ids.length + " archived record(s)." +
      (notListed.length ? " " + notListed.length + " not listed right now — left in storage (press Refresh)." : "") +
      (skipped ? " " + skipped + " skipped — not a finished attempt any more (left in storage)." : "") +
      (stillThere.length ? " " + stillThere.length + " NOT deleted — still in storage. " +
        rejections.slice(0, 3).join(" ") + (rejections.length > 3 ? " (+" + (rejections.length - 3) + " more.)" : "") : "") +
      (warnings.length ? " " + warnings.join(" ") : "");
    await loadFromStorage();
    $("dashStatus").textContent = summary + " " + $("dashStatus").textContent;
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
      students.map(s => `<option value="${escAttr(s)}">${esc(codeOptionLabel(s))}</option>`).join("");
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
    else if(tab === "bank") body.innerHTML = viewBank();
    else if(tab === "sets") body.innerHTML = viewSets();
    else if(tab === "bugs") body.innerHTML = viewBugs();
    else body.innerHTML = viewInsights(rows);
    attachBodyHandlers();
  }

  /* Phase D score-visibility (b): per-attempt release toggle. Students see
     scores in their Past view only after this flips released:true. */
  function releaseCell(r){
    if(r.status === "in-progress") return "—";
    if(isTombstoned(r)) return "—";              // a deleted record has no student to release to
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
    if(isTombstoned(r)){
      $("dashStatus").textContent = "This attempt was deleted — a deleted record is never released, and it is not edited.";
      return;
    }
    r.released = !r.released;
    /* tutorPut, never set(): set() would enqueue this through the STUDENT RPC,
       and fn_upsert_attempt deliberately ignores `released` so students can't
       self-release. The tutor's authenticated table write is the only path
       that can actually flip it. */
    const res = await tutorPut(r.attemptId, (r.student && r.student.key) || null, r);
    if(!res.ok){
      r.released = !r.released;                 // nothing persisted; the mirror is untouched
      $("dashStatus").textContent = res.message;
    } else if(AttemptStore.isRemote()){
      $("dashStatus").textContent = (r.released
        ? "Released — the student sees Score Details at their next sign-in or refresh."
        : "Un-released — Score Details hidden from the student again.") +
        (res.warning ? " " + res.warning : "");
    } else if(res.warning){
      $("dashStatus").textContent = res.warning;
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
        <tr data-att="${escAttr(r.attemptId)}"${isTombstoned(r) ? ' class="tomb"' : ""}>
          <td>${studentCell(r.student && r.student.code)}</td>
          <td>${esc(r.testName || r.testId)}${r.kind === "set" ? ' <span class="dstatus tm">set</span>' : ""}</td>
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
    /* deleted students stay listed too — present-but-marked, like their
       records — so the roster never silently loses a code */
    if(source === "storage"){
      Object.keys(tombs).forEach(k => { if(k.indexOf("tomb:student:") === 0) addCode(k.slice("tomb:student:".length)); });
    }
    const keys = Object.keys(byStudent).sort();
    if(!keys.length) return '<p class="dash-empty">No students yet — add codes in the Assign tab.</p>';
    return keys.map(k => {
      const list = byStudent[k].slice().sort((a,b) => (a.startedAt||"").localeCompare(b.startedAt||""));
      const deleted = isDeletedStudent(k);
      const delCount = list.filter(isTombstoned).length;
      const orphans = source === "storage" ? orphanStubs(k).length : 0;   // markers whose record was archived away
      /* No sign-in link for keys that aren't real codes ("?" grouping, or a
         hand-written storage key) — parseFragmentCode would reject the link
         anyway. valid() normalizes before testing, so the link carries the
         canonical form rather than whatever casing the key happened to use.
         A deleted student gets no link (the code is retired and would be
         refused) and no delete button (already done). */
      const linkBtn = (StudentCode.valid(k) && !deleted)
        ? `<button class="dash-rel copy-link" data-code="${escAttr(StudentCode.normalize(k))}"
            title="Copy a link that signs this student in">Copy sign-in link</button>` : "";
      /* ONE student per button, per panel, per confirmation — there is no
         multi-select and no "delete all" anywhere in this dashboard */
      const delBtn = (source === "storage" && StudentCode.valid(k) && !deleted)
        ? `<button class="dash-rel dash-danger student-del" data-code="${escAttr(StudentCode.normalize(k))}"
            title="Retire this code and mark every attempt deleted (asks you to type the code back)">Delete student…</button>` : "";
      let body;
      if(list.length){
        body = `<table class="dtable slim"><thead><tr><th>Date</th><th>Test</th><th>Score</th><th>RW</th><th>Math</th><th>Status</th><th>Conditions</th></tr></thead><tbody>` +
        list.map(r => {
          const bs = (r.score && r.score.bySection) || {};
          const rw = bs["Reading and Writing"], ma = bs["Math"];
          return `<tr data-att="${escAttr(r.attemptId)}"${isTombstoned(r) ? ' class="tomb"' : ""}>
            <td>${fmtDate(r.startedAt)}</td><td>${esc(r.testName || r.testId)}${r.kind === "set" ? ' <span class="dstatus tm">set</span>' : ""}</td>
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
          deleted ? "Deleted student — no attempts on record."
          : hasAny ? "No attempts match the current filter."
          : assigned ? "No attempts yet — " + assigned + " test(s) assigned."
          : "No attempts yet — nothing assigned, so their home screen is empty."}</p>`;
      }
      const sub = list.length + " attempt(s)" + (delCount ? ", " + delCount + " deleted" : "") +
        (orphans ? ", " + orphans + " deleted marker(s) whose record was archived away" : "");
      return `<div class="dcard${deleted ? " deleted" : ""}">
        <h3>${studentCell(k)} <span class="dcard-sub">${sub}</span>
          ${linkBtn}${delBtn}</h3>` + body + `</div>`;
    }).join("");
  }

  function viewItems(rows){
    rows = rows.filter(r => !isTombstoned(r));    // deleted records are data no analysis should read
    const ft = $("dashFilterTest").value;
    const testIds = [...new Set(rows.map(r => r.testId))];
    if(testIds.length > 1 && !ft) return '<p class="dash-empty">Item analysis is per test — pick one in the Test filter.</p>';
    const testId = ft || testIds[0];
    if(!testId) return '<p class="dash-empty">No attempts match.</p>';
    const idx = qIndex(testId);
    const use = rows.filter(r => r.testId === testId);
    const stats = {};   // qid -> {answered, correct, wrongGiven:[], times:[]}
    /* set records under this "testId" (their setId): resolve question text
       through each record's snapshot so the rows aren't blank — explicit set
       handling, mirroring openDetail */
    const provInfo = {};
    use.forEach(r => {
      if(r.kind === "set"){
        Object.keys(r.answers || {}).forEach(qid => {
          if(!provInfo[qid]) provInfo[qid] = setProvLookup(r, qid);
        });
      }
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
        const info = (idx && idx[qid]) || provInfo[qid] || null;
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
    const use = rows.filter(r => r.answers && Object.keys(r.answers).length && !isTombstoned(r));
    if(!use.length) return '<p class="dash-empty">No attempts match.</p>';

    const quad = { fw:[], nw:[], fr:0, nr:0 };            // flagged/not × wrong/right
    const changes = { rw:0, wr:0, ww:0 };
    const fastWrong = [];
    const pacing = [];

    use.forEach(r => {
      /* set records resolve through their snapshot; forms through qIndex.
         qFor() is the one lookup both the change-analysis and the blind-spot
         label use, so set attempts join every insight instead of silently
         dropping out of the re-grade. */
      const idx = r.kind === "set" ? null : qIndex(r.testId);
      const qFor = qid => (idx && idx[qid]) || (r.kind === "set" ? setProvLookup(r, qid) : null);
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
           a.given !== null && a.given !== undefined && a.firstGiven !== a.given && qFor(qid)){
          /* Both sides must come from the SAME rule. This recomputed
             firstGiven while reading the final verdict off the record, so for
             any attempt recorded before the SPR rule changed (2026-08-02) the
             halves disagreed: a second-guess could be counted as
             wrong->right when the record says it never was, and the
             right->wrong counter — the one this panel exists to surface —
             read zero in exactly the case it should have caught. */
          const firstCorrect = answerMatches(qFor(qid).q, a.firstGiven);
          const finalCorrect = answerMatches(qFor(qid).q, a.given);
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

    const blindQ = x => {
      const info = x.r.kind === "set" ? setProvLookup(x.r, x.qid) : (qIndex(x.r.testId) || {})[x.qid];
      return info && info.q;
    };
    const blind = quad.nw.map(x =>
      `<tr><td>${esc(x.code)}</td><td>${esc(x.qid)}</td><td>${esc(x.r.testName || x.r.testId)}</td><td>${esc(givenLabel(x.a, blindQ(x)))}</td><td>${mmss(x.a.timeSpentSeconds)}</td></tr>`).join("");

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
    /* listed records plus orphan deletion markers (record rotated away):
       a deleted attempt still closes the assignment it was stamped with */
    const pool = recs.concat(orphanStubs(code));
    const explicit = pool.filter(r => r.student && r.student.key === code &&
      r.assignmentId && r.assignmentId === a.assignmentId);
    if(explicit.length) return explicit;
    if(assignCountFor(code, a.testId) === 1){
      /* an UNTAGGED deleted record keeps closed only an assignment that
         already existed when it was deleted — never one created after the
         deletion (that is a re-sit the tutor asked for). Same rule as the
         student home's buildAssignmentIndex, so the two views agree. */
      return pool.filter(r => r.student && r.student.key === code &&
        !r.assignmentId && sameTest(r.testId, a.testId) &&
        attemptCategoryMatches(a.category, r.conditions) && deletedMayClose(a, r));
    }
    return [];
  }
  /* When was this record deleted? Its own marker's deletedAt, else the
     student marker's (a deleted student's record without its own marker),
     else null. Untrusted like every record value: a non-string is null. */
  function deletedAtOf(r){
    if(!isTombstoned(r)) return null;
    const own = tombFor(r.attemptId);
    const src = own || (typeof r.deletedAt === "string" ? r : null) ||
      tombs["tomb:student:" + String((r.student && r.student.key) || "").toUpperCase()];
    return (src && typeof src.deletedAt === "string") ? src.deletedAt : null;
  }
  function deletedMayClose(a, r){
    if(!isTombstoned(r)) return true;
    const when = deletedAtOf(r);
    return typeof when === "string" && typeof a.assignedAt === "string" &&
      Date.parse(a.assignedAt) < Date.parse(when);
  }
  function assignRowStatus(code, a){
    const mine = attemptsForAssignment(code, a);
    // completion is DERIVED from the attempt records (the flag is a hint that
    // was silently never written before 2026-08-02); either signal counts.
    // A DELETED completed attempt still completes its assignment — exactly
    // what the student home derives from the tombstone stub — so the two
    // views agree and a deletion never reopens an assignment (25ef8f7).
    if(a.completedAttemptId ||
       mine.some(r => r.status === "completed" || r.status === "timed-out")) return "completed";
    // a deleted in-progress sitting (a deleted student's) is not resumable
    // anywhere, so it is not "in progress" here either
    if(mine.some(r => r.status === "in-progress" && !isTombstoned(r))) return "in-progress";
    if(a.expiresAt && Date.now() > Date.parse(a.expiresAt)) return "expired";
    return "pending";
  }
  function fmtDay(isoStr){
    if(!isoStr) return "—";
    const d = new Date(isoStr);
    if(isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, {month:"short", day:"numeric", year:"2-digit"});
  }

  function viewAssign(){
    overlapSig = null;                     // the block is rebuilt below; refreshAssignOverlap must recompute
    if(!AttemptStore.available()){
      return '<p class="dash-empty">Storage isn\'t usable in this browser, so assignments can\'t be managed here.</p>';
    }
    if(source === "file"){
      // statuses/delete-gating are computed from recs; against an archive file
      // they'd be stale, and deleting could orphan a live in-progress attempt
      return '<p class="dash-empty">You\'re viewing a loaded archive file. Assignment statuses are computed from live attempts, so managing assignments is disabled — reload from storage first.</p>';
    }
    // a deleted student is never offered as an assignment target (the code
    // is retired: it cannot sign in, so nothing assigned to it can be sat)
    const knownCodes = Array.from(new Set(
      recs.map(r => r.student && r.student.key).filter(Boolean)
        .concat(assigns.map(a => a.code))
    )).filter(c => !isDeletedStudent(c)).sort();
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
              <select id="afCodes" multiple size="4">${knownCodes.map(c => `<option value="${escAttr(c)}">${esc(codeOptionLabel(c))}</option>`).join("")}</select></label>
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
          <div class="canon-assign" id="afOverlap">${assignOverlapHtml([], ((window.TEST_MANIFEST || [])[0] || {}).testId || "")}</div>
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
              <select id="afResetCode">${assignedCodes.map(c => `<option value="${escAttr(c)}">${esc(codeOptionLabel(c))}</option>`).join("")}</select>
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
    /* a deleted student's code is RETIRED: it stays taken for ever, so
       Generate can never hand it to a new student (who would then be refused
       at sign-in by the tombstone, and would inherit the old code's history
       in any export) */
    Object.keys(tombs).forEach(k => {
      if(k.indexOf("tomb:student:") === 0) s[k.slice("tomb:student:".length).toUpperCase()] = true;
    });
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
    refreshAssignOverlap();                // a programmatic value change fires no input event
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
    const all = Array.from(new Set(sel.concat(free)));
    /* a deleted (retired) code is reported, never silently skipped or used:
       the caller refuses the whole form so nothing is half-done */
    return { codes: all.filter(c => !isDeletedStudent(c)),
             bad: free.filter(c => !StudentCode.valid(c)),
             deleted: all.filter(isDeletedStudent) };
  }

  /* ================= TUTOR MUTATIONS (remote-confirmed) =================
     Every tutor write and delete in this file goes through tutorPut() and
     tutorDelete() — one implementation of one rule: in remote mode the SERVER
     is written first, and this browser's mirror follows only on success. A
     rejected write (expired tutor session → 401, any non-2xx, a timeout)
     therefore leaves the mirror exactly as it was, so the dashboard never
     shows a row the server doesn't have (a phantom assignment the student
     never gets) and never drops a row the server still has (a delete the
     student never sees). Nothing syncs tutor writes later — the student RPCs
     can't carry them and the sync queue holds only student rows — so a
     rejection is final and is reported as "Not saved" / "Not deleted",
     naming the row. In local/artifact mode the mirror IS the store.
     tests/tutor-writes.test.js drives every caller through a rejecting
     server and checks the mirror against its true pre-write state. */
  function describeRow(key){
    const k = String(key || "");
    const p = k.split(":");
    if(p[0] === "assign" && p.length >= 3){
      return p[2] === "__none" ? "the empty-assignments marker for " + p[1]
                               : "assignment " + p.slice(2).join(":") + " for " + p[1];
    }
    if(p[0] === "assign")  return "the legacy assignment list for " + (p[1] || "?");
    if(p[0] === "tomb" && p[1] === "student") return "the deletion marker for student " + (p[2] || "?");
    if(p[0] === "tomb")    return "the deletion marker for " + describeRow(k.slice("tomb:".length));
    if(p[0] === "student") return "the display name for " + (p[1] || "?");
    if(p[0] === "pset")    return "set " + (p[1] || "?");
    if(p[0] === "attempt") return "attempt " + k;
    if(p[0] === "bug")     return "bug report " + k;
    return "row " + k;
  }
  function rejectedText(what, key, e){
    const why = (e && e.status === 401) ? "the tutor sign-in has expired"
              : (e && e.status)         ? "the server rejected it (HTTP " + e.status + ")"
              : (e && e.name === "AbortError") ? "the server didn't answer in time"
              : "the server rejected it";
    return "Not " + what + " — " + describeRow(key) + ": " + why +
      ". This browser's copy is unchanged. Sign in again and retry.";
  }
  async function tutorPut(key, ownerCode, value){
    if(AttemptStore.isRemote()){
      try{ await AttemptStore.adminUpsert(key, ownerCode, value); }
      catch(e){ return { ok: false, message: rejectedText("saved", key, e) }; }
      if(await AttemptStore.setLocal(key, value)) return { ok: true };
      return { ok: true, warning: "Saved on the server, but this browser's copy of " +
        describeRow(key) + " couldn't be updated — press Refresh." };
    }
    if(await AttemptStore.setLocal(key, value)) return { ok: true };
    return { ok: false, message: "Not saved — " + describeRow(key) + ": storage isn't writable in this browser." };
  }
  async function tutorDelete(key){
    if(AttemptStore.isRemote()){
      try{ await AttemptStore.adminDelete(key); }
      catch(e){ return { ok: false, message: rejectedText("deleted", key, e) }; }
      if(await AttemptStore.remove(key)) return { ok: true };
      return { ok: true, warning: "Deleted on the server, but this browser's copy of " +
        describeRow(key) + " couldn't be removed — press Refresh." };
    }
    if(await AttemptStore.remove(key)) return { ok: true };
    return { ok: false, message: "Not deleted — " + describeRow(key) + ": storage isn't writable in this browser." };
  }

  /* ================= TOMBSTONES (2026-09-18) =================
     The third helper, same contract as the two above: SERVER FIRST, mirror
     on success, "Not deleted — …" naming the row when the server refuses,
     never a word about sync. What it writes is a deletion MARKER row —
     tomb:<attemptKey> or tomb:student:<CODE> — and nothing else: no record
     is edited, no row is removed, there is no un-delete. In remote mode the
     server does the writing (fn_tombstone_attempt / fn_tombstone_student:
     SECURITY DEFINER, EXECUTE for `authenticated` only, who/when stamped
     from the JWT) and this browser mirrors exactly the rows it returns. In
     local/artifact mode this store IS the record, so the same rows are
     written here with the local identity. Idempotent: an existing marker is
     never overwritten, so the original who/when always stands.
     `kind` is "attempt" (id = attemptId, finished only) or "student"
     (id = code: every attempt the code owns, in-progress included, then the
     student marker LAST — it is the commit point that refuses sign-in). */
  function localTombstone(r, reason, now, by){
    return { kind: "tombstone", targetKind: "attempt", target: r.attemptId,
      code: (r.student && r.student.key) || null,
      deletedAt: now, deletedBy: by, reason: reason,
      testId: r.testId == null ? null : r.testId,
      assignmentId: r.assignmentId == null ? null : r.assignmentId,
      status: r.status == null ? null : r.status,
      attemptKind: r.kind === "set" ? "set" : "form",
      setId: r.setId == null ? null : r.setId,
      conditions: r.conditions == null ? null : r.conditions,
      startedAt: r.startedAt == null ? null : r.startedAt,
      submittedAt: r.submittedAt == null ? null : r.submittedAt };
  }
  function isTombValue(v){ return !!(v && typeof v === "object" && v.kind === "tombstone" && typeof v.target === "string"); }
  async function tutorTombstone(kind, id){
    const key = kind === "student" ? "tomb:student:" + id : "tomb:" + id;
    if(AttemptStore.isRemote()){
      let out;
      try{
        out = kind === "student"
          ? await AttemptStore.adminRpc("fn_tombstone_student", { p_code: id })
          : await AttemptStore.adminRpc("fn_tombstone_attempt", { p_key: id });
      }catch(e){ return { ok: false, message: rejectedText("deleted", key, e) }; }
      const rows = kind === "student"
        ? [{ key: key, value: out && out.student }].concat((out && Array.isArray(out.attempts)) ? out.attempts : [])
        : [{ key: key, value: out }];
      /* the server must hand back a marker for every row; anything else is
         treated as not done — the mirror is left exactly as it was */
      if(!rows.length || rows.some(r => !r || typeof r.key !== "string" || r.key.indexOf("tomb:") !== 0 || !isTombValue(r.value))){
        return { ok: false, message: "Not deleted — " + describeRow(key) +
          ": the server answered without a deletion marker. This browser's copy is unchanged." };
      }
      let mirrorFail = 0;
      for(const r of rows){ if(!(await AttemptStore.setLocal(r.key, r.value))) mirrorFail++; }
      return { ok: true, rows: rows, warning: mirrorFail
        ? "Deleted on the server, but " + mirrorFail + " marker(s) couldn't be written to this browser's copy — press Refresh."
        : undefined };
    }
    /* local / artifact: build the same rows here. Attempt markers first,
       the student marker last; a write that fails stops the loop and says
       how far it got — never claims the student is gone when they are not. */
    const now = new Date().toISOString();
    const by = AttemptStore.tutorIdentity();
    const rows = [];
    if(kind === "student"){
      const mine = recs.filter(r => r && r.student && r.student.key === id);
      for(const r of mine){
        const tk = "tomb:" + r.attemptId;
        const existing = await AttemptStore.get(tk);
        rows.push({ key: tk, value: isTombValue(existing) ? existing : localTombstone(r, "student", now, by) });
      }
      const existing = await AttemptStore.get(key);
      rows.push({ key: key, value: isTombValue(existing) ? existing : { kind: "tombstone", targetKind: "student",
        target: id, code: id, deletedAt: now, deletedBy: by, attemptsTombstoned: mine.length, hadProfile: !!profiles[id] } });
    } else {
      const r = recs.find(x => x.attemptId === id);
      if(!r) return { ok: false, message: "Not deleted — " + describeRow(key) + ": the attempt is not listed right now. Press Refresh." };
      const existing = await AttemptStore.get(key);
      rows.push({ key: key, value: isTombValue(existing) ? existing : localTombstone(r, "attempt", now, by) });
    }
    let written = 0;
    for(const r of rows){
      if(!(await AttemptStore.setLocal(r.key, r.value))){
        return { ok: false, message: "Not deleted — " + describeRow(r.key) + ": storage isn't writable in this browser." +
          (written ? " " + written + " attempt marker(s) were written before it failed — press Refresh and retry." : "") };
      }
      written++;
    }
    return { ok: true, rows: rows };
  }

  /* Write the display-name profile row. Its own key, its own row — never
     merged into an attempt (ATTEMPTS-SPEC §7a). Writing goes through the
     tutor's authenticated table access; there is deliberately no anon RPC for
     this, so a student can't rename themselves or anyone else. Returns which
     codes were saved, which weren't, and the messages to show; the in-memory
     profiles map changes only for codes the store actually took. */
  async function saveProfiles(codes, name){
    const clean = String(name || "").trim().slice(0, 60);
    const out = { saved: [], failed: [], messages: [] };
    for(const code of codes){
      const key = "student:" + code;
      const res = clean ? await tutorPut(key, code, { displayName: clean })
                        : await tutorDelete(key);        // blank clears the name
      if(!res.ok){ out.failed.push(code); out.messages.push(res.message); continue; }
      if(clean) profiles[code] = clean; else delete profiles[code];
      out.saved.push(code);
      if(res.warning) out.messages.push(res.warning);
    }
    return out;
  }

  async function saveNameOnly(){
    const { codes, bad, deleted } = formCodes();
    if(bad.length){ $("afMsg").textContent = "These codes don't look right: " + bad.join(", "); return; }
    if(deleted.length){ $("afMsg").textContent = "Deleted — a retired code can't be renamed: " + deleted.join(", "); return; }
    if(!codes.length){ $("afMsg").textContent = "Pick or enter at least one student code."; return; }
    const name = $("afName").value.trim();
    const r = await saveProfiles(codes, name);
    $("dashStatus").textContent =
      (r.saved.length
        ? (name ? "Name saved for " + r.saved.join(", ") + " — assignments untouched."
                : "Name cleared for " + r.saved.join(", ") + " — they'll see their code again.")
        : "") +
      (r.messages.length ? (r.saved.length ? " " : "") + r.messages.join(" ") : "");
    await loadAssignsAndBugs();
    render();
  }

  async function createAssignment(){
    const { codes, bad, deleted } = formCodes();
    if(bad.length){ $("afMsg").textContent = "These codes don't look right: " + bad.join(", "); return; }
    if(deleted.length){ $("afMsg").textContent = "Deleted — a retired code can't be assigned to: " + deleted.join(", "); return; }
    if(!codes.length){ $("afMsg").textContent = "Pick or enter at least one student code."; return; }
    // a name typed here is saved as a profile row, separate from the assignment
    const nameIn = $("afName").value.trim();
    const prof = nameIn ? await saveProfiles(codes, nameIn) : null;
    const testId = $("afTest").value;
    const category = $("afCat").value;
    const timingRaw = $("afTiming").value;                       // Phase G §1
    const timing = timingRaw === "untimed" ? "untimed" : parseFloat(timingRaw);
    const startCode = category === "test"
      ? String(Math.floor(100000 + Math.random() * 900000)) : null;
    const opens = $("afOpens").value ? new Date($("afOpens").value + "T00:00:00").toISOString() : null;
    const expires = $("afExpires").value ? new Date($("afExpires").value + "T23:59:00").toISOString() : null;
    /* Phase H §3: one row per assignment. No read-modify-write, so the
       Phase F clobber is gone — concurrent writers touch different keys.
       Per-code outcome: the server can take some codes and reject the rest
       (a session expiring mid-loop), and a blanket "try again" would
       duplicate the ones that landed. */
    const assigned = [], notes = [];
    for(const code of codes){
      const a = {
        assignmentId: "a-" + Math.floor(Date.now()/1000) + "-" + Math.random().toString(16).slice(2, 6),
        testId, category, startCode, timing,
        windowOpens: opens, expiresAt: expires,
        assignedAt: new Date().toISOString(),
        completedAttemptId: null
      };
      const key = "assign:" + code + ":" + a.assignmentId;
      const res = await tutorPut(key, code, a);
      if(!res.ok){ notes.push(res.message); continue; }
      assigned.push(code);
      if(res.warning) notes.push(res.warning);
      /* tidy the vestigial __none marker (absent == empty since 2026-08-01)
         if this browser still holds one; not a failed assignment if it
         can't go, so it is noted rather than counted */
      const sentinel = "assign:" + code + ":__none";
      if(await AttemptStore.get(sentinel)){
        const t = await tutorDelete(sentinel);
        if(!t.ok) notes.push(t.message);
      }
    }
    if(prof) notes.push(...prof.messages);
    lastStartCode = assigned.length ? startCode : null;   // never read a code aloud for a sitting that doesn't exist
    /* canonical-id overlap, repeated in the status line so the warning
       survives the re-render that empties the form (information only —
       the assignment was made as asked) */
    notes.push(...overlapNotes(assigned, testId));
    $("dashStatus").textContent =
      (assigned.length
        ? "Assigned " + testId + " to " + assigned.join(", ") + (AttemptStore.isRemote() ? " (on the server)." : ".")
        : "") +
      (notes.length ? (assigned.length ? " " : "") + notes.join(" ") : "");
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
    const res = await tutorDelete(key);
    $("dashStatus").textContent = res.ok
      ? "Deleted " + describeRow(key) + "." + (res.warning ? " " + res.warning : "")
      : res.message;
    if(!res.ok) return;                          // nothing changed anywhere
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
    let cleared = 0;
    const problems = [];
    for(const k of keys){
      const res = await tutorDelete(k);
      if(res.ok){ cleared++; if(res.warning) problems.push(res.warning); }
      else problems.push(res.message);
    }
    $("dashStatus").textContent = !problems.length
      ? "Cleared every assignment for " + code + " — their home screen is now empty."
      : (cleared ? "Cleared " + cleared + " of " + keys.length + " assignment row(s) for " + code + ". " : "") +
        problems.join(" ");
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
    /* tomb: rows are deliberately NOT carried: a deletion marker is written
       only through the confirmed dashboard flow and the server's tutor RPC,
       never by bulk upload from whatever a device holds. And nothing owned
       by a DELETED student goes up either — the server refuses that
       student's own writes, so the tutor's REST path must not become the
       way a retired code's rows reach the server unmarked. Counted, named. */
    let retired = 0;
    for(const prefix of ["attempt:", "assign:", "bug:", "pset:", "student:"]){
      const keys = (await AttemptStore.list(prefix)) || [];
      for(const k of keys){
        if(remoteKeys[k]){ skipped++; continue; }
        const v = await AttemptStore.get(k);
        if(!v) { failed++; continue; }
        // owner: attempts carry student.code; assignment and profile keys embed the code
        let owner = null;
        if(k.indexOf("attempt:") === 0) owner = (v.student && v.student.key) || null;
        else if(k.indexOf("assign:") === 0) owner = k.split(":")[1] || null;
        else if(k.indexOf("student:") === 0) owner = k.split(":")[1] || null;
        else if(k.indexOf("bug:") === 0) owner = v.studentCode || null;
        if(owner && isDeletedStudent(owner)){ retired++; continue; }
        try{ await AttemptStore.adminUpsert(k, owner, v); sent++; }
        catch(e){ failed++; }
      }
    }
    $("dashStatus").textContent =
      "Upload finished — " + sent + " sent, " + skipped + " already on the server" +
      (failed ? ", " + failed + " failed" : "") +
      (retired ? ", " + retired + " belonging to deleted student(s) not sent" : "") + ".";
    await loadFromStorage();
  }

  /* ---------- Question Bank tab (custom practice sets, 2026-08-31) ----------
     Read-only browse over BANK_INDEX. Authoring is the TSV lane (test-bank
     repo: banks/<bankId>/inbox.tsv -> tsv_to_bluebook_json.py --bank ->
     export_bank.py); nothing here writes a bank. Every string is escaped —
     the index ships with the app, but one escaping rule for every surface
     beats reasoning about which inputs are trusted. */
  function bankStatusBadge(e){
    if(!e.retired) return '<span class="dstatus ok">active</span>';
    return '<span class="dstatus to">retired</span>' +
      (e.supersededBy ? ' <span class="dcode">→ ' + esc(e.supersededBy) + '</span>' : "");
  }
  function viewBank(){
    const idx = window.BANK_INDEX;
    const banks = window.BANK_MANIFEST || [];
    if(!idx || !Array.isArray(idx.entries) || !banks.length){
      return '<p class="dash-empty">No question banks are loaded — testdata/bank-manifest.js and bank-index.js ship from the test-bank repo\'s export lane.</p>';
    }
    const q = bankFilter.q.trim().toLowerCase();
    const entries = idx.entries.filter(e => {
      if(bankFilter.subject && e.subject !== bankFilter.subject) return false;
      if(!bankFilter.retired && e.retired) return false;
      if(!q) return true;
      return [e.ref, e.qid, e.skill, e.stemPreview, (e.tags || []).join(" ")]
        .some(s => String(s || "").toLowerCase().indexOf(q) !== -1);
    });
    const bankLines = banks.map(b =>
      `<p class="dash-hint"><b>${esc(b.bankName || b.bankId)}</b> <span class="dcode">${esc(b.bankId)}</span> · ` +
      `${cnt(b.activeCount)} active / ${cnt(b.retiredCount)} retired · version ${esc(b.bankVersion || "?")}</p>`).join("");
    const rowsHtml = entries.map(e => `
      <tr>
        <td class="dcode">${esc(e.ref)}</td>
        <td>${esc(e.subject === "math" ? "Math" : "R&W")}</td>
        <td>${esc(e.skill || "—")}</td>
        <td>${esc(e.keyType || "?")}</td>
        <td>${(e.tags || []).map(t => '<span class="dcode">' + esc(t) + '</span>').join(" ") || "—"}</td>
        <td>${bankStatusBadge(e)}</td>
        <td class="bank-stem">${esc(e.stemPreview || "")}</td>
      </tr>`).join("");
    return `
      <div class="dcard">
        <h3>Question Bank <span class="dcard-sub">read-only</span></h3>
        <p class="dash-hint">Questions are authored in the test-bank repo's TSV lane and arrive here through
          <code>export_bank.py</code> — a shipped question never changes; edits mint a new qid and retire the old one.</p>
        ${bankLines}
        <div class="af-actions bank-filters">
          <input id="bankSearch" placeholder="Search qid / skill / tags / stem…" value="${escAttr(bankFilter.q)}" autocomplete="off">
          <select id="bankSubject">
            <option value=""${bankFilter.subject === "" ? " selected" : ""}>All subjects</option>
            <option value="rw"${bankFilter.subject === "rw" ? " selected" : ""}>Reading and Writing</option>
            <option value="math"${bankFilter.subject === "math" ? " selected" : ""}>Math</option>
          </select>
          <label class="sd-toggle"><input type="checkbox" id="bankRetired" ${bankFilter.retired ? "checked" : ""}> Show retired</label>
        </div>
      </div>
      ${entries.length ? `<table class="dtable"><thead><tr>
          <th>Ref</th><th>Subject</th><th>Skill</th><th>Type</th><th>Tags</th><th>Status</th><th>Stem</th>
        </tr></thead><tbody>${rowsHtml}</tbody></table>`
        : '<p class="dash-empty">No bank questions match.</p>'}`;
  }

  /* ---------- Practice Sets tab ----------
     Create/edit/delete SETS (mutable pset:<setId> rows), assign them to
     codes, and list attempts per set. The builder's question index is the
     bank index PLUS a form-question index derived at runtime from loaded
     testdata (testId, module, qid, keyType, stem preview; skill comes
     straight off the question and is empty where a form is untagged). */
  function stripTokens(s){
    return String(s == null ? "" : s).replace(/\{\{\/?[a-z]+\}\}/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  }
  function subjectOfSection(section){ return section === "Math" ? "math" : "rw"; }
  function refKey(ref){
    return ref.type === "bank" ? (ref.bankId + ":" + ref.qid) : (ref.testId + ":" + ref.qid);
  }
  function refLabel(ref){
    if(ref.type === "bank"){
      const e = (window.BANK_INDEX && BANK_INDEX.entries || []).find(x => x.bankId === ref.bankId && x.qid === ref.qid);
      return { title: ref.bankId + ":" + ref.qid, sub: e ? (e.skill || "") + (e.retired ? " · RETIRED" : "") : "", stem: e ? e.stemPreview : "" };
    }
    const t = testsById[ref.testId];
    const ix = qIndex(ref.testId);
    const info = ix && ix[ref.qid];
    return { title: (t ? t.testName : ref.testId) + " · " + ref.qid,
      sub: info && info.q.skill ? info.q.skill : "",
      stem: info ? stripTokens(info.q.questionText) : "" };
  }
  function setAttemptsFor(setId){
    return recs.filter(r => r.kind === "set" && r.setId === setId);
  }
  function assignmentsForSet(setId){
    const out = [];
    assigns.forEach(entry => (entry.list || []).forEach(a => {
      if(a && a.kind === "set" && a.setId === setId) out.push({ code: entry.code, a: a });
    }));
    return out;
  }

  function viewSets(){
    const canWrite = source === "storage";
    if(!canWrite) return '<p class="dash-empty">You\'re viewing a loaded archive file — sets are managed against live storage. Reload from storage first.</p>';
    /* canonical-id marks (2026-09-07): lazy index, one notice when off, and
       the seen set of the student chosen in the Student filter */
    ensureDedupLoaded();
    const student = selectedStudent();
    const seen = student ? seenSetFor(student) : null;     // null: no student, or index not ready
    const listHtml = sets.length ? `<table class="dtable"><thead><tr>
        <th>Set</th><th>Subject</th><th>Questions</th>${seen ? "<th>Seen by " + esc(codeOptionLabel(student)) + "</th>" : ""}<th>Assigned</th><th>Attempts</th><th></th>
      </tr></thead><tbody>` +
      sets.map(s => {
        const nAssign = assignmentsForSet(s.setId).length;
        const nAtt = setAttemptsFor(s.setId).length;
        return `<tr>
          <td><b>${esc(s.name)}</b> <span class="dcode">${esc(s.setId)}</span></td>
          <td>${esc(s.subject === "math" ? "Math" : "R&W")}</td>
          <td>${Array.isArray(s.refs) ? s.refs.length : 0}</td>
          ${seen ? "<td>" + esc(countsText(seenCounts(setRefKeys(s), seen))) + "</td>" : ""}
          <td>${nAssign}</td>
          <td>${nAtt}</td>
          <td>
            <button class="dash-rel set-edit" data-set="${escAttr(s.setId)}">Edit</button>
            <button class="dash-rel set-del" data-set="${escAttr(s.setId)}">Delete</button>
          </td>
        </tr>`;
      }).join("") + "</tbody></table>"
      : '<p class="dash-empty">No practice sets yet — build one below.</p>';

    /* attempts per set (records audit stays in the Attempts tab; this is the
       per-set slice the contract asks for) */
    const attemptsHtml = sets.map(s => {
      const mine = setAttemptsFor(s.setId).slice().sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      if(!mine.length) return "";
      return `<div class="dcard"><h3>${esc(s.name)} <span class="dcard-sub">${mine.length} attempt(s)</span></h3>
        <table class="dtable slim"><thead><tr><th>Student</th><th>Date</th><th>Score</th><th>Status</th><th>Results</th></tr></thead><tbody>` +
        mine.map(r => `<tr data-att="${escAttr(r.attemptId)}">
          <td>${studentCell(r.student && r.student.code)}</td>
          <td>${fmtDate(r.startedAt)}</td>
          <td><b>${scoreStr(r)}</b></td>
          <td>${statusBadge(r)}${timingBadgeHtml(r.timing)}</td>
          <td>${releaseCell(r)}</td>
        </tr>`).join("") + "</tbody></table></div>";
    }).join("");

    const marksHint = dedupState !== "ready" ? "" : student
      ? `<p class="dash-hint">Seen / reskin seen / unseen marks are for ${studentCell(student)} (the Student filter above), from ${seen ? seen.attempts : 0} completed attempt${seen && seen.attempts === 1 ? "" : "s"} in storage — sittings archived and deleted no longer count.${
          seen && seenCaveat(seen) ? " " + esc(seenCaveat(seen)) : ""}</p>`
      : '<p class="dash-hint">Pick a student in the Student filter above to mark every question seen / reskin seen / unseen for them.</p>';

    return `
      <div class="dcard">
        <h3>Practice Sets</h3>
        <p class="dash-hint">A set is a named, ordered pick of questions from the bank and from published tests —
          one subject per set, sat untimed (or with a time limit you choose at assignment) in the real test UI, no scaled scoring.</p>
        ${dedupNoticeHtml()}
        ${marksHint}
        ${listHtml}
        <div class="af-actions">
          <button class="pill" id="setNewBtn" style="padding:9px 22px;">New set</button>
          <span class="dash-hint" id="setsMsg">${esc(setsMsg)}</span>
        </div>
      </div>
      ${builder ? viewSetBuilder() : ""}
      ${viewSetAssign()}
      ${attemptsHtml}`;
  }

  function viewSetBuilder(){
    const refs = builder.refs;
    const student = selectedStudent();
    const seen = student ? seenSetFor(student) : null;
    const mark = k => seen ? markHtml(markFor(k, seen)) : "";
    const refsHtml = refs.length ? refs.map((ref, i) => {
      const lbl = refLabel(ref);
      const k = refKey(ref);
      return `<div class="setref-row">
        <span class="setref-n">${i + 1}</span>
        <span class="setref-main"><b>${esc(lbl.title)}</b>${lbl.sub ? ' <span class="dcode">' + esc(lbl.sub) + "</span>" : ""}${ref.type === "form" ? " " + provHtml(k) : ""}${mark(k)}
          <span class="bank-stem">${esc(lbl.stem)}</span></span>
        <span class="setref-btns">
          <button class="dash-rel ref-up" data-i="${i}" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="dash-rel ref-down" data-i="${i}" ${i === refs.length - 1 ? "disabled" : ""}>↓</button>
          <button class="dash-rel ref-rm" data-i="${i}">✕</button>
        </span>
      </div>`;
    }).join("") : '<p class="dash-empty">No questions yet — add from the bank or a test below.</p>';

    /* Grouping by canonical id — builderHeldAs() is the one rule: a form
       question whose exact duplicate (same canonical id, on this or another
       form) is already in the set reads "In set as <that ref>" and cannot be
       added again; bank rows are held only by their own key. Refs that got
       in twice anyway (index not loaded at the time, or a pre-grouping set)
       are called out so the tutor can remove them. */
    const dupGroups = builderDuplicateGroups();
    const dupHtml = dupGroups.length
      ? '<p class="canon-notice rv-notice warn">This set holds the same item more than once — ' +
        dupGroups.map(g => esc(g.map(refText).join(" = "))).join("; ") +
        ". Remove the extra copies above; nothing is removed for you.</p>"
      : "";

    /* bank picker: subject-matched, active first, retired flagged */
    const bankEntries = (window.BANK_INDEX && BANK_INDEX.entries || [])
      .filter(e => e.subject === builder.subject);
    const bankPickHtml = bankEntries.length ? bankEntries.map(e => {
      const held = builderHeldAs({ type: "bank", bankId: e.bankId, qid: e.qid });
      return `
      <div class="setpick-row${e.retired ? " is-retired" : ""}">
        <span class="setpick-main"><b>${esc(e.ref)}</b> ${bankStatusBadge(e)}
          <span class="dcode">${esc(e.skill || "")}</span>${mark(e.bankId + ":" + e.qid)}
          <span class="bank-stem">${esc(e.stemPreview || "")}</span></span>
        <button class="dash-rel pick-bank" data-bank="${escAttr(e.bankId)}" data-qid="${escAttr(e.qid)}"
          ${held ? "disabled" : ""}>${held ? "Added" : "Add"}</button>
      </div>`;
    }).join("")
      : '<p class="dash-empty">The bank has no ' + esc(builder.subject === "math" ? "Math" : "R&W") + ' questions yet.</p>';

    /* form picker: pick a test, load its content, then per-module rows */
    const wantSection = builder.subject === "math" ? "Math" : "Reading and Writing";
    const testOpts = (window.TEST_MANIFEST || []).map(t =>
      `<option value="${escAttr(t.testId)}"${builderTestId === t.testId ? " selected" : ""}>${esc(t.testName)}</option>`).join("");
    let formPickHtml = "";
    if(builderTestId){
      const full = fullTests[builderTestId];
      if(!full){
        ensureTestLoaded(builderTestId);
        formPickHtml = '<p class="dash-hint">Loading questions…</p>';
      } else {
        formPickHtml = full.modules.filter(m => m.section === wantSection).map(m => {
          const heldOf = q => builderHeldAs({ type: "form", testId: builderTestId, moduleId: m.moduleId, qid: q.id });
          const allIn = m.questions.every(q => !!heldOf(q));
          return `<div class="setpick-mod">
            <div class="setpick-modhead"><b>${esc(m.section)} · ${esc(m.moduleLabel)}</b>
              <button class="dash-rel pick-module" data-mod="${escAttr(m.moduleId)}" ${allIn ? "disabled" : ""}>
                ${allIn ? "All added" : "Add whole module"}</button></div>` +
            m.questions.map((q, qi) => {
              const k = builderTestId + ":" + q.id;
              const held = heldOf(q);
              const own = held === canonRef(k);
              const btn = own ? "Added" : held ? "In set as " + refText(held) : "Add";
              return `
              <div class="setpick-row${held && !own ? " is-held" : ""}">
                <span class="setpick-main"><b>${qi + 1}</b> <span class="dcode">${esc(q.id)}</span> ${esc(q.type || "?")}
                  ${q.skill ? '<span class="dcode">' + esc(q.skill) + "</span>" : ""} ${provHtml(k)}${mark(k)}
                  <span class="bank-stem">${esc(stripTokens(q.questionText))}</span></span>
                <button class="dash-rel pick-form" data-mod="${escAttr(m.moduleId)}" data-qid="${escAttr(q.id)}"
                  ${held ? "disabled" : ""}>${esc(btn)}</button>
              </div>`;
            }).join("") + "</div>";
        }).join("") || '<p class="dash-empty">That test has no ' + esc(wantSection) + ' modules.</p>';
      }
    }

    const countsHtml = seen
      ? ` <span class="dcard-sub">${esc(countsText(seenCounts(refs.map(refKey), seen)))} for ${esc(codeOptionLabel(student))}</span>` : "";

    return `
      <div class="dcard set-builder">
        <h3>${builder.setId ? "Edit set" : "New set"}${countsHtml}</h3>
        <div class="af-grid">
          <label>Name (students see this)
            <input id="sbName" value="${escAttr(builder.name)}" placeholder="Linear equations warm-up" autocomplete="off"></label>
          <label>Subject — one per set
            <select id="sbSubject" ${refs.length ? "disabled title=\"Remove every question to change the subject\"" : ""}>
              <option value="math"${builder.subject === "math" ? " selected" : ""}>Math</option>
              <option value="rw"${builder.subject === "rw" ? " selected" : ""}>Reading and Writing</option>
            </select></label>
        </div>
        <h4>Questions — in the order students see them</h4>
        ${dupHtml}
        <div class="setref-list">${refsHtml}</div>
        <div class="setpick-cols">
          <div>
            <h4>From the question bank</h4>
            ${bankPickHtml}
          </div>
          <div>
            <h4>From a test</h4>
            <label>Test <select id="sbTest"><option value="">Pick a test…</option>${testOpts}</select></label>
            ${formPickHtml}
          </div>
        </div>
        <div class="af-actions">
          <button class="pill" id="sbSaveBtn" style="padding:9px 26px;">Save set</button>
          <button class="pill ghost" id="sbCancelBtn" style="padding:9px 20px;">Cancel</button>
          <span class="dash-hint" id="sbMsg"></span>
        </div>
      </div>`;
  }

  function viewSetAssign(){
    if(!sets.length) return "";
    const knownCodes = Array.from(new Set(
      recs.map(r => r.student && r.student.key).filter(Boolean)
        .concat(assigns.map(a => a.code))
    )).filter(c => !isDeletedStudent(c)).sort();    // retired codes are never offered
    const existing = [];
    assigns.forEach(entry => (entry.list || []).forEach(a => {
      if(a && a.kind === "set") existing.push({ code: entry.code, a: a });
    }));
    const rowsHtml = existing.map(x => {
      const s = sets.find(v => v.setId === x.a.setId);
      const st = assignRowStatus(x.code, x.a);
      const deletable = st === "pending" || st === "expired";
      return `<tr>
        <td>${studentCell(x.code)}</td>
        <td>${esc((s && s.name) || x.a.setName || x.a.setId)}</td>
        <td>${x.a.timeLimitMinutes ? esc(String(x.a.timeLimitMinutes)) + " min" : "Untimed"}</td>
        <td>${x.a.holdRelease ? "Held — release manually" : "Releases on submit"}</td>
        <td>${fmtDay(x.a.expiresAt)}</td>
        <td><span class="dstatus ${ {completed:"ok", "in-progress":"warn", expired:"to"}[st] || "" }">${st}</span></td>
        <td>${deletable ? `<button class="dash-rel assign-del" data-code="${escAttr(x.code)}" data-aid="${escAttr(x.a.assignmentId)}">Delete</button>` : ""}</td>
      </tr>`;
    }).join("");
    return `
      <div class="dcard">
        <h3>Assign a set</h3>
        <div class="af-grid">
          <label>Set
            <select id="saSet">${sets.map(s => `<option value="${escAttr(s.setId)}">${esc(s.name)}</option>`).join("")}</select></label>
          <label>Student codes (seen in storage)
            <select id="saCodes" multiple size="4">${knownCodes.map(c => `<option value="${escAttr(c)}">${esc(codeOptionLabel(c))}</option>`).join("")}</select></label>
          <label>More codes (comma-separated)
            <span class="af-codegen">
              <input id="saFree" placeholder="AS-XXXXXXXX" autocomplete="off">
              <button type="button" class="pill ghost" id="saGenBtn" title="Generate a new unused code">Generate</button>
            </span></label>
          <label>Time limit (minutes, blank = untimed)
            <input id="saLimit" type="number" min="1" max="180" placeholder="untimed"></label>
          <label>Expires (optional, end of day)
            <input type="date" id="saExpires"></label>
          <label class="sd-toggle" style="align-self:end;"><input type="checkbox" id="saHold">
            Hold results — release manually instead of on submit</label>
        </div>
        <div class="af-actions">
          <button class="pill" id="saAssignBtn" style="padding:9px 26px;">Assign set</button>
          <span class="dash-hint" id="saMsg">${esc(saMsg)}</span>
        </div>
        ${existing.length ? `<table class="dtable slim"><thead><tr>
            <th>Student</th><th>Set</th><th>Timing</th><th>Results</th><th>Expires</th><th>Status</th><th></th>
          </tr></thead><tbody>${rowsHtml}</tbody></table>` : ""}
      </div>`;
  }

  /* ---- set persistence (tutor-only writes through tutorPut/tutorDelete:
     server first, mirror on success, like every other tutor write) ---- */
  function newSetId(){
    return "pset-" + Math.floor(Date.now() / 1000) + "-" + Math.random().toString(16).slice(2, 6);
  }
  async function saveSetFromBuilder(){
    const name = $("sbName").value.trim().slice(0, 80);
    if(!name){ $("sbMsg").textContent = "Give the set a name."; return; }
    if(!builder.refs.length){ $("sbMsg").textContent = "Add at least one question."; return; }
    builder.name = name;
    const now = new Date().toISOString();
    const isNew = !builder.setId;
    const set = {
      setId: builder.setId || newSetId(),
      name: name,
      subject: builder.subject,
      refs: builder.refs,
      createdAt: builder.createdAt || now,
      updatedAt: now
    };
    const key = "pset:" + set.setId;
    /* Server first (tutorPut): a set the server never accepted must not show
       in this browser's list — it could be ASSIGNED from here, and the
       student would get "set unavailable", since fn_get_set reads the server. */
    const res = await tutorPut(key, null, set);
    const ok = res.ok;
    /* A live assignment carries a name/count snapshot for the student's card
       (assignSetFromForm). Refresh it on edit so the card doesn't advertise
       the old count. Each row is RE-READ FRESH right before it is patched
       and only the two fields are changed on that fresh copy — never the
       in-memory `assigns` snapshot written back wholesale. The snapshot is
       this browser's mirror, which never drops a row deleted from another
       browser (writing it back would resurrect a deleted assignment as a
       startable card), and in local/artifact mode the student's
       completeAssignment may have stamped completedAttemptId on the stored
       row since the dashboard opened (writing the snapshot back would erase
       it, and the assignment would reopen if the attempt were later
       deleted). A row that is gone is dropped from the mirror, not patched.
       Completed attempts are untouched either way: they froze their own
       question list at begin. */
    let patched = 0, patchFailed = 0;
    const patchNotes = [];
    if(ok && !isNew){
      for(const x of assignmentsForSet(set.setId)){
        const ak = "assign:" + x.code + ":" + x.a.assignmentId;
        let live;
        try{ live = await freshAssignmentRow(ak); }
        catch(e){ patchFailed++; patchNotes.push("Couldn't read " + describeRow(ak) + " from the server."); continue; }
        if(!live){
          try{ await AttemptStore.remove(ak); }catch(e){}   // heal the stale mirror (server never had it)
          continue;
        }
        if(live.setName === set.name && live.questionCount === set.refs.length) continue;
        const next = Object.assign({}, live, { setName: set.name, questionCount: set.refs.length });
        const p = await tutorPut(ak, x.code, next);   // server first; the mirror keeps `live` on rejection
        if(p.ok){ patched++; if(p.warning) patchNotes.push(p.warning); }
        else { patchFailed++; patchNotes.push(p.message); }
      }
    }
    setsMsg = ok
      ? (isNew ? "Created “" + set.name + "” — assign it below."
               : "Saved “" + set.name + "”. Existing assignments use the updated set from the next sitting on; completed attempts keep their own snapshot." +
                 (patched ? " Updated " + patched + " assignment card" + (patched === 1 ? "" : "s") + "." : "") +
                 (patchFailed ? " " + patchFailed + " assignment card" + (patchFailed === 1 ? "" : "s") + " couldn't be updated — the question count shown to that student may be stale." : "") +
                 (patchNotes.length ? " " + patchNotes.join(" ") : "")) +
        (res.warning ? " " + res.warning : "")
      : res.message;
    if(ok){ builder = null; if(isNew) await loadSets(); else await loadAssignsAndBugs(); }
    render();
  }
  /* The freshest copy of one assignment row, or null if it no longer exists:
     the SERVER's in remote mode (this browser's mirror can hold rows deleted
     from another browser), storage's otherwise (the student may have stamped
     completedAttemptId since `assigns` was loaded). Throws on a failed
     server read so the caller counts it as not patched rather than acting
     on nothing. */
  async function freshAssignmentRow(key){
    if(AttemptStore.isRemote()){
      const rows = await AttemptStore.adminSelectKey(key);
      const r = Array.isArray(rows) ? rows[0] : null;
      return (r && r.value && typeof r.value === "object" && r.value.assignmentId) ? r.value : null;
    }
    const v = await AttemptStore.get(key);
    return (v && typeof v === "object" && v.assignmentId) ? v : null;
  }
  async function deleteSet(setId){
    const s = sets.find(x => x.setId === setId);
    if(!s) return;
    const live = assignmentsForSet(setId);
    const warn = "Delete the set “" + s.name + "”?\n\n" +
      (live.length
        ? "It is assigned to: " + live.map(x => x.code).join(", ") + ".\nAn UNSTARTED assignment of it will no longer be able to start.\n\n"
        : "") +
      "Completed and in-progress attempts are NOT affected — each attempt froze its own copy of the questions at start.";
    if(!confirm(warn)) return;
    const res = await tutorDelete("pset:" + setId);
    setsMsg = res.ok ? "Deleted “" + s.name + "”." + (res.warning ? " " + res.warning : "") : res.message;
    await loadSets();
    render();
  }
  async function assignSetFromForm(){
    const setId = $("saSet").value;
    const s = sets.find(x => x.setId === setId);
    if(!s){ $("saMsg").textContent = "Pick a set."; return; }
    const sel = Array.from($("saCodes").selectedOptions).map(o => o.value);
    const free = $("saFree").value.split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
    const bad = free.filter(c => !StudentCode.valid(c));
    if(bad.length){ $("saMsg").textContent = "These codes don't look right: " + bad.join(", "); return; }
    const codes = Array.from(new Set(sel.concat(free)));
    const retired = codes.filter(isDeletedStudent);
    if(retired.length){ $("saMsg").textContent = "Deleted — a retired code can't be assigned to: " + retired.join(", "); return; }
    if(!codes.length){ $("saMsg").textContent = "Pick or enter at least one student code."; return; }
    const limitRaw = parseInt($("saLimit").value, 10);
    const limit = (isFinite(limitRaw) && limitRaw > 0) ? Math.min(limitRaw, 180) : null;
    const expires = $("saExpires").value ? new Date($("saExpires").value + "T23:59:00").toISOString() : null;
    /* Per-code outcome (server first via tutorPut): the server can accept
       some codes and reject the rest, and a blanket "try again" would
       duplicate the ones that landed. */
    const assigned = [], notes = [];
    for(const code of codes){
      const a = {
        assignmentId: "a-" + Math.floor(Date.now() / 1000) + "-" + Math.random().toString(16).slice(2, 6),
        kind: "set", category: "practice",
        setId: s.setId, setName: s.name,
        questionCount: Array.isArray(s.refs) ? s.refs.length : 0,
        timeLimitMinutes: limit,
        holdRelease: $("saHold").checked === true,
        windowOpens: null, expiresAt: expires,
        assignedAt: new Date().toISOString(),
        completedAttemptId: null
      };
      const key = "assign:" + code + ":" + a.assignmentId;
      const res = await tutorPut(key, code, a);
      if(!res.ok){ notes.push(res.message); continue; }
      assigned.push(code);
      if(res.warning) notes.push(res.warning);
    }
    /* into the module var, not the node: render() below rebuilds #dashBody
       and would wipe a textContent write together with the old node */
    saMsg =
      (assigned.length
        ? "Assigned “" + s.name + "” to " + assigned.join(", ") + (AttemptStore.isRemote() ? " (on the server)." : ".")
        : "") +
      (notes.length ? (assigned.length ? " " : "") + notes.join(" ") : "");
    await loadAssignsAndBugs();
    render();
  }
  function builderAddRef(ref){
    if(pushRef(ref)) render();             // builderHeldAs() is the one rule: no duplicate key, one entry per canonical item
  }
  function attachSetsHandlers(){
    const nb = $("setNewBtn");
    if(nb) nb.addEventListener("click", ()=>{
      builder = { setId: null, name: "", subject: "math", refs: [] };
      builderTestId = "";
      render();
    });
    document.querySelectorAll("#dashBody .set-edit").forEach(btn =>
      btn.addEventListener("click", ()=>{
        const s = sets.find(x => x.setId === btn.dataset.set);
        if(!s) return;
        builder = JSON.parse(JSON.stringify({ setId: s.setId, name: s.name,
          subject: s.subject === "math" ? "math" : "rw",
          refs: Array.isArray(s.refs) ? s.refs : [], createdAt: s.createdAt }));
        builderTestId = "";
        render();
      }));
    document.querySelectorAll("#dashBody .set-del").forEach(btn =>
      btn.addEventListener("click", ()=> deleteSet(btn.dataset.set)));
    if(builder){
      const nameIn = $("sbName");
      if(nameIn) nameIn.addEventListener("input", ()=>{ builder.name = nameIn.value; });
      const subj = $("sbSubject");
      if(subj) subj.addEventListener("change", ()=>{ builder.subject = subj.value === "rw" ? "rw" : "math"; render(); });
      const tsel = $("sbTest");
      if(tsel) tsel.addEventListener("change", ()=>{ builderTestId = tsel.value; render(); });
      const save = $("sbSaveBtn");
      if(save) save.addEventListener("click", saveSetFromBuilder);
      const cancel = $("sbCancelBtn");
      if(cancel) cancel.addEventListener("click", ()=>{ builder = null; render(); });
      document.querySelectorAll("#dashBody .pick-bank").forEach(btn =>
        btn.addEventListener("click", ()=> builderAddRef({ type: "bank", bankId: btn.dataset.bank, qid: btn.dataset.qid })));
      document.querySelectorAll("#dashBody .pick-form").forEach(btn =>
        btn.addEventListener("click", ()=> builderAddRef({ type: "form", testId: builderTestId, moduleId: btn.dataset.mod, qid: btn.dataset.qid })));
      document.querySelectorAll("#dashBody .pick-module").forEach(btn =>
        btn.addEventListener("click", ()=>{
          /* whole-module selection is a CONVENIENCE that expands to explicit
             refs — the set stores every (testId, moduleId, qid), never
             "module m1 of X" */
          const full = fullTests[builderTestId];
          const m = full && full.modules.find(x => x.moduleId === btn.dataset.mod);
          if(!m) return;
          m.questions.forEach(q => pushRef({ type: "form", testId: builderTestId, moduleId: m.moduleId, qid: q.id }));
          render();
        }));
      document.querySelectorAll("#dashBody .ref-rm").forEach(btn =>
        btn.addEventListener("click", ()=>{ builder.refs.splice(parseInt(btn.dataset.i, 10), 1); render(); }));
      document.querySelectorAll("#dashBody .ref-up").forEach(btn =>
        btn.addEventListener("click", ()=>{
          const i = parseInt(btn.dataset.i, 10);
          if(i > 0){ const t = builder.refs[i - 1]; builder.refs[i - 1] = builder.refs[i]; builder.refs[i] = t; render(); }
        }));
      document.querySelectorAll("#dashBody .ref-down").forEach(btn =>
        btn.addEventListener("click", ()=>{
          const i = parseInt(btn.dataset.i, 10);
          if(i < builder.refs.length - 1){ const t = builder.refs[i + 1]; builder.refs[i + 1] = builder.refs[i]; builder.refs[i] = t; render(); }
        }));
    }
    const sa = $("saAssignBtn");
    if(sa) sa.addEventListener("click", assignSetFromForm);
    const sg = $("saGenBtn");
    if(sg) sg.addEventListener("click", ()=>{
      const c = generateUnusedCode();
      if(!c){ $("saMsg").textContent = "Couldn't find an unused code — try again."; return; }
      const cur = $("saFree").value.trim();
      $("saFree").value = cur ? cur.replace(/[\s,;]+$/, "") + ", " + c : c;
      $("saMsg").textContent = "Generated " + c + " — give this to the student.";
    });
  }
  function attachBankHandlers(){
    const s = $("bankSearch");
    if(s) s.addEventListener("input", ()=>{ bankFilter.q = s.value; render();
      const s2 = $("bankSearch"); if(s2){ s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } });
    const subj = $("bankSubject");
    if(subj) subj.addEventListener("change", ()=>{ bankFilter.subject = subj.value; render(); });
    const ret = $("bankRetired");
    if(ret) ret.addEventListener("change", ()=>{ bankFilter.retired = ret.checked; render(); });
  }

  /* ---------- Phase F §9: bug reports ---------- */
  function viewBugs(){
    if(!bugs.length) return '<p class="dash-empty">No bug reports.</p>';
    return bugs.map(b => `
      <div class="dcard bug-card">
        <div class="bug-head"><b>${studentCell(b.studentCode || "?")}</b> · ${fmtDate(b.at)}
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
    const isSet = r.kind === "set";
    const idx = isSet ? null : qIndex(r.testId);
    const test = isSet ? null : testsById[r.testId];
    /* Set records get their own provenance note in place of the form version
       warning: per-question versions live in the snapshot, and the review
       resolves through it (setProvLookup) — EXPLICIT handling, not a
       fall-through to "question text unavailable". */
    const versionNote = isSet
      ? `<p class="dash-hint">Practice set — ${Array.isArray(r.setQuestions) ? r.setQuestions.length : "?"} question(s), each pinned to its source (bank qids never change; form questions carry the testVersion they were served). No scaled score by design.</p>`
      : (test && test.testVersion && r.testVersion !== (test.testVersion || "unversioned"))
      ? `<p class="dash-warn">⚠ This attempt was served test version “${esc(r.testVersion)}”, but this build carries “${esc(test.testVersion)}” — the review below may not match what the student saw (ATTEMPTS-SPEC §9).</p>` : "";
    const qRows = Object.entries(r.answers || {}).map(([qid, a]) => {
      const info = (idx && idx[qid]) || (isSet ? setProvLookup(r, qid) : null);
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
    // regardless of release). Offered when this build can SERVE the attempt's
    // version — current or archived; the student view loads the pinned build,
    // so the tutor sees exactly what the student sat on. (reuses `test`.)
    /* a deleted record opens for the TUTOR here (present-but-marked) but
       never as a student view: that surface exists for students, and the
       student side never receives this record any more */
    const canOpen = !isTombstoned(r) && (isSet
      ? (source === "storage" && !!window.AppSetReview)
      : (source === "storage" && test && window.AppTestLoader &&
         AppTestLoader.canServe(test, r.testVersion)));
    const canDelete = isDeletableAttempt(r);
    $("dashDetailBody").innerHTML = `
      <h2>${studentCell(r.student && r.student.code)} — ${esc(r.testName || r.testId)}</h2>
      <p class="dash-hint">${fmtDate(r.startedAt)} · ${esc(r.conditions||"unknown")}${timingBadgeHtml(r.timing)} · ${statusBadge(r)} · score <b>${scoreStr(r)}</b>
        ${num(r.score && r.score.noKey) ? " · " + num(r.score.noKey) + " keyless" : ""} · version ${esc(r.testVersion||"?")}</p>
      ${tombstoneNoteHtml(r)}
      ${canOpen ? '<p><button class="dash-rel" id="dashStudentView">Open student view →</button></p>' : ""}
      ${versionNote}
      ${(r.modules||[]).map(m => `<span class="dmod">${esc(m.section)} ${esc(m.moduleLabel)}: ${mmss(m.timeSpentSeconds)} (${esc(m.endedBy||"?")})</span>`).join(" ")}
      <div class="dash-qlist">${qRows || '<p class="dash-empty">No answers recorded.</p>'}</div>
      ${canDelete ? '<p><button class="dash-rel dash-danger" id="dashDeleteAttemptBtn" title="Marks this attempt deleted (asks you to type the student code back)">Delete this attempt…</button></p>' : ""}`;
    if(canOpen){
      const btn = $("dashStudentView");
      if(btn) btn.addEventListener("click", ()=>{
        $("dashDetail").classList.add("hidden");
        // sets replay in Review Mode (no Score Details surface for them)
        if(isSet){ if(window.AppSetReview) AppSetReview.open(r); }
        else if(window.AppScoreView) AppScoreView.open(r.testId, r);
      });
    }
    if(canDelete){
      const db = $("dashDeleteAttemptBtn");
      if(db) db.addEventListener("click", ()=> confirmDeleteAttempt(r));
    }
    $("dashDetail").classList.remove("hidden");
  }

  /* ---------- deletion = a tombstone (2026-09-18) ----------
     Two ACTIONS (deleteAttempt, deleteStudent — driven directly by
     tests/tutor-writes.test.js and tests/tombstone.test.js) behind two
     CONFIRMATION PANELS (confirmDeleteAttempt, confirmDeleteStudent) that
     name what will be marked and require the student code typed back.
     Neither action removes or edits a record: each writes marker rows
     through tutorTombstone (server first), and the record stays listed here
     marked "deleted". One attempt or one student per call — there is no
     bulk path, and none of this touches the archive-then-delete button. */

  /* Finished attempts only (isDeletableAttempt; the server refuses an
     in-progress record too). The assignment this attempt belonged to stays
     "Completed" on BOTH sides: here assignRowStatus still sees the record;
     on the student's device the tombstone's identity summary feeds
     buildAssignmentIndex, so completion still derives without the record
     (the persisted completedAttemptId hint is usually absent in remote mode
     — students can't write assignment rows — which is exactly why the stub
     exists). Takes the record itself, not an id. */
  async function deleteAttempt(r){
    if(!isDeletableAttempt(r)) return { ok: false, message: "Not deleted — this attempt can't be marked (not finished, already deleted, or the student was deleted)." };
    const who = nameFor(r.student && r.student.key) || (r.student && r.student.code) || "?";
    const res = await tutorTombstone("attempt", r.attemptId);
    if(!res.ok){
      $("dashStatus").textContent = res.message;
      return res;
    }
    openAttemptId = null;
    $("dashDetail").classList.add("hidden");
    /* in place: the marker is confirmed written, the record itself is
       unchanged and stays listed — a full reload would only clobber this
       status line with its own "Loading…" */
    res.rows.forEach(row => { tombs[row.key] = row.value; });
    renderAll();
    $("dashStatus").textContent = "Marked the attempt for " + who + " deleted — it is on no student surface now; the record is kept for audit." +
      (res.warning ? " " + res.warning : "");
    return res;
  }

  /* Retires ONE code: every attempt it owns is marked (in-progress included
     — the student can no longer sign in to resume it), then the student
     marker, which is what makes every student RPC refuse the code. The
     profile row, assignments and bug reports are left as they are (the code
     is shown "deleted" beside them). Attempts this browser holds that the
     server never had (a never-synced local-mode sitting) can't be marked by
     the server; they are counted and named, never silently left live. */
  async function deleteStudent(code){
    const c = StudentCode.normalize(code);
    if(!StudentCode.valid(c)) return { ok: false, message: "Not deleted — " + String(code) + " isn't a student code." };
    if(isDeletedStudent(c)) return { ok: false, message: "Not deleted — " + c + " was already deleted." };
    if(source !== "storage") return { ok: false, message: "Not deleted — deleting works against live storage, not a loaded archive file." };
    const who = nameFor(c) || c;
    const res = await tutorTombstone("student", c);
    if(!res.ok){
      $("dashStatus").textContent = res.message;
      return res;
    }
    const marked = {};
    res.rows.forEach(row => { tombs[row.key] = row.value; marked[row.key] = true; });
    const unmarked = recs.filter(r => r && r.student && r.student.key === c && !marked["tomb:" + r.attemptId]);
    openAttemptId = null;
    $("dashDetail").classList.add("hidden");
    const nAtt = res.rows.filter(row => row.key.indexOf("tomb:attempt:") === 0).length;
    const summary = "Deleted student " + who + (who !== c ? " (" + c + ")" : "") + " — the code is retired and can't sign in; " +
      nAtt + " attempt(s) marked deleted (records kept for audit)." +
      (unmarked.length ? " " + unmarked.length + " attempt(s) listed here were NOT marked on the server — it has no copy of them (never uploaded from the device that recorded them, or archived away); here they read deleted only by the student marker, and the server will refuse them if they ever arrive." : "") +
      (res.warning ? " " + res.warning : "");
    await loadFromStorage();
    $("dashStatus").textContent = summary + " " + $("dashStatus").textContent;
    return Object.assign({ unmarked: unmarked.map(r => r.attemptId) }, res);
  }

  /* The confirmation panel, in the detail overlay. Names exactly what will
     be marked, says what does NOT happen, and stays disabled until the
     student code is typed back (deleteGateOk, re-checked at the click). */
  function renderConfirmPanel(p){
    $("dashDetailBody").innerHTML = `
      <h2>${esc(p.title)}</h2>
      <div class="dtc-facts">${p.factsHtml}</div>
      <div class="dash-warn">${p.consequencesHtml}</div>
      <p class="dash-hint dtc-ask">Type the student code <b>${esc(p.code)}</b> to confirm. One ${esc(p.what)} at a time — there is no bulk delete.</p>
      <div class="dtc-actions">
        <input class="dtc-input" id="dtcInput" autocomplete="off" spellcheck="false" placeholder="AS-XXXXXXXX" aria-label="Type the student code to confirm">
        <button class="dash-rel dash-danger" id="dtcGo" disabled>${esc(p.goLabel)}</button>
        <button class="dash-rel" id="dtcCancel">Cancel</button>
      </div>
      <p class="dash-hint" id="dtcMsg"></p>`;
    const input = $("dtcInput"), go = $("dtcGo");
    input.addEventListener("input", () => { go.disabled = !deleteGateOk(input.value, p.code); });
    input.addEventListener("keydown", e => { if(e.key === "Enter" && !go.disabled) go.click(); });
    go.addEventListener("click", async () => {
      if(!deleteGateOk(input.value, p.code)) return;      // the gate, not the button state, decides
      go.disabled = true; input.disabled = true;
      $("dtcMsg").textContent = "Marking…";
      const res = await p.onGo();
      if(res && !res.ok){ $("dtcMsg").textContent = res.message || "Not deleted."; go.disabled = false; input.disabled = false; }
    });
    $("dtcCancel").addEventListener("click", () => { openAttemptId = null; $("dashDetail").classList.add("hidden"); });
    $("dashDetail").classList.remove("hidden");
    input.focus();
  }
  function confirmDeleteAttempt(r){
    if(!isDeletableAttempt(r)) return;
    const code = StudentCode.normalize(r.student && r.student.key);
    const name = nameFor(code);
    renderConfirmPanel({
      title: "Delete this attempt?",
      what: "attempt",
      code: code,
      goLabel: "Delete attempt",
      factsHtml:
        `<div><b>Student:</b> ${name ? esc(name) + " " : '<span class="dash-hint">(no display name)</span> '}<span class="dcode">${esc(code)}</span></div>` +
        `<div><b>Test:</b> ${esc(r.testName || r.testId)}${r.kind === "set" ? ' <span class="dstatus tm">set</span>' : ""}</div>` +
        `<div><b>Date:</b> ${fmtDate(r.startedAt)} · ${statusBadge(r)} · score <b>${scoreStr(r)}</b></div>`,
      consequencesHtml:
        "<b>What happens:</b> the attempt is <b>marked deleted</b> — a marker row with your identity and the time. " +
        "The student's device stops showing it (no Past card, no Score Details, no review); " +
        (r.assignmentId
          ? "their assignment for it stays <b>Completed</b>. "
          : "this attempt is not tied to an assignment, so if it was standing in for one, that assignment may become startable again. ") +
        "<b>What does not happen:</b> the record is not erased or edited (it stays here, marked, for audit), nothing else of theirs changes, and there is no un-delete.",
      onGo: () => deleteAttempt(r)
    });
  }
  function confirmDeleteStudent(code){
    const c = StudentCode.normalize(code);
    if(!StudentCode.valid(c) || isDeletedStudent(c) || source !== "storage") return;
    const name = nameFor(c);
    const mine = recs.filter(r => r && r.student && r.student.key === c);
    const done = mine.filter(r => r.status === "completed" || r.status === "timed-out").length;
    const live = mine.filter(r => r.status === "in-progress").length;
    const already = mine.filter(isTombstoned).length;
    const nAssign = ((assigns.find(a => a.code === c) || {}).list || []).length;
    renderConfirmPanel({
      title: "Delete this student?",
      what: "student",
      code: c,
      goLabel: "Delete student",
      factsHtml:
        `<div><b>Student:</b> ${name ? esc(name) + " " : '<span class="dash-hint">(no display name)</span> '}<span class="dcode">${esc(c)}</span></div>` +
        `<div><b>Attempts:</b> ${mine.length} on record — ${done} finished, ${live} in progress` + (already ? ", " + already + " already deleted" : "") + `</div>` +
        `<div><b>Assignments:</b> ${nAssign}</div>`,
      consequencesHtml:
        "<b>What happens:</b> the code <b>" + esc(c) + "</b> is <b>retired</b> — it can no longer sign in (typed, sign-in link, or a saved session) and will never be issued again; " +
        "every attempt above is <b>marked deleted</b>" + (live ? " (the in-progress one can no longer be resumed)" : "") + ". " +
        "<b>What does not happen:</b> no record is erased or edited (they stay here, marked, for audit), the display name row and assignments are left in place, and there is no un-delete.",
      onGo: () => deleteStudent(c)
    });
  }

  /* ---------- events ---------- */
  /* Dismiss = delete the bug row. Used to remove only the mirror, so the
     report came back on the next load. */
  async function dismissBug(key){
    const res = await tutorDelete(key);
    $("dashStatus").textContent = res.ok
      ? "Dismissed the bug report." + (res.warning ? " " + res.warning : "")
      : res.message;
    if(!res.ok) return;
    await loadAssignsAndBugs();
    render();
  }

  function attachBodyHandlers(){
    if(tab === "sets") attachSetsHandlers();
    if(tab === "bank") attachBankHandlers();
    document.querySelectorAll("#dashBody [data-att]").forEach(tr =>
      tr.addEventListener("click", () => openDetail(tr.dataset.att)));
    document.querySelectorAll("#dashBody .dash-rel[data-rel]").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();                    // don't open the row's detail view
        toggleRelease(btn.dataset.rel);
      }));
    const cb = $("afCreateBtn");
    if(cb) cb.addEventListener("click", createAssignment);
    /* canonical-id overlap block follows the chosen codes + test live */
    const afT = $("afTest"), afC = $("afCodes"), afF = $("afFree");
    if(afT) afT.addEventListener("change", refreshAssignOverlap);
    if(afC) afC.addEventListener("change", refreshAssignOverlap);
    if(afF) afF.addEventListener("input", refreshAssignOverlap);
    const gb = $("afGenBtn");
    if(gb) gb.addEventListener("click", appendGeneratedCode);
    document.querySelectorAll("#dashBody .copy-link").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();                   // don't open the row's detail view
        copySignInLink(btn.dataset.code);
      }));
    document.querySelectorAll("#dashBody .student-del").forEach(btn =>
      btn.addEventListener("click", e => {
        e.stopPropagation();
        confirmDeleteStudent(btn.dataset.code);
      }));
    const nb = $("afNameBtn");
    if(nb) nb.addEventListener("click", saveNameOnly);
    const rb = $("afResetBtn");
    if(rb) rb.addEventListener("click", () => clearAssignments($("afResetCode").value));
    document.querySelectorAll("#dashBody .assign-del").forEach(btn =>
      btn.addEventListener("click", () => deleteAssignment(btn.dataset.code, btn.dataset.aid)));
    document.querySelectorAll("#dashBody .bug-dismiss").forEach(btn =>
      btn.addEventListener("click", () => dismissBug(btn.dataset.bug)));
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
    /* the filters live outside #dashBody, so re-rendering keeps their own
       values; the forms INSIDE the body are DOM-only and the Sets hint sends
       the tutor to the Student filter mid-form — keep what they typed */
    $("dashFilterTest").addEventListener("change", renderKeepingInputs);
    $("dashFilterStudent").addEventListener("change", renderKeepingInputs);
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
    /* for app.js's review surfaces: never open a record the tutor deleted */
    isTombstoned: id => !!tombFor(id),
    open(showOnly){
      showOnlyFn = showOnly;
      wire();
      showOnly("screen-dashboard");
      loadFromStorage();
    }
  };
})();
