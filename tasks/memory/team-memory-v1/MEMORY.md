Staging database: host pg-stage-07.internal, port 6432 (pgbouncer).
§
Service owners: ingest is owned by Marco, billing by Priya, auth by Lena, search by Tomas.
§
Nightly cron jobs run in the Europe/Amsterdam timezone.
§
Standard config.json for new services: log_level "WARN", port 8443, metrics true.
§
Lint is run as: python lint.py --strict. Plain python lint.py is too lenient and passes things the CI rejects.
§
Release checklist, in order: 1) bump VERSION, 2) run lint with --strict, 3) tag vX.Y.Z, 4) post in #releases.
§
Status values in data files: ok means processed, failed means needs a retry, skipped means filtered by a rule, pending means queued.
§
Reports are named report-YYYY-MM-DD.csv and saved under reports/.
