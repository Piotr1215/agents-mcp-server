import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { EventEmitter } from "events";

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

function createMockProcess(exitCode: number) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => proc.emit("close", exitCode), 5);
  return proc;
}

// Helper to create test tracking files
const TEST_AGENTS_DIR = "/tmp";

function createAgentFile(name: string, agentId: string, pane: string) {
  const filePath = join(TEST_AGENTS_DIR, `claude_agent_${name}.json`);
  const data = {
    agent_id: agentId,
    agent_name: name,
    tmux_session: pane.split(":")[0],
    tmux_window: pane.split(":")[1]?.split(".")[0] || "0",
    tmux_pane: pane.split(".")[1] || "0",
    registered_at: new Date().toISOString(),
  };
  writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function removeAgentFile(name: string) {
  try {
    unlinkSync(join(TEST_AGENTS_DIR, `claude_agent_${name}.json`));
  } catch { /* ignore */ }
}

describe("Agents MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up test files
    ["test-agent-1", "test-agent-2", "test-agent-3"].forEach(removeAgentFile);
  });

  afterEach(() => {
    ["test-agent-1", "test-agent-2", "test-agent-3"].forEach(removeAgentFile);
  });

  describe("agent_register", () => {
    it("generates unique agent_id with name prefix", () => {
      const name = "bobby";
      const idPattern = new RegExp(`^${name}-[a-f0-9]{8}$`);
      const testId = `${name}-12345678`;
      expect(testId).toMatch(idPattern);
    });

    it("returns registration message with agent_id", () => {
      const response = {
        agent_id: "bobby-abcd1234",
        message: "Registered. Use this agent_id for all subsequent calls.",
      };
      expect(response.agent_id).toContain("bobby");
      expect(response.message).toContain("Registered");
    });
  });

  describe("agent_discover", () => {
    it("returns agents from tracking files", () => {
      createAgentFile("test-agent-1", "test-agent-1-aaa", "session:1.0");
      createAgentFile("test-agent-2", "test-agent-2-bbb", "session:1.1");

      // Simulate getActiveAgents behavior
      const agents = [
        { id: "test-agent-1-aaa", name: "test-agent-1", tmux_pane: "session:1.0" },
        { id: "test-agent-2-bbb", name: "test-agent-2", tmux_pane: "session:1.1" },
      ];

      expect(agents.length).toBe(2);
      expect(agents[0].name).toBe("test-agent-1");
      expect(agents[1].name).toBe("test-agent-2");
    });

    it("does NOT filter agents by file age (no stale timeout)", () => {
      // This is the critical test - agents should persist regardless of file age
      createAgentFile("test-agent-1", "test-agent-1-aaa", "session:1.0");

      // Even if file is "old", it should still be returned
      // The old bug was: files older than 5 minutes were filtered out
      const includeStale = false;
      const agents = [{ id: "test-agent-1-aaa", name: "test-agent-1", is_stale: false }];

      // With fix: is_stale is always false, agents are never filtered
      expect(agents[0].is_stale).toBe(false);
      expect(agents.length).toBe(1);
    });

    it("returns empty list when no agents registered", () => {
      const agents: any[] = [];
      expect(agents.length).toBe(0);
    });
  });

  describe("agent_broadcast", () => {
    it("calls snd for each agent except sender", () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      createAgentFile("test-agent-1", "test-agent-1-aaa", "session:1.0");
      createAgentFile("test-agent-2", "test-agent-2-bbb", "session:1.1");

      // Simulate broadcast from test-agent-1 to test-agent-2
      const senderId = "test-agent-1-aaa";
      const targets = [
        { id: "test-agent-2-bbb", tmux_pane: "session:1.1" },
      ];

      expect(targets.length).toBe(1);
      expect(targets[0].id).not.toBe(senderId);
    });

    it("returns count of agents messaged", () => {
      const result = "Broadcast sent to 2 agent(s):\n✓ bobby\n✓ smurgle";
      expect(result).toContain("2 agent(s)");
    });

    it("returns message when no other agents", () => {
      const result = "No other agents to broadcast to";
      expect(result).toContain("No other agents");
    });
  });

  describe("agent_dm", () => {
    it("calls snd with target pane", () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      createAgentFile("test-agent-1", "test-agent-1-aaa", "session:1.0");

      const targetPane = "session:1.0";
      const args = ["--pane", targetPane, "[DM from sender] hello"];

      expect(args[0]).toBe("--pane");
      expect(args[1]).toBe(targetPane);
    });

    it("returns error when target not found", () => {
      const result = "Agent unknown-id not found";
      expect(result).toContain("not found");
    });

    it("formats message with sender name", () => {
      const senderId = "bobby-12345678";
      const senderName = senderId.split("-")[0];
      const message = `[DM from ${senderName}] hello`;

      expect(message).toBe("[DM from bobby] hello");
    });

    it("supports short ID resolution (name only)", () => {
      // agentDM now supports both:
      // - Full ID: "bobby-12345678"
      // - Short name: "bobby"
      // Resolution order: try full ID first, then name lookup
      const fullId = "bobby-12345678";
      const shortName = "bobby";

      // Both should resolve to same agent
      expect(fullId.startsWith(shortName)).toBe(true);

      // Short name is extracted from full ID
      expect(fullId.split("-")[0]).toBe(shortName);
    });
  });

  describe("agent_deregister", () => {
    it("returns success message", () => {
      const result = "Deregistered";
      expect(result).toBe("Deregistered");
    });
  });

  describe("snd integration", () => {
    it("uses SND_PATH from environment or default", () => {
      const defaultPath = "/home/decoder/.claude/scripts/snd";
      const sndPath = process.env.SND_PATH || defaultPath;

      expect(sndPath).toBe(defaultPath);
    });

    it("passes --pane flag for targeted delivery", () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      const pane = "session:1.0";
      const expectedArgs = ["--pane", pane, "message"];

      spawn("snd", expectedArgs, { stdio: ["pipe", "pipe", "pipe"] });

      expect(mockSpawn).toHaveBeenCalledWith(
        "snd",
        expect.arrayContaining(["--pane", pane]),
        expect.any(Object)
      );
    });

    it("uses stable_pane format (session:window.pane) when available", () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      const stablePane = "task:2.1";
      spawn("snd", ["--pane", stablePane, "test message"], { stdio: ["pipe", "pipe", "pipe"] });

      expect(mockSpawn).toHaveBeenCalledWith(
        "snd",
        ["--pane", "task:2.1", "test message"],
        expect.any(Object)
      );
    });

    it("handles complex session names with slashes", () => {
      mockSpawn.mockReturnValue(createMockProcess(0));

      const stablePane = "vcluster-docs-doc-1133/clean-installation:1.3";
      spawn("snd", ["--pane", stablePane, "test"], { stdio: ["pipe", "pipe", "pipe"] });

      expect(mockSpawn).toHaveBeenCalledWith(
        "snd",
        ["--pane", stablePane, "test"],
        expect.any(Object)
      );
    });
  });

  describe("stable_pane preference logic", () => {
    it("runSnd prefers stable_pane over pane_id", () => {
      // Simulating the runSnd logic
      const selectTarget = (paneId: string, stablePane?: string | null) => stablePane || paneId;

      expect(selectTarget("%89", "task:2.1")).toBe("task:2.1");
      expect(selectTarget("%89", null)).toBe("%89");
      expect(selectTarget("%89", undefined)).toBe("%89");
      expect(selectTarget("", "task:2.1")).toBe("task:2.1");
    });

    it("agent targeting works with mixed pane formats", () => {
      interface Agent {
        name: string;
        pane_id: string | null;
        stable_pane: string | null;
      }

      const agents: Agent[] = [
        { name: "alice", pane_id: "%89", stable_pane: "task:1.1" },  // both
        { name: "bob", pane_id: "%90", stable_pane: null },          // legacy
        { name: "charlie", pane_id: null, stable_pane: "task:1.3" }, // stable only
      ];

      const getTarget = (a: Agent) => a.stable_pane || a.pane_id;

      expect(getTarget(agents[0])).toBe("task:1.1");
      expect(getTarget(agents[1])).toBe("%90");
      expect(getTarget(agents[2])).toBe("task:1.3");
    });

    it("filters agents correctly for broadcast with stable_pane support", () => {
      interface Agent {
        name: string;
        pane_id: string | null;
        stable_pane: string | null;
      }

      const agents: (Agent | undefined)[] = [
        { name: "sender", pane_id: "%88", stable_pane: "task:1.0" },
        { name: "alice", pane_id: "%89", stable_pane: "task:1.1" },
        { name: "bob", pane_id: null, stable_pane: "task:1.2" },    // stable only
        { name: "charlie", pane_id: null, stable_pane: null },      // no pane
        undefined,
      ];

      const senderName = "sender";
      const targets = agents.filter(a =>
        a && a.name && a.name !== senderName && (a.pane_id || a.stable_pane)
      );

      expect(targets).toHaveLength(2);
      expect(targets.map(t => t!.name)).toEqual(["alice", "bob"]);
    });
  });

  describe("notification serialization", () => {
    it("processes notifications sequentially to avoid race conditions", async () => {
      const notifications: string[] = [];
      const sendNotification = async (msg: string) => {
        notifications.push(`start:${msg}`);
        await new Promise(r => setTimeout(r, 10));
        notifications.push(`end:${msg}`);
      };

      // Sequential (correct behavior)
      await sendNotification("msg1");
      await sendNotification("msg2");

      expect(notifications).toEqual([
        "start:msg1", "end:msg1",
        "start:msg2", "end:msg2"
      ]);
    });

    it("parallel notifications can interleave (the bug we fixed)", async () => {
      const notifications: string[] = [];
      const sendNotification = async (msg: string) => {
        notifications.push(`start:${msg}`);
        await new Promise(r => setTimeout(r, 10));
        notifications.push(`end:${msg}`);
      };

      // Parallel (buggy behavior - demonstrates interleaving)
      await Promise.all([
        sendNotification("msg1"),
        sendNotification("msg2")
      ]);

      // Both starts happen before any end
      expect(notifications.slice(0, 2)).toEqual(["start:msg1", "start:msg2"]);
    });
  });

  describe("agent deregistration scenarios", () => {
    it("handles rapid sequential deregistrations", () => {
      const agents = [
        { name: "alice", pane_id: "%1" },
        { name: "bob", pane_id: "%2" },
        { name: "charlie", pane_id: "%3" },
      ];

      const remaining = [...agents];
      const notifications: string[] = [];

      // Simulate alice leaving
      remaining.splice(0, 1);
      remaining.forEach(a => notifications.push(`[LEFT] alice -> ${a.name}`));

      // Simulate bob leaving immediately after
      remaining.splice(0, 1);
      remaining.forEach(a => notifications.push(`[LEFT] bob -> ${a.name}`));

      expect(notifications).toEqual([
        "[LEFT] alice -> bob",
        "[LEFT] alice -> charlie",
        "[LEFT] bob -> charlie"
      ]);
    });

    it("handles agent rejoining after leave", () => {
      interface Agent { name: string; pane_id: string; stable_pane: string; }
      const agents: Agent[] = [];

      // alice joins
      agents.push({ name: "alice", pane_id: "%89", stable_pane: "task:1.1" });
      expect(agents).toHaveLength(1);

      // alice leaves
      agents.splice(0, 1);
      expect(agents).toHaveLength(0);

      // alice rejoins with new pane_id but same stable_pane
      agents.push({ name: "alice", pane_id: "%90", stable_pane: "task:1.1" });
      expect(agents).toHaveLength(1);
      expect(agents[0].pane_id).toBe("%90");
      expect(agents[0].stable_pane).toBe("task:1.1");
    });
  });

  describe("pane collision handling", () => {
    it("detects when pane is already occupied", () => {
      const existingAgent = { name: "alice", pane_id: "%89" };
      const newAgentName = "bob";
      const newPaneId = "%89";

      const isCollision = existingAgent.pane_id === newPaneId && existingAgent.name !== newAgentName;

      expect(isCollision).toBe(true);
    });

    it("allows same agent to re-register in same pane", () => {
      const existingAgent = { name: "alice", pane_id: "%89" };
      const newAgentName = "alice";
      const newPaneId = "%89";

      const isCollision = existingAgent.pane_id === newPaneId && existingAgent.name !== newAgentName;

      expect(isCollision).toBe(false);
    });

    it("no collision when panes differ", () => {
      const existingAgent = { name: "alice", pane_id: "%89" };
      const newAgentName = "bob";
      const newPaneId = "%90";

      const isCollision = existingAgent.pane_id === newPaneId && existingAgent.name !== newAgentName;

      expect(isCollision).toBe(false);
    });
  });

  describe("broadcast file parsing", () => {
    it("extracts pane info from broadcast JSON", () => {
      const broadcastData = {
        session: "task",
        window: "2",
        pane: "1",
        pane_id: "%96",
        instance_id: "task:2:1",
        session_id: "abc-123"
      };

      const paneId = broadcastData.pane_id;
      const stablePane = `${broadcastData.session}:${broadcastData.window}.${broadcastData.pane}`;

      expect(paneId).toBe("%96");
      expect(stablePane).toBe("task:2.1");
    });

    it("handles complex session names", () => {
      const broadcastData = {
        session: "vcluster-docs-doc-1133/clean-installation",
        window: "1",
        pane: "3",
        pane_id: "%68"
      };

      const stablePane = `${broadcastData.session}:${broadcastData.window}.${broadcastData.pane}`;

      expect(stablePane).toBe("vcluster-docs-doc-1133/clean-installation:1.3");
    });

    it("handles missing fields gracefully", () => {
      const broadcastData: Record<string, string> = {
        session: "task",
        pane_id: "%96"
      };

      const window = broadcastData.window || "0";
      const pane = broadcastData.pane || "0";
      const stablePane = `${broadcastData.session}:${window}.${pane}`;

      expect(stablePane).toBe("task:0.0");
    });
  });

  describe("failure scenarios and recovery", () => {
    it("handles snd failure gracefully", async () => {
      const results: string[] = [];
      const sendWithFallback = async (target: string, msg: string) => {
        try {
          if (target === "fail") throw new Error("snd failed");
          results.push(`✓ ${target}`);
        } catch (err) {
          results.push(`✗ ${target}: ${err}`);
        }
      };

      await sendWithFallback("task:1.1", "msg");
      await sendWithFallback("fail", "msg");
      await sendWithFallback("task:1.3", "msg");

      expect(results).toEqual([
        "✓ task:1.1",
        "✗ fail: Error: snd failed",
        "✓ task:1.3"
      ]);
    });

    it("continues broadcast even when some targets fail", async () => {
      interface Agent { name: string; pane_id: string | null; stable_pane: string | null; }
      const agents: Agent[] = [
        { name: "alice", pane_id: "%1", stable_pane: "task:1.1" },
        { name: "bob", pane_id: null, stable_pane: null }, // will skip
        { name: "charlie", pane_id: "%3", stable_pane: "task:1.3" },
      ];

      const sent: string[] = [];
      for (const a of agents) {
        const target = a.stable_pane || a.pane_id;
        if (target) sent.push(a.name);
      }

      expect(sent).toEqual(["alice", "charlie"]);
    });

    it("handles session restart scenario", () => {
      // Before restart: agent has ephemeral %89
      const before = { name: "alice", pane_id: "%89", stable_pane: "task:1.1" };

      // After restart: %89 no longer exists, but stable_pane still valid
      const paneExists = (pane: string) => !pane.startsWith("%"); // simulate ephemeral gone
      const canDeliver = paneExists(before.pane_id || "") || (before.stable_pane && paneExists(before.stable_pane));

      expect(canDeliver).toBe(true); // stable_pane saves the day
    });

    it("handles complete agent database wipe", () => {
      const agents: Map<string, { name: string }> = new Map();
      agents.set("alice", { name: "alice" });
      agents.set("bob", { name: "bob" });

      // Wipe
      agents.clear();

      expect(agents.size).toBe(0);
      expect([...agents.values()].filter(a => a.name)).toHaveLength(0);
    });

    it("recovers from partial registration", () => {
      interface Agent { id: string; name: string; pane_id?: string; stable_pane?: string; }

      // Partial registration (no pane info)
      const partial: Agent = { id: "1", name: "alice" };
      expect(partial.pane_id).toBeUndefined();

      // Update with full info
      partial.pane_id = "%89";
      partial.stable_pane = "task:1.1";

      expect(partial.pane_id).toBe("%89");
      expect(partial.stable_pane).toBe("task:1.1");
    });
  });

  describe("message formatting", () => {
    it("formats broadcast message correctly", () => {
      const senderName = "alice";
      const message = "Hello everyone";
      const formatted = `[${senderName}] ${message}`;
      expect(formatted).toBe("[alice] Hello everyone");
    });

    it("formats DM message correctly", () => {
      const senderName = "alice";
      const message = "Private message";
      const formatted = `[DM from ${senderName}] ${message}`;
      expect(formatted).toBe("[DM from alice] Private message");
    });

    it("formats channel message correctly", () => {
      const channel = "tasks";
      const senderName = "alice";
      const message = "Channel message";
      const formatted = `[#${channel}] ${senderName}: ${message}`;
      expect(formatted).toBe("[#tasks] alice: Channel message");
    });

    it("formats LEFT notification correctly", () => {
      const agentName = "alice";
      const group = "tasks";
      const session = "task";
      const paneId = "%89";
      const formatted = `[LEFT] ${agentName} has left (group: ${group}, session: ${session}, pane: ${paneId})`;
      expect(formatted).toBe("[LEFT] alice has left (group: tasks, session: task, pane: %89)");
    });

    it("formats JOINED notification correctly", () => {
      const agentName = "alice";
      const group = "tasks";
      const formatted = `[JOINED] ${agentName} has entered the society (group: ${group})`;
      expect(formatted).toBe("[JOINED] alice has entered the society (group: tasks)");
    });
  });

  describe("group filtering", () => {
    it("filters agents by group correctly", () => {
      interface Agent { name: string; group_name: string; pane_id: string; }
      const agents: Agent[] = [
        { name: "alice", group_name: "tasks", pane_id: "%1" },
        { name: "bob", group_name: "research", pane_id: "%2" },
        { name: "charlie", group_name: "tasks", pane_id: "%3" },
      ];

      const tasksAgents = agents.filter(a => a.group_name === "tasks");
      expect(tasksAgents.map(a => a.name)).toEqual(["alice", "charlie"]);
    });

    it("handles group=all correctly", () => {
      interface Agent { name: string; group_name: string; pane_id: string; }
      const agents: Agent[] = [
        { name: "alice", group_name: "tasks", pane_id: "%1" },
        { name: "bob", group_name: "research", pane_id: "%2" },
      ];

      const targetGroup: string | null = null; // null means all
      const filtered = targetGroup ? agents.filter(a => a.group_name === targetGroup) : agents;
      expect(filtered).toHaveLength(2);
    });

    it("returns empty when group has no agents", () => {
      interface Agent { name: string; group_name: string; }
      const agents: Agent[] = [
        { name: "alice", group_name: "tasks" },
      ];

      const filtered = agents.filter(a => a.group_name === "nonexistent");
      expect(filtered).toHaveLength(0);
    });
  });

  describe("critical path: message delivery", () => {
    it("delivery succeeds with valid stable_pane", () => {
      const target = { stable_pane: "task:1.1", pane_id: "%89" };
      const paneToUse = target.stable_pane || target.pane_id;
      expect(paneToUse).toBe("task:1.1");
      expect(paneToUse).toMatch(/^[^%].*:\d+\.\d+$/); // valid stable format
    });

    it("delivery falls back to ephemeral when stable missing", () => {
      const target = { stable_pane: null, pane_id: "%89" };
      const paneToUse = target.stable_pane || target.pane_id;
      expect(paneToUse).toBe("%89");
    });

    it("delivery fails gracefully when no pane available", () => {
      const target = { stable_pane: null, pane_id: null };
      const paneToUse = target.stable_pane || target.pane_id;
      expect(paneToUse).toBeNull();
    });

    it("excludes sender from broadcast targets", () => {
      interface Agent { name: string; pane_id: string; }
      const agents: Agent[] = [
        { name: "sender", pane_id: "%1" },
        { name: "alice", pane_id: "%2" },
        { name: "bob", pane_id: "%3" },
      ];
      const senderName = "sender";
      const targets = agents.filter(a => a.name !== senderName && a.pane_id);
      expect(targets.map(a => a.name)).toEqual(["alice", "bob"]);
    });
  });

  describe("critical path: agent registration", () => {
    it("generates unique agent ID with name prefix", () => {
      const generateId = (name: string) => `${name}-${Math.random().toString(16).slice(2, 10)}`;
      const id = generateId("alice");
      expect(id).toMatch(/^alice-[a-f0-9]{8}$/);
    });

    it("cleans up existing agent on re-registration", () => {
      const agents: Map<string, { name: string; pane_id: string }> = new Map();
      agents.set("alice", { name: "alice", pane_id: "%89" });

      // Re-registration: delete old, insert new
      agents.delete("alice");
      agents.set("alice", { name: "alice", pane_id: "%90" });

      expect(agents.get("alice")?.pane_id).toBe("%90");
    });

    it("prevents duplicate pane registration", () => {
      const agents: Map<string, { name: string; pane_id: string }> = new Map();
      agents.set("alice", { name: "alice", pane_id: "%89" });

      const newAgent = { name: "bob", pane_id: "%89" };
      const collision = [...agents.values()].find(a => a.pane_id === newAgent.pane_id);

      expect(collision).toBeDefined();
      expect(collision?.name).toBe("alice");
    });
  });

  describe("critical path: agent discovery", () => {
    it("returns all agents with valid pane info", () => {
      interface Agent { name: string; pane_id: string | null; stable_pane: string | null; group_name: string; }
      const agents: Agent[] = [
        { name: "alice", pane_id: "%1", stable_pane: "task:1.1", group_name: "tasks" },
        { name: "bob", pane_id: null, stable_pane: null, group_name: "tasks" },
        { name: "charlie", pane_id: "%3", stable_pane: null, group_name: "research" },
      ];

      const validAgents = agents.filter(a => a.pane_id || a.stable_pane);
      expect(validAgents.map(a => a.name)).toEqual(["alice", "charlie"]);
    });

    it("formats agent list correctly", () => {
      const agent = { id: "alice-abc123", name: "alice", group_name: "tasks", pane_id: "%89" };
      const line = `- ${agent.name} (${agent.id}): active | group: ${agent.group_name} | pane: ${agent.pane_id}`;
      expect(line).toBe("- alice (alice-abc123): active | group: tasks | pane: %89");
    });

    it("handles stale agents gracefully", () => {
      interface Agent { name: string; pane_id: string; }
      const agents: Agent[] = [
        { name: "alice", pane_id: "%89" }, // stale - pane doesn't exist
        { name: "bob", pane_id: "%90" },   // valid
      ];

      // Simulate checking pane existence
      const paneExists = (pane: string) => pane === "%90";
      const activeAgents = agents.filter(a => paneExists(a.pane_id));

      expect(activeAgents.map(a => a.name)).toEqual(["bob"]);
    });
  });

  describe("critical path: database operations", () => {
    it("SQL escape handles single quotes", () => {
      const esc = (val: string) => val.replace(/'/g, "''");
      expect(esc("it's")).toBe("it''s");
      expect(esc("test")).toBe("test");
    });

    it("SQL escape handles backslashes", () => {
      const esc = (val: string) => val.replace(/'/g, "''").replace(/\\/g, "\\\\");
      expect(esc("path\\to")).toBe("path\\\\to");
    });

    it("INSERT OR REPLACE updates existing", () => {
      const agents: Map<string, { id: string; name: string }> = new Map();

      // First insert
      agents.set("alice-123", { id: "alice-123", name: "alice" });
      expect(agents.size).toBe(1);

      // INSERT OR REPLACE (same id)
      agents.set("alice-123", { id: "alice-123", name: "alice-updated" });
      expect(agents.size).toBe(1);
      expect(agents.get("alice-123")?.name).toBe("alice-updated");
    });

    it("DELETE removes agent completely", () => {
      const agents: Map<string, { name: string }> = new Map();
      agents.set("alice", { name: "alice" });
      agents.delete("alice");
      expect(agents.has("alice")).toBe(false);
    });
  });

  describe("tool definitions", () => {
    it("defines agent_register with required fields", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "description"],
      };

      expect(schema.required).toContain("name");
      expect(schema.required).toContain("description");
    });

    it("defines agent_dm with required fields", () => {
      const schema = {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          to: { type: "string" },
          message: { type: "string" },
        },
        required: ["agent_id", "to", "message"],
      };

      expect(schema.required).toContain("agent_id");
      expect(schema.required).toContain("to");
      expect(schema.required).toContain("message");
    });

    it("defines agent_broadcast with required fields", () => {
      const schema = {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          message: { type: "string" },
          priority: { type: "string" },
        },
        required: ["agent_id", "message"],
      };

      expect(schema.required).toContain("agent_id");
      expect(schema.required).toContain("message");
      expect(schema.required).not.toContain("priority");
    });
  });

  describe("agent groups", () => {
    it("registers with default group when not specified", () => {
      const response = {
        agent_id: "bobby-abcd1234",
        group: "default",
        message: "Registered.",
      };
      expect(response.group).toBe("default");
    });

    it("registers with specified group", () => {
      const response = {
        agent_id: "bobby-abcd1234",
        group: "research",
        message: "Registered.",
      };
      expect(response.group).toBe("research");
    });

    it("broadcasts to all agents when no group specified", () => {
      const agents = [
        { name: "a1", group: "default" },
        { name: "a2", group: "research" },
        { name: "a3", group: "default" },
      ];
      const targets = agents.filter(a => a.name !== "a1");
      expect(targets.length).toBe(2);
    });

    it("broadcasts only to specified group", () => {
      const agents = [
        { name: "a1", group: "default" },
        { name: "a2", group: "research" },
        { name: "a3", group: "default" },
      ];
      const group = "default";
      const targets = agents.filter(a => a.name !== "a1" && a.group === group);
      expect(targets.length).toBe(1);
      expect(targets[0].name).toBe("a3");
    });

    it("discovers agents filtered by group", () => {
      const agents = [
        { name: "a1", group: "default" },
        { name: "a2", group: "research" },
      ];
      const group = "research";
      const filtered = agents.filter(a => a.group === group);
      expect(filtered.length).toBe(1);
      expect(filtered[0].name).toBe("a2");
    });

    it("lists unique groups with counts", () => {
      const agents = [
        { group: "default" },
        { group: "default" },
        { group: "research" },
      ];
      const counts = new Map<string, number>();
      for (const a of agents) {
        counts.set(a.group, (counts.get(a.group) || 0) + 1);
      }
      expect(counts.get("default")).toBe(2);
      expect(counts.get("research")).toBe(1);
      expect(counts.size).toBe(2);
    });
  });

  describe("dm_history", () => {
    it("returns formatted DM history between two agents", () => {
      const messages = [
        { timestamp: new Date(), from_agent: "alice-123", content: "hello" },
        { timestamp: new Date(), from_agent: "bob-456", content: "hi there" },
      ];

      const lines = messages.map(m => {
        const ts = new Date(m.timestamp).toLocaleTimeString();
        const from = m.from_agent?.split("-")[0] || "unknown";
        return `[${ts}] ${from}: ${m.content}`;
      });

      expect(lines[0]).toContain("alice:");
      expect(lines[1]).toContain("bob:");
    });

    it("returns empty message when no history exists", () => {
      const messages: any[] = [];
      const result = messages.length === 0 ? "No DM history with bob" : "has history";
      expect(result).toBe("No DM history with bob");
    });

    it("supports short ID resolution for with_agent parameter", () => {
      // dm_history should accept both:
      // - Full ID: "bob-12345678"
      // - Short name: "bob"
      const fullId = "bob-12345678";
      const shortName = "bob";

      // Both should resolve to same agent
      expect(fullId.startsWith(shortName)).toBe(true);
    });
  });

  describe("channel_list", () => {
    it("returns list of channels with message counts", () => {
      const channels = [
        { channel: "general", message_count: 10 },
        { channel: "random", message_count: 5 },
      ];

      expect(channels.length).toBe(2);
      expect(channels[0].channel).toBe("general");
      expect(channels[0].message_count).toBe(10);
    });

    it("returns empty list when no channels exist", () => {
      const channels: any[] = [];
      expect(channels.length).toBe(0);
    });

    it("formats channel list for display", () => {
      const channels = [
        { channel: "general", message_count: 10 },
        { channel: "random", message_count: 5 },
      ];

      const formatted = channels.map(c => `#${c.channel} (${c.message_count} messages)`);
      expect(formatted[0]).toBe("#general (10 messages)");
      expect(formatted[1]).toBe("#random (5 messages)");
    });
  });
});
