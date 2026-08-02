/* grading.js — answer matching.

   SPR grading follows the real Bluebook rule, NOT a tolerance band. The
   student-produced response field holds 5 characters (6 including a minus
   sign), and the on-screen directions say what to do when the answer does not
   fit: a fraction that doesn't fit may be entered as its decimal equivalent,
   and a decimal that doesn't fit may be entered by TRUNCATING OR ROUNDING at
   the fourth digit. The directions' own Acceptable / Unacceptable table is the
   specification. For 2/3 it accepts

       2/3   .6666   .6667   0.666   0.667

   and rejects

       0.66   .66   0.67   .67

   Two things follow from that table, and they are the whole design:

   1. Acceptance is a SET OF VALUES, not a neighbourhood. .6666 and .6667 are
      in; .66 and .67 are out — even though .67 is closer to 2/3 than .666 is.
      The question is never "how near is this?" but "is this what you get by
      truncating or rounding the real value to a length that fits?".

   2. Both .6666 (four decimals, written ".") and 0.666 (three decimals,
      written "0.") are acceptable, because each FILLS the five-character
      field in its own written form. .66 is rejected because the student had
      room for more precision and did not use it. So the permitted precisions
      are derived from the field width and the way the number has to be
      written — not fixed at four.

   The old implementation compared with a fixed +/-0.01. That is wrong in both
   directions, and dangerously so for small answers: with the key .0138
   (202511asiav1 m1-q6, the truncated form of 1/72) the tolerance was larger
   than the answer itself, so .02 and .005 both graded correct.

   A key that is itself a truncation cannot be expanded back into the exact
   value — .0138 does not know it came from 1/72 — so the other acceptable
   forms belong in `alt_answers`, which is the explicit override and is
   checked with exactly the same rule. The test bank already does this
   (202511asiav1 records "1/72|.0139|0.0139").                              */

/* Kept for callers that want a plain number; returns null for non-fractions. */
function toFraction(str){
    const m = String(str).trim().match(/^-?\d+\s*\/\s*\d+$/);
    if(!m) return null;
    const parts = str.split("/");
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if(den === 0 || isNaN(num) || isNaN(den)) return null;
    return num/den;
  }

  /* The field: 5 characters, or 6 when a minus sign is present. */
  const SPR_MAX_CHARS = 5;
  /* Nothing legitimate — no converter key, no alt, and certainly no entry the
     5/6-character field can hold — comes near this. Bounding here is what
     keeps every product below Number.MAX_SAFE_INTEGER: with |n| and d both
     under 1e7, ratEq's cross-products stay under 1e14 and truncAt's n*p under
     1e11. Without the bound a long value read out of a RECORD (which
     ATTEMPTS-SPEC §7 says anyone can write) overflowed to Infinity, and
     Infinity === Infinity made it grade correct against almost every key. */
  const SPR_MAX_TERM = 1e7;

  /* Exact rational parse — no floats, so .1 + .2 style error can never decide
     a student's score. Accepts "7", "-189", ".5", "5.", "9.96", "-1/3".
     Returns null for anything that is not a finite, in-range value. */
  function sprParseExact(s){
    const t = String(s == null ? "" : s).trim();
    if(!t || t.length > 24) return null;          // nothing real is this long
    let m = t.match(/^(-?)(\d+)\s*\/\s*(\d+)$/);
    if(m){
      const num = Number(m[2]), den = Number(m[3]);
      if(!den || !isFinite(num) || !isFinite(den)) return null;   // x/0 is not a value
      if(num > SPR_MAX_TERM || den > SPR_MAX_TERM) return null;
      return { n: (m[1] ? -1 : 1) * num, d: den };
    }
    m = t.match(/^(-?)(\d*)(?:\.(\d*))?$/);
    if(!m) return null;
    const ip = m[2] || "", fp = m[3] || "";
    if(!ip && !fp) return null;                   // "", "-", "." are not values
    const n = Number(ip + fp), d = Math.pow(10, fp.length);
    if(!isFinite(n) || !isFinite(d) || n > SPR_MAX_TERM || d > SPR_MAX_TERM) return null;
    return { n: (m[1] ? -1 : 1) * n, d };
  }

  function ratEq(a, b){ return a.n * b.d === b.n * a.d; }
  function ratIsZero(a){ return a.n === 0; }

  function sprGcd(a, b){
    a = Math.abs(a); b = Math.abs(b);
    while(b){ const t = a % b; a = b; b = t; }
    return a;
  }
  /* How many decimal places the value needs to be written EXACTLY, or null if
     it never terminates (1/3). A denominator of only 2s and 5s terminates. */
  function sprExactPlaces(a){
    const g = sprGcd(a.n, a.d) || 1;
    let d = a.d / g, twos = 0, fives = 0;
    while(d % 2 === 0){ d /= 2; twos++; }
    while(d % 5 === 0){ d /= 5; fives++; }
    if(d !== 1) return null;
    return Math.max(twos, fives);
  }

  /* Can the answer be written EXACTLY inside the field? This is the
     precondition the directions put on shortening: "If your answer is a
     decimal that DOESN'T FIT in the provided space, enter it by truncating or
     rounding at the fourth digit." Without this check the rule offered a
     shortened form even when the exact value was writable, which handed out
     credit for plainly wrong answers — .188 for 3/16 (=.1875, which fits),
     and worse, a bare 0 for any key below .001, because truncating those to
     three places collapses them to zero. */
  function sprFitsExactly(a){
    const dp = sprExactPlaces(a);
    if(dp === null) return false;                 // never terminates
    const mag = Math.abs(a.n) / a.d;
    const intDigits = String(Math.floor(mag)).length;
    const avail = SPR_MAX_CHARS;                  // the sign gets its own slot
    if(dp === 0) return intDigits <= avail;       // an integer needs no point
    if(intDigits + 1 + dp <= avail) return true;  // "I.ddd"
    if(mag < 1 && 1 + dp <= avail) return true;   // ".dddd"
    return false;
  }

  /* Truncate / round a rational to k decimal places, exactly.
     `a.n * p` and `a.d` are both safe integers here (keys are short), and a
     non-zero remainder is at least 1, so the true quotient sits at least
     1/a.d away from the integer boundary — far outside double error. The
     divisions below are therefore safe to trunc/round directly. */
  function truncAt(a, k){
    const p = Math.pow(10, k);
    return { n: Math.trunc((a.n * p) / a.d), d: p };
  }
  function roundAt(a, k){
    const p = Math.pow(10, k);
    const q = (a.n * p) / a.d;
    // half away from zero, the ordinary reading of "rounding"
    return { n: q >= 0 ? Math.floor(q + 0.5) : Math.ceil(q - 0.5), d: p };
  }

  /* How many decimal places can actually be entered — one entry per way the
     number can legally be written, because that is what makes both .6666 and
     0.666 acceptable while .66 is not.
       |v| < 1 : ".dddd" leaves 4, and "0.ddd" leaves 3
       |v| >= 1: "II.dd" leaves (width - digits - 1)
     A value whose integer part already fills the field (62951) yields none,
     so only the exact value is accepted. */
  function sprCapacities(a){
    const avail = SPR_MAX_CHARS;                  // the sign gets its own slot
    const mag = Math.abs(a.n) / a.d;
    const out = [];
    if(mag < 1){
      /* Both writable forms, which is what makes .6666 AND 0.666 acceptable
         for 2/3 while .66 is not. Never zero places: "0" is not a shortening
         of a sub-1 answer, it is a different (wrong) answer. */
      if(avail - 1 >= 1) out.push(avail - 1);                    // ".dddd"
      if(avail - 2 >= 1) out.push(avail - 2);                    // "0.ddd"
    } else {
      const intDigits = String(Math.floor(mag)).length;
      const withInt = avail - intDigits - 1;                     // "II.dd"
      if(withInt >= 1) out.push(withInt);
      else if(intDigits <= avail) out.push(0);
      /* Zero places ONLY when no decimal form is writable at all. 1562.5 and
         62951.5 cannot be written in five characters, so 1562/1563 and
         62951/62952 are the only entries that fit — without this such a key
         accepted nothing and the item was unanswerable. But 43/3 CAN be
         written to two places as 14.33, so "14" is not a shortening it is
         allowed to stop at, exactly as .66 is not for 2/3. Note the integer
         form carries no decimal point, which is why it is not `avail - digits
         - 1`. */
    }
    return out;
  }

  /* Does this entry name the same answer as this key? */
  function sprValueMatches(given, key){
    const a = String(given).trim(), b = String(key).trim();
    if(a.toLowerCase() === b.toLowerCase()) return true;   // typed it verbatim
    const ga = sprParseExact(a), gb = sprParseExact(b);
    if(!ga || !gb) return false;
    if(ratEq(ga, gb)) return true;                         // same exact value
    /* Shortening is licensed ONLY when the exact answer cannot be written in
       the field. If it fits, the exact value is the only acceptable entry. */
    if(sprFitsExactly(gb)) return false;
    const caps = sprCapacities(gb);
    for(let i = 0; i < caps.length; i++){
      const t = truncAt(gb, caps[i]), r = roundAt(gb, caps[i]);
      /* A shortening that collapses a non-zero answer to zero is not an
         answer — it is the absence of one. 1/3000 truncated to three places
         is 0, and "0" must never be credited for it. */
      if(!ratIsZero(t) && ratEq(ga, t)) return true;
      if(!ratIsZero(r) && ratEq(ga, r)) return true;
    }
    return false;
  }

  function hasKey(q){ return q.correctAnswer !== null && q.correctAnswer !== undefined; }

  function answerMatches(q, given){
    if(!hasKey(q)) return false;                       // "No key yet" — never graded
    if(q.type === "spr"){
      const keys = [q.correctAnswer].concat(q.altAnswers || []);   // schema v1.2 §4
      return keys.some(k => sprValueMatches(given, k));
    }
    return given === q.correctAnswer;
  }
