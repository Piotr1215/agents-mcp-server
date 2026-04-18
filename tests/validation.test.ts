import { describe, it, expect } from "vitest";
import {
  validateMessageBody,
  validateDmTarget,
  dmTargetIsReachable,
  broadcastGroupIsReachable,
} from "../src/validation.js";

describe("validateMessageBody", () => {
  it("rejects empty string", () => {
    expect(validateMessageBody("")).toMatch(/empty or whitespace/);
  });

  it("rejects whitespace-only", () => {
    expect(validateMessageBody("   ")).toMatch(/empty or whitespace/);
  });

  it("rejects tab/newline-only", () => {
    expect(validateMessageBody("\t\n\r")).toMatch(/empty or whitespace/);
  });

  it("rejects non-string", () => {
    // Defensive: schema already enforces string, but guard caller bugs.
    expect(validateMessageBody(undefined as unknown as string)).toMatch(/empty or whitespace/);
  });

  it("accepts valid content", () => {
    expect(validateMessageBody("hello")).toBeNull();
  });

  it("accepts content with surrounding whitespace", () => {
    expect(validateMessageBody("  hello  ")).toBeNull();
  });

  it("accepts content that is only unicode (non-ascii whitespace treated as content)", () => {
    expect(validateMessageBody("こんにちは")).toBeNull();
  });
});

describe("validateDmTarget", () => {
  it("rejects self-DM", () => {
    expect(validateDmTarget("alice", "alice")).toMatch(/cannot DM self/);
    expect(validateDmTarget("alice", "alice")).toMatch(/channel_send/);
  });

  it("accepts DM to a different agent", () => {
    expect(validateDmTarget("alice", "bob")).toBeNull();
  });

  it("is case-sensitive — different-case names are not self-DMs", () => {
    expect(validateDmTarget("alice", "Alice")).toBeNull();
  });
});

describe("dmTargetIsReachable", () => {
  it("accepts when target is a local agent", async () => {
    const reachable = await dmTargetIsReachable("bob", {
      hasLocalAgent: () => true,
      hasRemotePeer: () => false,
    });
    expect(reachable).toBe(true);
  });

  it("accepts when target is a remote peer", async () => {
    const reachable = await dmTargetIsReachable("bob", {
      hasLocalAgent: () => false,
      hasRemotePeer: () => true,
    });
    expect(reachable).toBe(true);
  });

  it("rejects when target is neither local nor remote", async () => {
    const reachable = await dmTargetIsReachable("ghost", {
      hasLocalAgent: () => false,
      hasRemotePeer: () => false,
    });
    expect(reachable).toBe(false);
  });

  it("short-circuits remote lookup when local hit", async () => {
    let remoteChecked = false;
    const reachable = await dmTargetIsReachable("bob", {
      hasLocalAgent: () => true,
      hasRemotePeer: () => {
        remoteChecked = true;
        return false;
      },
    });
    expect(reachable).toBe(true);
    expect(remoteChecked).toBe(false);
  });

  it("awaits async local lookup", async () => {
    const reachable = await dmTargetIsReachable("bob", {
      hasLocalAgent: async () => true,
      hasRemotePeer: () => false,
    });
    expect(reachable).toBe(true);
  });
});

describe("broadcastGroupIsReachable", () => {
  it("accepts when group has local members", async () => {
    const reachable = await broadcastGroupIsReachable("tasks", {
      localMemberCount: () => 3,
      remoteMemberCount: () => 0,
    });
    expect(reachable).toBe(true);
  });

  it("accepts when group has only remote members", async () => {
    const reachable = await broadcastGroupIsReachable("tasks", {
      localMemberCount: () => 0,
      remoteMemberCount: () => 2,
    });
    expect(reachable).toBe(true);
  });

  it("rejects when group has zero members anywhere", async () => {
    const reachable = await broadcastGroupIsReachable("typo-group", {
      localMemberCount: () => 0,
      remoteMemberCount: () => 0,
    });
    expect(reachable).toBe(false);
  });

  it("accepts a group-of-one — the sender counts as a member", async () => {
    // A sender broadcasting to their own group where they are the only member
    // should still succeed; the group is valid, just currently one-sided.
    const reachable = await broadcastGroupIsReachable("alice-group", {
      localMemberCount: () => 1,
      remoteMemberCount: () => 0,
    });
    expect(reachable).toBe(true);
  });

  it("short-circuits remote lookup when local hit", async () => {
    let remoteChecked = false;
    const reachable = await broadcastGroupIsReachable("tasks", {
      localMemberCount: () => 2,
      remoteMemberCount: () => {
        remoteChecked = true;
        return 5;
      },
    });
    expect(reachable).toBe(true);
    expect(remoteChecked).toBe(false);
  });

  it("awaits async local counter", async () => {
    const reachable = await broadcastGroupIsReachable("tasks", {
      localMemberCount: async () => 1,
      remoteMemberCount: () => 0,
    });
    expect(reachable).toBe(true);
  });
});
