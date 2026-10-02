import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerSocket, resolveCodexNudgeTimeoutMs } from "../src/codex-nudges.js";
import { createCodexPeer, serverFrame } from "./helpers/codex-peer.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createPeer(options: Parameters<typeof createCodexPeer>[0] = {}) {
  const peer = await createCodexPeer(options);
  cleanup.push(peer.close);
  return peer;
}

function inspect(bridge: CodexAppServerSocket) {
  return bridge as unknown as {
    socket: Socket;
    pending: Map<number, { timer: ReturnType<typeof setTimeout> }>;
  };
}

async function expectClosed(bridge: CodexAppServerSocket, peer: Awaited<ReturnType<typeof createPeer>>) {
  expect(bridge.closed).toBe(true);
  expect(inspect(bridge).pending.size).toBe(0);
  expect(inspect(bridge).socket.destroyed).toBe(true);
  await peer.closed;
  await vi.waitFor(() => {
    for (const event of ["connect", "data", "error", "close"]) {
      expect(inspect(bridge).socket.listenerCount(event)).toBe(0);
    }
  });
}

describe("CodexAppServerSocket", () => {
  it("bounds a silent WebSocket handshake and rejects later requests", async () => {
    const peer = await createPeer({ handshake: "silent" });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 40 });

    await expect(bridge.request("thread/read", {})).rejects.toThrow("WebSocket handshake timed out after 40ms");
    await expectClosed(bridge, peer);
    await expect(bridge.request("thread/read", {})).rejects.toThrow("WebSocket handshake timed out");
  });

  it("bounds a silent initialize response", async () => {
    const peer = await createPeer({ initialize: "silent" });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 40 });

    await expect(bridge.request("thread/read", {})).rejects.toThrow("initialize timed out after 40ms");
    expect(peer.messages.map((message) => message.method)).toEqual(["initialize"]);
    await expectClosed(bridge, peer);
  });

  it("bounds a silent RPC and clears every concurrent pending request", async () => {
    const peer = await createPeer();
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 40 });
    await peer.ready;
    const first = bridge.request("thread/read", {});
    const second = bridge.request("turn/start", {});
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(inspect(bridge).pending.size).toBe(2), { interval: 1 });
    const timers = [...inspect(bridge).pending.values()].map((pending) => pending.timer);
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");

    const results = await settled;
    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: "app-server thread/read timed out after 40ms" }) },
      { status: "rejected", reason: expect.objectContaining({ message: "app-server thread/read timed out after 40ms" }) },
    ]);
    for (const timer of timers) expect(clearTimer).toHaveBeenCalledWith(timer);
    await expectClosed(bridge, peer);
  });

  it("completes initialization and RPCs without stale deadlines", async () => {
    const peer = await createPeer({
      onRequest: (message, socket) => socket.write(serverFrame({ id: message.id, result: { method: message.method } })),
    });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 40 });

    expect(await bridge.request("thread/read", {})).toEqual({ method: "thread/read" });
    await peer.ready;
    expect(peer.messages.map((message) => message.method)).toEqual(["initialize", "initialized", "thread/read"]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(bridge.closed).toBe(false);
    expect(await bridge.request("turn/start", {})).toEqual({ method: "turn/start" });
    bridge.close();
    await expectClosed(bridge, peer);
  });

  it("rejects promptly when the peer closes before the handshake", async () => {
    const peer = await createPeer({ handshake: "close" });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 1000 });

    await expect(bridge.request("thread/read", {})).rejects.toThrow("app-server socket closed");
    await expectClosed(bridge, peer);
  });

  it("rejects an invalid upgrade and destroys the connection", async () => {
    const peer = await createPeer({ handshake: "reject" });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 1000 });

    await expect(bridge.request("thread/read", {})).rejects.toThrow("handshake failed: HTTP/1.1 403 Forbidden");
    await expectClosed(bridge, peer);
  });

  it("rejects waiting requests when the peer closes after initialization", async () => {
    const peer = await createPeer({ onRequest: (_message, socket) => socket.end() });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 1000 });

    await expect(bridge.request("thread/read", {})).rejects.toThrow("app-server socket closed");
    await expectClosed(bridge, peer);
  });

  it("handles an eager initialization failure before request() consumes it", async () => {
    const peer = await createPeer({ initialize: "silent" });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 40 });

    await peer.closed;
    await expect(bridge.request("thread/read", {})).rejects.toThrow("initialize timed out after 40ms");
    await expectClosed(bridge, peer);
  });

  it("closes a bridge whose initialization is rejected by the peer", async () => {
    const peer = await createPeer({ initialize: "error" });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 1000 });

    await peer.closed;
    await expect(bridge.request("thread/read", {})).rejects.toThrow("initialize rejected");
    await expectClosed(bridge, peer);
  });

  it("handles an eager handshake deadline without an unhandled rejection", async () => {
    const peer = await createPeer({ handshake: "silent" });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 40 });

    await peer.closed;
    await expect(bridge.request("thread/read", {})).rejects.toThrow("WebSocket handshake timed out");
    await expectClosed(bridge, peer);
  });

  it("preserves RPC errors and leaves a responding bridge usable", async () => {
    const peer = await createPeer({
      onRequest: (message, socket) => socket.write(serverFrame({ id: message.id, error: { message: "turn is no longer active" } })),
    });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 1000 });

    await expect(bridge.request("turn/steer", {})).rejects.toThrow("turn is no longer active");
    expect(bridge.closed).toBe(false);
    expect(inspect(bridge).pending.size).toBe(0);
    bridge.close();
    await expectClosed(bridge, peer);
  });

  it("rejects socket errors and releases its listeners", async () => {
    const peer = await createPeer();
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 1000 });
    await peer.ready;
    const result = expect(bridge.request("thread/read", {})).rejects.toThrow("test socket error");

    inspect(bridge).socket.destroy(new Error("test socket error"));
    await result;
    await expectClosed(bridge, peer);
  });

  it("lets an explicit close settle requests during the handshake", async () => {
    const peer = await createPeer({ handshake: "silent" });
    const bridge = new CodexAppServerSocket(peer.socketPath, { timeoutMs: 1000 });
    const result = expect(bridge.request("thread/read", {})).rejects.toThrow("app-server socket closed");
    await vi.waitFor(() => expect(peer.sockets).toHaveLength(1), { interval: 1 });

    bridge.close();
    await result;
    await expectClosed(bridge, peer);
    bridge.close();
  });

  it("keeps path-only construction and reads its deadline from the environment", async () => {
    vi.stubEnv("AGENTS_CODEX_NUDGE_TIMEOUT_MS", "40");
    const peer = await createPeer({ handshake: "silent" });
    const bridge = new CodexAppServerSocket(peer.socketPath);

    await expect(bridge.request("thread/read", {})).rejects.toThrow("timed out after 40ms");
    await expectClosed(bridge, peer);
  });
});

describe("resolveCodexNudgeTimeoutMs", () => {
  it("uses a one-second default and accepts a positive finite override", () => {
    expect(resolveCodexNudgeTimeoutMs({})).toBe(1000);
    expect(resolveCodexNudgeTimeoutMs({ AGENTS_CODEX_NUDGE_TIMEOUT_MS: "75" })).toBe(75);
  });

  it.each(["", "0", "-1", "NaN", "Infinity", "invalid"])("rejects invalid configuration %j", (value) => {
    expect(() => resolveCodexNudgeTimeoutMs({ AGENTS_CODEX_NUDGE_TIMEOUT_MS: value })).toThrow("positive finite number");
  });

  it.each([0, -1, NaN, Infinity])("validates constructor timeout %j before opening a socket", (timeoutMs) => {
    expect(() => new CodexAppServerSocket("/unused/test.sock", { timeoutMs })).toThrow("positive finite number");
  });
});
