-- Stage 7: a whole-catalogue reindex that does not happen inside the request
-- that asked for it (risk R-12, D-103).
--
-- `product_search_queue` has always had two jobs pulling in opposite
-- directions. For a listing somebody just changed, the right behaviour is to
-- rebuild its row at the commit of that change, which the deferred constraint
-- trigger does: the shopper searching a second later finds the new words. For a
-- whole-catalogue rebuild, that same trigger is exactly wrong — queueing five
-- thousand listings makes the commit rebuild five thousand rows, about a
-- hundred seconds of work inside one web request, which no serverless platform
-- will wait for and nothing can resume if it fails half-way.
--
-- So a queued row now says why it is queued. A change still rebuilds at commit.
-- A rebuild waits for `search.process_queue`, which is chunked, time-bounded,
-- retried and reported. Nothing else changes: `queue_product_search` still
-- writes 'change', which is what every trigger in migration 0014 and 0036 calls.

ALTER TABLE "product_search_queue"
  ADD COLUMN "source" text NOT NULL DEFAULT 'change';
--> statement-breakpoint

ALTER TABLE "product_search_queue"
  ADD CONSTRAINT "product_search_queue_source_check"
  CHECK ("source" IN ('change', 'rebuild'));
--> statement-breakpoint

COMMENT ON COLUMN "product_search_queue"."source" IS
  'change: rebuilt at the commit that queued it. rebuild: left for the background worker, so a whole-catalogue reindex is not paid for inside one request.';
--> statement-breakpoint

-- The worker takes the oldest first and does not care why a row is there, but
-- it reads a chunk at a time, so an index on (source, queued_at) keeps that
-- read off the whole table once a rebuild has queued the catalogue.
CREATE INDEX IF NOT EXISTS "product_search_queue_source_idx"
  ON "product_search_queue" ("source", "queued_at");
--> statement-breakpoint

-- A change to a listing already waiting for a rebuild becomes a change: the
-- shopper's next search should see the edit, not wait behind the backlog.
CREATE OR REPLACE FUNCTION queue_product_search(ids uuid[]) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO product_search_queue (product_id, source)
  SELECT DISTINCT t.product_id, 'change'
  FROM unnest(ids) AS t(product_id)
  WHERE t.product_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM products p WHERE p.id = t.product_id)
  ON CONFLICT (product_id) DO UPDATE SET queued_at = now(), source = 'change'
$$;
--> statement-breakpoint

-- Runs once per queued product at commit, for a change and not for a rebuild.
-- The delete is what makes a product queued fifty times in one transaction
-- rebuild once: every event after the first finds the row already gone. A
-- failure is caught and logged rather than raised, because a broken index row
-- is not a reason to refuse a product save; the row stays queued for the sweep.
CREATE OR REPLACE FUNCTION process_product_search_queue_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A row queued by a whole-catalogue rebuild is the background worker's, and
  -- doing it here would put the whole rebuild inside one commit.
  IF NEW.source <> 'change' THEN
    RETURN NULL;
  END IF;

  BEGIN
    DELETE FROM product_search_queue WHERE product_id = NEW.product_id;
    IF FOUND THEN
      PERFORM refresh_product_search(ARRAY[NEW.product_id]);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Search index rebuild failed for product %: %', NEW.product_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
