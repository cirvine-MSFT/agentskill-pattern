import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyStagingState } from "../../tools/semantic-corpus-mcp/launcher.mjs";
import { scenario } from "./fixtures.mjs";

const launcher = fileURLToPath(
  new URL("../../tools/semantic-corpus-mcp/launcher.mjs", import.meta.url),
);
const server = fileURLToPath(
  new URL("../../tools/semantic-corpus-mcp/server.mjs", import.meta.url),
);

function startLauncher(parent, statePath) {
  const cleanupTokenPath = path.join(parent, "cleanup.cap");
  const child = spawn(process.execPath, [launcher], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      ...process.env,
      SEMANTIC_CORPUS_STATE_PATH: statePath,
      SEMANTIC_CORPUS_CLEANUP_TOKEN_PATH: cleanupTokenPath,
      SEMANTIC_CORPUS_SANDBOX_PARENT: parent,
      SEMANTIC_CORPUS_RUN_ID: "B01-A4",
      SEMANTIC_CORPUS_ARM_ID: "4",
      SEMANTIC_CORPUS_BLOCK_ID: "B01",
      SEMANTIC_CORPUS_SEED: "20260729",
      SEMANTIC_CORPUS_LOCK_WAIT_MS: "100",
      SEMANTIC_CORPUS_LOCK_STALE_MS: "1000",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let nextId = 0;
  return {
    child,
    cleanupTokenPath,
    async request(method, params = {}) {
      nextId += 1;
      const id = nextId;
      const response = new Promise((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
  };
}

async function cleanupTree(root) {
  if (process.platform === "win32") {
    spawnSync("icacls.exe", [root, "/reset", "/T", "/C", "/Q"], {
      windowsHide: true,
    });
  } else {
    const visit = async (target) => {
      const stats = await lstat(target);
      if (!stats.isDirectory()) {
        await chmod(target, 0o600);
        return;
      }
      await chmod(target, 0o700);
      for (const entry of await readdir(target)) {
        await visit(path.join(target, entry));
      }
    };
    await visit(root).catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
}

test("direct server and unconfigured launcher both fail closed before MCP startup", async () => {
  for (const executable of [server, launcher]) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("SEMANTIC_CORPUS_")) delete env[key];
    }
    const child = spawn(process.execPath, [executable], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end();
    const [code] = await once(child, "exit");
    assert.equal(code, 78);
    assert.match(stderr, executable === server ? /SANDBOX_REQUIRED/ : /LAUNCH_CONFIG_INVALID/);
    assert.equal(child.stdout.read(), null);
  }
});

test("launcher fails closed when the disposable sandbox would be inside the repository", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "semantic-launcher-failure-"));
  const statePath = path.join(parent, "state.json");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const child = spawn(process.execPath, [launcher], {
    cwd: repository,
    env: {
      ...process.env,
      SEMANTIC_CORPUS_STATE_PATH: statePath,
      SEMANTIC_CORPUS_CLEANUP_TOKEN_PATH: path.join(parent, "cleanup.cap"),
      SEMANTIC_CORPUS_SANDBOX_PARENT: repository,
      SEMANTIC_CORPUS_RUN_ID: "B01-A4",
      SEMANTIC_CORPUS_ARM_ID: "4",
      SEMANTIC_CORPUS_BLOCK_ID: "B01",
      SEMANTIC_CORPUS_SEED: "20260729",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end();
  assert.equal((await once(child, "exit"))[0], 78);
  assert.match(stderr, /CONFINEMENT_UNVERIFIED/);
});

test(
  "launcher signals close MCP gracefully before forced termination",
  { skip: process.platform === "win32" ? "Windows does not deliver POSIX child signals" : false },
  async (t) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "semantic-launcher-signal-"));
    const statePath = path.join(parent, "state.json");
    const client = startLauncher(parent, statePath);
    t.after(() => cleanupTree(parent));
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
    });
    assert.equal(initialized.result.serverInfo.name, "semantic-corpus");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(
      (await readdir(state.stagingRoot)).includes(".corpus.lock"),
      true,
    );
    client.child.kill("SIGTERM");
    assert.equal((await once(client.child, "exit"))[0], 0);
    assert.equal(
      (await readdir(state.stagingRoot)).includes(".corpus.lock"),
      false,
    );
  },
);

test("trusted launcher serves full MCP flow and publishes verified canonical benchmark output", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "semantic-launcher-e2e-"));
  const statePath = path.join(parent, "state.json");
  const client = startLauncher(parent, statePath);
  let stderr = "";
  client.child.stderr.setEncoding("utf8");
  client.child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (client.child.exitCode === null) client.child.kill();
    await cleanupTree(parent);
  });

  const initialized = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "integration-test", version: "1" },
  });
  assert.equal(initialized.result.serverInfo.name, "semantic-corpus");

  const listed = await client.request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "read_request",
      "list_contract_files",
      "read_contract_file",
      "write_scenario",
      "finalize_staging",
    ],
  );
  const writeTool = listed.result.tools.find((tool) => tool.name === "write_scenario");
  const inputSchema = writeTool.inputSchema.properties.scenario.properties.input;
  assert.equal(inputSchema.$id, "v1-config.schema.json");
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(
    inputSchema.properties.features.properties.flags.additionalProperties,
    { type: "boolean" },
  );

  const pinned = await client.request("tools/call", {
    name: "read_request",
    arguments: {},
  });
  const request = pinned.result.structuredContent.request;
  assert.equal(request.targetCount, 60);
  assert.equal(request.runId, "B01-A4");
  assert.equal(request.v1ConfigSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(request.requestHash, pinned.result.structuredContent.requestHash);

  const contract = await client.request("tools/call", {
    name: "list_contract_files",
    arguments: {},
  });
  const paths = contract.result.structuredContent.files.map((entry) => entry.path);
  assert.deepEqual(paths, [
    "arm-contract.json",
    "candidate-manifest.json",
    "contract-manifest.json",
    "mapping-spec.json",
    "request.json",
    "schemas/scenario.schema.json",
    "schemas/staging.schema.json",
    "schemas/v1-config.schema.json",
    "task/shared-task-prompt.txt",
  ]);
  const armContract = await client.request("tools/call", {
    name: "read_contract_file",
    arguments: { path: "arm-contract.json" },
  });
  assert.equal(JSON.parse(armContract.result.structuredContent.content).commonContract.caseCount, 60);

  const invalid = await client.request("tools/call", {
    name: "write_scenario",
    arguments: {
      scenario: {
        ...scenario(0),
        input: { ...scenario(0).input, expected: { status: "ok" } },
      },
    },
  });
  assert.equal(invalid.error.code, -32602);
  assert.equal(invalid.error.data.code, "SCHEMA_ERROR");

  for (let index = 0; index < 60; index += 1) {
    const written = await client.request("tools/call", {
      name: "write_scenario",
      arguments: { scenario: scenario(index) },
    });
    assert.equal(written.result.structuredContent.count, index + 1);
  }
  const finalized = await client.request("tools/call", {
    name: "finalize_staging",
    arguments: {},
  });
  const summary = finalized.result.structuredContent;
  assert.deepEqual(
    Object.keys(summary).sort(),
    [
      "count",
      "manifestHash",
      "payloadSha256",
      "requestHash",
      "stagingPath",
      "status",
    ],
  );
  assert.equal(summary.count, 60);
  assert.equal(summary.status, "SUCCESS");
  assert.equal(summary.stagingPath, "corpus-staging/B01-A4.json");

  const cleanupToken = await readFile(client.cleanupTokenPath, "utf8");
  await assert.rejects(
    () => verifyStagingState(statePath, "0".repeat(64), cleanupToken),
    (error) => error.code === "PAYLOAD_HASH_MISMATCH",
  );
  const verified = await verifyStagingState(
    statePath,
    summary.payloadSha256,
    cleanupToken,
  );
  assert.deepEqual(verified, summary);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const payload = JSON.parse(await readFile(state.stagingPath, "utf8"));
  assert.equal(payload.cases.length, 60);
  assert.equal(JSON.stringify(payload).includes('"expected"'), false);
  assert.equal(JSON.stringify(payload).includes('"trace"'), false);
  assert.equal(JSON.stringify(payload).includes('"diagnostics"'), false);

  client.child.stdin.end();
  const [code] = await once(client.child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
});
