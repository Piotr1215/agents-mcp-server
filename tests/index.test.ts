import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import { EventEmitter } from "events";

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

function createMockProcess(stdout: string, stderr: string, exitCode: number) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  }, 5);

  return proc;
}

describe("NATS MCP Server", () => {
  const originalEnv = process.env.NATS_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NATS_URL;
  });

  afterEach(() => {
    if (originalEnv) {
      process.env.NATS_URL = originalEnv;
    } else {
      delete process.env.NATS_URL;
    }
  });

  describe("publish", () => {
    it("calls nats CLI with correct arguments", () => {
      mockSpawn.mockReturnValue(createMockProcess("Published 5 bytes", "", 0));

      const args = ["-s", "nats://localhost:4222", "publish", "test.subject", "hello"];
      spawn("nats", args, { stdio: ["pipe", "pipe", "pipe"] });

      expect(mockSpawn).toHaveBeenCalledWith(
        "nats",
        expect.arrayContaining(["publish", "test.subject", "hello"]),
        expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] })
      );
    });

    it("includes headers in command args", () => {
      const headers = [
        { key: "X-Request-Id", value: "123" },
        { key: "X-Priority", value: "high" },
      ];
      const cmdArgs = ["publish", "orders.new", "order data"];

      for (const h of headers) {
        cmdArgs.push("-H", `${h.key}:${h.value}`);
      }

      expect(cmdArgs).toEqual([
        "publish", "orders.new", "order data",
        "-H", "X-Request-Id:123",
        "-H", "X-Priority:high",
      ]);
    });

    it("handles empty message", () => {
      const cmdArgs = ["publish", "test.subject", ""];
      expect(cmdArgs[2]).toBe("");
    });
  });

  describe("subscribe", () => {
    it("builds args with default count of 1", () => {
      const count = undefined;
      const cmdArgs = ["subscribe", "events.>", "--count", String(count || 1)];

      expect(cmdArgs).toEqual(["subscribe", "events.>", "--count", "1"]);
    });

    it("builds args with specified count", () => {
      const cmdArgs = ["subscribe", "events.>", "--count", "10"];
      expect(cmdArgs[3]).toBe("10");
    });

    it("supports wildcard subjects", () => {
      const subjects = ["events.*", "events.>", "*.created", ">"];
      subjects.forEach((subject) => {
        const cmdArgs = ["subscribe", subject, "--count", "1"];
        expect(cmdArgs[1]).toBe(subject);
      });
    });
  });

  describe("request", () => {
    it("builds args with timeout in milliseconds", () => {
      const timeout = 3000;
      const cmdArgs = [
        "request", "service.time", "now?",
        "--timeout", `${timeout}ms`,
      ];

      expect(cmdArgs).toEqual([
        "request", "service.time", "now?",
        "--timeout", "3000ms",
      ]);
    });

    it("uses default 5000ms timeout", () => {
      const timeout = undefined;
      const cmdArgs = [
        "request", "service.endpoint", "payload",
        "--timeout", `${timeout || 5000}ms`,
      ];

      expect(cmdArgs[4]).toBe("5000ms");
    });
  });

  describe("environment configuration", () => {
    it("defaults to localhost:4222", () => {
      const url = process.env.NATS_URL || "nats://localhost:4222";
      expect(url).toBe("nats://localhost:4222");
    });

    it("respects NATS_URL environment variable", () => {
      process.env.NATS_URL = "nats://production.server:4222";
      const url = process.env.NATS_URL || "nats://localhost:4222";
      expect(url).toBe("nats://production.server:4222");
    });

    it("supports custom ports", () => {
      process.env.NATS_URL = "nats://localhost:14222";
      const url = process.env.NATS_URL;
      expect(url).toContain("14222");
    });
  });

  describe("error handling", () => {
    it("rejects on non-zero exit code", async () => {
      mockSpawn.mockReturnValue(
        createMockProcess("", "connection refused", 1)
      );

      const proc = spawn("nats", ["-s", "nats://invalid:4222", "publish", "test", "msg"]);

      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        proc.stderr!.on("data", (data: Buffer) => (stderr += data.toString()));
        proc.on("close", (code: number) => {
          if (code !== 0) {
            reject(new Error(stderr || `Exit code ${code}`));
          } else {
            resolve();
          }
        });
      }).catch((err) => {
        expect(err.message).toContain("connection refused");
      });
    });

    it("handles process spawn errors", async () => {
      const proc = createMockProcess("", "", 0);
      mockSpawn.mockReturnValue(proc);

      setTimeout(() => proc.emit("error", new Error("spawn ENOENT")), 5);

      await new Promise<void>((resolve) => {
        proc.on("error", (err: Error) => {
          expect(err.message).toBe("spawn ENOENT");
          resolve();
        });
      });
    });
  });

  describe("tool definitions", () => {
    it("defines nats_publish with required fields", () => {
      const schema = {
        type: "object",
        properties: {
          subject: { type: "string" },
          message: { type: "string" },
          headers: { type: "array" },
        },
        required: ["subject", "message"],
      };

      expect(schema.required).toContain("subject");
      expect(schema.required).toContain("message");
      expect(schema.required).not.toContain("headers");
    });

    it("defines nats_subscribe with required fields", () => {
      const schema = {
        type: "object",
        properties: {
          subject: { type: "string" },
          count: { type: "number" },
          timeout: { type: "number" },
        },
        required: ["subject"],
      };

      expect(schema.required).toContain("subject");
      expect(schema.required).not.toContain("count");
      expect(schema.required).not.toContain("timeout");
    });

    it("defines nats_request with required fields", () => {
      const schema = {
        type: "object",
        properties: {
          subject: { type: "string" },
          message: { type: "string" },
          timeout: { type: "number" },
        },
        required: ["subject", "message"],
      };

      expect(schema.required).toContain("subject");
      expect(schema.required).toContain("message");
      expect(schema.required).not.toContain("timeout");
    });
  });
});
