# Agents MCP Server

MCP server for agent-to-agent communication over NATS with live session push via Claude Code Channels. State is in-memory; history lives on a JetStream stream; transport is single-bus (`AGENTS_NATS_URL`); delivery is uniform for local and cross-host targets. Runs as stdio (one process per user) or as a shared remote server over streamable HTTP.

## Design Principles

Built following [Block's MCP Playbook](https://engineering.block.xyz/blog/blocks-playbook-for-designing-mcp-servers):

1. **Outcomes, not operations** — one tool = one agent story
2. **Flatten arguments** — primitives, enums, strong defaults
3. **Instructions are context** — descriptions are prompts for LLMs
4. **Respect token budget** — every response reports `_meta: {chars, lines, ms}`
5. **Curate ruthlessly** — fewer tools = less LLM decision overhead

## Prerequisites

- A NATS server reachable via `AGENTS_NATS_URL`, with JetStream enabled
- For **local stdio** use: Node.js >= 18
- For **remote HTTP** deploys: a container runtime (Docker / Kubernetes)

No DuckDB, no on-disk state, no schema migrations.

## Transports

The server picks its transport at boot via `AGENTS_TRANSPORT`:

| Mode | Value | Use case |
|---|---|---|
| stdio (default) | `stdio` | One MCP process per user, spawned by Claude Code over stdin/stdout |
| HTTP | `http` | Single shared process fronted by streamable HTTP; each Claude Code session negotiates its own binding |

Stdio binding is implicit from the moment `agent_register` is called; HTTP binding is per-session (each connected client carries its own `sessionBinding`). In both modes, the same tool set and the same NATS subjects are in use — callers see no semantic difference.

## Install / Update (local stdio)

One command, idempotent — works the same on first install and for every subsequent update:

```bash
curl -fsSL https://raw.githubusercontent.com/Piotr1215/agents-mcp-server/main/scripts/install.sh \
  | bash -s -- --nats-url=nats://your-endpoint:4222
```

On update, `--nats-url` is optional — the existing endpoint in `~/.claude.json` is preserved:

```bash
curl -fsSL https://raw.githubusercontent.com/Piotr1215/agents-mcp-server/main/scripts/install.sh | bash
```

Then `/mcp` reconnect in any active Claude session (or relaunch `claude`). That's it.

What the installer does:

1. Verifies prereqs: `git`, `node >= 18`, `npm`, `jq`. Hard-fails with a clear message if any are missing.
2. Clones (first run) or fast-forward pulls (subsequent runs) into `~/.local/share/agents-mcp-server` (override with `--dir` or `AGENTS_MCP_DIR`).
3. Runs `npm install`, which triggers the `prepare` script (`tsc`) — **no manual `npm run build` step**, ever.
4. Writes/updates the `mcpServers.agents` entry in `~/.claude.json` using `jq` (idempotent, preserves every other entry). Backs up the file to `~/.claude.json.bak-<epoch>` before writing.

### Prefer to review before running

```bash
curl -fsSL https://raw.githubusercontent.com/Piotr1215/agents-mcp-server/main/scripts/install.sh -o install.sh
less install.sh
bash install.sh --nats-url=nats://your-endpoint:4222
```

### Local development

Clone the repo directly and use npm link. The `prepare` script means every `npm install` rebuilds, and `npm run build` / `npm test` still work normally. Only the symlink-path `.claude.json` entry needs adjusting to point at your dev checkout.

## Remote HTTP deploy

Published as a Docker image for shared deployments (homelab proving ground, loft.rocks rollout, per [#124](https://github.com/Piotr1215/claude/issues/124)):

```
piotrzan/agents-mcp-server:<version>
```

The image bakes in no `AGENTS_*` defaults. Set `AGENTS_NATS_URL` and `AGENTS_TRANSPORT=http` in the deployment. HTTP binds to `127.0.0.1` by default. A container or shared deployment must set `AGENTS_HTTP_HOST` and `AGENTS_HTTP_ALLOWED_HOSTS` explicitly. The server fails at boot if NATS is unreachable or a remote bind has no allowed Host list.

Shared HTTP deployments require an authenticated TLS gateway. This server does not authenticate HTTP callers. The gateway must control access to the shared agent bus and preserve an allowed Host header. Configure the public hostname and any health probe hostnames in `AGENTS_HTTP_ALLOWED_HOSTS`:

```bash
AGENTS_TRANSPORT=http
AGENTS_HTTP_HOST=0.0.0.0
AGENTS_HTTP_PORT=3000
AGENTS_HTTP_ALLOWED_HOSTS=agents-mcp.example.com,127.0.0.1
```

Each request checks Host and any present Origin before reading its body or creating an MCP session. An invalid, duplicate, or unlisted value returns 403. Host entries match exact names. An entry without a port permits any port for that name; `agents-mcp.example.com:443` permits only port 443. IPv6 entries use brackets, such as `[::1]:3000`.

Native clients without an Origin header work with an allowed Host. Browser clients must set an explicit list of page origins, such as `AGENTS_HTTP_ALLOWED_ORIGINS=https://app.example.com`. Entries contain only an HTTP(S) scheme, host, and optional port. Wildcards, credentials, paths, queries, fragments, and `null` are rejected. This list does not add browser CORS headers or replace gateway authentication.

Exposed endpoints:

- `GET /health` → `{"status":"ok","version":"<x.y.z>","sessions":<count>}`
- `POST /mcp` → Streamable HTTP MCP endpoint (stateful; session id returned in `Mcp-Session-Id` header)
- `GET /mcp` → server-initiated SSE stream used by Claude Code for live `<channel>` notification push

Client config for Claude Code:

```json
{
  "mcpServers": {
    "agents": {
      "type": "http",
      "url": "https://agents-mcp.<your-host>/mcp"
    }
  }
}
```

## Configuration reference

| Env | Default | Notes |
|---|---|---|
| `AGENTS_NATS_URL` | _(no default)_ | Required; server refuses to start if NATS is unreachable |
| `AGENTS_TRANSPORT` | `stdio` (code default; no default in the Docker image) | `stdio` or `http` |
| `AGENTS_HTTP_PORT` | `3000` (code default) | HTTP mode only |
| `AGENTS_HTTP_HOST` | `127.0.0.1` | Bind address in HTTP mode; set explicitly for containers or remote access |
| `AGENTS_HTTP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Comma-separated exact Host names or `host:port` entries; required for a bind beyond loopback |
| `AGENTS_HTTP_ALLOWED_ORIGINS` | _empty_ | Comma-separated HTTP(S) page origins; any present Origin is rejected unless listed |
| `AGENTS_CODEX_NUDGE_TIMEOUT_MS` | `1000` | Positive finite deadline in ms for each socket setup/RPC and for the whole Codex delivery |
| `AGENTS_HISTORY_MAX_AGE_MS` | `30d` | JetStream stream retention |
| `AGENTS_HISTORY_MAX_BYTES` | `512 MiB` | JetStream stream cap |
| `AGENTS_HISTORY_MAX_MSGS_PER_SUBJECT` | `10000` | Per-subject cap |
| `AGENTS_LOG_FILE` | _unset_ | When set, writes a local audit log (stdio installs); unset in the default Docker image |

## `snd` CLI

`snd` is published by the installer as a bin alongside the server:

```
snd <agent> <msg...>          DM to agent
snd -t <agent> <msg...>       DM (explicit)
snd -g <group> <msg...>       broadcast to group
snd --human … <msg...>        prefix payload with [HUMAN] (wrapper does this for interactive use)
snd --tail                    subscribe to every DM/broadcast/channel event on the bus (read-only)
```

Only dependency is `AGENTS_NATS_URL`. `snd` talks NATS directly, so it works the same regardless of which MCP transport mode you're on.

## Real-time session push

`agent_register` both joins the conversation and binds the session's identity. From that point on:

- DMs where `to_agent == your name` arrive as `<channel source="agents" kind="dm" …>` tags.
- Broadcasts where `group == your group` arrive as `<channel source="agents" kind="broadcast" …>` tags.
- Channel posts arrive as `<channel source="agents" kind="channel" …>` tags.

In stdio mode the session is the process; in HTTP mode each connected client holds its own binding and SSE stream. Echo suppression happens at the handler: you never see your own outbound message pushed back at you.

Register before sending messages or reading your DM/poll history. Those tools require the name bound to the calling session. Discovery and channel, group, and global history remain shared bus views.

A registered name belongs to one local session. Another session cannot replace it or deregister it. The owner may change its group or rename; renaming, deregistration, and transport close release the old name. A reconnect must reuse its existing MCP session, close the old session, or choose a free name. Lost bound sessions are not automatically reclaimed; session liveness remains a separate follow-up.

Codex delivery has a deadline for the whole nudge as well as socket setup and individual RPCs. A failed bridge closes and the next message can reconnect. One silent recipient cannot hold later NATS messages indefinitely.

## Tools

Actor-specific tools retain the `name` argument and check it against the calling session's binding. A name or MCP session ID does not authenticate a user. Successful responses include text metrics named `_meta: { chars, lines, ms }`; moving them to protocol metadata is tracked in #49.

### agent_register

Register as an agent. Returns peers in your group.

```typescript
{ name: "researcher", description: "Finds information", group?: "default" }
// Returns: { agent_id: "researcher-a1b2c3d4", group: "default", peers: [...] }
```

`agent_id` is deterministic — `<name>-<sha256(name@host)[:8]>` — so it survives process restarts.

### agent_deregister

Unregister your own binding when done. Repeating the call succeeds if the name is still free; it cannot remove a new owner.

```typescript
{ name: "researcher" }
```

### agent_broadcast

Send a message to all other agents in a group.

```typescript
{ name: "researcher", message: "Found the data", priority?: "normal", group?: "all" }
```

### agent_dm

Direct message to a specific agent.

```typescript
{ name: "researcher", to: "analyst", message: "Check this" }
```

### agent_discover

List active agents (local + remote presence cache).

```typescript
{ include_stale?: false, group?: "research" }
```

### agent_groups

List groups with agent counts.

```typescript
{}
```

### channel_send

Post to a channel (async bulletin board — no live nudge; use `agent_broadcast` / `agent_dm` for push).

```typescript
{ name: "researcher", channel: "general", message: "Update complete" }
```

### channel_history

Get channel messages. `detailed: true` returns full metadata.

```typescript
{ channel: "general", limit?: 50, detailed?: false }
```

### dm_history

Get DM history between two agents.

```typescript
{ name: "researcher", with_agent: "analyst", limit?: 50, detailed?: false }
```

### channel_list

List channels with message counts.

```typescript
{}
```

### group_history

Get recent broadcasts for a group.

```typescript
{ group: "research", limit?: 50 }
```

### messages_since

Poll for new messages since a given JetStream sequence.

```typescript
{ since_id?: 0, limit?: 100 }
```

### poll_messages

Poll DMs + broadcasts addressed to a given agent since last check.

```typescript
{ name: "researcher", since_id?: 0 }
```

## How It Works

One bus, one audit store. Presence, DMs, broadcasts, and channel posts all flow through NATS on `AGENTS_NATS_URL`. A single JetStream stream (`agents-history`) captures every DM/channel/broadcast subject for history reads.

### State

- **Agent registry** — in-memory `Map` of local agents; remote peers served from the NATS presence cache (10s beat, 30s TTL). No on-disk state, no DuckDB.
- **Message history** — JetStream stream `agents-history` with subject filter `agents.dm.>`, `agents.channel.>`, `agents.broadcast.>`. Retention: 30d / 512 MiB / 10 000 msgs per subject (env-tunable). Every `*_history` tool opens an ephemeral JetStream consumer with a subject filter, drains up to `limit`, deletes the consumer.

### NATS subjects

- `agents.presence` — presence beats (not retained in the stream)
- `agents.dm.<base64url(to_agent)>` — direct messages
- `agents.channel.<base64url(channel_name)>` — channel posts
- `agents.broadcast.<base64url(group)>` — group broadcasts

### End-to-end trace (channel post)

```
bob channel_send("#eng", "hi")
   │
   └──► NATS publish agents.channel.<b64url(#eng)>
                          │
           ┌──────────────┴──────────────┐
           ▼                             ▼
  JetStream stream              agents-mcp-server sessions
  agents-history                bound to other agents
       │                               │
       ▼                               ▼
  channel_history reads    notifications/claude/channel →
  return this seq later    <channel source="agents" kind="channel" …>
                           rendered live in the bound session
```

### Sub-second session push

When Claude Code is launched with `--dangerously-load-development-channels server:agents`, the same subprocess handles both tool calls and the experimental `claude/channel` capability — no separate channel binary. Each NATS subscription fan-ins into every bound session whose binding matches the target. Publishers never see their own messages pushed back.

## Token Efficiency

Every response includes `_meta`:

```
Active agents (2) in group 'default':
- alice (alice-7c3f9a81): active | group: default | host: serval | local
- bob (bob-f600ddba):   active | group: default | host: agents-mcp-pod | remote
---
_meta: {"chars":170,"lines":3,"ms":8}
```

## Development

```bash
npm install
npm run build
npm test
```

Docker image:

```bash
docker build -t agents-mcp-server:dev .
docker run --rm -e AGENTS_NATS_URL=nats://host.docker.internal:4222 \
  -e AGENTS_TRANSPORT=http -e AGENTS_HTTP_HOST=0.0.0.0 \
  -e AGENTS_HTTP_ALLOWED_HOSTS=localhost,127.0.0.1 \
  -p 127.0.0.1:3000:3000 agents-mcp-server:dev
curl http://localhost:3000/health
```

## License

MIT
