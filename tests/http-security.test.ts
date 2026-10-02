import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { readHttpSecurityPolicy, validateHttpRequest } from "../src/http-security.js";

function request(host: string | string[] | undefined, origin?: string | string[], rawHeaders?: string[]) {
  return {
    headers: { host, origin } as IncomingMessage["headers"],
    rawHeaders,
  };
}

describe("HTTP security configuration", () => {
  it("binds loopback and permits native loopback clients by default", () => {
    const policy = readHttpSecurityPolicy({});
    expect(policy).toEqual({
      host: "127.0.0.1",
      allowedHosts: ["localhost", "127.0.0.1", "[::1]"],
      allowedOrigins: [],
    });
    for (const host of ["localhost", "localhost:3000", "127.0.0.1:54321", "[::1]:3000"]) {
      expect(validateHttpRequest(request(host), policy)).toBeNull();
    }
  });

  it("requires explicit allowed Hosts for a remote bind", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "agents.internal"]) {
      expect(() => readHttpSecurityPolicy({ AGENTS_HTTP_HOST: host })).toThrow(/AGENTS_HTTP_ALLOWED_HOSTS/);
    }
  });

  it("accepts loopback bind addresses without an explicit list", () => {
    for (const host of ["localhost", "127.0.0.2", "::1"]) {
      expect(readHttpSecurityPolicy({ AGENTS_HTTP_HOST: host }).host).toBe(host);
    }
  });

  it("normalizes, deduplicates, and keeps explicit Host ports", () => {
    const policy = readHttpSecurityPolicy({
      AGENTS_HTTP_HOST: "0.0.0.0",
      AGENTS_HTTP_ALLOWED_HOSTS: " agents.example, AGENTS.EXAMPLE, agents.example:443, [0:0:0:0:0:0:0:1]:3000 ",
      AGENTS_HTTP_ALLOWED_ORIGINS: "https://APP.example:443, https://app.example",
    });
    expect(policy.allowedHosts).toEqual(["agents.example", "agents.example:443", "[::1]:3000"]);
    expect(policy.allowedOrigins).toEqual(["https://app.example"]);
  });

  it.each(["", "http://localhost", "localhost:3000", "*.example", "localhost/path", "[::1]", "127.1", "::1%lo0", "fe80::1%eth0"])(
    "rejects invalid bind address %j",
    (host) => expect(() => readHttpSecurityPolicy({ AGENTS_HTTP_HOST: host })).toThrow(/AGENTS_HTTP_HOST/),
  );

  it.each(["", " , ", "*.example", "user@agents.example", "agents.example/path", "http://agents.example", "agents.example:0", "agents.example:65536", "agents.example:", "127.1", "::1", "[::1]%lo0", "[::1%lo0]", "[fe80::1%25eth0]:3000", "agents.example,"])(
    "rejects invalid allowed Host list %j",
    (allowedHosts) => expect(() => readHttpSecurityPolicy({ AGENTS_HTTP_ALLOWED_HOSTS: allowedHosts })).toThrow(/AGENTS_HTTP_ALLOWED_HOSTS/),
  );

  it.each(["null", "*", "ftp://app.example", "https://user@app.example", "https://app.example/", "https://app.example/path", "https://app.example?query", "https://app.example#fragment", "https://app.example,", "https://127.1", "https://0x7f000001", "https://foo.123"])(
    "rejects invalid allowed Origin list %j",
    (origins) => expect(() => readHttpSecurityPolicy({ AGENTS_HTTP_ALLOWED_ORIGINS: origins })).toThrow(/AGENTS_HTTP_ALLOWED_ORIGINS/),
  );
});

describe("HTTP request boundary", () => {
  const local = readHttpSecurityPolicy({});
  const remote = readHttpSecurityPolicy({
    AGENTS_HTTP_HOST: "0.0.0.0",
    AGENTS_HTTP_ALLOWED_HOSTS: "agents.example:443, agents.internal, [::1]:3000",
    AGENTS_HTTP_ALLOWED_ORIGINS: "https://app.example, http://localhost:8080",
  });

  it.each([undefined, "", "evil.example", "localhost.evil.example", "localhost@evil.example", "localhost/evil", "localhost\\evil", "localhost:65536", "localhost:0", "localhost:", "localhost,evil.example", "localhost?query", "localhost#fragment", "localhost.", "127.1", "::1", "[::1", "[::1]evil", "[::1%lo0]", "[::1%25lo0]", "[fe80::1%eth0]:3000", "localhost\t", ["localhost", "evil.example"]])(
    "rejects missing, malformed, or unlisted Host %j",
    (host) => expect(validateHttpRequest(request(host), local)).toMatch(/Host/),
  );

  it("matches the exact hostname and the optional configured port", () => {
    expect(validateHttpRequest(request("AGENTS.EXAMPLE:443"), remote)).toBeNull();
    expect(validateHttpRequest(request("agents.example:80"), remote)).toMatch(/Host/);
    expect(validateHttpRequest(request("agents.example"), remote)).toMatch(/Host/);
    expect(validateHttpRequest(request("agents.internal:54321"), remote)).toBeNull();
    expect(validateHttpRequest(request("[::1]:3000"), remote)).toBeNull();
    expect(validateHttpRequest(request("[::1]:3001"), remote)).toMatch(/Host/);
  });

  it("rejects duplicate Host headers even when Node discarded a duplicate", () => {
    expect(validateHttpRequest(request("localhost", undefined, ["Host", "localhost", "Host", "evil.example"]), local)).toMatch(/Host/);
  });

  it.each(["https://evil.example", "http://localhost", "null", "", ["https://app.example"]])(
    "rejects every present Origin by default: %j",
    (origin) => expect(validateHttpRequest(request("localhost", origin), local)).toMatch(/Origin/),
  );

  it("accepts an exact configured Origin and native clients without Origin", () => {
    expect(validateHttpRequest(request("agents.internal"), remote)).toBeNull();
    expect(validateHttpRequest(request("agents.internal", "https://app.example"), remote)).toBeNull();
    expect(validateHttpRequest(request("agents.internal", "http://localhost:8080"), remote)).toBeNull();
  });

  it.each(["https://app.example.evil", "https://app.example:444", "http://app.example", "https://app.example/", "https://app.example/path", "https://app.example?query", "https://app.example#fragment", "https://user@app.example", "https://app.example https://evil.example", "https://app.example,https://evil.example", "null", "https://app.example\t", "https://foo.123"])(
    "rejects Origin aliases with other hosts, schemes, ports, or URL parts: %j",
    (origin) => expect(validateHttpRequest(request("agents.internal", origin), remote)).toMatch(/Origin/),
  );

  it("rejects duplicate Origin headers", () => {
    expect(validateHttpRequest(request("agents.internal", "https://app.example", ["Host", "agents.internal", "Origin", "https://app.example", "Origin", "https://app.example"]), remote)).toMatch(/Origin/);
  });
});
