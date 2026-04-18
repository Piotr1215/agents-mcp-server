#!/usr/bin/env node
// Claude Code Channels source for agents-mcp-server.
//
// Spawned per-session via `claude --dangerously-load-development-channels
// server:agents-channel`. Subscribes to the NATS agents.channel.* wildcard
// and forwards remote channel messages into the open Claude session as
// <channel> notifications, bypassing the need for polling.
//
// Session identity is carried in AGENTS_CHANNEL_FOR — the agent name this
// session represents. AGENTS_NATS_URL gates NATS connectivity. Both are
// required; the server exits loudly if either is missing.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initNatsTransport, NatsTransport, RemoteChannelMessage, RemoteDirectMessage } from "./nats.js";

const CHANNEL_METHOD = "notifications/claude/channel";

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

export function buildChannelNotification(msg: RemoteChannelMessage): ChannelNotificationParams {
  const meta: Record<string, string> = { kind: "channel" };
  const add = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === null) return;
    meta[sanitizeMetaKey(k)] = String(v);
  };
  add("channel", msg.channel);
  add("from_agent", msg.fromAgent);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  return { content: msg.content, meta };
}

export function buildDmNotification(msg: RemoteDirectMessage): ChannelNotificationParams {
  const meta: Record<string, string> = { kind: "dm" };
  const add = (k: string, v: string | number | undefined) => {
    if (v === undefined || v === null) return;
    meta[sanitizeMetaKey(k)] = String(v);
  };
  add("from_agent", msg.fromAgent);
  add("to_agent", msg.toAgent);
  add("origin_host", msg.originHost);
  add("origin_ts", msg.originTs);
  return { content: msg.content, meta };
}

async function main(): Promise<void> {
  const agentName = process.env.AGENTS_CHANNEL_FOR;
  const natsUrl = process.env.AGENTS_NATS_URL;

  if (!agentName) {
    console.error("[channel] AGENTS_CHANNEL_FOR is required (agent name this session represents)");
    process.exit(1);
  }
  if (!natsUrl) {
    console.error("[channel] AGENTS_NATS_URL is required (cross-host push needs NATS)");
    process.exit(1);
  }

  const mcp = new McpServer(
    { name: "agents-channel", version: "0.1.0" },
    {
      capabilities: { experimental: { "claude/channel": {} } },
      instructions: `Real-time cross-host agent events for ${agentName}. Inbound messages arrive as <channel source="agents-channel" channel="..." from_agent="..." origin_host="..." origin_ts="...">body</channel>. React if relevant, ignore otherwise.`,
    }
  );

  await mcp.connect(new StdioServerTransport());

  let transport: NatsTransport | null = null;
  transport = await initNatsTransport({
    url: natsUrl,
    onChannelMessage: async (msg: RemoteChannelMessage) => {
      try {
        const params = buildChannelNotification(msg);
        await mcp.server.notification({ method: CHANNEL_METHOD, params });
      } catch (err) {
        console.error("[channel] emit failed:", err instanceof Error ? err.message : err);
      }
    },
    onDirectMessage: async (msg: RemoteDirectMessage) => {
      // DMs are private — only push if the message is addressed to the agent
      // this session represents. Without this filter every host's session
      // would see every host's DMs.
      if (msg.toAgent !== agentName) return;
      try {
        const params = buildDmNotification(msg);
        await mcp.server.notification({ method: CHANNEL_METHOD, params });
      } catch (err) {
        console.error("[channel] dm emit failed:", err instanceof Error ? err.message : err);
      }
    },
  });

  if (!transport) {
    console.error("[channel] NATS connect failed — no events will flow");
    process.exit(2);
  }

  console.error(`[channel] running for agent=${agentName} host=${transport.getHost()} nats=${natsUrl}`);

  const shutdown = async () => {
    await transport?.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only run main() when invoked as a script, not when imported by tests.
const isMain = process.argv[1] && process.argv[1].endsWith("channel.js");
if (isMain) {
  main().catch((err) => {
    console.error("[channel] fatal:", err);
    process.exit(1);
  });
}
