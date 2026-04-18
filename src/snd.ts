#!/usr/bin/env node
import { connect, type Subscription } from "nats";
import { Buffer } from "node:buffer";
import process from "node:process";

const USAGE = `snd — publisher + spectator for agents comms bus

usage:
  snd <agent> <msg...>          DM to agent
  snd -t <agent> <msg...>       DM to agent (explicit)
  snd -g <group> <msg...>       broadcast to group
  snd --human … <msg...>        prepend "[HUMAN] " to payload
  snd --tail                    subscribe to every DM/broadcast/channel
                                event on the bus and print one line per
                                message. Read-only. Ctrl-C to exit.
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

export interface PublishArgs {
  mode: "publish";
  kind: "dm" | "broadcast";
  target: string;
  message: string;
  human: boolean;
}

export interface TailArgs {
  mode: "tail";
}

export type ParsedArgs = PublishArgs | TailArgs;

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(args.length === 0 ? 1 : 0);
  }

  if (args.includes("--tail")) {
    if (args.length !== 1 || args[0] !== "--tail") {
      fail("snd: --tail takes no other arguments", 1);
    }
    return { mode: "tail" };
  }

  let human = false;
  // Strip --human if present anywhere in front.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--human") { args.splice(i, 1); human = true; i--; }
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
  return { mode: "publish", kind, target, message, human };
}

export function formatTailLine(subject: string, payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const ts = typeof raw.origin_ts === "number" ? raw.origin_ts : Date.now();
  const host = typeof raw.origin_host === "string" ? raw.origin_host : "?";
  const from = typeof raw.from_agent === "string" ? raw.from_agent : "?";
  const content = typeof raw.content === "string" ? raw.content : "";
  const hhmmss = new Date(ts).toISOString().slice(11, 19);
  const sender = `[${from}@${host}]`;
  const body = content.replace(/^\[HUMAN\]\s*/, "");

  if (subject.startsWith("agents.dm.")) {
    const to = typeof raw.to_agent === "string" ? raw.to_agent : "?";
    return `<dm> ${hhmmss} ${sender} -> ${to}: ${body}`;
  }
  if (subject.startsWith("agents.broadcast.")) {
    const group = typeof raw.group === "string" ? raw.group : "?";
    return `<bcast> ${hhmmss} ${sender} -> g:${group}: ${body}`;
  }
  if (subject.startsWith("agents.channel.")) {
    const channel = typeof raw.channel === "string" ? raw.channel : "?";
    return `<ch> ${hhmmss} ${sender} -> ${channel}: ${body}`;
  }
  return null;
}

async function runPublish(parsed: PublishArgs, url: string): Promise<void> {
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

async function runTail(url: string): Promise<void> {
  let nc;
  try {
    nc = await connect({ servers: url, timeout: 3000 });
  } catch (err) {
    fail(`[snd --tail] connect failed: ${err instanceof Error ? err.message : err}`, 2);
  }
  console.error(`[snd --tail] watching ${url} — Ctrl-C to exit`);

  const subs: Subscription[] = [
    nc.subscribe("agents.dm.*"),
    nc.subscribe("agents.broadcast.*"),
    nc.subscribe("agents.channel.*"),
  ];

  const stop = async () => {
    for (const sub of subs) sub.unsubscribe();
    await nc.drain().catch(() => { /* best-effort */ });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const consume = async (sub: Subscription): Promise<void> => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(Buffer.from(msg.data).toString("utf-8"));
        const line = formatTailLine(msg.subject, payload);
        if (line) console.log(line);
      } catch {
        // Malformed payload — skip silently so one bad publisher can't flood stderr.
      }
    }
  };

  await Promise.all(subs.map((s) => consume(s)));
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const url = process.env.AGENTS_NATS_URL;
  if (!url) fail("snd: AGENTS_NATS_URL is required", 1);

  if (parsed.mode === "tail") {
    await runTail(url);
    return;
  }
  await runPublish(parsed, url);
}

const isMain = process.argv[1] && process.argv[1].endsWith("snd.js");
if (isMain) {
  main().catch((err) => { console.error("[snd] fatal:", err); process.exit(2); });
}

// Export for tests.
export { parseArgs, USAGE };
