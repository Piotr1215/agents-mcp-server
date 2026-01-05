// DuckDB backend for agent communication
// Each operation opens/closes connection to allow concurrent access from hook
import { Database } from "duckdb-async";

const DB_PATH = process.env.AGENTS_DB_PATH || "/home/decoder/.claude/data/agents.duckdb";

let initialized = false;

async function withDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const db = await Database.create(DB_PATH);
  try {
    if (!initialized) {
      await initSchema(db);
      initialized = true;
    }
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function initSchema(db: Database): Promise<void> {
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

// For server startup - just ensure schema exists
export async function getDb(): Promise<void> {
  await withDb(async () => {});
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
  await withDb(async (db) => {
    await db.run(
      `INSERT OR REPLACE INTO agents (id, name, group_name, pane_id, registered_at) VALUES (?, ?, ?, ?, now())`,
      id, name, group, paneId
    );
  });
}

export async function deregisterAgent(id: string): Promise<Agent | null> {
  return await withDb(async (db) => {
    const rows = await db.all(`SELECT * FROM agents WHERE id = ?`, id);
    if (rows.length > 0) {
      await db.run(`DELETE FROM agents WHERE id = ?`, id);
      return rows[0] as Agent;
    }
    return null;
  });
}

export async function getAgents(group?: string): Promise<Agent[]> {
  return await withDb(async (db) => {
    if (group) {
      return (await db.all(`SELECT * FROM agents WHERE group_name = ?`, group)) as Agent[];
    }
    return (await db.all(`SELECT * FROM agents`)) as Agent[];
  });
}

export async function getAgent(id: string): Promise<Agent | null> {
  return await withDb(async (db) => {
    const rows = await db.all(`SELECT * FROM agents WHERE id = ?`, id);
    return rows[0] as Agent || null;
  });
}

export async function getAgentByName(name: string): Promise<Agent | null> {
  return await withDb(async (db) => {
    const rows = await db.all(`SELECT * FROM agents WHERE name = ?`, name);
    return rows[0] as Agent || null;
  });
}

export async function logMessage(type: string, from: string | null, to: string | null, channel: string | null, content: string): Promise<number> {
  return await withDb(async (db) => {
    const result = await db.all(`SELECT nextval('msg_seq') as id`);
    const id = (result[0] as {id: number}).id;
    await db.run(
      `INSERT INTO messages (id, type, from_agent, to_agent, channel, content) VALUES (?, ?, ?, ?, ?, ?)`,
      id, type, from, to, channel, content
    );
    return id;
  });
}

export async function getChannelHistory(channel: string, limit = 50): Promise<Message[]> {
  return await withDb(async (db) => {
    return (await db.all(
      `SELECT * FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?`,
      channel, limit
    )) as Message[];
  });
}

export async function getMessagesSince(sinceId: number, limit = 100): Promise<Message[]> {
  return await withDb(async (db) => {
    return (await db.all(
      `SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?`,
      sinceId, limit
    )) as Message[];
  });
}

export async function getGroups(): Promise<{group_name: string, count: number}[]> {
  return await withDb(async (db) => {
    return (await db.all(
      `SELECT group_name, COUNT(*) as count FROM agents GROUP BY group_name ORDER BY group_name`
    )) as {group_name: string, count: number}[];
  });
}
