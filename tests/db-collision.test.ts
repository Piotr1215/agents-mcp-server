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

  it("ON CONFLICT(name) upserts agent during re-registration", () => {
    // Add unique index (mirrors initSchema fix for tables missing PK)
    dbExec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents(name)");

    // First registration
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, registered_at) VALUES ('dev-abc', 'dev', 'evening', '%4', now()) ON CONFLICT(name) DO UPDATE SET group_name = EXCLUDED.group_name, pane_id = EXCLUDED.pane_id, registered_at = EXCLUDED.registered_at");

    const found = dbQuery("SELECT * FROM agents WHERE name = 'dev'");
    expect(found).toHaveLength(1);
    expect(found[0].pane_id).toBe("%4");
    expect(found[0].registered_at).not.toBeNull();

    // Re-registration updates the row (new pane, same name). Post-#27 the
    // UPSERT no longer reassigns id — DuckDB 1.1.3 rejects SET on a PK column.
    // Production reuses the existing id (src/index.ts:110), so id is stable
    // across re-register.
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, registered_at) VALUES ('dev-xyz', 'dev', 'evening', '%9', now()) ON CONFLICT(name) DO UPDATE SET group_name = EXCLUDED.group_name, pane_id = EXCLUDED.pane_id, registered_at = EXCLUDED.registered_at");

    const updated = dbQuery("SELECT * FROM agents WHERE name = 'dev'");
    expect(updated).toHaveLength(1);
    expect(updated[0].pane_id).toBe("%9");
    expect(updated[0].id).toBe("dev-abc");
  });

  it("ON CONFLICT(name) does not clobber other agents", () => {
    dbExec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents(name)");

    dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('a-1', 'alice', 'team', '%1')");
    dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('b-1', 'bob', 'team', '%2')");

    // Re-register alice — bob must survive. Post-#27 UPSERT does not
    // reassign id (see test above).
    dbExec("INSERT INTO agents (id, name, group_name, pane_id, registered_at) VALUES ('a-2', 'alice', 'team', '%5', now()) ON CONFLICT(name) DO UPDATE SET group_name = EXCLUDED.group_name, pane_id = EXCLUDED.pane_id, registered_at = EXCLUDED.registered_at");

    const all = dbQuery("SELECT name, pane_id FROM agents ORDER BY name");
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ name: "alice", pane_id: "%5" });
    expect(all[1]).toMatchObject({ name: "bob", pane_id: "%2" });
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
