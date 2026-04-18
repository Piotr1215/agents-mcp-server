#!/usr/bin/env node
// Claude Code Channels source for agents-mcp-server — the session's main comms
// line. Spawned per-session via `claude --dangerously-load-development-channels
// server:comms`. Forwards remote agent events (channels, DMs, broadcasts) into
// the open Claude session as <channel source="comms" …> notifications.
//
// Identity is bound at runtime via the comms_bind tool — the session calls it
// right after agent_register to declare which agent name and group it
// represents. Routing then flows from that binding: DMs addressed to the bound
// name are pushed; broadcasts on the bound group are pushed; channels are
// public and always pushed. Unbound sessions receive channels only.
//
// AGENTS_NATS_URL is required. AGENTS_CHANNEL_FOR is an optional seed for the
// initial binding, kept for backward compatibility with static setups.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initNatsTransport,
  NatsTransport,
  RemoteBroadcastMessage,
  RemoteChannelMessage,
  RemoteDirectMessage,
} from "./nats.js";

const CHANNEL_METHOD = "notifications/claude/channel";
const SOURCE_NAME = "comms";

// Claude Code restricts meta keys to [A-Za-z0-9_]. Anything else is dropped
// on the other side, which silently loses the attribute. Strip up front so
// the behaviour is predictable.
function sanitizeMetaKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, "_");
}

export interface ChannelNotificationParams {
  content: string;
  meta: Record<string, string>;
  [key: string]: unknown;
}

function metaBuilder(kind: string): { meta: Record<string, string>; add: (k: string, v: string | number | undefined) => void } {
  const meta: Record<string, string> = { kind };
  const add = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === null) return;
    meta[sanitizeMetaKey(k)] = String(v);
  };
  return { meta, add };
}

export function buildChannelNotification(msg: RemoteChannelMessage): ChannelNotificationParams {
  const { meta, add } = metaBuilder("channel");
  add("channel", msg.channel);
  add("from_agent", msg.fromAgent);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  return { content: msg.content, meta };
}

export function buildDmNotification(msg: RemoteDirectMessage): ChannelNotificationParams {
  const { meta, add } = metaBuilder("dm");
  add("from_agent", msg.fromAgent);
  add("to_agent", msg.toAgent);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  return { content: msg.content, meta };
}

export function buildBroadcastNotification(msg: RemoteBroadcastMessage): ChannelNotificationParams {
  const { meta, add } = metaBuilder("broadcast");
  add("from_agent", msg.fromAgent);
  add("group", msg.group);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  return { content: msg.content, meta };
}

// Runtime binding state. Session identity is fluid — an operator may
// /norm-agent one name, then /norm-agent a different one. The comms server
// owns this state and filters inbound events against it.
export interface CommsBinding {
  name: string | null;
  group: string | null;
}

export function shouldDeliverDm(binding: CommsBinding, msg: RemoteDirectMessage): boolean {
  if (!binding.name) return false;
  return msg.toAgent === binding.name;
}

export function shouldDeliverBroadcast(binding: CommsBinding, msg: RemoteBroadcastMessage): boolean {
  if (!binding.group) return false;
  return msg.group === binding.group;
}

async function main(): Promise<void> {
  const natsUrl = process.env.AGENTS_NATS_URL;
  if (!natsUrl) {
    console.error("[comms] AGENTS_NATS_URL is required (cross-host push needs NATS)");
    process.exit(1);
  }

  const binding: CommsBinding = {
    name: process.env.AGENTS_CHANNEL_FOR ?? null,
    group: process.env.AGENTS_CHANNEL_GROUP ?? null,
  };

  const mcp = new McpServer(
    { name: "comms", version: "0.2.0" },
    {
      capabilities: { experimental: { "claude/channel": {} }, tools: {} },
      instructions: `Comms line for cross-host agent events. Inbound messages arrive as <channel source="comms" kind="channel|dm|broadcast" …>body</channel>. Call comms_bind({name, group?}) right after agent_register so DM and broadcast routing knows who this session is — pre-bind, only public channel posts flow through.`,
    }
  );

  // Tool: comms_bind — session declares which agent+group it represents so
  // routing filters can let through DMs and group broadcasts addressed to it.
  mcp.registerTool(
    "comms_bind",
    {
      title: "Bind Session Identity",
      description: "Bind this comms session to an agent identity. Call right after agent_register. Pass group if the agent is in one, so group broadcasts reach this session.",
      inputSchema: {
        name: z.string().describe("Agent name this session represents"),
        group: z.string().optional().describe("Agent group (for broadcast routing)"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ name, group }) => {
      binding.name = name;
      binding.group = group ?? null;
      const payload = { bound: { name: binding.name, group: binding.group } };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    }
  );

  await mcp.connect(new StdioServerTransport());

  const transport: NatsTransport | null = await initNatsTransport({
    url: natsUrl,
    onChannelMessage: async (msg) => {
      try {
        await mcp.server.notification({ method: CHANNEL_METHOD, params: buildChannelNotification(msg) });
      } catch (err) {
        console.error("[comms] channel emit failed:", err instanceof Error ? err.message : err);
      }
    },
    onDirectMessage: async (msg) => {
      if (!shouldDeliverDm(binding, msg)) return;
      try {
        await mcp.server.notification({ method: CHANNEL_METHOD, params: buildDmNotification(msg) });
      } catch (err) {
        console.error("[comms] dm emit failed:", err instanceof Error ? err.message : err);
      }
    },
    onBroadcast: async (msg) => {
      if (!shouldDeliverBroadcast(binding, msg)) return;
      try {
        await mcp.server.notification({ method: CHANNEL_METHOD, params: buildBroadcastNotification(msg) });
      } catch (err) {
        console.error("[comms] broadcast emit failed:", err instanceof Error ? err.message : err);
      }
    },
  });

  if (!transport) {
    console.error("[comms] NATS connect failed — no events will flow");
    process.exit(2);
  }

  const seed = binding.name ? `seed=${binding.name}${binding.group ? `/${binding.group}` : ""}` : "unbound";
  console.error(`[comms] running host=${transport.getHost()} nats=${natsUrl} ${seed}`);

  const shutdown = async () => {
    await transport?.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const isMain = process.argv[1] && process.argv[1].endsWith("comms.js");
if (isMain) {
  main().catch((err) => {
    console.error("[comms] fatal:", err);
    process.exit(1);
  });
}

// Re-export SOURCE_NAME for tests that want to assert on the channel source attribute.
export { SOURCE_NAME };
