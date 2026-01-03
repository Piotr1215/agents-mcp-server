# NATS MCP Server

MCP server enabling AI assistants to interact with [NATS](https://nats.io/) messaging.

## Prerequisites

- Node.js >= 18
- [NATS CLI](https://github.com/nats-io/natscli) in PATH

```bash
# Install NATS CLI
curl -sf https://binaries.nats.dev/nats-io/natscli/nats@latest | sh
sudo mv nats /usr/local/bin/

# Or via package manager
brew install nats-io/nats-tools/nats  # macOS
go install github.com/nats-io/natscli/nats@latest  # Go
```

## Installation

```bash
git clone https://github.com/Piotr1215/nats-mcp-server.git
cd nats-mcp-server
npm install
npm run build
```

## Configuration

Environment variable `NATS_URL` sets the server (default: `nats://localhost:4222`).

### Claude Code

Add to `~/.claude/claude.json`:

```json
{
  "mcpServers": {
    "nats": {
      "command": "node",
      "args": ["/path/to/nats-mcp-server/build/index.js"],
      "env": {
        "NATS_URL": "nats://your-server:4222"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (same format).

## Tools

### nats_publish

Publish message to a subject.

```typescript
{ subject: "orders.new", message: "order data", headers?: [{key: "id", value: "123"}] }
```

### nats_subscribe

Receive messages from a subject.

```typescript
{ subject: "events.>", count?: 1, timeout?: 5000 }
```

### nats_request

Request-reply pattern.

```typescript
{ subject: "service.time", message: "now?", timeout?: 5000 }
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
