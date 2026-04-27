import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NatsTransport, PresenceBeat, RemoteChannelMessage, RemoteDirectMessage, RemoteBroadcastMessage } from "../src/nats.js";
import type { NatsConnection, Subscription, Msg } from "nats";

// NATS-style wildcard: "a.b.*" matches "a.b.X" but not "a.b" or "a.b.X.Y".
function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  if (p.length !== s.length) return false;
  return p.every((tok, i) => tok === "*" || tok === s[i]);
}

class FakeBus {
  private subs: Array<(subject: string, data: Uint8Array) => void> = [];

  publish(subject: string, data: Uint8Array): void {
    for (const handler of this.subs) handler(subject, data);
  }

  subscribe(handler: (subject: string, data: Uint8Array) => void): () => void {
    this.subs.push(handler);
    return () => {
      this.subs = this.subs.filter((h) => h !== handler);
    };
  }
}

function fakeConnection(bus: FakeBus): NatsConnection {
  const queues = new Map<string, { push: (m: Msg) => void; iter: AsyncIterable<Msg> & { stop: () => void } }>();

  function makeSub(subject: string): Subscription {
    let resolveNext: ((m: IteratorResult<Msg>) => void) | null = null;
    const pending: Msg[] = [];
    let stopped = false;

    const push = (msg: Msg) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: msg, done: false });
      } else {
        pending.push(msg);
      }
    };

    const iter: AsyncIterable<Msg> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Msg>> {
            if (pending.length) return Promise.resolve({ value: pending.shift()!, done: false });
            if (stopped) return Promise.resolve({ value: undefined as unknown as Msg, done: true });
            return new Promise((resolve) => { resolveNext = resolve; });
          },
        };
      },
    };

    bus.subscribe((subj, data) => {
      if (!subjectMatches(subject, subj)) return;
      push({
        subject: subj,
        data,
        sid: 0,
        reply: "",
        string: () => Buffer.from(data).toString("utf-8"),
        json: () => JSON.parse(Buffer.from(data).toString("utf-8")),
        respond: () => false,
      } as unknown as Msg);
    });

    const sub = Object.assign(iter, {
      unsubscribe: () => { stopped = true; if (resolveNext) { resolveNext({ value: undefined as unknown as Msg, done: true }); resolveNext = null; } },
      drain: async () => { stopped = true; },
      getSubject: () => subject,
      getID: () => 0,
    });
    queues.set(subject, { push, iter: sub as unknown as AsyncIterable<Msg> & { stop: () => void } });
    return sub as unknown as Subscription;
  }

  return {
    publish: (subject: string, data?: Uint8Array) => bus.publish(subject, data ?? new Uint8Array()),
    subscribe: (subject: string) => makeSub(subject),
    drain: async () => { /* noop */ },
    close: async () => { /* noop */ },
  } as unknown as NatsConnection;
}

describe("NatsTransport", () => {
  let bus: FakeBus;

  beforeEach(() => { bus = new FakeBus(); });
  afterEach(() => { vi.useRealTimers(); });

  it("publishes presence beats carrying local agent identity", async () => {
    const nc = fakeConnection(bus);
    const seen: PresenceBeat[] = [];
    bus.subscribe((_, data) => seen.push(JSON.parse(Buffer.from(data).toString())));

    const t = new NatsTransport({
      url: "fake",
      host: "host-a",
      connector: async () => nc,
      now: () => 1_000,
    });
    await t.start();
    t.trackLocal({ agent_id: "triage-aaa", name: "triage", group: "default" });
    await t.publishAll();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      agent_id: "triage-aaa",
      name: "triage",
      group: "default",
      host: "host-a",
      ts: 1_000,
    });
    await t.close();
  });

  it("ingests remote beats and returns them via getRemotePeers", async () => {
    const t = new NatsTransport({
      url: "fake",
      host: "host-a",
      connector: async () => fakeConnection(bus),
      now: () => 1_000,
    });
    await t.start();
    t.ingestBeat({ agent_id: "worker-xxx", name: "worker", group: "default", host: "host-b", ts: 1_000 });

    const peers = t.getRemotePeers();
    expect(peers).toHaveLength(1);
    expect(peers[0].name).toBe("worker");
    expect(peers[0].host).toBe("host-b");
    await t.close();
  });

  it("drops remote peers past TTL", async () => {
    let clock = 1_000;
    const t = new NatsTransport({
      url: "fake",
      host: "host-a",
      peerTtlMs: 5_000,
      connector: async () => fakeConnection(bus),
      now: () => clock,
    });
    await t.start();
    t.ingestBeat({ agent_id: "worker-xxx", name: "worker", group: "default", host: "host-b", ts: 1_000 });
    expect(t.getRemotePeers()).toHaveLength(1);

    clock = 10_000;
    expect(t.getRemotePeers()).toHaveLength(0);
    await t.close();
  });

  it("filters remote peers by group", async () => {
    const t = new NatsTransport({
      url: "fake",
      connector: async () => fakeConnection(bus),
      now: () => 1_000,
    });
    await t.start();
    t.ingestBeat({ agent_id: "a", name: "a", group: "alpha", host: "h", ts: 1_000 });
    t.ingestBeat({ agent_id: "b", name: "b", group: "beta",  host: "h", ts: 1_000 });

    expect(t.getRemotePeers("alpha").map((p) => p.name)).toEqual(["a"]);
    expect(t.getRemotePeers("beta").map((p) => p.name)).toEqual(["b"]);
    expect(t.getRemotePeers()).toHaveLength(2);
    await t.close();
  });

  it("excludes locally tracked agents from remote peer list", async () => {
    const t = new NatsTransport({
      url: "fake",
      connector: async () => fakeConnection(bus),
      now: () => 1_000,
    });
    await t.start();
    t.trackLocal({ agent_id: "me", name: "me", group: "default" });
    t.ingestBeat({ agent_id: "me",    name: "me",    group: "default", host: "host-a", ts: 1_000 });
    t.ingestBeat({ agent_id: "other", name: "other", group: "default", host: "host-b", ts: 1_000 });

    const peers = t.getRemotePeers();
    expect(peers.map((p) => p.agent_id)).toEqual(["other"]);
    await t.close();
  });

  // Issue #127 (presence parity): the transport used to silently drop
  // same-host presence beats from sibling agent-mcp-server processes (each
  // Claude session spawns its own stdio MCP server). Filtering on
  // beat.host === this.host hid those siblings from agent_discover. Loopback
  // dedup is now agent_id-based via this.locals — host-level filtering is too
  // broad for multi-agent-per-host deployments.
  it("includes same-host peers from sibling processes (agent_id-based loopback dedup)", async () => {
    const t = new NatsTransport({
      url: "fake",
      host: "host-a",
      connector: async () => fakeConnection(bus),
      now: () => 1_000,
    });
    await t.start();
    t.trackLocal({ agent_id: "me-abc", name: "me", group: "default" });
    t.ingestBeat({ agent_id: "me-abc",      name: "me",      group: "default", host: "host-a", ts: 1_000 });
    t.ingestBeat({ agent_id: "sibling-xyz", name: "sibling", group: "default", host: "host-a", ts: 1_000 });

    const peers = t.getRemotePeers();
    expect(peers.map((p) => p.agent_id)).toEqual(["sibling-xyz"]);
    await t.close();
  });

  it("delivers a beat end-to-end through subscribe loop", async () => {
    const t = new NatsTransport({
      url: "fake",
      host: "host-a",
      connector: async () => fakeConnection(bus),
      now: () => 1_000,
    });
    await t.start();

    bus.publish("agents.presence", Buffer.from(JSON.stringify({
      agent_id: "remote-xyz",
      name: "remote",
      group: "default",
      host: "host-b",
      ts: 1_000,
    })));

    await new Promise((r) => setTimeout(r, 10));
    const peers = t.getRemotePeers();
    expect(peers.map((p) => p.agent_id)).toContain("remote-xyz");
    await t.close();
  });

  it("tolerates malformed presence payloads", async () => {
    const t = new NatsTransport({
      url: "fake",
      connector: async () => fakeConnection(bus),
      now: () => 1_000,
    });
    await t.start();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.publish("agents.presence", Buffer.from("not-json"));
    await new Promise((r) => setTimeout(r, 10));
    expect(t.getRemotePeers()).toHaveLength(0);
    errSpy.mockRestore();
    await t.close();
  });

  describe("channel pub/sub", () => {
    it("publishes to agents.channel.<base64url> with origin metadata", async () => {
      const seen: Array<{ subject: string; payload: any }> = [];
      bus.subscribe((subject, data) => {
        if (subject.startsWith("agents.channel.")) {
          seen.push({ subject, payload: JSON.parse(Buffer.from(data).toString("utf-8")) });
        }
      });
      const t = new NatsTransport({
        url: "fake",
        host: "host-a",
        connector: async () => fakeConnection(bus),
        now: () => 42,
      });
      await t.start();
      t.publishChannelMessage("#eng", "alice-abc", "hello");
      expect(seen).toHaveLength(1);
      const expectedSubject = "agents.channel." + Buffer.from("#eng", "utf-8").toString("base64url");
      expect(seen[0].subject).toBe(expectedSubject);
      expect(seen[0].payload).toMatchObject({
        channel: "#eng",
        from_agent: "alice-abc",
        content: "hello",
        origin_host: "host-a",
        origin_ts: 42,
        origin_seq: 0,
      });
      await t.close();
    });

    it("delivers remote channel messages via onChannelMessage callback", async () => {
      const received: RemoteChannelMessage[] = [];
      const recv = new NatsTransport({
        url: "fake",
        host: "host-b",
        onChannelMessage: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 100,
      });
      await recv.start();

      const sender = new NatsTransport({
        url: "fake",
        host: "host-a",
        connector: async () => fakeConnection(bus),
        now: () => 50,
      });
      await sender.start();
      sender.publishChannelMessage("#eng", "alice-abc", "hi from A");

      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        channel: "#eng",
        fromAgent: "alice-abc",
        content: "hi from A",
        originHost: "host-a",
        originTs: 50,
      });
      await sender.close();
      await recv.close();
    });

    // Issue #127: the transport used to silently drop same-host messages to
    // avoid the publisher's own echo. That broke multi-agent-per-host
    // deployments (tmux panes, k8s pods sharing a hostname) because every peer
    // on the same host saw `origin_host === this.host` and was filtered out.
    // Transport now delivers every message; echo suppression moved into the
    // handler in src/index.ts where sessionBinding is available.
    it("delivers same-host messages to the callback (handler handles echo suppression)", async () => {
      const received: RemoteChannelMessage[] = [];
      const t = new NatsTransport({
        url: "fake",
        host: "host-a",
        onChannelMessage: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 1_000,
      });
      await t.start();
      t.publishChannelMessage("#eng", "alice-abc", "loopback-test");
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      expect(received[0].originHost).toBe("host-a");
      await t.close();
    });

    it("drops channel payloads missing required fields", async () => {
      const received: RemoteChannelMessage[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const t = new NatsTransport({
        url: "fake",
        host: "host-b",
        onChannelMessage: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 1_000,
      });
      await t.start();
      const subject = "agents.channel." + Buffer.from("#eng", "utf-8").toString("base64url");
      bus.publish(subject, Buffer.from(JSON.stringify({ channel: "#eng", content: "" })));
      bus.publish(subject, Buffer.from("{not valid json"));
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      await t.close();
    });

    it("is a no-op when publishChannelMessage is called before start()", () => {
      const t = new NatsTransport({
        url: "fake",
        connector: async () => fakeConnection(bus),
      });
      expect(() => t.publishChannelMessage("#eng", "alice", "hi")).not.toThrow();
    });
  });

  describe("dm pub/sub", () => {
    it("publishes to agents.dm.<base64url(to)> with origin metadata", async () => {
      const seen: Array<{ subject: string; payload: any }> = [];
      bus.subscribe((subject, data) => {
        if (subject.startsWith("agents.dm.")) {
          seen.push({ subject, payload: JSON.parse(Buffer.from(data).toString("utf-8")) });
        }
      });
      const t = new NatsTransport({
        url: "fake",
        host: "host-a",
        connector: async () => fakeConnection(bus),
        now: () => 77,
      });
      await t.start();
      t.publishDirectMessage("bob-ssh", "alice-abc", "private");
      expect(seen).toHaveLength(1);
      const expectedSubject = "agents.dm." + Buffer.from("bob-ssh", "utf-8").toString("base64url");
      expect(seen[0].subject).toBe(expectedSubject);
      expect(seen[0].payload).toMatchObject({
        to_agent: "bob-ssh",
        from_agent: "alice-abc",
        content: "private",
        origin_host: "host-a",
        origin_ts: 77,
        origin_seq: 0,
      });
      await t.close();
    });

    it("delivers remote DMs via onDirectMessage callback", async () => {
      const received: RemoteDirectMessage[] = [];
      const recv = new NatsTransport({
        url: "fake",
        host: "host-b",
        onDirectMessage: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 200,
      });
      await recv.start();

      const sender = new NatsTransport({
        url: "fake",
        host: "host-a",
        connector: async () => fakeConnection(bus),
        now: () => 150,
      });
      await sender.start();
      sender.publishDirectMessage("bob-ssh", "alice-abc", "hello bob");

      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        toAgent: "bob-ssh",
        fromAgent: "alice-abc",
        content: "hello bob",
        originHost: "host-a",
        originTs: 150,
      });
      await sender.close();
      await recv.close();
    });

    // See channel pub/sub section for the #127 rationale — same shape here.
    it("delivers same-host DMs to the callback (handler handles echo suppression)", async () => {
      const received: RemoteDirectMessage[] = [];
      const t = new NatsTransport({
        url: "fake",
        host: "host-a",
        onDirectMessage: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 1_000,
      });
      await t.start();
      t.publishDirectMessage("bob-ssh", "alice-abc", "loopback");
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      expect(received[0].originHost).toBe("host-a");
      await t.close();
    });

    it("drops DM payloads missing required fields", async () => {
      const received: RemoteDirectMessage[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const t = new NatsTransport({
        url: "fake",
        host: "host-b",
        onDirectMessage: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 1_000,
      });
      await t.start();
      const subject = "agents.dm." + Buffer.from("bob-ssh", "utf-8").toString("base64url");
      // Missing from_agent — should be dropped with error log
      bus.publish(subject, Buffer.from(JSON.stringify({
        to_agent: "bob-ssh",
        content: "no sender",
        origin_host: "host-a",
      })));
      bus.publish(subject, Buffer.from("not-json"));
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      await t.close();
    });

    it("is a no-op when publishDirectMessage is called before start()", () => {
      const t = new NatsTransport({
        url: "fake",
        connector: async () => fakeConnection(bus),
      });
      expect(() => t.publishDirectMessage("bob-ssh", "alice", "hi")).not.toThrow();
    });
  });

  describe("broadcast pub/sub", () => {
    it("publishes to agents.broadcast.<base64url(group)> with origin metadata", async () => {
      const seen: Array<{ subject: string; payload: any }> = [];
      bus.subscribe((subject, data) => {
        if (subject.startsWith("agents.broadcast.")) {
          seen.push({ subject, payload: JSON.parse(Buffer.from(data).toString("utf-8")) });
        }
      });
      const t = new NatsTransport({
        url: "fake",
        host: "host-a",
        connector: async () => fakeConnection(bus),
        now: () => 88,
      });
      await t.start();
      t.publishBroadcast("tasks", "triage-abc", "new task assigned");
      expect(seen).toHaveLength(1);
      const expectedSubject = "agents.broadcast." + Buffer.from("tasks", "utf-8").toString("base64url");
      expect(seen[0].subject).toBe(expectedSubject);
      expect(seen[0].payload).toMatchObject({
        group: "tasks",
        from_agent: "triage-abc",
        content: "new task assigned",
        origin_host: "host-a",
        origin_ts: 88,
        origin_seq: 0,
      });
      await t.close();
    });

    it("delivers remote broadcasts via onBroadcast callback", async () => {
      const received: RemoteBroadcastMessage[] = [];
      const recv = new NatsTransport({
        url: "fake",
        host: "host-b",
        onBroadcast: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 200,
      });
      await recv.start();

      const sender = new NatsTransport({
        url: "fake",
        host: "host-a",
        connector: async () => fakeConnection(bus),
        now: () => 150,
      });
      await sender.start();
      sender.publishBroadcast("tasks", "triage-abc", "ping the team");

      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        group: "tasks",
        fromAgent: "triage-abc",
        content: "ping the team",
        originHost: "host-a",
        originTs: 150,
      });
      await sender.close();
      await recv.close();
    });

    // See channel pub/sub section for the #127 rationale — same shape here.
    it("delivers same-host broadcasts to the callback (handler handles echo suppression)", async () => {
      const received: RemoteBroadcastMessage[] = [];
      const t = new NatsTransport({
        url: "fake",
        host: "host-a",
        onBroadcast: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 1_000,
      });
      await t.start();
      t.publishBroadcast("tasks", "triage-abc", "loopback");
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      expect(received[0].originHost).toBe("host-a");
      await t.close();
    });

    // Issue #127 regression: two independent transports sharing a hostname
    // (tmux panes on one laptop, pods on one k8s node) used to never see each
    // other's broadcasts because the receiver filtered on origin_host. The
    // publisher is now visible to the same-host peer.
    it("delivers broadcasts between two transports sharing a host", async () => {
      const received: RemoteBroadcastMessage[] = [];
      const recv = new NatsTransport({
        url: "fake",
        host: "shared-host",
        onBroadcast: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 1_000,
      });
      await recv.start();

      const sender = new NatsTransport({
        url: "fake",
        host: "shared-host",
        connector: async () => fakeConnection(bus),
        now: () => 2_000,
      });
      await sender.start();
      sender.publishBroadcast("tasks", "peer-abc", "hi same-host neighbor");

      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        group: "tasks",
        fromAgent: "peer-abc",
        content: "hi same-host neighbor",
        originHost: "shared-host",
      });
      await sender.close();
      await recv.close();
    });

    it("drops broadcast payloads missing required fields", async () => {
      const received: RemoteBroadcastMessage[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const t = new NatsTransport({
        url: "fake",
        host: "host-b",
        onBroadcast: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 1_000,
      });
      await t.start();
      const subject = "agents.broadcast." + Buffer.from("tasks", "utf-8").toString("base64url");
      // Missing from_agent
      bus.publish(subject, Buffer.from(JSON.stringify({
        group: "tasks",
        content: "no sender",
        origin_host: "host-a",
      })));
      bus.publish(subject, Buffer.from("not-json"));
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      await t.close();
    });

    it("is a no-op when publishBroadcast is called before start()", () => {
      const t = new NatsTransport({
        url: "fake",
        connector: async () => fakeConnection(bus),
      });
      expect(() => t.publishBroadcast("tasks", "triage", "hi")).not.toThrow();
    });
  });

  describe("origin_seq tie-breaker", () => {
    it("emits strictly monotonic origin_seq within a single now() tick across all three publish methods", async () => {
      const seen: Array<{ subject: string; payload: any }> = [];
      bus.subscribe((subject, data) => {
        if (
          subject.startsWith("agents.dm.") ||
          subject.startsWith("agents.broadcast.") ||
          subject.startsWith("agents.channel.")
        ) {
          seen.push({ subject, payload: JSON.parse(Buffer.from(data).toString("utf-8")) });
        }
      });
      const t = new NatsTransport({
        url: "fake",
        host: "host-a",
        connector: async () => fakeConnection(bus),
        now: () => 1_000, // frozen — every publish shares this origin_ts
      });
      await t.start();

      t.publishDirectMessage("bob", "alice", "msg1");
      t.publishBroadcast("default", "alice", "msg2");
      t.publishChannelMessage("#eng", "alice", "msg3");
      t.publishDirectMessage("bob", "alice", "msg4");

      expect(seen).toHaveLength(4);
      // All share the same origin_ts — so sort stability depends on origin_seq.
      expect(new Set(seen.map((s) => s.payload.origin_ts))).toEqual(new Set([1_000]));
      // Strictly monotonic, starting at 0, single counter spanning all publish kinds.
      expect(seen.map((s) => s.payload.origin_seq)).toEqual([0, 1, 2, 3]);

      await t.close();
    });

    it("carries origin_seq through the consumer callback", async () => {
      const received: RemoteDirectMessage[] = [];
      const recv = new NatsTransport({
        url: "fake",
        host: "host-b",
        onDirectMessage: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 100,
      });
      await recv.start();

      const sender = new NatsTransport({
        url: "fake",
        host: "host-a",
        connector: async () => fakeConnection(bus),
        now: () => 50,
      });
      await sender.start();
      sender.publishDirectMessage("bob", "alice", "first");
      sender.publishDirectMessage("bob", "alice", "second");

      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(2);
      expect(received[0].originSeq).toBe(0);
      expect(received[1].originSeq).toBe(1);

      await sender.close();
      await recv.close();
    });

    it("falls back to 0 on the consumer side when a legacy payload omits origin_seq", async () => {
      const received: RemoteDirectMessage[] = [];
      const recv = new NatsTransport({
        url: "fake",
        host: "host-b",
        onDirectMessage: (m) => { received.push(m); },
        connector: async () => fakeConnection(bus),
        now: () => 100,
      });
      await recv.start();

      // Older publisher wire format: no origin_seq field.
      const subject = "agents.dm." + Buffer.from("bob", "utf-8").toString("base64url");
      bus.publish(subject, Buffer.from(JSON.stringify({
        to_agent: "bob",
        from_agent: "alice",
        content: "legacy",
        origin_host: "host-a",
        origin_ts: 50,
      })));

      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);
      expect(received[0].originSeq).toBe(0);

      await recv.close();
    });
  });

  describe("reconnect resurrection (#120)", () => {
    // A fake connection that exposes a controllable status() stream.
    // Returns the nc plus an `emit` function the test uses to inject
    // "disconnect"/"reconnect" events as if nats.js had seen them.
    function statefulFake(bus: FakeBus): {
      nc: NatsConnection;
      emit: (event: { type: string; data?: unknown }) => void;
      endStatus: () => void;
    } {
      const base = fakeConnection(bus);
      const pending: Array<{ type: string; data?: unknown }> = [];
      let resolveNext: ((v: IteratorResult<{ type: string; data?: unknown }>) => void) | null = null;
      let ended = false;
      const iter: AsyncIterable<{ type: string; data?: unknown }> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<{ type: string; data?: unknown }>> {
              if (pending.length) return Promise.resolve({ value: pending.shift()!, done: false });
              if (ended) return Promise.resolve({ value: undefined as never, done: true });
              return new Promise((resolve) => { resolveNext = resolve; });
            },
          };
        },
      };
      const nc = Object.assign(base, {
        status: () => iter,
      }) as unknown as NatsConnection;
      const emit = (event: { type: string; data?: unknown }) => {
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: event, done: false });
        } else {
          pending.push(event);
        }
      };
      const endStatus = () => {
        ended = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: undefined as never, done: true });
        }
      };
      return { nc, emit, endStatus };
    }

    it("resubscribes after a reconnect event so inbound DMs still deliver", async () => {
      const received: RemoteDirectMessage[] = [];
      const { nc, emit, endStatus } = statefulFake(bus);
      const recv = new NatsTransport({
        url: "fake",
        host: "host-b",
        onDirectMessage: (m) => { received.push(m); },
        connector: async () => nc,
        now: () => 100,
      });
      await recv.start();

      // Pre-reconnect DM delivers normally.
      const subject = "agents.dm." + Buffer.from("bob", "utf-8").toString("base64url");
      bus.publish(subject, Buffer.from(JSON.stringify({
        to_agent: "bob",
        from_agent: "alice",
        content: "before",
        origin_host: "host-a",
        origin_ts: 50,
      })));
      await new Promise((r) => setTimeout(r, 10));
      expect(received).toHaveLength(1);

      // Simulate the broker flap: disconnect, then reconnect. The transport
      // must re-establish its four wildcard subscriptions so that post-
      // reconnect messages keep arriving.
      emit({ type: "disconnect" });
      emit({ type: "reconnect" });
      await new Promise((r) => setTimeout(r, 10));

      bus.publish(subject, Buffer.from(JSON.stringify({
        to_agent: "bob",
        from_agent: "alice",
        content: "after",
        origin_host: "host-a",
        origin_ts: 60,
      })));
      await new Promise((r) => setTimeout(r, 10));
      // If resubscribe had not fired we'd see 1 here; the second delivery is
      // the proof that the consume loop survived the flap.
      expect(received.map((m) => m.content)).toEqual(["before", "after"]);

      endStatus();
      await recv.close();
    });

    it("does not crash when the connection has no status() method (legacy fakes)", async () => {
      const t = new NatsTransport({
        url: "fake",
        host: "host-a",
        connector: async () => fakeConnection(bus),
        now: () => 1_000,
      });
      await expect(t.start()).resolves.not.toThrow();
      await t.close();
    });
  });
});
