import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  computeRequestHash,
  computeSandboxTokenHash,
  CorpusService,
} from "../../tools/semantic-corpus-mcp/lib.mjs";

export function inputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["version", "id", "enabled", "profile"],
    properties: {
      version: { type: "integer", const: 1 },
      id: { type: "string", minLength: 1, maxLength: 40 },
      enabled: { type: "boolean" },
      profile: {
        type: "object",
        additionalProperties: false,
        required: ["region", "flags"],
        properties: {
          region: { type: "string", maxLength: 4, enum: ["us", "eu", "apac"] },
          flags: {
            type: "array",
            minItems: 0,
            maxItems: 3,
            uniqueItems: true,
            items: {
              type: "string",
              maxLength: 10,
              enum: ["legacy", "regulated", "preview"],
            },
          },
        },
      },
    },
  };
}

export function baseRequest(overrides = {}) {
  const targetCount = overrides.targetCount ?? 4;
  const categories =
    overrides.categories ??
    [
      { category: "mapping-rules", minQuota: Math.ceil(targetCount / 2) },
      { category: "cross-field-invariants", minQuota: Math.floor(targetCount / 4) },
    ];
  const scenarios =
    overrides.scenarios ??
    Array.from({ length: targetCount }, (_, index) => ({
      scenarioId: `scenario-${String(index + 1).padStart(3, "0")}`,
      category:
        index < Math.ceil(targetCount / 2)
          ? "mapping-rules"
          : "cross-field-invariants",
    }));
  const request = {
    version: 1,
    targetCount,
    scenarios,
    categories,
    maxSizes: {
      contractFileBytes: 262_144,
      scenarioBytes: 65_536,
      manifestBytes: 262_144,
    },
    v1ConfigSchema: inputSchema(),
    ...overrides,
  };
  delete request.requestHash;
  request.requestHash = computeRequestHash(request);
  return request;
}

export function encodeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function scenarioInput(index) {
  return {
    version: 1,
    id: `record-${index}`,
    enabled: index % 2 === 0,
    profile: {
      region: ["us", "eu", "apac"][index % 3],
      flags: index % 2 === 0 ? ["legacy"] : ["regulated"],
    },
  };
}

async function identity(target) {
  const stats = await lstat(target, { bigint: true });
  return { device: stats.dev.toString(), fileId: stats.ino.toString() };
}

export async function createRun(request = baseRequest(), sandboxOverrides = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "semantic-corpus-"));
  const contract = path.join(cwd, "corpus-contract");
  const staging = path.join(cwd, "corpus-staging");
  const configPath = path.join(cwd, "corpus-sandbox.json");
  await mkdir(contract);
  await mkdir(staging);
  await mkdir(path.join(contract, "schemas"));
  await writeFile(path.join(contract, "request.json"), encodeJson(request));
  await writeFile(path.join(contract, "rules.md"), "# Rules\n");
  await writeFile(
    path.join(contract, "schemas", "v1.json"),
    encodeJson(request.v1ConfigSchema),
  );
  await Promise.all([
    chmod(path.join(contract, "request.json"), 0o400),
    chmod(path.join(contract, "rules.md"), 0o400),
    chmod(path.join(contract, "schemas", "v1.json"), 0o400),
  ]);
  const token = randomBytes(32).toString("hex");
  const sandbox = {
    version: 1,
    sandboxKind: "restricted-acl",
    tokenHash: computeSandboxTokenHash(token),
    requestHash: request.requestHash,
    roots: {
      contract: {
        path: contract,
        access: "read-only",
        identity: await identity(contract),
      },
      staging: {
        path: staging,
        access: "read-write",
        identity: await identity(staging),
      },
    },
    lock: {
      waitTimeoutMs: 2_000,
      staleAfterMs: 60_000,
    },
    ...sandboxOverrides,
  };
  await writeFile(configPath, encodeJson(sandbox));
  await chmod(configPath, 0o400);
  const environment = { configPath, token };
  return {
    cwd,
    contract,
    staging,
    configPath,
    environment,
    env: {
      ...process.env,
      SEMANTIC_CORPUS_SANDBOX_CONFIG: configPath,
      SEMANTIC_CORPUS_SANDBOX_TOKEN: token,
    },
    request,
    requestHash: request.requestHash,
    sandbox,
    async open(options = {}) {
      return CorpusService.create({ environment, ...options });
    },
    async cleanup() {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
