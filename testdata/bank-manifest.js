/* testdata/bank-manifest.js — the bank-lane manifest, loaded by the set
   builder only. One entry per question bank, each explicitly typed
   "bank". DELIBERATELY a separate file from testdata/manifest.js: the app
   renders every TEST_MANIFEST entry as a sittable test, so a bank must
   never enter that list. bankIds are internal (bank-<slug>); students
   never see them. */
window.BANK_MANIFEST = [
 {
  "bankId": "bank-david-core",
  "type": "bank",
  "owner": "david",
  "bankName": "David’s Core Question Bank",
  "bankVersion": "sha-23154ea489a4",
  "questionCount": 1,
  "activeCount": 1,
  "retiredCount": 0,
  "subjectCounts": {
   "rw": 0,
   "math": 1
  }
 },
 {
  "bankId": "bank-202608-salvage",
  "type": "bank",
  "owner": "david",
  "bankName": "2026 August salvage",
  "bankVersion": "sha-c373526f5b01",
  "questionCount": 245,
  "activeCount": 187,
  "retiredCount": 58,
  "subjectCounts": {
   "rw": 79,
   "math": 108
  }
 }
];
