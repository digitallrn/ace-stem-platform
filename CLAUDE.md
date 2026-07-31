# Mission brief: Ace STEM Bluebook Simulator — the PLATFORM repo
*Read automatically at the start of every Claude Code session in this folder.*

## Read first
`SCHEMA-v1.2.md` — the data contract. It's authoritative over instinct,
including for anything below.

## What this repo is
The reusable Bluebook-style SAT simulator (the "platform" track — see
`EMULATOR-HANDOFF.md` if present for the fuller history; the file keeps
its historical name). Split into files
for real editing/version control:

```
index.html    — dev shell: markup + KaTeX CDN tags + local <script>/<link>
styles.css    — all app styling (incl. tutor-dashboard section at the end)
render.js     — fmt() token/LaTeX renderer (schema §2)
grading.js    — answerMatches, toFraction, hasKey, sprValueMatches
attempts.js   — AttemptStore (shared-storage adapter, ?devstorage=1 local
                shim) + Attempts (recording per ATTEMPTS-SPEC.md)
app.js        — state machine, screens, event handlers, results
dashboard.js  — tutor dashboard (hidden admin sign-in acestem-admin)
test-data.js  — window.TEST_DATA = [tests...] — generated from the
                test-bank repo's validated JSON; carries testVersion
                (frozen once students take a test — ATTEMPTS-SPEC §9)
assemble.py   — inlines the local files above into dist/index-live.html,
                the single-file preview used in the claude.ai panel
tsv_to_bluebook_json.py — the extraction→JSON converter
```

Load order matters: `test-data.js`, `render.js`, `grading.js`,
`attempts.js`, `app.js`, `dashboard.js` — plain (non-module) scripts, so
top-level declarations are globals used across files. Don't wrap
`render.js`/`grading.js` in IIFEs, and don't redefine `escapeHtml`,
`fmt`, `answerMatches`, etc. inside `app.js`.

## Absolutely do not touch
`sat-2026-june-asia-v1.html` and anything about its publish state — that's
the frozen fork, self-contained, published as its own claude.ai artifact
in a separate original chat with live student attempt data. This repo has
no relationship to it and should never generate or overwrite it.
`assemble.py` builds `dist/index-live.html` only — a preview file, not
that fork.

## Workflow
1. Edit the split files directly.
2. `python3 assemble.py` to produce `dist/index-live.html` whenever you
   want to preview in the claude.ai panel or hand David a single file.
3. Commit dev files; `dist/` can be gitignored (it's a build output) or
   committed for convenience — David's call, either is fine at this scale.
4. No test runner is wired up yet. Until then: syntax-check every JS file
   before committing (`node --check <file>`), and if you touch `render.js`
   or `grading.js`, sanity-check `fmt()` and `answerMatches()` behavior
   with a throwaway Node snippet before moving on — these two files are the
   part of the app with the least margin for silent breakage, since a bad
   regex or an off-by-one in the tokenizer fails quietly (wrong rendering)
   rather than loudly (a thrown error).

## Known limitations (accepted for launch)
- **Concurrent `assign:<CODE>` writes can clobber.** Each student's
  assignments live in ONE storage key holding an array, mutated by
  unguarded read-modify-write from two sides: the tutor dashboard
  (create/delete) and the student app (`Attempts.completeAssignment` on
  finalize). Storage is last-write-wins, so a tutor editing assignments
  at the same moment a student finishes can silently drop one write.
  Reads are already hardened against the more dangerous failure
  (a *failed* read no longer overwrites with `[]` — see
  `AttemptStore.getResult`); this remaining item is the concurrent-
  *success* race, whose window is small at tutoring scale.
  **Queued post-launch fix:** move to per-assignment keys
  (`assign:<CODE>:<assignmentId>`), enumerated with `storage.list`, the
  same one-key-per-record pattern ATTEMPTS-SPEC §1 chose for attempts to
  avoid exactly this clobber. Accepted as-is for launch 2026-07-31.

## Known open items
- ✅ 2026-07-23: Attempt recording + tutor dashboard implemented per
  ATTEMPTS-SPEC.md (students sign in with a CODE, records are
  pseudonymous; dashboard has export + archive-then-delete). Read that
  spec before touching attempts.js/dashboard.js.
- David wants changes to the Results page; scope not yet defined — ask
  before restructuring `renderResults()` in `app.js` beyond small tweaks,
  since the tutor dashboard and future score-report generation both read
  the same results data.
- `test-data.js` holds "2026 June Asia v1" (97 questions, converted from
  the frozen fork; m2-q11 pending key adjudication in the test-bank
  repo). Regenerate from the test-bank repo's JSON — never hand-edit —
  and bump `testVersion` on any content change after students have
  taken it (ATTEMPTS-SPEC §9).
