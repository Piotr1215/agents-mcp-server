#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { z } from "zod";

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";

// Tool schemas
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

const tools: Tool[] = [
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
