#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args[0] === "--version") {
  process.stdout.write("fake-copilot 1.0.0\n");
  process.exit(0);
}

if (args[0] === "benchmark-capabilities") {
  process.stdout.write(`${JSON.stringify({
    atomicCreateSession: true,
    localExecution: true,
    promptFile: true,
    parentModel: true,
    customAgent: true,
    fixedModelCustomAgent: true,
    rawEvents: true,
    usageExport: true,
    preSessionFailureReceipt: true,
    zeroUsageReceipt: true
  })}\n`);
  process.exit(0);
}

if (args[0] === "benchmark-preflight-arm5") {
  process.stdout.write(`${JSON.stringify({
    atomicKickoff: args.includes("--atomic-kickoff"),
    selectedAgent: value("--agent"),
    observedWorkerModel: value("--worker-model"),
    workerSessionId: "fake-arm5-preflight-worker"
  })}\n`);
  process.exit(0);
}

if (args[0] !== "create-session") throw new Error("Unsupported fake CLI command");
if (process.env.FAKE_COPILOT_CREATE_FAILURE === "1") {
  process.stdout.write(`${JSON.stringify({
    receiptKind: "authoritative-pre-session-failure",
    receiptId: "fixture-create-failure",
    phase: "create_session",
    kickoffStarted: false,
    sessionCreated: false,
    usage: {
      aiCredits: 0,
      premiumRequests: null,
      nanoAiu: 0,
      modelTokens: 0,
      completionCount: 0
    }
  })}\n`);
  process.stderr.write("fixture pre-session creation failure\n");
  process.exit(23);
}
const runId = value("--run-id");
const candidateCommit = value("--candidate-commit");
const promptPath = resolve(value("--prompt-file"));
const taskPath = resolve(value("--task-file"));
const eventsPath = resolve(value("--events-out"));
const usagePath = resolve(value("--usage-out"));
const parentModel = value("--model");
const projectId = value("--project-id");
const armId = Number(runId.slice(-1));
const workerModel = armId === 5 ? "claude-haiku-4.5" : parentModel;
const cliSessionId = `fake-cli-${runId}`;
const appSessionId = `fake-app-${runId}`;
const workerCallId = `fake-worker-${runId}`;
const agentName = armId === 5 ? "semantic-test-corpus-haiku" : "semantic-test-corpus";
const terminal = "corpus-staging - 0 scenarios - FAILURE: SCHEMA_ERROR";
const taskPrompt = readFileSync(taskPath, "utf8");
const start = Date.parse("2026-07-31T21:00:00.000Z") + Number(value("--global-order")) * 60_000;
const timestamp = (offset) => new Date(start + offset).toISOString();
const events = [
  {
    type: "session.start",
    data: {
      sessionId: cliSessionId,
      selectedModel: parentModel,
      context: { headCommit: candidateCommit }
    },
    id: `${runId}-session`,
    timestamp: timestamp(0),
    parentId: null
  },
  {
    type: "assistant.turn_start",
    data: { turnId: "0", model: parentModel },
    id: `${runId}-turn-start`,
    timestamp: timestamp(1000),
    parentId: `${runId}-session`
  },
  {
    type: "user.message",
    data: { content: readFileSync(promptPath, "utf8") },
    id: `${runId}-kickoff`,
    timestamp: timestamp(500),
    parentId: `${runId}-session`
  },
  {
    type: "tool.execution_start",
    data: {
      toolCallId: `${runId}-skill`,
      toolName: "skill",
      arguments: { skill: "semantic-test-corpus" },
      model: parentModel
    },
    id: `${runId}-skill-start`,
    timestamp: timestamp(1100)
  },
  {
    type: "skill.invoked",
    data: { name: "semantic-test-corpus" },
    id: `${runId}-skill-invoked`,
    timestamp: timestamp(1200)
  },
  {
    type: "tool.execution_complete",
    data: {
      toolCallId: `${runId}-skill`,
      success: true,
      result: { content: "loaded" },
      model: parentModel
    },
    id: `${runId}-skill-complete`,
    timestamp: timestamp(1300)
  },
  {
    type: "tool.execution_start",
    data: {
      toolCallId: workerCallId,
      toolName: "task",
      arguments: {
        agent_type: agentName,
        mode: "sync",
        prompt: taskPrompt
      },
      model: parentModel
    },
    id: `${runId}-task-start`,
    timestamp: timestamp(1400)
  },
  {
    type: "subagent.started",
    data: {
      toolCallId: workerCallId,
      agentName,
      model: workerModel
    },
    agentId: workerCallId,
    id: `${runId}-worker-start`,
    timestamp: timestamp(1500)
  },
  {
    type: "tool.execution_start",
    data: {
      toolCallId: `${runId}-list`,
      toolName: "semantic-corpus-list_contract_files",
      arguments: {},
      model: workerModel,
      mcpServerName: "semantic-corpus",
      mcpToolName: "list_contract_files",
      parentToolCallId: workerCallId
    },
    agentId: workerCallId,
    id: `${runId}-list-start`,
    timestamp: timestamp(1600)
  },
  {
    type: "tool.execution_complete",
    data: {
      toolCallId: `${runId}-list`,
      success: true,
      result: { content: "{\"files\":[\"request.json\",\"mapping-spec.json\"]}" },
      model: workerModel,
      parentToolCallId: workerCallId
    },
    agentId: workerCallId,
    id: `${runId}-list-complete`,
    timestamp: timestamp(1700)
  },
  {
    type: "tool.execution_start",
    data: {
      toolCallId: `${runId}-write`,
      toolName: "semantic-corpus-write_scenario_input",
      arguments: { scenarioId: "scenario-001", config: {} },
      model: workerModel,
      mcpServerName: "semantic-corpus",
      mcpToolName: "write_scenario_input",
      parentToolCallId: workerCallId
    },
    agentId: workerCallId,
    id: `${runId}-write-start`,
    timestamp: timestamp(1800)
  },
  {
    type: "tool.execution_complete",
    data: {
      toolCallId: `${runId}-write`,
      success: false,
      result: { error: { code: "SCHEMA_ERROR", message: "fixture rejection" } },
      model: workerModel,
      parentToolCallId: workerCallId
    },
    agentId: workerCallId,
    id: `${runId}-write-complete`,
    timestamp: timestamp(1900)
  },
  {
    type: "subagent.completed",
    data: {
      toolCallId: workerCallId,
      agentName,
      model: workerModel,
      result: terminal
    },
    agentId: workerCallId,
    id: `${runId}-worker-complete`,
    timestamp: timestamp(2000)
  },
  {
    type: "tool.execution_complete",
    data: {
      toolCallId: workerCallId,
      success: true,
      result: { content: terminal },
      model: parentModel
    },
    id: `${runId}-task-complete`,
    timestamp: timestamp(2100)
  },
  {
    type: "assistant.turn_end",
    data: { turnId: "0", model: parentModel },
    id: `${runId}-turn-end`,
    timestamp: timestamp(2200)
  }
];
const row = (id, agentId, model, input, output, offset) => ({
  id,
  session_id: cliSessionId,
  turn_index: 0,
  agent_id: agentId,
  parent_tool_call_id: agentId,
  model,
  input_tokens: input,
  output_tokens: output,
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
  created_at: timestamp(offset)
});
const usage = {
  formatVersion: 1,
  source: {
    database: "session-store.db",
    table: "assistant_usage_events",
    exportedAt: timestamp(3000),
    cliSessionId,
    query: "SELECT id, session_id, turn_index, agent_id, parent_tool_call_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, duration_ms, time_to_first_token_ms, inter_token_latency_ms, initiator, api_endpoint, reasoning_effort, finish_reason, content_filter_triggered, token_details_json, created_at FROM assistant_usage_events WHERE session_id = ? ORDER BY id"
  },
  rows: [
    row(1, null, parentModel, 100, 10, 1200),
    row(2, workerCallId, workerModel, 200, 20, 2000)
  ]
};
usage.rows[0].parent_tool_call_id = null;
mkdirSync(dirname(eventsPath), { recursive: true });
mkdirSync(dirname(usagePath), { recursive: true });
writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { flag: "wx" });
writeFileSync(usagePath, `${JSON.stringify(usage, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({
  project_session_id: appSessionId,
  project_id: projectId,
  execution_location: "local",
  kickoff_mode: "autopilot",
  kickoff_model: parentModel,
  cli_session_id: cliSessionId,
  started_at: timestamp(0),
  ended_at: timestamp(2200),
  terminal_return: terminal,
  kickoff_consumed: true,
  prompt_sha256_echo: value("--prompt-sha256"),
  prompt_bytes: readFileSync(promptPath).length
})}\n`);
