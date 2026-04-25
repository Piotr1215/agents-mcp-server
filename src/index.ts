#!/usr/bin/env node
// PROJECT: claude-automation, agent-lifecycle, agents-mcp-homelab-deploy
// Issue: https://github.com/Piotr1215/claude/issues/42 (lineage), #129 (DuckDB drop)
//
// Agent communication over NATS. Two modes, picked at boot via AGENTS_TRANSPORT:
//
//   stdio (default) — one MCP process per user, spawned by Claude Code.
//                     `agent_register` binds the process's identity.
//
//   http            — single shared process fronted by streamable HTTP. Each
//                     engineer's Claude Code negotiates its own session; each
//                     session holds its own binding, its own McpServer, and
//                     its own connected NATS-driven notification fan-in. Used
//                     by the homelab + loft.rocks deployments.
//
// All persistence lives on NATS: presence on `agents.presence`, and the
// `agents-history` JetStream stream captures every DM/channel/broadcast for
// history reads (#123 Phase 1 — JetStream-only audit store). No DuckDB.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import { appendFileSync } from "fs";
import * as registry from "./registry.js";
import * as history from "./history.js";
import { initNatsTransport, NatsTransport } from "./nats.js";
import {
  buildChannelNotification,
  buildDmNotification,
  buildBroadcastNotification,
  CHANNEL_METHOD,
} from "./notifications.js";
import {
  validateMessageBody,
  validateDmTarget,
  dmTargetIsReachable,
  broadcastGroupIsReachable,
} from "./validation.js";
import * as metrics from "./metrics.js";

const SERVER_NAME = "agents";
const SERVER_VERSION = "5.2.0";
const DEFAULT_NATS_URL = "nats://nats.nats.svc:4222";
const LOG_FILE = process.env.AGENTS_LOG_FILE || "";

let natsTransport: NatsTransport | null = null;

interface SessionBinding { name: string; group: string; agentId: string; }

interface Session {
  id: string;
  server: McpServer;
  transport: StdioServerTransport | StreamableHTTPServerTransport;
  getBinding: () => SessionBinding | null;
  setBinding: (b: SessionBinding | null) => void;
  lastActivity: number;
  createdAt: number;
}

const sessions = new Map<string, Session>();

// Tunables for HTTP-mode session housekeeping. Defaults err on the side of
// dropping unbound sessions quickly (clients that initialize but never call
// agent_register are almost always dead reconnects) while leaving bound
// sessions alone — those carry live agent identity and must not be reaped
// just for being quiet. PUSH_TIMEOUT_MS guards against a single dead SSE
// stalling fan-out to every other bound session.
const UNBOUND_SESSION_TIMEOUT_MS = Number(process.env.AGENTS_UNBOUND_TIMEOUT_MS) || 60_000;
const SESSION_SWEEP_INTERVAL_MS = Number(process.env.AGENTS_SWEEP_INTERVAL_MS) || 30_000;
const PUSH_TIMEOUT_MS = Number(process.env.AGENTS_PUSH_TIMEOUT_MS) || 1_000;

function logToFile(type: string, content: string): void {
  if (!LOG_FILE) return;
  try {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    appendFileSync(LOG_FILE, `[${ts}] [${type}] ${content}\n`);
  } catch { /* best-effort */ }
}

// Wrap a handler so every response carries `_meta` with chars/lines/ms.
// Per-tool telemetry now flows out via the prom-client `agents_tool_calls_total`
// counter — replaces the DuckDB-backed tool_metrics table dropped in #129.
// Errors thrown by `fn` are caught, recorded as status="err", then re-thrown
// so the MCP layer still surfaces the failure to the caller.
async function withMeta(
  toolName: string,
  fn: () => Promise<string>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const startTime = Date.now();
  let result: string;
  try {
    result = await fn();
  } catch (err) {
    metrics.toolCallsCounter.inc({ tool: toolName, status: "err" });
    throw err;
  }
  const durationMs = Date.now() - startTime;
  const status = result.startsWith("Error:") ? "err" : "ok";
  metrics.toolCallsCounter.inc({ tool: toolName, status });
  const responseChars = result.length;
  const responseLines = result.split("\n").length;
  const meta = { chars: responseChars, lines: responseLines, ms: durationMs };
  const finalResult = result.startsWith("{")
    ? JSON.stringify({ ...JSON.parse(result), _meta: meta })
    : `${result}\n---\n_meta: ${JSON.stringify(meta)}`;
  return { content: [{ type: "text", text: finalResult }] };
}

function createMcpServer(session: { getBinding: () => SessionBinding | null; setBinding: (b: SessionBinding | null) => void }): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        experimental: { "claude/channel": {} },
      },
      instructions: "Multi-agent coordination server with live session push. agent_register(name, description, group) both joins and binds this session — from that moment on, DMs to this name and broadcasts to this group push in as <channel source=\"agents\" kind=\"dm|broadcast|channel\">body</channel> tags. Use agent_broadcast, agent_dm, channel_send for outbound. Use *_history tools for catch-up reads. Deregister on shutdown.",
    },
  );

  server.registerTool(
    "agent_register",
    {
      title: "Join Conversation",
      description: "Register as an agent. Returns agent_id and list of active peers in your group.",
      inputSchema: {
        name: z.string().describe("Agent name"),
        description: z.string().describe("What this agent does"),
        group: z.string().optional().default("default").describe("Agent group (default: 'default')"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ name, group }) => withMeta("agent_register", async () => {
      const groupName = group || "default";
      const host = natsTransport?.getHost() ?? "local";
      const agentId = registry.generateAgentId(name, host);

      // Evict any other session that previously bound this name. Without
      // this, a stale session left over from a /mcp reconnect (or a crashed
      // client whose transport.onclose never fired) keeps a dead binding
      // for the same name. pushToSessions then fans out notifications to
      // both — the live session and the dead transport — and the dead one
      // can stall the await chain. One name, one bound session.
      for (const s of sessions.values()) {
        if (s.setBinding === session.setBinding) continue;
        const b = s.getBinding();
        if (b && b.name === name) {
          s.setBinding(null);
          registry.deregisterAgent(b.agentId);
          if (natsTransport) natsTransport.untrackLocal(b.agentId);
        }
      }

      registry.registerAgent(agentId, name, groupName);

      const peers = registry
        .getAgents(groupName)
        .filter((a) => a.name !== name)
        .map((a) => ({ name: a.name, group: a.group_name }));

      session.setBinding({ name, group: groupName, agentId });

      if (natsTransport) {
        const localAgent = { agent_id: agentId, name, group: groupName };
        natsTransport.trackLocal(localAgent);
        await natsTransport.publishBeat(localAgent);
      }

      return JSON.stringify({
        agent_id: agentId,
        group: groupName,
        peers,
        message: "Registered. Use your name for subsequent calls.",
      });
    }),
  );

  server.registerTool(
    "agent_deregister",
    {
      title: "Leave Conversation",
      description: "Deregister an agent when shutting down.",
      inputSchema: { name: z.string().describe("Your agent name") },
      annotations: { destructiveHint: true },
    },
    async ({ name }) => withMeta("agent_deregister", async () => {
      const agent = registry.getAgentByName(name);
      if (!agent) {
        return JSON.stringify({ success: true, name, message: "was already gone or never registered" });
      }
      registry.deregisterAgent(agent.id);
      if (natsTransport) natsTransport.untrackLocal(agent.id);
      const binding = session.getBinding();
      if (binding && binding.agentId === agent.id) session.setBinding(null);
      return JSON.stringify({
        success: true,
        id: agent.id,
        name: agent.name,
        group_name: agent.group_name,
        message: `Deregistered ${name}`,
      });
    }),
  );

  server.registerTool(
    "agent_broadcast",
    {
      title: "Broadcast Message",
      description: "Send a message to ALL other agents.",
      inputSchema: {
        name: z.string().describe("Your agent name"),
        message: z.string().describe("Message content"),
        priority: z.enum(["low", "normal", "high"]).optional().default("normal").describe("Message priority"),
        group: z.string().optional().describe("Target group (omit for all agents)"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ name, message, group }) => withMeta("agent_broadcast", async () => {
      const sender = registry.getAgentByName(name);
      if (!sender) return `Error: You (${name}) not registered. Call agent_register first.`;
      const bodyErr = validateMessageBody(message);
      if (bodyErr) return `Error: broadcast ${bodyErr}.`;
      if (!natsTransport) return `Error: NATS transport not configured — broadcasts require AGENTS_NATS_URL.`;

      const targetGroup = group === "all" ? null : (group || sender.group_name);
      if (!targetGroup) return `Error: broadcast requires a target group.`;

      const groupReachable = await broadcastGroupIsReachable(targetGroup, {
        localMemberCount: (g) => registry.getAgents(g).length,
        remoteMemberCount: (g) => natsTransport!.getRemotePeers(g).length,
      });
      if (!groupReachable) return `Error: group '${targetGroup}' has no registered agents. Use agent_groups to see active groups.`;

      logToFile("BROADCAST", `${name} -> ${targetGroup}: ${message}`);
      natsTransport.publishBroadcast(targetGroup, name, message);
      metrics.messagesCounter.inc({ type: "broadcast" });
      return `Broadcast published to group '${targetGroup}' over NATS. Sessions bound to that group receive it as <channel kind="broadcast">.`;
    }),
  );

  server.registerTool(
    "agent_dm",
    {
      title: "Direct Message",
      description: "Send a direct message to a specific agent.",
      inputSchema: {
        name: z.string().describe("Your agent name"),
        to: z.string().describe("Target agent name"),
        message: z.string().describe("Message content"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ name, to, message }) => withMeta("agent_dm", async () => {
      const sender = registry.getAgentByName(name);
      if (!sender) return `Error: You (${name}) not registered. Call agent_register first.`;
      if (!natsTransport) return `Error: NATS transport not configured — DMs require AGENTS_NATS_URL.`;

      const bodyErr = validateMessageBody(message);
      if (bodyErr) return `Error: DM ${bodyErr}.`;
      const selfErr = validateDmTarget(name, to);
      if (selfErr) return `Error: ${selfErr}.`;

      const reachable = await dmTargetIsReachable(to, {
        hasLocalAgent: () => !!registry.getAgentByName(to),
        hasRemotePeer: (n) => natsTransport!.getRemotePeers().some((p) => p.name === n),
      });
      if (!reachable) return `Error: agent '${to}' not registered. Use agent_discover to see active agents.`;

      logToFile("DM", `${name} -> ${to}: ${message}`);
      natsTransport.publishDirectMessage(to, name, message);
      metrics.messagesCounter.inc({ type: "dm" });
      return `DM published to '${to}' over NATS. Live delivery happens when the recipient session is registered (agent_register auto-binds); otherwise the message stays in dm_history for catch-up.`;
    }),
  );

  server.registerTool(
    "agent_discover",
    {
      title: "Find Peers",
      description: "Discover all active agents.",
      inputSchema: {
        include_stale: z.boolean().optional().default(false).describe("Include agents not seen in last 5 minutes"),
        group: z.string().optional().describe("Filter by group (omit for all)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ group }) => withMeta("agent_discover", async () => {
      const agents = registry.getAgents(group || undefined);
      if (agents.length === 0) {
        return group ? `No agents in group '${group}'` : "No agents currently registered.";
      }
      const localHost = natsTransport ? natsTransport.getHost() : "local";
      const lines = agents.map((a) => {
        const isLocal = !!registry.getAgent(a.id);
        const host = isLocal ? localHost : "remote";
        return `- ${a.name} (${a.id}): active | group: ${a.group_name} | host: ${host}${isLocal ? " | local" : ""}`;
      });
      const groupInfo = group ? ` in group '${group}'` : "";
      return `Active agents (${lines.length})${groupInfo}:\n${lines.join("\n")}`;
    }),
  );

  server.registerTool(
    "agent_groups",
    {
      title: "List Groups",
      description: "List all active agent groups.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => withMeta("agent_groups", async () => {
      const groups = registry.getGroups();
      if (groups.length === 0) return "No agents registered.";
      const lines = groups.map((g) => `- ${g.group_name} (${g.count} agent${g.count > 1 ? "s" : ""})`);
      return `Active groups (${groups.length}):\n${lines.join("\n")}`;
    }),
  );

  server.registerTool(
    "channel_send",
    {
      title: "Post to Channel",
      description: "Log a message to a channel (async bulletin board). Does NOT nudge agents — use agent_dm or agent_broadcast for real-time delivery. Agents read channels via channel_history.",
      inputSchema: {
        name: z.string().describe("Your agent name"),
        channel: z.string().describe("Channel name"),
        message: z.string().describe("Message content"),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ name, channel, message }) => withMeta("channel_send", async () => {
      if (!natsTransport) return `Error: NATS transport not configured — channels require AGENTS_NATS_URL.`;
      logToFile("CHANNEL", `#${channel} ${name}: ${message}`);
      natsTransport.publishChannelMessage(channel, name, message);
      metrics.messagesCounter.inc({ type: "channel" });
      return `Message logged to #${channel}`;
    }),
  );

  server.registerTool(
    "channel_history",
    {
      title: "Read Channel",
      description: "Get recent messages from a channel.",
      inputSchema: {
        channel: z.string().describe("Channel name"),
        limit: z.number().optional().default(50).describe("Max messages to return (default: 50)"),
        detailed: z.boolean().optional().default(false).describe("Include full metadata (default: false, compact mode)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ channel, limit, detailed }) => withMeta("channel_history", async () => {
      const messages = await history.getChannelHistory(channel, limit);
      if (messages.length === 0) return `No messages in #${channel}`;
      if (detailed) {
        return JSON.stringify({
          channel,
          count: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            timestamp: m.timestamp,
            from: m.from_agent,
            content: m.content,
          })),
        });
      }
      const lines = messages.map((m) => {
        const ts = new Date(m.timestamp).toLocaleTimeString();
        const from = m.from_agent?.split("-")[0] || "unknown";
        return `[${ts}] ${from}: ${m.content}`;
      });
      return `#${channel} history (${messages.length}):\n${lines.join("\n")}`;
    }),
  );

  server.registerTool(
    "dm_history",
    {
      title: "Catch Up on DMs",
      description: "Get DM history between you and another agent.",
      inputSchema: {
        name: z.string().describe("Your agent name"),
        with_agent: z.string().describe("The other agent's name"),
        limit: z.number().optional().default(50).describe("Max messages to return (default: 50)"),
        detailed: z.boolean().optional().default(false).describe("Include full metadata (default: false, compact mode)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, with_agent, limit, detailed }) => withMeta("dm_history", async () => {
      const messages = await history.getDmHistory(name, with_agent, limit);
      if (messages.length === 0) return `No DM history with ${with_agent}`;
      if (detailed) {
        return JSON.stringify({
          with_agent,
          count: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            timestamp: m.timestamp,
            from: m.from_agent,
            to: m.to_agent,
            content: m.content,
          })),
        });
      }
      const lines = messages.map((m) => {
        const ts = new Date(m.timestamp).toLocaleTimeString();
        const from = m.from_agent?.split("-")[0] || "unknown";
        return `[${ts}] ${from}: ${m.content}`;
      });
      return `DM history with ${with_agent} (${messages.length}):\n${lines.join("\n")}`;
    }),
  );

  server.registerTool(
    "channel_list",
    {
      title: "List Channels",
      description: "List all channels with message counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => withMeta("channel_list", async () => {
      const channels = await history.getChannels();
      if (channels.length === 0) return "No channels with messages yet.";
      const lines = channels.map((c) => `- #${c.channel} (${c.message_count} messages)`);
      return `Active channels (${channels.length}):\n${lines.join("\n")}`;
    }),
  );

  server.registerTool(
    "group_history",
    {
      title: "Read Group History",
      description: "Get recent broadcast messages for a group.",
      inputSchema: {
        group: z.string().describe("Group name"),
        limit: z.number().optional().default(50).describe("Max messages to return (default: 50)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ group, limit }) => withMeta("group_history", async () => {
      const messages = await history.getGroupHistory(group, limit);
      if (messages.length === 0) return `No history for group '${group}'`;
      const lines = messages.map((m) => {
        const ts = new Date(m.timestamp).toLocaleTimeString();
        const from = m.from_agent?.split("-")[0] || "system";
        return `[${ts}] ${from}: ${m.content}`;
      });
      return `Group '${group}' history (${messages.length}):\n${lines.join("\n")}`;
    }),
  );

  server.registerTool(
    "messages_since",
    {
      title: "Poll Messages",
      description: "Poll for new messages since a given ID (for TUI).",
      inputSchema: {
        since_id: z.number().optional().default(0).describe("Return messages after this ID (0 for all)"),
        limit: z.number().optional().default(100).describe("Max messages to return (default: 100)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ since_id, limit }) => withMeta("messages_since", async () => {
      const messages = await history.getMessagesSince(since_id || 0, limit);
      if (messages.length === 0) return JSON.stringify({ messages: [], last_id: since_id || 0 });
      const lastId = messages[messages.length - 1].id;
      return JSON.stringify({ messages, last_id: lastId });
    }),
  );

  server.registerTool(
    "poll_messages",
    {
      title: "Poll My Messages",
      description: "Poll for new DMs and broadcasts since last check. Returns messages addressed to you. Use from a CronCreate loop.",
      inputSchema: {
        name: z.string().describe("Your agent name"),
        since_id: z.number().optional().default(0).describe("Last seen message ID (0 for first poll)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, since_id }) => withMeta("poll_messages", async () => {
      const agent = registry.getAgentByName(name);
      if (!agent) return `Error: Agent '${name}' not registered. Call agent_register first.`;
      const messages = await history.getMessagesForAgent(name, agent.group_name, since_id || 0);
      if (messages.length === 0) return JSON.stringify({ messages: [], last_id: since_id || 0 });
      const lastId = messages[messages.length - 1].id;
      const formatted = messages.map((m) => ({
        id: m.id,
        type: m.type,
        from: m.from_agent?.split("-")[0] || "unknown",
        content: m.content,
      }));
      return JSON.stringify({ messages: formatted, last_id: lastId });
    }),
  );

  return server;
}

// Push one notification with a hard timeout so a single hung transport (a
// closed SSE whose client never sent DELETE /mcp) cannot stall the fan-out
// to every other bound session — the bug that caused snd → bound-session
// delivery to silently fail in 5.0.0.
async function pushOne(session: Session, params: Record<string, unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("push timeout")), PUSH_TIMEOUT_MS);
  });
  const stopTimer = metrics.pushDurationHistogram.startTimer();
  try {
    await Promise.race([
      session.server.server.notification({ method: CHANNEL_METHOD, params }),
      timeout,
    ]);
    stopTimer();
  } catch (err) {
    stopTimer();
    const kind = err instanceof Error && err.message === "push timeout" ? "timeout" : "other";
    metrics.pushErrorsCounter.inc({ kind });
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Fan incoming NATS messages out to every bound session whose binding matches
// the target. Own-sends are suppressed at the binding layer: the sender's
// session sees the tool response, not an echoed <channel> tag. Pushes run in
// parallel — serial await behind a dead transport was the stall.
async function pushToSessions(
  kind: "channel" | "dm" | "broadcast",
  msg: { fromAgent: string; originHost: string; channel?: string; toAgent?: string; group?: string; content: string; originTs: number; originSeq: number },
): Promise<void> {
  if (!natsTransport) return;
  const senderHost = natsTransport.getHost();
  const tasks: Promise<void>[] = [];
  for (const session of sessions.values()) {
    const binding = session.getBinding();
    if (!binding) continue;
    const isSelf = msg.fromAgent === binding.name || msg.fromAgent === binding.agentId;
    if (isSelf) continue;
    let params: unknown | null = null;
    if (kind === "channel") {
      params = buildChannelNotification({
        channel: msg.channel!,
        fromAgent: msg.fromAgent,
        content: msg.content,
        originHost: msg.originHost,
        originTs: msg.originTs,
        originSeq: msg.originSeq,
      }, senderHost);
    } else if (kind === "dm") {
      if (msg.toAgent !== binding.name) continue;
      params = buildDmNotification({
        toAgent: msg.toAgent!,
        fromAgent: msg.fromAgent,
        content: msg.content,
        originHost: msg.originHost,
        originTs: msg.originTs,
        originSeq: msg.originSeq,
      }, senderHost);
    } else {
      if (msg.group !== binding.group) continue;
      params = buildBroadcastNotification({
        group: msg.group!,
        fromAgent: msg.fromAgent,
        content: msg.content,
        originHost: msg.originHost,
        originTs: msg.originTs,
        originSeq: msg.originSeq,
      }, senderHost);
    }
    tasks.push(
      pushOne(session, params as Record<string, unknown>).catch((err) => {
        console.error("[push] notification failed:", err instanceof Error ? err.message : err);
      }),
    );
  }
  await Promise.all(tasks);
}

async function initInfra(): Promise<void> {
  const natsUrl = process.env.AGENTS_NATS_URL || DEFAULT_NATS_URL;
  natsTransport = await initNatsTransport({
    url: natsUrl,
    onChannelMessage: async (msg) => {
      logToFile("CHANNEL", `#${msg.channel} ${msg.fromAgent}@${msg.originHost}: ${msg.content}`);
      await pushToSessions("channel", msg);
    },
    onDirectMessage: async (msg) => {
      logToFile("DM", `${msg.fromAgent}@${msg.originHost} -> ${msg.toAgent}: ${msg.content}`);
      await pushToSessions("dm", msg);
    },
    onBroadcast: async (msg) => {
      logToFile("BROADCAST", `${msg.fromAgent}@${msg.originHost} -> ${msg.group}: ${msg.content}`);
      await pushToSessions("broadcast", msg);
    },
  });
  if (!natsTransport) {
    throw new Error(`Failed to connect to NATS at ${natsUrl}. Set AGENTS_NATS_URL or ensure the default is reachable.`);
  }
  registry.setPresenceSource(natsTransport);
  const nc = natsTransport.getConnection();
  if (!nc) throw new Error("NATS connection unavailable after init");
  await history.init(nc);
}

async function startStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  let binding: SessionBinding | null = null;
  const getBinding = () => binding;
  const setBinding = (b: SessionBinding | null) => { binding = b; };
  const session: Session = {
    id: "stdio",
    server: createMcpServer({ getBinding, setBinding }),
    transport,
    getBinding,
    setBinding,
    lastActivity: Date.now(),
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  await session.server.connect(transport);
  console.error(`agents MCP v${SERVER_VERSION} (stdio + NATS@${natsTransport?.getHost()}) running`);
}

async function startHttp(): Promise<void> {
  const port = Number(process.env.AGENTS_HTTP_PORT) || 3000;
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: SERVER_VERSION, sessions: sessions.size }));
        return;
      }
      if (req.method === "GET" && req.url === "/metrics" && metrics.isEnabled()) {
        const out = await metrics.renderMetrics();
        res.writeHead(200, { "Content-Type": out.contentType });
        res.end(out.body);
        return;
      }
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      const body = await readBody(req);
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session && body && isInitializeRequest(body)) {
        session = await createHttpSession();
      }
      if (!session) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session ID; initialize first" }, id: null }));
        return;
      }
      session.lastActivity = Date.now();
      await (session.transport as StreamableHTTPServerTransport).handleRequest(req, res, body);
    } catch (err) {
      console.error("[http] request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
    }
  });
  metrics.bindSnapshotSources({
    countSessions: () => sessions.size,
    countUnboundSessions: () => {
      let n = 0;
      for (const s of sessions.values()) if (s.getBinding() === null) n++;
      return n;
    },
    countBindingsByGroup: () => {
      const counts = new Map<string, number>();
      for (const s of sessions.values()) {
        const b = s.getBinding();
        if (b) counts.set(b.group, (counts.get(b.group) ?? 0) + 1);
      }
      return counts;
    },
    countActiveAgentsByGroup: () => {
      const counts = new Map<string, number>();
      for (const a of registry.getAgents()) {
        counts.set(a.group_name, (counts.get(a.group_name) ?? 0) + 1);
      }
      return counts;
    },
  });

  httpServer.listen(port, () => {
    console.error(`agents MCP v${SERVER_VERSION} (streamable-http:${port} + NATS@${natsTransport?.getHost()}) running`);
  });

  // Sweep unbound HTTP sessions whose transport.onclose never fired (laptop
  // sleeps, network drops, /mcp reconnect without a clean DELETE). Bound
  // sessions are left alone — agent identity is presumed live until the
  // owning client deregisters or the transport actually closes. The leak
  // before this fix went unbound→3-digit session counts in under an hour.
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions.entries()) {
      if (s.getBinding() !== null) continue;
      if (now - s.lastActivity < UNBOUND_SESSION_TIMEOUT_MS) continue;
      metrics.sessionAgeHistogram.observe((now - s.createdAt) / 1000);
      try {
        const t = s.transport as StreamableHTTPServerTransport;
        if (typeof t.close === "function") void t.close();
      } catch { /* best-effort */ }
      sessions.delete(id);
    }
  }, SESSION_SWEEP_INTERVAL_MS).unref();
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

async function createHttpSession(): Promise<Session> {
  let binding: SessionBinding | null = null;
  let sessionRef: Session | null = null;
  const getBinding = () => binding;
  const setBinding = (b: SessionBinding | null) => { binding = b; };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => {
      const s = pending;
      if (!s) return;
      s.id = id;
      sessions.set(id, s);
    },
  });
  const server = createMcpServer({ getBinding, setBinding });
  transport.onclose = () => {
    const ageMs = Date.now() - (sessionRef?.createdAt ?? Date.now());
    metrics.sessionAgeHistogram.observe(ageMs / 1000);
    if (transport.sessionId) sessions.delete(transport.sessionId);
    const agentId = binding?.agentId;
    if (agentId) {
      registry.deregisterAgent(agentId);
      if (natsTransport) natsTransport.untrackLocal(agentId);
    }
  };
  await server.connect(transport);
  const session: Session = {
    id: "",
    server,
    transport,
    getBinding,
    setBinding,
    lastActivity: Date.now(),
    createdAt: Date.now(),
  };
  sessionRef = session;
  pending = session;
  return session;
}

// Bridge for the onsessioninitialized callback — the StreamableHTTP transport
// does not pass the session object back to us, so we stash the in-flight one
// here between construction and the init callback.
let pending: Session | null = null;

async function main(): Promise<void> {
  await initInfra();
  const transportMode = (process.env.AGENTS_TRANSPORT || "stdio").toLowerCase();
  if (transportMode === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});

process.on("SIGTERM", async () => { await natsTransport?.close(); process.exit(0); });
process.on("SIGINT", async () => { await natsTransport?.close(); process.exit(0); });
