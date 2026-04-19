// DuckDB backend for agent communication
// Uses CLI instead of library to avoid lock issues
import { execSync } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";
import { mkdirSync } from "fs";

// Default under $HOME so the server boots on any Linux/macOS account without
// AGENTS_DB_PATH. Previously hardcoded to /home/decoder/... which broke every
// other user and every root/container install.
const DB_PATH = process.env.AGENTS_DB_PATH || join(homedir(), ".claude", "data", "agents.duckdb");

let initialized = false;

// Thrown by dbExec / dbQuery when retries are exhausted. Callers on critical
// paths (register, history reads) let it propagate so the failure is loud.
// Non-critical paths (logMessage, metrics) wrap in try/catch. Prior behavior
// was to log + return silently, which masked Piotr1215/claude#120-class bugs
// for hours — the register UPSERT appeared to succeed when it hadn't.
export class DbError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DbError";
  }
}

// Escape string for SQL single-quoted literals
function esc(value: string): string {
  return value.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

function dbQuery(sql: string, retries = 5): string {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return execSync(`duckdb "${DB_PATH}" -json -c "${sql.replace(/"/g, '\\"')}"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch (e) {
      lastErr = e;
      if (attempt === retries - 1) break;
      const delay = Math.pow(2, attempt) * 100;
      execSync(`sleep ${delay / 1000}`);
    }
  }
  console.error("[db] Query failed after retries:", lastErr);
  throw new DbError(`dbQuery failed after ${retries} retries`, lastErr);
}

function dbExec(sql: string, retries = 5): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      execSync(`duckdb "${DB_PATH}" -c "${sql.replace(/"/g, '\\"')}"`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      return;
    } catch (e) {
      lastErr = e;
      if (attempt === retries - 1) break;
      const delay = Math.pow(2, attempt) * 100;
      execSync(`sleep ${delay / 1000}`);
    }
  }
  console.error("[db] Exec failed after retries:", lastErr);
  throw new DbError(`dbExec failed after ${retries} retries`, lastErr);
}

function initSchema(): void {
  if (initialized) return;
  // duckdb CLI refuses to open a file under a missing directory. Create the
  // parent on first boot so fresh accounts (no ~/.claude/data yet) don't need
  // any pre-step from the installer.
  mkdirSync(dirname(DB_PATH), { recursive: true });
  dbExec(`
    CREATE TABLE IF NOT EXISTS agents (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      group_name VARCHAR DEFAULT 'default',
      registered_at TIMESTAMP DEFAULT now()
    );
    -- Clean-break migration: drop legacy local-plane columns. pane_id /
    -- stable_pane were tmux artifacts from the pre-NATS delivery era. The
    -- server now lives strictly in the remote plane — comms handles push,
    -- snd handles publish, neither cares about panes.
    --
    -- DuckDB rejects ALTER TABLE DROP COLUMN when *any* index exists on the
    -- table ("Cannot alter entry 'agents' because there are entries that
    -- depend on it"), even if the index doesn't reference the dropped
    -- column. Fresh installs don't hit this (no pre-existing index at ALTER
    -- time), but grandfathered DBs that already built idx_agents_name on a
    -- prior boot fail every startup until the index is dropped first.
    DROP INDEX IF EXISTS idx_agents_name;
    ALTER TABLE agents DROP COLUMN IF EXISTS pane_id;
    ALTER TABLE agents DROP COLUMN IF EXISTS stable_pane;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT now(),
      type VARCHAR,
      from_agent VARCHAR,
      to_agent VARCHAR,
      channel VARCHAR,
      content TEXT,
      origin_host VARCHAR
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin_host VARCHAR;
    CREATE TABLE IF NOT EXISTS tool_metrics (
      id INTEGER PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT now(),
      tool_name VARCHAR NOT NULL,
      response_chars INTEGER NOT NULL,
      response_lines INTEGER NOT NULL,
      duration_ms INTEGER,
      is_error BOOLEAN DEFAULT false
    );
    CREATE SEQUENCE IF NOT EXISTS msg_seq START 1;
    CREATE SEQUENCE IF NOT EXISTS metric_seq START 1;
  `);
  initialized = true;
}

// For server startup
export async function getDb(): Promise<void> {
  initSchema();
}

export interface Agent {
  id: string;
  name: string;
  group_name: string;
  registered_at: Date;
}

export interface Message {
  id: number;
  timestamp: Date;
  type: string;
  from_agent: string | null;
  to_agent: string | null;
  channel: string | null;
  content: string;
}

export async function registerAgent(id: string, name: string, group: string): Promise<void> {
  initSchema();
  // id is the PRIMARY KEY — DuckDB 1.1.3+ rejects assigning to it in an UPSERT
  // ("Binder Error: Can not assign to column 'id' because it has a UNIQUE/
  // PRIMARY KEY constraint"). index.ts already reuses the existing id on name
  // conflict, so this branch never needs to update id anyway. Dropping the
  // clause lets fresh (non-grandfathered) DuckDB installs register cleanly.
  dbExec(`INSERT INTO agents (id, name, group_name, registered_at) VALUES ('${esc(id)}', '${esc(name)}', '${esc(group)}', now()) ON CONFLICT(name) DO UPDATE SET group_name = EXCLUDED.group_name, registered_at = EXCLUDED.registered_at`);
}

export async function deregisterAgent(id: string): Promise<Agent | null> {
  initSchema();
  const result = dbQuery(`SELECT * FROM agents WHERE id = '${esc(id)}'`);
  const rows = JSON.parse(result || "[]");
  if (rows.length > 0) {
    dbExec(`DELETE FROM agents WHERE id = '${esc(id)}'`);
    return rows[0] as Agent;
  }
  return null;
}

export async function getAgents(group?: string): Promise<Agent[]> {
  initSchema();
  const sql = group
    ? `SELECT * FROM agents WHERE group_name = '${esc(group)}'`
    : `SELECT * FROM agents`;
  const result = dbQuery(sql);
  return JSON.parse(result || "[]") as Agent[];
}

export async function getAgent(id: string): Promise<Agent | null> {
  initSchema();
  const result = dbQuery(`SELECT * FROM agents WHERE id = '${esc(id)}'`);
  const rows = JSON.parse(result || "[]");
  return rows[0] as Agent || null;
}

export async function getAgentByName(name: string): Promise<Agent | null> {
  initSchema();
  const result = dbQuery(`SELECT * FROM agents WHERE name = '${esc(name)}'`);
  const rows = JSON.parse(result || "[]");
  return rows[0] as Agent || null;
}

export async function setCommsBound(name: string, bound: boolean): Promise<void> {
  initSchema();
  dbExec(`UPDATE agents SET comms_bound = ${bound ? "true" : "false"} WHERE name = '${esc(name)}'`);
}

export async function logMessage(type: string, from: string | null, to: string | null, channel: string | null, content: string, originHost: string | null = null): Promise<number> {
  initSchema();
  // Best-effort: the canonical delivery path is NATS. If logging fails we
  // still want the DM/broadcast to have been delivered, not to throw up the
  // stack and mislead the caller into thinking the send itself failed. The
  // DbError still hits stderr via dbExec/dbQuery so the outage is visible.
  try {
    const idResult = dbQuery(`SELECT nextval('msg_seq') as id`);
    const rows = JSON.parse(idResult || "[]");
    const id = rows[0]?.id ?? Date.now();
    dbExec(`INSERT INTO messages (id, type, from_agent, to_agent, channel, content, origin_host) VALUES (${id}, '${esc(type)}', ${from ? `'${esc(from)}'` : 'NULL'}, ${to ? `'${esc(to)}'` : 'NULL'}, ${channel ? `'${esc(channel)}'` : 'NULL'}, '${esc(content)}', ${originHost ? `'${esc(originHost)}'` : 'NULL'})`);
    return id;
  } catch (e) {
    if (e instanceof DbError) return -1;
    throw e;
  }
}

export async function insertReplicatedChannelMessage(params: {
  channel: string;
  fromAgent: string;
  content: string;
  originHost: string;
}): Promise<number> {
  return logMessage("CHANNEL", params.fromAgent, null, params.channel, params.content, params.originHost);
}

export async function insertReplicatedDm(params: {
  toAgent: string;
  fromAgent: string;
  content: string;
  originHost: string;
}): Promise<number> {
  // Resolve both sides to their canonical agent_id when known so dm_history
  // joins the rows to their agents; fall back to the name when the peer
  // isn't in our local registry (remote-only agent).
  const from = await getAgentByName(params.fromAgent);
  const to = await getAgentByName(params.toAgent);
  const fromId = from?.id || params.fromAgent;
  const toId = to?.id || params.toAgent;
  return logMessage("DM", fromId, toId, null, params.content, params.originHost);
}

export async function insertReplicatedBroadcast(params: {
  group: string;
  fromAgent: string;
  content: string;
  originHost: string;
}): Promise<number> {
  // Store group name in the channel column so existing group_history queries
  // (which filter by channel == group) pick remote broadcasts up unchanged.
  const from = await getAgentByName(params.fromAgent);
  const fromId = from?.id || params.fromAgent;
  return logMessage("BROADCAST", fromId, null, params.group, params.content, params.originHost);
}

export async function getChannelHistory(channel: string, limit = 50): Promise<Message[]> {
  initSchema();
  const result = dbQuery(`SELECT * FROM messages WHERE channel = '${esc(channel)}' ORDER BY timestamp DESC LIMIT ${limit}`);
  return JSON.parse(result || "[]") as Message[];
}

export async function getDmHistory(agent1: string, agent2: string, limit = 50): Promise<Message[]> {
  initSchema();
  const result = dbQuery(`SELECT * FROM messages WHERE type = 'DM' AND ((from_agent = '${esc(agent1)}' AND to_agent = '${esc(agent2)}') OR (from_agent = '${esc(agent2)}' AND to_agent = '${esc(agent1)}')) ORDER BY timestamp DESC LIMIT ${limit}`);
  return JSON.parse(result || "[]") as Message[];
}

export async function getGroupHistory(group: string, limit = 50): Promise<Message[]> {
  initSchema();
  const result = dbQuery(`SELECT * FROM messages WHERE channel = '${esc(group)}' AND type IN ('BROADCAST', 'LEFT', 'JOINED') ORDER BY timestamp DESC LIMIT ${limit}`);
  return JSON.parse(result || "[]") as Message[];
}

export async function getMessagesSince(sinceId: number, limit = 100): Promise<Message[]> {
  initSchema();
  const result = dbQuery(`SELECT * FROM messages WHERE id > ${sinceId} ORDER BY id ASC LIMIT ${limit}`);
  return JSON.parse(result || "[]") as Message[];
}

export async function getMessagesForAgent(agentId: string, groupName: string, sinceId: number, limit = 50): Promise<Message[]> {
  initSchema();
  const result = dbQuery(`
    SELECT * FROM messages
    WHERE id > ${sinceId}
      AND (from_agent IS NULL OR from_agent != '${esc(agentId)}')
      AND (
        (type = 'DM' AND to_agent = '${esc(agentId)}')
        OR (type = 'BROADCAST' AND channel = '${esc(groupName)}')
      )
    ORDER BY id ASC
    LIMIT ${limit}
  `);
  return JSON.parse(result || "[]") as Message[];
}

export async function getGroups(): Promise<{group_name: string, count: number}[]> {
  initSchema();
  const result = dbQuery(`SELECT group_name, COUNT(*) as count FROM agents GROUP BY group_name ORDER BY group_name`);
  return JSON.parse(result || "[]") as {group_name: string, count: number}[];
}

export async function getChannels(): Promise<{channel: string, message_count: number}[]> {
  initSchema();
  const result = dbQuery(`SELECT channel, COUNT(*) as message_count FROM messages WHERE channel IS NOT NULL GROUP BY channel ORDER BY channel`);
  return JSON.parse(result || "[]") as {channel: string, message_count: number}[];
}

export interface ToolMetric {
  id: number;
  timestamp: Date;
  tool_name: string;
  response_chars: number;
  response_lines: number;
  duration_ms: number | null;
  is_error: boolean;
}

export async function logToolMetric(toolName: string, responseChars: number, responseLines: number, durationMs: number | null, isError: boolean): Promise<void> {
  initSchema();
  // Telemetry — a missing metric row should never break a live tool call.
  try {
    const idResult = dbQuery(`SELECT nextval('metric_seq') as id`);
    const rows = JSON.parse(idResult || "[]");
    const id = rows[0]?.id ?? Date.now();
    dbExec(`INSERT INTO tool_metrics (id, tool_name, response_chars, response_lines, duration_ms, is_error) VALUES (${id}, '${esc(toolName)}', ${responseChars}, ${responseLines}, ${durationMs ?? 'NULL'}, ${isError})`);
  } catch (e) {
    if (!(e instanceof DbError)) throw e;
  }
}

export async function getToolMetrics(days = 7): Promise<ToolMetric[]> {
  initSchema();
  const result = dbQuery(`SELECT * FROM tool_metrics WHERE timestamp > now() - INTERVAL '${days} days' ORDER BY timestamp DESC`);
  return JSON.parse(result || "[]") as ToolMetric[];
}

export async function getToolMetricsSummary(days = 7): Promise<{tool_name: string, call_count: number, avg_chars: number, total_chars: number, error_count: number}[]> {
  initSchema();
  const result = dbQuery(`
    SELECT
      tool_name,
      COUNT(*) as call_count,
      ROUND(AVG(response_chars))::INTEGER as avg_chars,
      SUM(response_chars) as total_chars,
      SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as error_count
    FROM tool_metrics
    WHERE timestamp > now() - INTERVAL '${days} days'
    GROUP BY tool_name
    ORDER BY total_chars DESC
  `);
  return JSON.parse(result || "[]") as {tool_name: string, call_count: number, avg_chars: number, total_chars: number, error_count: number}[];
}
