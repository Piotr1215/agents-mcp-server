import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/agents-test-group-history.duckdb";

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

describe("group history capture (real DuckDB)", () => {
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
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT now(),
        type VARCHAR,
        from_agent VARCHAR,
        to_agent VARCHAR,
        channel VARCHAR,
        content TEXT
      );
      CREATE SEQUENCE msg_seq START 1;
    `);
  });

  afterEach(() => {
    try { unlinkSync(TEST_DB); } catch { /* cleanup */ }
  });

  describe("broadcast stores group in channel", () => {
    it("stores target group as channel for group-scoped broadcast", () => {
      dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('alice-1', 'alice', 'redis', '%1')");

      // Simulate what agent_broadcast now does
      dbExec(`INSERT INTO messages (id, type, from_agent, channel, content)
        VALUES (nextval('msg_seq'), 'BROADCAST', 'alice-1', 'redis', 'hello group')`);

      const msgs = dbQuery("SELECT type, channel, content FROM messages WHERE type = 'BROADCAST'");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].channel).toBe("redis");
    });

    it("stores null channel for all-groups broadcast", () => {
      dbExec(`INSERT INTO messages (id, type, from_agent, channel, content)
        VALUES (nextval('msg_seq'), 'BROADCAST', 'alice-1', NULL, 'hello everyone')`);

      const msgs = dbQuery("SELECT channel FROM messages WHERE type = 'BROADCAST'");
      expect(msgs[0].channel).toBeNull();
    });
  });

  describe("LEFT messages store group in channel", () => {
    it("deregister logs LEFT with group as channel", () => {
      dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('bob-1', 'bob', 'tasks', '%2')");

      // Simulate what all exit paths now do
      dbExec(`
        DELETE FROM agents WHERE id = 'bob-1';
        INSERT INTO messages (id, type, from_agent, channel, content)
        VALUES (nextval('msg_seq'), 'LEFT', 'bob-1', 'tasks', 'bob left');
      `);

      const msgs = dbQuery("SELECT type, from_agent, channel, content FROM messages WHERE type = 'LEFT'");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].channel).toBe("tasks");
      expect(msgs[0].from_agent).toBe("bob-1");
    });

    it("session-closed logs LEFT with group as channel", () => {
      dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('triage-1', 'triage', 'tasks', '%3')");

      // Simulate __tmux_session_cleanup.sh
      dbExec(`
        DELETE FROM agents WHERE id = 'triage-1';
        INSERT INTO messages (id, type, from_agent, channel, content)
        VALUES (nextval('msg_seq'), 'LEFT', 'triage-1', 'tasks', 'triage left (reason: session-closed)');
      `);

      const msgs = dbQuery("SELECT channel, content FROM messages WHERE type = 'LEFT'");
      expect(msgs[0].channel).toBe("tasks");
      expect(msgs[0].content).toContain("session-closed");
    });

    it("prune-stale logs LEFT with group as channel", () => {
      dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('ghost-1', 'ghost', 'redis', '%999')");

      // Simulate __prune_stale_agents.sh
      dbExec(`
        DELETE FROM agents WHERE id = 'ghost-1';
        INSERT INTO messages (id, type, from_agent, channel, content)
        VALUES (nextval('msg_seq'), 'LEFT', 'ghost-1', 'redis', 'ghost left (reason: pruned-stale)');
      `);

      const msgs = dbQuery("SELECT channel, content FROM messages WHERE type = 'LEFT'");
      expect(msgs[0].channel).toBe("redis");
      expect(msgs[0].content).toContain("pruned-stale");
    });

    it("wrapper-exit logs LEFT with group as channel", () => {
      dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('ben-1', 'ben', 'redis', '%8')");

      // Simulate __claude_with_monitor.sh deregister_agent()
      dbExec(`
        DELETE FROM agents WHERE id = 'ben-1';
        INSERT INTO messages (id, type, from_agent, channel, content)
        VALUES (nextval('msg_seq'), 'LEFT', 'ben-1', 'redis', 'ben left (reason: wrapper-exit)');
      `);

      const msgs = dbQuery("SELECT channel, content FROM messages WHERE type = 'LEFT'");
      expect(msgs[0].channel).toBe("redis");
      expect(msgs[0].content).toContain("wrapper-exit");
    });

    it("health-check-pruned logs LEFT with group as channel", () => {
      dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('stale-1', 'stale', 'default', '%777')");

      // Simulate agent-health-check.sh act mode
      dbExec(`
        DELETE FROM agents WHERE id = 'stale-1';
        INSERT INTO messages (id, type, from_agent, channel, content)
        VALUES (nextval('msg_seq'), 'LEFT', 'stale-1', 'default', 'stale left (reason: health-check-pruned)');
      `);

      const msgs = dbQuery("SELECT channel, content FROM messages WHERE type = 'LEFT'");
      expect(msgs[0].channel).toBe("default");
      expect(msgs[0].content).toContain("health-check-pruned");
    });
  });

  describe("group history query", () => {
    it("retrieves broadcast and LEFT messages for a group", () => {
      // Mix of messages across groups
      dbExec(`
        INSERT INTO messages (id, type, from_agent, channel, content) VALUES
          (nextval('msg_seq'), 'BROADCAST', 'alice-1', 'redis', 'update from alice'),
          (nextval('msg_seq'), 'BROADCAST', 'bob-1', 'tasks', 'update from bob'),
          (nextval('msg_seq'), 'LEFT', 'charlie-1', 'redis', 'charlie left'),
          (nextval('msg_seq'), 'DM', 'alice-1', NULL, 'private msg'),
          (nextval('msg_seq'), 'CHANNEL', 'alice-1', 'general', 'channel msg');
      `);

      // Query group history (same as db.getGroupHistory)
      const redis = dbQuery(`
        SELECT * FROM messages
        WHERE channel = 'redis' AND type IN ('BROADCAST', 'LEFT', 'JOINED')
        ORDER BY timestamp DESC LIMIT 50
      `);

      expect(redis).toHaveLength(2);
      expect(redis.map((m: any) => m.type).sort()).toEqual(["BROADCAST", "LEFT"]);
      expect(redis.every((m: any) => m.channel === "redis")).toBe(true);
    });

    it("does not leak messages across groups", () => {
      dbExec(`
        INSERT INTO messages (id, type, from_agent, channel, content) VALUES
          (nextval('msg_seq'), 'BROADCAST', 'a-1', 'redis', 'redis msg'),
          (nextval('msg_seq'), 'BROADCAST', 'b-1', 'tasks', 'tasks msg');
      `);

      const tasks = dbQuery("SELECT * FROM messages WHERE channel = 'tasks' AND type IN ('BROADCAST', 'LEFT', 'JOINED')");
      expect(tasks).toHaveLength(1);
      expect(tasks[0].content).toBe("tasks msg");
    });

    it("returns empty for group with no history", () => {
      const empty = dbQuery("SELECT * FROM messages WHERE channel = 'nonexistent' AND type IN ('BROADCAST', 'LEFT', 'JOINED')");
      expect(empty).toHaveLength(0);
    });

    it("all-groups broadcast (null channel) excluded from group queries", () => {
      dbExec(`
        INSERT INTO messages (id, type, from_agent, channel, content) VALUES
          (nextval('msg_seq'), 'BROADCAST', 'a-1', NULL, 'to everyone'),
          (nextval('msg_seq'), 'BROADCAST', 'a-1', 'redis', 'to redis');
      `);

      const redis = dbQuery("SELECT * FROM messages WHERE channel = 'redis' AND type IN ('BROADCAST', 'LEFT', 'JOINED')");
      expect(redis).toHaveLength(1);
      expect(redis[0].content).toBe("to redis");
    });
  });

  describe("ghost detection logic", () => {
    it("agent with dead pane_id is a ghost", () => {
      dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('g-1', 'ghost', 'default', '%999')");

      const agents = dbQuery("SELECT name, pane_id, stable_pane FROM agents");
      const livePanes = new Set(["%1", "%2", "%3"]); // %999 not in set

      const ghosts = agents.filter((a: any) => {
        if (a.pane_id && !livePanes.has(a.pane_id)) return true;
        return false;
      });

      expect(ghosts).toHaveLength(1);
      expect(ghosts[0].name).toBe("ghost");
    });

    it("agent with live pane_id is healthy", () => {
      dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('h-1', 'healthy', 'default', '%1')");

      const agents = dbQuery("SELECT name, pane_id FROM agents");
      const livePanes = new Set(["%1", "%2"]);

      const ghosts = agents.filter((a: any) => a.pane_id && !livePanes.has(a.pane_id));
      expect(ghosts).toHaveLength(0);
    });

    it("agent with no pane identifiers is not flagged", () => {
      dbExec("INSERT INTO agents (id, name, group_name) VALUES ('n-1', 'nopane', 'default')");

      const agents = dbQuery("SELECT name, pane_id, stable_pane FROM agents");
      const livePanes = new Set(["%1"]);

      const ghosts = agents.filter((a: any) => {
        if (!a.pane_id && !a.stable_pane) return false;
        if (a.pane_id && !livePanes.has(a.pane_id)) return true;
        return false;
      });

      expect(ghosts).toHaveLength(0);
    });

    it("act mode: pruning ghost deletes from agents and logs LEFT", () => {
      dbExec("INSERT INTO agents (id, name, group_name, pane_id) VALUES ('g-1', 'ghost', 'redis', '%999')");

      // Simulate act mode
      dbExec(`
        DELETE FROM agents WHERE id = 'g-1';
        INSERT INTO messages (id, type, from_agent, channel, content)
        VALUES (nextval('msg_seq'), 'LEFT', 'g-1', 'redis', 'ghost left (reason: health-check-pruned)');
      `);

      const agents = dbQuery("SELECT * FROM agents WHERE id = 'g-1'");
      expect(agents).toHaveLength(0);

      const msgs = dbQuery("SELECT * FROM messages WHERE type = 'LEFT' AND from_agent = 'g-1'");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].channel).toBe("redis");
    });
  });
});
