import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Every file the media provider stored (migration 0027, D-055). The sweep in
 * lib/media/registry.ts deletes files nothing points at any more.
 */
export const mediaObjects = pgTable(
  "media_objects",
  {
    key: text("key").primaryKey(),
    provider: text("provider").notNull(),
    url: text("url").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("media_objects_created_at_idx").on(table.createdAt),
    check("media_objects_bytes_check", sql`${table.bytes} >= 0`),
  ],
);
