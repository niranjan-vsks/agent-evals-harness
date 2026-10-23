"""det-07-sort: numbers.txt of 60 integers in [-500, 500] with negatives and duplicates, seed 20261021.

The expected sorted.txt is produced by sorting the generated numbers and lives in the fixture's
_hidden/ directory, where the agent cannot read it and the file_state grader can. The generator
refuses a draw where a plain text sort would already give the right order, so the task cannot
be solved by `sort` without `-n`.

    python tasks/gen/det_07_sort.py [output tasks dir]
"""
import random

from _common import run, task_json

SEED = 20261021
COUNT = 60
TASK_ID = "det-07-sort"


def numbers() -> list[int]:
    rng = random.Random(SEED)
    values = [rng.randrange(-500, 501) for _ in range(COUNT)]
    values[-6:] = [rng.choice(values[:-6]) for _ in range(6)]  # duplicates, so a sort must keep every copy
    assert sum(1 for v in values if v < 0) >= 10, "the draw needs negatives"
    assert len(set(values)) < len(values), "the draw needs duplicates"
    assert sorted(values) != [int(s) for s in sorted(str(v) for v in values)], "a text sort must give the wrong order"
    return values


def lines(values: list[int]) -> bytes:
    return ("".join(f"{v}\n" for v in values)).encode("utf-8")


def render() -> dict[str, bytes]:
    values = numbers()
    task = {
        "id": TASK_ID,
        "category": "neutral_deterministic",
        "prompt": "Sort the numbers in numbers.txt in ascending numeric order and write the result to sorted.txt, one number per line, with a newline after the last number.",
        "fixture_dir": f"fixtures/{TASK_ID}",
        "memory_fixture": None,
        "graders": [{"type": "file_state", "checks": [{"path": "sorted.txt", "equals_file": "expected/sorted.txt"}]}],
        "discriminates": ["model"],
        "tags": ["p2", "generated", "files"],
    }
    return {
        f"fixtures/{TASK_ID}/numbers.txt": lines(values),
        f"fixtures/{TASK_ID}/_hidden/expected/sorted.txt": lines(sorted(values)),
        f"{TASK_ID}.json": task_json(task),
    }


if __name__ == "__main__":
    run(render)
