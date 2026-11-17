import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type AgentTransport, type SessionBinding } from "../src/index.js";
import * as registry from "../src/registry.js";
import * as history from "../src/history.js";
import { NatsTransport } from "../src/nats.js";
import { resolveWorkerDm } from "../src/dm-intake.js";

vi.mock("../src/dm-intake.js", () => ({
  resolveWorkerDm: vi.fn(async (): Promise<"resolved" | "show" | "fallback"> => "resolved"),
  shouldRouteWorkerDm: (from: string, to: string) => from === "worker" && to === "triage",
}));

vi.mock("../src/history.js", () => ({
  getDmHistory: vi.fn(async () => []),
  getMessagesForAgent: vi.fn(async () => []),
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

async function caller(transport: AgentTransport) {
  let binding: SessionBinding | null = null;
  const server = createMcpServer({
    getBinding: () => binding,
    setBinding: (value) => { binding = value; },
  }, transport);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "ownership-test", version: "1" });
  clients.push(client);
  await client.connect(clientTransport);
  return {
    client,
    binding: () => binding,
    call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }),
    register: (name: string, group = "test") => client.callTool({
      name: "agent_register", arguments: { name, group, description: "test caller" },
    }),
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const agent of registry.getAgents()) registry.deregisterAgent(agent.id);
  vi.clearAllMocks();
});

describe("MCP session ownership", () => {
  it.each([
    ["agent_dm", { to: "bob", message: "forged" }],
    ["agent_broadcast", { message: "forged", group: "test" }],
    ["channel_send", { channel: "test", message: "forged" }],
    ["agent_deregister", {}],
    ["dm_history", { with_agent: "bob" }],
    ["poll_messages", {}],
  ])("rejects another caller's name in %s before side effects", async (tool, args) => {
    const transport = fakeTransport();
    const alice = await caller(transport);
    const bob = await caller(transport);
    await alice.register("alice");
    await bob.register("bob");

    const result = await bob.call(tool, { name: "alice", ...args });

    expect(result.isError).toBe(true);
    expect(alice.binding()?.name).toBe("alice");
    expect(registry.getAgentByName("alice")).not.toBeNull();
    expect(transport.publishDirectMessage).not.toHaveBeenCalled();
    expect(transport.publishBroadcast).not.toHaveBeenCalled();
    expect(transport.publishChannelMessage).not.toHaveBeenCalled();
    expect(transport.untrackLocal).not.toHaveBeenCalled();
    expect(history.getDmHistory).not.toHaveBeenCalled();
    expect(history.getMessagesForAgent).not.toHaveBeenCalled();
  });

  it("requires registration for channel sends", async () => {
    const transport = fakeTransport();
    const unbound = await caller(transport);
    expect((await unbound.call("channel_send", {
      name: "alice", channel: "test", message: "unbound",
    })).isError).toBe(true);
    expect(transport.publishChannelMessage).not.toHaveBeenCalled();
  });

  it("rejects a duplicate name while preserving both owners", async () => {
    const transport = fakeTransport();
    const alice = await caller(transport);
    const bob = await caller(transport);
    await alice.register("alice");
    await bob.register("bob");
    expect((await bob.register("alice")).isError).toBe(true);
    expect(alice.binding()?.name).toBe("alice");
    expect(bob.binding()?.name).toBe("bob");
    expect(registry.getAgentByName("alice")).not.toBeNull();
    expect(registry.getAgentByName("bob")).not.toBeNull();
  });

  it("allows owner sends, private reads, and a group change", async () => {
    const transport = fakeTransport();
    const alice = await caller(transport);
    const bob = await caller(transport);
    await alice.register("alice");
    await bob.register("bob");
    expect((await alice.register("alice", "updated")).isError).not.toBe(true);
    expect(alice.binding()?.group).toBe("updated");
    expect((await alice.call("agent_dm", { name: "alice", to: "bob", message: "hello" })).isError).not.toBe(true);
    expect((await alice.call("agent_broadcast", { name: "alice", message: "hello" })).isError).not.toBe(true);
    expect((await alice.call("channel_send", { name: "alice", channel: "test", message: "hello" })).isError).not.toBe(true);
    expect((await alice.call("dm_history", { name: "alice", with_agent: "bob" })).isError).not.toBe(true);
    expect((await alice.call("poll_messages", { name: "alice" })).isError).not.toBe(true);
    expect(transport.publishDirectMessage).toHaveBeenCalledWith("bob", "alice", "hello");
    expect(transport.publishBroadcast).toHaveBeenCalledWith("updated", "alice", "hello");
    expect(transport.publishChannelMessage).toHaveBeenCalledWith("test", "alice", "hello");
    expect(history.getDmHistory).toHaveBeenCalledWith("alice", "bob", 50);
    expect(history.getMessagesForAgent).toHaveBeenCalledWith("alice", "updated", 0);
  });

  it("queues a DM for an unregistered recipient and replays it once through poll_messages", async () => {
    const storedMessages: Array<{
      id: number;
      type: "DM";
      from_agent: string;
      to_agent: string;
      channel: null;
      content: string;
      origin_host: string;
      timestamp: Date;
    }> = [];
    const transport = fakeTransport();
    vi.mocked(transport.publishDirectMessage).mockImplementation((to, from, content) => {
      storedMessages.push({
        id: 1,
        type: "DM",
        from_agent: from,
        to_agent: to,
        channel: null,
        content,
        origin_host: "test-local",
        timestamp: new Date(1),
      });
    });
    vi.mocked(history.getMessagesForAgent).mockImplementation(async (name, _group, sinceId) =>
      storedMessages.filter((message) => message.to_agent === name && message.id > sinceId),
    );
    const alice = await caller(transport);
    const worker = await caller(transport);
    await alice.register("alice");

    const send = await alice.call("agent_dm", {
      name: "alice", to: "worker", message: "finished",
    });
    expect(send.isError).not.toBe(true);
    expect(send.content[0]).toMatchObject({ type: "text" });
    expect((send.content[0] as { text: string }).text).toContain("queued for worker (not registered)");
    expect(transport.publishDirectMessage).toHaveBeenCalledTimes(1);
    expect(transport.publishDirectMessage).toHaveBeenCalledWith("worker", "alice", "finished");
    expect(registry.getAgentByName("worker")).toBeNull();

    await worker.register("worker");
    const firstPoll = await worker.call("poll_messages", { name: "worker" });
    const firstPayload = JSON.parse((firstPoll.content[0] as { text: string }).text);
    expect(firstPayload).toMatchObject({
      messages: [{ id: 1, type: "DM", from: "alice", content: "finished" }],
      last_id: 1,
    });

    const secondPoll = await worker.call("poll_messages", { name: "worker", since_id: firstPayload.last_id });
    expect(JSON.parse((secondPoll.content[0] as { text: string }).text)).toMatchObject({ messages: [], last_id: 1 });
    expect(transport.publishDirectMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["sync rejection", "async rejection", "missing ack", "closed transport", "acknowledged"])(
    "handles resolved history publish: %s", async (mode) => {
      const bus = new NatsTransport({ url: "fake", host: "test-local" });
      const attempts: Array<{ subject: string; payload: any }> = [];
      const publishHistory = vi.fn((subject: string, data: Uint8Array) => {
        attempts.push({ subject, payload: JSON.parse(Buffer.from(data).toString()) });
        if (mode === "sync rejection") throw new Error("sync failure");
        if (mode === "async rejection") return Promise.reject(new Error("no ack"));
        if (mode === "missing ack") return Promise.resolve(undefined);
        return Promise.resolve({ stream: "history", seq: 1 });
      });
      const connection = {
        jetstream: () => ({ publish: publishHistory }),
        publish: (subject: string, data: Uint8Array) => attempts.push({ subject, payload: JSON.parse(Buffer.from(data).toString()) }),
      };
      Object.assign(bus, { nc: connection, closed: mode === "closed transport" });
      const transport = fakeTransport();
      const live = vi.fn(bus.publishDirectMessage.bind(bus));
      transport.publishDirectMessage = live;
      const worker = await caller(transport);
      await worker.register("worker");
      const result = await worker.call("agent_dm", { name: "worker", to: "triage", message: "done" });
      expect(result.isError).not.toBe(true);
      expect(resolveWorkerDm).toHaveBeenCalled();
      const calls = live.mock.calls;
      expect(calls).toHaveLength(mode === "acknowledged" ? 1 : 2);
      expect(calls[0][3]).toBe(true);
      if (mode !== "acknowledged") {
        expect(calls[1][3]).toBe(false);
        expect(calls[1][4]).toEqual(calls[0][4]);
        expect((result.content[0] as { text: string }).text).not.toContain("recorded");
        if (mode !== "closed transport") {
          expect(attempts.map(a => a.subject)).toEqual(["agents.dm.dHJpYWdl.resolved", "agents.dm.dHJpYWdl"]);
          expect(attempts[1].payload.message_id).toBe(attempts[0].payload.message_id);
          expect(attempts[1].payload.message_ts).toBe(attempts[0].payload.message_ts);
        }
      } else {
        expect((result.content[0] as { text: string }).text).toContain("recorded");
        expect(attempts).toHaveLength(1);
      }
    },
  );

  it.each(["show", "fallback"] as const)("delivers the full body for %s", async (route) => {
    vi.mocked(resolveWorkerDm).mockResolvedValueOnce(route);
    const transport = fakeTransport();
    const worker = await caller(transport);
    await worker.register("worker");
    const body = "first line\nsecond line";
    await worker.call("agent_dm", { name: "worker", to: "triage", message: body });
    const [to, from, delivered, historyOnly, identity] = vi.mocked(transport.publishDirectMessage).mock.calls[0];
    expect(to).toBe("triage");
    expect(from).toBe("worker");
    expect(historyOnly).toBe(false);
    expect(delivered).toBe(route === "show" ? `${body} [event_id:${identity!.id}]` : body);
    expect(resolveWorkerDm).toHaveBeenCalledWith("worker", "triage", body, identity!.id, identity!.ts);
  });

  it("releases the previous name when the owner renames", async () => {
    const transport = fakeTransport();
    const alice = await caller(transport);
    const bob = await caller(transport);
    await alice.register("alice");
    const oldId = alice.binding()!.agentId;
    await alice.register("renamed");
    expect(registry.getAgentByName("alice")).toBeNull();
    expect(transport.untrackLocal).toHaveBeenCalledWith(oldId);
    expect((await bob.register("alice")).isError).not.toBe(true);
    expect((await alice.call("agent_deregister", { name: "alice" })).isError).toBe(true);
    expect(bob.binding()?.name).toBe("alice");
  });

  it("allows repeated deregistration but cannot remove a new owner", async () => {
    const transport = fakeTransport();
    const alice = await caller(transport);
    const bob = await caller(transport);
    await alice.register("alice");
    expect((await alice.call("agent_deregister", { name: "alice" })).isError).not.toBe(true);
    expect((await alice.call("agent_deregister", { name: "alice" })).isError).not.toBe(true);
    await bob.register("alice");
    expect((await alice.call("agent_deregister", { name: "alice" })).isError).toBe(true);
    expect(registry.getAgentByName("alice")).not.toBeNull();
  });

  it("releases an owned name and presence on transport close", async () => {
    const transport = fakeTransport();
    const alice = await caller(transport);
    const bob = await caller(transport);
    await alice.register("alice");
    const id = alice.binding()!.agentId;
    await alice.client.close();
    expect(alice.binding()).toBeNull();
    expect(registry.getAgentByName("alice")).toBeNull();
    expect(transport.untrackLocal).toHaveBeenCalledWith(id);
    expect((await bob.register("alice")).isError).not.toBe(true);
  });
});
