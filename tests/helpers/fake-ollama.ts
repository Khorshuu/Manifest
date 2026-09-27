import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Ollama's local HTTP API (D-124), on a loopback port. It
 * answers `/api/tags` and `/api/chat` from scripts the test supplies and
 * records every request, so a test can see exactly what a provider sent —
 * and that it sent no key.
 */

export type ChatRequest = {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  format: unknown;
  options?: Record<string, unknown>;
};

export type ChatReply = { status?: number; content?: string; doneReason?: string; raw?: string };

export type FakeOllama = {
  url: string;
  requests: { path: string; headers: http.IncomingHttpHeaders; body: ChatRequest | null }[];
  models: string[];
  chat: (request: ChatRequest, index: number) => ChatReply;
  close(): Promise<void>;
};

export async function startFakeOllama(options: { models?: string[]; chat?: FakeOllama["chat"] } = {}): Promise<FakeOllama> {
  const fake: FakeOllama = {
    url: "",
    requests: [],
    models: options.models ?? ["qwen2.5:7b"],
    chat: options.chat ?? (() => ({ content: '{"candidates":[]}' })),
    close: async () => undefined,
  };
  let chats = 0;
  const server = http.createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const body = text ? (JSON.parse(text) as ChatRequest) : null;
      fake.requests.push({ path: request.url ?? "", headers: request.headers, body });
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(typeof value === "string" ? value : JSON.stringify(value));
      };
      if (request.url === "/api/tags") return json(200, { models: fake.models.map((name) => ({ name, model: name })) });
      if (request.url === "/api/chat" && body) {
        if (!fake.models.includes(body.model) && !fake.models.includes(`${body.model}:latest`)) {
          return json(404, { error: `model '${body.model}' not found, try pulling it first` });
        }
        const reply = fake.chat(body, chats++);
        if (reply.raw !== undefined) return json(reply.status ?? 200, reply.raw);
        return json(reply.status ?? 200, {
          model: body.model,
          message: { role: "assistant", content: reply.content ?? "" },
          done: true,
          done_reason: reply.doneReason ?? "stop",
          prompt_eval_count: 1200,
          eval_count: 300,
        });
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}

/** A loopback port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
