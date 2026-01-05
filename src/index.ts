#!/usr/bin/env node
// PROJECT: claude-automation
// Agent communication via snd
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

const SND_PATH = process.env.SND_PATH || "/home/decoder/.claude/scripts/snd";

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
];

interface AgentInfo {
  id: string;
  name: string;
  group: string;
  tmux_pane: string;
  is_stale: boolean;
}

function getActiveAgents(_includeStale = false): AgentInfo[] {
  const agentDir = "/tmp";
  const agents: AgentInfo[] = [];

  try {
    const files = readdirSync(agentDir).filter(f => f.startsWith("claude_agent_") && f.endsWith(".json"));

    for (const file of files) {
      try {
        const filePath = join(agentDir, file);
        const content = readFileSync(filePath, "utf-8");
        const data = JSON.parse(content);

        agents.push({
          id: data.agent_id || "unknown",
          name: data.agent_name || "unknown",
          group: data.group || "default",
          tmux_pane: data.pane_id || "",
          is_stale: false,
        });
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory read failed
  }

  return agents;
}

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

async function agentRegister(args: z.infer<typeof AgentRegisterSchema>): Promise<string> {
  const agentId = generateAgentId(args.name);
  return JSON.stringify({ agent_id: agentId, group: args.group, message: "Registered. Use this agent_id for all subsequent calls." });
}

async function agentDeregister(_args: z.infer<typeof AgentDeregisterSchema>): Promise<string> {
  return "Deregistered";
}

async function agentBroadcast(args: z.infer<typeof AgentBroadcastSchema>): Promise<string> {
  const agents = getActiveAgents();
  const senderName = args.agent_id.split("-")[0];
  const sender = agents.find(a => a.id === args.agent_id);
  const senderGroup = sender?.group || "default";

  let targets = agents.filter(a => a.id !== args.agent_id && a.tmux_pane);

  // Determine target group: explicit group, "all" for everyone, or sender's group
  const targetGroup = args.group === "all" ? null : (args.group || senderGroup);

  if (targetGroup) {
    targets = targets.filter(a => a.group === targetGroup);
  }

  if (targets.length === 0) {
    return targetGroup ? `No agents in group '${targetGroup}'` : "No other agents to broadcast to";
  }

  const formattedMsg = `[${senderName}] ${args.message}`;
  const results: string[] = [];

  for (const target of targets) {
    try {
      await runSnd(target.tmux_pane, formattedMsg);
      results.push(`✓ ${target.name}`);
    } catch (err) {
      results.push(`✗ ${target.name}: ${err}`);
    }
  }

  const groupInfo = targetGroup ? ` in group '${targetGroup}'` : " (all groups)";
  return `Broadcast sent to ${targets.length} agent(s)${groupInfo}:\n${results.join("\n")}`;
}

async function agentDM(args: z.infer<typeof AgentDMSchema>): Promise<string> {
  const agents = getActiveAgents();
  const senderName = args.agent_id.split("-")[0];
  const target = agents.find(a => a.id === args.to);

  if (!target) return `Agent ${args.to} not found`;
  if (!target.tmux_pane) return `Agent ${args.to} has no tmux pane`;

  const formattedMsg = `[DM from ${senderName}] ${args.message}`;

  try {
    await runSnd(target.tmux_pane, formattedMsg);
    return `DM sent to ${target.name}`;
  } catch (err) {
    return `Failed to send DM: ${err}`;
  }
}

async function agentDiscover(args: z.infer<typeof AgentDiscoverSchema>): Promise<string> {
  let agents = getActiveAgents(args.include_stale);

  if (args.group) {
    agents = agents.filter(a => a.group === args.group);
  }

  if (agents.length === 0) {
    return args.group ? `No agents in group '${args.group}'` : "No agents currently registered.";
  }

  const lines = agents.map(a =>
    `- ${a.name} (${a.id}): ${a.is_stale ? "stale" : "active"} | group: ${a.group} | pane: ${a.tmux_pane || "unknown"}`
  );

  const groupInfo = args.group ? ` in group '${args.group}'` : "";
  return `Active agents (${agents.length})${groupInfo}:\n${lines.join("\n")}`;
}

async function agentGroups(): Promise<string> {
  const agents = getActiveAgents();

  if (agents.length === 0) return "No agents registered.";

  const groupCounts = new Map<string, number>();
  for (const a of agents) {
    groupCounts.set(a.group, (groupCounts.get(a.group) || 0) + 1);
  }

  const lines = Array.from(groupCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([group, count]) => `- ${group} (${count} agent${count > 1 ? "s" : ""})`);

  return `Active groups (${groupCounts.size}):\n${lines.join("\n")}`;
}

const server = new Server(
  { name: "agents-mcp-server", version: "1.0.0" },
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agents MCP Server running");
}

main().catch(console.error);
