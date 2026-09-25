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
  "testVersion": "2026-09-23-a",
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
  "testVersion": "2026-08-19-a",
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
  "testVersion": "2026-09-23-a",
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
  "testVersion": "2026-09-04-a",
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
  "testVersion": "2026-09-23-a",
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
  "testVersion": "2026-09-23-a",
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
  "testVersion": "2026-09-23-a",
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
  "testId": "202506asiav2",
  "testName": "2025 June Asia v2",
  "testVersion": "2026-09-23-a",
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
  "testId": "202503usv1",
  "testName": "2025 March US v1",
  "testVersion": "2026-09-23-a",
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
  "testId": "202503usv2",
  "testName": "2025 March US v2",
  "testVersion": "2026-09-23-a",
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
  "testId": "202509asiav2",
  "testName": "2025 September Asia v2",
  "testVersion": "2026-09-23-a",
  "moduleCount": 4,
  "questionCount": 97,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 43
   }
  ],
  "legacyIds": []
 },
 {
  "testId": "202512usv2",
  "testName": "2025 December US v2",
  "testVersion": "2026-09-23-a",
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
  "testId": "202506asiav4",
  "testName": "2025 June Asia v4",
  "testVersion": "2026-09-23-a",
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
  "testId": "202608intv1",
  "testName": "2026 August International v1",
  "testVersion": "2026-09-23-a",
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
   "202608asiav1"
  ]
 },
 {
  "testId": "202608usv0",
  "testName": "2026 August US v0",
  "testVersion": "2026-09-23-a",
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
  "testId": "202408usv2",
  "testName": "2024 August US v2",
  "testVersion": "2026-09-23-a",
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
  "legacyIds": [],
  "pathway": "harder"
 },
 {
  "testId": "202506usv1",
  "testName": "2025 June US v1",
  "testVersion": "2026-09-08-a",
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
  "legacyIds": [],
  "pathway": "harder"
 },
 {
  "testId": "202412asiav1",
  "testName": "2024 December Asia v1",
  "testVersion": "2026-09-23-a",
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
  "legacyIds": [],
  "pathway": "harder"
 },
 {
  "testId": "202406intv1",
  "testName": "2024 June International v1",
  "testVersion": "2026-09-23-a",
  "moduleCount": 4,
  "questionCount": 97,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 43
   }
  ],
  "legacyIds": [],
  "pathway": "harder"
 },
 {
  "testId": "202412usv1",
  "testName": "2024 December US v1",
  "testVersion": "2026-09-24-a",
  "moduleCount": 4,
  "questionCount": 97,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 43
   }
  ],
  "legacyIds": [],
  "pathway": "harder"
 },
 {
  "testId": "202505usv1",
  "testName": "2025 May US v1",
  "testVersion": "2026-09-24-a",
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
  "legacyIds": [],
  "pathway": "harder"
 },
 {
  "testId": "202512asiav1",
  "testName": "2025 December Asia v1",
  "testVersion": "2026-09-24-a",
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
  "legacyIds": [],
  "pathway": "harder"
 },
 {
  "testId": "202503asiav2",
  "testName": "2025 March Asia v2",
  "testVersion": "2026-09-24-a",
  "moduleCount": 4,
  "questionCount": 97,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 43
   }
  ],
  "legacyIds": [],
  "pathway": "harder"
 },
 {
  "testId": "202510usv1",
  "testName": "2025 October US v1",
  "testVersion": "2026-09-25-a",
  "moduleCount": 4,
  "questionCount": 97,
  "sections": [
   {
    "section": "Reading and Writing",
    "moduleCount": 2,
    "questionCount": 54
   },
   {
    "section": "Math",
    "moduleCount": 2,
    "questionCount": 43
   }
  ],
  "legacyIds": [],
  "pathway": "easier"
 }
];
