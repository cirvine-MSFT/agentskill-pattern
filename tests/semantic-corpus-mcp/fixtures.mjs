import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  computeRequestHash,
  computeSandboxTokenHash,
  CorpusService,
} from "../../tools/semantic-corpus-mcp/lib.mjs";

function identity(stats) {
  return { device: stats.dev.toString(), fileId: stats.ino.toString() };
}

export function baseRequest(overrides = {}) {
  const request = {
    version: 1,
    targetCount: 40,
    scenarios: Array.from({ length: 40 }, (_, index) => ({
      scenarioId: `scenario-${String(index + 1).padStart(3, "0")}`,
      category: index < 25 ? "mapping-rules" : "cross-field-invariants",
    })),
    categories: [
      { category: "mapping-rules", minQuota: 20 },
      { category: "cross-field-invariants", minQuota: 10 },
    ],
    maxSizes: {
      contractFileBytes: 262144,
      scenarioBytes: 65536,
      manifestBytes: 262144,
    },
    v1ConfigSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "enabled", "profile"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 40 },
        enabled: { type: "boolean" },
        profile: {
          type: "object",
          additionalProperties: false,
          required: ["region", "flags"],
          properties: {
            region: { type: "string", enum: ["us", "eu", "apac"], maxLength: 4 },
            flags: {
              type: "array",
              minItems: 0,
              maxItems: 3,
              uniqueItems: true,
              items: {
                type: "string",
                enum: ["legacy", "regulated", "preview"],
                maxLength: 10,
              },
            },
          },
        },
      },
    },
    ...overrides,
  };
  request.requestHash = computeRequestHash(request);
  return request;
}

export function scenarioInput(index) {
  return {
    id: `record-${index}`,
    enabled: index % 2 === 0,
    profile: {
      region: ["us", "eu", "apac"][index % 3],
      flags: index % 2 === 0 ? ["legacy"] : ["regulated"],
    },
  };
}

export function encodeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function createRun(request = baseRequest(), configOverrides = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "semantic-corpus-"));
  const contract = path.resolve(cwd, "corpus-contract");
  const staging = path.resolve(cwd, "corpus-staging");
  const configPath = path.resolve(cwd, "corpus-sandbox.json");
  const token = "test-launcher-token-0123456789abcdef";
  await mkdir(contract);
  await mkdir(staging);
  await mkdir(path.join(contract, "schemas"));
  await writeFile(
    path.join(contract, "request.json"),
    `${JSON.stringify(request, null, 2)}\n`,
  );
  await writeFile(path.join(contract, "rules.md"), "# Rules\n");
  await writeFile(
    path.join(contract, "schemas", "v1.json"),
    `${JSON.stringify(request.v1ConfigSchema)}\n`,
  );
  await Promise.all([
    chmod(path.join(contract, "request.json"), 0o400),
    chmod(path.join(contract, "rules.md"), 0o400),
    chmod(path.join(contract, "schemas", "v1.json"), 0o400),
  ]);

  const config = {
    version: 1,
    sandboxKind: "restricted-acl",
    tokenHash: computeSandboxTokenHash(token),
    requestHash: request.requestHash,
    roots: {
      contract: {
        path: contract,
        access: "read-only",
        identity: identity(await lstat(contract, { bigint: true })),
      },
      staging: {
        path: staging,
        access: "read-write",
        identity: identity(await lstat(staging, { bigint: true })),
      },
    },
    lock: { waitTimeoutMs: 100, staleAfterMs: 1000 },
    ...configOverrides,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await chmod(configPath, 0o400);

  return {
    cwd,
    contract,
    staging,
    configPath,
    config,
    sandbox: config,
    token,
    request,
    requestHash: request.requestHash,
    environment: { configPath, token },
    env: {
      ...process.env,
      SEMANTIC_CORPUS_SANDBOX_CONFIG: configPath,
      SEMANTIC_CORPUS_SANDBOX_TOKEN: token,
    },
    async open(options = {}) {
      return CorpusService.create({
        environment: { configPath, token },
        ...options,
      });
    },
    async cleanup() {
      await chmod(configPath, 0o600).catch(() => {});
      await chmod(path.join(contract, "request.json"), 0o600).catch(() => {});
      await chmod(path.join(contract, "rules.md"), 0o600).catch(() => {});
      await chmod(path.join(contract, "schemas", "v1.json"), 0o600).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
