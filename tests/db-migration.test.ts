import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "child_process";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agents-test-migration.duckdb";

function rawExec(sql: string): void {
  execSync(`duckdb "${TEST_DB}" -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout: 5000,
  });
}

function rawQuery(sql: string): any[] {
  const out = execSync(`duckdb "${TEST_DB}" -json -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
  return JSON.parse(out || "[]");
}

describe("initSchema migration on grandfathered DB", () => {
  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* fresh */ }
    vi.resetModules();
    process.env.AGENTS_DB_PATH = TEST_DB;
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* cleanup */ }
    delete process.env.AGENTS_DB_PATH;
  });

  // Reproduces the pre-fix failure: DuckDB refuses ALTER TABLE DROP COLUMN
  // when any index exists on the table. A grandfathered DB built under the
  // old schema already has idx_agents_name, so every startup hit
  // "Cannot alter entry 'agents' because there are entries that depend on it"
  // and dbExec propagated DbError, killing the process before MCP handshake.
  it("runs cleanly against a DB carrying legacy pane columns and idx_agents_name", async () => {
    rawExec(`
      CREATE TABLE agents (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        group_name VARCHAR DEFAULT 'default',
        pane_id VARCHAR,
        stable_pane VARCHAR,
        registered_at TIMESTAMP DEFAULT now()
      );
      CREATE UNIQUE INDEX idx_agents_name ON agents(name);
      INSERT INTO agents (id, name, pane_id) VALUES ('keep-1', 'survivor', '%9');
    `);

    const { getDb } = await import("../src/db");
    await expect(getDb()).resolves.toBeUndefined();

    const cols = rawQuery("DESCRIBE agents").map((r: any) => r.column_name);
    expect(cols).toEqual(
      expect.arrayContaining(["id", "name", "group_name", "registered_at"]),
    );
    expect(cols).not.toContain("pane_id");
    expect(cols).not.toContain("stable_pane");

    // Pre-existing rows survive the column drop.
    const rows = rawQuery("SELECT id, name FROM agents");
    expect(rows).toEqual([{ id: "keep-1", name: "survivor" }]);

    // Unique-name index is back in place so UPSERT ON CONFLICT(name) works.
    const idx = rawQuery("SELECT index_name FROM duckdb_indexes() WHERE table_name='agents'");
    expect(idx.map((r: any) => r.index_name)).toContain("idx_agents_name");
  });

  it("runs cleanly against a fresh DB with no prior schema", async () => {
    const { getDb } = await import("../src/db");
    await expect(getDb()).resolves.toBeUndefined();

    const cols = rawQuery("DESCRIBE agents").map((r: any) => r.column_name);
    expect(cols).toEqual(["id", "name", "group_name", "registered_at"]);
  });
});
