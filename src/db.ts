// DuckDB backend for agent communication
// Uses CLI instead of library to avoid lock issues
import { execSync } from "child_process";

const DB_PATH = process.env.AGENTS_DB_PATH || "/home/decoder/.claude/data/agents.duckdb";

let initialized = false;

function dbQuery(sql: string): string {
  try {
    return execSync(`duckdb "${DB_PATH}" -json -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch (e) {
    return "[]";
  }
}

function dbExec(sql: string): void {
  try {
    execSync(`duckdb "${DB_PATH}" -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    // Ignore errors
  }
}

function initSchema(): void {
  if (initialized) return;
  dbExec(`
    CREATE TABLE IF NOT EXISTS agents (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      group_name VARCHAR DEFAULT 'default',
      pane_id VARCHAR,
      registered_at TIMESTAMP DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT now(),
      type VARCHAR,
      from_agent VARCHAR,
      to_agent VARCHAR,
      channel VARCHAR,
      content TEXT
    );
    CREATE SEQUENCE IF NOT EXISTS msg_seq START 1;
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
  pane_id: string | null;
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

export async function registerAgent(id: string, name: string, group: string, paneId: string): Promise<void> {
  initSchema();
  dbExec(`INSERT OR REPLACE INTO agents (id, name, group_name, pane_id, registered_at) VALUES ('${id}', '${name}', '${group}', '${paneId}', now())`);
}

export async function deregisterAgent(id: string): Promise<Agent | null> {
  initSchema();
  const result = dbQuery(`SELECT * FROM agents WHERE id = '${id}'`);
  const rows = JSON.parse(result || "[]");
  if (rows.length > 0) {
    dbExec(`DELETE FROM agents WHERE id = '${id}'`);
    return rows[0] as Agent;
  }
  return null;
}

export async function getAgents(group?: string): Promise<Agent[]> {
  initSchema();
  const sql = group
    ? `SELECT * FROM agents WHERE group_name = '${group}'`
    : `SELECT * FROM agents`;
  const result = dbQuery(sql);
  return JSON.parse(result || "[]") as Agent[];
}

export async function getAgent(id: string): Promise<Agent | null> {
  initSchema();
  const result = dbQuery(`SELECT * FROM agents WHERE id = '${id}'`);
  const rows = JSON.parse(result || "[]");
  return rows[0] as Agent || null;
}

export async function getAgentByName(name: string): Promise<Agent | null> {
  initSchema();
  const result = dbQuery(`SELECT * FROM agents WHERE name = '${name}'`);
  const rows = JSON.parse(result || "[]");
  return rows[0] as Agent || null;
}

export async function logMessage(type: string, from: string | null, to: string | null, channel: string | null, content: string): Promise<number> {
  initSchema();
  const idResult = dbQuery(`SELECT nextval('msg_seq') as id`);
  const id = JSON.parse(idResult || "[{\"id\":1}]")[0].id;
  const escapedContent = content.replace(/'/g, "''");
  dbExec(`INSERT INTO messages (id, type, from_agent, to_agent, channel, content) VALUES (${id}, '${type}', ${from ? `'${from}'` : 'NULL'}, ${to ? `'${to}'` : 'NULL'}, ${channel ? `'${channel}'` : 'NULL'}, '${escapedContent}')`);
  return id;
}

export async function getChannelHistory(channel: string, limit = 50): Promise<Message[]> {
  initSchema();
  const result = dbQuery(`SELECT * FROM messages WHERE channel = '${channel}' ORDER BY timestamp DESC LIMIT ${limit}`);
  return JSON.parse(result || "[]") as Message[];
}

export async function getDmHistory(agent1: string, agent2: string, limit = 50): Promise<Message[]> {
  initSchema();
  // Get DMs between two agents (both directions)
  const result = dbQuery(`SELECT * FROM messages WHERE type = 'DM' AND ((from_agent = '${agent1}' AND to_agent = '${agent2}') OR (from_agent = '${agent2}' AND to_agent = '${agent1}')) ORDER BY timestamp DESC LIMIT ${limit}`);
  return JSON.parse(result || "[]") as Message[];
}

export async function getMessagesSince(sinceId: number, limit = 100): Promise<Message[]> {
  initSchema();
  const result = dbQuery(`SELECT * FROM messages WHERE id > ${sinceId} ORDER BY id ASC LIMIT ${limit}`);
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
