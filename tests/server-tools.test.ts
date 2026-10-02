import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type AgentTransport, type SessionBinding } from "../src/index.js";
import * as registry from "../src/registry.js";
import * as history from "../src/history.js";

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
