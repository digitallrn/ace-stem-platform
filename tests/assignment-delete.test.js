/* tests/assignment-delete.test.js — run: node tests/assignment-delete.test.js
   (from the repo root)

   Work Item 4 (delete an attempt from the tutor dashboard) has one hard
   constraint: deleting a completed attempt's record must NOT reopen its
   assignment for a retake. dashboard.js's deleteAttempt() only ever removes
   the attempt row itself — it never touches the assignment row — so this
   proves that's sufficient by exercising the REAL completion logic app.js
   uses to decide whether a card reads "Start" or "Completed":
   assignmentComplete()/assignmentState(), fed by buildAssignmentIndex().

   app.js is a DOM-heavy single IIFE with no exports (see the note atop
   tests/timer-drift.test.js for why it can't be vm-loaded whole); these
   particular functions don't touch the DOM at all, so they're pulled out by
   source text and evaluated with a plain `state` object standing in for
   app.js's closure state — same extraction technique, applied to a
   different cluster of functions. */

const fs = require("fs");
const path = require("path");
const repo = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(repo, "app.js"), "utf8");
const { extractFn, extractConst } = require("./extract-helper");

const FN_NAMES = ["archivedVersions", "canServeVersion", "testById", "attemptCompleted",
  "attemptResumable", "canonTestId", "isLegacyAssign", "categoryMatchesConditions",
  "buildAssignmentIndex", "assignmentComplete", "assignmentState"];
const CONST_NAMES = ["TESTCACHE_PREFIX", "byStartDesc"];

const body = CONST_NAMES.map(n => extractConst(appSrc, n)).join("\n") + "\n\n" +
  FN_NAMES.map(n => extractFn(appSrc, n)).join("\n\n") +
  "\nreturn { buildAssignmentIndex, assignmentComplete, assignmentState };";

function makeWorld(state){
  const window = { TEST_ARCHIVE_INDEX: undefined, __TESTDATA__: {} };
  const localStorage = { getItem: () => null };
  const factory = new Function("state", "window", "localStorage", body);
  return factory(state, window, localStorage);
}

let pass = true;
const check = (ok, label, detail) => {
  if(!ok) pass = false;
  console.log((ok ? "PASS" : "FAIL") + " | " + label.padEnd(64) + (detail || ""));
};

/* ---- setup: one practice assignment, one completed attempt tied to it,
   exactly as app.js's real finalize->completeAssignment path leaves things:
   both signals present (the record itself, AND the completedAttemptId hint
   persisted onto the assignment row) ---- */
const assignment = { assignmentId: "a1", testId: "t1", category: "practice",
  completedAttemptId: "attempt:t1:1700000000:abcd" };
const state = {
  tests: [{ testId: "t1", testName: "Test One", testVersion: "v1", legacyIds: [] }],
  assignments: [assignment],
  assignAttempts: {}
};
const completedRecord = { testId: "t1", testVersion: "v1", assignmentId: "a1",
  status: "completed", conditions: "self-administered", startedAt: "2026-08-01T00:00:00Z" };

const world = makeWorld(state);

/* 1. before any delete: the assignment reads completed, as it should */
world.buildAssignmentIndex([completedRecord]);
check(world.assignmentComplete(assignment) === true,
  "before delete: assignmentComplete() is true");
check(world.assignmentState(assignment) === "completed",
  "before delete: assignmentState() is \"completed\" (card shows Completed, not Start)");

/* 2. the delete itself: dashboard.js's deleteAttempt() removes ONLY the
   attempt row. It never writes to the assignment row, so completedAttemptId
   is untouched — simulated here by just dropping the record from the list
   buildAssignmentIndex sees, same as a re-read of storage after the row is
   gone, while `assignment.completedAttemptId` stays exactly as it was. */
world.buildAssignmentIndex([]);
check(world.assignmentComplete(assignment) === true,
  "after delete: assignmentComplete() is STILL true (completedAttemptId survives)");
check(world.assignmentState(assignment) === "completed",
  "after delete: assignmentState() is STILL \"completed\" — card does not offer Start again");

/* 3. control: this invariant is load-bearing, not vacuous — without the
   persisted completedAttemptId hint (e.g. a pre-2026-08-01 record, or a
   assignment that predates the hint being written), losing the record DOES
   flip the assignment back to startable. This is what completedAttemptId
   exists to prevent, and it's the reason deleteAttempt() must never clear or
   touch it. */
const assignmentNoHint = { assignmentId: "a2", testId: "t1", category: "practice" };
const stateNoHint = {
  tests: state.tests, assignments: [assignmentNoHint], assignAttempts: {}
};
const worldNoHint = makeWorld(stateNoHint);
const completedRecord2 = Object.assign({}, completedRecord, { assignmentId: "a2" });
worldNoHint.buildAssignmentIndex([completedRecord2]);
check(worldNoHint.assignmentComplete(assignmentNoHint) === true,
  "control: without a hint, completion still derives from the record while it exists");
worldNoHint.buildAssignmentIndex([]);
check(worldNoHint.assignmentComplete(assignmentNoHint) === false &&
      worldNoHint.assignmentState(assignmentNoHint) === "ready",
  "control: without completedAttemptId, losing the record DOES reopen the assignment",
  "(this is exactly what the persisted hint exists to prevent)");

console.log(pass ? "\nALL ASSIGNMENT-DELETE CASES PASS" : "\nFAILURES PRESENT");
process.exit(pass ? 0 : 1);
