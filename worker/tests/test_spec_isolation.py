"""R-10: the spec file is never under trial_dir while the agent runs (it held the graders until R-11 took them out of the child's spec). These are the runner and
child-process halves; test_adapter_conformance.py::test_r10_* is the end-to-end one with a stub model that goes looking."""
import json
import os
from pathlib import Path

import pytest

from worker.run_one import assert_trial_dir_holds_no_extras, consume_spec
from worker.runner import run_trial
from worker.tests.conftest import make_spec


def test_r10_the_spec_is_not_under_the_trial_dir_during_the_run(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="list_trial_dir"), runner_env)
    top, jsons = res["outcome"]["final_response"].removeprefix("FINAL: ").split("|")
    assert set(top.split(",")) <= {"workspace", "out", "home", "tmp", "child"}
    assert "spec.json" not in jsons and "spec.json" not in top
    assert not any((runner_env.work_dir / "specs").glob("*"))  # and none is left behind


def test_r10_a_kept_trial_dir_never_holds_the_spec(runner_env, tasks_dir):
    import dataclasses

    keep = dataclasses.replace(runner_env, keep_trial_dirs=True)
    spec = make_spec(tasks_dir)
    run_trial(spec, keep)
    kept = keep.work_dir / "trials" / spec["trial_id"] / "1"
    assert kept.is_dir() and not list(kept.rglob("spec.json"))
    assert not any((keep.work_dir / "specs").glob("*"))


def test_r10_the_spec_is_removed_even_when_the_child_crashes(runner_env, tasks_dir):
    res = run_trial(make_spec(tasks_dir, mode="crash"), runner_env)
    assert res["error_class"] == "worker_crash"
    assert not any((runner_env.work_dir / "specs").glob("*"))


def test_r10_consume_spec_reads_then_deletes(tmp_path):
    path = tmp_path / "s.json"
    path.write_text(json.dumps({"spec": {"a": 1}, "paths": {}}), encoding="utf-8")
    assert consume_spec(str(path)) == {"spec": {"a": 1}, "paths": {}}
    assert not path.exists()


@pytest.mark.skipif(os.name == "nt", reason="a read-only directory does not stop unlink on Windows the same way")
def test_r10_a_spec_that_cannot_be_deleted_is_not_run(tmp_path):
    d = tmp_path / "ro"
    d.mkdir()
    path = d / "s.json"
    path.write_text("{}", encoding="utf-8")
    d.chmod(0o555)
    try:
        if os.geteuid() == 0:
            pytest.skip("root can delete from a read-only directory")
        with pytest.raises(PermissionError):
            consume_spec(str(path))
    finally:
        d.chmod(0o755)


def test_r10_a_stray_file_in_the_trial_dir_stops_the_child(tmp_path):
    for name in ("workspace", "out", "home", "tmp"):
        (tmp_path / name).mkdir()
    assert_trial_dir_holds_no_extras(str(tmp_path))  # the runner's own directories are fine
    (tmp_path / "spec.json").write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeError, match="spec.json"):
        assert_trial_dir_holds_no_extras(str(tmp_path))
