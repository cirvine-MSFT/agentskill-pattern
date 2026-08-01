#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStaging } from "../validators/staging.mjs";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import { readAuthenticatedExport } from "../scripts/authenticated-export.mjs";
import { preflightLocalModel } from "../scripts/preflight-local-model.mjs";
import { validateLocalEvidence } from "../scripts/validate-local-evidence.mjs";
import { computeRequestHash } from "../../../tools/semantic-corpus-mcp/lib.mjs";

const benchmarkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frozenRequest = JSON.parse(readFileSync(resolve(benchmarkRoot, "design", "corpus-request.json"), "utf8"));
const frozenSchedule = JSON.parse(readFileSync(resolve(benchmarkRoot, "design", "schedule.json"), "utf8"));
const frozenSeeds = JSON.parse(readFileSync(resolve(benchmarkRoot, "design", "seeds.json"), "utf8"));
const schemaRoot = resolve(benchmarkRoot, "schemas");
const localEvidenceSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "local-evidence.schema.json"), "utf8")
);
const localPreflightSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "local-model-preflight.schema.json"), "utf8")
);
const MCP_TOOLS = new Set([
  "semantic-corpus/list_contract_files",
  "semantic-corpus/read_contract_file",
  "semantic-corpus/write_scenario_input",
  "semantic-corpus/write_scenario_manifest"
]);

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function argumentsSha256(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function readExactFile(root, path, maximumBytes) {
  const target = resolve(root, path);
  if (!within(root, target)) throw new Error(`Adapter source escapes corpus-staging: ${path}`);
  const stats = lstatSync(target);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Adapter source is not a regular non-symlink file: ${path}`);
  }
  if (!samePath(realpathSync.native(target), target)) {
    throw new Error(`Adapter source is redirected: ${path}`);
  }
  const bytes = readFileSync(target);
  if (bytes.length > maximumBytes) throw new Error(`Adapter source exceeds its request limit: ${path}`);
  return bytes;
}

function validateImmutableRequest(request) {
  const expectedKeys = [
    "categories",
    "maxSizes",
    "requestHash",
    "scenarios",
    "targetCount",
    "v1ConfigSchema",
    "version"
  ];
  if (!request
    || typeof request !== "object"
    || Array.isArray(request)
    || JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("Immutable request has an unexpected top-level shape");
  }
  if (request.version !== 1
    || request.targetCount !== 60
    || request.scenarios?.length !== request.targetCount
    || !Array.isArray(request.categories)
    || !request.maxSizes
    || !request.v1ConfigSchema) {
    throw new Error("Immutable request has invalid benchmark dimensions");
  }
  const scenarioIds = new Set();
  const categories = new Set(request.categories.map((entry) => entry.category));
  for (const scenario of request.scenarios) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.scenarioId)
      || !categories.has(scenario.category)
      || scenarioIds.has(scenario.scenarioId)) {
      throw new Error("Immutable request has invalid scenario IDs/categories");
    }
    scenarioIds.add(scenario.scenarioId);
  }
  if (!/^[a-f0-9]{64}$/.test(request.requestHash)
    || computeRequestHash(request) !== request.requestHash
    || request.requestHash !== frozenRequest.requestHash) {
    throw new Error("Immutable request self-hash is invalid");
  }
}

export function canonicalStagingBytes(staging) {
  return Buffer.from(`${JSON.stringify(staging, null, 2)}\n`, "utf8");
}

function snapshotManifest(stagingRoot, request) {
  const path = resolve(stagingRoot, "manifest.json");
  if (!existsSync(path)) return null;
  const bytes = readExactFile(stagingRoot, "manifest.json", request.maxSizes.manifestBytes);
  const manifest = JSON.parse(bytes);
  const expected = {
    version: 1,
    kind: "semantic-source-scenarios",
    requestHash: request.requestHash,
    scenarioCount: request.targetCount,
    scenarios: request.scenarios.map(({ scenarioId, category }) => ({
      scenarioId,
      category
    }))
  };
  if (canonicalJson(manifest) !== canonicalJson(expected)) {
    throw new Error("Staged manifest content differs from the immutable request");
  }
  return {
    path: "corpus-staging/manifest.json",
    sha256: sha256(bytes),
    bytes: bytes.length
  };
}

function snapshotCases(stagingRoot, request) {
  const scenariosRoot = resolve(stagingRoot, "scenarios");
  if (!existsSync(scenariosRoot)) return [];
  const stats = lstatSync(scenariosRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || !samePath(realpathSync.native(scenariosRoot), scenariosRoot)) {
    throw new Error("corpus-staging/scenarios must be a regular non-symlink directory");
  }
  const requested = new Map(request.scenarios.map((item, index) => [item.scenarioId, { ...item, index }]));
  const entries = readdirSync(scenariosRoot, { withFileTypes: true });
  const cases = [];
  for (const entry of entries) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Unexpected entry in corpus-staging/scenarios: ${entry.name}`);
    }
    const scenarioId = match[1];
    const definition = requested.get(scenarioId);
    if (!definition) throw new Error(`Staged scenario is absent from the immutable request: ${scenarioId}`);
    const sourcePath = `scenarios/${entry.name}`;
    const bytes = readExactFile(stagingRoot, sourcePath, request.maxSizes.scenarioBytes);
    cases.push({
      id: scenarioId,
      category: definition.category,
      input: JSON.parse(bytes),
      stagingFile: {
        path: `corpus-staging/${sourcePath}`,
        sha256: sha256(bytes),
        bytes: bytes.length
      },
      requestIndex: definition.index
    });
  }
  return cases
    .toSorted((left, right) => left.requestIndex - right.requestIndex)
    .map(({ requestIndex, ...scenario }) => scenario);
}

function snapshotToolErrors(events, runId) {
  const calls = new Map(events
    .filter((event) => event.type === "tool.called" && event.runId === runId)
    .map((event) => [event.callId, event]));
  return events
    .filter((event) =>
      event.type === "tool.result"
      && event.runId === runId
      && event.resultStatus === "error"
      && MCP_TOOLS.has(event.toolName))
    .map((event) => {
      const call = calls.get(event.callId);
      if (!call || call.toolName !== event.toolName) {
        throw new Error(`Tool error ${event.callId} has no exact matching MCP call`);
      }
      return {
        callId: event.callId,
        toolName: event.toolName,
        argumentsSha256: call.argumentsSha256,
        ...(call.scenarioId ? { scenarioId: call.scenarioId } : {}),
        code: event.errorCode,
        message: event.errorMessage
      };
    });
}

function verifyAuthenticatedWrites({ cases, manifest, events, runId, request }) {
  const results = new Map(events
    .filter((event) => event.type === "tool.result" && event.runId === runId)
    .map((event) => [event.callId, event]));
  const successfulCalls = events.filter((event) =>
    event.type === "tool.called"
    && event.runId === runId
    && results.get(event.callId)?.resultStatus === "success");
  const scenarioCalls = successfulCalls.filter((event) =>
    event.toolName === "semantic-corpus/write_scenario_input");
  const casesById = new Map(cases.map((scenario) => [scenario.id, scenario]));
  const calledIds = new Set(scenarioCalls.map((call) => call.scenarioId));
  if (scenarioCalls.length !== cases.length
    || calledIds.size !== scenarioCalls.length
    || cases.some((scenario) => !calledIds.has(scenario.id))
    || scenarioCalls.some((call) => !casesById.has(call.scenarioId))) {
    throw new Error("Staged scenario IDs differ from authenticated successful writes");
  }

  for (const call of scenarioCalls) {
    const scenario = casesById.get(call.scenarioId);
    if (call.argumentsSha256 !== argumentsSha256({
      scenarioId: call.scenarioId,
      config: scenario.input
    })) {
      throw new Error(`Staged scenario differs from authenticated arguments: ${call.scenarioId}`);
    }
  }

  const manifestCalls = successfulCalls.filter((event) =>
    event.toolName === "semantic-corpus/write_scenario_manifest");
  if (manifestCalls.length !== (manifest ? 1 : 0)) {
    throw new Error("Staged manifest differs from authenticated successful writes");
  }
  if (manifestCalls.length === 1
    && manifestCalls[0].argumentsSha256 !== argumentsSha256({ scenarios: request.scenarios })) {
    throw new Error("Staged manifest differs from authenticated arguments");
  }
}

function verifyLocalWrites({ cases, manifest, successfulWrites, request }) {
  const scenarioWrites = successfulWrites.filter((write) =>
    write.toolName === "semantic-corpus/write_scenario_input");
  const casesById = new Map(cases.map((scenario) => [scenario.id, scenario]));
  const writtenIds = new Set(scenarioWrites.map((write) => write.scenarioId));
  if (scenarioWrites.length !== cases.length
    || writtenIds.size !== scenarioWrites.length
    || cases.some((scenario) => !writtenIds.has(scenario.id))
    || scenarioWrites.some((write) => !casesById.has(write.scenarioId))) {
    throw new Error("Staged scenario IDs differ from local successful writes");
  }

  for (const write of scenarioWrites) {
    const scenario = casesById.get(write.scenarioId);
    if (write.argumentsSha256 !== argumentsSha256({
      scenarioId: write.scenarioId,
      config: scenario.input
    })) {
      throw new Error(`Staged scenario differs from local write arguments: ${write.scenarioId}`);
    }
  }
  const manifestWrites = successfulWrites.filter((write) =>
    write.toolName === "semantic-corpus/write_scenario_manifest");
  if (manifestWrites.length !== (manifest ? 1 : 0)) {
    throw new Error("Staged manifest differs from local successful writes");
  }
  if (manifestWrites.length === 1
    && manifestWrites[0].argumentsSha256 !== argumentsSha256({
      scenarios: request.scenarios
    })) {
    throw new Error("Staged manifest differs from local write arguments");
  }
}

export function verifyLocalSnapshotWrites(snapshotBytes, localEvidence) {
  const snapshot = JSON.parse(snapshotBytes);
  if (!canonicalStagingBytes(snapshot).equals(snapshotBytes)) {
    throw new Error("Local snapshot is not canonical staging bytes");
  }
  if (snapshot.adapter?.requestHash !== frozenRequest.requestHash) {
    throw new Error("Local snapshot request hash differs from the immutable request");
  }
  verifyLocalWrites({
    cases: snapshot.cases,
    manifest: snapshot.adapter?.manifest ?? null,
    successfulWrites: localEvidence.successfulWrites,
    request: frozenRequest
  });
}

export function snapshotCorpusStaging({
  corpusContractRoot,
  corpusStagingRoot,
  platformEvents,
  runId,
  blockId,
  armId,
  seed,
  outputPath
}) {
  const contractRoot = resolve(corpusContractRoot);
  const contractStats = lstatSync(contractRoot);
  if (!contractStats.isDirectory() || contractStats.isSymbolicLink()
    || !samePath(realpathSync.native(contractRoot), contractRoot)) {
    throw new Error("corpus-contract root must be a regular non-symlink directory");
  }
  const request = JSON.parse(readExactFile(contractRoot, "request.json", 1024 * 1024));
  validateImmutableRequest(request);
  const stagingRoot = resolve(corpusStagingRoot);
  const rootStats = lstatSync(stagingRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()
    || !samePath(realpathSync.native(stagingRoot), stagingRoot)) {
    throw new Error("corpus-staging root must be a regular non-symlink directory");
  }
  const completions = platformEvents.filter((event) =>
    event.type === "run.completed" && event.runId === runId);
  if (completions.length !== 1) {
    throw new Error("Evaluator adapter requires exactly one model run completion");
  }
  const planned = frozenSchedule.runs.find((item) => item.runId === runId);
  const expectedSeed = frozenSeeds.blocks.find((item) => item.id === blockId)?.seed;
  if (!planned
    || planned.blockId !== blockId
    || planned.armId !== armId
    || completions[0].blockId !== blockId
    || completions[0].armId !== armId
    || seed !== expectedSeed) {
    throw new Error("Adapter run metadata differs from the frozen schedule/seed");
  }
  const completedAt = Date.parse(completions[0].timestamp);
  if (platformEvents.some((event) =>
    event.runId === runId
    && ["tool.called", "tool.result", "fs.access", "delegation.invoked", "delegation.completed"].includes(event.type)
    && Date.parse(event.timestamp) >= completedAt)) {
    throw new Error("Model generation activity continued at or after completion");
  }

  const cases = snapshotCases(stagingRoot, request);
  const toolErrors = snapshotToolErrors(platformEvents, runId);
  const manifest = snapshotManifest(stagingRoot, request);
  verifyAuthenticatedWrites({
    cases,
    manifest,
    events: platformEvents,
    runId,
    request
  });
  const staging = {
    formatVersion: 1,
    generator: { armId, blockId, seed },
    adapter: {
      version: 1,
      requestHash: request.requestHash,
      sourceRoot: "corpus-staging/",
      successfulWrites: cases.length,
      toolErrorCount: toolErrors.length,
      manifest
    },
    cases,
    toolErrors
  };
  const errors = validateStaging(staging);
  if (errors.length > 0) {
    throw new Error(`Adapter produced invalid benchmark staging: ${JSON.stringify(errors)}`);
  }
  const bytes = canonicalStagingBytes(staging);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx" });
  return {
    staging,
    bytes,
    stagingPath: target,
    snapshotSha256: sha256(bytes),
    submittedCases: cases.length,
    toolErrorCount: toolErrors.length
  };
}

export function snapshotLocalCorpusStaging({
  corpusContractRoot,
  corpusStagingRoot,
  localEvidence,
  localEvidenceBytes,
  modelPreflight,
  sourceArtifactRoot,
  sourceCandidateRoot,
  outputPath
}) {
  const evidenceErrors = validateJsonSchema(localEvidence, localEvidenceSchema, {
    schemaDir: schemaRoot
  });
  if (evidenceErrors.length > 0) {
    throw new Error(`Local evidence is invalid: ${evidenceErrors[0].path} ${evidenceErrors[0].message}`);
  }
  const preflightErrors = validateJsonSchema(modelPreflight, localPreflightSchema, {
    schemaDir: schemaRoot
  });
  if (preflightErrors.length > 0) {
    throw new Error(`Local model preflight is invalid: ${preflightErrors[0].path} ${preflightErrors[0].message}`);
  }
  const localEvidenceErrors = validateLocalEvidence(localEvidence, {
    artifactRoot: sourceArtifactRoot,
    candidateRoot: sourceCandidateRoot
  });
  if (localEvidenceErrors.length > 0) {
    throw new Error(`Local evidence source validation failed: ${localEvidenceErrors[0]}`);
  }
  const recomputedPreflight = preflightLocalModel(localEvidence, localEvidenceBytes);
  if (JSON.stringify(modelPreflight) !== JSON.stringify(recomputedPreflight)
    || modelPreflight.status !== "pass"
    || modelPreflight.beforeOutcomesOpened !== true
    || localEvidence.attempt.outcomesOpened !== false
    || modelPreflight.runId !== localEvidence.runId
    || modelPreflight.evidenceSha256 !== sha256(localEvidenceBytes)) {
    throw new Error("Local evaluator snapshot requires exact passing pre-outcome model evidence");
  }
  const planned = frozenSchedule.runs.find((item) => item.runId === localEvidence.runId);
  if (!planned
    || planned.blockId !== localEvidence.blockId
    || planned.armId !== localEvidence.armId) {
    throw new Error("Local evidence run identity differs from the frozen schedule");
  }
  if (!localEvidence.timing.endedAt) {
    throw new Error("Local evaluator snapshot requires observed model completion");
  }

  const contractRoot = resolve(corpusContractRoot);
  const contractStats = lstatSync(contractRoot);
  if (!contractStats.isDirectory() || contractStats.isSymbolicLink()
    || !samePath(realpathSync.native(contractRoot), contractRoot)) {
    throw new Error("corpus-contract root must be a regular non-symlink directory");
  }
  const request = JSON.parse(readExactFile(contractRoot, "request.json", 1024 * 1024));
  validateImmutableRequest(request);
  const stagingRoot = resolve(corpusStagingRoot);
  const rootStats = lstatSync(stagingRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()
    || !samePath(realpathSync.native(stagingRoot), stagingRoot)) {
    throw new Error("corpus-staging root must be a regular non-symlink directory");
  }
  const cases = snapshotCases(stagingRoot, request);
  const manifest = snapshotManifest(stagingRoot, request);
  verifyLocalWrites({
    cases,
    manifest,
    successfulWrites: localEvidence.successfulWrites,
    request
  });
  const staging = {
    formatVersion: 1,
    generator: {
      armId: planned.armId,
      blockId: planned.blockId,
      seed: planned.seed
    },
    adapter: {
      version: 1,
      requestHash: request.requestHash,
      sourceRoot: "corpus-staging/",
      successfulWrites: cases.length,
      toolErrorCount: localEvidence.toolErrors.length,
      manifest
    },
    cases,
    toolErrors: localEvidence.toolErrors
  };
  const errors = validateStaging(staging);
  if (errors.length > 0) {
    throw new Error(`Local adapter produced invalid benchmark staging: ${JSON.stringify(errors)}`);
  }
  const bytes = canonicalStagingBytes(staging);
  verifyLocalSnapshotWrites(bytes, localEvidence);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx" });
  return {
    evidenceTier: "descriptive-local-v1",
    staging,
    bytes,
    stagingPath: target,
    snapshotSha256: sha256(bytes),
    submittedCases: cases.length,
    toolErrorCount: localEvidence.toolErrors.length
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const required = [
    "--corpus-contract", "--corpus-staging", "--payload", "--signature", "--public-key", "--run-id",
    "--block-id", "--arm-id", "--seed", "--out"
  ];
  if (required.some((name) => argument(args, name) === undefined)) {
    throw new Error("Usage: node evaluator/adapter.mjs --corpus-contract <root> --corpus-staging <root> --payload <platform-export.json> --signature <export.sig> --public-key <platform.pem> --run-id <run> --block-id <block> --arm-id <1-4> --seed <integer> --out <staging/run.json>");
  }
  const authenticated = readAuthenticatedExport({
    payloadPath: argument(args, "--payload"),
    signaturePath: argument(args, "--signature"),
    publicKeyPath: argument(args, "--public-key")
  });
  const result = snapshotCorpusStaging({
    corpusContractRoot: argument(args, "--corpus-contract"),
    corpusStagingRoot: argument(args, "--corpus-staging"),
    platformEvents: authenticated.payload.events,
    runId: argument(args, "--run-id"),
    blockId: argument(args, "--block-id"),
    armId: Number(argument(args, "--arm-id")),
    seed: Number(argument(args, "--seed")),
    outputPath: argument(args, "--out")
  });
  process.stdout.write(`${JSON.stringify({
    stagingPath: result.stagingPath,
    snapshotSha256: result.snapshotSha256,
    submittedCases: result.submittedCases,
    toolErrorCount: result.toolErrorCount
  })}\n`);
}
