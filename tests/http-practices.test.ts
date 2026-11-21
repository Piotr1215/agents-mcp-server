import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request, type Server } from "node:http";
import { createHttpServer, MAX_BODY_BYTES, type AgentTransport } from "../src/index.js";
import { readHttpSecurityPolicy } from "../src/http-security.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function fakeTransport(): AgentTransport {
  return {
    getHost: () => "test-local", getRemotePeers: () => [],
    trackLocal: vi.fn(), untrackLocal: vi.fn(), publishBeat: vi.fn(async () => {}),
    publishBroadcast: vi.fn(), publishDirectMessage: vi.fn(), publishChannelMessage: vi.fn(),
  };
}

async function endpoint(env: NodeJS.ProcessEnv = {}) {
  const server = createHttpServer(fakeTransport(), readHttpSecurityPolicy(env));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => closeServer(server));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
} });

// Wire-level POST that streams `chunks` of `size` bytes with no Content-Length.
function postChunked(url: string, chunks: number, size: number, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(`${url}/mcp`, { method: "POST", headers: { ...headers, ...extra } }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    const piece = Buffer.alloc(size, 0x20);
    for (let i = 0; i < chunks; i++) req.write(piece);
    req.end();
  });
}

describe("HTTP request body cap", () => {
  it("answers 413 with a JSON-RPC error when Content-Length exceeds the cap", async () => {
    const url = await endpoint();
    const response = await fetch(`${url}/mcp`, { method: "POST", headers, body: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32600);
    expect(body.id).toBeNull();
  });

  it("stops a chunked upload with no Content-Length once it passes the cap", async () => {
    const url = await endpoint();
    const result = await postChunked(url, 48, 64 * 1024);
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).error.message).toContain("exceeds");
  });

  it("still accepts a body just under the cap path (normal initialize) and serves later requests", async () => {
    const url = await endpoint();
    const response = await fetch(`${url}/mcp`, { method: "POST", headers, body: initialize });
    expect(response.status).toBe(200);
    const id = response.headers.get("mcp-session-id");
    await response.text();
    await fetch(`${url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": id! } }).then((r) => r.text());
  });

  it("checks Origin and Host before reading: a forbidden request with a huge body is 403", async () => {
    const url = await endpoint();
    const result = await postChunked(url, 48, 64 * 1024, { origin: "https://attacker.example" }).catch((e: NodeJS.ErrnoException) => ({ status: 403, body: e.code ?? "" }));
    expect(result.status).toBe(403);
    const host = await postChunked(url, 48, 64 * 1024, { host: "attacker.example" }).catch(() => ({ status: 403, body: "" }));
    expect(host.status).toBe(403);
  });

  it("answers malformed JSON with a 400 parse error, not a 500 with exception text", async () => {
    const url = await endpoint();
    const response = await fetch(`${url}/mcp`, { method: "POST", headers, body: "{not json" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe(-32700);
    expect(JSON.stringify(body)).not.toContain("Unexpected token");
  });
});

describe("SDK client over the HTTP router", () => {
  it("sends several requests in a row and sees isError on failure paths", async () => {
    const url = await endpoint();
    const client = new Client({ name: "http-practices", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
    await client.connect(transport);
    cleanup.push(async () => { await transport.terminateSession(); await client.close(); });

    expect((await client.callTool({ name: "agent_register", arguments: { name: "hp-a", description: "t", group: "g" } })).isError).not.toBe(true);
    const empty = await client.callTool({ name: "agent_dm", arguments: { name: "hp-a", to: "hp-b", message: "  " } });
    expect(empty.isError).toBe(true);
    const self = await client.callTool({ name: "agent_dm", arguments: { name: "hp-a", to: "hp-a", message: "hi" } });
    expect(self.isError).toBe(true);
    const badLimit = await client.callTool({ name: "channel_history", arguments: { channel: "c", limit: 9999 } });
    expect(badLimit.isError).toBe(true);
    expect((await client.callTool({ name: "agent_groups", arguments: {} })).isError).not.toBe(true);
    const tools = await client.listTools();
    expect(tools.tools.every((t) => t.annotations?.openWorldHint === false)).toBe(true);
  });
});
