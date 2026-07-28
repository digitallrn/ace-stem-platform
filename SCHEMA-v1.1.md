# Ace STEM Bluebook Simulator — Data Schema v1.1
*The single source of truth for what the extraction pipeline emits, what the
converter validates, and what the app renders. Both `sat_bluebook_extract.py`
and `index.html` must conform to this document. Supersedes the schema section
of EMULATOR-HANDOFF.md where they differ.*

**Headline decision (v1.1):** math is stored as **LaTeX** and rendered with
**KaTeX** in the app. Chosen for Bluebook fidelity (stacked fractions, proper
radicals, segment overbars) — the simulator's whole purpose is authenticity.

---

## 1. TSV columns (extractor → converter)

One row per question. Cells must contain **no raw newlines or tabs** — all
structure is expressed with `{{tokens}}` (see §2). Backslashes appear
literally (LaTeX); never escape them.

| column | req | contents |
|---|---|---|
| `id` | ✓ | extractor's internal row id (converter regenerates display ids) |
| `source` | ✓ | test name as printed, e.g. `2024 March C` (identical on every row of a test) |
| `module` | ✓ | `Reading and Writing` or `Math` |
| `module_num` | ✓ | `1` or `2` |
| `q_num` | ✓ | question number within the module |
| `skill` |  | College Board skill/domain label if identifiable, else blank |
| `passage` |  | passage / stimulus text (blank if none) |
| `question` | ✓ | the question stem |
| `choice_a`–`choice_d` | MCQ | the four choices, verbatim |
| `answer` | ✓ | MCQ: single letter `A`–`D`. SPR: the primary printed key (number or fraction) |
| `alt_answers` |  | SPR only: additional acceptable values, pipe-separated, e.g. `4\|5` for "one possible value" questions. Leave blank if the key is single-valued |
| `needs_figure` |  | `1` if the question or passage references a visual (graph, figure, diagram, table-as-image) that must be shown. Blank otherwise |
| `figure` |  | URL or data-URI of the captured figure image (may be blank even when `needs_figure=1` — the converter will route that to review) |
| `figure_caption` |  | caption line printed under the figure, if any |
| `needs_review` |  | extractor's own doubt flag: brief reason text. Non-blank ⇒ row goes to review. **When unsure, flag — never guess.** |

Old TSVs without the v1.1 columns still convert (new columns are optional).

## 2. Token vocabulary (inside `passage`, `question`, `choice_*`)

All layout and rich text is expressed with `{{token}}` markup. The converter
passes tokens through to JSON **verbatim**; the app's `fmt()` renderer is the
single place they become HTML. Unknown or unbalanced tokens fail validation.

| token | kind | meaning |
|---|---|---|
| `{{br}}` | void | line break. Use for paragraph breaks, poem lines, Text 1 / Text 2 separation, blank lines (`{{br}}{{br}}`) |
| `{{u}}…{{/u}}` | paired | underline (RW "underlined portion" questions) |
| `{{i}}…{{/i}}` | paired | italics (work titles, foreign terms, variables in prose) |
| `{{m}}…{{/m}}` | paired | **inline LaTeX**, KaTeX-renderable subset |
| `{{mm}}…{{/mm}}` | paired | **display LaTeX** — centered block equation (systems, standalone equations) |
| `{{table}} … {{/table}}` | paired | data table. Cells separated by `\|`, rows separated by `{{row}}`; the first row is the header row |
| `{{row}}` | void | row separator, valid only inside `{{table}}` |

Example table:
`{{table}} x \| f(x) {{row}} 1 \| 3 {{row}} 2 \| 7 {{/table}}`

### LaTeX rules
- **Never use `$` delimiters.** SAT word problems contain dollar amounts
  ("costs $5"); only `{{m}}`/`{{mm}}` delimit math.
- Stay inside the KaTeX-supported command set (`\frac`, `\sqrt`, `\left(`,
  `\right)`, `\pi`, `\theta`, `\le`, `\ge`, `\overline{AB}`, `\triangle`,
  `\angle`, `^`, `_`, `\%`, etc.).
- Braces must balance within each math segment.
- Don't wrap plain integers in prose in math tokens ("has 12 marbles" stays
  plain text); do wrap anything with structure: `{{m}}x^2{{/m}}`,
  `{{m}}\frac{2}{3}{{/m}}`, `{{m}}\overline{AB}{{/m}}`.
- Because `{{br}}` (not `\n`) marks line breaks, LaTeX commands beginning
  with `n` (`\neq`, `\not`) are safe — nothing ever rewrites backslash
  sequences.

## 3. JSON question object (converter → test-data.js → app)

```
{
  "id": "ma1-q7",
  "type": "mcq" | "spr",
  "passage": string | null,        // tokens intact
  "questionText": string,          // tokens intact
  "choices": [4 strings],          // MCQ only, tokens intact
  "correctAnswer": int 0-3 | string | null,   // null = no key yet
  "altAnswers": [strings],         // SPR only, optional
  "difficulty": null,              // reserved; never fabricated
  "skill": string | null,
  "figure": string,                // optional; URL or data-URI
  "figureCaption": string          // optional
}
```
Module and test wrappers are unchanged from v1.0 (moduleId, section,
moduleLabel, timeLimitMinutes 32 RW / 35 Math, questions[]).

## 4. Grading semantics (app)

- MCQ: index equality.
- SPR: correct if the student's entry matches `correctAnswer` **or any entry
  in `altAnswers`**, using the existing fraction/decimal equivalence (±0.01).
- True range answers ("any value between 1/3 and 1/2") are **not** modeled in
  v1.1 — they're rare; the extractor must flag them `needs_review: range
  answer` for manual handling.
- `correctAnswer: null` ⇒ "No key yet" badge, excluded from denominators
  (fork behavior, backported).

## 5. Validation guarantees (converter)

A row reaches the clean JSON only if **all** hold; otherwise it lands in
`_review.tsv` with a reason:
1. Not flagged by the extractor (`needs_review` blank).
2. Question stem non-empty.
3. MCQ ⇒ all 4 choices present. SPR ⇒ `answer` and every `alt_answers` entry
   parse as a number or fraction.
4. No raw newlines/tabs in any text cell.
5. All tokens known, properly paired/nested; `{{row}}` only inside tables.
6. Every `{{m}}`/`{{mm}}` segment non-empty with balanced braces and no `$`.
7. `needs_figure=1` ⇒ `figure` present.

## 6. App-side requirements implied by v1.1 (chat-track work)

- `fmt()` renderer implementing §2, with KaTeX (loaded from cdnjs; the app
  already requires internet for Desmos) — escape prose first, then substitute
  tokens; math segments render via `katex.renderToString(..., {throwOnError:
  false})` so a bad segment shows in red instead of crashing the module.
- `answerMatches` extended for `altAnswers`; `correctAnswer: null` handling.
- v1.0 data (plain-text math, no tokens) still renders fine — tokens are
  additive. The March C 40-question set will be superseded by the v1.1 pilot
  re-extraction anyway.
