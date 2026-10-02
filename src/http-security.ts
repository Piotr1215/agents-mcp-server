import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export interface HttpSecurityPolicy {
  host: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}

interface HostAuthority {
  hostname: string;
  port?: number;
  authority: string;
}

type HttpRequestHeaders = Pick<IncomingMessage, "headers"> & Partial<Pick<IncomingMessage, "rawHeaders">>;

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// Keep Host parsing independent of URL's shorthand IPv4 and credential parsing.
function parseHostAuthority(value: string): HostAuthority | null {
  if (!value || /[\s\\/@?#,]/.test(value)) return null;

  let hostname: string;
  let portText: string | undefined;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(value);
    if (!match || match[1].includes("%") || isIP(match[1]) !== 6) return null;
    try {
      hostname = new URL(`http://[${match[1]}]`).hostname.slice(1, -1);
    } catch {
      return null;
    }
    portText = match[2];
  } else {
    const match = /^([^:]+)(?::([0-9]+))?$/.exec(value);
    if (!match) return null;
    hostname = match[1].toLowerCase();
    portText = match[2];
    if (isIP(hostname) !== 4) {
      if (hostname.length > 253 || /^[0-9.]+$/.test(hostname)) return null;
      const labels = hostname.split(".");
      if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    }
  }

  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  const formattedHost = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return { hostname, port, authority: port === undefined ? formattedHost : `${formattedHost}:${port}` };
}

// An Origin has only a scheme and authority, with no credentials or URL suffix.
function parseOrigin(value: string): string | null {
  const match = /^(https?):\/\/(.+)$/.exec(value);
  if (!match) return null;
  const host = parseHostAuthority(match[2]);
  if (!host) return null;
  try {
    const url = new URL(`${match[1]}://${host.authority}`);
    const expectedHost = isIP(host.hostname) === 6 ? `[${host.hostname}]` : host.hostname;
    return url.hostname === expectedHost ? url.origin : null;
  } catch {
    return null;
  }
}

// Reject invalid settings at boot instead of silently weakening the boundary.
function readList(value: string, name: string, parse: (entry: string) => string | null): string[] {
  const entries: string[] = [];
  for (const entry of value.split(",")) {
    const parsed = parse(entry.trim());
    if (parsed === null) throw new Error(`${name} contains an invalid entry.`);
    entries.push(parsed);
  }
  return [...new Set(entries)];
}

// Remote binding requires a deliberate Host list; browser origins are opt-in.
export function readHttpSecurityPolicy(env: Record<string, string | undefined> = process.env): HttpSecurityPolicy {
  const configuredHost = env.AGENTS_HTTP_HOST === undefined ? "127.0.0.1" : env.AGENTS_HTTP_HOST.trim();
  const hostAuthority = isIP(configuredHost) === 6
    ? parseHostAuthority(`[${configuredHost}]`)
    : parseHostAuthority(configuredHost);
  if (!hostAuthority || hostAuthority.port !== undefined || configuredHost.startsWith("[")) {
    throw new Error("AGENTS_HTTP_HOST must be a hostname or IP address without a port.");
  }
  const host = hostAuthority.hostname;
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (!loopback && env.AGENTS_HTTP_ALLOWED_HOSTS === undefined) {
    throw new Error("Set AGENTS_HTTP_ALLOWED_HOSTS when AGENTS_HTTP_HOST binds beyond loopback.");
  }
  const allowedHosts = env.AGENTS_HTTP_ALLOWED_HOSTS === undefined
    ? [...LOOPBACK_HOSTS]
    : readList(env.AGENTS_HTTP_ALLOWED_HOSTS, "AGENTS_HTTP_ALLOWED_HOSTS", (entry) => parseHostAuthority(entry)?.authority ?? null);
  const allowedOrigins = !env.AGENTS_HTTP_ALLOWED_ORIGINS?.trim()
    ? []
    : readList(env.AGENTS_HTTP_ALLOWED_ORIGINS, "AGENTS_HTTP_ALLOWED_ORIGINS", parseOrigin);
  return { host, allowedHosts, allowedOrigins };
}

// rawHeaders preserves duplicates that Node may discard from headers.host.
function duplicateHeader(req: HttpRequestHeaders, name: string): boolean {
  let count = 0;
  for (let index = 0; index < (req.rawHeaders?.length ?? 0); index += 2) {
    if (req.rawHeaders?.[index].toLowerCase() === name && ++count > 1) return true;
  }
  return false;
}

// Call before reading bodies or creating MCP sessions for every HTTP method.
export function validateHttpRequest(req: HttpRequestHeaders, policy: HttpSecurityPolicy): string | null {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || duplicateHeader(req, "host")) return "Forbidden: invalid Host header.";
  const host = parseHostAuthority(hostHeader);
  const hostAllowed = host && policy.allowedHosts.some((entry) => {
    const allowed = parseHostAuthority(entry);
    return allowed && allowed.hostname === host.hostname && (allowed.port === undefined || allowed.port === host.port);
  });
  if (!hostAllowed) return "Forbidden: Host is not allowed.";

  const originHeader = req.headers.origin;
  if (duplicateHeader(req, "origin")) return "Forbidden: invalid Origin header.";
  if (originHeader !== undefined) {
    const origin = typeof originHeader === "string" ? parseOrigin(originHeader) : null;
    if (!origin || !policy.allowedOrigins.includes(origin)) return "Forbidden: Origin is not allowed.";
  }
  return null;
}
