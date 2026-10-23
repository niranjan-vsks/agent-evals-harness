# Incident 2026-09-14: checkout latency

Status: resolved. Severity: SEV2. Duration: 14:05 to 15:40 UTC (95 minutes).

## Timeline

- 14:05 Alerts fired: p95 latency of POST /checkout rose from 300 ms to 9 s.
- 14:20 On-call (Ravi) rolled back the 13:50 deploy of the cart service. No change in latency.
- 14:48 The slow-query log showed full scans of the orders table.
- 15:10 Found that migration 0042 (applied at 13:45) rebuilt the orders table and did not recreate the index on orders.customer_id.
- 15:25 Index created with CREATE INDEX CONCURRENTLY.
- 15:40 Latency back to normal.

## Cause

Migration 0042 rebuilt the orders table to change a column type. The script copied the rows but did not recreate the index on orders.customer_id, so every customer lookup scanned about 12 million rows.

## Fix

Re-created the index with CREATE INDEX CONCURRENTLY, which does not lock the table.

## Follow-ups

- Add a CI check that compares the index list before and after each migration (owner: Mei).
- The cart service deploy was unrelated to the incident and has been re-applied.
