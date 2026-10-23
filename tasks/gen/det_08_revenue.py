"""det-08-revenue: orders.json with 120 orders, seed 20261022. The answer is the sum of the amounts
of the orders whose status is "completed".

Amounts are drawn in whole cents and summed as integers, so the expected value has no floating
point error; it is written with exactly 2 decimals into the task file.

    python tasks/gen/det_08_revenue.py [output tasks dir]
"""
import json
import random

from _common import run, task_json

SEED = 20261022
COUNT = 120
TASK_ID = "det-08-revenue"
CUSTOMERS = ["Okafor", "Lindqvist", "Marin", "Tanaka", "Haddad", "Novak", "Silva", "Brandt"]
STATUSES = ["completed"] * 6 + ["refunded"] * 2 + ["cancelled"] * 1 + ["pending"] * 1


def orders() -> list[dict]:
    rng = random.Random(SEED)
    out = []
    for i in range(COUNT):
        cents = rng.randrange(500, 50000)
        out.append({"id": f"ord-{i + 1:04d}", "customer": rng.choice(CUSTOMERS), "status": rng.choice(STATUSES), "amount": cents / 100, "_cents": cents})
    return out


def expected(data: list[dict]) -> str:
    total = sum(o["_cents"] for o in data if o["status"] == "completed")
    return f"{total // 100}.{total % 100:02d}"


def render() -> dict[str, bytes]:
    data = orders()
    public = [{k: v for k, v in o.items() if not k.startswith("_")} for o in data]
    task = {
        "id": TASK_ID,
        "category": "neutral_deterministic",
        "prompt": "orders.json contains a list of orders. What is the total amount of the orders whose status is completed? Give the number with exactly 2 decimal places, digits and a decimal point only, with no currency symbol and no thousands separator (for example 1234.50). Finish your reply with a line of the form FINAL: <total>.",
        "fixture_dir": f"fixtures/{TASK_ID}",
        "memory_fixture": None,
        "graders": [{"type": "exact_match", "expected": expected(data), "expected_regex": None, "normalize": ["trim"], "extract": "final_line"}],
        "discriminates": ["model"],
        "tags": ["p2", "generated", "json"],
    }
    return {
        f"fixtures/{TASK_ID}/orders.json": (json.dumps(public, indent=2) + "\n").encode("utf-8"),
        f"{TASK_ID}.json": task_json(task),
    }


if __name__ == "__main__":
    run(render)
