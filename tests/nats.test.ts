import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NatsTransport, PresenceBeat } from "../src/nats.js";
import type { NatsConnection, Subscription, Msg } from "nats";

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
      if (subj !== subject) return;
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
});
