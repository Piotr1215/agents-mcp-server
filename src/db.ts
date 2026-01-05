// DuckDB backend for agent communication
import { Database } from "duckdb-async";

const DB_PATH = process.env.AGENTS_DB_PATH || "/tmp/agents.duckdb";

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.create(DB_PATH);
    await initSchema();
  }
  return db;
}

async function initSchema(): Promise<void> {
  if (!db) return;

  await db.exec(`
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
  const conn = await getDb();
  await conn.run(
    `INSERT OR REPLACE INTO agents (id, name, group_name, pane_id, registered_at) VALUES (?, ?, ?, ?, now())`,
    id, name, group, paneId
  );
}

export async function deregisterAgent(id: string): Promise<Agent | null> {
  const conn = await getDb();
  const rows = await conn.all(`SELECT * FROM agents WHERE id = ?`, id);
  if (rows.length > 0) {
    await conn.run(`DELETE FROM agents WHERE id = ?`, id);
    return rows[0] as Agent;
  }
  return null;
}

export async function getAgents(group?: string): Promise<Agent[]> {
  const conn = await getDb();
  if (group) {
    return (await conn.all(`SELECT * FROM agents WHERE group_name = ?`, group)) as Agent[];
  }
  return (await conn.all(`SELECT * FROM agents`)) as Agent[];
}

export async function getAgent(id: string): Promise<Agent | null> {
  const conn = await getDb();
  const rows = await conn.all(`SELECT * FROM agents WHERE id = ?`, id);
  return rows[0] as Agent || null;
}

export async function getAgentByName(name: string): Promise<Agent | null> {
  const conn = await getDb();
  const rows = await conn.all(`SELECT * FROM agents WHERE name = ?`, name);
  return rows[0] as Agent || null;
}

export async function logMessage(type: string, from: string | null, to: string | null, channel: string | null, content: string): Promise<number> {
  const conn = await getDb();
  const result = await conn.all(`SELECT nextval('msg_seq') as id`);
  const id = (result[0] as {id: number}).id;
  await conn.run(
    `INSERT INTO messages (id, type, from_agent, to_agent, channel, content) VALUES (?, ?, ?, ?, ?, ?)`,
    id, type, from, to, channel, content
  );
  return id;
}

export async function getChannelHistory(channel: string, limit = 50): Promise<Message[]> {
  const conn = await getDb();
  return (await conn.all(
    `SELECT * FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?`,
    channel, limit
  )) as Message[];
}

export async function getMessagesSince(sinceId: number, limit = 100): Promise<Message[]> {
  const conn = await getDb();
  return (await conn.all(
    `SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
    sinceId, limit
  )) as Message[];
}

export async function getGroups(): Promise<{group_name: string, count: number}[]> {
  const conn = await getDb();
  return (await conn.all(
    `SELECT group_name, COUNT(*) as count FROM agents GROUP BY group_name ORDER BY group_name`
  )) as {group_name: string, count: number}[];
}
