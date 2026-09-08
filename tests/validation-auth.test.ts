import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "@/lib/validation/auth";

describe("login schema", () => {
  it("normalises email casing and surrounding space", () => {
    const parsed = loginSchema.parse({
      email: "  Admin@Example.COM ",
      password: "x",
    });
    expect(parsed.email).toBe("admin@example.com");
  });

  it("rejects unknown fields rather than silently dropping them", () => {
    const result = loginSchema.safeParse({
      email: "admin@example.com",
      password: "x",
      role: "super_admin",
    });
    expect(result.success).toBe(false);
  });
});

describe("register schema", () => {
  it("requires a password of at least 10 characters", () => {
    const result = registerSchema.safeParse({
      email: "new@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a client-supplied role", () => {
    const result = registerSchema.safeParse({
      email: "new@example.com",
      password: "a-long-enough-password",
      role: "super_admin",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a Bangladeshi phone number", () => {
    const parsed = registerSchema.parse({
      email: "new@example.com",
      phone: "+8801700000000",
      password: "a-long-enough-password",
    });
    expect(parsed.phone).toBe("+8801700000000");
  });
});
