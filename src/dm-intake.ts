import { spawn } from "node:child_process";

export interface DmRecord { from: string; to: string; body: string; id: string; ts: string }

export function shouldRouteWorkerDm(from: string, to: string): boolean {
  return process.env.AGENTS_INTAKE_DM !== "0" && to === "triage" && !/^(human|intake$|rsi$|ledger$)/.test(from);
}

// Intake decides; any failure leaves the existing delivery path in charge.
export async function resolveWorkerDm(from: string, to: string, body: string, id: string, ts: string): Promise<"resolved" | "show" | "fallback"> {
  if (!shouldRouteWorkerDm(from, to)) return "fallback";
  const record: DmRecord = { from, to, body, id, ts };
  const event = { specversion: "1.0", id: record.id, source: "agent-dm", type: "agent-dm.message", time: record.ts,
    line: `${from} -> ${to}: ${body}`, body, meta: { from, to, message_id: record.id, ts: record.ts } };
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const finish = (value: "resolved" | "show" | "fallback") => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const child = spawn("intake", ["route", "agent-dm", "--record-json", "-", "--no-deliver"], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish("fallback"); }, 3000);
    child.on("error", () => finish("fallback"));
    child.stdin.on("error", () => finish("fallback"));
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 65536) { child.kill(); finish("fallback"); } });
    child.on("close", (code) => {
      if (code !== 0) return finish("fallback");
      try {
        const v = JSON.parse(output);
        if (v.terminal === "resolved" || v.terminal === "dropped") return finish("resolved");
        finish(v.terminal === "shown_gordon" && v.correlation_id === id ? "show" : "fallback");
      } catch { finish("fallback"); }
    });
    child.stdin.end(JSON.stringify(event));
  });
}
