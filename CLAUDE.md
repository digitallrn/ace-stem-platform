# Mission brief: Ace STEM Bluebook Emulator — the PLATFORM repo
*Read automatically at the start of every Claude Code session in this folder.*

## Read first
`SCHEMA-v1.1.md` — the data contract. It's authoritative over instinct,
including for anything below.

## What this repo is
The reusable Bluebook-style SAT emulator (the "platform" track — see
`EMULATOR-HANDOFF.md` if present for the fuller history). Split into files
for real editing/version control:

```
index.html    — dev shell: markup + KaTeX CDN tags + local <script>/<link>
styles.css    — all app styling
render.js     — fmt() token/LaTeX renderer (schema v1.1 §2)
grading.js    — answerMatches, toFraction, hasKey, sprValueMatches
app.js        — state machine, screens, event handlers, results
test-data.js  — window.TEST_DATA = [tests...] — David's actual test bank
assemble.py   — inlines the local files above into dist/index-live.html,
                the single-file preview used in the claude.ai panel
tsv_to_bluebook_json.py — the extraction→JSON converter (schema v1.1)
```

Load order matters: `test-data.js`, then `render.js`, then `grading.js`,
then `app.js` — the last three are plain (non-module) scripts, so
top-level function declarations in `render.js`/`grading.js` are globals
`app.js` calls directly. Don't wrap them in their own IIFEs, and don't
redefine `escapeHtml`, `fmt`, `answerMatches`, etc. inside `app.js`.

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

## Known open items (from EMULATOR-HANDOFF.md, still true)
- Attempt recording (`persistAttempt` → shared storage `attempt:*` keys) +
  Download Results JSON fallback — not yet backported from the fork.
- Tutor dashboard (attempt list, per-student wrong answers, item analysis,
  hardest-first) behind a hidden admin sign-in name — not yet backported.
- David wants changes to the Results page; scope not yet defined — ask
  before restructuring `renderResults()` in `app.js` beyond small tweaks,
  since the tutor dashboard and future score-report generation both read
  the same results data.
- `test-data.js` currently holds "2024 March C" (40 questions, pre-v1.1
  plain text). It'll be superseded once the extraction pipeline's pilot
  (see the test-bank repo) produces a v1.1 JSON with real math/tokens —
  that's the first real test of `render.js` against real content.
