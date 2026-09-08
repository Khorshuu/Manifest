import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id parameters. Deliberately explicit rather than relying on library
 * defaults, so a dependency upgrade cannot silently weaken hashing.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, OPTIONS);
  } catch {
    // A malformed or truncated hash must read as "wrong password", never as an
    // exception that a caller might mistake for a system error and retry past.
    return false;
  }
}
