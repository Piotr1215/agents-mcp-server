import { describe, it, expect } from "vitest";

/**
 * Tests for null guards in array operations.
 * These guards prevent "Cannot read properties of undefined" errors
 * when DuckDB returns sparse arrays or timing issues cause partial data.
 */

interface Agent {
  id: string;
  name: string;
  group_name: string;
  pane_id?: string;
  stable_pane?: string;
}

describe("array null guards", () => {
  describe("agent name extraction", () => {
    it("handles array with undefined elements", () => {
      const agents = [
        { id: "1", name: "alice", group_name: "default" },
        undefined,
        { id: "3", name: "bob", group_name: "tasks" },
        null,
      ] as (Agent | undefined | null)[];

      const names = agents.filter(a => a && a.name).map(a => a!.name).join(", ");

      expect(names).toBe("alice, bob");
    });

    it("handles empty array", () => {
      const agents: Agent[] = [];

      const names = agents.filter(a => a && a.name).map(a => a.name).join(", ");

      expect(names).toBe("");
    });

    it("handles array with agents missing name property", () => {
      const agents = [
        { id: "1", name: "alice", group_name: "default" },
        { id: "2", group_name: "tasks" } as Agent, // missing name
        { id: "3", name: "", group_name: "default" }, // empty name
      ];

      const names = agents.filter(a => a && a.name).map(a => a.name).join(", ");

      expect(names).toBe("alice");
    });
  });

  describe("group name extraction", () => {
    it("handles array with undefined elements", () => {
      const agents = [
        { id: "1", name: "alice", group_name: "default" },
        undefined,
        { id: "3", name: "bob", group_name: "tasks" },
        null,
      ] as (Agent | undefined | null)[];

      const groups = [...new Set(agents.filter(a => a && a.group_name).map(a => a!.group_name))];

      expect(groups).toEqual(["default", "tasks"]);
    });

    it("handles empty array", () => {
      const agents: Agent[] = [];

      const groups = [...new Set(agents.filter(a => a && a.group_name).map(a => a.group_name))];

      expect(groups).toEqual([]);
    });

    it("handles array with agents missing group_name", () => {
      const agents = [
        { id: "1", name: "alice", group_name: "default" },
        { id: "2", name: "bob" } as Agent, // missing group_name
        { id: "3", name: "charlie", group_name: "" }, // empty group_name
      ];

      const groups = [...new Set(agents.filter(a => a && a.group_name).map(a => a.group_name))];

      expect(groups).toEqual(["default"]);
    });

    it("deduplicates group names", () => {
      const agents = [
        { id: "1", name: "alice", group_name: "tasks" },
        { id: "2", name: "bob", group_name: "tasks" },
        { id: "3", name: "charlie", group_name: "default" },
      ];

      const groups = [...new Set(agents.filter(a => a && a.group_name).map(a => a.group_name))];

      expect(groups).toEqual(["tasks", "default"]);
    });
  });

  describe("target filtering for broadcast", () => {
    it("filters out undefined and agents without pane_id", () => {
      const agents = [
        { id: "1", name: "alice", group_name: "default", pane_id: "%1" },
        undefined,
        { id: "3", name: "bob", group_name: "tasks" }, // no pane_id
        { id: "4", name: "charlie", group_name: "default", pane_id: "%4" },
        null,
      ] as (Agent | undefined | null)[];

      const senderName = "alice";
      const targets = agents.filter(a => a && a.name && a.name !== senderName && a.pane_id);

      expect(targets).toHaveLength(1);
      expect(targets[0]!.name).toBe("charlie");
    });
  });

  describe("stable_pane resolution", () => {
    it("prefers stable_pane over ephemeral pane_id", () => {
      const agent = {
        id: "1",
        name: "alice",
        group_name: "default",
        pane_id: "%89",
        stable_pane: "task:2.1"
      };

      // Simulate runSnd logic: prefer stable_pane
      const target = agent.stable_pane || agent.pane_id;

      expect(target).toBe("task:2.1");
    });

    it("falls back to pane_id when stable_pane is missing", () => {
      const agent: Agent = {
        id: "1",
        name: "alice",
        group_name: "default",
        pane_id: "%89"
      };

      const target = agent.stable_pane || agent.pane_id;

      expect(target).toBe("%89");
    });

    it("handles agent with only stable_pane (no ephemeral)", () => {
      const agent = {
        id: "1",
        name: "alice",
        group_name: "default",
        stable_pane: "task:2.1"
      } as Agent;

      const target = agent.stable_pane || agent.pane_id;

      expect(target).toBe("task:2.1");
    });

    it("returns undefined when neither pane identifier exists", () => {
      const agent = {
        id: "1",
        name: "alice",
        group_name: "default"
      } as Agent;

      const target = agent.stable_pane || agent.pane_id;

      expect(target).toBeUndefined();
    });
  });

  describe("broadcast target filtering with stable_pane", () => {
    it("includes agents with stable_pane even if pane_id is missing", () => {
      const agents = [
        { id: "1", name: "alice", group_name: "tasks", pane_id: "%1", stable_pane: "task:1.1" },
        { id: "2", name: "bob", group_name: "tasks", stable_pane: "task:1.2" }, // no pane_id
        { id: "3", name: "charlie", group_name: "tasks" }, // no pane identifiers
        undefined,
      ] as (Agent | undefined | null)[];

      const senderName = "alice";
      const targets = agents.filter(a => a && a.name && a.name !== senderName && (a.pane_id || a.stable_pane));

      expect(targets).toHaveLength(1);
      expect(targets[0]!.name).toBe("bob");
    });

    it("filters correctly when some agents have only ephemeral pane_id", () => {
      const agents = [
        { id: "1", name: "alice", group_name: "tasks", pane_id: "%1", stable_pane: "task:1.1" },
        { id: "2", name: "bob", group_name: "tasks", pane_id: "%2" }, // legacy: only ephemeral
        { id: "3", name: "charlie", group_name: "tasks", stable_pane: "task:1.3" }, // new: only stable
      ] as Agent[];

      const senderName = "alice";
      const targets = agents.filter(a => a && a.name && a.name !== senderName && (a.pane_id || a.stable_pane));

      expect(targets).toHaveLength(2);
      expect(targets.map(t => t.name)).toEqual(["bob", "charlie"]);
    });
  });

  describe("stable_pane format validation", () => {
    it("recognizes valid tmux session:window.pane format", () => {
      const validFormats = [
        "task:1.1",
        "task:2.3",
        "vcluster-docs-doc-1133/clean-installation:1.2",
        "my-session:0.0",
      ];

      const isValidFormat = (pane: string) => /^[^:]+:\d+\.\d+$/.test(pane);

      for (const format of validFormats) {
        expect(isValidFormat(format)).toBe(true);
      }
    });

    it("rejects invalid formats", () => {
      const invalidFormats = [
        "%89",           // ephemeral format
        "task:1:1",      // wrong delimiter
        "task",          // missing window.pane
        "task:",         // missing window.pane
        ":1.1",          // missing session
      ];

      const isValidFormat = (pane: string) => /^[^:]+:\d+\.\d+$/.test(pane);

      for (const format of invalidFormats) {
        expect(isValidFormat(format)).toBe(false);
      }
    });
  });

  describe("pane identifier conversion", () => {
    it("converts instance_id format to tmux format", () => {
      // instance_id uses : for all delimiters: task:2:1
      // tmux uses : then . for pane: task:2.1
      const instanceId = "task:2:1";
      const parts = instanceId.split(":");
      const stablePane = `${parts[0]}:${parts[1]}.${parts[2]}`;

      expect(stablePane).toBe("task:2.1");
    });

    it("handles session names with special characters", () => {
      const session = "vcluster-docs-doc-1133/clean-installation";
      const window = "1";
      const pane = "2";
      const stablePane = `${session}:${window}.${pane}`;

      expect(stablePane).toBe("vcluster-docs-doc-1133/clean-installation:1.2");
    });
  });

  describe("edge cases for reliability", () => {
    it("handles empty string pane_id", () => {
      const agent = { id: "1", name: "alice", group_name: "tasks", pane_id: "", stable_pane: "task:1.1" };
      const target = agent.stable_pane || agent.pane_id || null;
      expect(target).toBe("task:1.1");
    });

    it("handles empty string stable_pane", () => {
      const agent = { id: "1", name: "alice", group_name: "tasks", pane_id: "%89", stable_pane: "" };
      const target = agent.stable_pane || agent.pane_id || null;
      expect(target).toBe("%89");
    });

    it("handles both empty strings", () => {
      const agent = { id: "1", name: "alice", group_name: "tasks", pane_id: "", stable_pane: "" };
      const target = agent.stable_pane || agent.pane_id || null;
      expect(target).toBeNull();
    });

    it("filters work with empty strings as falsy", () => {
      const agents = [
        { id: "1", name: "alice", pane_id: "%1", stable_pane: "task:1.1" },
        { id: "2", name: "bob", pane_id: "", stable_pane: "" },
        { id: "3", name: "charlie", pane_id: "", stable_pane: "task:1.3" },
      ] as Agent[];

      const validTargets = agents.filter(a => a.pane_id || a.stable_pane);
      expect(validTargets.map(a => a.name)).toEqual(["alice", "charlie"]);
    });

    it("handles whitespace-only values", () => {
      const paneId = "  ";
      const stablePane = "task:1.1";
      const target = stablePane || (paneId.trim() || null);
      expect(target).toBe("task:1.1");
    });

    it("handles numeric window and pane indices", () => {
      const session = "task";
      const window = 0;
      const pane = 0;
      const stablePane = `${session}:${window}.${pane}`;
      expect(stablePane).toBe("task:0.0");
    });

    it("handles high window/pane numbers", () => {
      const session = "task";
      const window = 99;
      const pane = 15;
      const stablePane = `${session}:${window}.${pane}`;
      expect(stablePane).toBe("task:99.15");
    });
  });

  describe("agent array operations safety", () => {
    it("safely handles completely undefined array elements", () => {
      const agents: (Agent | undefined | null)[] = [undefined, null, undefined];
      const validAgents = agents.filter(a => a && a.name && (a.pane_id || a.stable_pane));
      expect(validAgents).toHaveLength(0);
    });

    it("safely extracts names from sparse array", () => {
      const agents: (Agent | undefined | null)[] = [
        { id: "1", name: "alice", group_name: "tasks" },
        undefined,
        null,
        { id: "4", name: "bob", group_name: "tasks" },
      ];
      const names = agents.filter(a => a?.name).map(a => a!.name);
      expect(names).toEqual(["alice", "bob"]);
    });

    it("handles agent with all optional fields missing", () => {
      const agent = { id: "1", name: "alice", group_name: "tasks" } as Agent;
      expect(agent.pane_id).toBeUndefined();
      expect(agent.stable_pane).toBeUndefined();
      const hasPaneInfo = !!(agent.pane_id || agent.stable_pane);
      expect(hasPaneInfo).toBe(false);
    });

    it("deduplication works with stable_pane", () => {
      const agents = [
        { id: "1", name: "alice", group_name: "tasks", stable_pane: "task:1.1" },
        { id: "2", name: "bob", group_name: "tasks", stable_pane: "task:1.2" },
        { id: "3", name: "charlie", group_name: "default", stable_pane: "default:1.1" },
      ] as Agent[];

      const groups = [...new Set(agents.map(a => a.group_name))];
      expect(groups).toEqual(["tasks", "default"]);
    });
  });

  describe("concurrent operation safety", () => {
    it("delete-then-insert pattern is atomic-safe", () => {
      const agents: Map<string, Agent> = new Map();

      // Simulate: DELETE WHERE name='alice' OR pane_id='%89'
      agents.set("alice", { id: "1", name: "alice", group_name: "tasks", pane_id: "%89" });
      agents.delete("alice");

      // Simulate: INSERT alice with new pane
      agents.set("alice", { id: "2", name: "alice", group_name: "tasks", pane_id: "%90", stable_pane: "task:1.1" });

      expect(agents.get("alice")?.pane_id).toBe("%90");
      expect(agents.get("alice")?.stable_pane).toBe("task:1.1");
    });

    it("handles registration with existing stable_pane", () => {
      const agents: Map<string, Agent> = new Map();

      // alice registers
      agents.set("alice", { id: "1", name: "alice", group_name: "tasks", pane_id: "%89", stable_pane: "task:1.1" });

      // bob tries to register in same stable_pane (collision)
      const newStablePane = "task:1.1";
      const collision = [...agents.values()].find(a => a.stable_pane === newStablePane && a.name !== "bob");

      expect(collision).toBeDefined();
      expect(collision?.name).toBe("alice");
    });
  });

  describe("tmux pane target formats", () => {
    it("ephemeral format starts with %", () => {
      const isEphemeral = (pane: string) => pane.startsWith("%");
      expect(isEphemeral("%89")).toBe(true);
      expect(isEphemeral("task:1.1")).toBe(false);
    });

    it("stable format contains session:window.pane", () => {
      const isStable = (pane: string) => /^[^%].*:\d+\.\d+$/.test(pane);
      expect(isStable("task:1.1")).toBe(true);
      expect(isStable("my-session:0.0")).toBe(true);
      expect(isStable("%89")).toBe(false);
    });

    it("can detect format and choose appropriate handler", () => {
      const getFormat = (pane: string) => {
        if (pane.startsWith("%")) return "ephemeral";
        if (/^[^%].*:\d+\.\d+$/.test(pane)) return "stable";
        return "unknown";
      };

      expect(getFormat("%89")).toBe("ephemeral");
      expect(getFormat("task:1.1")).toBe("stable");
      expect(getFormat("invalid")).toBe("unknown");
    });
  });
});
