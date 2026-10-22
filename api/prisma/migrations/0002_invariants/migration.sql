-- Invariants from DATA_MODEL.md that Prisma cannot express. Each is tested in
-- api/src/db/invariants.spec.ts by attempting the forbidden write.

-- ---------------------------------------------------------------- column CHECKs

ALTER TABLE "model"
  ADD CONSTRAINT model_id_format CHECK (id ~ '^[a-z0-9-]+$'),
  ADD CONSTRAINT model_input_price_nonneg CHECK (input_price_per_mtok >= 0),
  ADD CONSTRAINT model_output_price_nonneg CHECK (output_price_per_mtok >= 0),
  ADD CONSTRAINT model_context_window_pos CHECK (context_window > 0),
  ADD CONSTRAINT model_roles_subset CHECK (roles <@ ARRAY['candidate', 'judge']::text[]);

ALTER TABLE "harness"
  ADD CONSTRAINT harness_id_format CHECK (id ~ '^[a-z0-9_]+$');

ALTER TABLE "task"
  ADD CONSTRAINT task_id_format CHECK (id ~ '^[a-z]+-[0-9]{2}(-[a-z0-9-]+)?$'),
  ADD CONSTRAINT task_graders_nonempty_array
    CHECK (jsonb_typeof(graders) = 'array' AND jsonb_array_length(graders) > 0),
  ADD CONSTRAINT task_discriminates_subset
    CHECK (discriminates <@ ARRAY['memory', 'skills', 'model', 'harness']::text[]);

ALTER TABLE "experiment"
  ADD CONSTRAINT experiment_n_trials_pos CHECK (n_trials >= 1);

ALTER TABLE "trial"
  ADD CONSTRAINT trial_index_nonneg CHECK (trial_index >= 0),
  ADD CONSTRAINT trial_attempt_count_nonneg CHECK (attempt_count >= 0),
  ADD CONSTRAINT trial_rate_limit_events_nonneg CHECK (rate_limit_events >= 0),
  -- D-11: passed is set iff the trial is done
  ADD CONSTRAINT trial_passed_iff_done CHECK ((status = 'done') = (passed IS NOT NULL)),
  -- DATA_MODEL 2.7: exit_reason NOT NULL iff done
  ADD CONSTRAINT trial_exit_reason_iff_done CHECK ((status = 'done') = (exit_reason IS NOT NULL)),
  -- D-13: an error without a class cannot be routed to the retry policy
  ADD CONSTRAINT trial_errored_has_class CHECK (status <> 'errored' OR error_class IS NOT NULL);

ALTER TABLE "trial_attempt"
  ADD CONSTRAINT trial_attempt_no_pos CHECK (attempt_no >= 1);

ALTER TABLE "grader_result"
  ADD CONSTRAINT grader_judge_model_iff_judge
    CHECK ((grader_type = 'llm_judge') = (judge_model_id IS NOT NULL)),
  ADD CONSTRAINT grader_judge_prompt_iff_judge
    CHECK ((grader_type = 'llm_judge') = (judge_prompt_hash IS NOT NULL));

-- ---------------------------------------------------------------- D-2

-- At most 1 current version per task id. Sync must clear the old row's flag before setting
-- the new one, inside one transaction.
CREATE UNIQUE INDEX task_one_current_per_id ON "task" (id) WHERE is_current;

-- ---------------------------------------------------------------- D-3

-- Configs are immutable. An UPDATE changes 0 rows instead of raising, so a code path that
-- tries it fails visibly in the test and silently-but-harmlessly in production.
CREATE RULE config_no_update AS ON UPDATE TO "config" DO INSTEAD NOTHING;

-- The trace is write-once (DATA_MODEL 2.9, "same rule as D-3").
CREATE RULE trace_no_update AS ON UPDATE TO "trace" DO INSTEAD NOTHING;

-- ---------------------------------------------------------------- D-8

CREATE FUNCTION experiment_reject_completed_with_errored() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'completed' AND EXISTS (
    SELECT 1 FROM "trial" WHERE experiment_id = NEW.id AND status = 'errored'
  ) THEN
    RAISE EXCEPTION 'D-8: experiment % cannot be completed while an errored trial exists', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER experiment_d8_completed_no_errored
  BEFORE INSERT OR UPDATE OF status ON "experiment"
  FOR EACH ROW EXECUTE FUNCTION experiment_reject_completed_with_errored();

-- ---------------------------------------------------------------- D-9

CREATE FUNCTION experiment_reject_n_trials_decrease() RETURNS trigger AS $$
BEGIN
  IF NEW.n_trials < OLD.n_trials THEN
    RAISE EXCEPTION 'D-9: experiment % n_trials cannot decrease (% -> %)', OLD.id, OLD.n_trials, NEW.n_trials
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER experiment_d9_n_trials_only_increases
  BEFORE UPDATE OF n_trials ON "experiment"
  FOR EACH ROW EXECUTE FUNCTION experiment_reject_n_trials_decrease();

-- ---------------------------------------------------------------- D-10

CREATE FUNCTION experiment_reject_preregistration_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
    NEW.hypothesis IS DISTINCT FROM OLD.hypothesis OR NEW.axis IS DISTINCT FROM OLD.axis
  ) THEN
    RAISE EXCEPTION 'D-10: experiment % hypothesis and axis are immutable once status leaves draft', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER experiment_d10_preregistration_immutable
  BEFORE UPDATE OF hypothesis, axis ON "experiment"
  FOR EACH ROW EXECUTE FUNCTION experiment_reject_preregistration_edit();
