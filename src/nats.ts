// Presence-only NATS transport. Enabled by AGENTS_NATS_URL.
//
// Publishes periodic presence beats and subscribes to peers so agents on
// other machines are visible to agent_discover. Does not yet route DMs or
// broadcasts — local tmux delivery is unchanged.
import { hostname } from "os";
import type { NatsConnection, Subscription } from "nats";

export interface PresenceBeat {
  agent_id: string;
  name: string;
  group: string;
  host: string;
  ts: number;
}

export interface NatsTransportConfig {
  url: string;
  host?: string;
  heartbeatMs?: number;
  peerTtlMs?: number;
  connector?: (url: string) => Promise<NatsConnection>;
  now?: () => number;
}

export interface LocalAgent {
  agent_id: string;
  name: string;
  group: string;
}

const PRESENCE_SUBJECT = "agents.presence";
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_PEER_TTL_MS = 30_000;

export class NatsTransport {
  private readonly url: string;
  private readonly host: string;
  private readonly heartbeatMs: number;
  private readonly peerTtlMs: number;
  private readonly now: () => number;
  private readonly connector: (url: string) => Promise<NatsConnection>;
  private readonly peers = new Map<string, PresenceBeat>();
  private readonly locals = new Map<string, LocalAgent>();
  private nc: NatsConnection | null = null;
  private sub: Subscription | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readLoop: Promise<void> | null = null;
  private closed = false;

  constructor(config: NatsTransportConfig) {
    this.url = config.url;
    this.host = config.host || hostname();
    this.heartbeatMs = config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.peerTtlMs = config.peerTtlMs ?? DEFAULT_PEER_TTL_MS;
    this.now = config.now ?? (() => Date.now());
    this.connector = config.connector ?? (async (url) => {
      const nats = await import("nats");
      return nats.connect({ servers: url, name: `agents-mcp@${this.host}` });
    });
  }

  async start(): Promise<void> {
    this.nc = await this.connector(this.url);
    this.sub = this.nc.subscribe(PRESENCE_SUBJECT);
    this.readLoop = this.consumePresence(this.sub);
    this.heartbeatTimer = setInterval(() => {
      this.publishAll().catch((err) => console.error("[nats] heartbeat failed:", err));
    }, this.heartbeatMs);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  trackLocal(agent: LocalAgent): void {
    this.locals.set(agent.agent_id, agent);
  }

  untrackLocal(agentId: string): void {
    this.locals.delete(agentId);
  }

  async publishAll(): Promise<void> {
    if (!this.nc || this.closed) return;
    for (const agent of this.locals.values()) {
      await this.publishBeat(agent);
    }
  }

  async publishBeat(agent: LocalAgent): Promise<void> {
    if (!this.nc || this.closed) return;
    const beat: PresenceBeat = {
      agent_id: agent.agent_id,
      name: agent.name,
      group: agent.group,
      host: this.host,
      ts: this.now(),
    };
    this.nc.publish(PRESENCE_SUBJECT, Buffer.from(JSON.stringify(beat)));
  }

  getRemotePeers(group?: string): PresenceBeat[] {
    const cutoff = this.now() - this.peerTtlMs;
    const result: PresenceBeat[] = [];
    for (const [id, beat] of this.peers) {
      if (beat.ts < cutoff) {
        this.peers.delete(id);
        continue;
      }
      if (this.locals.has(id)) continue;
      if (group && beat.group !== group) continue;
      result.push(beat);
    }
    return result;
  }

  getHost(): string {
    return this.host;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sub) {
      this.sub.unsubscribe();
      this.sub = null;
    }
    if (this.readLoop) {
      try { await this.readLoop; } catch { /* drained */ }
      this.readLoop = null;
    }
    if (this.nc) {
      await this.nc.drain().catch(() => { /* best-effort */ });
      this.nc = null;
    }
  }

  // Visible for tests.
  ingestBeat(beat: PresenceBeat): void {
    this.peers.set(beat.agent_id, beat);
  }

  private async consumePresence(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const beat = JSON.parse(Buffer.from(msg.data).toString("utf-8")) as PresenceBeat;
        if (beat.agent_id && beat.name && typeof beat.ts === "number") {
          this.ingestBeat(beat);
        }
      } catch (err) {
        console.error("[nats] bad presence payload:", err);
      }
    }
  }
}

export async function initNatsTransport(config: NatsTransportConfig): Promise<NatsTransport | null> {
  try {
    const transport = new NatsTransport(config);
    await transport.start();
    console.error(`[nats] connected to ${config.url} as ${transport.getHost()}`);
    return transport;
  } catch (err) {
    console.error(`[nats] disabled — connect failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
