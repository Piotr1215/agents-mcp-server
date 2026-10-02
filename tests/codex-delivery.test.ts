import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHttpServer, pushToSessions, type AgentTransport } from "../src/index.js";
import { readHttpSecurityPolicy } from "../src/http-security.js";
import { CHANNEL_METHOD } from "../src/notifications.js";
import * as registry from "../src/registry.js";
import { createCodexPeer, serverFrame } from "./helpers/codex-peer.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

function fakeTransport(): AgentTransport {
  return {
    getHost: () => "test-local", getRemotePeers: () => [],
    trackLocal: vi.fn(), untrackLocal: vi.fn(), publishBeat: vi.fn(async () => {}),
    publishBroadcast: vi.fn(), publishDirectMessage: vi.fn(), publishChannelMessage: vi.fn(),
  };
}

async function environment() {
  const home = await mkdtemp(join(tmpdir(), "agents-codex-bindings-test-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "agent-bindings"));
  vi.stubEnv("AGENTS_CODEX_HOME", home);
  vi.stubEnv("AGENTS_CODEX_NUDGES", "1");
  vi.stubEnv("AGENTS_CODEX_NUDGE_TIMEOUT_MS", "150");
  return {
    bind: (name: string, socketPath: string) => writeFile(
      join(home, "agent-bindings", `${encodeURIComponent(name)}.json`),
      JSON.stringify({ thread_id: "isolated-thread", socket_path: socketPath }),
    ),
  };
}

async function endpoint() {
  const transport = fakeTransport();
  const server = createHttpServer(transport, readHttpSecurityPolicy({}));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => closeServer(server));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const url = `http://127.0.0.1:${address.port}`;
  const sessionCount = async () => {
    const health = await (await fetch(`${url}/health`)).json() as { sessions: number };
    return health.sessions;
  };
  return { url, transport, sessionCount };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const channelNotification = z.object({
  method: z.literal(CHANNEL_METHOD),
  params: z.object({ content: z.string() }).passthrough(),
});

async function caller(url: string, name: string, group: string) {
  const client = new Client({ name: "codex-delivery-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  const notifications: string[] = [];
  client.setNotificationHandler(channelNotification, (notification) => {
    notifications.push(notification.params.content);
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await transport.terminateSession(); }
    finally { await client.close(); }
  };
  cleanup.push(close);
  await client.connect(transport);
  expect((await client.callTool({
    name: "agent_register", arguments: { name, group, description: "isolated runtime test" },
  })).isError).not.toBe(true);
  return { client, notifications, close };
}

function broadcast(group: string, content: string, sequence: number) {
  return {
    fromAgent: "runtime-sender", originHost: "test-remote", group, content,
    originTs: Date.now(), originSeq: sequence,
  };
}

describe("HTTP Codex nudge delivery", () => {
  it("keeps fanout bounded and reconnects after a silent Codex thread/read", async () => {
    const bindings = await environment();
    const peer = await createCodexPeer({
      onRequest: (message, socket, connection) => {
        if (connection === 0) return;
        socket.write(serverFrame({
          id: message.id,
          result: message.method === "thread/read"
            ? { thread: { status: { type: "idle" }, turns: [] } }
            : {},
        }));
      },
    });
    cleanup.push(peer.close);
    const group = "codex-runtime-fanout";
    const codexName = "codex-runtime-recipient";
    await bindings.bind(codexName, peer.socketPath);
    const http = await endpoint();
    const baselineSessions = await http.sessionCount();
    const codex = await caller(http.url, codexName, group);
    const healthy = await caller(http.url, "healthy-runtime-recipient", group);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let firstSettled = false;
    const started = performance.now();
    const firstPush = pushToSessions("broadcast", broadcast(group, "first runtime message", 1), http.transport)
      .then(() => { firstSettled = true; });

    await vi.waitFor(() => expect(healthy.notifications.some((content) => content.includes("first runtime message"))).toBe(true), { interval: 1 });
    expect(firstSettled).toBe(false);
    await firstPush;
    expect(performance.now() - started).toBeLessThan(750);
    await peer.closed;
    expect(peer.sockets).toHaveLength(1);
    expect(peer.sockets[0].destroyed).toBe(true);
    expect(peer.records.filter(({ connection }) => connection === 0).map(({ message }) => message.method))
      .toEqual(["initialize", "initialized", "thread/read"]);
    expect(errors).toHaveBeenCalledWith("[codex-nudge] delivery failed:", expect.stringContaining("timed out"));

    await pushToSessions("broadcast", broadcast(group, "second runtime message", 2), http.transport);
    await vi.waitFor(() => expect(healthy.notifications.some((content) => content.includes("second runtime message"))).toBe(true), { interval: 1 });
    expect(peer.sockets).toHaveLength(2);
    expect(peer.sockets[1].destroyed).toBe(false);
    expect(peer.records.filter(({ connection }) => connection === 1).map(({ message }) => message.method))
      .toEqual(["initialize", "initialized", "thread/read", "turn/start"]);
    expect(peer.records.find(({ connection, message }) => connection === 1 && message.method === "turn/start")?.message.params)
      .toMatchObject({ threadId: "isolated-thread", input: [{
        type: "text", text: `<bcast group="${group}"> [runtime-sender@test-remote] second runtime message`,
      }] });
    expect(errors).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(codex.notifications).toHaveLength(2), { interval: 1 });

    await codex.close();
    await healthy.close();
    await vi.waitFor(() => expect(peer.sockets.every((socket) => socket.destroyed)).toBe(true), { interval: 1 });
    expect(await http.sessionCount()).toBe(baselineSessions);
    expect(registry.getAgentByName(codexName)).toBeNull();
    expect(registry.getAgentByName("healthy-runtime-recipient")).toBeNull();
  }, 2000);

  it.each(["deregistration", "session deletion", "binding rename"] as const)("closes the Codex bridge on %s", async (action) => {
    const bindings = await environment();
    const peer = await createCodexPeer({
      onRequest: (message, socket) => socket.write(serverFrame({
        id: message.id, result: { thread: { status: { type: "notLoaded" }, turns: [] } },
      })),
    });
    cleanup.push(peer.close);
    const name = `codex-runtime-${action.replace(" ", "-")}`;
    const group = "codex-runtime-lifecycle";
    await bindings.bind(name, peer.socketPath);
    const http = await endpoint();
    const baselineSessions = await http.sessionCount();
    const recipient = await caller(http.url, name, group);
    await pushToSessions("broadcast", broadcast(group, "lifecycle runtime message", 1), http.transport);
    expect(peer.sockets).toHaveLength(1);
    expect(peer.sockets[0].destroyed).toBe(false);

    if (action === "deregistration") {
      expect((await recipient.client.callTool({ name: "agent_deregister", arguments: { name } })).isError)
        .not.toBe(true);
      expect(await http.sessionCount()).toBe(baselineSessions + 1);
    } else if (action === "binding rename") {
      expect((await recipient.client.callTool({ name: "agent_register", arguments: {
        name: `${name}-renamed`, group, description: "renamed runtime recipient",
      } })).isError).not.toBe(true);
      expect(registry.getAgentByName(`${name}-renamed`)).not.toBeNull();
      expect(await http.sessionCount()).toBe(baselineSessions + 1);
    } else await recipient.close();
    await peer.closed;
    expect(peer.sockets[0].destroyed).toBe(true);
    expect(registry.getAgentByName(name)).toBeNull();
    expect(http.transport.untrackLocal).toHaveBeenCalledTimes(1);
    await pushToSessions("broadcast", broadcast(group, "after release", 2), http.transport);
    expect(peer.sockets).toHaveLength(1);
    await recipient.close();
    expect(await http.sessionCount()).toBe(baselineSessions);
    expect(registry.getAgentByName(`${name}-renamed`)).toBeNull();
  });
});
