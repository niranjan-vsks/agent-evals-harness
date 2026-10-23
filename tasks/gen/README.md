# Task generators

Three tasks have computed answers, so the answer is derived by a seeded script and committed with
its fixture. Nothing in the task JSON for these 3 is typed by hand.

| script | task | seed | what it writes |
|---|---|---|---|
| `det_01_csv.py` | `det-01-csv-count` | 20261020 | `data.csv` (500 rows, 37 `failed`, 20 `skipped`) and the task file with `expected` counted from the rows |
| `det_07_sort.py` | `det-07-sort` | 20261021 | `numbers.txt` (60 integers, negatives and duplicates), `_hidden/expected/sorted.txt`, the task file |
| `det_08_revenue.py` | `det-08-revenue` | 20261022 | `orders.json` (120 orders) and the task file with `expected` summed in whole cents |

## Regenerate

```
python tasks/gen/det_01_csv.py
python tasks/gen/det_07_sort.py
python tasks/gen/det_08_revenue.py
```

Each takes an optional output directory (default: `tasks/`). Output is written as bytes with LF
line endings, because a task's version hash covers the raw bytes of the task file and its fixture
(`worker/task_hash.py`, `api/src/tasks/hash.ts`).

## Rules

- Regeneration must be byte-identical to what is committed. `worker/tests/test_task_generators.py`
  imports each script, calls `render()` and compares it with the files on disk; it fails if a
  script, its seed or the Python random module changes the output.
- A change to a seed, a count or the prompt changes the task's version hash. That is intended: it
  is a new version of the task (D-6), and experiments that pinned the old one are unaffected.
- Use only `random.Random(seed)` methods whose output is fixed across Python 3 versions
  (`shuffle`, `choice`, `randrange`, `random`).
- Add a new generator by writing `render() -> {path relative to tasks/: bytes}` and calling
  `_common.run(render)`; then add it to the table above and to the test.
