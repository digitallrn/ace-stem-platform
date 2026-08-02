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

  /* Exact rational parse — no floats, so .1 + .2 style error can never decide
     a student's score. Accepts "7", "-189", ".5", "5.", "9.96", "-1/3". */
  function sprParseExact(s){
    const t = String(s == null ? "" : s).trim();
    let m = t.match(/^(-?)(\d+)\s*\/\s*(\d+)$/);
    if(m){
      const den = Number(m[3]);
      if(!den) return null;                       // x/0 is not a value
      return { n: (m[1] ? -1 : 1) * Number(m[2]), d: den };
    }
    m = t.match(/^(-?)(\d*)(?:\.(\d*))?$/);
    if(!m) return null;
    const ip = m[2] || "", fp = m[3] || "";
    if(!ip && !fp) return null;                   // "", "-", "." are not values
    return { n: (m[1] ? -1 : 1) * Number(ip + fp), d: Math.pow(10, fp.length) };
  }

  function ratEq(a, b){ return a.n * b.d === b.n * a.d; }

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
    const intDigits = String(Math.floor(mag)).length;
    const out = [];
    if(mag < 1 && avail - 1 >= 1) out.push(avail - 1);          // ".dddd"
    const withInt = avail - intDigits - 1;                       // "I.ddd"
    if(withInt >= 1 && out.indexOf(withInt) === -1) out.push(withInt);
    return out;
  }

  /* Does this entry name the same answer as this key? */
  function sprValueMatches(given, key){
    const a = String(given).trim(), b = String(key).trim();
    if(a.toLowerCase() === b.toLowerCase()) return true;   // typed it verbatim
    const ga = sprParseExact(a), gb = sprParseExact(b);
    if(!ga || !gb) return false;
    if(ratEq(ga, gb)) return true;                         // same exact value
    /* Otherwise the only acceptable entries are the shortened forms the field
       forces: truncate or round the key at each precision that fills it. */
    const caps = sprCapacities(gb);
    for(let i = 0; i < caps.length; i++){
      if(ratEq(ga, truncAt(gb, caps[i]))) return true;
      if(ratEq(ga, roundAt(gb, caps[i]))) return true;
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
