-- Stage 7: a bulk import queues the search index instead of rebuilding it per
-- listing (risk R-13, D-104).
--
-- Migration 0039 gave `product_search_queue` a `source`: a row queued by a
-- change is rebuilt at that change's commit, so a shopper searching a second
-- later finds the new words, while a row queued by a whole-catalogue rebuild is
-- left for the background worker. That distinction was made where the *caller*
-- knew which it was — `rebuildSearchIndex` writes 'rebuild' itself.
--
-- The knowledge backfill cannot say so that way. It reaches the queue through
-- triggers on `pkb_facts` and `pkb_identifiers`, which call
-- `queue_product_search` and have no idea whether they are running under a
-- member of staff accepting one claim or under an import writing forty thousand
-- facts. Measured on the 5,000-listing scale database, a full backfill took
-- 305 s, of which about 30 s was those per-fact queue upserts and a further
-- share was rebuilding each listing's index at the commit of its own sync —
-- work that is thrown away as soon as the next listing is synced anyway.
--
-- So the source becomes something a transaction can declare. `set local
-- manifest.search_queue_source = 'rebuild'` makes every queue write in that
-- transaction a rebuild; anything else, including the setting being absent,
-- means 'change'. `set local` is the whole safety argument: the value cannot
-- outlive its transaction, so a script that sets it and crashes cannot leave
-- the shop quietly not reindexing. The default — no setting — is the safe one.

CREATE OR REPLACE FUNCTION queue_product_search(ids uuid[]) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO product_search_queue (product_id, source)
  SELECT DISTINCT t.product_id,
    CASE
      WHEN coalesce(current_setting('manifest.search_queue_source', true), '') = 'rebuild'
      THEN 'rebuild' ELSE 'change'
    END
  FROM unnest(ids) AS t(product_id)
  WHERE t.product_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = t.product_id)
  ON CONFLICT (product_id) DO UPDATE SET
    queued_at = now(),
    -- A listing already waiting for a change stays a change: a bulk import
    -- must never downgrade somebody's edit into the backlog behind it.
    source = CASE
      WHEN product_search_queue.source = 'change' THEN 'change'
      ELSE excluded.source
    END
$$;
