/**
 * Search now lives in `lib/search` — the index, the query planner, synonyms,
 * typo correction, suggestions and analytics (DECISIONS.md D-026). This file
 * keeps the catalogue's old export so nothing that imported it has to know
 * the engine moved.
 */
export { toTsQuery } from "@/lib/search/normalize";
