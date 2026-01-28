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
});
