import { cache } from "react";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE_NAME,
  validateSessionToken,
  type Session,
  type SessionUser,
} from "./session";

/**
 * Reads the session for the current request. Wrapped in React's cache so
 * several server components in one render share a single database read.
 */
export const getCurrentSession = cache(async (): Promise<Session | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return validateSessionToken(token);
});

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getCurrentSession();
  return session?.user ?? null;
}
