import { describe, expect, it, vi } from "vitest";
import {
  deliverCodexNudge,
  encodeClientTextFrame,
  readCodexBinding,
  readCodexThreadBinding,
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
