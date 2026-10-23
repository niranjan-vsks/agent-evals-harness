"""det-01-csv-count: data.csv with 500 rows, 37 failed and 20 skipped, seed 20261020.

The statuses are a shuffled list with exactly those counts, so the expected answer is counted from
the generated rows and written into the task file; nothing is typed by hand.

    python tasks/gen/det_01_csv.py [output tasks dir]
"""
import random
from datetime import datetime, timedelta

from _common import run, task_json

SEED = 20261020
ROWS, FAILED, SKIPPED = 500, 37, 20
TASK_ID = "det-01-csv-count"
SERVICES = ["ingest", "billing", "auth", "search", "export"]


def rows() -> list[tuple[int, str, str, str, int]]:
    rng = random.Random(SEED)
    statuses = ["failed"] * FAILED + ["skipped"] * SKIPPED + ["ok"] * (ROWS - FAILED - SKIPPED)
    rng.shuffle(statuses)
    start = datetime(2026, 9, 1, 0, 0, 0)
    return [
        (i + 1, (start + timedelta(seconds=97 * i)).strftime("%Y-%m-%dT%H:%M:%SZ"), rng.choice(SERVICES), status, rng.randrange(20, 4000))
        for i, status in enumerate(statuses)
    ]


def expected(data: list[tuple[int, str, str, str, int]]) -> str:
    return str(sum(1 for r in data if r[3] == "failed"))


def render() -> dict[str, bytes]:
    data = rows()
    csv_text = "id,timestamp,service,status,duration_ms\n" + "".join(f"{i},{ts},{svc},{st},{ms}\n" for i, ts, svc, st, ms in data)
    task = {
        "id": TASK_ID,
        "category": "neutral_deterministic",
        "prompt": "How many rows in data.csv have the status failed? Count data rows only, not the header line. Finish your reply with a line of the form FINAL: <number>.",
        "fixture_dir": f"fixtures/{TASK_ID}",
        "memory_fixture": None,
        "graders": [{"type": "exact_match", "expected": expected(data), "expected_regex": None, "normalize": ["trim"], "extract": "final_line"}],
        "discriminates": ["model"],
        "tags": ["p2", "generated", "csv"],
    }
    return {f"fixtures/{TASK_ID}/data.csv": csv_text.encode("utf-8"), f"{TASK_ID}.json": task_json(task)}


if __name__ == "__main__":
    run(render)
