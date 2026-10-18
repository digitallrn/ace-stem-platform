# Image answer choices — the contract (ruled 2026-10-07; live 2026-10-18)

*Status: LIVE. David ruled on every open decision on 2026-10-07 (§9). The
renderer shipped first (platform `b1949ce`, app.js / styles.css with its
tests). The test-bank converter has emitted the shape since test-bank
`6d03bcb`, whose `image_choices.py` holds §5's rules. Export batch eleven
released the first two image items at testVersion `2026-10-10-a`:
**202609asiav1 m2-q4** (key D) and **202510usv1 m2-q1** (key B, ruling 9.5).
Both render on production as of platform `b67d3a7`, deployed 2026-10-18.
**202406intv1 m2-q1** stays held: its choice C is absent from the source.
David's brief ordering the releases closed §9.6: each release fills its short
module. Since 2026-10-18 the renderer also checks every image's decoded bytes
against its declared type (§2.4). Three independent designs were drawn up and
judged against the code; this is the winner with the best of the other two
grafted in.*

## Why

Three live forms held an item out because its four answer choices are graph
IMAGES the renderer could not show (the test-bank repo's "Platform-feature
queue #1"): **202406intv1 m2-q1**, **202510usv1 m2-q1**, **202609asiav1 m2-q4**.
All Math multiple-choice, keyed by letter. Each hold left a module one
short, and a short module caps the form's best scaled score (the held-items
measurement of 2026-10-06). Two of the three now ship (above); 202406intv1
m2-q1 is the one still held. The converter already rebuilds image choices that
are really tables as `{{table}}` (202609usv1 m2-q7) and authors image stems
from renders; this contract is only for a choice that IS a picture.

## 1. Shape — an object entry inside `choices`

`choices` stays an array of exactly four. Each element is EITHER a string
(today's shape, `{{tokens}}` intact, rendered by `fmt()`) OR an object:

```json
{
  "id": "m2-q4",
  "type": "mcq",
  "passage": null,
  "questionText": "Which of the following graphs in the {{m}}xy{{/m}}-plane could represent …?",
  "choices": [
    { "image": "data:image/png;base64,iVBORw0KGgo…" },
    { "image": "data:image/png;base64,iVBORw0KGgo…" },
    { "image": "data:image/png;base64,iVBORw0KGgo…" },
    { "image": "data:image/png;base64,iVBORw0KGgo…" }
  ],
  "correctAnswer": 3,
  "difficulty": null, "skill": "Linear inequalities in one or two variables", "tags": []
}
```

- The two kinds are told apart **structurally** (`typeof c === "string"` vs
  an object with a string `image`), never by sniffing a string's prefix.
- `image` is a data URI matching exactly
  `^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+=*$` — the
  encoder's existing output (at the 2026-10-07 ruling all 258 shipped
  `figure`s already matched; 149 png, 12 jpeg, 34 svg+xml in forms). No
  `http(s):`, `blob:`, `charset`, whitespace or percent-encoding. gif/webp
  are out: nothing shipped uses them.
- The decoded bytes must be the type `image` declares (2026-10-18, §2.4):
  png opens with the PNG signature, jpeg with `FF D8 FF`, and svg+xml is a
  document whose root is `<svg>` in the SVG namespace. A grammar-valid
  source that fails this renders the placeholder below.
- `alt` is **reserved, optional**: a plain string the renderer uses as the
  image's alt text when present and non-blank; the converter emits none
  (ruling 9.2) and the app labels the image "Choice B (image)".
- `correctAnswer` is still an index 0–3. `figure`/`figureCaption` are
  independent: a stem figure and image choices can coexist.
- v1 is **all-or-nothing per item** at the converter; the renderer handles
  a mixed item per choice anyway.
- An element that is neither a string nor a valid image object (null, a
  number, an array, `{}`, `{image: 5}`, a bad grammar, bytes that are not the
  declared type) renders a visible "Image unavailable" placeholder for that
  choice — never a throw, never a blank box. The converter never emits one.
- Bank items (SCHEMA-BANKS-v1 §3) take the same grammar; they reach the same
  renderer through `buildSetTestFromRecord` with the objects intact
  (pinned in tests/set-flow.test.js §6).

**TSV lane (converter's side):** the image rides in four NEW columns
`choice_a_img … choice_d_img`, not in `choice_a..d`. Those columns sit outside
`TEXT_FIELDS` and outside every prose gate's `FIELDS` tuple (katex_strict,
token_convention, math_marking, question_choice_overlap), so none of them ever
scans base64 as prose; the converter alone maps column → object. No
committed TSV carries an `[IMAGE]` placeholder in a text cell: `[IMAGE]` is
now only the transcription's marker, which a build checks before it fills the
`_img` columns (202609asiav1's build names those rows `IMAGE_CHOICE_ROWS`).

**Why an object, not a parallel array or a token.** A `{{img}}` token would
make `fmt()` emit `<img>`, voiding the stated reason IMG is in
`DROP_ELEMENTS` (app.js, the sanitizer's comment) and forcing the sanitizer to
admit the one element it most wants out of saved markup. A parallel
`choiceImages` array with `""` in `choices` breaks both four-non-empty-choices
gates, leaves an empty `.ctext` as an annotatable region, makes every
per-choice branch read two arrays, and FAILS SILENTLY on an old client (four
blank tiles). The object fails LOUDLY in any unaware consumer
(`[object Object]` through `fmt`, a TypeError in dedup) — this codebase's
stated preference — is already skipped by every existing
`typeof v === "string"` guard, and cannot be confused with prose.

## 2. Sanitizer — unchanged, by construction

Nothing changes in `sanitizeOnce` / `sanitizeSavedHtml` / `DROP_ELEMENTS` /
`DROP_ATTRS` / `KEEP_CLASSES` / `STYLE_*` / `restoreAnnotations`. Four
invariants, each pinned by a test:

1. **`fmt()` still emits no `<img>`.** render.js is untouched; an image
   choice never reaches `fmt()` because `choiceBodyHtml` branches on the
   choice's TYPE before calling it (image-choice.test.js §5 greps render.js
   for `img`).
2. **An `<img>` still cannot enter saved annotation HTML.** `saveAnnotation`
   stores `host.el.innerHTML` and a choice's host is `closest(".ctext")`. An
   image choice renders NO `.ctext`: its `<img>` lives in `<span class="cimg">`,
   which `annotationHost` cannot resolve, so the selection is refused like a
   cross-choice selection and nothing can serialise the image into
   `choiceHtml`. The sanitizer's IMG comment carries the clause;
   `annotationHost` is exposed read-only on `window.AppSanitize` so the proof
   asks the real function.
3. **A crafted record cannot replace or blank an image choice through
   `choiceHtml`.** The replay substitutes a saved blob for `fmt(c)` on a TEXT
   choice; for an image choice the kind is decided from TEST DATA first and
   the slot is simply never read — there is no render site for the blob, so
   there is nothing to sanitize (image-choice.test.js §2: the output is
   byte-identical with and without a hostile blob; the proof plants one in all
   four slots).
4. **The source** is test-data-derived, never record-derived. It goes through
   `escapeHtml()` into `src` as `q.figure` does — and STRICTER:
   `choiceImageSrc(c)` returns the string only if `imageSourceOk` passes it,
   else null → placeholder, no `<img>`. A `data:` URI cannot make a network
   request, so whatever path content arrives by (the single-file build, a
   bank file, the device-writable localStorage test cache that the loader
   restores BEFORE the network) an image choice can never beacon or leak an
   IP. SVG is in the grammar only because the render path is `<img>` (no
   script, no external fetch); the helper's comment stays tied to `<img>`.
   Ruling 9.4: `q.figure` is routed through the same `data:`-only guard as a
   separate small commit (`0792fe7`), proving all 258 shipped figures still
   pass. `figureSrc` and `choiceImageSrc` share one guard.

   **Magic bytes (2026-10-18).** `imageSourceOk(s)` is the grammar and then
   three checks on the bytes, so a source that only *declares* the right type
   is not enough:
   1. the payload decodes. Grammar-valid base64 fails `atob` (the decoder a
      `data:` URL uses) only on its length and trailing `=`: with no `=`, a
      length of 1 mod 4; with one or two, a length that is not a multiple of
      4; three or more always. This is checked arithmetically, and
      image-choice.test.js §9 compares the arithmetic with `atob` itself in
      every case;
   2. png opens with the 8-byte signature `89 50 4E 47 0D 0A 1A 0A`, and jpeg
      with `FF D8 FF` (start of image, then a marker). Only a raster's first
      12 base64 characters are decoded, which matters because a figure can
      be 600 KB;
   3. svg+xml has no signature, so the whole document is decoded (every
      shipped SVG is under 24 KB). Its root element must be `<svg>` in the
      SVG namespace: `xmlns="http://www.w3.org/2000/svg"`, or a prefix bound
      by its own `xmlns:prefix`. Before the root it allows at most a UTF-8
      BOM, an XML declaration, whitespace and comments. A browser will not
      load an `<img>` whose SVG root is in no namespace. A DOCTYPE is not
      admitted: the converter refuses one. UTF-16 is refused too, since the
      converter reads UTF-8 only.

   It runs at both acceptance sites, choices and figures, because they share
   one guard (9.4). On 2026-10-18 every shipped image passes it: 608 figures
   and 8 image choices across current, archived and bank builds. Before it, a
   grammar-valid source whose bytes were something else got an `<img>`. A
   browser then either sniffed and drew it (PNG bytes declared jpeg) or
   showed its broken-image glyph. Either way the declared type was not
   checked anywhere on the platform.

   What the check does not prove: that a raster with a correct opening
   decodes to the end (a truncated PNG still shows the glyph). The
   converter's full decode is that gate (§5.3). Nor does it look at what an
   SVG contains: the render path is `<img>`, which runs no script and
   fetches nothing, so a scripted SVG is still accepted (the browser proof
   renders one).

`alt` is app-generated unless the reserved field is present; the new classes
(`choice-img`, `cimg`, `choice-image`, `cimg-missing`) are NOT in
`KEEP_CLASSES` and none is a hook `annotationHost` resolves on.

Companion hardening, DONE 2026-10-07 as its own reviewed commit (ruling
9.7): Math was annotation-free on every creation path but every replay site
honoured planted blobs on a Math module; `replaysAnnotations(mod)` now gates
the passage pane, the stacked stimulus, the stem and the choices' saved map
(`false` for a Math module), so a crafted record's `passageHtml` /
`stemHtml` / `choiceHtml` for a Math question has no render site at all —
the same closure for TEXT choices that the type branch gives image choices.
Pinned in tests/image-choice.test.js §8 (the gate and every call site) and in
the proof (a Math text item carrying the blob in its stem, all four choice
slots and — when the form has a Math text item with a set-up passage after
the image item, as 202606asiav1 does at ma2-q9 — its stimulus renders only
its own test data; the kept-highlight span that must survive on the RW item
must NOT appear here; the note records whether a stimulus was present, and
the stacked-stimulus gate is pinned by the node suite regardless).

## 3. Renderer (built, live)

One pure function, the unit-test seam, factored out of `buildQuestionHtml`:

```js
const CHOICE_IMAGE_RE = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+\/]+=*$/;
function imageSourceOk(s){ /* the grammar, then the bytes are the declared type (§2.4); full text in app.js */ }
function isImageChoice(c){ return !!c && typeof c === "object" && !Array.isArray(c); }
function choiceImageSrc(c){
  return (isImageChoice(c) && typeof c.image === "string" && imageSourceOk(c.image)) ? c.image : null;
}
function figureSrc(q){
  return (q && typeof q.figure === "string" && imageSourceOk(q.figure)) ? q.figure : null;
}
/* `saved` is the record's per-question map of highlighted-choice markup
   (ms.choiceHtml[q.id]) — record-derived, untrusted. It is handed in whole
   and indexed HERE, on the text path only, so the caller never holds a
   blob and an image choice's slot is never read at all. */
function choiceBodyHtml(c, idx, saved){
  const letter = String.fromCharCode(65 + idx);
  if(typeof c !== "string"){
    const src = choiceImageSrc(c);
    const alt = (isImageChoice(c) && typeof c.alt === "string" && c.alt.trim()) ? c.alt.trim() : "Choice " + letter + " (image)";
    return src
      ? `<span class="cimg"><img class="choice-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" draggable="false"></span>`
      : `<span class="cimg cimg-missing" role="img" aria-label="Choice ${letter} image unavailable">Image unavailable</span>`;
  }
  const savedC = (saved && typeof saved === "object") ? saved[idx] : undefined;
  /* only a non-empty STRING is a blob: an empty slot is "no blob", never a blanked choice */
  const inner = (typeof savedC === "string" && savedC !== "") ? sanitizeSavedHtml(savedC) : fmt(c, {bigInline:true});
  return `<span class="ctext">${inner}</span>`;
}
```

- `buildQuestionHtml` looks the per-question `choiceHtml` map up ONCE, by
  question id, and hands it whole to `choiceBodyHtml` for every choice; the
  branch itself never indexes the map or interpolates anything but the
  seam's `${body}` (pinned by an exact-set check on its interpolations). It
  adds `choice-img` to an image choice's `.choice`; the `clabel`, the review
  marks and the row's `elim-btn` / `elim-undo` are unchanged. No
  `id="figImg"` and no `.fig-imgwrap` on a choice image — those are the stem
  figure's singletons.
- CSS: `.choice .cimg{flex:0 1 auto;min-width:0;position:relative;display:inline-flex}`,
  `.choice .cimg img{display:block;width:auto;max-width:min(100%,320px);max-height:220px;-webkit-user-drag:none;user-select:none}`,
  `.choice.eliminated .cimg img{opacity:.35}` (the edge-to-edge strike still
  runs across it), `.cimg-missing` dashed placeholder. One choice per row,
  stacked (ruling 9.1, provisional until a real Bluebook capture); the 2×2
  grid is held ready as a commented `.choices:has(.choice-img)` rule beside
  them — literally CSS-only, keyed on the class the renderer already emits.
  The cap buys a predictable per-choice height and never-wider-than-the-
  column, not a no-scroll fit: four capped choices still scroll the pane.
- **Click to select**: unchanged — the handler is on `.choice` and the click
  bubbles from the image; `draggable="false"` keeps a native image drag from
  eating the mousedown. Un-cross by clicking a crossed-out choice unchanged.
- **Cross out**: unchanged — buttons sit outside `.choice`; `toggleEliminate`
  keys on the index.
- **No expand control** (ruling 9.3): add the hover ⛶ reusing `#figOverlay`
  only if the live graphs prove hard to read. Measured on the first two
  (test-bank reviewer, 2026-10-18): under the 320×220 cap a choice displays
  at about 179×220 (202609asiav1) and 215×220 (202510usv1). Which side is
  shaded, flat versus slanted, and the dashed boundary are legible; the tick
  numbers are small. Whether that calls for the control is David's decision.
- **Single-file build**: `assemble.py` inlines the test file verbatim; data
  URIs already ship for figures. The two shipped items carry 71,916 and
  39,032 URI characters (the estimate here was ≈300 KB per item).

## 4. Review Mode, the printed report, the dashboard, grading

- **Review Mode**: the same body inside the same `.choice rv …` div with
  `rv-key` / `rv-wrong` borders and the ✓/✕ `.rv-mark` to the right of the
  image; a crossed-out image keeps its strike and fade; nothing mutates, and
  a hostile record's `choiceHtml` for the item has no render site (proof).
- **Printed report**: unchanged and correct as-is — `window.print()` of
  Score Details, whose Questions Overview prints LETTERS from the stored
  index (`answerLetter` / `correctLabel`), which is what College Board's own
  report prints for every MCQ.
- **Dashboard**: letters everywhere (`givenLabel`; the `wrongLbl` block in
  `viewItems`; the `correctLbl` / `givenLabel` lines of the attempt detail
  pane); it renders no choice content.
- **Grading**: untouched. `answerMatches` for `mcq` is index equality;
  records store `given: idx`; nothing on the scoring path reads choice
  content — which is also why the renderer could ship first (2026-10-07) and
  the converter later (2026-10-18) without any record changing.

## 5. What the converter must emit and guarantee (the contract)

Also recorded as SCHEMA-v1.2.md §3 (shape) and §5 rule 8. **Implemented** in
the test-bank repo at `6d03bcb` (2026-10-18). `image_choices.py` holds rules
2–5. The converter, the bank lane, dedup, both exporters and the collision
guard were each taught the shape (test-bank STATUS.md, "Image answer
choices — the converter side"). `test_image_choices.py` proves it, red with
each support removed. The numbered rules below stay the contract.

1. Source columns: `choice_a_img … choice_d_img` (new), one data URI each;
   `choice_a..d` text cells stay EMPTY for an image item. No prose gate
   (`TEXT_FIELDS`, katex_strict, token_convention, math_marking,
   question_choice_overlap) ever lists the `_img` columns.
2. Emit `{"image": s}` per choice, `s` matching EXACTLY
   `^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+=*$` — no
   whitespace, no `charset`, no percent-encoding, no other scheme. Emit no
   other key (`alt` is reserved; emit it only when an authored description is
   ruled in).
3. The base64 decodes and the bytes' magic matches the subtype (PNG
   `\x89PNG`, JPEG `\xFF\xD8`; svg+xml parses as XML with root `<svg>`, no
   `<script`, no `on*=`, no `<foreignObject`, no external `href`/`xlink:href`).
   `image_choices.py` does all of it: strict base64 (excess or missing
   padding refused), the PNG IHDR, the JPEG start-of-frame, a full PIL decode
   of rasters, and the SVG parse with its safety rules. Since 2026-10-18 the
   renderer runs a lighter check itself, the type match of §2.4. A payload
   `atob` cannot decode, or whose bytes are not the declared type, renders
   the placeholder. The renderer still cannot see a raster that opens
   correctly but is truncated or corrupt further in: that shows the
   browser's broken-image glyph beside the label, and the converter's full
   decode remains its gate.
4. Longest side ≤ 600 px — checked as max(width, height) after decode (PIL
   size, or IHDR / SOF / svg viewBox), independent of `encode_figure`, which
   caps WIDTH only (≈2× the 320 px display width keeps a 2× DPR render
   sharp); grayscale unless colour carries meaning for that form, which the
   build records.
5. Size: each image ≤ 96 KB as a URI, the four together ≤ 320 KB, as set in
   `image_choices.py`. The first two shipped items sit well inside both:
   17,574–18,454 URI characters per image and 71,916 for the item
   (202609asiav1 m2-q4), and 6,998–12,590 and 39,032 (202510usv1 m2-q1).
6. Rule 3 ("MCQ ⇒ all 4 choices present") becomes: all four choices are
   non-empty strings, OR all four are valid image objects; a mixed item fails
   the row with reason `mixed text/image choices`. Every gate that counts
   choices learns the rule: the converter's four-choice gate,
   `bank_lib.mcq_answerability_problems`, `is_mcq_row` /
   `bank_row_to_question`, AND `bank_lib.validate_payload_shape` — the
   payload-level gate `load_bank` runs. It was strings-only and had to change
   BEFORE the first image item could be minted (a minted image ledger line is
   append-only, and every later `load_bank`, `bank_gate`, `export_bank` and
   mint would abort on it); `6d03bcb` changed it. `bank_gate.payload_texts`
   already skipped non-strings and needed nothing.
6b. The stem figure takes the SAME grammar: `figure` is a data URI matching
   rule 2's regex (no URLs); the converter's rule 7 refuses what the renderer
   now refuses (`figureSrc`: a figure outside the grammar renders a "Figure
   unavailable" frame). Every shipped figure already matches.
7. The key is still a letter A–D selecting an index; nothing about the bytes
   participates in keying. `choices` remains an ARRAY of length 4; `type`
   stays `"mcq"`.
8. An item is never held FOR being an image item (the converter has emitted
   the shape since 2026-10-18); a row with fewer than four decodable images still fails
   rule 6 (this keeps
   202406intv1 m2-q1 held — its choice C is absent from the source).
9. Dedup: `norm_choice` maps an image choice to the opaque token
   `[image:<sha256 of the DECODED bytes, 16 hex>]` so `choice_key` stays a
   tuple of strings; identical graph bytes across forms compare exact; never
   compare the base64 text (a re-encode changes it). Before `6d03bcb` a dict
   crashed `norm_text` and would have blocked `dedup-index.js` regeneration;
   rule 9 landed in that commit, before either image item was exported.
10. Export stays byte-deterministic (`json.dumps` serialises the one-key
    object in insertion order), so `--check` identity and
    `archive-testdata.js --verify` hold.
11. The exporter REFUSES to emit a form or bank containing an image object
    unless the platform checkout's app.js carries `choiceImageSrc` — the
    cross-repo posture `bank_lib.py` already takes by running the platform's
    grading.js. "App first, then export" is a check:
    `image_choices.platform_supports()` reads app.js for
    `function choiceImageSrc(` and the grammar literal, so both must stay
    verbatim (image-choice.test.js §9 pins them).
12. Un-holding is a content change on a live form: testVersion bump + `node
    archive-testdata.js`; manifest `questionCount`/`sections` change; attempts
    on the old build stay pinned. Done for both releases at `2026-10-10-a`:
    202609asiav1 95 → 96 (Math M2 raw max 21 → 22) and 202510usv1 97 → 98,
    with the old builds `2026-10-02-a` and `2026-09-25-a` archived.

## 6. Consumers (platform repo) — done

| Where | Change |
|---|---|
| app.js `choiceBodyHtml` + `buildQuestionHtml` choice branch | the seam above; `choice-img`; the per-question `choiceHtml` map is looked up once in the branch and handed whole to the seam, which indexes it only for a text choice |
| app.js `imageSourceOk` (2026-10-18) | the magic-bytes check (§2.4); `choiceImageSrc` and `figureSrc` both accept through it |
| app.js `annotationHost` | NO change; exposed on `window.AppSanitize` for the proof |
| app.js DROP_ELEMENTS comment | one clause |
| styles.css after `.choice.eliminated .hl` | the `.cimg` rules; the 2×2 grid commented beside them |
| render.js, grading.js, attempts.js, dashboard.js, assemble.py, build-site.js, archive-testdata.js | NO change |
| tests/image-choice-fixture.js | NEW — the shared four-image item (four distinct 4×3 PNGs) |
| tests/image-choice.test.js | NEW — the seam, the grammar, the placeholder, the fixture, the proof's copy of it, (0792fe7) the stem-figure guard with every shipped figure, and (2026-10-18) §9 the bytes check at both sites with its mutants, plus every shipped image choice |
| tests/keep-classes.test.js | explicit image-choice audit over every form and bank through the renderer's own `choiceImageSrc` (grammar, and since 2026-10-18 bytes), with planted-fixture controls |
| tests/injection-proof.js | synthesises the item in memory, plants the blob in all four slots, asserts the surfaces in §7 |
| tests/set-flow.test.js §6 | a bank item with image choices resolves intact |
| tests/extract-helper.js | `extractConst` steps over a leading regex literal (the grammar carries `;base64`) |
| SCHEMA-v1.2.md §3/§5, CLAUDE.md escaping contract | the shape and the rule |

## 7. Tests

- `node tests/image-choice.test.js`: 97 checks (§8 adds the Math-replay
  gate's truth table, its five call-site pins, and a FILE-WIDE, prefix-blind
  sweep: every mention of passageHtml/stemHtml/choiceHtml in app.js is an
  initialiser, restoreAnnotations, saveAnnotation or one of the five gated
  lines; the sanitizer has exactly four sinks; attempts.js names the fields
  only where the recorder packs the record; dashboard.js and render.js never
  do — a fifth replay site, an alias read, a new helper and an ungated sink
  each fail it) — text path byte-for-byte
  (the saved map indexed only on the text path, only at this choice's slot;
  an empty or non-string slot is "no blob");
  image path with the exact source, no `.ctext`, identical output with a
  hostile blob in every slot, and a trapping Proxy proving the map is never
  even indexed; the reserved alt; the grammar (13 rejections); ten
  malformed entries → placeholder, no throw (including an array holding a
  valid URI, which only the typeof guard keeps out); the seam is the one
  render site and the branch's interpolations are pinned as an EXACT SET of
  its eleven literals (the tripwire for the branch; a prefix test would let
  a `${sel ? blob : ""}` through, and the proof's hostile slots can sit on
  an unselected choice — so the proof now also selects a hostile slot on
  the image item); render.js emits no `img`; the proof embeds the fixture
  verbatim; and (0792fe7) the stem-figure guard — `figureSrc` accepts a
  data URI and refuses the rest, `figureFrameHtml` renders the guarded
  source or the placeholder frame without toolbar, the handlers and the
  overlay use it, and every shipped figure passes unchanged: 585 across
  current builds (195), banks (63) and archived builds (327) when it landed,
  608 on 2026-10-18, now with the 8 shipped image choices swept through
  `choiceImageSrc` beside them; ruling 9.4's "258" was the student-servable
  subset, current forms plus banks. §9 (2026-10-18) is the bytes check: 11
  true-type sources accepted and 28 grammar-valid ones refused (PNG, JPEG
  and SVG bytes each declared as the other two types, GIF and HTML bytes,
  zero bytes, broken, shifted or cut signatures, twelve SVG documents whose
  root is not `<svg>` in the SVG namespace or is preceded by something the
  check does not admit, three padding faults) at BOTH sites. Its decodability
  arithmetic agrees with `atob` on all 80 length × padding cases. The
  placeholder renders in the seam and in `figureFrameHtml`. A sweep pins
  where the renderer accepts an image: exactly two `<img>` writers, each fed
  by its guard, the overlay fed by `figureSrc`, every other `.src` a script
  loader's, and the grammar named only at its declaration and inside
  `imageSourceOk`. Ten in-process mutants, each built from the real source
  by a replacement that must apply, must each turn the battery red: either
  site running the bare grammar, the decodability rule dropped, each
  signature not compared or cut short, any SVG root admitted, the namespace
  value not compared, an SVG decoded only as far as a raster's head, and a
  prefixed root not bound to its own prefix. Against b67d3a7's app.js (no
  check) the suite fails 17 checks, among them the battery at both sites.
  Mutants that fail it (sixteen): the typeof guard dropped; the regex
  loosened to `^data:`; the saved slot read before the type branch; `<img>`
  inside `.ctext`; `draggable` dropped; alt unescaped; the branch rendering
  text choices itself; the branch interpolating a blob itself; the branch
  looking a slot up by index; a `sel`-gated blob before `${body}`; a
  comma-expression blob after it; the map's values appended to the body,
  unconditionally and `sel`-gated; a blob folded into `${letter}`; a slot
  re-wrapped as a one-entry map; an empty slot treated as a blob; and three
  that reach the markup by CONCATENATION through an alias declared above
  the branch (appended to the body, folded into the class attribute, folded
  into the review mark) — caught because the whole function may name the
  map and the record field exactly twice each.
- `node tests/keep-classes.test.js`: every image choice in every form and
  bank (Math included) is one the renderer's own `choiceImageSrc` accepts,
  grammar and (2026-10-18) bytes, inside a 4-entry MCQ, and no choices array
  anywhere holds a null, number or array entry. The audit must see at least
  one image choice; it sees the shipped 8 on 202510usv1 ma2-q1 and
  202609asiav1 ma2-q4. The control passes the fixture and fails thirteen
  planted defects, four of them bytes-only: PNG bytes declared jpeg, SVG
  bytes declared png, an un-namespaced SVG, and a payload `atob` refuses.
  Those four fail against b67d3a7's app.js.
- `tests/injection-proof.js` against `dist/index-live.html`: the synthetic
  item is counted among the surfaces; one `<img>` per choice with the EXACT
  fixture source and no `.ctext`; the hostile blob has no render site;
  review marks render; `annotationHost` (the real function) refuses the
  image and resolves a text choice (control); https / javascript: /
  data:text/html / whitespace sources render the placeholder with no `<img>`
  and no request to evil.example; four grammar-valid sources whose bytes are
  not the declared type, or do not decode, render the placeholder too
  (2026-10-18); a scripted SVG renders through `<img>` and executes nothing;
  seven bad stem-figure sources, two of them failing only the bytes check,
  render the "Figure unavailable" frame with review still entered, no
  `#figImg`, no toolbar and no request, and a grammar-valid figure renders
  with its toolbar.
- Regression: local-mode, tutor-writes, set-flow, tombstone, spr-grading
  green; `archive-testdata.js --verify` clean (no testdata changed).

## 8. Risks and scope, stated

- **Shipped (2026-10-18): 202609asiav1 m2-q4** (key D, both sealed passes)
  **and 202510usv1 m2-q1** (key B, ruling 9.5), both live-unassigned at
  `2026-10-10-a` pending their Stage-3 reads. 202406intv1 m2-q1 stays held
  (choice C absent). `build_202406intv1.py` lists FOUR image-choice sets
  (m1-q12, m1-q17, m1-q20, m2-q1) with only m2-q1 held — David to confirm
  how the other three ship today and whether any should become image
  choices.
- **Versioning**: §5.12, done for both releases; 9.6 is closed.
- **Layout unverified**: none of the 40 reference captures shows graph
  choices; stacked column and the 320×220 cap are provisional (9.1). The
  live graphs display small (§3, under ruling 9.3).
- `dist/index-live.html` is 22.5 MB (above the 16 MB artifact ceiling); the
  two shipped image items add 72 KB and 39 KB of URIs.
- Mixed items forbidden in v1 (renderer tolerates them); relax rule 5.6
  later if a "graph plus equation" item appears.
- Accessibility stays weak: choices are divs with click handlers and the
  default alt is neutral (9.2).
- **Undecodable payload**: since 2026-10-18 the renderer refuses a payload
  `atob` cannot decode, or whose bytes are not the declared type, and shows
  the loud placeholder (§2.4). keep-classes' audit runs the same check over
  every shipped image choice, and image-choice.test.js runs it over every
  shipped figure. What is left: a raster that opens correctly but is
  truncated or corrupt further in still shows the browser's broken-image
  glyph (visible and labelled, but not the placeholder). Full decodability
  is the converter's gate (§5.3: a PIL decode of every raster).
- **Narrow review panes**: `.cimg` is the only flexible item in a review
  choice, so under ~515 px the image yields to the nowrap `.rv-mark`
  (unreachable on target devices for Math-only v1); fold into the
  capture-driven layout pass (9.1).
- **Canonical schema copies**: the test-bank repo's SCHEMA-v1.2.md (its
  v1.2 addendum) and SCHEMA-BANKS-v1.md §3 carry the shape since `6d03bcb`.

## 9. Rulings (David, 2026-10-07)

1. **Layout and size**: stacked column at 320×220, provisional until a real
   Bluebook graph-choice capture settles it; the 2×2 grid stays one CSS rule
   away.
2. **Alt text**: app-generated "Choice B (image)" now; `alt` reserved for
   authored descriptions later.
3. **Expand control**: none for now; add the hover ⛶ only if the first live
   graphs prove hard to read. *2026-10-18: they are live; the measured
   display size is in §3, for David.*
4. **Grammar**: png + jpeg + svg+xml; and `q.figure` goes through the same
   `data:`-only guard as a separate small commit, proving all 258 shipped
   figures still pass. *2026-10-18: the shared guard also checks the bytes
   against the declared type (§2.4).*
5. **Which items ship first**: 202609asiav1 m2-q4 first. **202510usv1
   m2-q1's key is B, with the stem as printed** — "y > −36" is answerable as
   printed and both blind passes derived B from it; printed C fits only a
   stem with an x the print does not show, and no dropped-variable defect
   class is confirmed on that form, so the key is the outlier. Recorded here
   so the test-bank bump carries it. 202406intv1 m2-q1 stays held (missing
   choice C). *2026-10-18: both shipped, 202510usv1 m2-q1 keyed B.*
6. **Sequencing with the scoring decision**: un-holds wait for the
   pro-rating decision; nothing on the platform side. *Closed 2026-10-18 by
   David's brief ordering both releases: the scoring curves already carry 23
   entries for each Math module, so a raw 22 scores, and each release fills
   its short module rather than pro-rating it (test-bank STATUS.md, export
   batch eleven).*
7. **The Math-wide annotation-replay skip**: yes, as its own reviewed commit
   after the renderer lands.
