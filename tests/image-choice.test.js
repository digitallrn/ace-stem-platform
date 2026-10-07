/* tests/image-choice.test.js — run: node tests/image-choice.test.js (repo root)

   Image answer choices (2026-10-07, IMAGE-CHOICES-SPEC.md): a choice is a
   string (today) or {image: data URI, alt?}. This pins the renderer seam,
   choiceBodyHtml (extracted from app.js by source text with the real
   render.js fmt()/escapeHtml beside it), on the four things the contract
   rests on:
     1. a TEXT choice renders byte-for-byte as before — fmt(c) in .ctext, or
        the sanitized saved blob when one exists;
     2. an IMAGE choice renders an <img> with the EXACT source, outside any
        .ctext, and its output is IDENTICAL whether or not a hostile blob sits
        in its saved slot — the slot is never read for it;
     3. the grammar admits exactly data:image/(png|jpeg|svg+xml);base64,… and
        nothing else (http(s), javascript:, data:text/html, a charset param,
        whitespace, an empty payload, gif);
     4. every malformed entry renders the visible placeholder and never throws.
   Plus: the shared fixture passes the grammar and escapeHtml leaves it
   untouched; the browser proof embeds the fixture's four URIs verbatim; and
   buildQuestionHtml's choice branch no longer calls fmt() or writes .ctext
   itself (both live only in the seam), while annotationHost still resolves
   choices by .ctext.

   Mutants that must fail it (APP_SRC=<file> points at a scratch copy):
     drop the `typeof c.image === "string"` check (an array whose String()
     is a valid URI would then render); loosen the regex to ^data:; read the
     saved slot before the type branch; put the <img> inside .ctext; have
     buildQuestionHtml's branch index the saved map or interpolate a blob
     itself (the map is handed to the seam whole; only the seam's text path
     indexes it).                                                              */
"use strict";
const fs = require("fs");
const vm = require("vm");
const { extractFn, extractConst } = require("./extract-helper");
const F = require("./image-choice-fixture");

const APP_PATH = process.env.APP_SRC || "app.js";
const appSrc = fs.readFileSync(APP_PATH, "utf8");
const renderSrc = fs.readFileSync("render.js", "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}

/* the real render.js (fmt, escapeHtml) in a bare context — no KaTeX, so math
   takes its fallback span; no DOM, so no italic-correction pass */
const rctx = { window: {} };
vm.createContext(rctx);
vm.runInContext(renderSrc, rctx);
const fmt = rctx.fmt, escapeHtml = rctx.escapeHtml;
check(typeof fmt === "function" && typeof escapeHtml === "function", "render.js provides fmt() and escapeHtml()");

/* the seam, with a sanitizer stub that MARKS its output so the test can see
   which path ran (the real one needs a DOM) */
const SEAM_SRC = [extractConst(appSrc, "CHOICE_IMAGE_RE"), extractFn(appSrc, "isImageChoice"),
  extractFn(appSrc, "choiceImageSrc"), extractFn(appSrc, "choiceBodyHtml")].join("\n");
const seam = new Function("fmt", "escapeHtml", "sanitizeSavedHtml",
  SEAM_SRC + "\nreturn { CHOICE_IMAGE_RE, isImageChoice, choiceImageSrc, choiceBodyHtml };")(
  fmt, escapeHtml, s => "<sanitized>" + String(s) + "</sanitized>");
const { CHOICE_IMAGE_RE, choiceImageSrc, choiceBodyHtml } = seam;
const HOSTILE = '"><img src=x onerror="window.__XSS_FIRED=true"><b data-x=\'y\'>PWN</b>';

console.log("--- 1. text choices render as before ---");
{
  const plain = choiceBodyHtml("the {{i}}only{{/i}} answer", 1);
  check(plain === '<span class="ctext">' + fmt("the {{i}}only{{/i}} answer", { bigInline: true }) + "</span>",
    "a text choice is fmt(c, {bigInline:true}) inside .ctext", plain);
  const saved = choiceBodyHtml("text", 1, { 1: HOSTILE });
  check(saved === '<span class="ctext"><sanitized>' + HOSTILE + "</sanitized></span>",
    "a text choice with a saved blob in ITS slot renders the SANITIZED blob instead (today's replay path)", saved);
  const plainText = '<span class="ctext">' + fmt("text", { bigInline: true }) + "</span>";
  check(choiceBodyHtml("text", 1, { 1: null }) === plainText, "a null saved slot means 'no blob' for a text choice");
  check(choiceBodyHtml("text", 1, { 0: HOSTILE, 2: HOSTILE }) === plainText, "a blob in ANOTHER choice's slot is not this choice's");
  check(choiceBodyHtml("text", 1, undefined) === plainText && choiceBodyHtml("text", 1, null) === plainText && choiceBodyHtml("text", 1, "nope") === plainText,
    "no map, a null map, or a non-object map all mean 'no blob'");
}

console.log("--- 2. image choices render from test data only ---");
{
  const q = F.question();
  const out = q.choices.map((c, i) => choiceBodyHtml(c, i));
  check(out.every((h, i) => h === `<span class="cimg"><img class="choice-image" src="${F.URIS[i]}" alt="Choice ${String.fromCharCode(65 + i)} (image)" draggable="false"></span>`),
    "an image choice is one <img> with the EXACT fixture source, the app's neutral alt, draggable off, inside .cimg", out[0]);
  check(out.every(h => h.indexOf("ctext") === -1), "…and no .ctext anywhere in it (so it is never an annotation region)");
  const hostileMap = { 0: HOSTILE, 1: HOSTILE, 2: HOSTILE, 3: HOSTILE };
  const withBlob = q.choices.map((c, i) => choiceBodyHtml(c, i, hostileMap));
  check(withBlob.every((h, i) => h === out[i]), "a hostile blob in every saved slot changes NOTHING: the slot is never read for an image choice");
  /* a map that TRAPS reads proves the slot is never touched, not merely ignored */
  let touched = 0;
  const trap = new Proxy({}, { get(){ touched++; return HOSTILE; }, has(){ touched++; return true; } });
  q.choices.forEach((c, i) => choiceBodyHtml(c, i, trap));
  check(touched === 0, "…and the map is never even indexed for an image choice (a trapping Proxy sees no read)", String(touched));
  check(withBlob.every(h => h.indexOf("PWN") === -1 && h.indexOf("onerror") === -1 && h.indexOf("sanitized") === -1),
    "…no payload, and not even the sanitizer runs for it");
  const alt = choiceBodyHtml({ image: F.URIS[0], alt: ' a <rising> "line" ' }, 0);
  check(alt.indexOf('alt="a &lt;rising&gt; &quot;line&quot;"') !== -1, "the reserved alt, when a non-empty string, is used — escaped, trimmed", alt);
  check(choiceBodyHtml({ image: F.URIS[0], alt: "   " }, 2).indexOf('alt="Choice C (image)"') !== -1, "a blank alt falls back to the app's label");
  check(choiceBodyHtml({ image: F.URIS[0], alt: 7 }, 2).indexOf('alt="Choice C (image)"') !== -1, "a non-string alt falls back to the app's label");
  check(F.URIS.every(u => escapeHtml(u) === u), "escapeHtml is a no-op on every fixture URI (the grammar admits no metacharacter)");
  check(F.URIS.every(u => CHOICE_IMAGE_RE.test(u)) && new Set(F.URIS).size === 4, "the fixture's four URIs pass the grammar and are distinct");
}

console.log("--- 3. the grammar ---");
{
  const ok = ["data:image/png;base64,iVBORw0KGgo=", "data:image/jpeg;base64,/9j/4AAQ", "data:image/svg+xml;base64,PHN2Zy8+"];
  ok.forEach(s => check(choiceImageSrc({ image: s }) === s, "accepts " + s.slice(0, 24) + "…"));
  const bad = {
    "https URL": "https://evil.example/x.png",
    "javascript:": "javascript:alert(1)",
    "data:text/html": "data:text/html;base64,PHNjcmlwdD4=",
    "charset param": "data:image/png;charset=utf-8;base64,iVBORw0KGgo=",
    "leading whitespace": " data:image/png;base64,iVBORw0KGgo=",
    "inner whitespace": "data:image/png;base64, iVBORw0KGgo=",
    "trailing newline": "data:image/png;base64,iVBORw0KGgo=\n",
    "'<' in the payload": "data:image/png;base64,iVBOR<w0KGgo=",
    "empty payload": "data:image/png;base64,",
    "gif (no shipped precedent)": "data:image/gif;base64,R0lGODlh",
    "percent-encoded": "data:image/png;base64,iVBOR%20w0KGgo=",
    "blob:": "blob:https://sat.davidsatprep.com/abc",
    "uppercase scheme": "DATA:image/png;base64,iVBORw0KGgo="
  };
  Object.keys(bad).forEach(k => check(choiceImageSrc({ image: bad[k] }) === null, "rejects " + k, bad[k]));
}

console.log("--- 4. malformed entries: placeholder, never a throw ---");
{
  const junk = { "null": null, "number": 5, "array": ["data:image/png;base64,iVBORw0KGgo="], "empty object": {}, "image not a string": { image: 5 },
    "image fails the grammar": { image: "https://evil.example/x.png" }, "undefined": undefined, "boolean": true,
    /* an array whose String() is a grammar-valid URI: RegExp.test coerces, so
       only the typeof guard keeps this from rendering a real <img> */
    "image is an array holding a valid URI": { image: [F.URIS[0]] },
    "image is a String object": { image: new String(F.URIS[0]) } };
  Object.keys(junk).forEach(k => {
    let html = null, threw = null;
    try{ html = choiceBodyHtml(junk[k], 1); }catch(e){ threw = e; }
    check(!threw && typeof html === "string" && html.indexOf("cimg-missing") !== -1 && html.indexOf("<img") === -1 &&
          html.indexOf('role="img"') !== -1 && html.indexOf('aria-label="Choice B image unavailable"') !== -1,
      "malformed (" + k + ") renders the placeholder with no <img> and does not throw", threw ? String(threw) : html);
  });
}

console.log("--- 5. the seam is where the choice markup lives ---");
{
  const bq = extractFn(appSrc, "buildQuestionHtml");
  const branch = bq.slice(bq.indexOf("q.choices.map("), bq.indexOf("}).join(\"\") + '</div>'"));
  check(branch.indexOf("choiceBodyHtml(c, idx, savedMap)") !== -1, "buildQuestionHtml's choice branch renders every choice through choiceBodyHtml, handing it the whole saved map");
  check(branch.indexOf("fmt(") === -1 && branch.indexOf('class="ctext"') === -1 && branch.indexOf("sanitizeSavedHtml(") === -1,
    "…and no longer calls fmt(), sanitizeSavedHtml() or writes .ctext itself (one render site, one rule)");
  /* the branch must never HOLD a blob: no indexing of the map, no savedC, and
     ${body} the only interpolation between the letter badge and the mark */
  check(!/savedMap\s*\[|choiceHtml\s*\[[^\]]*\]\s*\[|\bsavedC\b/.test(branch), "…never indexes the saved map or names a slot itself (a crafted blob has nowhere to land in the branch)");
  const between = branch.split("</span>").slice(1).join("</span>");     // after the first clabel span
  const interps = (between.match(/\$\{[^}]*\}/g) || []).filter(s => !/^\$\{(idx|letter|elim|sel|mark|kind|isKey)\b/.test(s) && !/\? "[^"]*" : ""\}$/.test(s));
  check(interps.every(s => s === "${body}" || /^\$\{(idx|letter)\}$/.test(s)), "…and ${body} is the only markup interpolated into the choice box after the letter badge", interps.join(" | "));
  const bqHead = bq.slice(0, bq.indexOf("q.choices.map("));
  check(/const savedMap = \(ms\.choiceHtml && ms\.choiceHtml\[q\.id\]\) \|\| undefined;/.test(bqHead), "the saved map is looked up once per question, by question id only");
  check(/choice-img/.test(branch), "an image choice's .choice carries choice-img");
  const ah = extractFn(appSrc, "annotationHost");
  check(ah.indexOf('closest(".ctext")') !== -1 && ah.indexOf("cimg") === -1, "annotationHost resolves a choice by .ctext and knows nothing of .cimg — an image choice is no region");
  check(/window\.AppSanitize\.annotationHost = annotationHost;/.test(appSrc), "annotationHost is exposed for the browser proof");
  check(!/\bimg\b/.test(fs.readFileSync("render.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "")), "render.js still emits no <img> (grep, comments stripped)");
}

console.log("--- 6. the browser proof carries the same fixture ---");
{
  const proof = fs.readFileSync("tests/injection-proof.js", "utf8");
  check(F.URIS.every(u => proof.indexOf(u) !== -1), "tests/injection-proof.js embeds all four fixture URIs verbatim (it is pasted into a console and cannot require this file)");
}

console.log("--- 7. the stem figure goes through the same guard (ruling 2026-10-07) ---");
{
  const figureSrc = new Function(extractConst(appSrc, "CHOICE_IMAGE_RE") + "\n" + extractFn(appSrc, "figureSrc") + "\nreturn figureSrc;")();
  check(figureSrc({ figure: F.URIS[0] }) === F.URIS[0], "figureSrc returns a data:image/png figure unchanged");
  check(figureSrc({ figure: "https://evil.example/f.png" }) === null && figureSrc({ figure: "javascript:1" }) === null &&
        figureSrc({ figure: "" }) === null && figureSrc({}) === null && figureSrc({ figure: 5 }) === null && figureSrc(null) === null,
    "figureSrc refuses http(s), javascript:, an empty string, a missing or non-string figure, a null question");
  const frame = extractFn(appSrc, "figureFrameHtml");
  check(frame.indexOf("const src = figureSrc(q);") !== -1 && frame.indexOf('src="${escapeHtml(src)}"') !== -1 && frame.indexOf("escapeHtml(q.figure)") === -1,
    "figureFrameHtml renders the GUARDED source into the attribute, never q.figure directly");
  check(frame.indexOf("fig-missing") !== -1 && /\$\{src \? `<div class="fig-toolbar">/.test(frame), "a figure outside the grammar renders the placeholder with no toolbar");
  const handlers = extractFn(appSrc, "attachFigureHandlers");
  check(handlers.indexOf("if(!figureSrc(q)) return;") !== -1 && handlers.indexOf('el("figOverlayImg").src = figureSrc(q);') !== -1 && handlers.indexOf("= q.figure") === -1,
    "attachFigureHandlers and the expand overlay use the guarded source too");
  /* every shipped figure — current builds, archived builds, banks — passes */
  function loadData(file){ const c = { window: { __TESTDATA__: {}, __BANKDATA__: {} } }; vm.createContext(c); vm.runInContext(fs.readFileSync(file, "utf8"), c); return c.window; }
  const manifest = loadData("testdata/manifest.js").TEST_MANIFEST;
  const banks = loadData("testdata/bank-manifest.js").BANK_MANIFEST;
  let figures = 0; const rejected = [];
  const sweep = (where, qs) => qs.forEach(q => { if(q && q.figure !== undefined){ figures++; if(figureSrc(q) !== q.figure) rejected.push(where + ":" + (q.id || q.qid)); } });
  manifest.forEach(e => { const t = loadData("testdata/" + e.testId + ".js").__TESTDATA__[e.testId]; t.modules.forEach(m => sweep(e.testId, m.questions)); });
  fs.readdirSync("testdata/archive").filter(f => f.indexOf("@") !== -1 && /\.js$/.test(f)).forEach(f => {
    const id = f.split("@")[0]; const t = loadData("testdata/archive/" + f).__TESTDATA__[id]; t.modules.forEach(m => sweep(f, m.questions)); });
  banks.forEach(b => { const bank = loadData("testdata/" + b.bankId + ".js").__BANKDATA__[b.bankId]; sweep(b.bankId, bank.questions || []); });
  check(figures >= 500 && rejected.length === 0, "LIBRARY: every shipped figure (" + figures + " across current builds, archived builds and banks) passes the guard unchanged", rejected.slice(0, 8).join(", "));
}

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
