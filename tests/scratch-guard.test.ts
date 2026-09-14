import { describe, expect, it } from "vitest";
import { assertScratchDatabase, UnsafeDatabaseError } from "@/db/scratch-guard";

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
