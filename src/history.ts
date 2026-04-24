// JetStream-backed message history. Replaces the DuckDB-backed `messages`
// table (#129). JetStream is now the canonical audit store (#123 Phase 1).
//
// Every DM / channel / broadcast publish already lands on NATS subjects
// `agents.dm.<b64>`, `agents.channel.<b64>`, `agents.broadcast.<b64>`. We
// create one JetStream stream that filters those subjects and keep a bounded
// retention window. History reads become ephemeral JetStream consumers — no
// local state, no schema, no migrations, no duckdb CLI on the install host.
import type { NatsConnection } from "nats";

export interface HistoryMessage {
  id: number;
  timestamp: Date;
  type: "DM" | "BROADCAST" | "CHANNEL";
  from_agent: string | null;
  to_agent: string | null;
  channel: string | null;
  content: string;
  origin_host: string;
}

const STREAM_NAME = "agents-history";
const SUBJECT_PREFIX_DM = "agents.dm.";
const SUBJECT_PREFIX_CHANNEL = "agents.channel.";
const SUBJECT_PREFIX_BROADCAST = "agents.broadcast.";
const FILTER_SUBJECTS = [
  `${SUBJECT_PREFIX_DM}>`,
  `${SUBJECT_PREFIX_CHANNEL}>`,
  `${SUBJECT_PREFIX_BROADCAST}>`,
];

// Tunable via env — 30d / 512MiB / 10k per subject are sensible defaults for
// the proving-ground substrate and leave headroom on the 1 GiB JetStream PVC.
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_MSGS_PER_SUBJECT = 10_000;

let nc: NatsConnection | null = null;

export async function init(connection: NatsConnection): Promise<void> {
  nc = connection;
  const jsm = await nc.jetstreamManager();
  const maxAge = Number(process.env.AGENTS_HISTORY_MAX_AGE_MS) || DEFAULT_MAX_AGE_MS;
  const maxBytes = Number(process.env.AGENTS_HISTORY_MAX_BYTES) || DEFAULT_MAX_BYTES;
  const maxMsgsPerSubject = Number(process.env.AGENTS_HISTORY_MAX_MSGS_PER_SUBJECT) || DEFAULT_MAX_MSGS_PER_SUBJECT;
  const config = {
    name: STREAM_NAME,
    subjects: FILTER_SUBJECTS,
    max_age: maxAge * 1_000_000,
    max_bytes: maxBytes,
    max_msgs_per_subject: maxMsgsPerSubject,
  };
  try {
    await jsm.streams.add(config as never);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "STREAM_NAME_IN_USE" || code === "10058" || /already in use/i.test(String(err))) {
      await jsm.streams.update(STREAM_NAME, config as never).catch((updErr) => {
        console.error("[history] stream update failed:", updErr);
      });
    } else {
      throw err;
    }
  }
}

function encode(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

// Open an ephemeral consumer, drain up to `limit` messages matching the given
// subject filter, delete the consumer, return raw-shape messages in ascending
// stream-seq order. Callers project to the tool-specific response shape.
interface RawEnvelope {
  stream_seq: number;
  subject: string;
  origin_ts_ms: number;
  payload: {
    channel?: string;
    group?: string;
    to_agent?: string;
    from_agent?: string;
    content?: string;
    origin_host?: string;
    origin_ts?: number;
    origin_seq?: number;
  };
}

async function drain(filterSubjects: string[], limit: number, minSeq?: number): Promise<RawEnvelope[]> {
  if (!nc) throw new Error("history: init() not called");
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();

  const consumerConfig: Record<string, unknown> = {
    ack_policy: "none",
    inactive_threshold: 30_000_000_000,
    max_deliver: 1,
  };
  if (filterSubjects.length === 1) {
    consumerConfig.filter_subject = filterSubjects[0];
  } else if (filterSubjects.length > 1) {
    consumerConfig.filter_subjects = filterSubjects;
  }
  if (minSeq && minSeq > 0) {
    consumerConfig.deliver_policy = "by_start_sequence";
    consumerConfig.opt_start_seq = minSeq + 1;
  } else {
    consumerConfig.deliver_policy = "all";
  }

  const info = await jsm.consumers.add(STREAM_NAME, consumerConfig as never);
  const consumerName = info.name;
  const out: RawEnvelope[] = [];
  try {
    const consumer = await js.consumers.get(STREAM_NAME, consumerName);
    // nats.js rejects expires < 1000ms. Keep this tight enough that history
    // queries don't stall on empty streams, but above the client's floor.
    const iter = await consumer.fetch({ max_messages: limit, expires: 1000 });
    for await (const m of iter) {
      try {
        const payload = JSON.parse(Buffer.from(m.data).toString("utf-8"));
        out.push({
          stream_seq: Number(m.info.streamSequence),
          subject: m.subject,
          origin_ts_ms: payload.origin_ts ?? Date.now(),
          payload,
        });
      } catch (err) {
        console.error("[history] bad message payload, skipping:", err);
      }
    }
  } finally {
    await jsm.consumers.delete(STREAM_NAME, consumerName).catch(() => { /* best effort */ });
  }
  out.sort((a, b) => a.stream_seq - b.stream_seq);
  return out;
}

function classify(subject: string): "DM" | "CHANNEL" | "BROADCAST" {
  if (subject.startsWith(SUBJECT_PREFIX_DM)) return "DM";
  if (subject.startsWith(SUBJECT_PREFIX_BROADCAST)) return "BROADCAST";
  return "CHANNEL";
}

function toHistoryMessage(env: RawEnvelope): HistoryMessage {
  const type = classify(env.subject);
  const p = env.payload;
  return {
    id: env.stream_seq,
    timestamp: new Date(env.origin_ts_ms),
    type,
    from_agent: p.from_agent ?? null,
    to_agent: p.to_agent ?? null,
    channel: type === "CHANNEL" ? (p.channel ?? null) : (type === "BROADCAST" ? (p.group ?? null) : null),
    content: p.content ?? "",
    origin_host: p.origin_host ?? "",
  };
}

export async function getChannelHistory(channel: string, limit = 50): Promise<HistoryMessage[]> {
  const envs = await drain([`${SUBJECT_PREFIX_CHANNEL}${encode(channel)}`], limit);
  return envs.map(toHistoryMessage);
}

export async function getGroupHistory(group: string, limit = 50): Promise<HistoryMessage[]> {
  const envs = await drain([`${SUBJECT_PREFIX_BROADCAST}${encode(group)}`], limit);
  return envs.map(toHistoryMessage);
}

// DMs are keyed by recipient subject. A conversation between A and B lives on
// two subjects (`dm.<b64(A)>` and `dm.<b64(B)>`), so we drain both and filter
// for messages where the other party is the counterparty.
export async function getDmHistory(agent1: string, agent2: string, limit = 50): Promise<HistoryMessage[]> {
  const envs = await drain(
    [`${SUBJECT_PREFIX_DM}${encode(agent1)}`, `${SUBJECT_PREFIX_DM}${encode(agent2)}`],
    limit * 2,
  );
  const filtered = envs.filter((e) => {
    const f = e.payload.from_agent;
    const t = e.payload.to_agent;
    return (f === agent1 && t === agent2) || (f === agent2 && t === agent1);
  });
  return filtered.slice(-limit).map(toHistoryMessage);
}

export async function getMessagesSince(sinceId: number, limit = 100): Promise<HistoryMessage[]> {
  const envs = await drain(FILTER_SUBJECTS, limit, sinceId);
  return envs.map(toHistoryMessage);
}

// Messages for a given agent: DMs addressed to them, and broadcasts to their
// group. Drains both subject filters and merges by stream sequence.
export async function getMessagesForAgent(
  agentName: string,
  groupName: string,
  sinceId: number,
  limit = 50,
): Promise<HistoryMessage[]> {
  const envs = await drain(
    [`${SUBJECT_PREFIX_DM}${encode(agentName)}`, `${SUBJECT_PREFIX_BROADCAST}${encode(groupName)}`],
    limit * 2,
    sinceId,
  );
  const filtered = envs.filter((e) => {
    if (e.subject.startsWith(SUBJECT_PREFIX_DM)) {
      return e.payload.to_agent === agentName && e.payload.from_agent !== agentName;
    }
    return e.payload.from_agent !== agentName;
  });
  return filtered.slice(0, limit).map(toHistoryMessage);
}

// List channels with their message counts. JetStream exposes per-subject
// totals via the stream info; decode our base64url subjects back to the
// user-facing channel name.
export async function getChannels(): Promise<Array<{ channel: string; message_count: number }>> {
  if (!nc) throw new Error("history: init() not called");
  const jsm = await nc.jetstreamManager();
  const info = await jsm.streams.info(STREAM_NAME, {
    subjects_filter: `${SUBJECT_PREFIX_CHANNEL}>`,
  } as never);
  const subjects = (info.state as { subjects?: Record<string, number> }).subjects ?? {};
  const out: Array<{ channel: string; message_count: number }> = [];
  for (const [subject, count] of Object.entries(subjects)) {
    const encoded = subject.slice(SUBJECT_PREFIX_CHANNEL.length);
    let decoded = encoded;
    try {
      decoded = Buffer.from(encoded, "base64url").toString("utf-8");
    } catch { /* fall back to raw */ }
    out.push({ channel: decoded, message_count: count });
  }
  out.sort((a, b) => a.channel.localeCompare(b.channel));
  return out;
}
