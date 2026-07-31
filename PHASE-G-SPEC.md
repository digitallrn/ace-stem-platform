# PHASE-G-SPEC.md — Accommodations & Score Reporting

*Drop in the `ace-stem-platform` repo root. References: screenshots 25–28 in
`reference/bluebook-screenshots/` (25 = review popup with answer+rationale
shown, 26 = same popup with the toggle off, 27 = MyPractice Score Details
page, 28 = MyPractice dashboard score cards) and the five College Board PDFs
in `reference/collegeboard-reports/` (real score report, MyPractice details
×2, downloadable practice report, dashboard). These are style/structure
ground truth — we adapt, we don't clone: no percentiles, benchmarks,
Khan/tailored-practice buttons, or difficulty ratings (ours are deliberately
null, never fabricated). Implement top to bottom; stop for David's review.*

---

## 1. Timing accommodations

Assignment objects gain `"timing": 1 | 1.5 | 2 | "untimed"` (default 1).
Assign panel gets a dropdown: Standard / Time and a half (1.5×) / Double
time (2×) / Untimed. No-assignment default practice = standard.

- Module limits multiply exactly: RW 32:00 → 48:00 / 64:00; Math 35:00 →
  52:30 / 70:00. Break stays 10:00.
- **Untimed:** count-up elapsed display where the timer sits, no countdown,
  no auto-submit, no 5-minute alert; Hide still works; module ends only by
  student submit.
- The attempt record copies `timing`. Dashboard attempt rows and detail
  show a badge ("Extended time 1.5×" / "Untimed"); the student report
  shows the same. Pacing bars use the *accommodated* limit as denominator.
  Item-analysis medians are unchanged (mixed-timing pools are fine at this
  scale; the badge is the context).
- Resume math: `timeRemainingSeconds` already stores absolute seconds, so
  accommodated and untimed sittings resume correctly without special cases
  (untimed stores elapsed instead; flag it in the blob).

## 2. Calculator icon

Redraw the Math header's Calculator icon as an SVG matching the real
Bluebook glyph (visible in reference screenshots 22–23 and earlier Math
headers). Same treatment as the Reference x² icon already has.

## 3. Scaled scores (data prerequisite)

Tests may carry a `scoring` object in test-data:
`{ "rw": [raw0..raw54 → scaled], "math": [raw0..raw44 → scaled] }`.
Total = rw + math. The test-bank side is checking the source PDF for the
official conversion table; if none exists, David supplies/approves an
approximate curve and **every scaled number renders with an "Estimated"
label** (a small superscript/footnote treatment, on cards, hero, and the
printed report). If `scoring` is absent entirely, all scaled elements hide
and the report falls back to raw counts — never invent numbers.

## 4. Student Score Details page

This replaces the plain View My Responses as the released-attempt view
(reached from the Past card; same release gating as today).

- **Hero** (structure per screenshot 27, Ace STEM styling): test name +
  attempt date; TOTAL SCORE large with 400–1600 range; section scores with
  200–800 ranges; timing badge if accommodated; actions: **Review All
  Questions** (jumps to the table) and **Download Score Report** (§7).
- **Knowledge and Skills:** the 8 CB domains, aggregated from `skill` —
  RW: Information and Ideas, Craft and Structure, Expression of Ideas,
  Standard English Conventions; Math: Algebra, Advanced Math,
  Problem-Solving and Data Analysis, Geometry and Trigonometry (unmapped
  skills → "Other", shown only if non-empty). Per domain: correct/graded
  and a segmented performance bar (share of graded answered correctly).
  No difficulty rows.
- **Questions Overview table** (per the MyPractice details PDFs): tabs
  All / Reading and Writing / Math; columns Question #, Section, Correct
  Answer, Your Answer ("Omitted" when blank), Review, Domain; a **"Show
  Correct Answers"** toggle that blanks/reveals the Correct Answer column;
  View 10 / 30 / All with pagination.

## 5. Question Review popup (screenshots 25–26)

Modal over the table: question number + domain top-right; the full
question rendered on the left through the real fmt()/KaTeX/figure
pipeline; right pane empty until the **"Show correct answer and
explanation"** checkbox (bottom-left, sticky per popup session) is checked.
When shown:
- Banner: red "You omitted this question. The correct answer is D." /
  red "Your answer is B. The correct answer is D." / green "You answered
  D, which is correct." Keyless questions get a neutral "No key yet"
  banner and no correctness claim.
- **Rationale** section renders `q.rationale` through fmt() when present;
  the section is absent when the field is (no empty placeholder). The
  schema field is being added test-bank-side; content authoring is a
  separate later project.
- Previous / Next walk the filtered table order.

## 6. Dashboard + Past-card touches

- Past cards show the scaled TOTAL (or raw fallback) once released, in the
  card-anatomy style of screenshot 28; unreleased stays "Scores not
  released yet."
- Dashboard attempt detail gains an "Open student view" link to §4 (works
  regardless of release, admin-only).

## 7. Download Score Report

A print stylesheet on the §4 page producing a **one-page US Letter**
report in the spirit of the downloadable CB practice report: Ace STEM
wordmark, student code + test name + date + timing badge, total + section
scores (with Estimated labels when applicable), questions-overview counts
(correct / incorrect / omitted per section), and the 8 domain bars. The
button triggers window.print(); the stylesheet hides everything else and
fits one page. This becomes the parent-facing report path for platform
attempts.

## 8. Out of scope

Percentiles, benchmarks, school/state comparisons, tailored-practice or
Khan links, difficulty ratings, adaptive anything. Release flow, archive
rules, and version-gating unchanged — this page lives *behind* the
existing release gate.
