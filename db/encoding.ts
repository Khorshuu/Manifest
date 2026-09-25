/**
 * The database has to be UTF-8 (D-119).
 *
 * Product knowledge is text from manufacturers' pages, and those pages are
 * written in Unicode: "48 Ω", "−20 °C", "1× USB receiver", a Japanese model
 * name, an editor's zero-width space. A database created in a single-byte
 * encoding — WIN1252 is what an embedded cluster on Windows gets unless told
 * otherwise — has no byte for most of that, and PostgreSQL refuses the
 * insert with SQLSTATE 22P05. The failure used to surface as a research run
 * that read the manufacturer's page and stored nothing.
 *
 * Nothing here changes a database. It reports what the database is and, when
 * that is wrong, says exactly how to make one that is right. Recreating a
 * database is a person's decision: it holds their catalogue.
 */

export const REQUIRED_ENCODING = "UTF8";

/** Null when the encoding is fine; otherwise what is wrong and how to fix it. */
export function encodingProblem(encoding: string | null, database: string | null): string | null {
  if (!encoding) return null;
  if (encoding.toUpperCase().replace(/[^A-Z0-9]/g, "") === REQUIRED_ENCODING) return null;
  const name = database ?? "the database";
  const target = `${database ?? "preorder"}_utf8`;
  return [
    `The database "${name}" uses the ${encoding} encoding. Manifest needs UTF8: product knowledge from manufacturers' pages contains characters ${encoding} cannot store (Ω, −, zero-width spaces, most non-Latin text), and research that reads such a page fails to store it.`,
    `To fix it, create a UTF-8 database and point DATABASE_URL at it — nothing is deleted:`,
    `  CREATE DATABASE ${target} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;`,
    `then set DATABASE_URL to .../${target} and run "npm run db:setup" (only for a new, empty development database: it seeds, and the seed truncates its tables) or "npm run db:migrate" (one holding real data, after copying it across with pg_dump/pg_restore).`,
    `Keep the old database until the new one is checked; nothing needs to be dropped.`,
    `See docs/DATABASE.md, "Encoding".`,
  ].join("\n");
}

type Query = (text: string) => Promise<Record<string, unknown>[]>;

/** Reads the connected database's name and encoding. */
export async function databaseEncoding(query: Query): Promise<{ database: string | null; encoding: string | null }> {
  const rows = await query(
    "select current_database() as database, pg_encoding_to_char(encoding) as encoding from pg_database where datname = current_database()",
  );
  const row = rows[0] ?? {};
  return {
    database: typeof row.database === "string" ? row.database : null,
    encoding: typeof row.encoding === "string" ? row.encoding : null,
  };
}

/** Checks the connected database and returns the problem, if there is one. */
export async function checkDatabaseEncoding(query: Query): Promise<string | null> {
  const { database, encoding } = await databaseEncoding(query);
  return encodingProblem(encoding, database);
}
