// Prometheus metrics surface for agents-mcp-server.
//
// One Registry, one /metrics endpoint, no separate sidecar. The HTTP listener
// in src/index.ts:startHttp serves /metrics on the same port as /mcp and
// /health. Default-on; opt out with AGENTS_METRICS_DISABLED=1 (e.g. when
// running stdio-mode or when something else owns observability).
//
// Two flavors of metric:
//
//   - Snapshot gauges via `collect()` callbacks: session/binding counts,
//     active agents per group. These are derived from in-memory state at
//     scrape time, so there's no drift between scrapes and reality.
//
//   - Counters / histograms updated at the event source: messages sent,
//     tool calls, push fan-out latency, push errors, session age at
//     eviction. These accumulate over the process's lifetime.
import promClient, { Registry, Counter, Gauge, Histogram } from "prom-client";

export const registry = new Registry();

// Default Node runtime metrics (process_cpu_seconds_total, nodejs_heap_*,
// event-loop lag). Cheap, conventional, and the homelab Prom rules already
// pattern-match `process_*` for capacity planning.
promClient.collectDefaultMetrics({ register: registry });

interface SnapshotSources {
  countSessions: () => number;
  countUnboundSessions: () => number;
  countBindingsByGroup: () => Map<string, number>;
  countActiveAgentsByGroup: () => Map<string, number>;
}

let sources: SnapshotSources | null = null;

export function bindSnapshotSources(s: SnapshotSources): void {
  sources = s;
}

new Gauge({
  name: "agents_http_sessions_total",
  help: "Total HTTP session entries currently held by the server (bound + unbound).",
  registers: [registry],
  collect() {
    if (!sources) return;
    this.set(sources.countSessions());
  },
});

new Gauge({
  name: "agents_http_sessions_unbound",
  help: "HTTP sessions that have not called agent_register. Watching this rise is the leak signal.",
  registers: [registry],
  collect() {
    if (!sources) return;
    this.set(sources.countUnboundSessions());
  },
});

new Gauge({
  name: "agents_bindings_total",
  help: "Sessions bound to an agent name, grouped by agent group.",
  labelNames: ["group"],
  registers: [registry],
  collect() {
    if (!sources) return;
    this.reset();
    for (const [group, count] of sources.countBindingsByGroup()) {
      this.set({ group }, count);
    }
  },
});

new Gauge({
  name: "agents_active_agents",
  help: "Active agents (registry + presence cache union), grouped by agent group.",
  labelNames: ["group"],
  registers: [registry],
  collect() {
    if (!sources) return;
    this.reset();
    for (const [group, count] of sources.countActiveAgentsByGroup()) {
      this.set({ group }, count);
    }
  },
});

export const messagesCounter = new Counter({
  name: "agents_messages_total",
  help: "Messages published by this pod, by type.",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const toolCallsCounter = new Counter({
  name: "agents_tool_calls_total",
  help: "Tool invocations through the MCP surface, by tool and outcome.",
  labelNames: ["tool", "status"] as const,
  registers: [registry],
});

export const pushDurationHistogram = new Histogram({
  name: "agents_push_duration_seconds",
  help: "Time spent fanning out one notification to a bound session. Tail latency catches stalled SSE streams.",
  // Buckets tuned for the 1s push timeout: most sub-10ms when healthy,
  // the 1s+ bucket fires when the parallel-push timeout race kicks in.
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const pushErrorsCounter = new Counter({
  name: "agents_push_errors_total",
  help: "Notifications that failed to deliver, by failure kind.",
  labelNames: ["kind"] as const,
  registers: [registry],
});

export const sessionAgeHistogram = new Histogram({
  name: "agents_session_age_seconds",
  help: "Age of an HTTP session at eviction time (sweep or onclose).",
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600, 7200],
  registers: [registry],
});

export async function renderMetrics(): Promise<{ body: string; contentType: string }> {
  return { body: await registry.metrics(), contentType: registry.contentType };
}

export function isEnabled(): boolean {
  return process.env.AGENTS_METRICS_DISABLED !== "1";
}
