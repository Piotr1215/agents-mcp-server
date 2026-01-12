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
      "args": ["/path/to/agents-mcp-server/build/index.js"]
    }
  }
}
```

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

1. Agents register via `agent_register` - stored in DuckDB
2. Hook captures tmux pane_id for message delivery
3. Broadcasts/DMs delivered via `snd --pane <target> <message>`
4. All messages logged to DB with timestamps
5. Metrics tracked per tool call for optimization analysis

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
