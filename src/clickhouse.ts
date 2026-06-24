import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { config } from "./config.js";

let client: ClickHouseClient | null = null;

/** Lazily create a singleton ClickHouse client. */
export function getClient(): ClickHouseClient {
  if (!client) {
    client = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.username,
      password: config.clickhouse.password,
      database: config.clickhouse.database,
      clickhouse_settings: {
        max_execution_time: config.clickhouse.maxExecutionTimeSeconds,
      },
    });
  }
  return client;
}

/**
 * Run a parameterized SELECT and return rows as objects.
 *
 * Always use `params` with `{param_name:Type}` placeholders in `sql` rather
 * than string interpolation — ClickHouse binds them server-side, which avoids
 * SQL injection from tool arguments.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const resultSet = await getClient().query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });
  return resultSet.json<T>();
}

/** Verify connectivity; throws if ClickHouse is unreachable. */
export async function ping(): Promise<void> {
  const result = await getClient().ping();
  if (!result.success) {
    throw new Error(`ClickHouse ping failed: ${String(result.error)}`);
  }
}

export async function closeClient(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
