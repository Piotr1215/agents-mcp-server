import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agents-test-collision.duckdb";

function dbExec(sql: string): void {
  execSync(`duckdb "${TEST_DB}" -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout: 5000,
  });
}

function dbQuery(sql: string): any[] {
  const result = execSync(`duckdb "${TEST_DB}" -json -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
  return JSON.parse(result || "[]");
}

describe("DB registration collision (real DuckDB)", () => {
  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* fresh start */ }
    dbExec(`
      CREATE TABLE agents (
        id VARCHAR PRIMARY KEY,
        name VARCHAR NOT NULL,
        group_name VARCHAR DEFAULT 'default',
        pane_id VARCHAR,
        stable_pane VARCHAR,
        registered_at TIMESTAMP DEFAULT now()
      )
    `);
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* cleanup */ }
  });

  it("empty string stable_pane in DELETE wipes unrelated agents (the bug)", () => {
    // Agent A registers with empty stable_pane (stored as '')
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, stable_pane) VALUES ('a-1', 'big-bee', 'evening', '%0', '')");
    // Agent B registers with empty stable_pane
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, stable_pane) VALUES ('b-1', 'lil-bee', 'evening', '%1', '')");

    // Agent C registers — old buggy DELETE matches stable_pane = ''
    const PANE_ID = "%4";
    const STABLE_PANE = ""; // empty — this is the problem
    const AGENT_NAME = "dev";
    dbExec(`DELETE FROM agents WHERE pane_id = '${PANE_ID}' OR stable_pane = '${STABLE_PANE}' OR name = '${AGENT_NAME}'`);

    const remaining = dbQuery("SELECT name FROM agents ORDER BY name");
    // BUG: big-bee and lil-bee are GONE because stable_pane = '' matched them
    expect(remaining.map((r: any) => r.name)).toEqual([]);
  });

  it("guarded DELETE preserves unrelated agents (the fix)", () => {
    // Same setup
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, stable_pane) VALUES ('a-1', 'big-bee', 'evening', '%0', '')");
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, stable_pane) VALUES ('b-1', 'lil-bee', 'evening', '%1', '')");

    // Fixed DELETE: only include non-empty conditions
    const PANE_ID = "%4";
    const STABLE_PANE = "";
    const AGENT_NAME = "dev";
    let conditions = `name = '${AGENT_NAME}'`;
    if (PANE_ID) conditions += ` OR pane_id = '${PANE_ID}'`;
    if (STABLE_PANE) conditions += ` OR stable_pane = '${STABLE_PANE}'`;
    dbExec(`DELETE FROM agents WHERE ${conditions}`);

    const remaining = dbQuery("SELECT name FROM agents ORDER BY name");
    // FIX: big-bee and lil-bee survive
    expect(remaining.map((r: any) => r.name)).toEqual(["big-bee", "lil-bee"]);
  });

  it("NULL stable_pane is not matched by empty string comparison", () => {
    // Agent with NULL stable_pane (no pane info path in hook)
    dbExec("INSERT INTO agents (id, name, group_name) VALUES ('a-1', 'big-bee', 'evening')");

    const agents = dbQuery("SELECT name, stable_pane FROM agents");
    expect(agents[0].stable_pane).toBeNull();

    // DELETE with empty string should NOT match NULL
    dbExec("DELETE FROM agents WHERE stable_pane = ''");
    const remaining = dbQuery("SELECT name FROM agents");
    expect(remaining).toHaveLength(1); // NULL != '' in SQL
  });

  it("INSERT OR REPLACE keeps agent findable during re-registration", () => {
    // Simulate MCP tool writing basic record
    dbExec("INSERT OR REPLACE INTO agents (id, name, group_name, pane_id, registered_at) VALUES ('dev-abc', 'dev', 'evening', '', now())");

    // Agent should be findable immediately
    const found = dbQuery("SELECT * FROM agents WHERE name = 'dev'");
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("dev");

    // Hook updates with pane info later
    dbExec("DELETE FROM agents WHERE name = 'dev'");
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, stable_pane) VALUES ('dev-abc', 'dev', 'evening', '%4', 'task:2.1')");

    const updated = dbQuery("SELECT * FROM agents WHERE name = 'dev'");
    expect(updated).toHaveLength(1);
    expect(updated[0].pane_id).toBe("%4");
    expect(updated[0].stable_pane).toBe("task:2.1");
  });

  it("concurrent registrations don't clobber each other", () => {
    // Three agents register with proper non-empty pane info
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, stable_pane) VALUES ('a-1', 'big-bee', 'evening', '%0', 'task:0.0')");
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, stable_pane) VALUES ('b-1', 'lil-bee', 'evening', '%1', 'task:0.1')");

    // dev registers — guarded DELETE only removes dev's own old record
    const conditions = "name = 'dev' OR pane_id = '%4' OR stable_pane = 'task:0.4'";
    dbExec(`DELETE FROM agents WHERE ${conditions}`);
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, stable_pane) VALUES ('d-1', 'dev', 'evening', '%4', 'task:0.4')");

    const all = dbQuery("SELECT name FROM agents ORDER BY name");
    expect(all.map((r: any) => r.name)).toEqual(["big-bee", "dev", "lil-bee"]);
  });
});
