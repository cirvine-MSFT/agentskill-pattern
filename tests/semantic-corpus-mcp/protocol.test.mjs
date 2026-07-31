import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createDispatcher } from "../../tools/semantic-corpus-mcp/protocol.mjs";
import { createRun, scenarioInput } from "./fixtures.mjs";

const server = fileURLToPath(
  new URL("../../tools/semantic-corpus-mcp/server.mjs", import.meta.url),
);

test("fails closed before MCP startup without launcher sandbox evidence", async (t) => {
  const run = await createRun();
  t.after(() => run.cleanup());
  const env = { ...process.env };
  delete env.SEMANTIC_CORPUS_SANDBOX_CONFIG;
  delete env.SEMANTIC_CORPUS_SANDBOX_TOKEN;
  const child = spawn(process.execPath, [server], {
    cwd: run.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 78);
  assert.match(stderr, /SANDBOX_REQUIRED/);
  assert.equal(child.stdout.read(), null);
});

test("stdio server starts only with launcher evidence and serves MCP", async (t) => {
  const run = await createRun();
  t.after(() => run.cleanup());
  const child = spawn(process.execPath, [server], {
    cwd: run.cwd,
    env: run.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const response = new Promise((resolve) => {
    lines.once("line", (line) => resolve(JSON.parse(line)));
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })}\n`,
  );
  assert.equal((await response).result.serverInfo.name, "semantic-corpus");
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(stderr, "");
});

test("implements MCP with only request-bound narrow tools", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(async () => {
    await service.close();
    await run.cleanup();
  });
  const responses = [];
  const dispatch = createDispatcher(service, (message) => responses.push(message));
  let id = 0;
  async function request(method, params = {}) {
    id += 1;
    await dispatch({ jsonrpc: "2.0", id, method, params });
    return responses.find((message) => message.id === id);
  }

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.equal(initialized.result.serverInfo.version, "2.0.0");

  const listed = await request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "read_request",
      "list_contract_files",
      "read_contract_file",
      "write_scenario_input",
      "write_scenario_manifest",
    ],
  );
  assert.equal(
    listed.result.tools.some((tool) => /initialize|oracle|expected|shell|execute/i.test(tool.name)),
    false,
  );
  const inputTool = listed.result.tools.find(
    (tool) => tool.name === "write_scenario_input",
  );
  assert.deepEqual(inputTool.inputSchema.required, ["scenarioId", "config"]);
  assert.equal(inputTool.inputSchema.additionalProperties, false);
  assert.equal(inputTool.inputSchema.properties.config.additionalProperties, false);
  assert.equal(
    inputTool.inputSchema.properties.config.properties.profile.additionalProperties,
    false,
  );
  assert.equal(inputTool.inputSchema.properties.scenarioId.enum.length, 40);
  assert.equal(inputTool.inputSchema.properties.scenarioId.enum[0], "scenario-001");
  assert.equal(inputTool.inputSchema.properties.scenarioId.enum.at(-1), "scenario-040");

  const contract = await request("tools/call", {
    name: "list_contract_files",
    arguments: {},
  });
  assert.deepEqual(
    contract.result.structuredContent.files.map((file) => file.path),
    ["request.json", "rules.md", "schemas/v1.json"],
  );
  assert.equal(contract.result.structuredContent.requestHash, run.requestHash);

  const pinned = await request("tools/call", {
    name: "read_request",
    arguments: {},
  });
  assert.equal(
    pinned.result.structuredContent.request.requestHash,
    run.requestHash,
  );

  const written = await request("tools/call", {
    name: "write_scenario_input",
    arguments: {
      scenarioId: "scenario-001",
      config: scenarioInput(1),
    },
  });
  assert.equal(written.result.structuredContent.scenarioId, "scenario-001");

  const invalid = await request("tools/call", {
    name: "write_scenario_input",
    arguments: {
      scenarioId: "scenario-002",
      config: { ...scenarioInput(2), expectedOutcome: "v2" },
    },
  });
  assert.equal(invalid.error.code, -32602);
  assert.equal(invalid.error.data.code, "SCHEMA_ERROR");

  const unknownTool = await request("tools/call", {
    name: "initialize_corpus",
    arguments: {},
  });
  assert.equal(unknownTool.error.code, -32602);
  assert.equal(unknownTool.error.data.code, "TOOL_NOT_FOUND");

  const unknownMethod = await request("resources/list");
  assert.equal(unknownMethod.error.code, -32601);
});
