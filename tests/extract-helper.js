/* tests/extract-helper.js — shared by tests/timer-drift.test.js and
   tests/assignment-delete.test.js (not itself a test suite; nothing to run).

   app.js is a DOM-heavy single IIFE with no exports, so it can't be
   `require()`d or vm-loaded whole the way attempts.js can (see
   tests/local-mode.test.js). Both of the above tests instead pull specific
   top-level functions/consts out of app.js by source text and evaluate just
   those in a minimal harness — this is the shared brace/statement-matching
   logic that extraction needs, factored into one place so a future fix to it
   (e.g. skipping braces inside a string or regex literal) only has to be
   made once. */

function extractFn(src, name){
  const re = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{");
  const m = re.exec(src);
  if(!m) throw new Error("function not found in app.js: " + name);
  let i = m.index + m[0].length, depth = 1;
  while(depth > 0 && i < src.length){
    if(src[i] === "{") depth++;
    else if(src[i] === "}") depth--;
    i++;
  }
  return src.slice(m.index, i);
}

function extractConst(src, name){
  const re = new RegExp("const\\s+" + name + "\\s*=\\s*");
  const m = re.exec(src);
  if(!m) throw new Error("const not found in app.js: " + name);
  let i = m.index + m[0].length, depth = 0;
  while(i < src.length){
    const c = src[i];
    if(c === "(" || c === "{" || c === "[") depth++;
    else if(c === ")" || c === "}" || c === "]") depth--;
    else if(c === ";" && depth === 0) break;
    i++;
  }
  return src.slice(m.index, i + 1);
}

module.exports = { extractFn, extractConst };
