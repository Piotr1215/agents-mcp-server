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

// Compose "[<from>@<host>] <content>" so the renderer's body preview shows
// the sender even when meta attributes are hidden. Skip host when the event
// originated locally.
function withSenderPrefix(fromAgent: string, originHost: string, content: string, localHost: string): string {
  const prefix = originHost === localHost ? `[${fromAgent}]` : `[${fromAgent}@${originHost}]`;
  return `${prefix} ${content}`;
}

export function buildChannelNotification(msg: RemoteChannelMessage, localHost: string): ChannelNotificationParams {
  const { meta, add } = metaBuilder("channel");
  add("channel", msg.channel);
  add("from_agent", msg.fromAgent);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  return {
    content: withSenderPrefix(msg.fromAgent, msg.originHost, msg.content, localHost),
    meta,
  };
}

export function buildDmNotification(msg: RemoteDirectMessage, localHost: string): ChannelNotificationParams {
  const { meta, add } = metaBuilder("dm");
  add("from_agent", msg.fromAgent);
  add("to_agent", msg.toAgent);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  return {
    content: withSenderPrefix(msg.fromAgent, msg.originHost, msg.content, localHost),
    meta,
  };
}

export function buildBroadcastNotification(msg: RemoteBroadcastMessage, localHost: string): ChannelNotificationParams {
  const { meta, add } = metaBuilder("broadcast");
  add("from_agent", msg.fromAgent);
  add("group", msg.group);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  return {
    content: withSenderPrefix(msg.fromAgent, msg.originHost, msg.content, localHost),
    meta,
  };
}

export { CHANNEL_METHOD };
