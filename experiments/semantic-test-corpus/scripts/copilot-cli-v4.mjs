import { createHash } from "node:crypto";

export const COPILOT_VERSION = "1.0.77";
export const PROTOCOL_ID = "semantic-test-corpus-execution-v4";
export const MCP_TOOL_NAMES = [
  "semantic-corpus-list_contract_files",
  "semantic-corpus-read_contract_file",
  "semantic-corpus-write_scenario_input",
  "semantic-corpus-write_scenario_manifest"
];

const REQUIRED_HELP_FLAGS = [
  "-p, --prompt",
  "--session-id",
  "--model",
  "--agent",
  "--output-format",
  "-C <directory>",
  "--allow-all-tools",
  "--available-tools",
  "--additional-mcp-config",
  "--disable-builtin-mcps",
  "--disable-mcp-server",
  "--disallow-temp-dir",
  "--no-custom-instructions",
  "--no-ask-user",
  "--no-remote-export"
];

export function predeterminedSessionId(runNamespace, runId) {
  const bytes = createHash("sha256")
    .update(`${runNamespace}\0${runId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

export function parseCopilotJsonl(bytes) {
  return bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event.type !== "string") {
        throw new Error("event type is missing");
      }
      return event;
    } catch (error) {
      throw new Error(`Copilot JSONL line ${index + 1} is invalid: ${error.message}`);
    }
  });
}

export function resultEvent(events, expectedSessionId) {
  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1) {
    throw new Error(`Copilot JSONL requires exactly one result event; found ${results.length}`);
  }
  const result = results[0];
  if (result.sessionId !== expectedSessionId) {
    throw new Error("Copilot result sessionId differs from the predetermined UUID");
  }
  if (!Number.isInteger(result.exitCode)) {
    throw new Error("Copilot result event lacks an integer exitCode");
  }
  return result;
}

export function parseMcpList(stdout) {
  const names = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s{2}([A-Za-z0-9._-]+)\s+\((?:local|remote)\)\s*$/u.exec(line);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

export function inspectHelp(help) {
  const missingFlags = REQUIRED_HELP_FLAGS.filter((flag) => !help.includes(flag));
  const hasFabricatedSubcommand = /^\s{2}create-session(?:\s|$)/mu.test(help);
  return {
    requiredFlagsPresent: missingFlags.length === 0,
    missingFlags,
    fabricatedCreateSessionPresent: hasFabricatedSubcommand
  };
}

export function availableToolsForArm(arm) {
  return arm.delegated
    ? ["skill", "task", ...MCP_TOOL_NAMES]
    : [...MCP_TOOL_NAMES];
}

export function buildCopilotArgs({
  prompt,
  sessionId,
  model,
  reasoningEffort,
  topLevelAgent = null,
  candidateRoot,
  mcpConfigPath,
  disabledMcpServers = [],
  availableTools
}) {
  if (!prompt || !sessionId || !model || !candidateRoot || !mcpConfigPath
    || (reasoningEffort !== null && typeof reasoningEffort !== "string")) {
    throw new Error("Prompt, session UUID, model, candidate root, and MCP config are required");
  }
  const args = [
    "-p", prompt,
    "--session-id", sessionId,
    "--model", model,
    ...(topLevelAgent ? ["--agent", topLevelAgent] : []),
    "--output-format", "json",
    "-C", candidateRoot,
    "--allow-all-tools",
    `--available-tools=${availableTools.join(",")}`,
    "--additional-mcp-config", `@${mcpConfigPath}`,
    "--disable-builtin-mcps",
    ...disabledMcpServers.flatMap((server) => ["--disable-mcp-server", server]),
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export",
    "--no-auto-update",
    "--context", "default",
    ...(reasoningEffort === null ? [] : ["--effort", reasoningEffort])
  ];
  return args;
}
