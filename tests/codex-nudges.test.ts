import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliverBoundedCodexNudge,
  deliverCodexNudge,
  encodeClientTextFrame,
  readCodexBinding,
  readCodexThreadBinding,
  resolveCodexHome,
  resolveCodexSocketPath,
  type AppServerRpc,
} from "../src/codex-nudges.js";

function rpcWithThread(thread: unknown): AppServerRpc {
  return {
    request: vi.fn(async (method: string) => {
      if (method === "thread/read") return { thread };
      return {};
    }),
  };
}

const message = {
  fromAgent: "klod",
  content: "Hostile entered local",
  originHost: "serval",
};

describe("deliverCodexNudge", () => {
  it("starts a turn when the Codex thread is idle", async () => {
    const rpc = rpcWithThread({ status: { type: "idle" }, turns: [] });

    expect(await deliverCodexNudge(rpc, "thread-1", message)).toBe("started");
    expect(rpc.request).toHaveBeenLastCalledWith("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "<dm> [klod@serval] Hostile entered local" }],
    });
  });

  it("steers the active turn using its in-progress turn id", async () => {
    const rpc = rpcWithThread({
      status: { type: "active", activeFlags: [] },
      turns: [
        { id: "turn-old", status: "completed" },
        { id: "turn-live", status: "inProgress" },
      ],
    });

    expect(await deliverCodexNudge(rpc, "thread-1", message)).toBe("steered");
    expect(rpc.request).toHaveBeenLastCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-live",
      input: [{ type: "text", text: "<dm> [klod@serval] Hostile entered local" }],
    });
  });

  it("labels group broadcasts distinctly from direct messages", async () => {
    const rpc = rpcWithThread({ status: { type: "idle" }, turns: [] });

    expect(await deliverCodexNudge(rpc, "thread-1", {
      ...message,
      kind: "broadcast",
      group: "rag-eval",
    })).toBe("started");
    expect(rpc.request).toHaveBeenLastCalledWith("turn/start", {
      threadId: "thread-1",
      input: [{
        type: "text",
        text: "<bcast group=\"rag-eval\"> [klod@serval] Hostile entered local",
      }],
    });
  });

  it("does not revive a thread that is not loaded in a Codex client", async () => {
    const rpc = rpcWithThread({ status: { type: "notLoaded" }, turns: [] });

    expect(await deliverCodexNudge(rpc, "thread-1", message)).toBe("skipped");
    expect(rpc.request).toHaveBeenCalledTimes(1);
  });

  it("does not guess when an active thread has no in-progress turn", async () => {
    const rpc = rpcWithThread({
      status: { type: "active", activeFlags: [] },
      turns: [{ id: "turn-old", status: "completed" }],
    });

    expect(await deliverCodexNudge(rpc, "thread-1", message)).toBe("skipped");
    expect(rpc.request).toHaveBeenCalledTimes(1);
  });

  it("retries as a new turn when the active turn finishes during steering", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ thread: {
        status: { type: "active", activeFlags: [] },
        turns: [{ id: "turn-live", status: "inProgress" }],
      } })
      .mockRejectedValueOnce(new Error("turn is no longer active"))
      .mockResolvedValueOnce({ thread: { status: { type: "idle" }, turns: [] } })
      .mockResolvedValueOnce({});

    expect(await deliverCodexNudge({ request }, "thread-1", message)).toBe("started");
    expect(request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({ threadId: "thread-1" }));
  });

  it("rejects a malformed thread/read response", async () => {
    const rpc: AppServerRpc = { request: vi.fn(async () => ({})) };

    await expect(deliverCodexNudge(rpc, "thread-1", message)).rejects.toThrow(
      "thread/read returned no thread",
    );
  });
});

describe("deliverBoundedCodexNudge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function delayedRpc(responses: unknown[], delayMs: number) {
    const pending = new Map<ReturnType<typeof setTimeout>, (error: Error) => void>();
    return {
      request: vi.fn((_method: string, _params: Record<string, unknown>) => new Promise((resolve, reject) => {
        const response = responses.shift();
        const timer = setTimeout(() => {
          pending.delete(timer);
          if (response instanceof Error) reject(response);
          else resolve(response);
        }, delayMs);
        pending.set(timer, reject);
      })),
      close: vi.fn(() => {
        for (const [timer, reject] of pending) {
          clearTimeout(timer);
          reject(new Error("app-server socket closed"));
        }
        pending.clear();
      }),
    };
  }

  it("closes a never-responding RPC at the delivery deadline", async () => {
    const rpc = { request: vi.fn(() => new Promise(() => {})), close: vi.fn() };
    const rejected = expect(deliverBoundedCodexNudge(rpc, "thread-1", message, 75))
      .rejects.toThrow("Codex nudge delivery timed out after 75ms");

    await vi.advanceTimersByTimeAsync(74);
    expect(rpc.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(rpc.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds read and start together even when each response is quick", async () => {
    const rpc = delayedRpc([{ thread: { status: { type: "idle" }, turns: [] } }, {}], 40);
    const rejected = expect(deliverBoundedCodexNudge(rpc, "thread-1", message, 60))
      .rejects.toThrow("delivery timed out after 60ms");

    await vi.advanceTimersByTimeAsync(60);
    await rejected;
    expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "turn/start"]);
    expect(rpc.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original deadline through the steer retry", async () => {
    const rpc = delayedRpc([
      { thread: { status: { type: "active" }, turns: [{ id: "turn-1", status: "inProgress" }] } },
      new Error("turn is no longer active"),
      { thread: { status: { type: "idle" }, turns: [] } },
      {},
    ], 20);
    const rejected = expect(deliverBoundedCodexNudge(rpc, "thread-1", message, 70))
      .rejects.toThrow("delivery timed out after 70ms");

    await vi.advanceTimersByTimeAsync(70);
    await rejected;
    expect(rpc.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read", "turn/steer", "thread/read", "turn/start",
    ]);
    expect(rpc.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after success without closing the bridge later", async () => {
    const rpc = { ...rpcWithThread({ status: { type: "idle" }, turns: [] }), close: vi.fn() };

    expect(await deliverBoundedCodexNudge(rpc, "thread-1", message, 75)).toBe("started");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(rpc.close).not.toHaveBeenCalled();
  });

  it("propagates an RPC failure and clears the deadline", async () => {
    const error = new Error("thread read failed");
    const rpc = { request: vi.fn().mockRejectedValue(error), close: vi.fn() };

    await expect(deliverBoundedCodexNudge(rpc, "thread-1", message, 75)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(rpc.close).not.toHaveBeenCalled();
  });

  it("still rejects the deadline if closing the failed bridge throws", async () => {
    const cause = new Error("close failed");
    const rpc = {
      request: vi.fn(() => new Promise(() => {})),
      close: vi.fn(() => { throw cause; }),
    };
    const rejected = expect(deliverBoundedCodexNudge(rpc, "thread-1", message, 75))
      .rejects.toMatchObject({ message: "Codex nudge delivery timed out after 75ms", cause });

    await vi.advanceTimersByTimeAsync(75);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the configured delivery deadline by default", async () => {
    vi.stubEnv("AGENTS_CODEX_NUDGE_TIMEOUT_MS", "50");
    const rpc = { request: vi.fn(() => new Promise(() => {})), close: vi.fn() };
    const rejected = expect(deliverBoundedCodexNudge(rpc, "thread-1", message))
      .rejects.toThrow("delivery timed out after 50ms");

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(rpc.close).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid delivery budget before requesting or scheduling work", async () => {
    const rpc = { request: vi.fn(), close: vi.fn() };

    await expect(deliverBoundedCodexNudge(rpc, "thread-1", message, 0)).rejects.toThrow("positive finite number");
    expect(rpc.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("encodeClientTextFrame", () => {
  it("creates a masked WebSocket text frame", () => {
    const frame = encodeClientTextFrame("hello", Buffer.from([1, 2, 3, 4]));

    expect([...frame.subarray(0, 6)]).toEqual([0x81, 0x85, 1, 2, 3, 4]);
    const decoded = frame.subarray(6).map((byte, i) => byte ^ [1, 2, 3, 4][i % 4]);
    expect(decoded.toString()).toBe("hello");
  });
});

describe("readCodexThreadBinding", () => {
  it("reads the registered thread from the encoded agent binding path", () => {
    const readText = vi.fn(() => JSON.stringify({ agent: "greta/kube", thread_id: "thread-123" }));

    expect(readCodexThreadBinding("greta/kube", "/codex", readText)).toBe("thread-123");
    expect(readText).toHaveBeenCalledWith("/codex/agent-bindings/greta%2Fkube.json");
  });

  it("reads the pane-specific app-server socket with the thread", () => {
    const readText = vi.fn(() => JSON.stringify({
      agent: "greta",
      thread_id: "thread-123",
      socket_path: "/codex/app-server-control/pane/app-server-control.sock",
    }));

    expect(readCodexBinding("greta", "/codex", readText)).toEqual({
      threadId: "thread-123",
      socketPath: "/codex/app-server-control/pane/app-server-control.sock",
    });
  });

  it("returns null for a missing or malformed binding", () => {
    expect(readCodexThreadBinding("greta", "/codex", () => { throw new Error("missing"); })).toBeNull();
    expect(readCodexThreadBinding("greta", "/codex", () => "{}" )).toBeNull();
  });
});

describe("Codex MCP environment", () => {
  it("prefers the dedicated agents binding root over the generic Codex home", () => {
    expect(resolveCodexHome({
      AGENTS_CODEX_HOME: "/codex/work",
      CODEX_HOME: "/codex/personal",
    }, "/home/tester")).toBe("/codex/work");
  });

  it("prefers the dedicated pane socket over the generic app-server socket", () => {
    expect(resolveCodexSocketPath({
      AGENTS_CODEX_APP_SERVER_SOCKET: "/codex/work/pane.sock",
      CODEX_APP_SERVER_SOCKET: "/codex/personal/global.sock",
    }, "/home/tester")).toBe("/codex/work/pane.sock");
  });

  it("keeps the legacy Codex environment as a fallback", () => {
    const env = { CODEX_HOME: "/codex/legacy" };

    expect(resolveCodexHome(env, "/home/tester")).toBe("/codex/legacy");
    expect(resolveCodexSocketPath(env, "/home/tester")).toBe(
      "/codex/legacy/app-server-control/app-server-control.sock",
    );
  });
});
