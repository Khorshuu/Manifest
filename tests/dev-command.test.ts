/**
 * `npm run dev` starts the web server and the local background scheduler
 * together, and stops them together (D-121).
 *
 * The web server is a small stand-in (tests/fixtures/fake-web-server.mjs), so
 * this checks the supervisor itself — what it starts, in what order, how its
 * logs read and that neither process outlives the other — without building
 * the application.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { devPlan, prefixed } from "../scripts/dev.mjs";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

describe("the development command", () => {
  it("is npm run dev, with the parts still available on their own", () => {
    const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.dev).toBe("node scripts/dev.mjs");
    expect(scripts["dev:web"]).toBe("next dev");
    expect(scripts["jobs:dev"]).toBe("node scripts/jobs/dev-scheduler.mjs");
    // The browser tests start the web server alone and drive jobs themselves.
    expect(readFileSync("playwright.config.ts", "utf8")).toContain('"npm run dev:web"');
  });

  it("starts next dev and exactly one scheduler pointed at it", () => {
    const plan = devPlan(["--port", "3100", "--every", "5"], {});
    expect(plan.web.args.slice(-3)).toEqual(["dev", "--port", "3100"]);
    expect(plan.web.args[0].replaceAll("\\", "/")).toMatch(/next\/dist\/bin\/next$/);
    expect(plan.jobs.args[0]).toMatch(/dev-scheduler\.mjs$/);
    expect(plan.jobs.args.slice(1)).toEqual(["--base", "http://localhost:3100", "--every", "5"]);
    const defaults = devPlan([], {});
    expect(defaults.base).toBe("http://localhost:3000");
    expect(defaults.jobs.args.at(-1)).toBe("15");
    expect(() => devPlan(["--every", "0"], {})).toThrow(/every/);
    expect(prefixed("jobs", "200 {}")).toBe("[jobs] 200 {}");
  });

  it("runs both, labels their logs, and stops the scheduler when the web server stops", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/dev.mjs", "--port", String(port), "--every", "1"], {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        CRON_SECRET: "dev-command-test",
        DEV_WEB_COMMAND: process.execPath,
        // The stand-in exits after its third trigger call.
        DEV_WEB_ARGS: JSON.stringify(["tests/fixtures/fake-web-server.mjs", String(port), "3"]),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    expect(output).toContain(`[web] listening on ${port}`);
    expect(output).toContain("[web] trigger 1 authorised");
    expect(output).toMatch(/\[jobs\] \S+ 200 /);
    expect(output).toContain("[dev] the web server stopped");
    // The scheduler went with it: nothing calls the port once the supervisor has exited.
    expect(code).toBe(0);
    const calls = await new Promise<number>((resolve) => {
      let seen = 0;
      const probe = createServer((socket) => {
        seen += 1;
        socket.destroy();
      }).listen(port, () => setTimeout(() => probe.close(() => resolve(seen)), 2_500));
    });
    expect(calls).toBe(0);
  }, 60_000);

  it("stops both when whatever started it is killed outright", async () => {
    const port = await freePort();
    const log = join(mkdtempSync(join(tmpdir(), "dev-command-")), "dev.log");
    // A parent that starts the command with its output going to a file — as
    // `npm run dev > dev.log` does — and is then killed without a signal
    // reaching its child. Output to a pipe would end the child another way.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs"); const out = fs.openSync(${JSON.stringify(log)}, "a");
         require("node:child_process").spawn(process.execPath, ["scripts/dev.mjs", "--port", "${port}", "--every", "1"], { stdio: ["ignore", out, out], detached: true, windowsHide: true });
         setInterval(() => {}, 1000);`,
      ],
      {
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          CRON_SECRET: "dev-command-test",
          DEV_WEB_COMMAND: process.execPath,
          DEV_WEB_ARGS: JSON.stringify(["tests/fixtures/fake-web-server.mjs", String(port)]),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    await expect.poll(output, { timeout: 30_000 }).toContain("[web] trigger 1 authorised");

    parent.kill("SIGKILL");
    // The web stand-in's port is released once the supervisor has stopped it.
    await expect
      .poll(
        () =>
          new Promise<boolean>((resolve) => {
            const probe = createServer().once("error", () => resolve(false));
            probe.listen(port, () => probe.close(() => resolve(true)));
          }),
        { timeout: 20_000, interval: 500 },
      )
      .toBe(true);
  }, 60_000);
});
