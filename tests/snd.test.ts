import { describe, it, expect } from "vitest";
import { parseArgs, formatTailLine } from "../src/snd.js";

describe("snd parseArgs", () => {
  it("parses bare agent name as DM", () => {
    expect(parseArgs(["bob-ssh", "hello", "world"])).toEqual({
      mode: "publish",
      kind: "dm",
      target: "bob-ssh",
      message: "hello world",
      human: false,
    });
  });

  it("parses -t agent as DM", () => {
    expect(parseArgs(["-t", "triage", "auto-batch:", "ENG-123"])).toEqual({
      mode: "publish",
      kind: "dm",
      target: "triage",
      message: "auto-batch: ENG-123",
      human: false,
    });
  });

  it("parses -g group as broadcast", () => {
    expect(parseArgs(["-g", "tasks", "status:", "draining"])).toEqual({
      mode: "publish",
      kind: "broadcast",
      target: "tasks",
      message: "status: draining",
      human: false,
    });
  });

  it("lifts --human flag regardless of position", () => {
    expect(parseArgs(["--human", "-t", "bob", "hi"])).toMatchObject({
      mode: "publish",
      kind: "dm",
      target: "bob",
      message: "hi",
      human: true,
    });
    expect(parseArgs(["-g", "tasks", "--human", "work now"])).toMatchObject({
      mode: "publish",
      kind: "broadcast",
      target: "tasks",
      human: true,
    });
  });

  it("joins multi-word message with single spaces", () => {
    const parsed = parseArgs(["bob", "one", "two", "three"]);
    if (parsed.mode !== "publish") throw new Error("expected publish mode");
    expect(parsed.message).toBe("one two three");
  });

  it("parses --tail as tail mode", () => {
    expect(parseArgs(["--tail"])).toEqual({ mode: "tail" });
  });
});

describe("snd formatTailLine", () => {
  const ts = Date.UTC(2026, 3, 18, 22, 13, 20); // 22:13:20 UTC

  it("formats DM with target arrow", () => {
    const line = formatTailLine("agents.dm.Ym9i", {
      to_agent: "bob",
      from_agent: "alice",
      content: "hi there",
      origin_host: "pop-os",
      origin_ts: ts,
    });
    expect(line).toBe("<dm> 22:13:20 [alice@pop-os] -> bob: hi there");
  });

  it("formats broadcast with group prefix", () => {
    const line = formatTailLine("agents.broadcast.dGFza3M", {
      group: "tasks",
      from_agent: "triage",
      content: "standup in 5",
      origin_host: "serval",
      origin_ts: ts,
    });
    expect(line).toBe("<bcast> 22:13:20 [triage@serval] -> g:tasks: standup in 5");
  });

  it("formats channel with raw channel name", () => {
    const line = formatTailLine("agents.channel.I2VuZw", {
      channel: "#eng",
      from_agent: "dev",
      content: "pr ready",
      origin_host: "serval",
      origin_ts: ts,
    });
    expect(line).toBe("<ch> 22:13:20 [dev@serval] -> #eng: pr ready");
  });

  it("strips [HUMAN] prefix so sender info is not duplicated", () => {
    const line = formatTailLine("agents.broadcast.ZGVmYXVsdA", {
      group: "default",
      from_agent: "human",
      content: "[HUMAN] go ahead",
      origin_host: "human-cli",
      origin_ts: ts,
    });
    expect(line).toBe("<bcast> 22:13:20 [human@human-cli] -> g:default: go ahead");
  });

  it("returns null for unknown subjects", () => {
    expect(formatTailLine("agents.presence", { foo: 1 })).toBeNull();
    expect(formatTailLine("random.subject", {})).toBeNull();
  });

  it("tolerates missing fields with sentinel markers", () => {
    const line = formatTailLine("agents.dm.Ym9i", { origin_ts: ts });
    expect(line).toBe("<dm> 22:13:20 [?@?] -> ?: ");
  });
});
