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
  kind?: "dm" | "broadcast" | "channel";
  group?: string;
  channel?: string;
}

export interface CodexBinding {
  threadId: string;
  socketPath?: string;
}

type DeliveryResult = "started" | "steered" | "skipped";

interface ThreadSnapshot {
  status?: { type?: string };
  turns?: Array<{ id?: string; status?: string }>;
}

function nudgeText(message: CodexNudge): string {
  let tag = "<dm>";
  if (message.kind === "broadcast") tag = `<bcast group="${message.group ?? "default"}">`;
  if (message.kind === "channel") tag = `<channel name="${message.channel ?? "default"}">`;
  return `${tag} [${message.fromAgent}@${message.originHost}] ${message.content}`;
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

export async function deliverBoundedCodexNudge(
  rpc: AppServerRpc & { close(): void },
  threadId: string,
  message: CodexNudge,
  timeoutMs = resolveCodexNudgeTimeoutMs(),
): Promise<DeliveryResult> {
  validateTimeoutMs(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Codex nudge delivery timed out after ${timeoutMs}ms`);
      try {
        rpc.close();
      } catch (cause) {
        error.cause = cause;
      }
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([deliverCodexNudge(rpc, threadId, message), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function encodeClientTextFrame(text: string, mask = randomBytes(4)): Buffer {
  return encodeClientFrame(Buffer.from(text), 0x1, mask);
}

export function readCodexThreadBinding(
  agentName: string,
  codexHome = resolveCodexHome(),
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  return readCodexBinding(agentName, codexHome, readText)?.threadId ?? null;
}

export function readCodexBinding(
  agentName: string,
  codexHome = resolveCodexHome(),
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): CodexBinding | null {
  const bindingPath = join(codexHome, "agent-bindings", `${encodeURIComponent(agentName)}.json`);
  try {
    const binding = JSON.parse(readText(bindingPath)) as {
      thread_id?: unknown;
      socket_path?: unknown;
    };
    if (typeof binding.thread_id !== "string" || !binding.thread_id) return null;
    return {
      threadId: binding.thread_id,
      ...(typeof binding.socket_path === "string" && binding.socket_path
        ? { socketPath: binding.socket_path }
        : {}),
    };
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
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly connected: Promise<void>;
  private readonly initialized: Promise<void>;
  private abortHandshake?: (error: Error) => void;
  private terminalError?: Error;
  private buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private nextId = 1;
  private readonly onSocketError = (error: Error) => this.fail(error);
  private readonly onSocketClose = () => {
    this.fail(new Error("app-server socket closed"));
    this.socket.off("error", this.onSocketError);
  };
  private readonly onSocketData = (chunk: Buffer) => {
    try {
      this.handleData(chunk);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  constructor(socketPath = resolveCodexSocketPath(), options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs === undefined
      ? resolveCodexNudgeTimeoutMs()
      : validateTimeoutMs(options.timeoutMs);
    this.socket = createConnection(socketPath);
    this.socket.on("error", this.onSocketError);
    this.socket.once("close", this.onSocketClose);
    this.connected = this.handshake();
    this.initialized = this.connected
      .then(() => this.requestRaw("initialize", {
        clientInfo: { name: "agents_nudge_bridge", title: "Agents Nudge Bridge", version: "1.0.0" },
      }))
      .then(() => this.notify("initialized", {}))
      .catch((error: Error) => {
        this.fail(error);
        throw error;
      });
    // The bridge may fail before its first request. Keep the original rejection
    // for request() while marking the eager initialization promise as handled.
    void this.initialized.catch(() => {});
  }

  get closed(): boolean {
    return this.terminalError !== undefined;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.initialized;
    return this.requestRaw(method, params);
  }

  close(): void {
    this.fail(new Error("app-server socket closed"));
  }

  private handshake(): Promise<void> {
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("connect", onConnect);
        this.socket.off("data", onHandshake);
        this.abortHandshake = undefined;
      };
      const onConnect = () => {
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
      };
      const onHandshake = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headers = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 4);
        const accepted = headers.toLowerCase().includes("101 switching protocols")
          && headers.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`);
        if (!accepted) {
          this.fail(new Error(`app-server WebSocket handshake failed: ${headers.split("\r\n")[0]}`));
          return;
        }
        this.handshakeDone = true;
        cleanup();
        this.socket.on("data", this.onSocketData);
        if (this.buffer.length > 0) this.onSocketData(Buffer.alloc(0));
        resolve();
      };
      const timer = setTimeout(() => {
        this.fail(new Error(`app-server WebSocket handshake timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.abortHandshake = (error) => {
        cleanup();
        reject(error);
      };
      this.socket.once("connect", onConnect);
      this.socket.on("data", onHandshake);
    });
  }

  private requestRaw(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`app-server ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(encodeClientTextFrame(JSON.stringify({ method, id, params })));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.terminalError) throw this.terminalError;
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
      else if (opcode === 0x8) this.fail(new Error("app-server socket closed"));
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
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "app-server request failed"));
    else pending.resolve(message.result);
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.abortHandshake?.(error);
    this.socket.off("data", this.onSocketData);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.socket.destroy();
  }
}

function validateTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("AGENTS_CODEX_NUDGE_TIMEOUT_MS must be a positive finite number");
  }
  return timeoutMs;
}

export function resolveCodexNudgeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return validateTimeoutMs(env.AGENTS_CODEX_NUDGE_TIMEOUT_MS === undefined
    ? 1000
    : Number(env.AGENTS_CODEX_NUDGE_TIMEOUT_MS));
}

export function resolveCodexSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (env.AGENTS_CODEX_APP_SERVER_SOCKET) return env.AGENTS_CODEX_APP_SERVER_SOCKET;
  if (env.CODEX_APP_SERVER_SOCKET) return env.CODEX_APP_SERVER_SOCKET;
  return join(resolveCodexHome(env, home), "app-server-control", "app-server-control.sock");
}

export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return env.AGENTS_CODEX_HOME || env.CODEX_HOME || join(home, ".codex");
}
