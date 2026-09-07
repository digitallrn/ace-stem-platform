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
      render();
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
     Index strings (refs, family names) are test-data-derived and set-record
     refs are record-derived: both are untrusted on the render surface and
     go through esc()/escAttr() at every innerHTML site (CLAUDE.md escaping
     contract). tests/canonical-index.test.js pins the derivation. */
  let dedup = null;              // normalized index, or null
  let dedupState = "idle";       // "idle" | "loading" | "ready" | "failed"
  let dedupNote = "";            // why it is not ready, for the notice
  let seenCache = {};            // code -> seen set; rebuilt every render
  const DEDUP_FETCH_TIMEOUT_MS = 20000;

  function ensureDedupLoaded(){
    if(dedupState !== "idle") return;
    // an inlined build (dist/) or an earlier fetch already registered it
    if(window.DEDUP_INDEX){ adoptDedup(window.DEDUP_INDEX); return; }
    dedupState = "loading";
    const s = document.createElement("script");
    let done = false;
    const finish = fn => { if(done) return; done = true; clearTimeout(timer); s.remove(); fn(); };
    const fail = why => { dedupState = "failed"; dedupNote = why; onDedupSettled(); };
    const timer = setTimeout(() => finish(() => fail("timed out")), DEDUP_FETCH_TIMEOUT_MS);
    s.src = "testdata/dedup-index.js";
    s.async = true;
    s.onload = () => finish(() => {
      if(!window.DEDUP_INDEX){ fail("the file loaded but registered nothing"); return; }
      adoptDedup(window.DEDUP_INDEX);
      onDedupSettled();
    });
    s.onerror = () => finish(() => fail("testdata/dedup-index.js could not be fetched"));
    document.head.appendChild(s);
  }
  function adoptDedup(raw){
    const n = normalizeDedupIndex(raw);
    if(n){ dedup = n; dedupState = "ready"; dedupNote = ""; }
    else { dedupState = "failed"; dedupNote = "the index is malformed"; }
  }
  /* After an async load or failure: the Assignments tab keeps its typed form
     (a full render would wipe the codes and name the tutor is entering) and
     refreshes only the overlap block; every other tab re-renders. */
  function onDedupSettled(){
    if(tab === "assign") refreshAssignOverlap(); else render();
  }
  /* Shape-defensive normalization: the index is a committed file, but the
     dashboard must not throw on a truncated or hand-edited one. Returns null
     when it is unusable. Class and family members keep the index's own
     order (shipped order), canonical first. */
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
    const listIds = (arr, key) => (Array.isArray(arr) ? arr : []).map(x => x && x[key]).filter(x => typeof x === "string");
    return { items: items, classes: classes, fams: fams, byContainer: byContainer,
             forms: listIds(refd.forms, "testId"), banks: listIds(refd.banks, "bankId") };
  }
  function splitRef(ref){
    const s = String(ref == null ? "" : ref), i = s.indexOf(":");
    return i === -1 ? { container: s, qid: "" } : { container: s.slice(0, i), qid: s.slice(i + 1) };
  }
  /* "2026 June Asia v2 re2-q15" for a form ref; "bank-david-core q0001" for
     a bank ref (the bankId is the identifier David knows). An unknown
     container prints its raw id. Test names come from the manifest. */
  function refText(ref){
    const p = splitRef(ref);
    const t = testsById[p.container];
    return (t ? t.testName : p.container) + (p.qid ? " " + p.qid : "");
  }
  /* The exact class and family around one ref, or null when the index is
     not ready or the ref is not in it. alsoIn = the other members of its
     exact class (same canonical id); reskins = family members OUTSIDE that
     class (skeleton siblings). */
  function canonInfo(ref){
    if(!dedup) return null;
    const it = dedup.items[ref];
    if(!it) return null;
    const cls = dedup.classes[it.canonical] || [ref];
    const fam = it.family ? (dedup.fams[it.family] || []) : [];
    return { canonical: it.canonical, family: it.family,
             alsoIn: cls.filter(x => x !== ref),
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
  function completedAttemptsOf(code){
    return recs.filter(r => r && r.student && r.student.key === code &&
      (r.status === "completed" || r.status === "timed-out"));
  }
  /* The refs an attempt exposed. A FORM sitting exposes the whole form (a
     completed sitting had every module open, whether or not each question
     was visited), enumerated from the index by the manifest-resolved testId
     — no record-derived key is needed. A SET sitting exposed exactly its
     frozen snapshot (setQuestions[].ref — record-derived, so used only as a
     lookup key and escaped wherever it is shown). */
  function attemptRefs(r){
    if(r.kind === "set"){
      const src = Array.isArray(r.setQuestions) ? r.setQuestions.map(x => x && x.ref) : Object.keys(r.answers || {});
      return src.filter(x => typeof x === "string");
    }
    const id = (testsById[r.testId] || {}).testId || String(r.testId || "");
    return (dedup && dedup.byContainer[id]) || [];
  }
  function attemptLabel(r){
    const t = r.kind === "set" ? null : testsById[r.testId];
    return { attemptId: String(r.attemptId || ""),
             name: String((t ? t.testName : (r.kind === "set" ? (r.setName || r.testName) : (r.testName || r.testId))) || "?"),
             when: r.submittedAt || r.lastSavedAt || r.startedAt || null,
             status: String(r.status || "") };
  }
  function seenSetFor(code){
    if(!dedup || !code) return null;
    if(seenCache[code]) return seenCache[code];
    const seen = { canon: Object.create(null), fam: Object.create(null), attempts: 0, unindexed: 0 };
    completedAttemptsOf(code).forEach(r => {
      seen.attempts++;
      const lbl = attemptLabel(r);
      attemptRefs(r).forEach(ref => {
        const it = dedup.items[ref];
        if(!it){ seen.unindexed++; return; }
        const via = { attemptId: lbl.attemptId, name: lbl.name, when: lbl.when, status: lbl.status, ref: ref };
        (seen.canon[it.canonical] = seen.canon[it.canonical] || []).push(via);
        if(it.family) (seen.fam[it.family] = seen.fam[it.family] || []).push(via);
      });
    });
    return (seenCache[code] = seen);
  }
  /* seen: this canonical item was in a completed attempt (the same question,
     or an exact duplicate on another form or in a set). reskin: none of its
     exact class was, but a family sibling (skeleton reskin) was. unseen:
     neither. unindexed: the ref is not in the index (an index older than
     the library) — reported as such, never silently counted as unseen. */
  function markFor(ref, seen){
    if(!dedup || !seen) return null;
    const it = dedup.items[ref];
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
  const MARK_LABEL = { seen: "seen", reskin: "reskin seen", unseen: "unseen", unindexed: "not indexed" };
  const MARK_CLASS = { seen: "seen", reskin: "reskin", unseen: "unseen", unindexed: "unidx" };
  function viaText(v, mark){
    return (mark === "reskin" ? "reskin in " : "in ") + v.name + " (" + splitRef(v.ref).qid + ", " + v.status + " " + fmtDay(v.when) + ")";
  }
  function markHtml(m){
    if(!m) return "";
    const title = m.via.length ? m.via.map(v => viaText(v, m.mark)).join("; ")
      : (m.mark === "unindexed" ? "Not in the canonical-id index — regenerate it after the next export" : "");
    const first = m.via.length
      ? ' <span class="canon-via">' + esc(viaText(m.via[0], m.mark)) + (m.via.length > 1 ? " +" + (m.via.length - 1) : "") + "</span>" : "";
    return ` <span class="canon-mark ${MARK_CLASS[m.mark]}" title="${escAttr(title)}">${MARK_LABEL[m.mark]}</span>${first}`;
  }
  /* Marks are for the student chosen in the dashboard's Student filter. */
  function selectedStudent(){ const el = $("dashFilterStudent"); return el ? el.value : ""; }
  function setRefKeys(s){
    return (Array.isArray(s.refs) ? s.refs : []).filter(r => r && typeof r === "object").map(refKey);
  }
  /* The one visible notice per tab when marks are off. Ready: nothing —
     unless the index predates a test or bank the manifests list. */
  function dedupNoticeHtml(){
    if(dedupState === "ready"){
      const missing = (window.TEST_MANIFEST || []).filter(t => t && dedup.forms.indexOf(t.testId) === -1).map(t => t.testName)
        .concat((window.BANK_MANIFEST || []).filter(b => b && dedup.banks.indexOf(b.bankId) === -1).map(b => b.bankId));
      return missing.length
        ? '<p class="canon-notice warn">The canonical-id index predates ' + esc(missing.join(", ")) +
          ' — those questions show as “not indexed”. Regenerate it in the test-bank repo (dedup_gate.py --library --emit-platform) and redeploy.</p>'
        : "";
    }
    if(dedupState === "failed")
      return '<p class="canon-notice warn"><b>Canonical-id index unavailable</b> (' + esc(dedupNote) +
        ') — duplicate provenance and seen/unseen marks are off. Regenerate it in the test-bank repo (dedup_gate.py --library --emit-platform) and redeploy.</p>';
    return '<p class="canon-notice loading">Loading the canonical-id index…</p>';
  }

  /* ---- full-test assignment warning: how much of a form the student has
     already seen, by canonical id and family, and from which attempts ---- */
  function overlapFor(code, testId){
    const seen = seenSetFor(code);
    if(!seen) return null;
    const id = (testsById[testId] || {}).testId || String(testId || "");
    const refs = dedup.byContainer[id] || [];
    const o = { total: refs.length, attempts: seen.attempts, seenItems: [], reskinItems: [], unindexed: 0, sources: [] };
    const byAtt = Object.create(null);
    refs.forEach(ref => {
      const m = markFor(ref, seen);
      if(m.mark === "unindexed"){ o.unindexed++; return; }
      if(m.mark !== "seen" && m.mark !== "reskin") return;
      (m.mark === "seen" ? o.seenItems : o.reskinItems).push({ ref: ref, via: m.via });
      m.via.forEach(v => {
        const a = byAtt[v.attemptId] = byAtt[v.attemptId] ||
          { attemptId: v.attemptId, name: v.name, when: v.when, status: v.status, seen: 0, reskin: 0, refs: Object.create(null) };
        if(a.refs[ref]) return;              // count each form item once per source attempt
        a.refs[ref] = true;
        a[m.mark]++;
      });
    });
    o.sources = Object.keys(byAtt).map(k => byAtt[k])
      .sort((a, b) => String(a.when || "").localeCompare(String(b.when || "")));
    return o;
  }
  function assignOverlapHtml(codes, testId){
    ensureDedupLoaded();
    if(dedupState !== "ready") return dedupNoticeHtml();
    const t = testsById[testId];
    const tname = t ? t.testName : String(testId || "");
    const stale = dedupNoticeHtml();
    if(!codes.length || !testId)
      return stale + '<p class="dash-hint">Pick student codes to see how much of ' + esc(tname) +
        ' each has already seen (by canonical id) in their completed attempts.</p>';
    return stale + codes.map(code => {
      const o = overlapFor(code, testId);
      if(!o) return "";
      if(!o.attempts)
        return `<div class="canon-overlap none">${studentCell(code)} — no completed attempts yet, so nothing of ${esc(tname)} has been seen.</div>`;
      const n = o.seenItems.length + o.reskinItems.length;
      if(!n)
        return `<div class="canon-overlap none">${studentCell(code)} — none of ${esc(tname)}’s ${o.total} items appear in their ${o.attempts} completed attempt${o.attempts === 1 ? "" : "s"}.${
          o.unindexed ? " (" + o.unindexed + " not indexed.)" : ""}</div>`;
      const src = o.sources.map(a =>
        `<li>${esc(a.name)} · ${esc(a.status)} ${fmtDay(a.when)} — ${a.seen} identical, ${a.reskin} reskin</li>`).join("");
      const items = o.seenItems.map(x => `<li>${esc(splitRef(x.ref).qid)} = ${esc(refText(x.via[0].ref))}</li>`).join("") +
                    o.reskinItems.map(x => `<li>${esc(splitRef(x.ref).qid)} ~ reskin of ${esc(refText(x.via[0].ref))}</li>`).join("");
      return `<div class="canon-overlap warn">
        <b>${studentCell(code)} has already seen ${n} of ${esc(tname)}’s ${o.total} items</b> —
        ${o.seenItems.length} identical (same canonical id) and ${o.reskinItems.length} reskin${o.reskinItems.length === 1 ? "" : "s"}, from:
        <ul>${src}</ul>
        <details><summary>Which items</summary><ul class="canon-items">${items}</ul></details>
        <span class="dash-hint">For information only — nothing is excluded automatically; assign as usual.</span>${
          o.unindexed ? ' <span class="dash-hint">' + o.unindexed + " of the form’s questions are not in the index.</span>" : ""}
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
  /* Re-render ONLY the overlap block from the form's current codes + test
     (the form itself is never rebuilt here, so nothing typed is lost). */
  function refreshAssignOverlap(){
    const box = $("afOverlap"), sel = $("afCodes"), free = $("afFree"), t = $("afTest");
    if(!box || !sel || !free || !t) return;
    seenCache = {};
    const typed = free.value.split(/[\s,;]+/).map(s => StudentCode.normalize(s)).filter(c => c && StudentCode.valid(c));
    const codes = Array.from(new Set(Array.from(sel.selectedOptions).map(o => o.value).concat(typed)));
    box.innerHTML = assignOverlapHtml(codes, t.value);
  }
  /* Is a member of this ref's exact class already in the builder? Form
     questions only — bank rows are unaffected by the grouping. Returns the
     key of the member the set holds, or null. */
  function classInBuilder(k){
    const it = dedup && builder && dedup.items[k];
    if(!it) return null;
    const hit = builder.refs.find(r => { const o = dedup.items[refKey(r)]; return o && o.canonical === it.canonical; });
    return hit ? refKey(hit) : null;
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
  /* Plain-text name+code for a <select><option> — option text can't carry
     studentCell()'s <b>/<span> markup, so this is the same join flattened to
     one string. Falls back to the bare code when there's no profile row. */
  function codeOptionLabel(code){
    const c = String(code || "?");
    const n = nameFor(c);
    return n ? n + " (" + c + ")" : c;
  }
  /* Delete is finished-attempts only — never in-progress. That is what
     guarantees it's never offered mid-sitting (a live sitting is always
     "in-progress" until the student submits), and it's also what keeps a
     resumable record from ever being deleted out from under a student who
     could still resume into it. One rule, shared by the button's own gate
     (openDetail) and deleteAttempt's belt-and-braces recheck, so the two
     can never drift apart. */
  function isDeletableAttempt(r){
    return source === "storage" && !!r && (r.status === "completed" || r.status === "timed-out");
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
    assigns = []; bugs = []; profiles = {};
    await loadSets();
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
      /* Arm the delete for FINISHED attempts only. The archive file holds
         every record, including in-progress sittings, but a live sitting's
         checkpoint is not something an archive can stand in for — deleting
         it would leave a partial snapshot as the only copy (and a sitting
         that finishes between this download and the click would be lost
         outright, since finalize's upload has already drained). Those rows
         stay; the status says how many. */
      const deletable = recs.filter(isDeletableAttempt).map(r => r.attemptId);
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
      if(!isDeletableAttempt(cur)){ skipped++; skippedIds.push(id); continue; }
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
    seenCache = {};                          // recs may have changed since the last render
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
        <tr data-att="${escAttr(r.attemptId)}">
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
    const use = rows.filter(r => r.answers && Object.keys(r.answers).length);
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
    const { codes, bad } = formCodes();
    if(bad.length){ $("afMsg").textContent = "These codes don't look right: " + bad.join(", "); return; }
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
    const { codes, bad } = formCodes();
    if(bad.length){ $("afMsg").textContent = "These codes don't look right: " + bad.join(", "); return; }
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
        try{ await AttemptStore.adminUpsert(k, owner, v); sent++; }
        catch(e){ failed++; }
      }
    }
    $("dashStatus").textContent =
      "Upload finished — " + sent + " sent, " + skipped + " already on the server" +
      (failed ? ", " + failed + " failed" : "") + ".";
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
      ? `<p class="dash-hint">Seen / reskin seen / unseen marks are for ${studentCell(student)} (the Student filter above), from ${seen ? seen.attempts : 0} completed attempt${seen && seen.attempts === 1 ? "" : "s"}.</p>`
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

    const inSet = {};
    refs.forEach(r => { inSet[refKey(r)] = true; });
    /* Grouping by canonical id (form questions only — bank rows are
       unaffected): the set holds ONE entry per canonical item, so a form
       question whose exact duplicate (same canonical id, on this or another
       form) is already in the set reads "In set as <that ref>" and cannot
       be added again. */
    const heldAs = k => inSet[k] ? k : classInBuilder(k);

    /* bank picker: subject-matched, active first, retired flagged */
    const bankEntries = (window.BANK_INDEX && BANK_INDEX.entries || [])
      .filter(e => e.subject === builder.subject);
    const bankPickHtml = bankEntries.length ? bankEntries.map(e => `
      <div class="setpick-row${e.retired ? " is-retired" : ""}">
        <span class="setpick-main"><b>${esc(e.ref)}</b> ${bankStatusBadge(e)}
          <span class="dcode">${esc(e.skill || "")}</span>${mark(e.bankId + ":" + e.qid)}
          <span class="bank-stem">${esc(e.stemPreview || "")}</span></span>
        <button class="dash-rel pick-bank" data-bank="${escAttr(e.bankId)}" data-qid="${escAttr(e.qid)}"
          ${inSet[e.bankId + ":" + e.qid] ? "disabled" : ""}>${inSet[e.bankId + ":" + e.qid] ? "Added" : "Add"}</button>
      </div>`).join("")
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
          const allIn = m.questions.every(q => !!heldAs(builderTestId + ":" + q.id));
          return `<div class="setpick-mod">
            <div class="setpick-modhead"><b>${esc(m.section)} · ${esc(m.moduleLabel)}</b>
              <button class="dash-rel pick-module" data-mod="${escAttr(m.moduleId)}" ${allIn ? "disabled" : ""}>
                ${allIn ? "All added" : "Add whole module"}</button></div>` +
            m.questions.map((q, qi) => {
              const k = builderTestId + ":" + q.id;
              const held = heldAs(k);
              const btn = held === k ? "Added" : held ? "In set as " + refText(held) : "Add";
              return `
              <div class="setpick-row${held && held !== k ? " is-held" : ""}">
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
    )).sort();
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
    if(!builder) return;
    const k = refKey(ref);
    if(builder.refs.some(r => refKey(r) === k)) return;   // no duplicates
    if(ref.type === "form" && classInBuilder(k)) return; // one entry per canonical item (form questions)
    builder.refs.push(ref);
    render();
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
          m.questions.forEach(q => {
            const k = builderTestId + ":" + q.id;
            if(builder.refs.some(r => refKey(r) === k)) return;
            if(classInBuilder(k)) return;        // its exact duplicate is already in the set
            builder.refs.push({ type: "form", testId: builderTestId, moduleId: m.moduleId, qid: q.id });
          });
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
    const canOpen = isSet
      ? (source === "storage" && !!window.AppSetReview)
      : (source === "storage" && test && window.AppTestLoader &&
         AppTestLoader.canServe(test, r.testVersion));
    const canDelete = isDeletableAttempt(r);
    $("dashDetailBody").innerHTML = `
      <h2>${studentCell(r.student && r.student.code)} — ${esc(r.testName || r.testId)}</h2>
      <p class="dash-hint">${fmtDate(r.startedAt)} · ${esc(r.conditions||"unknown")}${timingBadgeHtml(r.timing)} · ${statusBadge(r)} · score <b>${scoreStr(r)}</b>
        ${num(r.score && r.score.noKey) ? " · " + num(r.score.noKey) + " keyless" : ""} · version ${esc(r.testVersion||"?")}</p>
      ${canOpen ? '<p><button class="dash-rel" id="dashStudentView">Open student view →</button></p>' : ""}
      ${versionNote}
      ${(r.modules||[]).map(m => `<span class="dmod">${esc(m.section)} ${esc(m.moduleLabel)}: ${mmss(m.timeSpentSeconds)} (${esc(m.endedBy||"?")})</span>`).join(" ")}
      <div class="dash-qlist">${qRows || '<p class="dash-empty">No answers recorded.</p>'}</div>
      ${canDelete ? '<p><button class="dash-rel dash-danger" id="dashDeleteAttemptBtn">Delete this attempt</button></p>' : ""}`;
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
      if(db) db.addEventListener("click", ()=> deleteAttempt(r));
    }
    $("dashDetail").classList.remove("hidden");
  }

  /* Tutor-only, finished attempts only (isDeletableAttempt — never offered
     while a status is "in-progress", so this never touches a live sitting).
     The assignment this attempt belonged to stays "Completed": assignRowStatus
     and the student-side assignmentComplete() both OR the derived-from-records
     signal with the persisted completedAttemptId hint written on the
     assignment row itself at finalize, and deleting an attempt record never
     touches that row. Losing the record therefore drops it from history
     without reopening its assignment for a retake.
     Takes the record itself, not an id — the only caller (openDetail's click
     handler) already has it, and re-deriving it via recs.find() a second time
     was pure waste. */
  async function deleteAttempt(r){
    if(!isDeletableAttempt(r)) return;   // belt and braces
    const who = nameFor(r.student && r.student.key) || (r.student && r.student.code) || "?";
    const msg = "Delete this attempt?\n\n" +
      "Student: " + who + "\nTest: " + (r.testName || r.testId) + "\nDate: " + fmtDate(r.startedAt) +
      "\n\nThis permanently removes the attempt record. Its assignment (if any) stays marked " +
      "Completed — deleting the record does not reopen it for a retake.";
    if(!window.confirm(msg)) return;
    /* Server first (tutorDelete): a failed delete has no sync-queue retry
       behind it, so the mirror must not drop the row until the server has —
       otherwise the record would be gone here but still on the server, and
       the next pullAllForTutor() would silently resurrect it. */
    const res = await tutorDelete(r.attemptId);
    if(!res.ok){
      $("dashStatus").textContent = res.message;
      return;
    }
    openAttemptId = null;
    $("dashDetail").classList.add("hidden");
    /* the archive button, if armed, no longer covers this row */
    if(lastExport){
      const rest = lastExport.ids.filter(id => id !== r.attemptId);
      lastExport = rest.length ? { ids: rest, when: lastExport.when } : null;
      $("dashDeleteBtn").disabled = !lastExport;
    }
    // update in place rather than a full loadFromStorage(): the row is
    // already confirmed gone from storage above, nothing else changed, and a
    // full reload (pullAllForTutor + a get() per attempt key in remote mode)
    // would both be pure waste and clobber this very status line with its
    // own "Loading…" text before the tutor ever sees it
    recs = recs.filter(x => x.attemptId !== r.attemptId);
    renderAll();
    $("dashStatus").textContent = "Deleted the attempt for " + who + "." + (res.warning ? " " + res.warning : "");
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
