import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMcpServer, setNameClaims, type AgentTransport, type SessionBinding } from "../src/index.js";
import * as registry from "../src/registry.js";
import * as history from "../src/history.js";
import { MAX_RESULT_CHARS } from "../src/bounds.js";

// History reads are mocked: nothing here touches a NATS bus.
vi.mock("../src/history.js", () => ({
  getDmHistory: vi.fn(async () => []),
  getChannelHistory: vi.fn(async () => []),
  getGroupHistory: vi.fn(async () => []),
  getMessagesSince: vi.fn(async () => []),
  getMessagesForAgent: vi.fn(async () => []),
  getChannels: vi.fn(async () => []),
}));

const clients: Client[] = [];

function fakeTransport(): AgentTransport {
  return {
    getHost: () => "test-local",
    getRemotePeers: () => [],
    trackLocal: vi.fn(),
    untrackLocal: vi.fn(),
    publishBeat: vi.fn(async () => {}),
    publishBroadcast: vi.fn(),
    publishDirectMessage: vi.fn(),
    publishChannelMessage: vi.fn(),
  };
}

async function connect(transport: AgentTransport | null | (() => AgentTransport | null)) {
  let binding: SessionBinding | null = null;
  const server = createMcpServer({ getBinding: () => binding, setBinding: (v) => { binding = v; } }, transport);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "practices-test", version: "1" });
  clients.push(client);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { client, call };
}

async function registered(name: string, transport: AgentTransport | null | (() => AgentTransport | null) = fakeTransport()) {
  const c = await connect(transport);
  const reg = await c.call("agent_register", { name, description: "test", group: "g" });
  expect(reg.isError).not.toBe(true);
  return c;
}

const textOf = (result: unknown): string =>
  ((result as { content: Array<{ text: string }> }).content[0]?.text) ?? "";

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const agent of registry.getAgents()) registry.deregisterAgent(agent.id);
  setNameClaims(null);
  vi.clearAllMocks();
});

describe("execution failures carry isError", () => {
  it("flags broadcast, dm and channel_send failures with a recovery message", async () => {
    const a = await registered("fail-a");
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["agent_broadcast", { name: "fail-a", message: "   ", group: "g" }, /non-empty/],
      ["agent_broadcast", { name: "fail-a", message: "hi", group: "nowhere" }, /agent_groups/],
      ["agent_dm", { name: "fail-a", to: "fail-a", message: "hi" }, /another recipient/],
      ["agent_dm", { name: "fail-a", to: "x", message: "" }, /non-empty/],
    ];
    for (const [tool, args, hint] of cases) {
      const result = await a.call(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(textOf(result)).toMatch(hint);
    }
  });

  it("flags dm, broadcast and channel_send when no bus transport is configured", async () => {
    const a = await registered("fail-b", null);
    for (const [tool, args] of [
      ["agent_dm", { name: "fail-b", to: "x", message: "hi" }],
      ["agent_broadcast", { name: "fail-b", message: "hi", group: "g" }],
      ["channel_send", { name: "fail-b", channel: "c", message: "hi" }],
    ] as const) {
      const result = await a.call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(textOf(result)).toContain("AGENTS_NATS_URL");
    }
  });

  it("flags a call made while the bus is connecting, and recovers on the next call", async () => {
    let ready: AgentTransport | null = null;
    const c = await connect(() => ready);
    const first = await c.call("agent_discover");
    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain("Error: bus connecting, retry.");
    expect(textOf(first)).toMatch(/wait a few seconds/);
    ready = fakeTransport();
    expect((await c.call("agent_discover")).isError).not.toBe(true);
  });

  it("flags argument validation failures and an unknown tool as errors", async () => {
    const c = await connect(fakeTransport());
    const badArg = await c.call("channel_history", { channel: 5 });
    expect(badArg.isError).toBe(true);
    // SDK 1.29 reports an unknown tool as an isError result carrying -32602;
    // a newer SDK may raise it as a JSON-RPC error. Either is a failure.
    const unknown = await c.call("no_such_tool").then((r) => r, (e: { code?: number }) => ({ thrown: e.code }));
    if ("thrown" in unknown) expect(unknown.thrown).toBe(-32602);
    else {
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain("-32602");
    }
  });
});

describe("history limits", () => {
  it.each([
    ["channel_history", { channel: "c" }],
    ["group_history", { group: "g" }],
    ["messages_since", {}],
  ])("%s rejects limits outside the integers 1..500", async (tool, args) => {
    const c = await connect(fakeTransport());
    for (const limit of [0, -1, 501, 1.5, 1e9]) {
      const result = await c.call(tool, { ...args, limit });
      expect(result.isError, `${tool} limit=${limit}`).toBe(true);
    }
    expect((await c.call(tool, { ...args, limit: 500 })).isError).not.toBe(true);
    expect((await c.call(tool, { ...args, limit: 1 })).isError).not.toBe(true);
    expect((await c.call(tool, { ...args })).isError).not.toBe(true);
  });

  it("dm_history rejects a fractional limit and keeps its default", async () => {
    const a = await registered("lim-a");
    expect((await a.call("dm_history", { name: "lim-a", with_agent: "b", limit: 2.5 })).isError).toBe(true);
    await a.call("dm_history", { name: "lim-a", with_agent: "b" });
    expect(history.getDmHistory).toHaveBeenLastCalledWith("lim-a", "b", 50);
  });

  it("keeps the documented defaults", async () => {
    const c = await connect(fakeTransport());
    await c.call("channel_history", { channel: "c" });
    expect(history.getChannelHistory).toHaveBeenLastCalledWith("c", 50);
    await c.call("messages_since", {});
    expect(history.getMessagesSince).toHaveBeenLastCalledWith(0, 100);
  });
});

function bulk(count: number, size: number, startId = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    timestamp: new Date(1_700_000_000_000 + i * 1000),
    type: "CHANNEL" as const,
    from_agent: `agent${i}-x`,
    to_agent: null,
    channel: "c",
    content: `msg-${startId + i} ` + "x".repeat(size),
    origin_host: "h",
  }));
}

describe("bounded history results", () => {
  it("channel_history compact stays under the cap, newest first, and says what was omitted", async () => {
    vi.mocked(history.getChannelHistory).mockResolvedValue(bulk(500, 5_000));
    const c = await connect(fakeTransport());
    const text = textOf(await c.call("channel_history", { channel: "c", limit: 500 }));
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS);
    expect(text).toContain("msg-500 ");
    expect(text).not.toContain("msg-1 ");
    expect(text).toMatch(/\d+ older messages omitted/);
    expect(text).toContain("messages_since(since_id=0)");
    expect(text).toMatch(/channel_history \((\d+)\)|#c history \((\d+)\)/);
  });

  it("channel_history detailed stays valid JSON under the cap with omitted and note", async () => {
    vi.mocked(history.getChannelHistory).mockResolvedValue(bulk(500, 5_000));
    const c = await connect(fakeTransport());
    const text = textOf(await c.call("channel_history", { channel: "c", limit: 500, detailed: true }));
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS);
    const parsed = JSON.parse(text);
    expect(parsed.omitted).toBeGreaterThan(0);
    expect(parsed.count + parsed.omitted).toBe(500);
    expect(parsed.messages.at(-1).id).toBe(500);
    expect(parsed.note).toContain("messages_since");
  });

  it("clips one huge message instead of returning it whole", async () => {
    vi.mocked(history.getGroupHistory).mockResolvedValue(bulk(1, 500_000));
    const c = await connect(fakeTransport());
    const text = textOf(await c.call("group_history", { group: "g" }));
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS);
    expect(text).toContain("[clipped");
  });

  it("dm_history is bounded too", async () => {
    vi.mocked(history.getDmHistory).mockResolvedValue(bulk(500, 5_000));
    const a = await registered("dmb-a");
    const text = textOf(await a.call("dm_history", { name: "dmb-a", with_agent: "b", limit: 500 }));
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS);
    expect(text).toMatch(/omitted/);
  });

  it("messages_since keeps the oldest rows so last_id pages forward without a gap", async () => {
    vi.mocked(history.getMessagesSince).mockResolvedValue(bulk(500, 5_000, 101));
    const c = await connect(fakeTransport());
    const text = textOf(await c.call("messages_since", { since_id: 100, limit: 500 }));
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS);
    const parsed = JSON.parse(text);
    expect(parsed.messages[0].id).toBe(101);
    expect(parsed.last_id).toBe(parsed.messages.at(-1).id);
    expect(parsed.omitted).toBe(500 - parsed.messages.length);
    expect(parsed.note).toContain("since_id=last_id");
  });

  it("poll_messages is bounded", async () => {
    vi.mocked(history.getMessagesForAgent).mockResolvedValue(bulk(500, 5_000));
    const a = await registered("poll-a");
    const text = textOf(await a.call("poll_messages", { name: "poll-a" }));
    expect(text.length).toBeLessThan(MAX_RESULT_CHARS);
    expect(JSON.parse(text).omitted).toBeGreaterThan(0);
  });

  it("small results carry no omission note", async () => {
    vi.mocked(history.getChannelHistory).mockResolvedValue(bulk(3, 10));
    const c = await connect(fakeTransport());
    expect(textOf(await c.call("channel_history", { channel: "c" }))).not.toContain("omitted");
  });
});

describe("tool annotations", () => {
  it("declares a closed domain on every tool and the right write hints", async () => {
    const c = await connect(fakeTransport());
    const tools = new Map((await c.client.listTools()).tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(tools.size).toBe(13);
    for (const [name, a] of tools) expect(a.openWorldHint, name).toBe(false);
    for (const name of ["agent_register", "agent_broadcast", "agent_dm", "channel_send"]) {
      expect(tools.get(name)?.destructiveHint, name).toBe(false);
      expect(tools.get(name)?.readOnlyHint, name).toBe(false);
    }
    expect(tools.get("agent_register")?.idempotentHint).toBe(true);
    expect(tools.get("agent_deregister")?.idempotentHint).toBe(true);
    expect(tools.get("agent_deregister")?.destructiveHint).toBe(true);
    for (const name of ["agent_broadcast", "agent_dm", "channel_send"]) {
      expect(tools.get(name)?.idempotentHint, name).toBe(false);
    }
    for (const name of ["agent_discover", "agent_groups", "channel_history", "dm_history", "channel_list", "group_history", "messages_since", "poll_messages"]) {
      expect(tools.get(name)?.readOnlyHint, name).toBe(true);
    }
  });
});

describe("stdio SDK client", () => {
  it("sends two requests in a row and sees isError on a failure path", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["build/index.js"],
      // Port 1 refuses at once: the child never reaches a shared bus.
      env: { PATH: process.env.PATH ?? "", AGENTS_TRANSPORT: "stdio", AGENTS_NATS_URL: "nats://127.0.0.1:1", AGENTS_CODEX_NUDGES: "0" },
    });
    const client = new Client({ name: "stdio-practices", version: "1" });
    clients.push(client);
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(13);
    const first = await client.callTool({ name: "agent_discover", arguments: {} });
    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain("Error: bus connecting, retry.");
    const second = await client.callTool({ name: "channel_history", arguments: { channel: "c", limit: 0 } });
    expect(second.isError).toBe(true);
  }, 15_000);
});
