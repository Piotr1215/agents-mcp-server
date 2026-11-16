import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface DmRecord { from: string; to: string; body: string; id: string; ts: string }

// Intake decides; any failure leaves the existing delivery path in charge.
export async function resolveWorkerDm(from: string, to: string, body: string): Promise<boolean> {
  if (process.env.AGENTS_INTAKE_DM === "0" || to !== "triage" || /^(human|intake$|rsi$|ledger$)/.test(from)) return false;
  const record: DmRecord = { from, to, body, id: randomUUID(), ts: new Date().toISOString() };
  const event = { specversion: "1.0", id: record.id, source: "agent-dm", type: "agent-dm.message", time: record.ts,
    line: `${from} -> ${to}: ${body}`, body, meta: { from, to, message_id: record.id, ts: record.ts } };
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const finish = (value: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const child = spawn("intake", ["route", "agent-dm", "--record-json", "-", "--no-deliver"], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, 3000);
    child.on("error", () => finish(false));
    child.stdin.on("error", () => finish(false));
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 65536) { child.kill(); finish(false); } });
    child.on("close", (code) => {
      if (code !== 0) return finish(false);
      try { const v = JSON.parse(output); finish(v.terminal === "resolved" || v.terminal === "dropped"); } catch { finish(false); }
    });
    child.stdin.end(JSON.stringify(event));
  });
}
