# BLUEBOOK-PARITY.md — UI parity work from real Bluebook screenshots

*Drop this in the `ace-stem-platform` repo root. Source: David ran the real
College Board Bluebook app (build VSN-0.9.688, July 2026) and screenshotted
it. Put those screenshots in `reference/bluebook-screenshots/` in this repo —
numbered 01–14 in the order referenced below — and LOOK AT THEM while
implementing. This file tells you what each shows and what to build; the
pixels (colors, spacing, iconography) come from the images, not from prose.*

Content fixes (LaTeX pass, m2-q11) are tracked in the test-bank repo — not
part of this spec.

Implement phase by phase, **stopping after each phase for David's review**.

---

## Phase A — quick parity fixes

**A1. Eliminate strikethrough spans the full choice row.** (Screenshot 10.)
When a choice is eliminated in real Bluebook, the horizontal line runs edge
to edge across the entire choice container — through the letter badge circle
and the full box width — not just through the answer text. The small
letter-eliminate icon on that row is replaced by an "Undo" text link at the
right. We already have eliminate + Undo; the delta is the line's extent.
Match the screenshot.

**A2. Verify the underline/highlight menu matches.** (Screenshots 6–9.)
Selection toolbar: three color swatches (yellow, blue, pink), an underline
dropdown, trash, and a note button. The underline dropdown offers three
underline styles (solid, dashed, dotted — confirm against screenshot 8) plus
"None". Applying a style renders highlight + underline together on the
selected span (screenshot 9). The handoff says we built 3 colors + underline
styles already — this item is *verify against the screenshots and fix
divergences*, not build from scratch.

## Phase B — sticky notes (previously deferred; now requested)

(Screenshots 6, 13, 14.) The rightmost toolbar button on a text selection
creates a **note** attached to that highlighted span:

- The noted span's highlight renders in a stronger, fully saturated yellow
  than an ordinary highlight (screenshot 13 shows both in one passage).
- A notes rail appears between the passage pane and the question pane. Each
  note card shows: the highlighted snippet as its truncated title, a trash
  icon to delete the note, and an editable body with placeholder text
  "Notes are saved automatically" (auto-save on input, no save button).
- The rail collapses/expands via a chevron at its bottom edge (screenshot 13
  open with ">" chevron; screenshot 14 collapsed to a thin rail with "<").
- Notes persist per question alongside the existing highlight persistence,
  and must survive Back/Next navigation exactly as highlights do.
- Scope: Reading & Writing modules only — Math headers don't have
  Highlights & Notes in real Bluebook, and ours already match that.
- Deleting a note removes the note but should downgrade the span back to a
  normal highlight, not strip the highlight entirely (verify against real
  app behavior if David can; otherwise this is the sensible default).

## Phase C — Save and Exit + Resume

(Screenshots 3 and 12.) Real Bluebook's More (⋮) menu has **Save and Exit**;
an exited practice test shows on the home screen as an in-progress card with
a **Resume** button.

- Add the More menu (see Phase E for its other items). "Save and Exit":
  flush the attempt record immediately, then return to the home screen.
- Extend the attempt record with a `resume` blob:
  `{ moduleIndex, questionIndex, timeRemainingSeconds, annotations }` where
  `annotations` serializes per-question highlights + notes (currently these
  live only in in-memory moduleState — they must be persisted for resume to
  restore them).
- Timer pauses while exited (practice-mode behavior); resume restores the
  exact remaining time, module, question, answers, flags, eliminations,
  highlights, and notes.
- On sign-in, an in-progress attempt for this code + test surfaces as the
  Resume card (Phase D) rather than starting a fresh attempt. Starting fresh
  anyway is a tutor-dashboard action, not a student one.
- **Deliberate deviation:** real Bluebook shows a trash icon on in-progress
  and past practice cards (screenshots 2, 3) letting the student delete
  them. We do NOT give students delete. Attempts are records; deletion
  happens only in the tutor dashboard. Omit the trash icon entirely.
- Recorder interaction: `status` stays "in-progress" for saved-and-exited
  attempts; the dashboard already displays that correctly.

## Phase D — home screen restructure

(Screenshots 1–5.) Real Bluebook's home has two sections; ours needs only
one of them.

- **Skip "Your Tests" entirely** (screenshot 1) — that's real
  administrations (submitted answers, score release dates). Not applicable.
- Build the **Practice** section (screenshots 2, 3) with an
  **Active | Past** toggle:
  - *Active:* cards for each test available to this student code, plus any
    in-progress attempt as a Resume card (Phase C). Card: test name, status,
    primary action (Start / Resume).
  - *Past:* one card per completed attempt — test name, "✓ Completed", and
    **View My Responses**: a read-only, student-facing review of their own
    attempt (reuse the results-screen renderer, loading the stored attempt
    for this code). Which content it shows depends on the score-visibility
    decision below.
- **Skip the Test Type dropdown flow** (screenshots 4, 5) — real Bluebook
  asks SAT vs PSAT then a practice-test picker. We have one test type and
  code-based sign-in; go straight from sign-in to the Active list.
- **Assignment model:** which tests a code sees comes from an assignment
  map in storage (`assign:<code>` → [testIds]). **Default when absent: all
  published tests.** That makes it zero-config today (one test exists) and
  gives the tutor per-student control later without schema changes. A
  dashboard UI for editing assignments can wait until a second test exists.
- Keep Ace STEM branding — this is UI-behavior parity, not logo cloning.

### Open decision (David) — score visibility at submit
Currently: student submits → sees the full results dashboard immediately.
Real Bluebook (screenshot 1) defers real-test scores ("answers submitted,
see score release dates"), while practice shows responses. Options:
  (a) keep instant full results;
  (b) submit → confirmation only; results appear in "Past → View My
      Responses" only after the tutor releases them (a per-attempt flag
      set from the dashboard).
Implement whichever David picks; (b) adds a small `released` flag to the
attempt record and a release toggle in the dashboard.

## Phase E — More menu completion

(Screenshot 12.) Real menu: Help, Shortcuts, Assistive Technology,
Line Reader, Save and Exit.

- **Save and Exit** — Phase C.
- **Line Reader** — implement: a draggable horizontal reading mask that
  dims all but a band of text (College Board's focus tool). Keyboard: drag
  by mouse; Esc or re-click to dismiss.
- **Help** — optional small modal; fine to omit for now.
- **Shortcuts / Assistive Technology** — omit for now. Hide menu items that
  aren't implemented rather than shipping dead entries.

## Deliberate deviations (documented so they're decisions, not oversights)

1. No student-facing deletion of attempts (trash icons omitted).
2. No Test Type / practice-picker dropdowns — code sign-in replaces them.
3. No "Your Tests" real-administration section.
4. Branding stays Ace STEM.
5. "THIS IS A PRACTICE TEST" banner: the real app shows it (screenshots
   6–14); we removed it early on at David's request. Keeping it removed
   unless David reverses — one line to restore if he does.

## Technical notes

- Annotations (highlights/notes) are currently innerHTML-per-question in
  moduleState; serializing them into the attempt record for resume must not
  break the fmt()/KaTeX-rendered content they sit on top of.
- Any content change from the test-bank side (LaTeX pass, m2-q11) means a
  regenerated test-data.js with a bumped testVersion — coordinate so the
  parity work is tested against the final content, not the plain-text math.
- After Phase D, the sign-in → home → test → results flow is different
  enough that the full end-to-end verification (real clicks, then dashboard
  reconciliation) should be re-run the way the attempts build was verified.
