// Bus-wide name claims, so two sessions cannot hold one agent name.
//
// Every Claude or Codex session runs its own copy of this server, and the
// in-process owner check never sees the others. agent_id is a hash of
// name@host, so two sessions on one machine that pick the same name get the
// same id and filter each other's beats as their own echo. Piotr saw two
// Alt+K workers both register "hello-test" (15 Nov 2026); a DM to that name
// reached whichever sessions were bound to it.
//
// A JetStream key-value bucket holds one key per name. create() is atomic,
// so of two sessions racing for a name exactly one wins. The holder refreshes
// its claim on a timer; a crashed session's claim ages out after the bucket
// TTL. The bucket lives in memory (see NAMES_BUCKET_BYTES). Names are unique across all groups, because DMs address a name alone.
//
// Fail open: when JetStream is down or misbehaves, registration proceeds as
// before. A broken bucket must never stop an agent from joining the bus.
import { StorageType, type NatsConnection } from "nats";

export const NAMES_BUCKET = "agent_names";
export const CLAIM_TTL_MS = 30_000;
export const CLAIM_REFRESH_MS = 10_000;
// Claims are live state, re-asserted every refresh, so memory storage fits:
// a server restart drops them and the holders take them back within one
// refresh. The bus's file store is fully reserved by its streams (15 Nov).
export const NAMES_BUCKET_BYTES = 1024 * 1024;

export interface ClaimHolder {
  instance: string;
  agent_id: string;
  group: string;
  host: string;
  ts: number;
}

export interface ClaimEntry {
  value: Uint8Array;
  revision: number;
  operation: string;
}

// The slice of a NATS KV the claims use; tests pass an in-memory fake.
export interface ClaimStore {
  create(key: string, value: Uint8Array): Promise<number>;
  get(key: string): Promise<ClaimEntry | null>;
  update(key: string, value: Uint8Array, revision: number): Promise<number>;
  delete(key: string, previousSeq: number): Promise<void>;
}

export type ClaimResult = { ok: true } | { ok: false; holder: ClaimHolder };

// KV keys allow [-/_=.A-Za-z0-9]; base64url maps any name into that set.
export function claimKey(name: string): string {
  return Buffer.from(name, "utf-8").toString("base64url") || "_";
}

// JetStream answers a create() on a live key with "wrong last sequence".
export function isTaken(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /wrong last sequence|key exists/i.test(text);
}

function encode(holder: ClaimHolder): Uint8Array {
  return Buffer.from(JSON.stringify(holder), "utf-8");
}

function decode(value: Uint8Array): ClaimHolder | null {
  try {
    const parsed = JSON.parse(Buffer.from(value).toString("utf-8"));
    return parsed && typeof parsed.instance === "string" ? (parsed as ClaimHolder) : null;
  } catch {
    return null;
  }
}

export class NameClaims {
  private readonly held = new Map<string, { holder: ClaimHolder; revision: number }>();

  constructor(
    private readonly store: () => Promise<ClaimStore | null>,
    private readonly log: (msg: string) => void = (msg) => console.error(`[claims] ${msg}`),
  ) {}

  // Take `name` for holder.instance. Not ok only when another live instance
  // positively holds it; every other failure lets the registration through.
  async claim(name: string, holder: ClaimHolder): Promise<ClaimResult> {
    let store: ClaimStore | null;
    try {
      store = await this.store();
    } catch (err) {
      this.log(`store unavailable, ${name} not claimed: ${String(err)}`);
      return { ok: true };
    }
    if (!store) return { ok: true };
    const key = claimKey(name);
    const data = encode(holder);
    try {
      this.held.set(name, { holder, revision: await store.create(key, data) });
      return { ok: true };
    } catch (err) {
      if (!isTaken(err)) {
        this.log(`claim of ${name} failed open: ${String(err)}`);
        return { ok: true };
      }
    }
    try {
      const entry = await store.get(key);
      const current = entry && entry.operation === "PUT" ? decode(entry.value) : null;
      if (entry && current && current.instance !== holder.instance) {
        return { ok: false, holder: current };
      }
      // Ours already (a re-register), unreadable, or deleted since: take it.
      const revision = entry
        ? await store.update(key, data, entry.revision)
        : await store.create(key, data);
      this.held.set(name, { holder, revision });
      return { ok: true };
    } catch (err) {
      if (isTaken(err)) {
        // Lost a race in the window above: someone else holds it now.
        const entry = await store.get(key).catch(() => null);
        const current = entry ? decode(entry.value) : null;
        if (current && current.instance !== holder.instance) return { ok: false, holder: current };
      }
      this.log(`claim of ${name} failed open: ${String(err)}`);
      return { ok: true };
    }
  }

  // Keep every held claim alive. A claim that aged out is taken again; one
  // another instance took meanwhile is dropped and logged.
  async refreshAll(): Promise<void> {
    for (const [name, { holder, revision }] of [...this.held]) {
      let store: ClaimStore | null = null;
      try {
        store = await this.store();
        if (!store) return;
        const fresh = { ...holder, ts: Date.now() };
        const next = await store.update(claimKey(name), encode(fresh), revision);
        this.held.set(name, { holder: fresh, revision: next });
      } catch {
        this.held.delete(name);
        const again = await this.claim(name, { ...holder, ts: Date.now() });
        if (!again.ok) {
          this.log(`lost ${name} to ${again.holder.host} (${again.holder.instance})`);
        }
      }
    }
  }

  // Give the name back, only if this instance still holds that revision.
  async release(name: string): Promise<void> {
    const mine = this.held.get(name);
    if (!mine) return;
    this.held.delete(name);
    try {
      const store = await this.store();
      await store?.delete(claimKey(name), mine.revision);
    } catch {
      // Someone else holds it now, or the store is down; the TTL cleans up.
    }
  }

  holds(name: string): boolean {
    return this.held.has(name);
  }
}

// The real store: a JetStream KV bucket on the shared connection.
export function kvStore(nc: NatsConnection, bucket: string = process.env.AGENTS_NAMES_BUCKET || NAMES_BUCKET): () => Promise<ClaimStore | null> {
  let opening: Promise<ClaimStore> | null = null;
  return () => {
    if (!opening) {
      opening = nc.jetstream().views.kv(bucket, {
        ttl: CLAIM_TTL_MS, history: 1, storage: StorageType.Memory, max_bytes: NAMES_BUCKET_BYTES,
      }).then((kv) => ({
        create: (key, value) => kv.create(key, value),
        get: async (key) => {
          const entry = await kv.get(key);
          return entry ? { value: entry.value, revision: entry.revision, operation: entry.operation } : null;
        },
        update: (key, value, revision) => kv.update(key, value, revision),
        delete: (key, previousSeq) => kv.delete(key, { previousSeq }),
      }));
      opening.catch(() => { opening = null; });
    }
    return opening;
  };
}
