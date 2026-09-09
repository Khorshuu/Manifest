-- Search stopped being a name match.
--
-- A shopper who types "tactile" is describing a switch, not naming a product,
-- and the words that answer them live in the description, the bullet points,
-- the spec table and the tags — not in the title. The previous query was
-- `title ILIKE '%term%' OR brand ILIKE '%term%'`, which found neither those
-- shoppers' products nor anything else the listing says about itself.
--
-- This index is the searchable text of a listing: everything the listing says
-- in its own words, with the description's markup stripped so tag names are
-- not indexed as vocabulary. The English configuration is named explicitly
-- rather than left to `default_text_search_config`, because an expression
-- index has to be immutable and a session-dependent configuration is not.
--
-- The application builds exactly this expression when it searches, so the
-- index is actually used. If one of them changes, both must.
CREATE INDEX IF NOT EXISTS "products_search_idx"
  ON "products"
  USING GIN (
    to_tsvector(
      'english',
      coalesce("title", '') || ' ' ||
      coalesce("brand", '') || ' ' ||
      coalesce(regexp_replace("description_html", '<[^>]*>', ' ', 'g'), '') || ' ' ||
      coalesce("tags"::text, '') || ' ' ||
      coalesce("bullet_features"::text, '') || ' ' ||
      coalesce("spec_table"::text, '') || ' ' ||
      coalesce("seo_meta_description", '')
    )
  );
--> statement-breakpoint
-- Autosuggest and the catalogue menu both look a category up by name, and the
-- suggestion query is run on every few keystrokes.
CREATE INDEX IF NOT EXISTS "categories_name_idx" ON "categories" ("name");
