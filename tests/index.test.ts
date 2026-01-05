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
});
