import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RpcMessage {
  id?: number;
  method: string;
  params: Record<string, unknown>;
}

export function serverFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.from([0x81, 126, 0, 0]);
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

export async function createCodexPeer(options: {
  handshake?: "accept" | "silent" | "reject" | "close";
  initialize?: "respond" | "silent" | "error";
  onRequest?: (message: RpcMessage, socket: Socket, connection: number) => void;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agents-codex-test-"));
  const socketPath = join(directory, "peer.sock");
  const sockets: Socket[] = [];
  const messages: RpcMessage[] = [];
  const records: Array<{ connection: number; message: RpcMessage }> = [];
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const server = createServer((socket) => {
    const connection = sockets.length;
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("close", markClosed);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (options.handshake === "silent") return;
        if (options.handshake === "close") {
          socket.end();
          return;
        }
        if (options.handshake === "reject") {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        const key = /Sec-WebSocket-Key: ([^\r]+)/i.exec(buffer.subarray(0, end).toString())![1];
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        const maskLength = (buffer[1] & 0x80) !== 0 ? 4 : 0;
        if (buffer.length < offset + maskLength + length) return;
        const mask = buffer.subarray(offset, offset + maskLength);
        offset += maskLength;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        if (maskLength) {
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        if (opcode !== 0x1) continue;
        const message = JSON.parse(payload.toString()) as RpcMessage;
        messages.push(message);
        records.push({ connection, message });
        if (message.method === "initialized") markReady();
        else if (message.method === "initialize") {
          if (options.initialize === "silent") continue;
          socket.write(serverFrame(options.initialize === "error"
            ? { id: message.id, error: { message: "initialize rejected" } }
            : { id: message.id, result: {} }));
        } else options.onRequest?.(message, socket, connection);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  return { socketPath, sockets, messages, records, ready, closed, close };
}
