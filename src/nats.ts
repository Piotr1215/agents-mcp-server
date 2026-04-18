// NATS transport for cross-host agent coordination. Enabled by AGENTS_NATS_URL.
//
// Phase 1: presence beats so remote agents show up in agent_discover.
// Phase 2: channel pub/sub so channel_send is replicated to all hosts —
// each host writes the incoming message to its local DuckDB so the
// existing channel_history reader keeps working unchanged.
//
// DMs and group broadcasts are still local tmux delivery only.
import { hostname } from "os";
import type { NatsConnection, Subscription } from "nats";

export interface PresenceBeat {
  agent_id: string;
  name: string;
  group: string;
  host: string;
  ts: number;
}

export interface RemoteChannelMessage {
  channel: string;
  fromAgent: string;
  content: string;
  originHost: string;
  originTs: number;
}

export interface NatsTransportConfig {
  url: string;
  host?: string;
  heartbeatMs?: number;
  peerTtlMs?: number;
  onChannelMessage?: (msg: RemoteChannelMessage) => void | Promise<void>;
  connector?: (url: string) => Promise<NatsConnection>;
  now?: () => number;
}

export interface LocalAgent {
  agent_id: string;
  name: string;
  group: string;
}

const PRESENCE_SUBJECT = "agents.presence";
const CHANNEL_SUBJECT_PREFIX = "agents.channel.";
const CHANNEL_SUBJECT_WILDCARD = "agents.channel.*";
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_PEER_TTL_MS = 30_000;

// NATS subjects allow [A-Za-z0-9._-] only; user-facing channel names do not
// (e.g. "#eng"). Base64url keeps the mapping reversible and ASCII-safe.
function channelToSubject(channel: string): string {
  return CHANNEL_SUBJECT_PREFIX + Buffer.from(channel, "utf-8").toString("base64url");
}

export class NatsTransport {
  private readonly url: string;
  private readonly host: string;
  private readonly heartbeatMs: number;
  private readonly peerTtlMs: number;
  private readonly now: () => number;
  private readonly connector: (url: string) => Promise<NatsConnection>;
  private readonly onChannelMessage: (msg: RemoteChannelMessage) => void | Promise<void>;
  private readonly peers = new Map<string, PresenceBeat>();
  private readonly locals = new Map<string, LocalAgent>();
  private nc: NatsConnection | null = null;
  private presenceSub: Subscription | null = null;
  private channelSub: Subscription | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private presenceLoop: Promise<void> | null = null;
  private channelLoop: Promise<void> | null = null;
  private closed = false;

  constructor(config: NatsTransportConfig) {
    this.url = config.url;
    this.host = config.host || hostname();
    this.heartbeatMs = config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.peerTtlMs = config.peerTtlMs ?? DEFAULT_PEER_TTL_MS;
    this.now = config.now ?? (() => Date.now());
    this.onChannelMessage = config.onChannelMessage ?? (() => {});
    this.connector = config.connector ?? (async (url) => {
      const nats = await import("nats");
      return nats.connect({ servers: url, name: `agents-mcp@${this.host}` });
    });
  }

  async start(): Promise<void> {
    this.nc = await this.connector(this.url);
    this.presenceSub = this.nc.subscribe(PRESENCE_SUBJECT);
    this.presenceLoop = this.consumePresence(this.presenceSub);
    this.channelSub = this.nc.subscribe(CHANNEL_SUBJECT_WILDCARD);
    this.channelLoop = this.consumeChannel(this.channelSub);
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

  publishChannelMessage(channel: string, fromAgent: string, content: string): void {
    if (!this.nc || this.closed) return;
    const payload = {
      channel,
      from_agent: fromAgent,
      content,
      origin_host: this.host,
      origin_ts: this.now(),
    };
    this.nc.publish(channelToSubject(channel), Buffer.from(JSON.stringify(payload)));
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
    for (const sub of [this.presenceSub, this.channelSub]) {
      if (sub) sub.unsubscribe();
    }
    this.presenceSub = null;
    this.channelSub = null;
    for (const loop of [this.presenceLoop, this.channelLoop]) {
      if (loop) { try { await loop; } catch { /* drained */ } }
    }
    this.presenceLoop = null;
    this.channelLoop = null;
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

  private async consumeChannel(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const raw = JSON.parse(Buffer.from(msg.data).toString("utf-8")) as {
          channel?: string;
          from_agent?: string;
          content?: string;
          origin_host?: string;
          origin_ts?: number;
        };
        if (!raw.channel || !raw.content || !raw.origin_host) {
          console.error("[nats] bad channel payload: missing fields");
          continue;
        }
        // Skip our own echoes — we already wrote them locally before publish.
        if (raw.origin_host === this.host) continue;
        await this.onChannelMessage({
          channel: raw.channel,
          fromAgent: raw.from_agent ?? "unknown",
          content: raw.content,
          originHost: raw.origin_host,
          originTs: raw.origin_ts ?? this.now(),
        });
      } catch (err) {
        console.error("[nats] bad channel payload:", err);
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
