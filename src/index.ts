#!/usr/bin/env node
// PROJECT: claude-automation
// Agent communication via DuckDB + snd
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { z } from "zod";
import { appendFileSync } from "fs";
import * as db from "./db.js";

const SND_PATH = process.env.SND_PATH || "/home/decoder/.claude/scripts/snd";
const LOG_FILE = "/tmp/agent_messages.log";

function logToFile(type: string, content: string): void {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  appendFileSync(LOG_FILE, `[${ts}] [${type}] ${content}\n`);
}

// Tool schemas
const AgentRegisterSchema = z.object({
  name: z.string(),
  description: z.string(),
  group: z.string().optional().default("default"),
});

const AgentDeregisterSchema = z.object({
  name: z.string(),
});

const AgentBroadcastSchema = z.object({
  name: z.string(),
  message: z.string(),
  priority: z.enum(["low", "normal", "high"]).optional().default("normal"),
  group: z.string().optional(),
});

const AgentDMSchema = z.object({
  name: z.string(),
  to: z.string(),
  message: z.string(),
});

const AgentDiscoverSchema = z.object({
  include_stale: z.boolean().optional().default(false),
  group: z.string().optional(),
});

const AgentGroupsSchema = z.object({});

const ChannelSendSchema = z.object({
  name: z.string(),
  channel: z.string(),
  message: z.string(),
});

const ChannelHistorySchema = z.object({
  channel: z.string(),
  limit: z.number().optional().default(50),
  detailed: z.boolean().optional().default(false),
});

const DmHistorySchema = z.object({
  name: z.string(),
  with_agent: z.string(),
  limit: z.number().optional().default(50),
  detailed: z.boolean().optional().default(false),
});

const ChannelListSchema = z.object({});

const MessagesSinceSchema = z.object({
  since_id: z.number().optional().default(0),
  limit: z.number().optional().default(100),
});

const ToolMetricsSchema = z.object({
  days: z.number().optional().default(7),
});

const tools: Tool[] = [
  {
    name: "agent_register",
    description: "Register as an agent. Returns agent_id and list of active peers in your group.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Agent name" },
        description: { type: "string" as const, description: "What this agent does" },
        group: { type: "string" as const, description: "Agent group (default: 'default')" },
      },
      required: ["name", "description"],
    },
    annotations: { title: "Join Conversation", readOnlyHint: false },
  },
  {
    name: "agent_deregister",
    description: "Deregister an agent when shutting down.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Your agent name" },
      },
      required: ["name"],
    },
    annotations: { title: "Leave Conversation", destructiveHint: true },
  },
  {
    name: "agent_broadcast",
    description: "Send a message to ALL other agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Your agent name" },
        message: { type: "string" as const, description: "Message content" },
        priority: { type: "string" as const, enum: ["low", "normal", "high"], description: "Message priority" },
        group: { type: "string" as const, description: "Target group (omit for all agents)" },
      },
      required: ["name", "message"],
    },
    annotations: { title: "Broadcast Message", readOnlyHint: false },
  },
  {
    name: "agent_dm",
    description: "Send a direct message to a specific agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Your agent name" },
        to: { type: "string" as const, description: "Target agent name" },
        message: { type: "string" as const, description: "Message content" },
      },
      required: ["name", "to", "message"],
    },
    annotations: { title: "Direct Message", readOnlyHint: false },
  },
  {
    name: "agent_discover",
    description: "Discover all active agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        include_stale: { type: "boolean" as const, description: "Include agents not seen in last 5 minutes" },
        group: { type: "string" as const, description: "Filter by group (omit for all)" },
      },
    },
    annotations: { title: "Find Peers", readOnlyHint: true },
  },
  {
    name: "agent_groups",
    description: "List all active agent groups.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: { title: "List Groups", readOnlyHint: true },
  },
  {
    name: "channel_send",
    description: "Send a message to a channel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Your agent name" },
        channel: { type: "string" as const, description: "Channel name" },
        message: { type: "string" as const, description: "Message content" },
      },
      required: ["name", "channel", "message"],
    },
    annotations: { title: "Post to Channel", readOnlyHint: false },
  },
  {
    name: "channel_history",
    description: "Get recent messages from a channel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string" as const, description: "Channel name" },
        limit: { type: "number" as const, description: "Max messages to return (default: 50)" },
        detailed: { type: "boolean" as const, description: "Include full metadata (default: false, compact mode)" },
      },
      required: ["channel"],
    },
    annotations: { title: "Read Channel", readOnlyHint: true },
  },
  {
    name: "dm_history",
    description: "Get DM history between you and another agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Your agent name" },
        with_agent: { type: "string" as const, description: "The other agent's name" },
        limit: { type: "number" as const, description: "Max messages to return (default: 50)" },
        detailed: { type: "boolean" as const, description: "Include full metadata (default: false, compact mode)" },
      },
      required: ["name", "with_agent"],
    },
    annotations: { title: "Catch Up on DMs", readOnlyHint: true },
  },
  {
    name: "channel_list",
    description: "List all channels with message counts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: { title: "List Channels", readOnlyHint: true },
  },
  {
    name: "messages_since",
    description: "Poll for new messages since a given ID (for TUI).",
    inputSchema: {
      type: "object" as const,
      properties: {
        since_id: { type: "number" as const, description: "Return messages after this ID (0 for all)" },
        limit: { type: "number" as const, description: "Max messages to return (default: 100)" },
      },
    },
    annotations: { title: "Poll Messages", readOnlyHint: true },
  },
  {
    name: "tool_metrics",
    description: "Get tool usage metrics (response sizes, call counts) for optimization analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: { type: "number" as const, description: "Days to look back (default: 7)" },
      },
    },
    annotations: { title: "Usage Metrics", readOnlyHint: true },
  },
];

async function runSnd(pane: string, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(SND_PATH, ["--pane", pane, message], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`snd failed with code ${code}`));
    });
    proc.on("error", reject);
  });
}

function generateAgentId(name: string): string {
  const suffix = randomBytes(4).toString("hex");
  return `${name}-${suffix}`;
}

// Note: pane_id comes from PostToolUse hook, not from here
async function agentRegister(args: z.infer<typeof AgentRegisterSchema>): Promise<string> {
  // Check if agent with same name already exists - reuse ID to prevent orphaning
  const existing = await db.getAgentByName(args.name);
  const agentId = existing ? existing.id : generateAgentId(args.name);

  // Get active peers so agent knows who's around (one tool = one story)
  const allAgents = await db.getAgents(args.group);
  const peers = allAgents
    .filter(a => a.name !== args.name)
    .map(a => ({ name: a.name, group: a.group_name }));

  // Registration completed by hook which calls registerAgent with pane_id
  return JSON.stringify({
    agent_id: agentId,
    group: args.group,
    peers,
    message: "Registered. Use your name for subsequent calls."
  });
}

async function agentDeregister(args: z.infer<typeof AgentDeregisterSchema>): Promise<string> {
  const agent = await db.getAgentByName(args.name);
  if (!agent || !agent.id) {
    // Idempotent - already gone is success
    return `${args.name} deregistered (was already gone or never registered)`;
  }
  await db.deregisterAgent(agent.id);
  await db.logMessage("LEFT", agent.id, null, null, `${agent.name} left (group: ${agent.group_name})`);
  return `Deregistered ${args.name}`;
}

async function agentBroadcast(args: z.infer<typeof AgentBroadcastSchema>): Promise<string> {
  const sender = await db.getAgentByName(args.name);
  if (!sender || !sender.id) {
    return `Error: You (${args.name}) not registered or registration incomplete. Call agent_register(name, description) first, then wait a moment for hook to complete.`;
  }
  const senderGroup = sender.group_name || "default";

  let agents = await db.getAgents();
  let targets = agents.filter(a => a.name !== args.name && a.pane_id);

  const targetGroup = args.group === "all" ? null : (args.group || senderGroup);
  if (targetGroup) {
    targets = targets.filter(a => a.group_name === targetGroup);
  }

  if (targets.length === 0) {
    const allAgents = await db.getAgents();
    const groups = [...new Set(allAgents.map(a => a.group_name))];
    return targetGroup
      ? `Error: No agents in group '${targetGroup}'. Available groups: ${groups.join(", ")}. Use agent_discover() or try group="all".`
      : "Error: No other agents online. You're alone. Wait for others to join or check agent_discover().";
  }

  await db.logMessage("BROADCAST", sender.id, null, null, args.message);
  logToFile("BROADCAST", `${args.name}: ${args.message}`);

  const formattedMsg = `[${args.name}] ${args.message}`;
  const results: string[] = [];

  for (const target of targets) {
    try {
      if (target.pane_id) {
        await runSnd(target.pane_id, formattedMsg);
        results.push(`✓ ${target.name}`);
      }
    } catch (err) {
      results.push(`✗ ${target.name}: ${err}`);
    }
  }

  const groupInfo = targetGroup ? ` in group '${targetGroup}'` : " (all groups)";
  return `Broadcast sent to ${targets.length} agent(s)${groupInfo}:\n${results.join("\n")}`;
}

async function agentDM(args: z.infer<typeof AgentDMSchema>): Promise<string> {
  const sender = await db.getAgentByName(args.name);
  if (!sender || !sender.id) {
    return `Error: You (${args.name}) not registered or registration incomplete. Call agent_register(name, description) first.`;
  }

  const target = await db.getAgentByName(args.to);
  if (!target || !target.id) {
    const agents = await db.getAgents();
    const names = agents.map(a => a.name).join(", ");
    return `Error: Agent '${args.to}' not found. Active agents: ${names || "none"}. Use agent_discover() to refresh.`;
  }
  if (!target.pane_id) return `Error: Agent '${args.to}' has no tmux pane (may have disconnected). Use agent_discover() to see active agents.`;

  await db.logMessage("DM", sender.id, target.id, null, args.message);
  logToFile("DM", `${args.name} -> ${target.name}: ${args.message}`);

  const formattedMsg = `[DM from ${args.name}] ${args.message}`;

  try {
    await runSnd(target.pane_id, formattedMsg);
    return `DM sent to ${target.name}`;
  } catch (err) {
    return `Failed to send DM: ${err}`;
  }
}

async function agentDiscover(args: z.infer<typeof AgentDiscoverSchema>): Promise<string> {
  let agents = await db.getAgents(args.group || undefined);

  if (agents.length === 0) {
    return args.group ? `No agents in group '${args.group}'` : "No agents currently registered.";
  }

  const lines = agents.map(a =>
    `- ${a.name} (${a.id}): active | group: ${a.group_name} | pane: ${a.pane_id || "unknown"}`
  );

  const groupInfo = args.group ? ` in group '${args.group}'` : "";
  return `Active agents (${agents.length})${groupInfo}:\n${lines.join("\n")}`;
}

async function agentGroups(): Promise<string> {
  const groups = await db.getGroups();

  if (groups.length === 0) return "No agents registered.";

  const lines = groups.map(g => `- ${g.group_name} (${g.count} agent${g.count > 1 ? "s" : ""})`);
  return `Active groups (${groups.length}):\n${lines.join("\n")}`;
}

async function channelSend(args: z.infer<typeof ChannelSendSchema>): Promise<string> {
  const sender = await db.getAgentByName(args.name);
  const senderId = sender?.id || args.name;

  await db.logMessage("CHANNEL", senderId, null, args.channel, args.message);

  // Notify all agents in channel's group (channel name = group name convention)
  const agents = await db.getAgents(args.channel);
  const targets = agents.filter(a => a.name !== args.name && a.pane_id);

  const formattedMsg = `[#${args.channel}] ${args.name}: ${args.message}`;

  for (const target of targets) {
    if (target.pane_id) {
      try {
        await runSnd(target.pane_id, formattedMsg);
      } catch {
        // Continue on failure
      }
    }
  }

  return `Message sent to #${args.channel} (${targets.length} recipients)`;
}

async function channelHistory(args: z.infer<typeof ChannelHistorySchema>): Promise<string> {
  const messages = await db.getChannelHistory(args.channel, args.limit);

  if (messages.length === 0) return `No messages in #${args.channel}`;

  if (args.detailed) {
    // Full metadata: id, timestamp, from_agent, content
    return JSON.stringify({
      channel: args.channel,
      count: messages.length,
      messages: messages.reverse().map(m => ({
        id: m.id,
        timestamp: m.timestamp,
        from: m.from_agent,
        content: m.content,
      })),
    });
  }

  // Compact: just time, name, content
  const lines = messages.reverse().map(m => {
    const ts = new Date(m.timestamp).toLocaleTimeString();
    const from = m.from_agent?.split("-")[0] || "unknown";
    return `[${ts}] ${from}: ${m.content}`;
  });

  return `#${args.channel} history (${messages.length}):\n${lines.join("\n")}`;
}

async function dmHistory(args: z.infer<typeof DmHistorySchema>): Promise<string> {
  const myAgent = await db.getAgentByName(args.name);
  const otherAgent = await db.getAgentByName(args.with_agent);

  const myId = myAgent?.id || args.name;
  const otherId = otherAgent?.id || args.with_agent;
  const otherName = otherAgent?.name || args.with_agent;

  const messages = await db.getDmHistory(myId, otherId, args.limit);

  if (messages.length === 0) return `No DM history with ${otherName}`;

  if (args.detailed) {
    // Full metadata
    return JSON.stringify({
      with_agent: otherName,
      count: messages.length,
      messages: messages.reverse().map(m => ({
        id: m.id,
        timestamp: m.timestamp,
        from: m.from_agent,
        to: m.to_agent,
        content: m.content,
      })),
    });
  }

  // Compact
  const lines = messages.reverse().map(m => {
    const ts = new Date(m.timestamp).toLocaleTimeString();
    const from = m.from_agent?.split("-")[0] || "unknown";
    return `[${ts}] ${from}: ${m.content}`;
  });

  return `DM history with ${otherName} (${messages.length}):\n${lines.join("\n")}`;
}

async function channelList(): Promise<string> {
  const channels = await db.getChannels();

  if (channels.length === 0) return "No channels with messages yet.";

  const lines = channels.map(c => `- #${c.channel} (${c.message_count} messages)`);
  return `Active channels (${channels.length}):\n${lines.join("\n")}`;
}

async function messagesSince(args: z.infer<typeof MessagesSinceSchema>): Promise<string> {
  const messages = await db.getMessagesSince(args.since_id, args.limit);

  if (messages.length === 0) return JSON.stringify({ messages: [], last_id: args.since_id });

  const lastId = messages[messages.length - 1].id;
  return JSON.stringify({ messages, last_id: lastId });
}

async function toolMetrics(args: z.infer<typeof ToolMetricsSchema>): Promise<string> {
  const summary = await db.getToolMetricsSummary(args.days);

  if (summary.length === 0) return `No tool metrics in last ${args.days} days.`;

  const totalCalls = summary.reduce((sum, t) => sum + t.call_count, 0);
  const totalChars = summary.reduce((sum, t) => sum + t.total_chars, 0);

  const lines = summary.map(t =>
    `- ${t.tool_name}: ${t.call_count} calls, avg ${t.avg_chars} chars, total ${t.total_chars} chars${t.error_count > 0 ? ` (${t.error_count} errors)` : ""}`
  );

  return `Tool metrics (last ${args.days} days):\n${lines.join("\n")}\n\nTotal: ${totalCalls} calls, ${totalChars} chars (~${Math.round(totalChars / 4)} tokens)`;
}

const server = new Server(
  { name: "agents-mcp-server", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const startTime = Date.now();

  try {
    let result: string;

    switch (name) {
      case "agent_register":
        result = await agentRegister(AgentRegisterSchema.parse(args));
        break;
      case "agent_deregister":
        result = await agentDeregister(AgentDeregisterSchema.parse(args));
        break;
      case "agent_broadcast":
        result = await agentBroadcast(AgentBroadcastSchema.parse(args));
        break;
      case "agent_dm":
        result = await agentDM(AgentDMSchema.parse(args));
        break;
      case "agent_discover":
        result = await agentDiscover(AgentDiscoverSchema.parse(args));
        break;
      case "agent_groups":
        result = await agentGroups();
        break;
      case "channel_send":
        result = await channelSend(ChannelSendSchema.parse(args));
        break;
      case "channel_history":
        result = await channelHistory(ChannelHistorySchema.parse(args));
        break;
      case "dm_history":
        result = await dmHistory(DmHistorySchema.parse(args));
        break;
      case "channel_list":
        result = await channelList();
        break;
      case "messages_since":
        result = await messagesSince(MessagesSinceSchema.parse(args));
        break;
      case "tool_metrics":
        result = await toolMetrics(ToolMetricsSchema.parse(args));
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    // Track metrics
    const durationMs = Date.now() - startTime;
    const responseChars = result.length;
    const responseLines = result.split("\n").length;
    await db.logToolMetric(name, responseChars, responseLines, durationMs, false);

    // Append _meta for transparency (tokens ≈ chars/4)
    const meta = { _meta: { chars: responseChars, lines: responseLines, ms: durationMs } };
    const finalResult = result.startsWith("{") ?
      JSON.stringify({ ...JSON.parse(result), ...meta }) :
      `${result}\n---\n_meta: ${JSON.stringify(meta._meta)}`;

    return { content: [{ type: "text" as const, text: finalResult }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;
    await db.logToolMetric(name, msg.length, 1, durationMs, true);
    return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  await db.getDb(); // Initialize DB
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agents MCP Server v2.0.0 (DuckDB) running");
}

main().catch(console.error);
