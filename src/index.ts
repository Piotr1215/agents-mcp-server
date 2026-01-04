#!/usr/bin/env node
// PROJECT: claude-automation
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { z } from "zod";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";

// Tool schemas - Core NATS
const PublishSchema = z.object({
  subject: z.string(),
  message: z.string(),
  headers: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});

const SubscribeSchema = z.object({
  subject: z.string(),
  count: z.number().optional().default(1),
  timeout: z.number().optional().default(5000),
});

const RequestSchema = z.object({
  subject: z.string(),
  message: z.string(),
  timeout: z.number().optional().default(5000),
});

// Tool schemas - Agent Protocol
const AgentRegisterSchema = z.object({
  name: z.string(),
  description: z.string(),
});

const AgentDeregisterSchema = z.object({
  agent_id: z.string(),
});

const AgentBroadcastSchema = z.object({
  agent_id: z.string(),
  message: z.string(),
  priority: z.enum(["low", "normal", "high"]).optional().default("normal"),
});

const AgentDMSchema = z.object({
  agent_id: z.string(),
  to: z.string(),
  message: z.string(),
});

const AgentCheckMessagesSchema = z.object({
  agent_id: z.string(),
  timeout: z.number().optional().default(5000),
});

const AgentHeartbeatSchema = z.object({
  agent_id: z.string(),
  status: z.string().optional().default("active"),
});

const AgentDiscoverSchema = z.object({
  include_stale: z.boolean().optional().default(false),
});

const tools: Tool[] = [
  // Core NATS tools
  {
    name: "nats_publish",
    description: "Publish a message to a NATS subject",
    inputSchema: {
      type: "object" as const,
      properties: {
        subject: { type: "string" as const, description: "NATS subject" },
        message: { type: "string" as const, description: "Message to publish" },
        headers: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              key: { type: "string" as const },
              value: { type: "string" as const },
            },
          },
          description: "Optional headers",
        },
      },
      required: ["subject", "message"],
    },
  },
  {
    name: "nats_subscribe",
    description: "Subscribe to a NATS subject and receive messages",
    inputSchema: {
      type: "object" as const,
      properties: {
        subject: { type: "string" as const, description: "NATS subject" },
        count: { type: "number" as const, description: "Number of messages" },
        timeout: { type: "number" as const, description: "Timeout in ms" },
      },
      required: ["subject"],
    },
  },
  {
    name: "nats_request",
    description: "Send request and wait for reply",
    inputSchema: {
      type: "object" as const,
      properties: {
        subject: { type: "string" as const, description: "NATS subject" },
        message: { type: "string" as const, description: "Request message" },
        timeout: { type: "number" as const, description: "Timeout in ms" },
      },
      required: ["subject", "message"],
    },
  },
  // Agent Protocol tools
  {
    name: "nats_agent_register",
    description: "Register as an agent. Returns unique agent_id to use in other calls.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Agent name (e.g., 'clauder')" },
        description: { type: "string" as const, description: "What this agent does" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "nats_agent_deregister",
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
    name: "nats_agent_broadcast",
    description: "Send a message to ALL agents.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string" as const, description: "Your agent ID" },
        message: { type: "string" as const, description: "Message content" },
        priority: { type: "string" as const, enum: ["low", "normal", "high"], description: "Message priority" },
      },
      required: ["agent_id", "message"],
    },
  },
  {
    name: "nats_agent_dm",
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
    name: "nats_agent_check_messages",
    description: "Check for incoming messages (broadcasts and DMs).",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string" as const, description: "Your agent ID" },
        timeout: { type: "number" as const, description: "How long to wait for messages (ms)" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "nats_agent_heartbeat",
    description: "Send a heartbeat to indicate agent is still alive.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_id: { type: "string" as const, description: "Your agent ID" },
        status: { type: "string" as const, description: "Current status message" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "nats_agent_discover",
    description: "Discover all active agents. Returns list of registered agents with their IDs, names, and status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        include_stale: { type: "boolean" as const, description: "Include agents not seen in last 5 minutes" },
      },
    },
  },
];

async function runNatsCommand(args: string[]): Promise<string> {
  const fullArgs = ["-s", NATS_URL, ...args];
  return new Promise((resolve, reject) => {
    const proc = spawn("nats", fullArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim() || "OK");
      } else {
        reject(new Error(stderr || `Command failed with code ${code}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

async function publish(args: z.infer<typeof PublishSchema>): Promise<string> {
  const cmdArgs = ["publish", args.subject, args.message];
  if (args.headers) {
    for (const h of args.headers) {
      cmdArgs.push("-H", `${h.key}:${h.value}`);
    }
  }
  return runNatsCommand(cmdArgs);
}

async function subscribe(args: z.infer<typeof SubscribeSchema>): Promise<string> {
  const cmdArgs = ["subscribe", args.subject, "--count", String(args.count || 1)];

  return new Promise((resolve, reject) => {
    const proc = spawn("nats", ["-s", NATS_URL, ...cmdArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    const timeoutId = setTimeout(() => {
      proc.kill();
      resolve(stdout || "No messages received");
    }, args.timeout || 5000);

    proc.stdout.on("data", (data) => (stdout += data.toString()));

    proc.on("close", () => {
      clearTimeout(timeoutId);
      resolve(stdout.trim() || "No messages");
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

async function natsRequest(args: z.infer<typeof RequestSchema>): Promise<string> {
  const cmdArgs = [
    "request",
    args.subject,
    args.message,
    "--timeout",
    `${args.timeout || 5000}ms`,
  ];
  return runNatsCommand(cmdArgs);
}

// Agent Protocol implementations
function generateAgentId(name: string): string {
  const suffix = randomBytes(4).toString("hex");
  return `${name}-${suffix}`;
}

async function agentRegister(args: z.infer<typeof AgentRegisterSchema>): Promise<string> {
  const agentId = generateAgentId(args.name);
  const payload = JSON.stringify({
    id: agentId,
    name: args.name,
    description: args.description,
    ts: Date.now(),
  });
  await publish({ subject: "agents.register", message: payload });
  return JSON.stringify({ agent_id: agentId, message: "Registered. Use this agent_id for all subsequent calls." });
}

async function agentDeregister(args: z.infer<typeof AgentDeregisterSchema>): Promise<string> {
  const payload = JSON.stringify({ id: args.agent_id, ts: Date.now() });
  await publish({ subject: "agents.deregister", message: payload });
  return "Deregistered";
}

async function agentBroadcast(args: z.infer<typeof AgentBroadcastSchema>): Promise<string> {
  const payload = JSON.stringify({
    from: args.agent_id,
    msg: args.message,
    priority: args.priority || "normal",
    ts: Date.now(),
  });
  await publish({ subject: "agents.broadcast", message: payload });
  return "Broadcast sent";
}

async function agentDM(args: z.infer<typeof AgentDMSchema>): Promise<string> {
  const payload = JSON.stringify({
    from: args.agent_id,
    to: args.to,
    msg: args.message,
    ts: Date.now(),
  });
  await publish({ subject: `agents.dm.${args.to}`, message: payload });
  return `DM sent to ${args.to}`;
}

async function agentCheckMessages(args: z.infer<typeof AgentCheckMessagesSchema>): Promise<string> {
  const consumerName = `agent-${args.agent_id.replace(/\//g, "-")}`;
  const streamName = "AGENT_MESSAGES";

  // Pull messages from JetStream consumer
  const cmdArgs = [
    "consumer", "next",
    streamName, consumerName,
    "--count", "10",
    "--no-ack", // We'll format and return, let caller decide to ack
  ];

  try {
    const result = await runNatsCommand(cmdArgs);
    if (!result || result === "OK" || result.includes("no messages")) {
      return "No messages";
    }
    return result;
  } catch (error) {
    // Consumer might not exist or no messages
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("timeout") || msg.includes("no messages")) {
      return "No messages";
    }
    // Consumer doesn't exist - try creating it
    if (msg.includes("consumer not found") || msg.includes("not found")) {
      return "No messages (consumer not configured)";
    }
    throw error;
  }
}

async function agentHeartbeat(args: z.infer<typeof AgentHeartbeatSchema>): Promise<string> {
  const payload = JSON.stringify({
    id: args.agent_id,
    status: args.status || "active",
    ts: Date.now(),
  });
  await publish({ subject: `agents.heartbeat.${args.agent_id}`, message: payload });
  return "Heartbeat sent";
}

async function agentDiscover(args: z.infer<typeof AgentDiscoverSchema>): Promise<string> {
  const agentDir = "/tmp";
  const staleThreshold = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();

  interface AgentInfo {
    id: string;
    name: string;
    status: string;
    tmux_pane: string;
    registered_at: string;
    is_stale: boolean;
  }

  const agents: AgentInfo[] = [];

  try {
    const files = readdirSync(agentDir).filter(f => f.startsWith("claude_agent_") && f.endsWith(".json"));

    for (const file of files) {
      try {
        const filePath = join(agentDir, file);
        const stat = statSync(filePath);
        const content = readFileSync(filePath, "utf-8");
        const data = JSON.parse(content);

        // Check if stale (file not modified in last 5 minutes)
        const fileAge = now - stat.mtimeMs;
        const isStale = fileAge > staleThreshold;

        if (!args.include_stale && isStale) {
          continue;
        }

        agents.push({
          id: data.agent_id || "unknown",
          name: data.agent_name || "unknown",
          status: isStale ? "stale" : "active",
          tmux_pane: data.tmux_session && data.tmux_window && data.tmux_pane
            ? `${data.tmux_session}:${data.tmux_window}.${data.tmux_pane}`
            : "unknown",
          registered_at: data.registered_at || "unknown",
          is_stale: isStale,
        });
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory read failed
  }

  if (agents.length === 0) {
    return "No agents currently registered.";
  }

  // Format output
  const lines = agents.map(a =>
    `- ${a.name} (${a.id}): ${a.status} | pane: ${a.tmux_pane}`
  );

  return `Active agents (${agents.length}):\n${lines.join("\n")}`;
}

const server = new Server(
  { name: "nats-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    let result: string;

    switch (name) {
      case "nats_publish":
        result = await publish(PublishSchema.parse(args));
        break;
      case "nats_subscribe":
        result = await subscribe(SubscribeSchema.parse(args));
        break;
      case "nats_request":
        result = await natsRequest(RequestSchema.parse(args));
        break;
      case "nats_agent_register":
        result = await agentRegister(AgentRegisterSchema.parse(args));
        break;
      case "nats_agent_deregister":
        result = await agentDeregister(AgentDeregisterSchema.parse(args));
        break;
      case "nats_agent_broadcast":
        result = await agentBroadcast(AgentBroadcastSchema.parse(args));
        break;
      case "nats_agent_dm":
        result = await agentDM(AgentDMSchema.parse(args));
        break;
      case "nats_agent_check_messages":
        result = await agentCheckMessages(AgentCheckMessagesSchema.parse(args));
        break;
      case "nats_agent_heartbeat":
        result = await agentHeartbeat(AgentHeartbeatSchema.parse(args));
        break;
      case "nats_agent_discover":
        result = await agentDiscover(AgentDiscoverSchema.parse(args));
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
  console.error(`NATS MCP Server running (${NATS_URL})`);
}

main().catch(console.error);
