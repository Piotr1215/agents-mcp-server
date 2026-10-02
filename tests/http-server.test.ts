import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { request, type Server } from "node:http";
import { createHttpServer, type AgentTransport } from "../src/index.js";
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
  const transport = fakeTransport();
  const server = createHttpServer(transport, readHttpSecurityPolicy(env));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => closeServer(server));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  return { url: `http://127.0.0.1:${address.port}`, transport };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function caller(url: string) {
  const client = new Client({ name: "http-security-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  await client.connect(transport);
  cleanup.push(async () => { await transport.terminateSession(); await client.close(); });
  return client;
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
} });
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("protected HTTP MCP endpoint", () => {
  it("accepts native clients without Origin and enforces ownership across HTTP sessions", async () => {
    const { url, transport } = await endpoint();
    const alice = await caller(url);
    const bob = await caller(url);
    for (const [client, name] of [[alice, "http-alice"], [bob, "http-bob"]] as const) {
      expect((await client.callTool({ name: "agent_register", arguments: { name, description: "test" } })).isError).not.toBe(true);
    }
    expect((await bob.callTool({ name: "agent_deregister", arguments: { name: "http-alice" } })).isError).toBe(true);
    expect((await bob.callTool({ name: "agent_dm", arguments: { name: "http-alice", to: "http-bob", message: "forged" } })).isError).toBe(true);
    expect(transport.publishDirectMessage).not.toHaveBeenCalled();
    expect((await alice.callTool({ name: "agent_dm", arguments: { name: "http-alice", to: "http-bob", message: "valid" } })).isError).not.toBe(true);
    expect(transport.publishDirectMessage).toHaveBeenCalledWith("http-bob", "http-alice", "valid");
  });

  it.each(["https://attacker.example", "null", "malformed"])("rejects Origin %s before parsing or allocating a session", async (origin) => {
    const { url } = await endpoint();
    const baseline = await (await fetch(`${url}/health`)).json();
    const response = await fetch(`${url}/mcp`, { method: "POST", headers: { ...headers, origin }, body: "{" });
    expect(response.status).toBe(403);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    await response.text();
    expect((await (await fetch(`${url}/health`)).json()).sessions).toBe(baseline.sessions);
  });

  it("permits an explicitly listed browser Origin", async () => {
    const { url } = await endpoint({ AGENTS_HTTP_ALLOWED_ORIGINS: "https://client.example" });
    const response = await fetch(`${url}/mcp`, {
      method: "POST", headers: { ...headers, origin: "https://client.example" }, body: initialize,
    });
    expect(response.status).toBe(200);
    const id = response.headers.get("mcp-session-id");
    expect(id).not.toBeNull();
    await response.text();
    const deleted = await fetch(`${url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": id! } });
    expect(deleted.status).toBe(200);
    await deleted.text();
  });

  it.each(["GET", "DELETE"])("checks Origin on %s as well as POST", async (method) => {
    const { url } = await endpoint();
    const response = await fetch(`${url}/mcp`, { method, headers: { origin: "https://attacker.example" } });
    expect(response.status).toBe(403);
    await response.text();
  });

  it.each([
    [{ "content-type": "application/json", accept: "application/json" }, 406],
    [{ ...headers, "content-type": "text/plain" }, 415],
  ])("closes a new session when SDK request validation rejects initialization (%s)", async (requestHeaders, status) => {
    const { url } = await endpoint();
    const close = vi.spyOn(StreamableHTTPServerTransport.prototype, "close");
    const response = await fetch(`${url}/mcp`, { method: "POST", headers: requestHeaders, body: initialize });
    expect(response.status).toBe(status);
    await response.text();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it.each(["attacker.example", "[::1%lo0]"])("rejects Host %s before initialization", async (host) => {
    const { url } = await endpoint();
    // fetch can replace Host; use Node's wire request to exercise the real header.
    const response = await new Promise<{ status?: number; sessionId?: string }>((resolve, reject) => {
      const req = request(`${url}/mcp`, {
        method: "POST", headers: { ...headers, host },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, sessionId: res.headers["mcp-session-id"] as string | undefined }));
      });
      req.on("error", reject);
      req.end(initialize);
    });
    expect(response.status).toBe(403);
    expect(response.sessionId).toBeUndefined();
  });
});
