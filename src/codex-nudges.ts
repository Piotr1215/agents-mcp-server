import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { readFileSync } from "node:fs";

export interface AppServerRpc {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface CodexNudge {
  fromAgent: string;
  content: string;
  originHost: string;
}

type DeliveryResult = "started" | "steered" | "skipped";

interface ThreadSnapshot {
  status?: { type?: string };
  turns?: Array<{ id?: string; status?: string }>;
}

function nudgeText(message: CodexNudge): string {
  return `<dm> [${message.fromAgent}@${message.originHost}] ${message.content}`;
}

async function readThread(rpc: AppServerRpc, threadId: string): Promise<ThreadSnapshot> {
  const response = await rpc.request("thread/read", { threadId, includeTurns: true });
  const thread = (response as { thread?: ThreadSnapshot } | null)?.thread;
  if (!thread) throw new Error("thread/read returned no thread");
  return thread;
}

async function deliverOnce(
  rpc: AppServerRpc,
  threadId: string,
  message: CodexNudge,
): Promise<DeliveryResult> {
  const thread = await readThread(rpc, threadId);
  const input = [{ type: "text", text: nudgeText(message) }];

  if (thread.status?.type === "idle") {
    await rpc.request("turn/start", { threadId, input });
    return "started";
  }

  if (thread.status?.type !== "active") return "skipped";
  const activeTurn = [...(thread.turns ?? [])].reverse().find((turn) => turn.status === "inProgress");
  if (!activeTurn?.id) return "skipped";

  await rpc.request("turn/steer", {
    threadId,
    expectedTurnId: activeTurn.id,
    input,
  });
  return "steered";
}

export async function deliverCodexNudge(
  rpc: AppServerRpc,
  threadId: string,
  message: CodexNudge,
): Promise<DeliveryResult> {
  try {
    return await deliverOnce(rpc, threadId, message);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("turn")) throw error;
    return deliverOnce(rpc, threadId, message);
  }
}

export function encodeClientTextFrame(text: string, mask = randomBytes(4)): Buffer {
  return encodeClientFrame(Buffer.from(text), 0x1, mask);
}

export function readCodexThreadBinding(
  agentName: string,
  codexHome = defaultCodexHome(),
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  const bindingPath = join(codexHome, "agent-bindings", `${encodeURIComponent(agentName)}.json`);
  try {
    const binding = JSON.parse(readText(bindingPath)) as { thread_id?: unknown };
    return typeof binding.thread_id === "string" && binding.thread_id ? binding.thread_id : null;
  } catch {
    return null;
  }
}

function encodeClientFrame(payload: Buffer, opcode: number, mask = randomBytes(4)): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

export class CodexAppServerSocket implements AppServerRpc {
  private readonly socket: Socket;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly connected: Promise<void>;
  private readonly initialized: Promise<void>;
  private buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private nextId = 1;

  constructor(socketPath = defaultSocketPath()) {
    this.socket = createConnection(socketPath);
    this.connected = this.handshake();
    this.socket.on("error", (error) => this.rejectPending(error));
    this.socket.on("close", () => this.rejectPending(new Error("app-server socket closed")));
    this.initialized = this.connected
      .then(() => this.requestRaw("initialize", {
        clientInfo: { name: "agents_nudge_bridge", title: "Agents Nudge Bridge", version: "1.0.0" },
      }))
      .then(() => this.notify("initialized", {}));
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.initialized;
    return this.requestRaw(method, params);
  }

  close(): void {
    this.socket.end(encodeClientFrame(Buffer.alloc(0), 0x8));
  }

  private handshake(): Promise<void> {
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    return new Promise((resolve, reject) => {
      this.socket.once("connect", () => {
        this.socket.write([
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });
      const onHandshake = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headers = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 4);
        const accepted = headers.toLowerCase().includes("101 switching protocols")
          && headers.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`);
        if (!accepted) {
          reject(new Error(`app-server WebSocket handshake failed: ${headers.split("\r\n")[0]}`));
          return;
        }
        this.handshakeDone = true;
        this.socket.off("data", onHandshake);
        this.socket.on("data", (data: Buffer) => this.handleData(data));
        if (this.buffer.length > 0) this.consumeFrames();
        resolve();
      };
      this.socket.on("data", onHandshake);
      this.socket.once("error", reject);
    });
  }

  private requestRaw(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeClientTextFrame(JSON.stringify({ method, id, params })));
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.socket.write(encodeClientTextFrame(JSON.stringify({ method, params })));
  }

  private handleData(chunk: Buffer): void {
    if (!this.handshakeDone) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.consumeFrames();
  }

  private consumeFrames(): void {
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const longLength = this.buffer.readBigUInt64BE(2);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("app-server frame is too large");
        length = Number(longLength);
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

      if (opcode === 0x1) this.handleMessage(payload.toString("utf8"));
      else if (opcode === 0x8) this.socket.end();
      else if (opcode === 0x9) this.socket.write(encodeClientFrame(payload, 0xa));
    }
  }

  private handleMessage(text: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "app-server request failed"));
    else pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function defaultSocketPath(): string {
  if (process.env.CODEX_APP_SERVER_SOCKET) return process.env.CODEX_APP_SERVER_SOCKET;
  return join(defaultCodexHome(), "app-server-control", "app-server-control.sock");
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}
