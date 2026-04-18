// Formatters for Claude Code Channel notifications.
//
// Each remote event type (channel post, DM, broadcast) becomes a
// <channel source="agents" kind="…" …>body</channel> tag in the session.
// Meta attributes carry routing data; body carries the human-readable
// content. Since Claude Code's preview line hides meta, we prepend a
// compact "<from>" prefix into the body so the sender is visible at a
// glance without expanding the tag.
import type {
  RemoteBroadcastMessage,
  RemoteChannelMessage,
  RemoteDirectMessage,
} from "./nats.js";

const CHANNEL_METHOD = "notifications/claude/channel" as const;

// Claude Code restricts meta keys to [A-Za-z0-9_]. Anything else is dropped
// silently on the other side.
function sanitizeMetaKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, "_");
}

export interface ChannelNotificationParams {
  content: string;
  meta: Record<string, string>;
  [key: string]: unknown;
}

function metaBuilder(kind: string): {
  meta: Record<string, string>;
  add: (k: string, v: string | number | undefined) => void;
} {
  const meta: Record<string, string> = { kind };
  const add = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === null) return;
    meta[sanitizeMetaKey(k)] = String(v);
  };
  return { meta, add };
}

// Compose body prefix so the renderer's one-line preview carries
// kind + sender + compact timestamp — the three things meta attributes hide.
// Shape: "<kind> HH:MM:SS [from@host] content"
// Collapses an already-present "[HUMAN]" prefix from the wrapper so it is not
// duplicated with the server-added "[from@host]".
function withSenderPrefix(
  kind: "dm" | "bcast" | "ch",
  fromAgent: string,
  originHost: string,
  originTs: number,
  content: string,
  localHost: string,
): string {
  const sender = originHost === localHost ? `[${fromAgent}]` : `[${fromAgent}@${originHost}]`;
  const hhmmss = new Date(originTs).toISOString().slice(11, 19);
  // If the wrapper already prepended "[HUMAN] ", strip it — `from_agent` and
  // `host` already carry that signal.
  const stripped = content.replace(/^\[HUMAN\]\s*/, "");
  return `<${kind}> ${hhmmss} ${sender} ${stripped}`;
}

export function buildChannelNotification(msg: RemoteChannelMessage, localHost: string): ChannelNotificationParams {
  const { meta, add } = metaBuilder("channel");
  add("channel", msg.channel);
  add("from_agent", msg.fromAgent);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  add("origin_seq", msg.originSeq);
  return {
    content: withSenderPrefix("ch", msg.fromAgent, msg.originHost, msg.originTs, msg.content, localHost),
    meta,
  };
}

export function buildDmNotification(msg: RemoteDirectMessage, localHost: string): ChannelNotificationParams {
  const { meta, add } = metaBuilder("dm");
  add("from_agent", msg.fromAgent);
  add("to_agent", msg.toAgent);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  add("origin_seq", msg.originSeq);
  return {
    content: withSenderPrefix("dm", msg.fromAgent, msg.originHost, msg.originTs, msg.content, localHost),
    meta,
  };
}

export function buildBroadcastNotification(msg: RemoteBroadcastMessage, localHost: string): ChannelNotificationParams {
  const { meta, add } = metaBuilder("broadcast");
  add("from_agent", msg.fromAgent);
  add("group", msg.group);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  add("origin_seq", msg.originSeq);
  return {
    content: withSenderPrefix("bcast", msg.fromAgent, msg.originHost, msg.originTs, msg.content, localHost),
    meta,
  };
}

export { CHANNEL_METHOD };
