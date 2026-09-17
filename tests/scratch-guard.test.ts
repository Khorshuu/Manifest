import { describe, expect, it } from "vitest";
import { assertDisposableTestDatabase, assertScratchDatabase, UnsafeDatabaseError } from "@/db/scratch-guard";

const local = (name: string) => `postgres://postgres:postgres@127.0.0.1:5432/${name}`;

describe("the scratch database guard", () => {
  it("accepts a local database named as scratch", () => {
    expect(assertScratchDatabase(local("manifest_scale"), {})).toEqual({
      host: "127.0.0.1",
      database: "manifest_scale",
    });
  });

  it.each(["preorder", "preorder_e2e", "manifest", "production", "scaled_shop", ""])(
    "refuses %j",
    (name) => {
      expect(() => assertScratchDatabase(local(name), {})).toThrow(UnsafeDatabaseError);
    },
  );

  it("refuses a missing or malformed connection string", () => {
    expect(() => assertScratchDatabase(undefined, {})).toThrow(UnsafeDatabaseError);
    expect(() => assertScratchDatabase("not a url", {})).toThrow(UnsafeDatabaseError);
    expect(() => assertScratchDatabase("mysql://x@localhost/manifest_scale", {})).toThrow(UnsafeDatabaseError);
  });

  it("refuses when the process runs as production", () => {
    expect(() => assertScratchDatabase(local("manifest_scale"), { NODE_ENV: "production" })).toThrow(/production/);
    expect(() => assertScratchDatabase(local("manifest_scale"), { VERCEL_ENV: "production" })).toThrow(/production/);
  });

  it("refuses a remote host unless remote use is explicit", () => {
    const remote = "postgres://u:p@ep-cool-name.neon.tech/manifest_scale?sslmode=require";
    expect(() => assertScratchDatabase(remote, {})).toThrow(/not this machine/);
    expect(assertScratchDatabase(remote, { SCALE_SEED_ALLOW_REMOTE: "1" }).database).toBe("manifest_scale");
  });
});

describe("the end-to-end database, which is dropped on every run", () => {
  const admin = "postgres://postgres:postgres@127.0.0.1:5432/postgres";

  it("accepts the suite's own database on this machine", () => {
    expect(assertDisposableTestDatabase(admin, "preorder_e2e", {})).toEqual({ host: "127.0.0.1", database: "preorder_e2e" });
  });

  it("refuses a database not named as a test one", () => {
    for (const name of ["preorder", "neondb", "postgres", "production", "e2e_shop; drop", "latest"]) {
      expect(() => assertDisposableTestDatabase(admin, name, {})).toThrow(UnsafeDatabaseError);
    }
  });

  it("refuses when the process runs as production", () => {
    expect(() => assertDisposableTestDatabase(admin, "preorder_e2e", { VERCEL_ENV: "production" })).toThrow(/production/);
  });

  it("refuses a remote host unless a disposable branch is declared", () => {
    const remote = "postgres://u:p@ep-cool-name.neon.tech/neondb?sslmode=require";
    expect(() => assertDisposableTestDatabase(remote, "preorder_e2e", {})).toThrow(/not this machine/);
    expect(assertDisposableTestDatabase(remote, "preorder_e2e", { E2E_ALLOW_REMOTE_DATABASE: "1" }).database).toBe("preorder_e2e");
  });
});
