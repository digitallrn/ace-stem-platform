# Partial sittings — Stage 2 report

*Platform repo, 2026-11-02. Companion to PARTIAL-SITTINGS-STAGE1.md (the
reconnaissance) and the rulings that followed it. Committed locally; **not
pushed** — the push waits on the migration below and on David's word.*

---

## 1. What shipped

- **The record.** One optional top-level field, `scope: {modules: [slots in
  form order], selectedByStudent: true|false}`, stamped by `Attempts.begin`
  and never touched (ATTEMPTS-SPEC §2). Absent ⇒ a full sitting. A
  tutor-fixed full sitting omits it and is **byte-identical** to what the
  pre-change recorder wrote (pinned against 21b6855's attempts.js by the golden
  fixture). A student-chosen Full test is stamped with `selectedByStudent:true`
  — the choice is then itself the information, exactly as the timing flag.
- **The vocabulary.** Four slots `re1 re2 ma1 ma2`, resolved to a module by
  section and ordinal; the seven presets (full, rw, math, each single slot)
  are the only scopes. `build-site.js` fails the deploy on any form whose
  modules do not map onto the four in order with every question id under its
  slot (`AttemptScope.formProblems`, lifted from attempts.js with a self-check);
  an archived build with the problem is a warning naming it. All 33 current
  forms and 51 archived builds map.
- **The seam.** `window.AttemptScope` (attempts.js, beside `AssignmentRules`):
  `scopeOf` (untrusted input, a malformed scope reads as full), `testFor` (the
  form with `modules` filtered to the record's scope; the very object for a
  full scope), `label` / `scoreLabel` / `presetLabel` (closed tables),
  `openedSlots`, `formProblems`. `testFor` is called in exactly four places in
  app.js: the start path, resume (before the clamp), Score Details (before
  `buildScoreRows`) and `storedModuleRaw`. The sitting RUNS on the scoped copy,
  so the recorder has no scope branch: `modules[]`, `answers`, `score` and both
  blobs hold only the scoped modules; an out-of-scope module is **absent** from
  `answers`, an in-scope unreached one **blank**, as always.
- **The assignment row.** `scopePolicy: {mode:"fixed", modules} |
  {mode:"student-choice", allowed:[preset names]}` (absent ⇒ fixed full) and
  `rowVersion` (absent ⇒ 1; the dashboard stamps 2 on every row it writes),
  both read through `AssignmentRules` (`scopePolicyOf`, `rowVersionOf`,
  `rowTooNew`, `ROW_VERSION`, `RELOAD_LINE`). A client refuses to begin a row
  above its version: the card shows "Reload this page to start this
  assignment" with no Start, `startAssignment` and `startTestFlowLoaded` refuse
  as the second layer.
- **The pre-flight screen.** `#screen-timing` now holds one block per choice
  the tutor left open (timing, part of the test) and states the fixed one;
  Continue is live once every block shown holds a valid pick; the scope pick
  is read through a closed preset table (junk is "no pick", never Full);
  `state.pendingScope` has `pendingTiming`'s exact lifecycle (cleared at the
  same eleven sites plus the choice screen's own).
- **Scoring and the surfaces.** Full unchanged. A section ⇒ that section's
  **exact** scaled score from the same per-module table
  (`scaledScores(…, scope)` returns `{rw|math, total: null}`), "Section only",
  the total "—". A module ⇒ null, raw count and skills only, "Single module".
  Never a total from a part. The Score Details hero carries the words (the
  printed report is that DOM) and the scope badge beside the timing badge with
  "(student-selected)" on the literal true; Review Mode's strips, chips and
  navigation are the sat modules only; the Questions tabs drop the absent
  section; the Past card shows the section's number over "200–800 · Section
  only · total —" or the raw count with "Single module"; the Score Calculator
  never prefills from a partial record.
- **The dashboard.** The scope badge on every Attempts row, Students card
  (whose RW column already prints "—" for an absent section) and detail line; a
  Scope column on the Assignments table; a Part-of-the-test control on the
  assign form (default fixed full; student-choice ticks of presets);
  `createAssignment` writes `scopePolicy` and `rowVersion` on every row of the
  bulk plan and reads each back; the overlap block gains "<student> has sat
  <form>: RW Module 1 (completed 1 Oct 2026), …" per chosen student
  (`exposureHtml`, from `AttemptScope.openedSlots` over live records, agreeing
  with `assignRowStatus` when no live record is behind a Completed row).
- **The server.** `supabase/migrations/2026-11-02_one_release_per_assignment.sql`
  restates `fn_upsert_attempt` and adds one guard to the form auto-release
  branch: no other completed or timed-out attempt of this code may already
  name the assignmentId. The stamped-assignmentId binding was already there
  (Stage 1, 0.2). `scope` is never read server-side.

## 2. The open questions, decided

| Question | Decision | Reason |
|---|---|---|
| Record shape | Ruled: `scope: {modules, selectedByStudent}`, absent ⇒ full | — |
| A student picking **Full test** | Stamped (`selectedByStudent:true`); a tutor-fixed full sitting omits the field | The ruling says absent means full and asks for the mark where the student chose; "Full test (student-selected)" is the mark, and the golden proves fixed-full records are unchanged |
| Score Calculator prefill | Skips partial records | The calculator is a what-if over the whole form; a Math-only record would prefill RW at 0 and mark "your result" there |
| Exposure line's home | Inside the per-test block under the assign form's options, beside the canonical-id overlap, shown even while the index loads | It is already per selected test and per chosen student, and it is where the tutor looks before Create |
| Single-module home card | "RW Module 1 · 1 module" (no question count) | The manifest carries per-section counts only; the Ready screen, with the content loaded, gives the exact count |
| Exposure vs a deleted completed record | The line says "sat — modules unknown (no live record of it in storage: archived away, or deleted)" | The row reads Completed by the tombstone rule and "Select all not yet sat" counts it; two surfaces on one form must agree (review finding 5) |

## 3. Files changed

attempts.js (AttemptScope; scopePolicyOf, rowVersion readers; the begin stamp;
`currentScope`), app.js (start path, pre-flight screen, resume, crash-resume,
cards, Ready screen, scaledScores, storedModuleRaw, Score Details hero and
tabs, Past card, calculator prefill, badges), dashboard.js (badges, Scope
column and control, createAssignment, exposure line, kept inputs), index.html
(the screen's two blocks), styles.css, build-site.js (the slot gate),
ATTEMPTS-SPEC.md (§2, §10), CLAUDE.md (the batch note), the new migration, and
the tests below. `dist/index-live.html` rebuilt (not tracked).

## 4. Adversarial review — findings and fixes

Run with `/code-review xhigh --max-findings all` on the working-tree diff. Eight
findings; all eight fixed before the commit.

| # | Finding | Fix |
|---|---|---|
| 1 | **Confirmed, critical.** `AttemptScope.isScope` duck-typed a scope as `{kind: string, modules: array}` — every practice-set record has both — so `testFor(setTest, setRecord)` in `resumeTestFlowLoaded` emptied the synthetic set test and **set resume (Resume card and crash-resume) returned false**. The suite's own pass-through check used a stub without `modules[]` and could not see it. | `isScope` requires a preset name from the closed list and no record identity (`attemptId`/`answers`/`student`); a real set-shaped record resumes through the real `resumeTestFlowLoaded` in §5, with the loose detector as the red control; §1's stub replaced by a real set record. |
| 2 | `label`/`scoreLabel` on a set record returned "Single module · undefined" (same root; no caller today). | Same fix; pinned in §1. |
| 3 | Test gap behind finding 1. | §1 and §5 cases above. |
| 4 | `slotLabel` read `SLOT_SHORT[slot] \|\| ""` without an own-property check ("constructor" → a function). | `hasOwnProperty`; pinned. |
| 5 | The exposure line said "none of its modules yet" where the Assignments row read Completed (a deleted finished sitting) and the not-yet-sat button counted the test as sat. | The line reads the row's verdict through `assignRowStatus` and says "sat — modules unknown"; pinned with a deleted-record case. |
| 6 | `startTestFlowLoaded` interpreted the policies before the `rowTooNew` refusal. | The refusal is the function's first statement. |
| 7 | `scaledScores` returned a `kind` field nothing read. | Removed. |
| 8 | `showReady` cloned the whole live record (`peekRecord`) to read one field. | `Attempts.currentScope()`, a clone of the field alone. |

## 5. Pre-existing assertions changed — before and after

| File | Before | After |
|---|---|---|
| tests/assignment-options.test.js §3 | pins the newest `fn_upsert_attempt` migration as `2026-11-02_assignment_options.sql` | pins `2026-11-02_one_release_per_assignment.sql`; GUARDS gains the one-release `not exists` clause with its removal control; a control asserts the 2026-11-02 assignment-options text **lacks** the guard (the old binding's test goes red there); `decide()` models the guard with six new cases (second completed consumer refused; timed-out consumer refused; an in-progress consumer, another student's, the row's own key, a different assignment's each still release) |
| tests/assignment-options.test.js §6 | `/const badgeHtml = timingBadgeHtml\(record\)/` in `renderScoreDetails` and `renderPastCards` | `/const badgeHtml = \[scopeBadgeHtml\(record\), timingBadgeHtml\(record\)\]\.filter\(Boolean\)\.join\(" · "\)/` |
| tests/assignment-options.test.js §7 | `/<th>Timing<\/th><th>Release<\/th>/` | `/<th>Timing<\/th><th>Scope<\/th><th>Release<\/th>/` |
| tests/assignment-options.test.js §8 | the `tcOptions` change handler sets `disabled = pickedTimingChoice() === null` | both blocks' handlers set `disabled = !preflightPicksComplete()`, and that function checks each block shown |
| tests/assignment-options.test.js §4 harnesses | `startTestFlowLoaded` world and `openTimingChoice` world supply the globals of 21b6855 | they also supply `AttemptScope`, `renderHome`, `scopeChoiceNote`, `fixedTimingLine`, `fixedScopeLine`, and an `el` stub with `classList.toggle` (harness only; every assertion's text unchanged) |
| tests/tombstone.test.js | `RESTATED = {"2026-11-02_assignment_options.sql": ["fn_upsert_attempt"]}` | plus `"2026-11-02_one_release_per_assignment.sql": ["fn_upsert_attempt"]` — the restatement check re-applies every tombstone gate to the new file |
| tests/tombstone.test.js harnesses | dashboard factories receive `AssignmentRules` | also `AttemptScope`; `scopeBadgeHtml` extracted beside `timingBadgeHtml` (harness only) |
| tests/tutor-writes.test.js harness | factory receives `AssignmentRules` | also `AttemptScope` (dashboard.js reads it at load); `scopeBadgeHtml`, `assignScopeText`, `exposureHtml` in NAMES; §14 added |
| tests/canonical-index.test.js harness | factory without `AttemptScope`, `assigns` | loads the real `AttemptScope`, declares `assigns`, extracts `exposureHtml` and the `assignRowStatus` chain; one new check (a Math-only record exposes only its 44 Math refs) |
| tests/injection-proof.js | 121 surfaces | 126: a hostile `scope` on the planted record (reads as full), a Math-only planted record driven through its Past card → Score Details → print DOM, the Part-of-the-test block with hostile allowed entries |

No pre-existing assertion was weakened; the three harness changes supply the
new globals the dashboard reads at load.

## 6. The checks the rulings asked for

| Check | Where | Red control |
|---|---|---|
| Math-only record: exactly two modules, no RW answer, Math section score, total null | partial-sittings §3, the real recorder on the real 2026 June Asia v2 form | the stamp removed from attempts.js |
| Single-module record: no scaled score anywhere | §3 (`scaledScores` null), §6 (hero), §7 (card) | the seam / the scope dropped |
| Full-scope record identical in shape | §3: byte-compare against `tests/partial-sittings-golden.json`, emitted from 21b6855's attempts.js by the same driver | a fixed-full sitting under a scopePolicy row is identical too; a student-chosen full differs by `scope` alone |
| Crash-resume restores the stored scope | §5: the real `resumeTestFlowLoaded`; a Math-only checkpoint at index 1 reopens the second Math module; `crashResumeCandidate` refuses index 2 | the seam removed → RW Module 2; the scope check removed → index 3 accepted |
| Review Mode shows only the sat modules | §6: two strips, every row Math, `reviewStep` never leaves them | the seam removed → four strips, RW "omitted" |
| The printed report prints no total | §6 (the hero DOM: TOTAL "—", "Section only", no 400–1600); the browser proof's print audit on the dist | — |
| The SPR audit over every existing record | `node tests/spr-grading.test.js "<Downloads>/attempts-archive-2026-09-21 (3).json"`: 95 records, 591 SPR items, ALL PASS; §9 runs the audit over a synthesized export with a partial record (counted, and a wrong verdict in it caught) | — |
| A manual sitting after a completed auto row stays unreleased; the forged case | assignment-options §3 model + text pins; the control reds against the previous migration's text | — |
| The build gate on a doctored form | build-site-drift: modules out of section order (red), a question id under the wrong prefix (red), an archived plant (warning), a renamed `AttemptScope` (extraction), a rule that accepts everything (self-check) | — |
| The tutor write path | tutor-writes §14: fixed Math rows carry `scopePolicy {fixed,[ma1,ma2]}` + `rowVersion 2`, read back and verified; defaults fixed full; student-choice ticks; none ticked refused | — |

Suites, all green: partial-sittings 144, assignment-options 192, tombstone
265, tutor-writes 608, canonical-index 185, set-flow 49, set-release-rule 14,
test-viewer 219, image-choice 121, keep-classes 28, bank-isolation 36,
set-audit 3, build-site-drift 30, spr-grading 70 (full sweep), plus
attempts-recording, timer-drift, local-mode, assignment-delete. The browser
injection proof against `dist/index-live.html`: 126 surfaces, the payload never
fired, the one failure the known KaTeX-allowlist drift on 202608intv1 (pinned
in keep-classes.test.js). Not run: `tests/viewer-proof.js` (the viewer takes
no record and is untouched) and `tests/tombstone-live-proof.js` (anon against
the live project; the tombstone paths are untouched).

## 7. Deploy order and the one-click checks

1. **Apply `supabase/migrations/2026-11-02_one_release_per_assignment.sql`** in
   the SQL editor. Either order is safe — the guard is purely restrictive and
   the app does not depend on it — but migration first closes the forged case
   before any new row exists. Re-applying is harmless; it also re-applies the
   2026-09-21 and 2026-11-02 bodies it restates.
2. **Push.** Then reload every open student tab (below).
3. **Human checks** (the migration header has the full steps): **H** a fixed
   Math assignment sat end to end (card, Ready screen, no break, Past card,
   Score Details, print, dashboard badge, Students "—", the SQL row's scope);
   **I** student chooses both timing and part ("Before You Start", both
   blocks, Continue only after both picks, `selectedByStudent:true`, every
   badge marked); **J** the forged case from the SQL editor — a completed
   write naming a consumed auto row lands `released = false`.

**Old-tab exposure (stated).** `rowVersion` protects tabs loaded from this
deploy onward. A tab loaded **before** it knows nothing of the field and would
sit a scoped assignment as a full test — a content exposure, not just a
timing slip. Hold partial-scope assignments until every student has reloaded.

## 8. Limits stated

- Archive-then-delete removes the consuming record from the server; after
  that a forged id naming the auto row would release again. The guard can see
  only rows that exist.
- The practice-set release branch is unchanged (restated verbatim); it was
  outside the brief.
- Local and artifact mode have no server: the `finalize` mirror decides there.
- The dashboard Score sort compares percentages across scopes.
- A single-module record's Knowledge and Skills shows only that module's
  domains.
- A fixed single-module home card cannot show the question count without the
  content; the Ready screen does.
- The header keeps the form's own numbering ("Section 2, Module 1: Math" for
  a Math-only sitting).
- "Select all not yet sat" counts a test sat in any part; the exposure line is
  the finer view, and it reads the row's verdict where no live record exists.
