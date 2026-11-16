import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
import { spawn } from "node:child_process";
import { resolveWorkerDm } from "../src/dm-intake.js";

function fakeChild(output: string, code: number | null = 0, fail = false) {
  const child = new EventEmitter() as any;
  child.stdin = new EventEmitter(); child.stdin.end = vi.fn(() => {
    queueMicrotask(() => { if (fail) child.emit("error", new Error("missing")); else if (code !== null) { child.stdout.emit("data", Buffer.from(output)); child.emit("close", code); } });
  });
  child.stdout = new EventEmitter(); child.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(child);
  return child;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("worker DM routing", () => {
  it.each([["resolved", true], ["dropped", true], ["shown", false]])("routes %s", async (terminal, expected) => {
    const child = fakeChild(JSON.stringify({ terminal }));
    expect(await resolveWorkerDm("worker", "triage", "body", "id-1", "2026-11-16T00:00:00Z")).toBe(expected);
    expect(JSON.parse(child.stdin.end.mock.calls[0][0])).toMatchObject({body:"body", id:"id-1", meta:{from:"worker",to:"triage",message_id:"id-1"}});
  });
  it.each(["human", "human-piotr", "intake", "rsi", "ledger"])("excludes %s", async from => {
    expect(await resolveWorkerDm(from, "triage", "x", "id-1", "2026-11-16T00:00:00Z")).toBe(false); expect(spawn).not.toHaveBeenCalled();
  });
  it("honors the off switch", async () => { vi.stubEnv("AGENTS_INTAKE_DM", "0"); expect(await resolveWorkerDm("worker", "triage", "x", "id-1", "2026-11-16T00:00:00Z")).toBe(false); expect(spawn).not.toHaveBeenCalled(); });
  it.each([["", 1, false], ["bad", 0, false], ["", 0, true]] as const)("delivers on error", async (out, code, fail) => { fakeChild(out, code, fail); expect(await resolveWorkerDm("worker", "triage", "x", "id-1", "2026-11-16T00:00:00Z")).toBe(false); });
  it("delivers on timeout", async () => { vi.useFakeTimers(); const child = fakeChild("", null); const result = resolveWorkerDm("worker", "triage", "x", "id-1", "2026-11-16T00:00:00Z"); await vi.advanceTimersByTimeAsync(3000); expect(await result).toBe(false); expect(child.kill).toHaveBeenCalled(); });
});
