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
  agent_id: z.string(),
});

const AgentBroadcastSchema = z.object({
  agent_id: z.string(),
  message: z.string(),
  priority: z.enum(["low", "normal", "high"]).optional().default("normal"),
  group: z.string().optional(),
});

const AgentDMSchema = z.object({
  agent_id: z.string(),
  to: z.string(),
  message: z.string(),
});

const AgentDiscoverSchema = z.object({
  include_stale: z.boolean().optional().default(false),
  group: z.string().optional(),
});

const AgentGroupsSchema = z.object({});

const ChannelSendSchema = z.object({
  agent_id: z.string(),
  channel: z.string(),
  message: z.string(),
});

const ChannelHistorySchema = z.object({
  channel: z.string(),
  limit: z.number().optional().default(50),
});

const MessagesSinceSchema = z.object({
  since_id: z.number().optional().default(0),
  limit: z.number().optional().default(100),
});

const tools: Tool[] = [
  {
    name: "agent_register",
    description: "Register as an agent. Returns unique agent_id to use in other calls.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Agent name" },
        description: { type: "string" as const, description: "What this agent does" },
        group: { type: "string" as const, description: "Agent group (default: 'default')" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "agent_deregister",
    description: "Deregister an agent when shutting down.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string" as const, description: "Your agent ID from registration" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "agent_broadcast",
    description: "Send a message to ALL other agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string" as const, description: "Your agent ID" },
        message: { type: "string" as const, description: "Message content" },
        priority: { type: "string" as const, enum: ["low", "normal", "high"], description: "Message priority" },
        group: { type: "string" as const, description: "Target group (omit for all agents)" },
      },
      required: ["agent_id", "message"],
    },
  },
  {
    name: "agent_dm",
    description: "Send a direct message to a specific agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string" as const, description: "Your agent ID" },
        to: { type: "string" as const, description: "Target agent ID" },
        message: { type: "string" as const, description: "Message content" },
      },
      required: ["agent_id", "to", "message"],
    },
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
  },
  {
    name: "agent_groups",
    description: "List all active agent groups.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "channel_send",
    description: "Send a message to a channel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string" as const, description: "Your agent ID" },
        channel: { type: "string" as const, description: "Channel name" },
        message: { type: "string" as const, description: "Message content" },
      },
      required: ["agent_id", "channel", "message"],
    },
  },
  {
    name: "channel_history",
    description: "Get recent messages from a channel.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string" as const, description: "Channel name" },
        limit: { type: "number" as const, description: "Max messages to return (default: 50)" },
      },
      required: ["channel"],
    },
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
  const agentId = generateAgentId(args.name);
  // Registration completed by hook which calls registerAgent with pane_id
  return JSON.stringify({ agent_id: agentId, group: args.group, message: "Registered. Use this agent_id for all subsequent calls." });
}

async function agentDeregister(args: z.infer<typeof AgentDeregisterSchema>): Promise<string> {
  const agent = await db.deregisterAgent(args.agent_id);
  if (agent) {
    await db.logMessage("LEFT", args.agent_id, null, null, `${agent.name} left (group: ${agent.group_name})`);
  }
  return "Deregistered";
}

async function agentBroadcast(args: z.infer<typeof AgentBroadcastSchema>): Promise<string> {
  const sender = await db.getAgent(args.agent_id);
  const senderName = sender?.name || args.agent_id.split("-")[0];
  const senderGroup = sender?.group_name || "default";

  let agents = await db.getAgents();
  let targets = agents.filter(a => a.id !== args.agent_id && a.pane_id);

  const targetGroup = args.group === "all" ? null : (args.group || senderGroup);
  if (targetGroup) {
    targets = targets.filter(a => a.group_name === targetGroup);
  }

  if (targets.length === 0) {
    return targetGroup ? `No agents in group '${targetGroup}'` : "No other agents to broadcast to";
  }

  await db.logMessage("BROADCAST", args.agent_id, null, null, args.message);
  logToFile("BROADCAST", `${senderName}: ${args.message}`);

  const formattedMsg = `[${senderName}] ${args.message}`;
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
  const sender = await db.getAgent(args.agent_id);
  const senderName = sender?.name || args.agent_id.split("-")[0];
  const target = await db.getAgent(args.to);

  if (!target) return `Agent ${args.to} not found`;
  if (!target.pane_id) return `Agent ${args.to} has no tmux pane`;

  await db.logMessage("DM", args.agent_id, args.to, null, args.message);
  logToFile("DM", `${senderName} -> ${target.name}: ${args.message}`);

  const formattedMsg = `[DM from ${senderName}] ${args.message}`;

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
  const sender = await db.getAgent(args.agent_id);
  const senderName = sender?.name || args.agent_id.split("-")[0];

  await db.logMessage("CHANNEL", args.agent_id, null, args.channel, args.message);

  // Notify all agents in channel's group (channel name = group name convention)
  const agents = await db.getAgents(args.channel);
  const targets = agents.filter(a => a.id !== args.agent_id && a.pane_id);

  const formattedMsg = `[#${args.channel}] ${senderName}: ${args.message}`;

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

  const lines = messages.reverse().map(m => {
    const ts = new Date(m.timestamp).toLocaleTimeString();
    const from = m.from_agent?.split("-")[0] || "unknown";
    return `[${ts}] ${from}: ${m.content}`;
  });

  return `#${args.channel} history (${messages.length}):\n${lines.join("\n")}`;
}

async function messagesSince(args: z.infer<typeof MessagesSinceSchema>): Promise<string> {
  const messages = await db.getMessagesSince(args.since_id, args.limit);

  if (messages.length === 0) return JSON.stringify({ messages: [], last_id: args.since_id });

  const lastId = messages[messages.length - 1].id;
  return JSON.stringify({ messages, last_id: lastId });
}

const server = new Server(
  { name: "agents-mcp-server", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

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
      case "messages_since":
        result = await messagesSince(MessagesSinceSchema.parse(args));
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text" as const, text: result }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
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
