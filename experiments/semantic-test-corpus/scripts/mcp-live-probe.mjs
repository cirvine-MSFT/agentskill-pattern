import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EXPECTED_TOOLS = [
  "list_contract_files",
  "read_contract_file",
  "write_scenario_input",
  "write_scenario_manifest"
];

export function probeGeneratedMcp(sandbox, { timeoutMs = 15_000 } = {}) {
  const mcpConfig = JSON.parse(readFileSync(sandbox.mcpConfigPath, "utf8"));
  const server = mcpConfig.mcpServers?.["semantic-corpus"];
  if (!server || typeof server.command !== "string" || !Array.isArray(server.args)) {
    throw new Error("Generated MCP config lacks the semantic-corpus command");
  }
  const input = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "protocol-v4-live-preflight", version: "1" }
      }
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const result = spawnSync(server.command, server.args, {
    cwd: sandbox.runtimeRoot,
    env: {
      ...process.env,
      SEMANTIC_CORPUS_SANDBOX_CONFIG: sandbox.configPath,
      SEMANTIC_CORPUS_SANDBOX_TOKEN: sandbox.token
    },
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Generated semantic-corpus MCP failed startup/handshake: ${
        result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`
      }`
    );
  }
  const responses = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const initialized = responses.find((response) => response.id === 1);
  const listed = responses.find((response) => response.id === 2);
  const tools = listed?.result?.tools?.map((tool) => tool.name);
  if (initialized?.result?.serverInfo?.name !== "semantic-corpus"
    || initialized?.result?.protocolVersion !== "2025-06-18") {
    throw new Error("Generated semantic-corpus MCP initialize response is invalid");
  }
  if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
    throw new Error(`Generated semantic-corpus MCP tools/list differs: ${JSON.stringify(tools)}`);
  }
  return {
    status: "pass",
    serverName: initialized.result.serverInfo.name,
    protocolVersion: initialized.result.protocolVersion,
    tools,
    stderr: result.stderr
  };
}

export { EXPECTED_TOOLS };
