# Judge validation

Files here are the protocol of DESIGN 8.2, in this order.

1. `npm run judge:sample -- --n 30` (from `api/`, or `docker compose exec api npm run judge:sample -- --n 30`)
   draws judge-graded trials, stratified by task and config, and writes `sample.jsonl`. Each line has
   `trial_id`, `grader_index`, `task_id`, `task_prompt`, `rubric` and `inputs` (the text the judge was
   shown), and nothing else: no verdict, no reasoning, no config (D-15).
2. Label every line against the rubric, literally, and write `labels.jsonl`, 1 object per line:

   ```json
   {"trial_id": "01M5...", "grader_index": 0, "human_passed": true, "labeler": "author", "note": "optional"}
   ```

   `human_passed` is true only when every criterion of the rubric is met by the inputs. `labeler` is
   required, so a second rater can be added without a schema change.
3. `npm run judge:kappa` joins the labels to the judge's verdicts, stores them (`judge_label`), computes
   raw agreement, Cohen's kappa and a 95 percent bootstrap interval (10,000 resamples, seed 20261023)
   and writes a `judge_validation` row. kappa 0.6 or more is `trusted`, 0.4 to below 0.6 is `flagged`,
   below 0.4 is `excluded`; a judge with no row is `excluded` (D-16). With labels by more than 1
   labeler, pass `--labeler <name>`.

`sample.jsonl` and `labels.jsonl` are committed once P5 produces them, as the audit trail.
