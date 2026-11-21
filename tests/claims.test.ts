import { describe, expect, it } from "vitest";
import { claimKey, isTaken, NameClaims, type ClaimHolder, type ClaimStore } from "../src/claims.js";

// In-memory KV with JetStream's create/update/delete revision semantics.
function fakeStore() {
  const keys = new Map<string, { value: Uint8Array; revision: number; operation: string }>();
  let seq = 0;
  const store: ClaimStore & { expire(key: string): void; keys: typeof keys } = {
    keys,
    async create(key, value) {
      const cur = keys.get(key);
      if (cur && cur.operation === "PUT") throw new Error(`wrong last sequence: ${cur.revision}`);
      keys.set(key, { value, revision: ++seq, operation: "PUT" });
      return seq;
    },
    async get(key) {
      return keys.get(key) ?? null;
    },
    async update(key, value, revision) {
      const cur = keys.get(key);
      if (!cur || cur.revision !== revision) throw new Error(`wrong last sequence: ${cur?.revision ?? 0}`);
      keys.set(key, { value, revision: ++seq, operation: "PUT" });
      return seq;
    },
    async delete(key, previousSeq) {
      const cur = keys.get(key);
      if (!cur || cur.revision !== previousSeq) throw new Error(`wrong last sequence: ${cur?.revision ?? 0}`);
      keys.set(key, { value: new Uint8Array(), revision: ++seq, operation: "DEL" });
    },
    expire(key) {
      keys.delete(key);
    },
  };
  return store;
}

const holder = (instance: string, host = "serval", group = "adhoc"): ClaimHolder => ({
  instance, agent_id: `x-${instance}`, group, host, ts: 1,
});

describe("NameClaims", () => {
  it("lets one session hold a name and refuses a second, naming the holder", async () => {
    const store = fakeStore();
    const a = new NameClaims(async () => store);
    const b = new NameClaims(async () => store);
    expect(await a.claim("hello-test", holder("A"))).toEqual({ ok: true });
    const second = await b.claim("hello-test", holder("B", "serval", "tasks"));
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.holder.instance).toBe("A");
    expect(b.holds("hello-test")).toBe(false);
  });

  it("refuses the name in every group, since DMs address a name alone", async () => {
    const store = fakeStore();
    await new NameClaims(async () => store).claim("intake", holder("A", "serval", "tasks"));
    const other = await new NameClaims(async () => store).claim("intake", holder("B", "mac", "adhoc"));
    expect(other.ok).toBe(false);
  });

  it("of two sessions racing for a name, exactly one wins", async () => {
    const store = fakeStore();
    const results = await Promise.all(["A", "B", "C"].map((i) =>
      new NameClaims(async () => store).claim("dup", holder(i))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("lets the same session register the name again", async () => {
    const store = fakeStore();
    const a = new NameClaims(async () => store);
    await a.claim("n", holder("A"));
    expect(await a.claim("n", holder("A"))).toEqual({ ok: true });
  });

  it("frees the name on release, and never releases another holder's claim", async () => {
    const store = fakeStore();
    const a = new NameClaims(async () => store);
    const b = new NameClaims(async () => store);
    await a.claim("n", holder("A"));
    await a.release("n");
    expect(await b.claim("n", holder("B"))).toEqual({ ok: true });
    await a.release("n"); // no longer held by A: a no-op
    expect((await new NameClaims(async () => store).claim("n", holder("C"))).ok).toBe(false);
  });

  it("keeps a claim alive on refresh and takes back one that aged out", async () => {
    const store = fakeStore();
    const a = new NameClaims(async () => store);
    await a.claim("n", holder("A"));
    const before = store.keys.get(claimKey("n"))!.revision;
    await a.refreshAll();
    expect(store.keys.get(claimKey("n"))!.revision).toBeGreaterThan(before);
    store.expire(claimKey("n"));
    await a.refreshAll();
    expect(a.holds("n")).toBe(true);
    expect((await new NameClaims(async () => store).claim("n", holder("B"))).ok).toBe(false);
  });

  it("drops and logs a claim another session took after it aged out", async () => {
    const store = fakeStore();
    const logs: string[] = [];
    const a = new NameClaims(async () => store, (m) => logs.push(m));
    await a.claim("n", holder("A"));
    store.expire(claimKey("n"));
    await new NameClaims(async () => store).claim("n", holder("B", "mac"));
    await a.refreshAll();
    expect(a.holds("n")).toBe(false);
    expect(logs.join(" ")).toMatch(/lost n to mac/);
  });

  it("fails open when the store is missing, down or errors", async () => {
    expect(await new NameClaims(async () => null).claim("n", holder("A"))).toEqual({ ok: true });
    const logs: string[] = [];
    const down = new NameClaims(async () => { throw new Error("no jetstream"); }, (m) => logs.push(m));
    expect(await down.claim("n", holder("A"))).toEqual({ ok: true });
    const broken: ClaimStore = {
      create: async () => { throw new Error("timeout"); },
      get: async () => null, update: async () => 1, delete: async () => {},
    };
    expect(await new NameClaims(async () => broken, (m) => logs.push(m)).claim("n", holder("A"))).toEqual({ ok: true });
    expect(logs).toHaveLength(2);
  });

  it("takes over a claim whose value cannot be read", async () => {
    const store = fakeStore();
    await store.create(claimKey("n"), Buffer.from("not json"));
    expect(await new NameClaims(async () => store).claim("n", holder("A"))).toEqual({ ok: true });
  });

  it("maps any name to a valid KV key and spots JetStream's taken error", () => {
    expect(claimKey("hello-test")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(claimKey("#eng ü")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(claimKey("")).toBe("_");
    expect(isTaken(new Error("wrong last sequence: 4"))).toBe(true);
    expect(isTaken(new Error("timeout"))).toBe(false);
  });
});
