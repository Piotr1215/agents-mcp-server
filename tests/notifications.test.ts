import { describe, it, expect } from "vitest";
import {
  buildChannelNotification,
  buildDmNotification,
  buildBroadcastNotification,
} from "../src/notifications.js";
import type {
  RemoteChannelMessage,
  RemoteDirectMessage,
  RemoteBroadcastMessage,
} from "../src/nats.js";

const chan = (o: Partial<RemoteChannelMessage> = {}): RemoteChannelMessage => ({
  channel: "#eng",
  fromAgent: "alice-abc",
  content: "hello world",
  originHost: "host-a",
  originTs: 1_700_000_000_000,
  ...o,
});

const dm = (o: Partial<RemoteDirectMessage> = {}): RemoteDirectMessage => ({
  toAgent: "bob-ssh",
  fromAgent: "alice-abc",
  content: "private hello",
  originHost: "host-a",
  originTs: 1_700_000_000_000,
  ...o,
});

const bcast = (o: Partial<RemoteBroadcastMessage> = {}): RemoteBroadcastMessage => ({
  group: "tasks",
  fromAgent: "triage",
  content: "new batch",
  originHost: "host-a",
  originTs: 1_700_000_000_000,
  ...o,
});

describe("buildChannelNotification", () => {
  it("prepends [from@host] when origin is remote", () => {
    const out = buildChannelNotification(chan({ originHost: "host-a" }), "host-b");
    expect(out.content).toBe("[alice-abc@host-a] hello world");
  });

  it("prepends just [from] when origin is local", () => {
    const out = buildChannelNotification(chan({ originHost: "host-b" }), "host-b");
    expect(out.content).toBe("[alice-abc] hello world");
  });

  it("carries full routing meta with kind=channel", () => {
    const out = buildChannelNotification(chan(), "host-b");
    expect(out.meta).toMatchObject({
      kind: "channel",
      channel: "#eng",
      from_agent: "alice-abc",
      origin_host: "host-a",
      origin_ts: "1700000000000",
    });
  });
});

describe("buildDmNotification", () => {
  it("kind=dm, includes to_agent + from_agent", () => {
    const out = buildDmNotification(dm(), "host-b");
    expect(out.meta).toMatchObject({
      kind: "dm",
      from_agent: "alice-abc",
      to_agent: "bob-ssh",
      origin_host: "host-a",
    });
    expect(out.content).toBe("[alice-abc@host-a] private hello");
  });

  it("drops host suffix for same-host DMs", () => {
    const out = buildDmNotification(dm({ originHost: "host-b" }), "host-b");
    expect(out.content).toBe("[alice-abc] private hello");
  });
});

describe("buildBroadcastNotification", () => {
  it("kind=broadcast, includes group + from_agent", () => {
    const out = buildBroadcastNotification(bcast(), "host-b");
    expect(out.meta).toMatchObject({
      kind: "broadcast",
      from_agent: "triage",
      group: "tasks",
      origin_host: "host-a",
    });
    expect(out.content).toBe("[triage@host-a] new batch");
  });
});
