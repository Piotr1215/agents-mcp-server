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
  originSeq: number;
}

export interface RemoteDirectMessage {
  toAgent: string;
  fromAgent: string;
  content: string;
  originHost: string;
  originTs: number;
  originSeq: number;
}

export interface RemoteBroadcastMessage {
  group: string;
  fromAgent: string;
  content: string;
  originHost: string;
  originTs: number;
  originSeq: number;
}

export interface NatsTransportConfig {
  url: string;
  host?: string;
  heartbeatMs?: number;
  peerTtlMs?: number;
  onChannelMessage?: (msg: RemoteChannelMessage) => void | Promise<void>;
  onDirectMessage?: (msg: RemoteDirectMessage) => void | Promise<void>;
  onBroadcast?: (msg: RemoteBroadcastMessage) => void | Promise<void>;
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
const DM_SUBJECT_PREFIX = "agents.dm.";
const DM_SUBJECT_WILDCARD = "agents.dm.*";
const BROADCAST_SUBJECT_PREFIX = "agents.broadcast.";
const BROADCAST_SUBJECT_WILDCARD = "agents.broadcast.*";
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_PEER_TTL_MS = 30_000;

// NATS subjects allow [A-Za-z0-9._-] only; user-facing channel names do not
// (e.g. "#eng"). Base64url keeps the mapping reversible and ASCII-safe.
function channelToSubject(channel: string): string {
  return CHANNEL_SUBJECT_PREFIX + Buffer.from(channel, "utf-8").toString("base64url");
}

// Agent names are usually subject-safe already, but users can pick anything.
// Encode to the same canonical form for consistency with channels.
function dmToSubject(toAgent: string): string {
  return DM_SUBJECT_PREFIX + Buffer.from(toAgent, "utf-8").toString("base64url");
}

// Group names share the same concerns — encode consistently.
function broadcastToSubject(group: string): string {
  return BROADCAST_SUBJECT_PREFIX + Buffer.from(group, "utf-8").toString("base64url");
}

export class NatsTransport {
  private readonly url: string;
  private readonly host: string;
  private readonly heartbeatMs: number;
  private readonly peerTtlMs: number;
  private readonly now: () => number;
  private readonly connector: (url: string) => Promise<NatsConnection>;
  private readonly onChannelMessage: (msg: RemoteChannelMessage) => void | Promise<void>;
  private readonly onDirectMessage: (msg: RemoteDirectMessage) => void | Promise<void>;
  private readonly onBroadcast: (msg: RemoteBroadcastMessage) => void | Promise<void>;
  private readonly peers = new Map<string, PresenceBeat>();
  private readonly locals = new Map<string, LocalAgent>();
  // Monotonic per-process sequence. Breaks ties when two publishes land in
  // the same millisecond — consumers can sort by (origin_ts, origin_seq) for
  // deterministic ordering within a single publisher. Cross-host ordering is
  // out of scope: each host maintains its own counter. Resets to 0 on process
  // restart; durability across restarts would need a persisted counter or a
  // global broker sequence, neither of which is required for tie-breaking.
  private seq: number = 0;
  private nc: NatsConnection | null = null;
  private presenceSub: Subscription | null = null;
  private channelSub: Subscription | null = null;
  private dmSub: Subscription | null = null;
  private broadcastSub: Subscription | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private presenceLoop: Promise<void> | null = null;
  private channelLoop: Promise<void> | null = null;
  private dmLoop: Promise<void> | null = null;
  private broadcastLoop: Promise<void> | null = null;
  private statusLoop: Promise<void> | null = null;
  private closed = false;

  constructor(config: NatsTransportConfig) {
    this.url = config.url;
    this.host = config.host || hostname();
    this.heartbeatMs = config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.peerTtlMs = config.peerTtlMs ?? DEFAULT_PEER_TTL_MS;
    this.now = config.now ?? (() => Date.now());
    this.onChannelMessage = config.onChannelMessage ?? (() => {});
    this.onDirectMessage = config.onDirectMessage ?? (() => {});
    this.onBroadcast = config.onBroadcast ?? (() => {});
    this.connector = config.connector ?? (async (url) => {
      const nats = await import("nats");
      // Infinite reconnect: broker flaps longer than the default 20s budget
      // (10 attempts × 2000ms) would permanently silence this session until
      // process restart. See Piotr1215/claude#120.
      return nats.connect({
        servers: url,
        name: `agents-mcp@${this.host}`,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
        pingInterval: 20_000,
      });
    });
  }

  async start(): Promise<void> {
    this.nc = await this.connector(this.url);
    this.setupSubscriptions();
    this.statusLoop = this.consumeStatus(this.nc);
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
      origin_seq: this.seq++,
    };
    this.nc.publish(channelToSubject(channel), Buffer.from(JSON.stringify(payload)));
  }

  publishDirectMessage(toAgent: string, fromAgent: string, content: string): void {
    if (!this.nc || this.closed) return;
    const payload = {
      to_agent: toAgent,
      from_agent: fromAgent,
      content,
      origin_host: this.host,
      origin_ts: this.now(),
      origin_seq: this.seq++,
    };
    this.nc.publish(dmToSubject(toAgent), Buffer.from(JSON.stringify(payload)));
  }

  publishBroadcast(group: string, fromAgent: string, content: string): void {
    if (!this.nc || this.closed) return;
    const payload = {
      group,
      from_agent: fromAgent,
      content,
      origin_host: this.host,
      origin_ts: this.now(),
      origin_seq: this.seq++,
    };
    this.nc.publish(broadcastToSubject(group), Buffer.from(JSON.stringify(payload)));
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
      // Own-host peers also reach us via wildcard subscribe — drop them so
      // agent_discover does not render local agents twice (once local, once
      // as "remote" from our own presence beat loopback).
      if (beat.host === this.host) continue;
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
    for (const sub of [this.presenceSub, this.channelSub, this.dmSub, this.broadcastSub]) {
      if (sub) sub.unsubscribe();
    }
    this.presenceSub = null;
    this.channelSub = null;
    this.dmSub = null;
    this.broadcastSub = null;
    for (const loop of [this.presenceLoop, this.channelLoop, this.dmLoop, this.broadcastLoop, this.statusLoop]) {
      if (loop) { try { await loop; } catch { /* drained */ } }
    }
    this.presenceLoop = null;
    this.channelLoop = null;
    this.dmLoop = null;
    this.broadcastLoop = null;
    this.statusLoop = null;
    if (this.nc) {
      await this.nc.drain().catch(() => { /* best-effort */ });
      this.nc = null;
    }
  }

  // Visible for tests.
  ingestBeat(beat: PresenceBeat): void {
    this.peers.set(beat.agent_id, beat);
  }

  // (Re)create all four wildcard subscriptions and the consume loops feeding
  // them. Called once from start() and again from the status watcher on every
  // reconnect — nats.js v2 keeps pre-existing Subscription objects alive after
  // reconnect, but we've seen iterator stalls in practice (#120), so re-
  // establishing the subs is belt-and-braces. Visible for tests.
  setupSubscriptions(): void {
    if (!this.nc) return;
    for (const sub of [this.presenceSub, this.channelSub, this.dmSub, this.broadcastSub]) {
      if (sub) sub.unsubscribe();
    }
    this.presenceSub = this.nc.subscribe(PRESENCE_SUBJECT);
    this.presenceLoop = this.consumePresence(this.presenceSub);
    this.channelSub = this.nc.subscribe(CHANNEL_SUBJECT_WILDCARD);
    this.channelLoop = this.consumeChannel(this.channelSub);
    this.dmSub = this.nc.subscribe(DM_SUBJECT_WILDCARD);
    this.dmLoop = this.consumeDm(this.dmSub);
    this.broadcastSub = this.nc.subscribe(BROADCAST_SUBJECT_WILDCARD);
    this.broadcastLoop = this.consumeBroadcast(this.broadcastSub);
  }

  // Watch the connection's status event stream. Log lifecycle transitions for
  // debuggability, and resubscribe on reconnect so a silenced flap cannot wipe
  // inbound delivery for the rest of the process lifetime (#120).
  private async consumeStatus(nc: NatsConnection): Promise<void> {
    // Fake connections in tests may not implement status(); skip silently.
    if (typeof nc.status !== "function") return;
    let stream: AsyncIterable<{ type: string; data?: unknown }>;
    try {
      stream = nc.status() as AsyncIterable<{ type: string; data?: unknown }>;
      if (!stream || typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") return;
    } catch {
      return;
    }
    try {
      for await (const status of stream) {
        if (this.closed) break;
        console.error(`[nats] ${status.type}${status.data ? `: ${status.data}` : ""}`);
        if (status.type === "reconnect") {
          this.setupSubscriptions();
        }
      }
    } catch (err) {
      if (!this.closed) console.error("[nats] status loop exited:", err);
    }
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

  // Receive paths deliver every message to their handler, including own-host
  // echoes. Echo suppression lives in the handler — not here — because multiple
  // independent agent-mcp-server processes can share a hostname (tmux panes on
  // one laptop, pods on one k8s node), and a hostname-level filter silently
  // drops legitimate peer traffic. The handler decides per message whether to
  // write to the shared DB (skip when origin_host matches, since the publisher
  // already wrote) and whether to push to the bound session (skip only when
  // from_agent is this session's own identity).
  private async consumeChannel(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const raw = JSON.parse(Buffer.from(msg.data).toString("utf-8")) as {
          channel?: string;
          from_agent?: string;
          content?: string;
          origin_host?: string;
          origin_ts?: number;
          origin_seq?: number;
        };
        if (!raw.channel || !raw.content || !raw.origin_host) {
          console.error("[nats] bad channel payload: missing fields");
          continue;
        }
        await this.onChannelMessage({
          channel: raw.channel,
          fromAgent: raw.from_agent ?? "unknown",
          content: raw.content,
          originHost: raw.origin_host,
          originTs: raw.origin_ts ?? this.now(),
          originSeq: raw.origin_seq ?? 0,
        });
      } catch (err) {
        console.error("[nats] bad channel payload:", err);
      }
    }
  }

  private async consumeDm(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const raw = JSON.parse(Buffer.from(msg.data).toString("utf-8")) as {
          to_agent?: string;
          from_agent?: string;
          content?: string;
          origin_host?: string;
          origin_ts?: number;
          origin_seq?: number;
        };
        if (!raw.to_agent || !raw.from_agent || !raw.content || !raw.origin_host) {
          console.error("[nats] bad dm payload: missing fields");
          continue;
        }
        await this.onDirectMessage({
          toAgent: raw.to_agent,
          fromAgent: raw.from_agent,
          content: raw.content,
          originHost: raw.origin_host,
          originTs: raw.origin_ts ?? this.now(),
          originSeq: raw.origin_seq ?? 0,
        });
      } catch (err) {
        console.error("[nats] bad dm payload:", err);
      }
    }
  }

  private async consumeBroadcast(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const raw = JSON.parse(Buffer.from(msg.data).toString("utf-8")) as {
          group?: string;
          from_agent?: string;
          content?: string;
          origin_host?: string;
          origin_ts?: number;
          origin_seq?: number;
        };
        if (!raw.group || !raw.from_agent || !raw.content || !raw.origin_host) {
          console.error("[nats] bad broadcast payload: missing fields");
          continue;
        }
        await this.onBroadcast({
          group: raw.group,
          fromAgent: raw.from_agent,
          content: raw.content,
          originHost: raw.origin_host,
          originTs: raw.origin_ts ?? this.now(),
          originSeq: raw.origin_seq ?? 0,
        });
      } catch (err) {
        console.error("[nats] bad broadcast payload:", err);
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
