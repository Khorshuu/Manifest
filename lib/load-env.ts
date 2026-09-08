import { config } from "dotenv";

/**
 * Loads environment files for standalone scripts, in the same precedence
 * Next.js uses for the app itself. Next loads these automatically; a plain
 * `tsx` script does not, so scripts import this first.
 */
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
