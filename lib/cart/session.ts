import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { getOrCreateCart, newCartToken } from "./index";

export const CART_COOKIE_NAME = "cart";

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 60,
} as const;

/**
 * The cart for this request: the signed-in user's, or the guest cart named by
 * the cookie. Creates one when neither exists.
 */
export async function resolveCartId(): Promise<string> {
  const user = await getCurrentUser();
  if (user) return getOrCreateCart({ userId: user.id });

  const store = await cookies();
  let token = store.get(CART_COOKIE_NAME)?.value;

  if (!token) {
    token = newCartToken();
    store.set(CART_COOKIE_NAME, token, cookieOptions);
  }

  return getOrCreateCart({ sessionToken: token });
}

/** Read-only variant: never sets a cookie, so it is safe in a render. */
export async function findCartId(): Promise<string | null> {
  const user = await getCurrentUser();
  if (user) return getOrCreateCart({ userId: user.id });

  const store = await cookies();
  const token = store.get(CART_COOKIE_NAME)?.value;
  if (!token) return null;

  return getOrCreateCart({ sessionToken: token });
}
