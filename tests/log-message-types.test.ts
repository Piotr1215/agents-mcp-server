import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "child_process";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agents-test-log-message-types.duckdb";

function rawQuery(sql: string): any[] {
  const out = execSync(`duckdb "${TEST_DB}" -json -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
  return JSON.parse(out || "[]");
}

// Piotr1215/claude#116: 42 rows with type='human' landed in the messages
// table when a now-retired caller passed the sender name where the type was
// expected. The emitter is gone (agents-irc a6d9d0a + ~/.claude 10d5571), but
// nothing in logMessage prevents the next arg-order regression from writing
// the same class of garbage silently. These tests pin the allowlist guard:
// reject anything outside VALID_MESSAGE_TYPES, stderr + -1, no row.

describe("logMessage type allowlist", () => {
  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* fresh */ }
    vi.resetModules();
    process.env.AGENTS_DB_PATH = TEST_DB;
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* cleanup */ }
    delete process.env.AGENTS_DB_PATH;
  });

  it("accepts every valid type", async () => {
    const db = await import("../src/db");
    for (const t of db.VALID_MESSAGE_TYPES) {
      const id = await db.logMessage(t, "alice", null, null, `${t} payload`);
      expect(id).toBeGreaterThan(0);
    }
    const rows = rawQuery("SELECT type, content FROM messages ORDER BY id");
    expect(rows.map((r: any) => r.type)).toEqual([...db.VALID_MESSAGE_TYPES]);
  });

  it("rejects type='human' — the #116 class — without inserting a row", async () => {
    const db = await import("../src/db");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const id = await db.logMessage("human", "human", null, null, "[LEFT] kurt-sh left group nats");
    expect(id).toBe(-1);

    const rows = rawQuery("SELECT COUNT(*) as n FROM messages WHERE type='human'");
    expect(rows[0].n).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("rejecting invalid type 'human'"));
    errSpy.mockRestore();
  });

  it("rejects lowercase variants of valid types — enum is case-sensitive", async () => {
    const db = await import("../src/db");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const id = await db.logMessage("dm", "alice", "bob", null, "hi");
    expect(id).toBe(-1);

    const rows = rawQuery("SELECT COUNT(*) as n FROM messages WHERE type='dm'");
    expect(rows[0].n).toBe(0);
    errSpy.mockRestore();
  });

  it("rejects empty string and unknown types", async () => {
    const db = await import("../src/db");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await db.logMessage("", "a", null, null, "x")).toBe(-1);
    expect(await db.logMessage("SYSTEM", "a", null, null, "x")).toBe(-1);

    const rows = rawQuery("SELECT COUNT(*) as n FROM messages");
    expect(rows[0].n).toBe(0);
    errSpy.mockRestore();
  });
});
