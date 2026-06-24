import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { query } from "./clickhouse.js";
import { config } from "./config.js";

const c = config.logs.columns;
const TABLE = `${config.clickhouse.database}.${config.logs.table}`;

/** Standard projection for a single log line, aliased to stable keys. */
const LOG_SELECT = `
  ${c.timestamp}          AS timestamp,
  ${c.traceId}            AS traceId,
  ${c.spanId}             AS spanId,
  ${c.serviceName}        AS serviceName,
  ${c.severityText}       AS severity,
  ${c.severityNumber}     AS severityNumber,
  ${c.body}               AS body,
  ${c.logAttributes}      AS logAttributes,
  ${c.resourceAttributes} AS resourceAttributes
`;

/** Wrap rows in the MCP text-content envelope expected by tool results. */
function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Wrap a plain string in the MCP text-content envelope. */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Render a LogAttributes map compactly, e.g. "{user_id=42, path=/login}".
 *  ClickHouse may return the column as a JSON string or an object — handle both. */
function formatAttributes(attrs: unknown): string {
  let value: unknown = attrs;
  if (typeof attrs === "string") {
    if (attrs.trim() === "" || attrs.trim() === "{}") return "";
    try {
      value = JSON.parse(attrs);
    } catch {
      return attrs; // not JSON — show the raw string as-is
    }
  }
  if (!value || typeof value !== "object") return "";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "";
  return `{${entries
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(", ")}}`;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function registerTools(server: McpServer): void {
  // ── 1. Full activity timeline for one trace ──────────────────────────────
  server.registerTool(
    "get_trace_activity",
    {
      title: "Get trace activity",
      description:
        "Return the full chronological activity (all log entries) for a single trace ID. " +
        "This is the primary way to follow what a user/request did end-to-end across services.",
      inputSchema: {
        traceId: z.string().min(1).describe("The TraceId to look up."),
        limit: z
          .number()
          .int()
          .positive()
          .max(10000)
          .default(1000)
          .describe("Maximum number of log lines to return."),
        order: z
          .enum(["asc", "desc"])
          .default("asc")
          .describe("Chronological order of returned log lines."),
      },
    },
    async ({ traceId, limit, order }) => {
      const rows = await query<{
        timestamp: string;
        serviceName: string;
        severity: string;
        body: string;
        spanId: string;
        logAttributes: unknown;
      }>(
        `SELECT ${LOG_SELECT}
         FROM ${TABLE}
         WHERE ${c.traceId} = {traceId:String}
         ORDER BY ${c.timestamp} ${order === "asc" ? "ASC" : "DESC"}
         LIMIT {limit:UInt32}`,
        { traceId, limit },
      );
      if (rows.length === 0) {
        return errorResult(`No log entries found for trace ID "${traceId}".`);
      }

      const summary = rows
        .map((r, i) => {
          const attrs = formatAttributes(r.logAttributes);
          return (
            `[${i + 1}] ${r.timestamp} | service=${r.serviceName || "?"}` +
            ` | ${r.severity || "?"}` +
            (r.spanId ? ` | span=${r.spanId}` : "") +
            ` | ${r.body}` +
            (attrs ? ` | attrs=${attrs}` : "")
          );
        })
        .join("\n");

      return textResult(
        `Trace ${traceId} — ${rows.length} log entries (${order}):\n\n${summary}`,
      );
    },
  );

  // ── 2. High-level summary of a trace ─────────────────────────────────────
  server.registerTool(
    "get_trace_summary",
    {
      title: "Get trace summary",
      description:
        "Return an aggregate summary for a trace ID: total log lines, time span, " +
        "services involved, error count, and a severity breakdown. Use this first " +
        "to get the shape of a trace before pulling the full timeline.",
      inputSchema: {
        traceId: z.string().min(1).describe("The TraceId to summarize."),
      },
    },
    async ({ traceId }) => {
      const [summary] = await query<{
        total: string;
        firstSeen: string;
        lastSeen: string;
        services: string[];
        errorCount: string;
      }>(
        `SELECT
           count()                                            AS total,
           min(${c.timestamp})                                AS firstSeen,
           max(${c.timestamp})                                AS lastSeen,
           groupUniqArray(${c.serviceName})                   AS services,
           countIf(${c.severityNumber} >= 17)                 AS errorCount
         FROM ${TABLE}
         WHERE ${c.traceId} = {traceId:String}`,
        { traceId },
      );

      if (!summary || summary.total === "0") {
        return errorResult(`No log entries found for trace ID "${traceId}".`);
      }

      const severityBreakdown = await query<{ severity: string; count: string }>(
        `SELECT ${c.severityText} AS severity, count() AS count
         FROM ${TABLE}
         WHERE ${c.traceId} = {traceId:String}
         GROUP BY severity
         ORDER BY count DESC`,
        { traceId },
      );

      return jsonResult({ traceId, ...summary, severityBreakdown });
    },
  );

  // ── 3. Search log lines by filters ───────────────────────────────────────
  server.registerTool(
    "search_logs",
    {
      title: "Search logs",
      description:
        "Search individual log lines across all traces, filtered by service, " +
        "minimum severity, free-text in the body, and/or a time range. Returns " +
        "matching log lines including their trace IDs so you can drill into a full trace.",
      inputSchema: {
        service: z.string().optional().describe("Exact ServiceName to filter by."),
        bodyContains: z
          .string()
          .optional()
          .describe("Case-insensitive substring to match in the log Body."),
        minSeverityNumber: z
          .number()
          .int()
          .optional()
          .describe(
            "Minimum SeverityNumber (e.g. 9=INFO, 13=WARN, 17=ERROR, 21=FATAL).",
          ),
        since: z
          .string()
          .optional()
          .describe("ISO timestamp or ClickHouse datetime; only logs at/after this."),
        until: z
          .string()
          .optional()
          .describe("ISO timestamp or ClickHouse datetime; only logs at/before this."),
        limit: z.number().int().positive().max(5000).default(200),
        order: z.enum(["asc", "desc"]).default("desc"),
      },
    },
    async (args) => {
      const conditions: string[] = [];
      const params: Record<string, unknown> = { limit: args.limit };

      if (args.service) {
        conditions.push(`${c.serviceName} = {service:String}`);
        params.service = args.service;
      }
      if (args.bodyContains) {
        conditions.push(`positionCaseInsensitive(${c.body}, {bodyContains:String}) > 0`);
        params.bodyContains = args.bodyContains;
      }
      if (args.minSeverityNumber !== undefined) {
        conditions.push(`${c.severityNumber} >= {minSeverity:Int32}`);
        params.minSeverity = args.minSeverityNumber;
      }
      if (args.since) {
        conditions.push(`${c.timestamp} >= parseDateTimeBestEffort({since:String})`);
        params.since = args.since;
      }
      if (args.until) {
        conditions.push(`${c.timestamp} <= parseDateTimeBestEffort({until:String})`);
        params.until = args.until;
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await query(
        `SELECT ${LOG_SELECT}
         FROM ${TABLE}
         ${where}
         ORDER BY ${c.timestamp} ${args.order === "asc" ? "ASC" : "DESC"}
         LIMIT {limit:UInt32}`,
        params,
      );
      return jsonResult({ count: rows.length, logs: rows });
    },
  );

  // ── 4. Find distinct trace IDs matching filters ──────────────────────────
  server.registerTool(
    "find_traces",
    {
      title: "Find traces",
      description:
        "Find distinct trace IDs matching filters (service, min severity, body text, " +
        "time range), with per-trace counts and time span. Use this to discover which " +
        "traces to investigate (e.g. 'traces with errors in service X today'), then call " +
        "get_trace_activity on a specific trace ID.",
      inputSchema: {
        service: z.string().optional().describe("Exact ServiceName to filter by."),
        bodyContains: z
          .string()
          .optional()
          .describe("Case-insensitive substring to match in the log Body."),
        minSeverityNumber: z
          .number()
          .int()
          .optional()
          .describe("Minimum SeverityNumber (17=ERROR, 21=FATAL)."),
        since: z.string().optional().describe("ISO/ClickHouse datetime lower bound."),
        until: z.string().optional().describe("ISO/ClickHouse datetime upper bound."),
        limit: z.number().int().positive().max(1000).default(50),
      },
    },
    async (args) => {
      const conditions: string[] = [`${c.traceId} != ''`];
      const params: Record<string, unknown> = { limit: args.limit };

      if (args.service) {
        conditions.push(`${c.serviceName} = {service:String}`);
        params.service = args.service;
      }
      if (args.bodyContains) {
        conditions.push(`positionCaseInsensitive(${c.body}, {bodyContains:String}) > 0`);
        params.bodyContains = args.bodyContains;
      }
      if (args.minSeverityNumber !== undefined) {
        conditions.push(`${c.severityNumber} >= {minSeverity:Int32}`);
        params.minSeverity = args.minSeverityNumber;
      }
      if (args.since) {
        conditions.push(`${c.timestamp} >= parseDateTimeBestEffort({since:String})`);
        params.since = args.since;
      }
      if (args.until) {
        conditions.push(`${c.timestamp} <= parseDateTimeBestEffort({until:String})`);
        params.until = args.until;
      }

      const rows = await query(
        `SELECT
           ${c.traceId}                       AS traceId,
           count()                            AS logCount,
           countIf(${c.severityNumber} >= 17) AS errorCount,
           min(${c.timestamp})                AS firstSeen,
           max(${c.timestamp})                AS lastSeen,
           groupUniqArray(${c.serviceName})   AS services
         FROM ${TABLE}
         WHERE ${conditions.join(" AND ")}
         GROUP BY traceId
         ORDER BY lastSeen DESC
         LIMIT {limit:UInt32}`,
        params,
      );
      return jsonResult({ count: rows.length, traces: rows });
    },
  );

  // ── 5. List known services ───────────────────────────────────────────────
  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "List distinct ServiceName values present in the logs, with recent log counts. " +
        "Useful for discovering what services exist before filtering.",
      inputSchema: {
        sinceHours: z
          .number()
          .positive()
          .default(24)
          .describe("Look back this many hours when counting (default 24)."),
      },
    },
    async ({ sinceHours }) => {
      const rows = await query(
        `SELECT ${c.serviceName} AS service, count() AS logCount
         FROM ${TABLE}
         WHERE ${c.timestamp} >= now() - INTERVAL {hours:UInt32} HOUR
         GROUP BY service
         ORDER BY logCount DESC`,
        { hours: Math.ceil(sinceHours) },
      );
      return jsonResult({ count: rows.length, services: rows });
    },
  );
}
