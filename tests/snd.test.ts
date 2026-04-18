import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/snd.js";

describe("snd parseArgs", () => {
  it("parses bare agent name as DM", () => {
    expect(parseArgs(["bob-ssh", "hello", "world"])).toEqual({
      kind: "dm",
      target: "bob-ssh",
      message: "hello world",
      human: false,
    });
  });

  it("parses -t agent as DM", () => {
    expect(parseArgs(["-t", "triage", "auto-batch:", "ENG-123"])).toEqual({
      kind: "dm",
      target: "triage",
      message: "auto-batch: ENG-123",
      human: false,
    });
  });

  it("parses -g group as broadcast", () => {
    expect(parseArgs(["-g", "tasks", "status:", "draining"])).toEqual({
      kind: "broadcast",
      target: "tasks",
      message: "status: draining",
      human: false,
    });
  });

  it("lifts --human flag regardless of position", () => {
    expect(parseArgs(["--human", "-t", "bob", "hi"])).toMatchObject({
      kind: "dm",
      target: "bob",
      message: "hi",
      human: true,
    });
    expect(parseArgs(["-g", "tasks", "--human", "work now"])).toMatchObject({
      kind: "broadcast",
      target: "tasks",
      human: true,
    });
  });

  it("joins multi-word message with single spaces", () => {
    expect(parseArgs(["bob", "one", "two", "three"]).message).toBe("one two three");
  });
});
