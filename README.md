# Agents MCP Server

MCP server for agent-to-agent communication over NATS with live session push via Claude Code Channels. State lives in local DuckDB; transport is single-bus (`AGENTS_NATS_URL`); delivery is uniform for local and cross-host targets.

## Design Principles

Built following [Block's MCP Playbook](https://engineering.block.xyz/blog/blocks-playbook-for-designing-mcp-servers):

1. **Outcomes, not operations** - One tool = one agent story
2. **Flatten arguments** - Primitives, enums, strong defaults
3. **Instructions are context** - Descriptions are prompts for LLMs
4. **Respect token budget** - Self-report `_meta`, track metrics
5. **Curate ruthlessly** - Fewer tools = less LLM decision overhead

## Prerequisites

- Node.js >= 18
- DuckDB CLI
- A NATS server reachable via `AGENTS_NATS_URL`

## Install / Update

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

1. Verifies prereqs: `git`, `node >= 18`, `npm`, `duckdb`, `jq`. Hard-fails with a clear message if any are missing.
2. Clones (first run) or fast-forward pulls (subsequent runs) into `~/.local/share/agents-mcp-server` (override with `--dir` or `AGENTS_MCP_DIR`).
3. Runs `npm install`, which triggers the `prepare` script (`tsc`) — **no manual `npm run build` step**, ever.
4. Writes/updates the `mcpServers.agents` entry in `~/.claude.json` using `jq` (idempotent, preserves every other entry). Backs up the file to `~/.claude.json.bak-<epoch>` before writing.

### Prefer to review before running

Same effect, more paranoid:

```bash
curl -fsSL https://raw.githubusercontent.com/Piotr1215/agents-mcp-server/main/scripts/install.sh -o install.sh
less install.sh
bash install.sh --nats-url=nats://your-endpoint:4222
```

### Local development

For hacking on the server itself, clone the repo directly and use npm link as before — the `prepare` script means every `npm install` rebuilds, and `npm run build` / `npm test` still work normally. Only the symlink-path `.claude.json` entry needs adjusting to point at your dev checkout.

## Configuration

The installer writes this automatically. Shown here for reference:

```json
{
  "mcpServers": {
    "agents": {
      "command": "node",
      "args": ["/home/you/.local/share/agents-mcp-server/build/index.js"],
      "env": {
        "AGENTS_NATS_URL": "nats://nats.example:4222"
      }
    }
  }
}
```

`AGENTS_NATS_URL` is **required** — the server is single-bus: DMs, channels, broadcasts, and presence all flow through NATS. Session push lights up on `agent_register`; before that the session is send-only and all traffic still lands in DuckDB for `*_history` reads.

## `snd` CLI

`snd` is published by the installer as a bin alongside the server:

```
snd <agent> <msg...>          DM to agent
snd -t <agent> <msg...>       DM (explicit)
snd -g <group> <msg...>       broadcast to group
snd --human … <msg...>        prefix payload with [HUMAN] (wrapper does this for interactive use)
```

Only dependency is `AGENTS_NATS_URL`. One binary, one code path, callable from cron, shells, editor plugins.

## Real-time session push

`agent_register` both joins the conversation and binds the session's identity. From that point on, in the same process:

- DMs where `to_agent == your name` arrive as `<channel source="agents" kind="dm" …>` tags.
- Broadcasts where `group == your group` arrive as `<channel source="agents" kind="broadcast" …>` tags.
- Channel posts arrive as `<channel source="agents" kind="channel" …>` tags.

No second MCP process, no `comms_bind` call — the tools process and the channel source are the same binary. Echo suppression happens at the handler: you never see your own outbound message pushed back at you.

Sessions that haven't called `agent_register` yet stay send-only; inbound still lands in DuckDB for catch-up reads via `channel_history` / `dm_history` / `group_history`, so nothing is lost.

## Tools

All tools use `name` for identification (agents know their names from prompts).

Every response includes `_meta: { chars, lines, ms }` for token awareness.

### agent_register

Register as an agent. Returns peers in your group.

```typescript
{ name: "researcher", description: "Finds information", group?: "default" }
// Returns: { agent_id: "researcher-a1b2", group: "default", peers: [...] }
```

### agent_deregister

Unregister when done. Idempotent - succeeds even if already gone.

```typescript
{ name: "researcher" }
```

### agent_broadcast

Send message to all other agents.

```typescript
{ name: "researcher", message: "Found the data", priority?: "normal", group?: "all" }
```

### agent_dm

Direct message to specific agent.

```typescript
{ name: "researcher", to: "analyst", message: "Check this" }
```

### agent_discover

List active agents.

```typescript
{ include_stale?: false, group?: "research" }
```

### agent_groups

List groups with agent counts.

```typescript
{}
```

### channel_send

Post to a channel.

```typescript
{ name: "researcher", channel: "general", message: "Update complete" }
```

### channel_history

Get channel messages. Use `detailed: true` for full metadata.

```typescript
{ channel: "general", limit?: 50, detailed?: false }
// detailed=false: "[12:30:45] researcher: message"
// detailed=true: { channel, count, messages: [{ id, timestamp, from, content }] }
```

### dm_history

Get DM history. Use `detailed: true` for full metadata.

```typescript
{ name: "researcher", with_agent: "analyst", limit?: 50, detailed?: false }
```

### channel_list

List channels with message counts.

```typescript
{}
```

### messages_since

Poll for new messages (for TUI).

```typescript
{ since_id?: 0, limit?: 100 }
```

### tool_metrics

Analyze tool usage over time.

```typescript
{ days?: 7 }
// Returns: tool_name, call_count, avg_chars, total_chars, error_count
```

## How It Works

Single bus: everything (presence, DMs, broadcasts, channel posts) flows through NATS on `AGENTS_NATS_URL`. Local DuckDB is a per-host cache for history reads, not a delivery plane.

### State & persistence

1. `agent_register` inserts a row in DuckDB; that row is the binding between agent name and the current session.
2. Every outbound `agent_broadcast` / `agent_dm` / `channel_send` writes to the local DuckDB so `*_history` tools keep working offline.
3. Inbound messages from other hosts are mirrored into the local DuckDB on receive (same-host echoes skip the write — the publisher already stored the row).
4. `tool_metrics` reports per-tool usage from that same DuckDB.

### NATS transport (delivery plane)

When the server starts with `AGENTS_NATS_URL`, four subjects light up:

- **Presence** — every registered agent publishes a beat on `agents.presence` every 10s, TTL 30s. `agent_discover` merges remote peers from the cache.
- **Channel posts** — `channel_send` publishes to `agents.channel.<base64url(name)>`. All hosts subscribe and replicate into their local DuckDB so `channel_history` sees cross-host traffic.
- **DMs** — `agent_dm` publishes to `agents.dm.<base64url(to_agent)>`. Delivery is uniform: same-host and cross-host take the same path.
- **Broadcasts** — `agent_broadcast` publishes to `agents.broadcast.<base64url(group)>`. Group-bound sessions receive as `<channel kind="broadcast">`.

Sessions bound via `agent_register` get DMs and broadcasts pushed straight into the transcript as `<channel>` tags — no polling. The publisher's own messages are filtered at the handler so you don't see yourself echoed back.

### Channels source (real-time session push)

`build/channel.js` is a separate stdio MCP, spawned per session via `claude --dangerously-load-development-channels server:agents-channel`. It declares the experimental `claude/channel` capability and subscribes to `agents.channel.*`. On every remote message it emits a `notifications/claude/channel` event with `{content, meta}` — Claude Code renders that as `<channel source="agents-channel" channel="…" from_agent="…" origin_host="…" origin_ts="…">body</channel>` in the live transcript. No polling, no `snd`, sub-second round-trip.

### End-to-end trace

```
bob channel_send("#eng", …)         [pop-os]
   │
   ├──► pop-os DuckDB   (local history row)
   │
   └──► NATS publish agents.channel.<b64url(#eng)>
                          │
           ┌──────────────┴──────────────┐
           ▼                             ▼
  agents-mcp-server (tools)     agents-channel (source)
  on serval                      on serval
       │                              │
       ▼                              ▼
  serval DuckDB row        notifications/claude/channel
  (channel_history reads           │
   here)                           ▼
                      <channel …>body</channel> in
                      john-dev's session, live
```

## Token Efficiency

Every response includes `_meta`:
```
Active agents (2):
- alice: active | group: default
- bob: active | group: default
---
_meta: {"chars":95,"lines":3,"ms":12}
```

After a week, analyze with `tool_metrics(days: 7)`:
```
Tool metrics (last 7 days):
- agent_broadcast: 50 calls, avg 68 chars, total 3400 chars
- agent_discover: 20 calls, avg 150 chars, total 3000 chars
Total: 70 calls, 6400 chars (~1600 tokens)
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
