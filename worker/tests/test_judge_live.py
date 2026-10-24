"""The judge against real model calls (cards/P2.md section 5): the rubric of mem-06 must FAIL a generic
release checklist, and each judged task's rubric must separate a good answer from a plausible bad one.

Skipped unless RUN_LIVE=1 and the judge model's key is in the environment. It costs a few cents.

    host:       RUN_LIVE=1 OPENROUTER_API_KEY=... python -m pytest tests/test_judge_live.py -q
    container:  docker compose exec -e RUN_LIVE=1 worker pytest tests/test_judge_live.py -q

The judge model is the api/seed/models.json row JUDGE_MODEL_ID names (default model-a); inside the
container, which has no seed file, pass JUDGE_MODEL_SLUG instead.
"""
import json
import os
from pathlib import Path

import pytest

from worker.adapters.base import ModelSpec
from worker.graders.llm_judge import JudgeError, grade_llm_judge
from worker.tests.tasks_support import fixture_dir, load_task

pytestmark = pytest.mark.skipif(os.environ.get("RUN_LIVE") != "1", reason="live judge calls: set RUN_LIVE=1")


def judge_model() -> ModelSpec:
    wanted = os.environ.get("JUDGE_MODEL_ID", "model-a")
    seed = Path(__file__).resolve().parents[2] / "api" / "seed" / "models.json"
    slug = os.environ.get("JUDGE_MODEL_SLUG")
    if slug is None and seed.is_file():
        row = next(r for r in json.loads(seed.read_text(encoding="utf-8")) if r["id"] == wanted)
        slug = row["slug"]
    if slug is None:
        pytest.skip("no JUDGE_MODEL_SLUG and no api/seed/models.json")
    return ModelSpec(wanted, slug, "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", 0.0, 0.0, 100000)


def verdict(task_id: str, final: str | None = None, files: dict[str, str] | None = None, tmp_path: Path | None = None):
    """Runs the task's real llm_judge grader on an answer. Workspace files default to the task's own fixture."""
    task = load_task(task_id)
    (spec,) = [g for g in task["graders"] if g["type"] == "llm_judge"]
    workspace = tmp_path / task_id
    workspace.mkdir()
    fx = fixture_dir(task)
    if fx is not None:
        for p in fx.rglob("*"):
            if p.is_file() and "_hidden" not in p.parts:
                (workspace / p.relative_to(fx)).parent.mkdir(parents=True, exist_ok=True)
                (workspace / p.relative_to(fx)).write_bytes(p.read_bytes())
    for rel, body in (files or {}).items():
        (workspace / rel).write_text(body, encoding="utf-8")
    try:
        return grade_llm_judge(spec, task["prompt"], final, str(workspace), judge_model())
    except JudgeError as e:  # three of these in a row is a stop condition (cards/P2.md section 9): report the raw reply
        pytest.fail(f"the judge gave no usable verdict: {e}")


def met(outcome) -> dict[str, bool]:
    return {c["id"]: c["met"] for c in outcome.details["criteria"]}


SPECIFIC = "# Release checklist\n\n1. Bump VERSION\n2. Run python lint.py --strict\n3. Tag the release vX.Y.Z\n4. Post in #releases\n"
REWORDED = (
    "# Releasing\n\n1. Increment the number in the VERSION file.\n2. Lint the code with `python lint.py --strict`.\n"
    "3. Create the git tag `v<major>.<minor>.<patch>` for this version.\n4. Announce the release in the #releases channel.\n"
)
GENERIC = (
    "# Release checklist\n\n1. Update the changelog\n2. Make sure all tests pass\n3. Increase the version number\n"
    "4. Create a release tag in git\n5. Deploy to production\n6. Announce the release to the team\n"
)


class TestMem06TheRubricNeedsTheTeamsSpecifics:
    def test_the_teams_checklist_passes(self, tmp_path):
        out = verdict("mem-06-release", files={"RELEASE.md": SPECIFIC}, tmp_path=tmp_path)
        assert out.passed, out.details["criteria"]

    def test_the_same_steps_in_other_words_pass(self, tmp_path):
        out = verdict("mem-06-release", files={"RELEASE.md": REWORDED}, tmp_path=tmp_path)
        assert out.passed, out.details["criteria"]

    def test_a_generic_release_checklist_fails(self, tmp_path):
        out = verdict("mem-06-release", files={"RELEASE.md": GENERIC}, tmp_path=tmp_path)
        assert not out.passed
        m = met(out)
        assert m["c2"] is False and m["c4"] is False, "the checklist names neither --strict nor #releases"

    def test_dropping_only_the_strict_flag_fails(self, tmp_path):
        out = verdict("mem-06-release", files={"RELEASE.md": SPECIFIC.replace("python lint.py --strict", "python lint.py")}, tmp_path=tmp_path)
        assert not out.passed and met(out)["c2"] is False

    def test_dropping_only_the_channel_fails(self, tmp_path):
        out = verdict("mem-06-release", files={"RELEASE.md": SPECIFIC.replace("Post in #releases", "Tell the team")}, tmp_path=tmp_path)
        assert not out.passed and met(out)["c4"] is False

    def test_no_file_fails(self, tmp_path):
        assert not verdict("mem-06-release", tmp_path=tmp_path).passed


GOOD_SUMMARY = (
    "- Checkout p95 latency rose from 300 ms to 9 s on 2026-09-14 (SEV2, 95 minutes).\n"
    "- Root cause: migration 0042 rebuilt the orders table and did not recreate the index on orders.customer_id, so customer lookups scanned about 12 million rows.\n"
    "- Rolling back the cart service deploy did not help.\n"
    "- Fix: the index was re-created with CREATE INDEX CONCURRENTLY.\n"
    "- Follow-up: a CI check will compare index lists before and after each migration."
)


class TestJudgedTasksSeparateGoodFromPlausiblyBad:
    def test_jdg_01_good_summary_passes(self, tmp_path):
        out = verdict("jdg-01-summary", final=GOOD_SUMMARY, tmp_path=tmp_path)
        assert out.passed, out.details["criteria"]

    def test_jdg_01_an_invented_cause_fails(self, tmp_path):
        bad = GOOD_SUMMARY.replace("migration 0042 rebuilt the orders table and did not recreate the index on orders.customer_id", "a disk failure on the primary database host")
        out = verdict("jdg-01-summary", final=bad, tmp_path=tmp_path)
        assert not out.passed

    def test_jdg_01_six_bullets_fail(self, tmp_path):
        out = verdict("jdg-01-summary", final=GOOD_SUMMARY + "\n- The incident was resolved at 15:40 UTC.", tmp_path=tmp_path)
        assert not out.passed and met(out)["c3"] is False

    def test_jdg_02_good_commit_message_passes(self, tmp_path):
        msg = (
            "Fix off-by-one in paginate start offset\n\n"
            "Pages are numbered from 1, but the start index was page * page_size, so page 1 skipped\n"
            "the first page of items. Use (page - 1) * page_size and add a test for the first page."
        )
        out = verdict("jdg-02-commit", final=msg, tmp_path=tmp_path)
        assert out.passed, out.details["criteria"]

    def test_jdg_02_a_subject_over_72_characters_fails_that_criterion(self, tmp_path):
        subject = "Correct the pagination offset so that page 1 no longer skips the first ten items"
        assert len(subject) > 72
        msg = f"{subject}\n\nPages are numbered from 1 but the start index used page * page_size, an off-by-one error that skipped a page."
        out = verdict("jdg-02-commit", final=msg, tmp_path=tmp_path)
        assert not out.passed and met(out)["c1"] is False

    def test_jdg_02_a_subject_of_exactly_the_limit_is_accepted(self, tmp_path):
        subject = "Fix the pagination off-by-one so page 1 returns the first items now"  # 69
        assert len(subject) <= 72
        msg = f"{subject}\n\nPages are numbered from 1, but the start offset was page * page_size, an off-by-one error that skipped the first page."
        out = verdict("jdg-02-commit", final=msg, tmp_path=tmp_path)
        assert met(out)["c1"] is True

    def test_jdg_01_exactly_5_bullets_is_accepted(self, tmp_path):
        assert GOOD_SUMMARY.count("\n- ") + 1 == 5
        out = verdict("jdg-01-summary", final=GOOD_SUMMARY, tmp_path=tmp_path)
        assert met(out)["c3"] is True

    def test_jdg_02_a_vague_past_tense_message_fails(self, tmp_path):
        out = verdict("jdg-02-commit", final="Fixed some stuff in the pagination code", tmp_path=tmp_path)
        assert not out.passed

    def test_jdg_03_good_docstring_passes(self, tmp_path):
        doc = (
            "Convert a duration string to a number of seconds.\n\n"
            "Args:\n    text: one or more number-and-unit parts using the units s, m, h and d, for example '1h30m'.\n\n"
            "Returns:\n    The total duration as an int number of seconds.\n\n"
            "Raises:\n    ValueError: if the string is empty or not made only of number-and-unit parts.\n\n"
            "Example:\n    parse_duration('1h30m') == 5400"
        )
        out = verdict("jdg-03-docstring", final=doc, tmp_path=tmp_path)
        assert out.passed, out.details["criteria"]

    def test_jdg_03_a_docstring_without_the_error_case_or_example_fails(self, tmp_path):
        out = verdict("jdg-03-docstring", final="Parses a duration string and returns the number of seconds.", tmp_path=tmp_path)
        assert not out.passed

    def test_jdg_03_a_wrong_example_result_fails(self, tmp_path):
        doc = (
            "Convert a duration string such as '1h30m' to seconds. Units: s, m, h, d. Returns an int. "
            "Raises ValueError on empty or malformed input. Example: parse_duration('1h30m') == 4500"
        )
        assert not verdict("jdg-03-docstring", final=doc, tmp_path=tmp_path).passed

    def test_jdg_04_good_explanation_passes(self, tmp_path):
        text = (
            "The test calls random.sample on the pool without seeding, so each run picks different winners, "
            "and about 4 runs in 10 pick none of the numbers 1 to 5, which fails the assertion. "
            "Seed the generator (random.seed(0)) or pass a fixed sample into the test."
        )
        out = verdict("jdg-04-flaky", final=text, tmp_path=tmp_path)
        assert out.passed, out.details["criteria"]

    def test_jdg_04_blaming_a_race_condition_fails(self, tmp_path):
        out = verdict("jdg-04-flaky", final="It is a race condition between threads; add a lock around pick_winners.", tmp_path=tmp_path)
        assert not out.passed
