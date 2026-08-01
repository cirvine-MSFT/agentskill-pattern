#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));
const contract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));

function value(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("GitHub Copilot CLI 1.0.77.\nRun 'copilot update' to check for updates.\n");
  process.exit(0);
}

if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(`Usage: copilot [options]
  -p, --prompt <text>
  --session-id <uuid>
  --model <model>
  --agent <agent>
  --output-format <format>
  -C <directory>
  --allow-all-tools
  --available-tools <tools>
  --additional-mcp-config <config>
  --disable-builtin-mcps
  --disable-mcp-server <server>
  --disallow-temp-dir
  --no-custom-instructions
  --no-ask-user
  --no-remote-export
`);
  process.exit(0);
}

if (args[0] === "mcp" && args[1] === "list") {
  if (process.env.FAKE_COPILOT_MCP_LIST_FAILURE === "1") {
    process.stderr.write("fixture MCP enumeration failure\n");
    process.exit(2);
  }
  const collision = process.env.FAKE_COPILOT_MCP_COLLISION === "1"
    ? "  semantic-corpus (local)\n"
    : "";
  process.stdout.write(`Configured MCP servers:\n  azure (local)\n  playwright (local)\n${collision}`);
  process.exit(0);
}

if (args.includes("create-session")) {
  throw new Error("The removed create-session command must never be used");
}

const prompt = value("-p");
const cliSessionId = value("--session-id");
const parentModel = value("--model");
const candidateRoot = resolve(value("-C"));
if (!prompt || !cliSessionId || !parentModel || !args.includes("--allow-all-tools")
  || value("--output-format") !== "json") {
  throw new Error("Unsupported fake Copilot prompt invocation");
}
const planned = schedule.runs.find((run) => run.sessionId === cliSessionId);
if (!planned) throw new Error(`Unknown predetermined session UUID ${cliSessionId}`);
const arm = contract.arms.find((item) => item.id === planned.armId);
const workerModel = arm.workerModel ?? null;
const workerCallId = `${planned.runId}-worker`;
const terminal = "corpus-staging - 0 scenarios - FAILURE: SCHEMA_ERROR";
const taskPrompt = readFileSync(resolve(candidateRoot, contract.commonContract.taskArtifact), "utf8");
const start = Date.parse(
  process.env.FAKE_COPILOT_START_ISO ?? "2026-08-01T01:00:00.000Z"
) + planned.globalOrder * 10_000;
const timestamp = (offset) => new Date(start + offset).toISOString();
let sequence = 0;
const event = (type, data, options = {}) => ({
  type,
  data,
  ...(options.agentId ? { agentId: options.agentId } : {}),
  id: `${planned.runId}-${sequence += 1}`,
  timestamp: timestamp(options.offset ?? sequence * 100)
});

if (process.env.FAKE_COPILOT_CREATE_FAILURE === "1") {
  process.stderr.write("fixture prompt process failed after durable start\n");
  process.exit(23);
}

const events = [
  event("user.message", { content: prompt }),
  event("assistant.turn_start", { turnId: "0" }),
  event("model.call_start", { turnId: "0", model: parentModel })
];

if (arm.delegated) {
  events.push(
    event("assistant.message", {
      messageId: `${planned.runId}-parent-tool-message`,
      model: parentModel,
      content: "",
      toolRequests: []
    }),
    event("tool.execution_start", {
      toolCallId: `${planned.runId}-skill`,
      toolName: "skill",
      arguments: { skill: "semantic-test-corpus" },
      model: parentModel
    }),
    event("skill.invoked", { name: "semantic-test-corpus" }),
    event("tool.execution_complete", {
      toolCallId: `${planned.runId}-skill`,
      success: true,
      result: { content: "loaded" },
      model: parentModel
    }),
    event("tool.execution_start", {
      toolCallId: workerCallId,
      toolName: "task",
      arguments: {
        name: planned.runId.toLowerCase(),
        description: "Generate bounded corpus",
        agent_type: arm.agentName,
        mode: "sync",
        prompt: taskPrompt
      },
      model: parentModel
    }),
    event("subagent.started", {
      toolCallId: workerCallId,
      agentName: arm.agentName,
      model: workerModel
    }, { agentId: workerCallId }),
    event("model.call_start", { turnId: "0", model: workerModel }, {
      agentId: workerCallId
    })
  );
}

const semanticAgentId = arm.delegated ? workerCallId : null;
const semanticModel = arm.delegated ? workerModel : parentModel;
events.push(
  event("tool.execution_start", {
    toolCallId: `${planned.runId}-list`,
    toolName: "semantic-corpus-list_contract_files",
    arguments: {},
    model: semanticModel,
    ...(semanticAgentId ? { parentToolCallId: semanticAgentId } : {})
  }, { agentId: semanticAgentId }),
  event("tool.execution_complete", {
    toolCallId: `${planned.runId}-list`,
    success: true,
    result: { content: "{\"files\":[\"request.json\"]}" },
    model: semanticModel,
    ...(semanticAgentId ? { parentToolCallId: semanticAgentId } : {})
  }, { agentId: semanticAgentId }),
  event("tool.execution_start", {
    toolCallId: `${planned.runId}-write`,
    toolName: "semantic-corpus-write_scenario_input",
    arguments: { scenarioId: "scenario-001", config: {} },
    model: semanticModel,
    ...(semanticAgentId ? { parentToolCallId: semanticAgentId } : {})
  }, { agentId: semanticAgentId }),
  event("tool.execution_complete", {
    toolCallId: `${planned.runId}-write`,
    success: false,
    result: { error: { code: "SCHEMA_ERROR", message: "fixture rejection" } },
    model: semanticModel,
    ...(semanticAgentId ? { parentToolCallId: semanticAgentId } : {})
  }, { agentId: semanticAgentId })
);

if (arm.delegated) {
  events.push(
    event("assistant.message", {
      messageId: `${planned.runId}-worker-message`,
      model: workerModel,
      content: terminal,
      toolRequests: [],
      parentToolCallId: workerCallId
    }, { agentId: workerCallId }),
    event("subagent.completed", {
      toolCallId: workerCallId,
      agentName: arm.agentName,
      model: workerModel,
      totalToolCalls: 2,
      totalTokens: 220
    }, { agentId: workerCallId }),
    event("tool.execution_complete", {
      toolCallId: workerCallId,
      success: true,
      result: { content: terminal, detailedContent: terminal },
      model: parentModel
    }),
    event("assistant.turn_end", { turnId: "0" }),
    event("assistant.turn_start", { turnId: "1" }),
    event("model.call_start", { turnId: "1", model: parentModel }),
    event("assistant.message", {
      messageId: `${planned.runId}-parent-final`,
      model: parentModel,
      content: terminal,
      toolRequests: []
    }),
    event("assistant.turn_end", { turnId: "1" })
  );
} else {
  events.push(
    event("assistant.message", {
      messageId: `${planned.runId}-parent-final`,
      model: parentModel,
      content: terminal,
      toolRequests: []
    }),
    event("assistant.turn_end", { turnId: "0" })
  );
}

const resultSessionId = process.env.FAKE_COPILOT_EVENTS_SESSION_MISMATCH === "1"
  ? `${cliSessionId.slice(0, -1)}0`
  : cliSessionId;
events.push({
  type: "result",
  timestamp: timestamp(5000),
  sessionId: resultSessionId,
  exitCode: 0,
  usage: {
    premiumRequests: 1,
    totalApiDurationMs: 1000,
    sessionDurationMs: 5000,
    codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] }
  }
});

if (process.env.FAKE_COPILOT_MISSING_EVENT_MODEL === "1") {
  const modelEvent = events.find((item) => item.type === "model.call_start");
  delete modelEvent.data.model;
}
if (process.env.FAKE_COPILOT_DUPLICATE_TOOL_COMPLETION === "1") {
  const completion = events.find((item) => item.type === "tool.execution_complete");
  events.splice(-1, 0, structuredClone(completion));
}

if (process.env.FAKE_COPILOT_UNEXPECTED_STAGING === "1") {
  const sandbox = JSON.parse(
    readFileSync(process.env.SEMANTIC_CORPUS_SANDBOX_CONFIG, "utf8")
  );
  const scenarios = resolve(sandbox.roots.staging.path, "scenarios");
  mkdirSync(scenarios, { recursive: true });
  writeFileSync(
    resolve(scenarios, "unexpected.json"),
    `${JSON.stringify({ unexpected: true })}\n`,
    { flag: "wx" }
  );
}

if (process.env.FAKE_COPILOT_MALFORMED_EVENTS === "1") {
  process.stdout.write("{\"type\":\"user.message\"\n");
} else {
  for (const item of events) emit(item);
}
