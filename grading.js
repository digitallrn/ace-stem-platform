function toFraction(str){
    const m = String(str).trim().match(/^-?\d+\s*\/\s*\d+$/);
    if(!m) return null;
    const parts = str.split("/");
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if(den === 0 || isNaN(num) || isNaN(den)) return null;
    return num/den;
  }

  function sprValueMatches(given, key){
    const a = String(given).trim();
    const b = String(key).trim();
    if(a.toLowerCase() === b.toLowerCase()) return true;
    const aNum = toFraction(a) ?? parseFloat(a);
    const bNum = toFraction(b) ?? parseFloat(b);
    if(!isNaN(aNum) && !isNaN(bNum)) return Math.abs(aNum-bNum) < 0.01;
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
