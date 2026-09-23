-- Stage 7: the indexes a delete needs, and only those (D-106).
--
-- PostgreSQL does not index a foreign key's own columns. Twenty-two foreign
-- keys added by Stages 2 to 6 fire on a parent delete — CASCADE or SET NULL —
-- with no index to find the children, so each one is a sequential scan of the
-- child table per row deleted.
--
-- Most of those twenty-two do not matter and are deliberately left alone:
-- `created_by`, `decided_by` and the rest are attribution columns on small
-- tables whose parents are never deleted, and indexing them would buy nothing
-- and cost a write on every insert. Indexing all seventy-five unindexed
-- foreign keys would be the kind of tidying that looks like hardening and is
-- not.
--
-- These five are different: each is on a real delete path, and each is on a
-- table that grows with traffic or with knowledge rather than with the
-- catalogue, so the scan gets slower for ever.
--
--   deleteProduct          -> products         cascades to search_events,
--                                              search_clicks
--   deleteProduct          -> seo_research_runs sets null on seo_field_history,
--                                              seo_field_states
--   releaseListingKnowledge -> pkb_sources     cascades to pkb_product_sources
--
-- Measured on the scale database with 500,000 `search_events` rows, deleting
-- one listing's events:
--
--   without the index   41.0 ms   Seq Scan
--   with the index       0.6 ms   Bitmap Heap Scan
--
-- The sequential scan is linear in the table, so the figure is not the point:
-- at five million events it is about four hundred milliseconds, inside the
-- transaction that deletes a listing, and it keeps growing.
--
-- `search_console_metrics.last_sync_id` is the same shape and is deliberately
-- not here: nothing deletes a sync row today, so the index would be a write
-- cost against a delete that never happens. It belongs with whatever adds that
-- prune (risk R-17).

CREATE INDEX IF NOT EXISTS "search_events_product_id_idx"
  ON "search_events" ("product_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "search_clicks_product_id_idx"
  ON "search_clicks" ("product_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "seo_field_history_source_run_id_idx"
  ON "seo_field_history" ("source_run_id")
  WHERE "source_run_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "seo_field_states_source_run_id_idx"
  ON "seo_field_states" ("source_run_id")
  WHERE "source_run_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pkb_product_sources_source_id_idx"
  ON "pkb_product_sources" ("source_id");
--> statement-breakpoint

-- The job screen shows the last finished run of each kind, and asks for it with
-- `distinct on (kind) … order by kind, finished_at desc`. Without this index
-- that reads every finished job inside the retention window — the every-minute
-- delivery job alone leaves about ten thousand of them.
CREATE INDEX IF NOT EXISTS "jobs_kind_finished_idx"
  ON "jobs" ("kind", "finished_at" DESC)
  WHERE "finished_at" IS NOT NULL;
