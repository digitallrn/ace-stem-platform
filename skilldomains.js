/* skilldomains.js — the single source translating each fine SAT skill string
   to its College Board reporting DOMAIN, for the Score Details domain rollup.

   DELIBERATELY DUPLICATED with the test-bank repo's tagging contract: the fine
   skill strings below are byte-for-byte identical to the ones the test-bank
   pass writes into `question.skill`, and a vocabulary change must touch BOTH
   repos. This file is data, not logic — it defines one global and has no side
   effects. Plain non-module script (loaded before app.js by load order), so
   the global is what app.js reads.

   Contract the consumer (app.js mapDomain) relies on:
   - domainOf(null | "" | whitespace)  -> null.  An ABSENT skill is the caller's
     concern, not ours: today every shipped question has skill:null, and the
     caller turns null into "Other", which is exactly what keeps a fully
     untagged test rendering as it does now.
   - domainOf(known fine skill)         -> its domain (one of the eight below).
   - domainOf(unrecognized non-empty)   -> null.  The caller then groups it
     under its own raw string — NEVER silently dropped.
   Matching is EXACT after trimming: no case-folding and no substring games, so
   a mistagged or misspelled skill surfaces as its own visible group rather than
   quietly mis-rolling into the wrong domain. */
window.SKILL_DOMAINS = (function(){
  "use strict";

  /* domain -> [fine skills].  The eight domains are the College Board reporting
     categories; app.js owns their DISPLAY order (parent-report order). The map
     here is order-independent — it exists only to answer "which domain?". */
  var GROUPS = {
    "Information and Ideas": [
      "Central Ideas and Details",
      "Command of Evidence (Textual)",
      "Command of Evidence (Quantitative)",
      "Inferences"
    ],
    "Craft and Structure": [
      "Words in Context",
      "Text Structure and Purpose",
      "Cross-Text Connections"
    ],
    "Expression of Ideas": [
      "Rhetorical Synthesis",
      "Transitions"
    ],
    "Standard English Conventions": [
      "Boundaries",
      "Form, Structure, and Sense"
    ],
    "Algebra": [
      "Linear equations in one variable",
      "Linear functions",
      "Linear equations in two variables",
      "Systems of two linear equations in two variables",
      "Linear inequalities in one or two variables"
    ],
    "Advanced Math": [
      "Equivalent expressions",
      "Nonlinear equations in one variable and systems of equations in two variables",
      "Nonlinear functions"
    ],
    "Problem-Solving and Data Analysis": [
      "Ratios, rates, proportional relationships, and units",
      "Percentages",
      "One-variable data: Distributions and measures of center and spread",
      "Two-variable data: Models and scatterplots",
      "Probability and conditional probability",
      "Inference from sample statistics and margin of error",
      "Evaluating statistical claims: Observational studies and experiments"
    ],
    "Geometry and Trigonometry": [
      "Area and volume",
      "Lines, angles, and triangles",
      "Right triangles and trigonometry",
      "Circles"
    ]
  };

  var skillToDomain = {};
  Object.keys(GROUPS).forEach(function(domain){
    GROUPS[domain].forEach(function(skill){ skillToDomain[skill] = domain; });
  });

  function domainOf(skill){
    if(skill == null) return null;
    var key = String(skill).trim();
    if(!key) return null;
    return Object.prototype.hasOwnProperty.call(skillToDomain, key)
      ? skillToDomain[key] : null;
  }

  /* Ordered fine skills for a domain (contract order), so the render can list a
     domain's skills canonically instead of in test order. Unknown domain -> []. */
  function skillsFor(domain){
    return GROUPS[domain] ? GROUPS[domain].slice() : [];
  }

  return { skillToDomain: skillToDomain, domainOf: domainOf, skillsFor: skillsFor };
})();
