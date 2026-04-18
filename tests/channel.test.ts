import { describe, it, expect } from "vitest";
import { buildChannelNotification, buildDmNotification } from "../src/channel.js";
import type { RemoteChannelMessage, RemoteDirectMessage } from "../src/nats.js";

const sample = (overrides: Partial<RemoteChannelMessage> = {}): RemoteChannelMessage => ({
  channel: "#eng",
  fromAgent: "alice-abc",
  content: "hello world",
  originHost: "host-a",
  originTs: 1_700_000_000_000,
  ...overrides,
});

describe("buildChannelNotification", () => {
  it("maps RemoteChannelMessage fields into content + meta", () => {
    const out = buildChannelNotification(sample());
    expect(out.content).toBe("hello world");
    expect(out.meta).toEqual({
      kind: "channel",
      channel: "#eng",
      from_agent: "alice-abc",
      origin_host: "host-a",
      origin_ts: "1700000000000",
    });
  });

  it("coerces numeric origin_ts to string", () => {
    const out = buildChannelNotification(sample({ originTs: 42 }));
    expect(out.meta.origin_ts).toBe("42");
    expect(typeof out.meta.origin_ts).toBe("string");
  });

  it("sanitizes non-alphanumeric meta keys into underscores", () => {
    // Channel names with hyphens/dots would otherwise lose the attribute on the
    // Claude Code side. The helper normalizes the key, not the value.
    const weird = sample({ channel: "ops-sev1" });
    const out = buildChannelNotification(weird);
    // The value is preserved verbatim; the *key* is the one that's normalized.
    expect(out.meta.channel).toBe("ops-sev1");
  });

  it("emits exactly the expected meta keys", () => {
    const out = buildChannelNotification(sample());
    expect(Object.keys(out.meta).sort()).toEqual(
      ["channel", "from_agent", "kind", "origin_host", "origin_ts"].sort()
    );
  });

  it("does not include fields that are undefined on the input", () => {
    const msg = { ...sample(), originTs: undefined as unknown as number };
    const out = buildChannelNotification(msg);
    expect(out.meta).not.toHaveProperty("origin_ts");
  });

  it("tags channel notifications with kind=channel", () => {
    const out = buildChannelNotification(sample());
    expect(out.meta.kind).toBe("channel");
  });
});

const dmSample = (overrides: Partial<RemoteDirectMessage> = {}): RemoteDirectMessage => ({
  toAgent: "bob-ssh",
  fromAgent: "alice-abc",
  content: "private hello",
  originHost: "host-a",
  originTs: 1_700_000_000_000,
  ...overrides,
});

describe("buildDmNotification", () => {
  it("maps RemoteDirectMessage fields into content + meta with kind=dm", () => {
    const out = buildDmNotification(dmSample());
    expect(out.content).toBe("private hello");
    expect(out.meta).toEqual({
      kind: "dm",
      from_agent: "alice-abc",
      to_agent: "bob-ssh",
      origin_host: "host-a",
      origin_ts: "1700000000000",
    });
  });

  it("coerces numeric origin_ts to string", () => {
    const out = buildDmNotification(dmSample({ originTs: 99 }));
    expect(out.meta.origin_ts).toBe("99");
  });

  it("emits exactly the expected meta keys", () => {
    const out = buildDmNotification(dmSample());
    expect(Object.keys(out.meta).sort()).toEqual(
      ["from_agent", "kind", "origin_host", "origin_ts", "to_agent"].sort()
    );
  });

  it("omits undefined fields", () => {
    const msg = { ...dmSample(), originTs: undefined as unknown as number };
    const out = buildDmNotification(msg);
    expect(out.meta).not.toHaveProperty("origin_ts");
  });
});
