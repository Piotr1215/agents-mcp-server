#!/usr/bin/env node
// snd — unified publisher CLI for the agents comms bus.
//
// Usage:
//   snd <agent> <msg...>          DM to agent (alias of -t)
//   snd -t <agent> <msg...>       DM to agent
//   snd -g <group> <msg...>       broadcast to group
//   snd --human <agent|-g group> <msg...>
//       prepend "[HUMAN] " to the content so agents can distinguish
//       operator input from other agents. The human-facing shell wrapper
//       adds this flag by default; direct binary callers (cron, scripts)
//       omit it and get plain payloads.
//   snd --help | -h               usage
//
// Exit codes:
//   0  published successfully
//   1  usage / argument error
//   2  NATS connect or publish failure
//
// Reads AGENTS_NATS_URL (required).
// SND_FROM overrides the `from_agent` label on the payload (default: "human").
import { connect } from "nats";
import { Buffer } from "node:buffer";
import process from "node:process";

const USAGE = `snd — publisher for agents comms bus

usage:
  snd <agent> <msg...>          DM to agent
  snd -t <agent> <msg...>       DM to agent (explicit)
  snd -g <group> <msg...>       broadcast to group
  snd --human … <msg...>        prepend "[HUMAN] " to payload
  snd --help | -h               this help

env:
  AGENTS_NATS_URL  required — e.g. nats://nats.example:4222
  SND_FROM         optional — label for from_agent (default: human)

exit codes: 0 ok, 1 usage, 2 transport failure
`;

function fail(msg: string, code: number): never {
  console.error(msg);
  process.exit(code);
}

interface ParsedArgs {
  kind: "dm" | "broadcast";
  target: string;
  message: string;
  human: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let human = false;
  // Strip --human if present anywhere in front.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--human") { args.splice(i, 1); human = true; i--; }
  }
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(args.length === 0 ? 1 : 0);
  }

  let kind: "dm" | "broadcast" = "dm";
  let target: string;
  let rest: string[];

  if (args[0] === "-t") {
    if (args.length < 3) fail("snd: -t requires <agent> and a message", 1);
    target = args[1];
    rest = args.slice(2);
  } else if (args[0] === "-g") {
    kind = "broadcast";
    if (args.length < 3) fail("snd: -g requires <group> and a message", 1);
    target = args[1];
    rest = args.slice(2);
  } else {
    if (args.length < 2) fail("snd: need <agent> <message...>", 1);
    target = args[0];
    rest = args.slice(1);
  }

  const message = rest.join(" ");
  return { kind, target, message, human };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const url = process.env.AGENTS_NATS_URL;
  if (!url) fail("snd: AGENTS_NATS_URL is required", 1);

  const from = process.env.SND_FROM || "human";
  const content = parsed.human ? `[HUMAN] ${parsed.message}` : parsed.message;

  const subject = parsed.kind === "dm"
    ? "agents.dm." + Buffer.from(parsed.target, "utf-8").toString("base64url")
    : "agents.broadcast." + Buffer.from(parsed.target, "utf-8").toString("base64url");

  const payload = parsed.kind === "dm"
    ? {
        to_agent: parsed.target,
        from_agent: from,
        content,
        origin_host: "human-cli",
        origin_ts: Date.now(),
      }
    : {
        group: parsed.target,
        from_agent: from,
        content,
        origin_host: "human-cli",
        origin_ts: Date.now(),
      };

  try {
    const nc = await connect({ servers: url, timeout: 3000 });
    nc.publish(subject, Buffer.from(JSON.stringify(payload)));
    await nc.drain();
    const label = parsed.kind === "dm" ? `-> ${parsed.target}` : `-> g:${parsed.target}`;
    console.error(`[snd] ${label}: ${content}`);
  } catch (err) {
    fail(`[snd] failed: ${err instanceof Error ? err.message : err}`, 2);
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith("snd.js");
if (isMain) {
  main().catch((err) => { console.error("[snd] fatal:", err); process.exit(2); });
}

// Export for tests.
export { parseArgs, USAGE };
