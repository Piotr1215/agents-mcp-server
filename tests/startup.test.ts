import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
  }
});

function waitForResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      lines.close();
      reject(new Error(`MCP response ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      lines.close();
      reject(new Error(`MCP server exited before response ${id} (code=${code}, signal=${signal})`));
    });
    lines.on("line", (line) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { return; }
      if (message.id !== id) return;
      clearTimeout(timeout);
      lines.close();
      resolve(message);
    });
  });
}

function send(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

describe("stdio startup without NATS", () => {
  it("answers the MCP handshake and reports that the bus is connecting", async () => {
    const child = spawn(process.execPath, ["build/index.js"], {
      env: {
        ...process.env,
        AGENTS_TRANSPORT: "stdio",
        // Port 1 refuses immediately, keeping this test deterministic without
        // relying on an external NATS server.
        AGENTS_NATS_URL: "nats://127.0.0.1:1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);

    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "startup-test", version: "1" },
      },
    });

    const initialized = await waitForResponse(child, 1, 5_000);
    expect(initialized.error).toBeUndefined();
    expect(initialized.result).toBeDefined();

    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "agent_register", arguments: { name: "startup-test", description: "test" } },
    });

    const result = await waitForResponse(child, 2, 2_000);
    expect(JSON.stringify(result)).toContain("Error: bus connecting, retry.");
  }, 8_000);
});
