-- P6: a cause for every failed trial (cards/P6.md section 4). The category is derived by pure rules over the trace and the grader
-- results (api/src/failures/rules.ts); the evidence is the matched rule and the trace event or grader index it used.

CREATE TYPE "failure_category" AS ENUM (
  'step_exhaustion',
  'timeout',
  'hallucinated_tool_args',
  'wrong_tool_usage',
  'tool_error_unrecovered',
  'no_final_answer',
  'gave_up_early',
  'judge_criteria_unmet',
  'grader_disagreement',
  'memory_ignored',
  'abstained',
  'wrong_answer'
);

ALTER TABLE "trial"
  ADD COLUMN "failure_category" "failure_category",
  ADD COLUMN "failure_evidence" JSONB;

-- Evidence travels with the category.
ALTER TABLE "trial"
  ADD CONSTRAINT trial_failure_evidence_iff_category CHECK ((failure_evidence IS NOT NULL) = (failure_category IS NOT NULL));

-- failure_category IS NOT NULL iff status = 'done' AND passed = false. NOT VALID: rows written before this migration have no
-- category until `npm run failures:backfill` runs, and a plain ADD CONSTRAINT would refuse to start on a database that holds any.
-- The constraint is enforced for every insert and update from here on. It is validated below when no old row needs a category
-- (an empty or new database), and by the backfill when it has filled the old rows.
ALTER TABLE "trial"
  ADD CONSTRAINT trial_failure_category_iff_failed
  CHECK ((failure_category IS NOT NULL) = (status = 'done' AND passed IS FALSE)) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "trial" WHERE status = 'done' AND passed IS FALSE) THEN
    ALTER TABLE "trial" VALIDATE CONSTRAINT trial_failure_category_iff_failed;
  END IF;
END $$;
