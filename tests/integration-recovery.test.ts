import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const natsServerPath = "nats-server";
const hasNatsServer = spawnSync(natsServerPath, ["--version"], { stdio: "ignore" }).status === 0;
const clients: Client[] = [];
const children: ChildProcess[] = [];
const tempDirs: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a local port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  while (Date.now() < deadline) {
    last = await read();
    if (ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last!)}`);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("stdio bus recovery", () => {
  it.skipIf(!hasNatsServer)("connects after the MCP handshake and replays a queued DM once", async () => {
    const port = await freePort();
    const url = `nats://127.0.0.1:${port}`;
    const dataDir = await mkdtemp(join(tmpdir(), "agents-mcp-recovery-"));
    tempDirs.push(dataDir);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["build/index.js"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env as Record<string, string>,
        AGENTS_TRANSPORT: "stdio",
        AGENTS_NATS_URL: url,
      },
    });
    const client = new Client({ name: "recovery-integration", version: "1" });
    clients.push(client);
    await client.connect(transport);

    const unavailable = await client.callTool({
      name: "agent_register",
      arguments: { name: "recovery-alice", description: "recovery test" },
    });
    expect(text(unavailable)).toContain("Error: bus connecting, retry.");

    const nats = spawn(natsServerPath, ["--jetstream", "--store_dir", dataDir, "--port", String(port)], {
      stdio: "ignore",
    });
    children.push(nats);

    const registerAlice = async () => client.callTool({
      name: "agent_register",
      arguments: { name: "recovery-alice", description: "recovery test" },
    });
    const registered = await waitFor(registerAlice, (result) => !text(result).includes("bus connecting"));
    expect(registered.isError).not.toBe(true);

    const send = await client.callTool({
      name: "agent_dm",
      arguments: { name: "recovery-alice", to: "recovery-worker", message: "finished once" },
    });
    expect(text(send)).toContain("queued for recovery-worker (not registered)");

    const worker = await client.callTool({
      name: "agent_register",
      arguments: { name: "recovery-worker", description: "recovery test" },
    });
    expect(worker.isError).not.toBe(true);

    const poll = async (since_id = 0) => client.callTool({
      name: "poll_messages",
      arguments: { name: "recovery-worker", since_id },
    });
    const firstText = await waitFor(async () => text(await poll()), (value) => {
      try { return JSON.parse(value).messages.some((m: { content?: string }) => m.content === "finished once"); }
      catch { return false; }
    });
    const first = JSON.parse(firstText) as { messages: Array<{ content: string }>; last_id: number };
    expect(first.messages.filter((message) => message.content === "finished once")).toHaveLength(1);

    const next = JSON.parse(text(await poll(first.last_id))) as { messages: unknown[] };
    expect(next.messages).toHaveLength(0);
  }, 30_000);
});
