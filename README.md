# Agents MCP Server

MCP server for agent-to-agent communication via DuckDB + snd (tmux message injection).

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
- `snd` script in PATH (from `~/.claude/scripts/snd`)

## Installation

```bash
git clone https://github.com/Piotr1215/agents-mcp-server.git
cd agents-mcp-server
npm install
npm run build
```

## Configuration

Add to `~/.claude/claude.json`:

```json
{
  "mcpServers": {
    "agents": {
      "command": "node",
      "args": ["/path/to/agents-mcp-server/build/index.js"],
      "env": {
        "AGENTS_NATS_URL": "nats://nats.example:4222"
      }
    }
  }
}
```

`AGENTS_NATS_URL` is optional. When unset the server runs in local-only mode (DuckDB + `snd`). When set, presence beats and `channel_send` messages are replicated across hosts that share the same NATS.

## Real-time session push (comms)

Channels, DMs, and group broadcasts are async by default — writers hit DuckDB and readers pull via `channel_history` / `dm_history` / `group_history`. For live inbound pushed straight into an open Claude Code session, run the `comms` server as a [Claude Code Channels source](https://code.claude.com/docs/en/channels.md).

Add an entry to your `.mcp.json`:

```json
{
  "mcpServers": {
    "comms": {
      "command": "node",
      "args": ["/path/to/agents-mcp-server/build/comms.js"],
      "env": {
        "AGENTS_NATS_URL": "nats://nats.example:4222"
      }
    }
  }
}
```

Launch Claude Code with comms enabled:

```bash
claude --dangerously-load-development-channels server:comms
```

Identity is bound at runtime — not at launch — because agent names are set by slash commands inside a session, long after the subprocess has spawned. Right after `agent_register`, the session calls:

```
comms_bind(name: "YOUR_NAME", group: "YOUR_GROUP")
```

From then on:
- DMs where `to_agent == YOUR_NAME` arrive as `<channel source="comms" kind="dm" …>` tags.
- Broadcasts where `group == YOUR_GROUP` arrive as `<channel source="comms" kind="broadcast" …>` tags.
- Channel posts (public bulletin boards) always arrive as `<channel source="comms" kind="channel" …>` tags — they don't require binding.

Before `comms_bind` is called, only channel posts flow through. DMs and broadcasts stay off the wire until the session declares identity, so nothing leaks across agents that share a host.

Own-host echoes are filtered in the receive loop so a publisher doesn't receive its own message back as a tag.

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

Three layers. The first runs standalone; the other two light up when `AGENTS_NATS_URL` is set.

### Local (always on)

1. Agents register via `agent_register` — stored in DuckDB.
2. An MCP hook captures the caller's tmux `pane_id` for delivery.
3. `agent_broadcast` and `agent_dm` are pushed via `snd --pane <target> <message>` — direct tmux keystroke injection.
4. Every message is logged to DuckDB with timestamps; `tool_metrics` reports usage.

### NATS transport (cross-host state)

When `AGENTS_NATS_URL` is set, two extra things happen on the tools MCP (`build/index.js`):

- **Presence**: every registered agent publishes a beat on `agents.presence` every 10s, with 30s TTL. `agent_discover` merges remote peers from the cache, tagged `host: <hostname> | remote`.
- **Channel replication**: `channel_send` publishes to `agents.channel.<base64url(name)>` in addition to writing the local row. Every host subscribes to `agents.channel.*` and upserts incoming messages into its own DuckDB (own-host echoes filtered). `channel_history` reads from the local DB and therefore sees cross-host traffic without changes.

DMs and broadcasts are not yet routed over NATS — they stay local-tmux until the next phase.

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
