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
  originSeq: 42,
  ...o,
});

const dm = (o: Partial<RemoteDirectMessage> = {}): RemoteDirectMessage => ({
  toAgent: "bob-ssh",
  fromAgent: "alice-abc",
  content: "private hello",
  originHost: "host-a",
  originTs: 1_700_000_000_000,
  originSeq: 42,
  ...o,
});

const bcast = (o: Partial<RemoteBroadcastMessage> = {}): RemoteBroadcastMessage => ({
  group: "tasks",
  fromAgent: "triage",
  content: "new batch",
  originHost: "host-a",
  originTs: 1_700_000_000_000,
  originSeq: 42,
  ...o,
});

// originTs 1_700_000_000_000 → ISO 2023-11-14T22:13:20Z → HH:MM:SS "22:13:20"
const TS_PREFIX = "22:13:20";

describe("buildChannelNotification", () => {
  it("prepends <ch> <HH:MM:SS> [from@host] when origin is remote", () => {
    const out = buildChannelNotification(chan({ originHost: "host-a" }), "host-b");
    expect(out.content).toBe(`<ch> ${TS_PREFIX} [alice-abc@host-a] hello world`);
  });

  it("drops @host suffix for local origin", () => {
    const out = buildChannelNotification(chan({ originHost: "host-b" }), "host-b");
    expect(out.content).toBe(`<ch> ${TS_PREFIX} [alice-abc] hello world`);
  });

  it("carries full routing meta with kind=channel", () => {
    const out = buildChannelNotification(chan(), "host-b");
    expect(out.meta).toMatchObject({
      kind: "channel",
      channel: "#eng",
      from_agent: "alice-abc",
      origin_host: "host-a",
      origin_ts: "1700000000000",
      origin_seq: "42",
    });
  });
});

describe("buildDmNotification", () => {
  it("prepends <dm> <HH:MM:SS> [from@host] with meta", () => {
    const out = buildDmNotification(dm(), "host-b");
    expect(out.meta).toMatchObject({
      kind: "dm",
      from_agent: "alice-abc",
      to_agent: "bob-ssh",
      origin_host: "host-a",
      origin_seq: "42",
    });
    expect(out.content).toBe(`<dm> ${TS_PREFIX} [alice-abc@host-a] private hello`);
  });

  it("drops host suffix for same-host DMs", () => {
    const out = buildDmNotification(dm({ originHost: "host-b" }), "host-b");
    expect(out.content).toBe(`<dm> ${TS_PREFIX} [alice-abc] private hello`);
  });

  it("strips redundant [HUMAN] wrapper-prefix so it does not double up", () => {
    const out = buildDmNotification(dm({ content: "[HUMAN] hello" }), "host-b");
    expect(out.content).toBe(`<dm> ${TS_PREFIX} [alice-abc@host-a] hello`);
  });
});

describe("buildBroadcastNotification", () => {
  it("prepends <bcast> <HH:MM:SS> [from@host]", () => {
    const out = buildBroadcastNotification(bcast(), "host-b");
    expect(out.meta).toMatchObject({
      kind: "broadcast",
      from_agent: "triage",
      group: "tasks",
      origin_host: "host-a",
      origin_seq: "42",
    });
    expect(out.content).toBe(`<bcast> ${TS_PREFIX} [triage@host-a] new batch`);
  });
});
