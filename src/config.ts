/**
 * Centralized configuration, sourced from environment variables.
 *
 * The ClickHouse log table is assumed to follow the OpenTelemetry logs schema,
 * but every column name and the table name are overridable so this server can
 * point at a differently-named table without code changes.
 */

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  // HTTP server
  port: Number(env("PORT", "3003")),
  host: env("HOST", "0.0.0.0"),

  // ClickHouse connection
  clickhouse: {
    url: env("CLICKHOUSE_URL", "http://localhost:8123"),
    username: env("CLICKHOUSE_USER", "default"),
    password: env("CLICKHOUSE_PASSWORD", ""),
    database: env("CLICKHOUSE_DATABASE", "default"),
    // Guard against runaway queries.
    maxExecutionTimeSeconds: Number(env("CLICKHOUSE_MAX_EXECUTION_TIME", "30")),
  },

  // Logs table + column mapping (OpenTelemetry logs schema by default).
  logs: {
    table: env("LOGS_TABLE", "otel_logs"),
    columns: {
      timestamp: env("COL_TIMESTAMP", "Timestamp"),
      severityText: env("COL_SEVERITY_TEXT", "SeverityText"),
      severityNumber: env("COL_SEVERITY_NUMBER", "SeverityNumber"),
      body: env("COL_BODY", "Body"),
      serviceName: env("COL_SERVICE_NAME", "ServiceName"),
      traceId: env("COL_TRACE_ID", "TraceId"),
      spanId: env("COL_SPAN_ID", "SpanId"),
      resourceAttributes: env("COL_RESOURCE_ATTRIBUTES", "ResourceAttributes"),
      logAttributes: env("COL_LOG_ATTRIBUTES", "LogAttributes"),
    },
  },
} as const;

export type LogColumns = typeof config.logs.columns;
