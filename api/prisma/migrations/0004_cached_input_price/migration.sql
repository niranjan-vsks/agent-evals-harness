-- Cached prompt tokens are billed at their own, lower rate (DESIGN.md 13.14). input_tokens excludes them, so cost_usd needs a third price.
-- DEFAULT 0 lets the column be added to a database that already holds models; the seed upsert (api/seed/models.json) fills the real value at startup.

ALTER TABLE "model" ADD COLUMN "cached_input_price_per_mtok" DECIMAL(12,6) NOT NULL DEFAULT 0;

ALTER TABLE "model"
  ADD CONSTRAINT model_cached_input_price_nonneg CHECK (cached_input_price_per_mtok >= 0);
