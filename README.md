# ClickHouse Trace-Activity MCP Server

A custom [Model Context Protocol](https://modelcontextprotocol.io) server that lets
an MCP client (Claude Desktop, Claude Code, etc.) **track a user's activity by trace ID**
from application logs stored in ClickHouse.

It exposes the modern **Streamable HTTP** transport, so it runs as an always-on
service in Docker — start it once and it stays up (auto-restarting on crash or
reboot) until you stop it.

## Tools

| Tool | What it does |
|------|--------------|
| `get_trace_activity` | Full chronological log timeline for one trace ID — the end-to-end story of a request/user across services. |
| `get_trace_summary` | Aggregate view of a trace: total lines, time span, services involved, error count, severity breakdown. |
| `search_logs` | Search individual log lines by service, min severity, body text, and time range. Returns their trace IDs to drill into. |
| `find_traces` | Discover distinct trace IDs matching filters (e.g. "traces with errors in service X today"), with per-trace counts. |
| `list_services` | List distinct `ServiceName` values with recent log counts. |

## Log schema

Defaults to the OpenTelemetry logs schema (table `otel_logs`):

`Timestamp, SeverityText, SeverityNumber, Body, ServiceName, TraceId, SpanId, ResourceAttributes, LogAttributes`

Every column name and the table name are overridable via environment variables
(see `.env.example`) — no code changes needed if your table differs.

## Quick start (Docker)

```bash
cp .env.example .env          # set CLICKHOUSE_URL etc.
docker compose up -d --build  # build + run, detached
```

The server is now at `http://localhost:3003/mcp` and will restart automatically
until you run:

```bash
docker compose down           # stop it
```

Useful:

```bash
docker compose logs -f        # follow logs
curl localhost:3003/health    # health + ClickHouse connectivity check
```

### Connecting to a ClickHouse on your host machine

From inside the container, `localhost` is the container itself. Use
`host.docker.internal` to reach a ClickHouse running on your Mac/Windows host:

```env
CLICKHOUSE_URL=http://host.docker.internal:8123
```

If ClickHouse runs in another Docker network, point `CLICKHOUSE_URL` at that
service name and attach this server to the same network.

## Connecting an MCP client

Point your client at the Streamable HTTP endpoint:

```
http://localhost:3003/mcp
```

For Claude Code:

```bash
claude mcp add --transport http trace-activity http://localhost:3003/mcp
```

For Claude Desktop, add an HTTP MCP server entry with that URL in its config.

## Local development (without Docker)

```bash
nvm use 22
npm install
npm run dev      # tsx watch, hot reload
# or
npm run build && npm start
```

## Configuration

All settings come from environment variables; see `.env.example`. Key ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3003` | HTTP port the server listens on |
| `CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `default` / _empty_ | Credentials |
| `CLICKHOUSE_DATABASE` | `default` | Database holding the logs table |
| `CLICKHOUSE_MAX_EXECUTION_TIME` | `30` | Per-query timeout (seconds) |
| `LOGS_TABLE` | `otel_logs` | Logs table name |
| `COL_*` | OTel names | Per-column overrides (see `.env.example`) |

## Notes

- All tool inputs are bound as ClickHouse **server-side query parameters**, so
  arguments can't be used for SQL injection.
- The server runs as the non-root `node` user inside the container.
- `docker stop` / `docker compose down` sends `SIGTERM`; the server drains MCP
  sessions and closes the ClickHouse client gracefully.
