// In-memory agent registry. Replaces the DuckDB-backed `agents` table (#129).
//
// Local agents are kept in a Map, populated by registerAgent, drained by
// deregisterAgent. Remote peers come from the NatsTransport presence cache
// (TTL-expired, already in place). Public API mirrors the old db.ts exports
// so the call sites in index.ts change only the import.
//
// No persistence across process restart: a restarted pod has an empty map
// until clients re-register. Remote peers learn themselves via presence beats.
import { createHash } from "crypto";
import { hostname } from "os";

export interface Agent {
  id: string;
  name: string;
  group_name: string;
  registered_at: Date;
}

export interface PresenceSource {
  getRemotePeers(group?: string): Array<{ agent_id: string; name: string; group: string; host: string; ts: number }>;
  getHost(): string;
}

const locals = new Map<string, Agent>();
let presenceSource: PresenceSource | null = null;

export function setPresenceSource(source: PresenceSource | null): void {
  presenceSource = source;
}

// Deterministic agent_id across restarts. Stable within a (name, host) pair,
// unique across hosts. Replaces the old random-hex suffix that produced a
// fresh id every boot.
export function generateAgentId(name: string, host: string = hostname()): string {
  const suffix = createHash("sha256").update(`${name}@${host}`).digest("hex").slice(0, 8);
  return `${name}-${suffix}`;
}

export function registerAgent(id: string, name: string, group: string): void {
  locals.set(id, { id, name, group_name: group, registered_at: new Date() });
}

export function deregisterAgent(id: string): Agent | null {
  const existing = locals.get(id);
  if (!existing) return null;
  locals.delete(id);
  return existing;
}

export function getAgent(id: string): Agent | null {
  return locals.get(id) ?? null;
}

export function getAgentByName(name: string): Agent | null {
  for (const agent of locals.values()) {
    if (agent.name === name) return agent;
  }
  return null;
}

// Union of local agents and remote presence beats, optionally filtered by
// group. Remote peers are adapted into the Agent shape; the presence cache
// already filters stale beats (TTL) and own-host echoes.
export function getAgents(group?: string): Agent[] {
  const result: Agent[] = [];
  for (const agent of locals.values()) {
    if (group && agent.group_name !== group) continue;
    result.push(agent);
  }
  if (presenceSource) {
    for (const beat of presenceSource.getRemotePeers(group)) {
      result.push({
        id: beat.agent_id,
        name: beat.name,
        group_name: beat.group,
        registered_at: new Date(beat.ts),
      });
    }
  }
  return result;
}

export function getGroups(): Array<{ group_name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const agent of locals.values()) {
    counts.set(agent.group_name, (counts.get(agent.group_name) ?? 0) + 1);
  }
  if (presenceSource) {
    for (const beat of presenceSource.getRemotePeers()) {
      counts.set(beat.group, (counts.get(beat.group) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([group_name, count]) => ({ group_name, count }))
    .sort((a, b) => a.group_name.localeCompare(b.group_name));
}
