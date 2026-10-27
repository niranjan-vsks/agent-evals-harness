# experiments/p5: how the primary experiment was run

The scripts here ran the real experiment of DESIGN.md 10 against a running stack. They use Node 18+ `fetch` only and talk to the API; none of them touches the database.

| script | what it does |
|---|---|
| `setup-pilot.mjs [api]` | `POST /configs` for the 2 configs of DESIGN 10.1, `POST /experiments` (draft, phase `pilot`, N = 3, seed 20261025, the 22 tasks, the hypothesis read from DESIGN.md 10.1 verbatim) and `POST /experiments/:id/start` |
| `wait.mjs <experiment-id> [api]` | polls `GET /experiments/:id` every 30 s and prints each change of the progress counts; reads progress only, never `/compare` |
| `fetch-results.mjs <experiment-id> [api]` | `GET compare?persist=1`, then downloads `export.json?traces=1`, `compare.csv` and `export.csv` into `experiments/results/`, and checks gate 5 of cards/P5.md (the stored result equals a fresh `compare?persist=0`) |
| `analyze.mjs <export.json> [--json out] [--reveal-judged]` | the numbers DESIGN 10.4 and 12.2 quote: census, tokens, spend, data-quality counters, the stored comparison, trajectory candidates. It holds back the judge-graded tasks' pass rates unless `--reveal-judged`, so the labeler is not unblinded |
| `setup-secondary.mjs [api]` | the secondary experiment of DESIGN 10.3 (model A against model B, Hermes, memory off, N = 3) |

Default API: `http://127.0.0.1:3200`.

## The isolated stack

The run used its own compose project so that a rebuild by another session could not swap its containers. It is `git archive` of the commit the run was built from, with 3 edits to `docker-compose.yml`: host ports `127.0.0.1:3200` (api), `127.0.0.1:8200` (worker) and `127.0.0.1:8280` (web), the repository's `.env` named by absolute path, and `./experiments` bind-mounted from the repository by absolute path (so `judge:sample` and `judge:kappa` read and write the repository's `experiments/`).

```
git archive cb7a46d | tar -x -C C:/hx/p5src          # then edit docker-compose.yml as above
cd C:/hx/p5src
set DOCKER_BUILDKIT=0 & set COMPOSE_BAKE=false
docker compose -p p5run build api worker web
docker compose -p p5run up -d
node <repo>/experiments/p5/setup-pilot.mjs http://127.0.0.1:3200
node <repo>/experiments/p5/wait.mjs <experiment-id> http://127.0.0.1:3200
```

The data is in the volume `p5run_dbdata`. Do not run `docker compose -p p5run down -v`. The platform has no import endpoint, so `experiments/results/<id>.json` is the record and the volume is the only live copy.

## The database dump

`experiments/results/p5run-db-pre-kappa.sql.gz` is `pg_dump --no-owner` of the run's database (schema and data of both experiments, before the judge validation). The platform has no import endpoint, so this is how the experiments come back into a database. Making a dump, and restoring one into an empty `postgres:16` (this was tested: exit 0, 264 trials, 2 experiments, 3 configs, 2 comparison runs):

```
docker compose -p p5run -f C:/hx/p5src/docker-compose.yml exec -T db pg_dump -U evals --no-owner evals | gzip -9 > dump.sql.gz

docker run -d --name restore -e POSTGRES_USER=evals -e POSTGRES_PASSWORD=evals -e POSTGRES_DB=evals postgres:16
gzip -dc dump.sql.gz | docker exec -i restore psql -U evals -d evals -q -v ON_ERROR_STOP=1
```

To use the restored data with the application, restore into the `db` service of a stack whose database is empty (start only `db`, restore, then start `api`, `worker` and `web`); the dump should include Prisma's `_prisma_migrations` table, so the API should see the migrations as applied (starting the application on a restored database was not tested). `experiments/results/p5run-db-post-kappa.sql.gz` is the dump taken after `judge:kappa` and `failures:backfill` (it also holds the 30 labels, the `judge_validation` row and the post-kappa `comparison_run` of each experiment); the pre-kappa dump is kept as the record of the database before the validation.

## Judge validation commands against this stack

```
docker compose -p p5run -f C:/hx/p5src/docker-compose.yml exec api npm run judge:sample -- --n 30
docker compose -p p5run -f C:/hx/p5src/docker-compose.yml exec api npm run judge:kappa
node experiments/p5/fetch-results.mjs 01M5SRTYPNZ9EWV1HX8KJGX40N     # re-export after kappa: the comparison then applies the judge policy
```
