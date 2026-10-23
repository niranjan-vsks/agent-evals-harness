"""The generated tasks (tasks/gen): regeneration is byte-identical to what is committed, and the
committed answers agree with an independent reading of the committed fixtures."""
import csv
import json
from decimal import Decimal

import pytest

from worker.tests.tasks_support import load_gen, load_task, tasks_root

GENERATORS = ["det_01_csv", "det_07_sort", "det_08_revenue"]


@pytest.mark.parametrize("name", GENERATORS)
def test_regeneration_is_byte_identical_to_the_committed_files(name):
    module = load_gen(name)
    rendered = module.render()
    assert rendered, "a generator must write something"
    for rel, data in rendered.items():
        assert (tasks_root() / rel).read_bytes() == data, f"{rel} differs from what {name}.py generates"


@pytest.mark.parametrize("name", GENERATORS)
def test_rendering_twice_gives_the_same_bytes_and_no_carriage_returns(name):
    module = load_gen(name)
    first, second = module.render(), module.render()
    assert first == second
    assert all(b"\r" not in data for data in first.values())


def test_det_01_the_answer_is_counted_from_the_committed_rows():
    rows = list(csv.DictReader((tasks_root() / "fixtures/det-01-csv-count/data.csv").read_text(encoding="utf-8").splitlines()))
    assert len(rows) == 500
    counts = {s: sum(1 for r in rows if r["status"] == s) for s in ("failed", "skipped", "ok")}
    assert counts == {"failed": 37, "skipped": 20, "ok": 443}
    assert load_task("det-01-csv-count")["graders"][0]["expected"] == str(counts["failed"])


def test_det_07_the_expected_file_is_the_numeric_sort_and_a_text_sort_is_not():
    root = tasks_root() / "fixtures/det-07-sort"
    numbers = [int(x) for x in (root / "numbers.txt").read_text(encoding="utf-8").split()]
    expected = (root / "_hidden/expected/sorted.txt").read_text(encoding="utf-8")
    assert expected == "".join(f"{n}\n" for n in sorted(numbers))
    assert len(numbers) == 60 and sum(1 for n in numbers if n < 0) >= 10 and len(set(numbers)) < len(numbers)
    assert expected != "".join(f"{n}\n" for n in sorted(numbers, key=str))


def test_det_08_the_answer_is_the_sum_of_completed_orders_read_back_from_the_json():
    orders = json.loads((tasks_root() / "fixtures/det-08-revenue/orders.json").read_text(encoding="utf-8"), parse_float=Decimal)
    assert len(orders) == 120 and {o["status"] for o in orders} == {"completed", "refunded", "cancelled", "pending"}
    total = sum(o["amount"] for o in orders if o["status"] == "completed")
    assert load_task("det-08-revenue")["graders"][0]["expected"] == f"{total:.2f}"
    assert total != sum(o["amount"] for o in orders), "the other statuses must change the answer"
