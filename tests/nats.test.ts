import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NatsTransport, PresenceBeat, RemoteChannelMessage, RemoteDirectMessage } from "../src/nats.js";
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

    it("skips own-host echoes in receive loop", async () => {
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
      expect(received).toHaveLength(0);
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

    it("skips own-host echoes in DM receive loop", async () => {
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
      expect(received).toHaveLength(0);
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
});
