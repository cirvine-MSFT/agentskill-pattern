import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(
  new URL("../../tools/semantic-corpus-mcp/server.mjs", import.meta.url),
);

async function startClient(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "semantic-corpus-protocol-"));
  await mkdir(path.join(cwd, "corpus-contract"));
  await mkdir(path.join(cwd, "corpus-staging"));
  await writeFile(path.join(cwd, "corpus-contract", "rules.md"), "rules");

  const child = spawn(process.execPath, [server], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });

  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId;
    nextId += 1;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 5_000);
      pending.set(id, {
        resolve(message) {
          clearTimeout(timeout);
          resolve(message);
        },
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) {
      await once(child, "exit");
    }
    assert.equal(stderr, "");
    await rm(cwd, { recursive: true, force: true });
  });
  return { child, cwd, request };
}

test("implements initialize, tools/list, tools/call, and JSON-RPC errors", async (t) => {
  const client = await startClient(t);
  const initialized = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.equal(initialized.result.serverInfo.name, "semantic-corpus");

  client.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const listed = await client.request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "list_contract_files",
      "read_contract_file",
      "write_scenario_input",
      "write_scenario_manifest",
    ],
  );
  assert.equal(
    listed.result.tools.some((tool) => /shell|execute|expected|oracle/i.test(tool.name)),
    false,
  );

  const contract = await client.request("tools/call", {
    name: "list_contract_files",
    arguments: {},
  });
  assert.equal(contract.result.isError, false);
  assert.equal(contract.result.structuredContent.files[0].path, "rules.md");

  const read = await client.request("tools/call", {
    name: "read_contract_file",
    arguments: { path: "rules.md" },
  });
  assert.equal(read.result.structuredContent.content, "rules");

  const written = await client.request("tools/call", {
    name: "write_scenario_input",
    arguments: {
      scenarioId: "protocol-scenario",
      input: { id: "protocol-scenario", enabled: true },
    },
  });
  assert.equal(written.result.isError, false);
  assert.equal(
    written.result.structuredContent.path,
    "corpus-staging/scenarios/protocol-scenario.json",
  );

  const denied = await client.request("tools/call", {
    name: "read_contract_file",
    arguments: { path: "../outside" },
  });
  assert.equal(denied.result.isError, true);
  assert.equal(JSON.parse(denied.result.content[0].text).error.code, "PATH_ESCAPE");

  const unknownTool = await client.request("tools/call", {
    name: "run_oracle",
    arguments: {},
  });
  assert.equal(unknownTool.error.code, -32602);
  assert.equal(unknownTool.error.data.code, "TOOL_NOT_FOUND");

  const invalidArguments = await client.request("tools/call", {
    name: "read_contract_file",
    arguments: {},
  });
  assert.equal(invalidArguments.error.code, -32602);
  assert.equal(invalidArguments.error.data.code, "SCHEMA_ERROR");

  const unknownMethod = await client.request("resources/list");
  assert.equal(unknownMethod.error.code, -32601);
});
