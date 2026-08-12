/* testdata/manifest.js — the ONLY test file loaded at startup.
   One entry per test: enough for the home screen, the assignment model and
   version-gating to work without touching a single question. The full file
   testdata/<testId>.js is fetched only when a sitting starts or resumes.
   testId follows the source-PDF convention YYYYMM+region+v# and is INTERNAL:
   students only ever see testName. `legacyIds` lists ids this test used to
   carry, so attempt records written before a rename still resolve. */
window.TEST_MANIFEST = [
 {
  "testId": "202606asiav1",
  "testName": "2026 June Asia v1",
  "testVersion": "2026-08-09-a",
  "moduleCount": 4,
  "questionCount": 98,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 44
   }
  ],
  "legacyIds": [
   "2026-june-asia-v1"
  ]
 },
 {
  "testId": "202606asiav2",
  "testName": "2026 June Asia v2",
  "testVersion": "2026-08-09-a",
  "moduleCount": 4,
  "questionCount": 98,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 44
   }
  ],
  "legacyIds": []
 },
 {
  "testId": "202511asiav1",
  "testName": "2025 November Asia v1",
  "testVersion": "2026-08-05-a",
  "moduleCount": 4,
  "questionCount": 98,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 44
   }
  ],
  "legacyIds": []
 },
 {
  "testId": "202603asiav1",
  "testName": "2026 March Asia v1",
  "testVersion": "2026-08-09-a",
  "moduleCount": 4,
  "questionCount": 98,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 44
   }
  ],
  "legacyIds": []
 },
 {
  "testId": "202510usv3",
  "testName": "2025 October US v3",
  "testVersion": "2026-08-09-a",
  "moduleCount": 4,
  "questionCount": 98,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 44
   }
  ],
  "legacyIds": []
 },
 {
  "testId": "202508asiav1",
  "testName": "2025 August Asia v1",
  "testVersion": "2026-08-11-a",
  "moduleCount": 4,
  "questionCount": 98,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 44
   }
  ],
  "legacyIds": []
 },
 {
  "testId": "202509asiav4",
  "testName": "2025 September Asia v4",
  "testVersion": "2026-08-13-a",
  "moduleCount": 4,
  "questionCount": 98,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 44
   }
  ],
  "legacyIds": []
 }
];
