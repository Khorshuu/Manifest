import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238), implemented here rather than
 * pulled in.
 *
 * It is roughly sixty lines of well-specified arithmetic with published test
 * vectors, which the tests check against — so the implementation is provable
 * in a way that trusting a transitive dependency on the authentication path is
 * not. It also means no secret ever leaves this process.
 *
 * SHA-1 is not a mistake: RFC 6238 specifies it, and every authenticator app
 * assumes it. The security here rests on the shared secret, not on the hash.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** How far either side of now a code is still accepted. */
export const TOTP_WINDOW_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 without padding, which is what authenticator apps expect. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function base32Decode(encoded: string): Buffer {
  const normalised = encoded.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of normalised) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error("That is not a valid base32 secret.");
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** A 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226): the counter-based code TOTP is built on. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const counterBytes = Buffer.alloc(8);
  // Written as two 32-bit halves: a JavaScript number cannot hold a 64-bit
  // integer exactly, and the counter comfortably fits in the low half for the
  // next several thousand years.
  counterBytes.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBytes.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", secret).update(counterBytes).digest();

  // Dynamic truncation, RFC 4226 section 5.3.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Which 30-second step an instant falls in. */
export function totpStep(
  now: number = Date.now(),
  period = TOTP_PERIOD_SECONDS,
): number {
  return Math.floor(now / 1000 / period);
}

export function totp(
  secretBase32: string,
  now: number = Date.now(),
  digits = TOTP_DIGITS,
  period = TOTP_PERIOD_SECONDS,
): string {
  return hotp(base32Decode(secretBase32), totpStep(now, period), digits);
}

export type TotpVerification = {
  valid: boolean;
  /** The step the code belonged to, so a caller can refuse a replay. */
  step: number | null;
};

/**
 * Checks a code against the steps around now, allowing for clocks that
 * disagree by a few seconds. Comparison is constant-time: a code is a secret
 * for thirty seconds, and leaking how much of it was right through timing
 * would shorten that considerably.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: {
    now?: number;
    window?: number;
    digits?: number;
    period?: number;
    /** The last step this account already used, refused as a replay. */
    lastUsedStep?: number | null;
  } = {},
): TotpVerification {
  const {
    now = Date.now(),
    window = TOTP_WINDOW_STEPS,
    digits = TOTP_DIGITS,
    period = TOTP_PERIOD_SECONDS,
    lastUsedStep = null,
  } = options;

  const cleaned = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) {
    return { valid: false, step: null };
  }

  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return { valid: false, step: null };
  }

  const current = totpStep(now, period);

  for (let offset = -window; offset <= window; offset++) {
    const step = current + offset;
    if (step < 0) continue;

    const expected = hotp(secret, step, digits);
    if (!constantTimeEquals(expected, cleaned)) continue;

    // A code already spent cannot be spent again: without this, anyone who
    // sees a code over someone's shoulder has thirty seconds to reuse it.
    if (lastUsedStep !== null && step <= lastUsedStep) {
      return { valid: false, step };
    }

    return { valid: true, step };
  }

  return { valid: false, step: null };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * The otpauth:// URI an authenticator app reads from a QR code. The issuer is
 * repeated as a parameter because some apps read only one of the two places.
 */
export function totpAuthUri(options: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${options.issuer}:${options.account}`);
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}
