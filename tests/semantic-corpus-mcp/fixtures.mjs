import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPreparedBootPayload,
  disposePreparedSandbox,
  prepareSandbox,
  spawnPreparedServer,
} from "../../tools/semantic-corpus-mcp/launcher.mjs";
import { CorpusService } from "../../tools/semantic-corpus-mcp/lib.mjs";

const baselinePath = fileURLToPath(
  new URL(
    "../../experiments/semantic-test-corpus/staging/baseline.json",
    import.meta.url,
  ),
);
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));

export function scenario(index) {
  return structuredClone(baseline.cases[index % baseline.cases.length]);
}

export function scenarioInput(index) {
  return scenario(index).input;
}

export function encodeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function createRun(options = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "semantic-corpus-test-"));
  const statePath = path.join(parent, "launcher-state.json");
  const prepared = await prepareSandbox({
    statePath,
    cleanupTokenPath: path.join(parent, "cleanup.cap"),
    sandboxParent: parent,
    metadata: {
      runId: options.runId ?? "B01-A4",
      armId: options.armId ?? 4,
      blockId: options.blockId ?? "B01",
      seed: options.seed ?? 20260729,
    },
    waitTimeoutMs: options.waitTimeoutMs ?? 100,
    staleAfterMs: options.staleAfterMs ?? 1000,
  });
  const auditEvents = [];

  return {
    ...prepared,
    parent,
    cwd: prepared.state.sandboxRoot,
    contract: prepared.state.contractRoot,
    staging: prepared.state.stagingRoot,
    configPath: prepared.state.configPath,
    request: prepared.request,
    requestHash: prepared.request.requestHash,
    manifestHash: prepared.request.manifestHash,
    async open(serviceOptions = {}) {
      return CorpusService.create({
        boot: createPreparedBootPayload(
          prepared,
          serviceOptions.bootOptions,
        ).payload,
        enforceProcessConfinement: false,
        audit: async (event) => auditEvents.push(event),
        ...serviceOptions,
      });
    },
    spawnServer(stdio) {
      return spawnPreparedServer(prepared, stdio);
    },
    bootEnvelope(options = {}) {
      return createPreparedBootPayload(prepared, options);
    },
    auditEvents,
    async cleanup() {
      await disposePreparedSandbox(prepared).catch(() => {});
      await rm(parent, { recursive: true, force: true });
    },
  };
}
