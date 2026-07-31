import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { evaluateIsolationEvidence } from "../../experiments/semantic-test-corpus/scripts/verify-isolation-evidence.mjs";
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
    assert.match(
      stderr,
      executable === server ? /LAUNCH_ATTESTATION_REQUIRED/ : /LAUNCH_CONFIG_INVALID/,
    );
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
  assert.deepEqual(writeTool.inputSchema.properties.scenario, {});

  const pinned = await client.request("tools/call", {
    name: "read_request",
    arguments: {},
  });
  const request = pinned.result.structuredContent.request;
  assert.equal(request.targetCount, 60);
  assert.equal(request.runId, "B01-A4");
  assert.equal(request.v1ConfigSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(
    request.v1ConfigSchema.properties.features.properties.flags.additionalProperties,
    { type: "boolean" },
  );
  assert.equal(request.requestHash, pinned.result.structuredContent.requestHash);

  const contract = await client.request("tools/call", {
    name: "list_contract_files",
    arguments: {},
  });
  const paths = contract.result.structuredContent.files.map((entry) => entry.path);
  assert.deepEqual(paths, [
    "contract/mapping-spec.json",
    "contract-manifest.json",
    "request.json",
    "schemas/scenario.schema.json",
    "schemas/staging.schema.json",
    "schemas/v1-config.schema.json",
    "scripts/validate-staging.mjs",
    "task/delegated-worker-skill.md",
    "task/shared-task-prompt.txt",
    "validators/json-schema.mjs",
    "validators/staging.mjs",
  ]);
  const delegatedSkill = await client.request("tools/call", {
    name: "read_contract_file",
    arguments: { path: "task/delegated-worker-skill.md" },
  });
  assert.match(
    delegatedSkill.result.structuredContent.content,
    /name: semantic-scenario-stager/,
  );

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
      "errorCount",
      "payloadSha256",
      "promotableCases",
      "stagingPath",
      "submittedCases",
    ],
  );
  assert.equal(summary.submittedCases, 60);
  assert.equal(summary.promotableCases, 60);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.stagingPath, "staging/B01-A4.json");

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

  const emitted = (await readFile(state.auditPath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    [...new Set(emitted.filter((event) => event.type === "tool.called")
      .map((event) => event.toolName))].sort(),
    ["file.read", "file.write", "staging.validate"],
  );
  const firstAt = Date.parse(emitted[0].timestamp);
  const lastAt = Date.parse(emitted.at(-1).timestamp);
  const iso = (milliseconds) => new Date(milliseconds).toISOString();
  const runId = "B01-A4";
  const blockId = "B01";
  const armId = 4;
  const parentSessionId = `${runId}-parent`;
  const workerSessionId = `${runId}-worker`;
  const candidateRoot = state.sandboxRoot;
  const evaluatorRoot = fileURLToPath(
    new URL("../../experiments/semantic-test-corpus/evaluator", import.meta.url),
  );
  const stagingPath = path.resolve(candidateRoot, summary.stagingPath);
  const baseAt = firstAt - 120_000;
  const completedAt = lastAt + 120_000;
  const roleEvents = ["parent", "worker"].flatMap((role) => {
    const sessionId = role === "parent" ? parentSessionId : workerSessionId;
    return [
      {
        eventId: `${role}-audit-start`, type: "audit.started",
        timestamp: iso(baseAt + 1_000), sessionId, runId, blockId, armId, role,
      },
      {
        eventId: `${role}-policy`, type: "sandbox.policy.applied",
        timestamp: iso(baseAt + 2_000), sessionId, runId, blockId, armId, role,
        candidateRoot, deniedRoots: [evaluatorRoot],
        filesystemMode: "candidate-root-only", networkMode: "deny",
      },
      {
        eventId: `${role}-created`, type: "session.created",
        timestamp: iso(baseAt + 3_000), sessionId, runId, blockId, armId, role,
        ...(role === "worker" ? { parentSessionId } : {}),
      },
      {
        eventId: `${role}-bound`, type: "model.bound",
        timestamp: iso(baseAt + 4_000), sessionId, runId, blockId, armId, role,
        modelId: "claude-haiku-4.5", atomic: true,
      },
      {
        eventId: `${role}-audit-complete`, type: "audit.completed",
        timestamp: iso(completedAt + 2_000), sessionId, runId, blockId, armId, role,
        filesystemComplete: true, networkComplete: true,
      },
      {
        eventId: `${role}-usage`, type: "usage.reported",
        timestamp: iso(completedAt + 3_000), sessionId, runId, blockId, armId, role,
        totalTokens: 100, intervalStart: iso(baseAt + 4_000),
        intervalEnd: iso(completedAt + 1_000),
      },
    ];
  });
  const schedule = JSON.parse(await readFile(
    fileURLToPath(new URL(
      "../../experiments/semantic-test-corpus/design/schedule.json",
      import.meta.url,
    )),
    "utf8",
  ));
  const starts = schedule.runs.filter((run) => run.blockId === blockId).map((run) => ({
    eventId: `${run.runId}-started`,
    type: "run.started",
    timestamp: iso(baseAt + 10_000 + run.order),
    sessionId: run.runId === runId ? parentSessionId : `${run.runId}-process`,
    processId: `${run.runId}-process`,
    runId: run.runId,
    blockId,
    armId: run.armId,
    role: run.armId === 0 ? "baseline" : "parent",
    sequence: run.order,
  }));
  const skillBytes = await readFile(
    fileURLToPath(new URL(
      "../../experiments/semantic-test-corpus/design/delegated-worker-skill.md",
      import.meta.url,
    )),
  );
  const evidence = {
    formatVersion: 1,
    provider: "github-copilot-platform",
    exportId: "semantic-mcp-integration",
    exportedAt: iso(completedAt + 10_000),
    capturedAt: iso(completedAt + 9_000),
    events: [
      ...roleEvents,
      ...starts,
      {
        eventId: "delegation-invoked", type: "delegation.invoked",
        timestamp: iso(baseAt + 20_000), sessionId: parentSessionId,
        runId, blockId, armId, role: "parent", callId: "delegation",
        workerSessionId, skillName: "semantic-scenario-stager",
        skillSha256: createHash("sha256").update(skillBytes).digest("hex"),
      },
      ...emitted,
      {
        eventId: "delegation-completed", type: "delegation.completed",
        timestamp: iso(completedAt - 1_000), sessionId: parentSessionId,
        runId, blockId, armId, role: "parent", callId: "delegation",
        returnFields: Object.keys(summary),
      },
      {
        eventId: "run-completed", type: "run.completed",
        timestamp: iso(completedAt), sessionId: parentSessionId,
        runId, blockId, armId, role: "parent",
      },
      {
        eventId: "unblinded", type: "outcomes.unblinded",
        timestamp: iso(completedAt + 4_000), sessionId: parentSessionId,
        runId, blockId, armId, role: "parent",
      },
      {
        eventId: "outcome-access", type: "outcome.accessed",
        timestamp: iso(completedAt + 5_000), sessionId: parentSessionId,
        runId, blockId, armId, role: "parent",
      },
    ],
  };
  const isolation = evaluateIsolationEvidence(
    { payload: evidence, authentication: { status: "verified" } },
    { armId, runId, candidateRoot, evaluatorRoot, stagingPath },
  );
  assert.equal(isolation.status, "compliant", isolation.violations.join("\n"));
});
