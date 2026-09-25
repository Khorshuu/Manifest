// Stands in for `next dev` in tests/dev-command.test.ts: answers the readiness
// probe and the job trigger, logs each trigger call, and exits after a few.
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const stopAfter = Number(process.argv[3] ?? "0");
let calls = 0;
const server = createServer((request, response) => {
  if (request.url === "/api/cron/jobs") {
    const authorised = request.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
    calls += 1;
    console.log(`trigger ${calls} ${authorised ? "authorised" : "refused"}`);
    response.writeHead(authorised ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify({ succeeded: 0 }));
    if (stopAfter && calls >= stopAfter) setTimeout(() => process.exit(0), 50);
    return;
  }
  response.writeHead(200);
  response.end("ok");
});
server.listen(port, () => console.log(`listening on ${port}`));
