#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const schema = JSON.parse(readFileSync(resolve(schemaRoot, "local-usage-export.schema.json"), "utf8"));
export const USAGE_COLUMNS = [
  "id", "session_id", "turn_index", "agent_id", "parent_tool_call_id", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "reasoning_tokens", "total_nano_aiu", "request_multiplier", "duration_ms",
  "time_to_first_token_ms", "inter_token_latency_ms", "initiator", "api_endpoint",
  "reasoning_effort", "finish_reason", "content_filter_triggered",
  "token_details_json", "created_at"
];
const QUERY = `SELECT ${USAGE_COLUMNS.join(", ")} FROM assistant_usage_events WHERE session_id = ? ORDER BY id`;

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function runPython(database, cliSessionId) {
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    "db.row_factory = sqlite3.Row",
    `rows = [dict(row) for row in db.execute(${JSON.stringify(QUERY)}, (sys.argv[2],))]`,
    "print(json.dumps(rows, separators=(',', ':')))"
  ].join("\n");
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  const failures = [];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c", script, database, cliSessionId], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
    failures.push(result.error?.message ?? result.stderr.trim());
  }
  throw new Error(`Unable to export local SQLite usage: ${failures.join("; ")}`);
}

export function createUsageExport(rows, { cliSessionId, exportedAt }) {
  const output = {
    formatVersion: 1,
    source: {
      database: "session-store.db",
      table: "assistant_usage_events",
      exportedAt,
      cliSessionId,
      query: QUERY
    },
    rows
  };
  const errors = validateJsonSchema(output, schema, { schemaDir: schemaRoot });
  if (errors.length > 0) {
    throw new Error(`Local usage export is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  if (rows.some((row) => row.session_id !== cliSessionId)) {
    throw new Error("Local usage export contains a row for another CLI session");
  }
  return output;
}

export function exportLocalUsage({ database, cliSessionId, exportedAt = new Date().toISOString() }) {
  return createUsageExport(runPython(resolve(database), cliSessionId), { cliSessionId, exportedAt });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const database = argument(args, "--database");
  const cliSessionId = argument(args, "--cli-session-id");
  const outputPath = argument(args, "--out");
  if (!database || !cliSessionId || !outputPath) {
    throw new Error("Usage: node scripts/export-local-usage.mjs --database <session-store.db> --cli-session-id <id> --out <usage.json>");
  }
  const output = exportLocalUsage({ database, cliSessionId });
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${output.rows.length} exact assistant_usage_events rows exported for ${cliSessionId}\n`);
}
