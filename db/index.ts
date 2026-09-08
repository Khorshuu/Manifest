import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

const client = postgres(getEnv().DATABASE_URL, { max: 10 });

export const db = drizzle(client, { schema });
export { client };
