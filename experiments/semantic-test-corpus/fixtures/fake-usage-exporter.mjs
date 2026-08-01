import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));
const contract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));

function row(id, sessionId, agentId, model, createdAt) {
  return {
    id,
    session_id: sessionId,
    turn_index: 0,
    agent_id: agentId,
    parent_tool_call_id: agentId,
    model,
    input_tokens: agentId ? 200 : 100,
    output_tokens: agentId ? 20 : 10,
    cache_read_tokens: 100,
    cache_write_tokens: 10,
    reasoning_tokens: 5,
    total_nano_aiu: 1000000000,
    request_multiplier: 1,
    duration_ms: 500,
    time_to_first_token_ms: 100,
    inter_token_latency_ms: 10,
    initiator: agentId ? "sub-agent" : "user",
    api_endpoint: "responses",
    reasoning_effort: "medium",
    finish_reason: agentId ? "stop" : "tool_calls",
    content_filter_triggered: 0,
    token_details_json: "[]",
    created_at: createdAt
  };
}

export function fakeUsageExporter({ cliSessionId, exportedAt }) {
  if (process.env.FAKE_COPILOT_MISSING_USAGE === "1") {
    throw new Error("fixture usage export is unavailable");
  }
  if (process.env.FAKE_COPILOT_MALFORMED_USAGE === "1") {
    return { formatVersion: 1, malformed: true };
  }
  const planned = schedule.runs.find((run) => run.sessionId === cliSessionId);
  if (!planned) throw new Error(`Unknown fixture session ${cliSessionId}`);
  const arm = contract.arms.find((item) => item.id === planned.armId);
  const createdAt = exportedAt ?? new Date().toISOString();
  const parent = row(1, cliSessionId, null, arm.model, createdAt);
  parent.parent_tool_call_id = null;
  const rows = [parent];
  if (arm.delegated) {
    const workerCallId = `${planned.runId}-worker`;
    rows.push(row(2, cliSessionId, workerCallId, arm.workerModel, createdAt));
  }
  if (process.env.FAKE_COPILOT_USAGE_SESSION_MISMATCH === "1") {
    for (const item of rows) item.session_id = `${cliSessionId}-other`;
  }
  return {
    formatVersion: 1,
    source: {
      database: "session-store.db",
      table: "assistant_usage_events",
      exportedAt: createdAt,
      cliSessionId: process.env.FAKE_COPILOT_USAGE_SESSION_MISMATCH === "1"
        ? `${cliSessionId}-other`
        : cliSessionId,
      query: "SELECT exact fixture columns FROM assistant_usage_events WHERE session_id = ? ORDER BY id"
    },
    rows
  };
}
