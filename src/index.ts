import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { registerTools } from "./tools.js";
import { ping, closeClient } from "./clickhouse.js";

/** Build a fresh MCP server instance with all tools registered. */
function buildServer(): McpServer {
  const server = new McpServer({
    name: "clickhouse-trace-activity",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

// Active transports, keyed by MCP session ID.
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Liveness/readiness probe — also checks ClickHouse connectivity.
app.get("/health", async (_req: Request, res: Response) => {
  try {
    await ping();
    res.json({ status: "ok", clickhouse: "reachable" });
  } catch (err) {
    res.status(503).json({ status: "degraded", error: String(err) });
  }
});

// Client → server messages.
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports[sessionId] : undefined;

  if (!transport) {
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session. Send an initialize request first." },
        id: null,
      });
      return;
    }

    // New session: create a transport + server pair on initialize.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport!;
      },
    });

    transport.onclose = () => {
      if (transport!.sessionId) delete transports[transport!.sessionId];
    };

    await buildServer().connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

// Server → client stream (SSE) and session teardown share one handler.
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const httpServer = app.listen(config.port, config.host, () => {
  console.log(
    `ClickHouse trace-activity MCP server listening on http://${config.host}:${config.port}/mcp`,
  );
  ping()
    .then(() => console.log("ClickHouse connection OK"))
    .catch((err) => console.warn(`ClickHouse not reachable yet: ${String(err)}`));
});

// Graceful shutdown so `docker stop` exits cleanly.
async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);
  httpServer.close();
  for (const transport of Object.values(transports)) {
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
  }
  await closeClient();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
