/**
 * TOTP, checked against the published vectors.
 *
 * RFC 4226 appendix D and RFC 6238 appendix B give exact expected values for a
 * known secret and known times. Testing against those is what makes a
 * hand-written implementation on the authentication path defensible: it is not
 * "it seemed to work with my phone", it is the specification's own numbers.
 */
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  totp,
  totpAuthUri,
  totpStep,
  verifyTotp,
} from "@/lib/auth/totp";

/** RFC 4226 uses the ASCII secret "12345678901234567890". */
const RFC4226_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC4226_SECRET_BASE32 = base32Encode(RFC4226_SECRET);

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it("matches the known encoding of the RFC secret", () => {
    expect(RFC4226_SECRET_BASE32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("ignores spacing and case, as a person typing it would produce", () => {
    const decoded = base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq");
    expect(decoded.equals(RFC4226_SECRET)).toBe(true);
  });

  it("refuses something that is not base32", () => {
    expect(() => base32Decode("not-valid-1889")).toThrow();
  });
});

describe("HOTP against RFC 4226 appendix D", () => {
  const expected = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];

  it.each(expected.map((code, counter) => [counter, code]))(
    "counter %i produces %s",
    (counter, code) => {
      expect(hotp(RFC4226_SECRET, counter as number)).toBe(code);
    },
  );
});

describe("TOTP against RFC 6238 appendix B", () => {
  /**
   * The RFC's SHA-1 rows. Its table uses a 20-byte secret and eight digits;
   * the six-digit codes here are the last six of each, which is what a
   * six-digit authenticator shows for the same secret and time.
   */
  const vectors: [number, string][] = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ];

  it.each(vectors)("at unix time %i the code is %s", (seconds, code) => {
    expect(totp(RFC4226_SECRET_BASE32, seconds * 1000)).toBe(code);
  });

  it("changes every thirty seconds and no faster", () => {
    const base = 1_700_000_000_000;
    const step = totpStep(base);

    // Two instants inside the same step give the same code.
    const inside = totp(RFC4226_SECRET_BASE32, step * 30_000 + 1_000);
    const alsoInside = totp(RFC4226_SECRET_BASE32, step * 30_000 + 29_000);
    expect(inside).toBe(alsoInside);

    const next = totp(RFC4226_SECRET_BASE32, (step + 1) * 30_000 + 1_000);
    expect(next).not.toBe(inside);
  });
});

describe("verifying a code", () => {
  const now = 1_700_000_000_000;

  it("accepts the current code", () => {
    const code = totp(RFC4226_SECRET_BASE32, now);
    expect(verifyTotp(RFC4226_SECRET_BASE32, code, { now }).valid).toBe(true);
  });

  /** Phones and servers disagree by a few seconds; one step either way. */
  it("accepts the previous and next steps", () => {
    const previous = totp(RFC4226_SECRET_BASE32, now - 30_000);
    const next = totp(RFC4226_SECRET_BASE32, now + 30_000);

    expect(verifyTotp(RFC4226_SECRET_BASE32, previous, { now }).valid).toBe(true);
    expect(verifyTotp(RFC4226_SECRET_BASE32, next, { now }).valid).toBe(true);
  });

  it("refuses a code two steps old", () => {
    const stale = totp(RFC4226_SECRET_BASE32, now - 90_000);
    expect(verifyTotp(RFC4226_SECRET_BASE32, stale, { now }).valid).toBe(false);
  });

  it("refuses a code from a different secret", () => {
    const other = generateTotpSecret();
    const code = totp(other, now);

    expect(verifyTotp(RFC4226_SECRET_BASE32, code, { now }).valid).toBe(false);
  });

  it("refuses anything that is not six digits", () => {
    for (const code of ["", "12345", "1234567", "abcdef", "12 34 56 78"]) {
      expect(verifyTotp(RFC4226_SECRET_BASE32, code, { now }).valid).toBe(false);
    }
  });

  it("accepts a code typed with a space in the middle", () => {
    const code = totp(RFC4226_SECRET_BASE32, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    expect(verifyTotp(RFC4226_SECRET_BASE32, spaced, { now }).valid).toBe(true);
  });

  /**
   * The shoulder-surfing case: a code seen once must not work a second time,
   * even inside its own thirty seconds.
   */
  it("refuses a code that has already been used", () => {
    const code = totp(RFC4226_SECRET_BASE32, now);
    const first = verifyTotp(RFC4226_SECRET_BASE32, code, { now });

    expect(first.valid).toBe(true);
    expect(
      verifyTotp(RFC4226_SECRET_BASE32, code, {
        now,
        lastUsedStep: first.step,
      }).valid,
    ).toBe(false);
  });

  it("refuses an older step once a newer one has been used", () => {
    const previous = totp(RFC4226_SECRET_BASE32, now - 30_000);
    const currentStep = totpStep(now);

    expect(
      verifyTotp(RFC4226_SECRET_BASE32, previous, {
        now,
        lastUsedStep: currentStep,
      }).valid,
    ).toBe(false);
  });

  it("does not throw on a malformed secret", () => {
    expect(verifyTotp("!!!not base32!!!", "123456", { now }).valid).toBe(false);
  });
});

describe("secrets and enrolment", () => {
  it("generates a 160-bit secret", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("generates a different secret every time", () => {
    const secrets = new Set(
      Array.from({ length: 50 }, () => generateTotpSecret()),
    );
    expect(secrets.size).toBe(50);
  });

  it("builds a URI an authenticator app can read", () => {
    const uri = totpAuthUri({
      secret: RFC4226_SECRET_BASE32,
      account: "admin@example.com",
      issuer: "Manifest",
    });

    expect(uri).toContain("otpauth://totp/Manifest%3Aadmin%40example.com");
    expect(uri).toContain(`secret=${RFC4226_SECRET_BASE32}`);
    expect(uri).toContain("issuer=Manifest");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
