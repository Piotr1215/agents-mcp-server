#!/usr/bin/env node
// PROJECT: claude-automation, agent-lifecycle
// See: ops-autonomous-worker.md, ops-triage-agent.md, __mcp_agent_registration_hook.sh
// Issue: https://github.com/Piotr1215/claude/issues/42
// Agent communication via DuckDB + snd
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

async function runSnd(pane: string, message: string, stablePane?: string | null): Promise<void> {
  // Prefer stable_pane (session:window.pane format) over ephemeral pane_id (%123)
  // Stable format survives tmux session restarts
  const target = stablePane || pane;
  return new Promise((resolve, reject) => {
    const proc = spawn(SND_PATH, ["--pane", target, message], {
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

// Metrics wrapper for tool handlers
async function withMetrics<T>(
  toolName: string,
  fn: () => Promise<string>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const startTime = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startTime;
    const responseChars = result.length;
    const responseLines = result.split("\n").length;
    await db.logToolMetric(toolName, responseChars, responseLines, durationMs, false);

    const meta = { _meta: { chars: responseChars, lines: responseLines, ms: durationMs } };
    const finalResult = result.startsWith("{")
      ? JSON.stringify({ ...JSON.parse(result), ...meta })
      : `${result}\n---\n_meta: ${JSON.stringify(meta._meta)}`;

    return { content: [{ type: "text", text: finalResult }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;
    await db.logToolMetric(toolName, msg.length, 1, durationMs, true);
    throw error;
  }
}

// Create server
const server = new McpServer(
  { name: "agents-mcp-server", version: "3.0.0" },
  {
    instructions: "Multi-agent coordination server. Call agent_register(name, description) first to join. Use agent_discover() to find peers. Use agent_broadcast() for group messages, agent_dm() for direct messages. Channels are group-scoped via channel_send(). Check dm_history() or channel_history() to catch up on conversations."
  }
);

// Tool: agent_register
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
  async ({ name, description, group }) => {
    return withMetrics("agent_register", async () => {
      const groupName = group || "default";
      const existing = await db.getAgentByName(name);
      const agentId = existing?.id || generateAgentId(name);
      const allAgents = await db.getAgents(groupName);
      const peers = allAgents
        .filter(a => a && a.name && a.name !== name)
        .map(a => ({ name: a.name, group: a.group_name }));

      return JSON.stringify({
        agent_id: agentId,
        group: groupName,
        peers,
        message: "Registered. Use your name for subsequent calls."
      });
    });
  }
);

// Tool: agent_deregister
server.registerTool(
  "agent_deregister",
  {
    title: "Leave Conversation",
    description: "Deregister an agent when shutting down.",
    inputSchema: {
      name: z.string().describe("Your agent name"),
    },
    annotations: { destructiveHint: true },
  },
  async ({ name }) => {
    return withMetrics("agent_deregister", async () => {
      const agent = await db.getAgentByName(name);
      if (!agent || !agent.id) {
        return JSON.stringify({
          success: true,
          name,
          message: "was already gone or never registered"
        });
      }
      // Capture info BEFORE deletion for hook to use
      const agentInfo = {
        id: agent.id,
        name: agent.name,
        group_name: agent.group_name || "default",
        pane_id: agent.pane_id,
        stable_pane: agent.stable_pane
      };
      await db.deregisterAgent(agent.id);
      await db.logMessage("LEFT", agent.id, null, null, `${agent.name} left (group: ${agent.group_name}, pane: ${agent.pane_id})`);
      return JSON.stringify({
        success: true,
        ...agentInfo,
        message: `Deregistered ${name}`
      });
    });
  }
);

// Tool: agent_broadcast
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
  async ({ name, message, priority, group }) => {
    return withMetrics("agent_broadcast", async () => {
      const sender = await db.getAgentByName(name);
      if (!sender || !sender.id) {
        return `Error: You (${name}) not registered or registration incomplete. Call agent_register(name, description) first, then wait a moment for hook to complete.`;
      }
      const senderGroup = sender.group_name || "default";

      let agents = await db.getAgents();
      let targets = agents.filter(a => a && a.name && a.name !== name && a.pane_id);

      const targetGroup = group === "all" ? null : (group || senderGroup);
      if (targetGroup) {
        targets = targets.filter(a => a.group_name === targetGroup);
      }

      if (targets.length === 0) {
        const allAgents = await db.getAgents();
        const groups = [...new Set(allAgents.filter(a => a && a.group_name).map(a => a.group_name))];
        return targetGroup
          ? `Error: No agents in group '${targetGroup}'. Available groups: ${groups.join(", ")}. Use agent_discover() or try group="all".`
          : "Error: No other agents online. You're alone. Wait for others to join or check agent_discover().";
      }

      await db.logMessage("BROADCAST", sender.id, null, null, message);
      logToFile("BROADCAST", `${name}: ${message}`);

      const formattedMsg = `[${name}] ${message}`;
      const results: string[] = [];

      for (const target of targets) {
        try {
          if (target.pane_id || target.stable_pane) {
            await runSnd(target.pane_id || "", formattedMsg, target.stable_pane);
            results.push(`✓ ${target.name}`);
          }
        } catch (err) {
          results.push(`✗ ${target.name}: ${err}`);
        }
      }

      const groupInfo = targetGroup ? ` in group '${targetGroup}'` : " (all groups)";
      return `Broadcast sent to ${targets.length} agent(s)${groupInfo}:\n${results.join("\n")}`;
    });
  }
);

// Tool: agent_dm
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
  async ({ name, to, message }) => {
    return withMetrics("agent_dm", async () => {
      const sender = await db.getAgentByName(name);
      if (!sender || !sender.id) {
        return `Error: You (${name}) not registered or registration incomplete. Call agent_register(name, description) first.`;
      }

      const target = await db.getAgentByName(to);
      if (!target || !target.id) {
        const agents = await db.getAgents();
        const names = agents.filter(a => a && a.name).map(a => a.name).join(", ");
        return `Error: Agent '${to}' not found. Active agents: ${names || "none"}. Use agent_discover() to refresh.`;
      }
      if (!target.pane_id && !target.stable_pane) return `Error: Agent '${to}' has no tmux pane (may have disconnected). Use agent_discover() to see active agents.`;

      await db.logMessage("DM", sender.id, target.id, null, message);
      logToFile("DM", `${name} -> ${target.name}: ${message}`);

      const formattedMsg = `[DM from ${name}] ${message}`;

      try {
        await runSnd(target.pane_id || "", formattedMsg, target.stable_pane);
        return `DM sent to ${target.name}`;
      } catch (err) {
        return `Failed to send DM: ${err}`;
      }
    });
  }
);

// Tool: agent_discover
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
  async ({ include_stale, group }) => {
    return withMetrics("agent_discover", async () => {
      const agents = await db.getAgents(group || undefined);
      const validAgents = agents.filter(a => a && a.id && a.name);

      if (validAgents.length === 0) {
        return group ? `No agents in group '${group}'` : "No agents currently registered.";
      }

      const lines = validAgents.map(a =>
        `- ${a.name} (${a.id}): active | group: ${a.group_name || "default"} | pane: ${a.pane_id || "unknown"}`
      );

      const groupInfo = group ? ` in group '${group}'` : "";
      return `Active agents (${validAgents.length})${groupInfo}:\n${lines.join("\n")}`;
    });
  }
);

// Tool: agent_groups
server.registerTool(
  "agent_groups",
  {
    title: "List Groups",
    description: "List all active agent groups.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    return withMetrics("agent_groups", async () => {
      const groups = await db.getGroups();

      if (groups.length === 0) return "No agents registered.";

      const lines = groups.map(g => `- ${g.group_name} (${g.count} agent${g.count > 1 ? "s" : ""})`);
      return `Active groups (${groups.length}):\n${lines.join("\n")}`;
    });
  }
);

// Tool: channel_send
server.registerTool(
  "channel_send",
  {
    title: "Post to Channel",
    description: "Send a message to a channel.",
    inputSchema: {
      name: z.string().describe("Your agent name"),
      channel: z.string().describe("Channel name"),
      message: z.string().describe("Message content"),
    },
    annotations: { readOnlyHint: false },
  },
  async ({ name, channel, message }) => {
    return withMetrics("channel_send", async () => {
      const sender = await db.getAgentByName(name);
      const senderId = sender?.id || name;

      await db.logMessage("CHANNEL", senderId, null, channel, message);

      const agents = await db.getAgents(channel);
      const targets = agents.filter(a => a && a.name && a.name !== name && (a.pane_id || a.stable_pane));

      const formattedMsg = `[#${channel}] ${name}: ${message}`;

      for (const target of targets) {
        if (target.pane_id || target.stable_pane) {
          try {
            await runSnd(target.pane_id || "", formattedMsg, target.stable_pane);
          } catch {
            // Continue on failure
          }
        }
      }

      return `Message sent to #${channel} (${targets.length} recipients)`;
    });
  }
);

// Tool: channel_history
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
  async ({ channel, limit, detailed }) => {
    return withMetrics("channel_history", async () => {
      const messages = await db.getChannelHistory(channel, limit);

      if (messages.length === 0) return `No messages in #${channel}`;

      const validMessages = messages.filter(m => m && m.id);

      if (detailed) {
        return JSON.stringify({
          channel,
          count: validMessages.length,
          messages: validMessages.reverse().map(m => ({
            id: m.id,
            timestamp: m.timestamp,
            from: m.from_agent,
            content: m.content,
          })),
        });
      }

      const lines = validMessages.reverse().map(m => {
        const ts = new Date(m.timestamp).toLocaleTimeString();
        const from = m.from_agent?.split("-")[0] || "unknown";
        return `[${ts}] ${from}: ${m.content}`;
      });

      return `#${channel} history (${messages.length}):\n${lines.join("\n")}`;
    });
  }
);

// Tool: dm_history
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
  async ({ name, with_agent, limit, detailed }) => {
    return withMetrics("dm_history", async () => {
      const myAgent = await db.getAgentByName(name);
      const otherAgent = await db.getAgentByName(with_agent);

      const myId = myAgent?.id || name;
      const otherId = otherAgent?.id || with_agent;
      const otherName = otherAgent?.name || with_agent;

      const messages = await db.getDmHistory(myId, otherId, limit);
      const validMessages = messages.filter(m => m && m.id);

      if (validMessages.length === 0) return `No DM history with ${otherName}`;

      if (detailed) {
        return JSON.stringify({
          with_agent: otherName,
          count: validMessages.length,
          messages: validMessages.reverse().map(m => ({
            id: m.id,
            timestamp: m.timestamp,
            from: m.from_agent,
            to: m.to_agent,
            content: m.content,
          })),
        });
      }

      const lines = validMessages.reverse().map(m => {
        const ts = new Date(m.timestamp).toLocaleTimeString();
        const from = m.from_agent?.split("-")[0] || "unknown";
        return `[${ts}] ${from}: ${m.content}`;
      });

      return `DM history with ${otherName} (${validMessages.length}):\n${lines.join("\n")}`;
    });
  }
);

// Tool: channel_list
server.registerTool(
  "channel_list",
  {
    title: "List Channels",
    description: "List all channels with message counts.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    return withMetrics("channel_list", async () => {
      const channels = await db.getChannels();

      if (channels.length === 0) return "No channels with messages yet.";

      const lines = channels.map(c => `- #${c.channel} (${c.message_count} messages)`);
      return `Active channels (${channels.length}):\n${lines.join("\n")}`;
    });
  }
);

// Tool: messages_since
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
  async ({ since_id, limit }) => {
    return withMetrics("messages_since", async () => {
      const messages = await db.getMessagesSince(since_id, limit);
      const validMessages = messages.filter(m => m && m.id);

      if (validMessages.length === 0) return JSON.stringify({ messages: [], last_id: since_id });

      const lastId = validMessages[validMessages.length - 1].id;
      return JSON.stringify({ messages: validMessages, last_id: lastId });
    });
  }
);

// Tool: tool_metrics
server.registerTool(
  "tool_metrics",
  {
    title: "Usage Metrics",
    description: "Get tool usage metrics (response sizes, call counts) for optimization analysis.",
    inputSchema: {
      days: z.number().optional().default(7).describe("Days to look back (default: 7)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ days }) => {
    return withMetrics("tool_metrics", async () => {
      const summary = await db.getToolMetricsSummary(days);

      if (summary.length === 0) return `No tool metrics in last ${days} days.`;

      const totalCalls = summary.reduce((sum, t) => sum + t.call_count, 0);
      const totalChars = summary.reduce((sum, t) => sum + t.total_chars, 0);

      const lines = summary.map(t =>
        `- ${t.tool_name}: ${t.call_count} calls, avg ${t.avg_chars} chars, total ${t.total_chars} chars${t.error_count > 0 ? ` (${t.error_count} errors)` : ""}`
      );

      return `Tool metrics (last ${days} days):\n${lines.join("\n")}\n\nTotal: ${totalCalls} calls, ${totalChars} chars (~${Math.round(totalChars / 4)} tokens)`;
    });
  }
);

async function main() {
  await db.getDb(); // Initialize DB
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agents MCP Server v3.0.0 (McpServer + DuckDB) running");
}

main().catch(console.error);
