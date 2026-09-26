-- What research suggests a discovered label is (DECISIONS.md D-123).
--
-- An attribute proposal already records the label, one example value, a
-- guessed shape and the evidence. A page read with intelligent extraction also
-- says what kind of statement the value is (a product fact, an ingredient, a
-- warning, a version's own fact, an item in the box) and what attribute it
-- appears to mean. That is a suggestion for the person deciding the label —
-- it groups the review screen and pre-fills nothing — so it is kept beside
-- the proposal rather than in any canonical column. Nullable: proposals from
-- the deterministic readers and every proposal made before this migration
-- have none.
--
-- Shape: {"kind": "product_fact" | "composition" | ..., "meaning": text | null,
--         "method": "ai_assisted" | "html_text" | ...}

ALTER TABLE "pkb_attribute_proposals" ADD COLUMN "suggestion" jsonb;
