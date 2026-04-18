// Publish-time validation for agent_dm and agent_broadcast. Pure helpers so
// the handler composes DB/NATS lookups but the decision logic stays unit-
// testable without spinning up a fake transport. Issue: #116 — silent
// publish to nonexistent target/group and to empty/whitespace body currently
// returns success, hiding caller bugs behind the NATS fire-and-forget model.

export function validateMessageBody(message: string): string | null {
  if (typeof message !== "string" || message.trim().length === 0) {
    return "message body cannot be empty or whitespace-only";
  }
  return null;
}

export function validateDmTarget(sender: string, target: string): string | null {
  if (sender === target) {
    return "cannot DM self; use channel_send for self-scratch";
  }
  return null;
}

export interface DmTargetLookup {
  hasLocalAgent: (name: string) => boolean | Promise<boolean>;
  hasRemotePeer: (name: string) => boolean;
}

// Loose presence check — matches the system's eventually-consistent model.
// A just-deregistered target can still slip through between lookup and
// publish; that is no worse than the prior fire-and-forget behavior where
// any crash mid-send loses the message. The point here is catching typos
// and stale names, not being a strict correctness oracle.
export async function dmTargetIsReachable(
  target: string,
  lookup: DmTargetLookup,
): Promise<boolean> {
  if (await lookup.hasLocalAgent(target)) return true;
  if (lookup.hasRemotePeer(target)) return true;
  return false;
}

export interface GroupLookup {
  localMemberCount: (group: string) => number | Promise<number>;
  remoteMemberCount: (group: string) => number;
}

export async function broadcastGroupIsReachable(
  group: string,
  lookup: GroupLookup,
): Promise<boolean> {
  const local = await lookup.localMemberCount(group);
  if (local > 0) return true;
  if (lookup.remoteMemberCount(group) > 0) return true;
  return false;
}
