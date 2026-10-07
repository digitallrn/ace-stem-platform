/* tests/image-choice-fixture.js — the one image-choice item the suites share
   (no shipped test carries the shape yet: the converter emits it later, see
   IMAGE-CHOICES-SPEC.md). Four distinct 4×3 PNGs (red, green, blue, amber),
   generated once with node's zlib and pinned here as data URIs, so every
   check — the node renderer suite, keep-classes' grammar audit, and the
   browser injection proof, which embeds the SAME four strings because it is
   pasted into a console — renders the same bytes.

   node: const F = require("./image-choice-fixture");  F.URIS, F.question()
   browser (pasted): the proof carries URIS verbatim; image-choice.test.js
   pins that the two copies are identical. */
(function(root){
  "use strict";
  const URIS = [
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGM4oaEBRww4OQAHpg0hlLAT/AAAAABJRU5ErkJggg==",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGPQWGADRww4OQDs3wwxgy58EwAAAABJRU5ErkJggg==",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGPQCDgBRww4OQAdNg8B7MAzwQAAAABJRU5ErkJggg==",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGN4tkoEjhhwcgCJ9hOxCBph0wAAAABJRU5ErkJggg=="
  ];
  /* the shape the converter will emit: four {image} objects, index key, no alt */
  function question(id){
    return { id: id || "ma2-q4", type: "mcq", passage: null,
      questionText: "Which of the following graphs in the {{m}}xy{{/m}}-plane could represent the solutions to the system?",
      choices: URIS.map(u => ({ image: u })),
      correctAnswer: 3, difficulty: null, skill: "Linear inequalities in one or two variables", tags: [] };
  }
  const api = { URIS: URIS, question: question };
  if(typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IMAGE_CHOICE_FIXTURE = api;
})(typeof window !== "undefined" ? window : this);
