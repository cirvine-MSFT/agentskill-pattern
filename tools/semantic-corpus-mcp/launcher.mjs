#!/usr/bin/env node

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessStaging } from "../../experiments/semantic-test-corpus/validators/staging.mjs";
import { createLauncherBootEnvelope } from "./attestation.mjs";
import {
  canonicalJson,
  canonicalJsonBytes,
  computeRequestHash,
  computeSandboxTokenHash,
  sha256,
  validateRequestDocument,
  validateStagingPayload,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const benchmarkRoot = path.join(repoRoot, "experiments", "semantic-test-corpus");
const serverPath = path.join(here, "server.mjs");
const launcherPath = fileURLToPath(import.meta.url);
const trustedSources = [
  path.join(here, "assessment.mjs"),
  path.join(here, "attestation.mjs"),
  path.join(here, "lib.mjs"),
  path.join(here, "protocol.mjs"),
  serverPath,
];
const contractFiles = [
  ["fixture/spec/mapping-spec.json", "contract/mapping-spec.json"],
  ["schemas/v1-config.schema.json", "schemas/v1-config.schema.json"],
  ["schemas/scenario.schema.json", "schemas/scenario.schema.json"],
  ["schemas/staging.schema.json", "schemas/staging.schema.json"],
  ["validators/json-schema.mjs", "validators/json-schema.mjs"],
  ["validators/staging.mjs", "validators/staging.mjs"],
  ["scripts/validate-staging.mjs", "scripts/validate-staging.mjs"],
  ["design/shared-task-prompt.txt", "task/shared-task-prompt.txt"],
  ["design/delegated-worker-skill.md", "task/delegated-worker-skill.md"],
];
const FORBIDDEN_SOURCE_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']node:(?:net|http|https|http2|tls|dgram|dns|child_process|worker_threads|cluster|vm)["']|\b(?:fetch|WebSocket|EventSource)\s*\(|process\.binding\s*\(/u;
const PREPARED_SANDBOX = Symbol("prepared semantic corpus sandbox");
let cachedWindowsSid;

class LauncherError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LauncherError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LauncherError(code, message);
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail("LAUNCH_CONFIG_INVALID", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function requireText(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("LAUNCH_CONFIG_INVALID", `${label} is missing or invalid`);
  }
  return value;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

async function assertPlainPath(target, label) {
  const absolute = path.resolve(target);
  if (absolute !== target) {
    fail("CONFINEMENT_UNVERIFIED", `${label} must be absolute and normalized`);
  }
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink()) {
    fail("CONFINEMENT_UNVERIFIED", `${label} cannot be a symlink, junction, or reparse point`);
  }
  if (path.resolve(await realpath(absolute)) !== absolute) {
    fail("CONFINEMENT_UNVERIFIED", `${label} must resolve to itself`);
  }
  return absolute;
}

async function identity(target) {
  const stats = await lstat(target, { bigint: true });
  return identityFromStats(stats);
}

function identityFromStats(stats) {
  return { device: stats.dev.toString(), fileId: stats.ino.toString() };
}

function identitiesEqual(left, right) {
  return left.device === right.device && left.fileId === right.fileId;
}

async function writePrivateFile(target, content) {
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await restrictPrivateFile(target);
}

async function restrictPrivateFile(target) {
  await chmod(target, 0o600);
  if (process.platform === "win32") {
    const sid = currentWindowsSid();
    runIcacls(
      [target, "/inheritance:r", "/grant:r", `*${sid}:F`, "/Q"],
      "failed to restrict private runtime file ACL",
    );
  }
}

async function reserveRuntimeFile(target) {
  const handle = await open(target, "wx", 0o600);
  return {
    target,
    handle,
    identity: identityFromStats(await handle.stat({ bigint: true })),
    closed: false,
  };
}

async function writeReservedFile(reservation, content) {
  await reservation.handle.writeFile(content);
  await reservation.handle.sync();
  await reservation.handle.close();
  reservation.closed = true;
  await restrictPrivateFile(reservation.target);
}

async function releaseRuntimeReservation(reservation) {
  if (!reservation.closed) {
    await reservation.handle.close().catch(() => {});
    reservation.closed = true;
  }
  const onDisk = await lstat(reservation.target, { bigint: true }).catch(() => undefined);
  if (
    onDisk &&
    identitiesEqual(identityFromStats(onDisk), reservation.identity)
  ) {
    await rm(reservation.target).catch(() => {});
  }
}

async function reserveRuntimeFiles(targets) {
  const reservations = [];
  try {
    for (const target of targets) {
      reservations.push(await reserveRuntimeFile(target));
    }
    return reservations;
  } catch (error) {
    await Promise.all(reservations.map(releaseRuntimeReservation));
    throw error;
  }
}

async function readJson(target, label) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    fail("LAUNCH_CONFIG_INVALID", `${label} must contain valid JSON`);
  }
}

async function hashFile(target) {
  return sha256(await readFile(target));
}

async function attestTrustedSources() {
  const sources = [];
  for (const sourcePath of trustedSources) {
    const content = await readFile(sourcePath);
    if (FORBIDDEN_SOURCE_IMPORT.test(content.toString("utf8"))) {
      fail("CONFINEMENT_UNVERIFIED", `trusted MCP source imports a forbidden module: ${sourcePath}`);
    }
    sources.push({ path: sourcePath, sha256: sha256(content) });
  }
  return sources;
}

function assertPermissionModelAvailable() {
  const result = spawnSync(
    process.execPath,
    ["--permission", "-e", "process.exit(process.permission?.has('child') ? 2 : 0)"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    fail("CONFINEMENT_UNAVAILABLE", "Node permission confinement is unavailable or permits child processes");
  }
}

function currentWindowsSid() {
  if (cachedWindowsSid) return cachedWindowsSid;
  const result = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail("CONFINEMENT_UNAVAILABLE", "cannot resolve the Windows launcher identity");
  }
  const match = /"(S-\d(?:-\d+)+)"\s*$/u.exec(result.stdout.trim());
  if (!match) {
    fail("CONFINEMENT_UNAVAILABLE", "cannot parse the Windows launcher SID");
  }
  cachedWindowsSid = match[1];
  return cachedWindowsSid;
}

function runIcacls(args, label) {
  const result = spawnSync("icacls.exe", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail("CONFINEMENT_UNAVAILABLE", `${label}: ${result.stderr || result.stdout}`.trim());
  }
}

async function walkTree(root) {
  const entries = [];
  const visit = async (directory) => {
    entries.push({ path: directory, directory: true });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        fail("CONFINEMENT_UNVERIFIED", `${target} is a symlink, junction, or reparse point`);
      }
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        entries.push({ path: target, directory: false });
      } else {
        fail("CONFINEMENT_UNVERIFIED", `${target} is not a regular file or directory`);
      }
    }
  };
  await visit(root);
  return entries;
}

async function applyAccessPolicy(contractRoot, stagingRoot, configPath) {
  const contractEntries = await walkTree(contractRoot);
  await walkTree(stagingRoot);
  if (process.platform === "win32") {
    const sid = currentWindowsSid();
    runIcacls(
      [contractRoot, "/inheritance:r", "/T", "/C", "/Q"],
      "failed to remove corpus-contract ACL inheritance",
    );
    for (const entry of contractEntries) {
      runIcacls(
        [
          entry.path,
          "/grant:r",
          entry.directory ? `*${sid}:(OI)(CI)RX` : `*${sid}:R`,
          "/Q",
        ],
        "failed to restrict corpus-contract ACL",
      );
    }
    runIcacls(
      [stagingRoot, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)M`, "/T", "/C", "/Q"],
      "failed to grant corpus-staging ACL",
    );
    runIcacls(
      [configPath, "/inheritance:r", "/grant:r", `*${sid}:R`, "/Q"],
      "failed to restrict sandbox config ACL",
    );
  } else {
    const entries = await walkTree(contractRoot);
    for (const entry of entries.sort((left, right) => right.path.length - left.path.length)) {
      await chmod(entry.path, entry.directory ? 0o500 : 0o400);
    }
    await chmod(stagingRoot, 0o700);
    await chmod(configPath, 0o400);
  }
}

function verifyAccessProbe(contractFile, stagingRoot, configPath) {
  const probe = String.raw`
    const fs = require("node:fs");
    const [contractFile, stagingRoot, configPath] = process.argv.slice(1);
    for (const target of [contractFile, configPath]) {
      try {
        const fd = fs.openSync(target, "r+");
        fs.closeSync(fd);
        process.exit(10);
      } catch (error) {
        if (!["EACCES", "EPERM", "EROFS"].includes(error.code)) process.exit(11);
      }
    }
    const target = require("node:path").join(stagingRoot, ".access-probe");
    fs.writeFileSync(target, "verified", { flag: "wx", mode: 0o600 });
    fs.unlinkSync(target);
  `;
  const result = spawnSync(
    process.execPath,
    ["-e", probe, contractFile, stagingRoot, configPath],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    fail("CONFINEMENT_UNVERIFIED", "filesystem access policy could not be verified");
  }
}

async function copyContract(contractRoot) {
  const files = [];
  for (const [sourceRelative, destinationRelative] of contractFiles) {
    const source = path.join(benchmarkRoot, ...sourceRelative.split("/"));
    const destination = path.join(contractRoot, ...destinationRelative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const sourceHash = await hashFile(source);
    const destinationHash = await hashFile(destination);
    if (sourceHash !== destinationHash) {
      fail("CONFINEMENT_UNVERIFIED", `${destinationRelative} changed while materializing the contract`);
    }
    files.push({ path: destinationRelative, sha256: destinationHash });
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const manifest = { version: 1, files };
  const manifestBytes = canonicalJsonBytes(manifest);
  const manifestPath = path.join(contractRoot, "contract-manifest.json");
  await writePrivateFile(manifestPath, manifestBytes);
  return { manifest, manifestHash: sha256(manifestBytes) };
}

export async function buildBenchmarkRequest(metadata) {
  const [armContract, v1ConfigSchema, scenarioSchema, stagingSchema] = await Promise.all([
    readJson(path.join(benchmarkRoot, "design", "arm-contract.json"), "arm contract"),
    readJson(path.join(benchmarkRoot, "schemas", "v1-config.schema.json"), "v1 schema"),
    readJson(path.join(benchmarkRoot, "schemas", "scenario.schema.json"), "scenario schema"),
    readJson(path.join(benchmarkRoot, "schemas", "staging.schema.json"), "staging schema"),
  ]);
  if (
    armContract.commonContract?.caseCount !== 60 ||
    armContract.commonContract?.output !== "staging/<run-id>.json" ||
    armContract.commonContract?.schema !== "schemas/staging.schema.json" ||
    armContract.delegationContract?.invocation !== "semantic-scenario-stager" ||
    canonicalJson(armContract.delegationContract?.returnFields) !==
      canonicalJson([
        "stagingPath",
        "payloadSha256",
        "submittedCases",
        "promotableCases",
        "errorCount",
      ]) ||
    canonicalJson(armContract.delegationContract?.toolSurface) !==
      canonicalJson(["file.read", "file.write", "staging.validate"])
  ) {
    fail("BENCHMARK_CONTRACT_MISMATCH", "merged arm contract is not the registered 60-case staging contract");
  }
  const request = {
    version: 2,
    runId: requireText(metadata.runId, "runId", /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u),
    targetCount: armContract.commonContract.caseCount,
    generator: {
      armId: parseInteger(metadata.armId, "armId", 0, 4),
      blockId: requireText(metadata.blockId, "blockId", /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u),
      seed: parseInteger(metadata.seed, "seed", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    },
    maxSizes: {
      contractFileBytes: 1024 * 1024,
      scenarioBytes: 128 * 1024,
      stagingBytes: 4 * 1024 * 1024,
    },
    v1ConfigSchema,
    scenarioSchema,
    stagingSchema,
    manifestHash: requireText(metadata.manifestHash, "manifestHash", /^[a-f0-9]{64}$/u),
  };
  request.requestHash = computeRequestHash(request);
  validateRequestDocument(request);
  return request;
}

function stateSignature(state, cleanupToken) {
  const unsigned = { ...state };
  delete unsigned.authorization;
  return createHmac("sha256", cleanupToken).update(canonicalJson(unsigned)).digest("hex");
}

async function writeState(
  statePath,
  state,
  serverToken,
  cleanupToken,
  reservations,
) {
  const [stateReservation, serverTokenReservation, cleanupTokenReservation] =
    reservations;
  const auditReservation = reservations[3];
  const serverTokenPath = serverTokenReservation.target;
  const cleanupTokenPath = cleanupTokenReservation.target;
  await writeReservedFile(serverTokenReservation, serverToken);
  await writeReservedFile(cleanupTokenReservation, cleanupToken);
  await writeReservedFile(auditReservation, Buffer.alloc(0));
  const signed = {
    ...state,
    authorization: stateSignature(state, cleanupToken),
  };
  await writeReservedFile(
    stateReservation,
    `${JSON.stringify(signed, null, 2)}\n`,
  );
  return {
    ...signed,
    serverTokenPath,
    cleanupTokenPath,
    auditPath: auditReservation.target,
  };
}

async function loadState(statePath, cleanupToken) {
  const absolute = await assertPlainPath(path.resolve(statePath), "state path");
  const state = await readJson(absolute, "launcher state");
  const serverTokenPath = `${absolute}.server-token`;
  requireText(cleanupToken, "cleanup capability", /^[A-Za-z0-9_-]{40,128}$/u);
  const serverToken = await readFile(serverTokenPath, "utf8");
  const expected = Buffer.from(stateSignature(state, cleanupToken), "utf8");
  const actual = Buffer.from(state.authorization ?? "", "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    fail("STATE_AUTHORIZATION_FAILED", "launcher state authorization is invalid");
  }
  for (const key of [
    "sandboxRoot",
    "contractRoot",
    "stagingRoot",
    "configPath",
    "stagingPath",
    "auditPath",
    "executablePath",
  ]) {
    if (typeof state[key] !== "string" || !path.isAbsolute(state[key])) {
      fail("STATE_INVALID", `launcher state ${key} is invalid`);
    }
    if (state.logicalStagingPath !== `staging/${state.runId}.json`) {
      fail("STATE_INVALID", "launcher state logical staging path is invalid");
    }
    if (
      !/^[a-f0-9]{64}$/u.test(state.configSha256 ?? "") ||
      !/^[a-f0-9]{64}$/u.test(state.expectedServerSha256 ?? "") ||
      !/^[a-f0-9]{64}$/u.test(state.expectedExecutableSha256 ?? "") ||
      !/^[a-f0-9]{64}$/u.test(state.expectedLauncherSha256 ?? "")
    ) {
      fail("STATE_INVALID", "launcher state executable/config hashes are invalid");
    }
  }
  await Promise.all([
    assertPlainPath(state.sandboxRoot, "sandbox root"),
    assertPlainPath(state.contractRoot, "contract root"),
    assertPlainPath(state.stagingRoot, "staging root"),
    assertPlainPath(state.configPath, "sandbox config"),
  ]);
  if (
    !isWithin(state.sandboxRoot, state.contractRoot) ||
    !isWithin(state.sandboxRoot, state.stagingRoot) ||
    !isWithin(state.sandboxRoot, state.configPath) ||
    !isWithin(state.stagingRoot, state.stagingPath) ||
    state.auditPath !== `${absolute}.audit.jsonl`
  ) {
    fail("STATE_INVALID", "launcher state paths escape the disposable sandbox");
  }
  if (
    path.basename(state.sandboxRoot).startsWith("semantic-corpus-run-") === false ||
    state.contractRoot !== path.join(state.sandboxRoot, "corpus-contract") ||
    state.stagingRoot !== path.join(state.sandboxRoot, "corpus-staging") ||
    state.configPath !== path.join(state.sandboxRoot, "corpus-sandbox.json") ||
    state.stagingPath !== path.join(state.stagingRoot, `${state.runId}.json`) ||
    isWithin(await realpath(repoRoot), await realpath(state.sandboxRoot)) ||
    isWithin(await realpath(state.sandboxRoot), await realpath(repoRoot))
  ) {
    fail("STATE_INVALID", "launcher state does not identify a trusted disposable layout");
  }
  const config = await readJson(state.configPath, "sandbox config");
  if (
    config?.version !== 2 ||
    config.requestHash !== state.requestHash ||
    config.manifestHash !== state.manifestHash ||
    config.roots?.contract?.path !== state.contractRoot ||
    config.roots?.staging?.path !== state.stagingRoot ||
    config.sandbox?.path !== state.sandboxRoot ||
    config.audit?.logicalStagingPath !== state.logicalStagingPath ||
    config.confinement?.executable?.path !== state.executablePath ||
    config.confinement?.executable?.sha256 !== state.expectedExecutableSha256 ||
    config.confinement?.launcher?.path !== launcherPath ||
    config.confinement?.launcher?.sha256 !== state.expectedLauncherSha256 ||
    !identitiesEqual(config.roots.contract.identity, await identity(state.contractRoot)) ||
    !identitiesEqual(config.roots.staging.identity, await identity(state.stagingRoot)) ||
    config.tokenHash !== computeSandboxTokenHash(serverToken)
  ) {
    fail("STATE_INVALID", "launcher state no longer matches its sandbox config or roots");
  }
  const expectedSources = await attestTrustedSources();
  if (canonicalJson(config.confinement?.sources) !== canonicalJson(expectedSources)) {
    fail("STATE_INVALID", "launcher trusted source attestation changed");
  }
  if (
    await hashFile(state.configPath) !== state.configSha256 ||
    await hashFile(serverPath) !== state.expectedServerSha256 ||
    await hashFile(state.executablePath) !== state.expectedExecutableSha256 ||
    await hashFile(launcherPath) !== state.expectedLauncherSha256
  ) {
    fail("STATE_INVALID", "launcher config or expected executable hash changed");
  }
  return {
    statePath: absolute,
    state,
    cleanupToken,
    serverToken,
    serverTokenPath,
    config,
  };
}

export async function prepareSandbox(options = {}) {
  assertPermissionModelAvailable();
  const statePath = path.resolve(
    options.statePath ??
      requireText(process.env.SEMANTIC_CORPUS_STATE_PATH, "SEMANTIC_CORPUS_STATE_PATH", /.+/u),
  );
  if (statePath !== (options.statePath ?? process.env.SEMANTIC_CORPUS_STATE_PATH)) {
    fail("LAUNCH_CONFIG_INVALID", "state path must be absolute and normalized");
  }
  if (isWithin(repoRoot, statePath)) {
    fail("CONFINEMENT_UNVERIFIED", "launcher state and tokens must remain outside the repository");
  }
  await mkdir(path.dirname(statePath), { recursive: true });
  await assertPlainPath(path.dirname(statePath), "state directory");
  const cleanupTokenPath = path.resolve(
    options.cleanupTokenPath ??
      requireText(
        process.env.SEMANTIC_CORPUS_CLEANUP_TOKEN_PATH,
        "SEMANTIC_CORPUS_CLEANUP_TOKEN_PATH",
        /.+/u,
      ),
  );
  if (
    cleanupTokenPath !==
      (options.cleanupTokenPath ?? process.env.SEMANTIC_CORPUS_CLEANUP_TOKEN_PATH) ||
    isWithin(repoRoot, cleanupTokenPath)
  ) {
    fail("CONFINEMENT_UNVERIFIED", "cleanup capability path must be absolute and outside the repository");
  }
  await mkdir(path.dirname(cleanupTokenPath), { recursive: true });
  await assertPlainPath(path.dirname(cleanupTokenPath), "cleanup capability directory");
  const auditPath = `${statePath}.audit.jsonl`;
  const sandboxParent = path.resolve(
    options.sandboxParent ?? process.env.SEMANTIC_CORPUS_SANDBOX_PARENT ?? os.tmpdir(),
  );
  await mkdir(sandboxParent, { recursive: true });
  await assertPlainPath(sandboxParent, "sandbox parent");
  const runtimeReservations = await reserveRuntimeFiles([
    statePath,
    `${statePath}.server-token`,
    cleanupTokenPath,
    auditPath,
  ]);
  let sandboxRoot;
  try {
    sandboxRoot = await mkdtemp(path.join(sandboxParent, "semantic-corpus-run-"));
    const canonicalRepo = await realpath(repoRoot);
    const canonicalSandbox = await realpath(sandboxRoot);
    if (isWithin(canonicalRepo, canonicalSandbox) || isWithin(canonicalSandbox, canonicalRepo)) {
      fail("CONFINEMENT_UNVERIFIED", "disposable sandbox must be outside and disjoint from the repository");
    }

    const contractRoot = path.join(sandboxRoot, "corpus-contract");
    const stagingRoot = path.join(sandboxRoot, "corpus-staging");
    const configPath = path.join(sandboxRoot, "corpus-sandbox.json");
    await Promise.all([mkdir(contractRoot), mkdir(stagingRoot)]);
    const { manifestHash } = await copyContract(contractRoot);
    const metadata = options.metadata ?? {
      runId: process.env.SEMANTIC_CORPUS_RUN_ID,
      armId: process.env.SEMANTIC_CORPUS_ARM_ID,
      blockId: process.env.SEMANTIC_CORPUS_BLOCK_ID,
      seed: process.env.SEMANTIC_CORPUS_SEED,
    };
    const request = await buildBenchmarkRequest({ ...metadata, manifestHash });
    const requestPath = path.join(contractRoot, "request.json");
    await writePrivateFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);

    const serverToken = randomBytes(32).toString("base64url");
    const cleanupToken = randomBytes(32).toString("base64url");
    const lock = {
      waitTimeoutMs: parseInteger(
        options.waitTimeoutMs ?? process.env.SEMANTIC_CORPUS_LOCK_WAIT_MS ?? "5000",
        "lock wait",
        50,
        30_000,
      ),
      staleAfterMs: parseInteger(
        options.staleAfterMs ?? process.env.SEMANTIC_CORPUS_LOCK_STALE_MS ?? "300000",
        "lock stale",
        1000,
        86_400_000,
      ),
    };
    if (lock.staleAfterMs <= lock.waitTimeoutMs) {
      fail("LAUNCH_CONFIG_INVALID", "lock stale interval must exceed its wait interval");
    }
    const sources = await attestTrustedSources();
    const executablePath = await realpath(process.execPath);
    const expectedExecutableSha256 = await hashFile(executablePath);
    const expectedLauncherSha256 = await hashFile(launcherPath);
    const config = {
      version: 2,
      tokenHash: computeSandboxTokenHash(serverToken),
      requestHash: request.requestHash,
      manifestHash,
      sandbox: {
        path: sandboxRoot,
        identity: await identity(sandboxRoot),
      },
      roots: {
        contract: {
          path: contractRoot,
          access: "read-only",
          identity: await identity(contractRoot),
        },
        staging: {
          path: stagingRoot,
          access: "read-write",
          identity: await identity(stagingRoot),
        },
      },
      audit: {
        candidateRoot: sandboxRoot,
        logicalStagingPath: `staging/${request.runId}.json`,
        runId: request.runId,
        blockId: request.generator.blockId,
        armId: request.generator.armId,
        sessionId:
          options.workerSessionId ??
          process.env.SEMANTIC_CORPUS_WORKER_SESSION_ID ??
          `${request.runId}-worker`,
      },
      lock,
      confinement: {
        provider: "trusted-launcher-v1",
        platform: process.platform,
        permissionModel: true,
        filesystemPolicy: "node-permission-allowlist",
        networkPolicy: "trusted-source-no-network-imports",
        repository: {
          path: canonicalRepo,
          identity: await identity(canonicalRepo),
          sourceHash: sha256(canonicalJson(sources)),
        },
        deniedReadRoots: [canonicalRepo],
        executable: {
          path: executablePath,
          sha256: expectedExecutableSha256,
        },
        launcher: {
          path: launcherPath,
          sha256: expectedLauncherSha256,
        },
        sources,
      },
    };
    const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    const configSha256 = sha256(configBytes);
    const expectedServerSha256 = sources.find(
      (source) => source.path === serverPath,
    ).sha256;
    await writePrivateFile(configPath, configBytes);
    await applyAccessPolicy(contractRoot, stagingRoot, configPath);
    verifyAccessProbe(requestPath, stagingRoot, configPath);

    const state = await writeState(
      statePath,
      {
        version: 1,
        runId: request.runId,
        sandboxRoot,
        contractRoot,
        stagingRoot,
        configPath,
        stagingPath: path.join(stagingRoot, `${request.runId}.json`),
        logicalStagingPath: `staging/${request.runId}.json`,
        auditPath,
        configSha256,
        expectedServerSha256,
        expectedExecutableSha256,
        executablePath,
        expectedLauncherSha256,
        requestHash: request.requestHash,
        manifestHash,
        lock,
        createdAt: new Date().toISOString(),
      },
      serverToken,
      cleanupToken,
      runtimeReservations,
    );
    return {
      [PREPARED_SANDBOX]: true,
      statePath,
      state,
      request,
      config,
      serverToken,
      cleanupToken,
      cleanupTokenPath,
      auditPath,
    };
  } catch (error) {
    if (sandboxRoot) {
      await restoreWritable(sandboxRoot).catch(() => {});
      await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
    }
    await Promise.all(runtimeReservations.map(releaseRuntimeReservation));
    throw error;
  }
}

function permissionArguments(prepared) {
  return [
    "--permission",
    ...trustedSources.map((source) => `--allow-fs-read=${source}`),
    `--allow-fs-read=${prepared.state.executablePath}`,
    `--allow-fs-read=${launcherPath}`,
    `--allow-fs-read=${prepared.state.sandboxRoot}`,
    `--allow-fs-read=${prepared.state.configPath}`,
    `--allow-fs-read=${prepared.state.contractRoot}`,
    `--allow-fs-read=${prepared.state.stagingRoot}`,
    `--allow-fs-write=${prepared.state.stagingRoot}`,
    serverPath,
  ];
}

export function createPreparedBootPayload(prepared, options = {}) {
  const boot = createLauncherBootEnvelope({
    configPath: prepared.state.configPath,
    configSha256: prepared.state.configSha256,
    config: prepared.config,
    serverToken: prepared.serverToken,
    expectedServerPath: serverPath,
    expectedServerSha256: prepared.state.expectedServerSha256,
    expectedExecutablePath: prepared.state.executablePath,
    expectedExecutableSha256: prepared.state.expectedExecutableSha256,
    expectedLauncherPath: launcherPath,
    expectedLauncherSha256: prepared.state.expectedLauncherSha256,
    stagingRoot: prepared.state.stagingRoot,
    lifetimeMs: options.lifetimeMs,
    now: options.now,
  });
  writeFileSync(
    boot.payload.replayPath,
    boot.payload.replayToken,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return boot;
}

export function spawnPreparedServer(prepared, stdio = ["pipe", "pipe", "pipe"]) {
  const boot = createPreparedBootPayload(prepared);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SEMANTIC_CORPUS_")) delete env[key];
  }
  const child = spawn(process.execPath, permissionArguments(prepared), {
    cwd: prepared.state.sandboxRoot,
    env,
    stdio: [...stdio.slice(0, 3), "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdio[3].end(boot.bytes);
  child.stdio[4].end(boot.publicKeyBytes);
  const auditStream = createWriteStream(prepared.state.auditPath, { flags: "a" });
  child.stdio[5].pipe(auditStream);
  child.auditDone = new Promise((resolve, reject) => {
    auditStream.once("finish", resolve);
    auditStream.once("error", reject);
  });
  child.bootEnvelope = boot;
  return child;
}

async function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function cleanupDeadOwnerTemporaries(stagingRoot, ownerPid) {
  const escapedPid = String(ownerPid).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const scenarioPattern = new RegExp(
    `^\\.[A-Za-z0-9._-]+\\.json\\.${escapedPid}\\.[a-f0-9]{16}\\.tmp$`,
    "u",
  );
  const lockPattern = new RegExp(
    `^\\.corpus\\.lock\\.${escapedPid}\\.[a-f0-9]{32}\\.tmp$`,
    "u",
  );
  for (const directory of [stagingRoot, path.join(stagingRoot, "scenarios")]) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!scenarioPattern.test(entry.name) && !lockPattern.test(entry.name)) continue;
      const target = path.join(directory, entry.name);
      const stats = await lstat(target);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        fail("LOCK_INVALID", "dead-owner temporary is not a regular file");
      }
      await rm(target);
    }
  }
}

async function atomicPublishRecovery(recoveryPath, bytes) {
  const temporaryPath = `${recoveryPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  let identity;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    identity = identityFromStats(await handle.stat({ bigint: true }));
    await handle.close();
    handle = undefined;
    await link(temporaryPath, recoveryPath);
    await rm(temporaryPath);
    return identity;
  } finally {
    if (handle) await handle.close().catch(() => {});
    const temporary = await lstat(temporaryPath, { bigint: true }).catch(() => undefined);
    if (
      temporary &&
      identity &&
      identitiesEqual(identityFromStats(temporary), identity)
    ) {
      await rm(temporaryPath).catch(() => {});
    }
  }
}

async function reclaimAbandonedRecovery(recoveryPath, state) {
  const stats = await lstat(recoveryPath, { bigint: true }).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stats) return true;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail("LOCK_INVALID", "staging recovery lock is not a regular file");
  }
  const recoveryBytes = await readFile(recoveryPath);
  let recovery;
  try {
    recovery = JSON.parse(recoveryBytes);
  } catch {
    fail("LOCK_INVALID", "staging recovery lock metadata is not valid JSON");
  }
  if (
    recovery.requestHash !== state.requestHash ||
    recovery.hostname !== os.hostname() ||
    !Number.isSafeInteger(recovery.pid) ||
    !/^[a-f0-9]{32}$/u.test(recovery.nonce ?? "")
  ) {
    fail("LOCK_INVALID", "staging recovery lock is not authorized for this run");
  }
  if (
    Date.now() - Number(stats.mtimeMs) < state.lock.staleAfterMs ||
    await processIsAlive(recovery.pid)
  ) {
    fail("LOCK_RECOVERY_ACTIVE", "another authorized staging recovery is active");
  }
  const identity = identityFromStats(stats);
  const quarantine = `${recoveryPath}.abandoned-${randomBytes(8).toString("hex")}`;
  try {
    await rename(recoveryPath, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const moved = await lstat(quarantine, { bigint: true });
  if (
    !identitiesEqual(identityFromStats(moved), identity) ||
    sha256(await readFile(quarantine)) !== sha256(recoveryBytes)
  ) {
    await rename(quarantine, recoveryPath).catch(() => {});
    fail("LOCK_CHANGED", "staging recovery lock changed during reclamation");
  }
  await rm(quarantine);
  return true;
}

async function acquireRecoveryInterlock(state) {
  const recoveryPath = path.join(state.stagingRoot, ".corpus.recovery.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const recovery = {
      version: 1,
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
      nonce: randomBytes(16).toString("hex"),
      requestHash: state.requestHash,
    };
    const bytes = canonicalJsonBytes(recovery);
    try {
      const identity = await atomicPublishRecovery(recoveryPath, bytes);
      return { recoveryPath, recovery, bytes, identity };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await reclaimAbandonedRecovery(recoveryPath, state);
    }
  }
  fail("LOCK_RECOVERY_ACTIVE", "another authorized staging recovery is active");
}

async function cleanupAbandonedQuarantines(state) {
  const entries = await readdir(state.stagingRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!/^\.corpus\.lock\.recovery-[a-f0-9]{32}$/u.test(entry.name)) continue;
    const target = path.join(state.stagingRoot, entry.name);
    const stats = await lstat(target, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      fail("LOCK_INVALID", "quarantined staging lock is not a regular file");
    }
    const bytes = await readFile(target);
    let owner;
    try {
      owner = JSON.parse(bytes);
    } catch {
      fail("LOCK_INVALID", "quarantined staging lock metadata is not valid JSON");
    }
    if (
      owner.requestHash !== state.requestHash ||
      owner.hostname !== os.hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      Date.now() - Number(stats.mtimeMs) < state.lock.staleAfterMs ||
      await processIsAlive(owner.pid)
    ) {
      fail("LOCK_INVALID", "quarantined staging lock cannot be safely recovered");
    }
    await cleanupDeadOwnerTemporaries(state.stagingRoot, owner.pid);
    await rm(target);
  }
}

export async function cleanupStaleLock(statePath, cleanupToken) {
  const loaded = await loadState(statePath, cleanupToken);
  const lockPath = path.join(loaded.state.stagingRoot, ".corpus.lock");
  const interlock = await acquireRecoveryInterlock(loaded.state);
  try {
    await cleanupAbandonedQuarantines(loaded.state);

    let lockStats;
    try {
      lockStats = await lstat(lockPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "absent" };
      throw error;
    }
    if (lockStats.isSymbolicLink() || !lockStats.isFile()) {
      fail("LOCK_INVALID", "staging lock is not a regular file");
    }
    if (Date.now() - Number(lockStats.mtimeMs) < loaded.state.lock.staleAfterMs) {
      fail("LOCK_ACTIVE", "staging lock has not reached the authorized stale interval");
    }
    const lockIdentity = identityFromStats(lockStats);
    const lockBytes = await readFile(lockPath);
    let owner;
    try {
      owner = JSON.parse(lockBytes);
    } catch {
      fail("LOCK_INVALID", "staging lock owner metadata is not valid JSON");
    }
    if (
      owner.requestHash !== loaded.state.requestHash ||
      owner.hostname !== os.hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      typeof owner.nonce !== "string"
    ) {
      fail("LOCK_INVALID", "staging lock owner metadata is not authorized for this run");
    }
    if (await processIsAlive(owner.pid)) {
      fail("LOCK_ACTIVE", "staging lock owner is still alive");
    }
    await cleanupDeadOwnerTemporaries(loaded.state.stagingRoot, owner.pid);

    const beforeMove = await lstat(lockPath, { bigint: true });
    if (
      !identitiesEqual(identityFromStats(beforeMove), lockIdentity) ||
      sha256(await readFile(lockPath)) !== sha256(lockBytes)
    ) {
      fail("LOCK_CHANGED", "staging lock changed during authorized recovery");
    }
    const quarantine = path.join(
      loaded.state.stagingRoot,
      `.corpus.lock.recovery-${interlock.recovery.nonce}`,
    );
    await rename(lockPath, quarantine);
    const quarantined = await lstat(quarantine, { bigint: true });
    if (!identitiesEqual(identityFromStats(quarantined), lockIdentity)) {
      await rename(quarantine, lockPath).catch(() => {});
      fail("LOCK_CHANGED", "staging lock identity changed during authorized recovery");
    }
    await rm(quarantine);
    return { status: "removed", ownerPid: owner.pid, requestHash: owner.requestHash };
  } finally {
    const onDisk = await lstat(interlock.recoveryPath, { bigint: true }).catch(
      () => undefined,
    );
    if (
      onDisk &&
      identitiesEqual(identityFromStats(onDisk), interlock.identity) &&
      sha256(
        await readFile(interlock.recoveryPath).catch(() => Buffer.alloc(0)),
      ) === sha256(interlock.bytes)
    ) {
      await rm(interlock.recoveryPath).catch(() => {});
    }
  }
}

async function verifyContractManifest(state) {
  const manifestPath = path.join(state.contractRoot, "contract-manifest.json");
  const manifestBytes = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch {
    fail("MANIFEST_HASH_MISMATCH", "contract manifest is not valid JSON");
  }
  if (
    !manifestBytes.equals(canonicalJsonBytes(manifest)) ||
    sha256(manifestBytes) !== state.manifestHash ||
    manifest?.version !== 1 ||
    !Array.isArray(manifest.files)
  ) {
    fail("MANIFEST_HASH_MISMATCH", "contract manifest bytes or hash changed");
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "path,sha256" ||
      typeof entry.path !== "string" ||
      !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      seen.has(entry.path)
    ) {
      fail("MANIFEST_HASH_MISMATCH", "contract manifest contains an invalid entry");
    }
    seen.add(entry.path);
    const target = path.resolve(state.contractRoot, ...entry.path.split("/"));
    if (!isWithin(state.contractRoot, target) || await hashFile(target) !== entry.sha256) {
      fail("MANIFEST_HASH_MISMATCH", `contract file hash changed: ${entry.path}`);
    }
  }
}

export async function verifyStagingState(
  statePath,
  expectedPayloadSha256,
  cleanupToken,
) {
  requireText(expectedPayloadSha256, "payloadSha256", /^[a-f0-9]{64}$/u);
  const loaded = await loadState(statePath, cleanupToken);
  await verifyContractManifest(loaded.state);
  const [request, payloadBytes] = await Promise.all([
    readJson(path.join(loaded.state.contractRoot, "request.json"), "corpus request"),
    readFile(loaded.state.stagingPath),
  ]);
  validateRequestDocument(request);
  if (
    request.requestHash !== loaded.state.requestHash ||
    request.manifestHash !== loaded.state.manifestHash
  ) {
    fail("REQUEST_HASH_MISMATCH", "launcher state no longer matches the immutable request");
  }
  const actualHash = sha256(payloadBytes);
  if (actualHash !== expectedPayloadSha256) {
    fail("PAYLOAD_HASH_MISMATCH", "staging payload does not match the delegated hash");
  }
  let payload;
  try {
    payload = JSON.parse(payloadBytes);
  } catch {
    fail("STAGING_INVALID", "staging payload is not valid JSON");
  }
  if (!payloadBytes.equals(canonicalJsonBytes(payload))) {
    fail("STAGING_NONCANONICAL", "staging payload bytes are not canonical");
  }
  validateStagingPayload(request, payload);
  const assessment = assessStaging(payload);
  const errors = [
    ...assessment.submissionErrors,
    ...assessment.cases.flatMap((entry) => entry.errors),
  ];
  if (assessment.submittedCases > 60) {
    fail("STAGING_INVALID", "staging payload exceeds the registered 60-slot target");
  }
  return {
    stagingPath: loaded.state.logicalStagingPath,
    payloadSha256: actualHash,
    submittedCases: assessment.submittedCases,
    promotableCases: assessment.promotableCases,
    errorCount: errors.length,
  };
}

async function restoreWritable(target) {
  if (process.platform === "win32") {
    const sid = currentWindowsSid();
    runIcacls(
      [target, "/inheritance:e", "/grant:r", `*${sid}:(OI)(CI)F`, "/T", "/C", "/Q"],
      "failed to restore sandbox cleanup ACL",
    );
  } else {
    for (const entry of (await walkTree(target)).sort((left, right) => left.path.length - right.path.length)) {
      await chmod(entry.path, entry.directory ? 0o700 : 0o600);
    }
  }
}

export async function disposePreparedSandbox(prepared) {
  if (!prepared?.[PREPARED_SANDBOX]) {
    fail("STATE_AUTHORIZATION_FAILED", "sandbox disposal requires the original prepared capability");
  }
  const lockPath = path.join(prepared.state.stagingRoot, ".corpus.lock");
  let lockExists = true;
  try {
    const lockStats = await lstat(lockPath);
    if (lockStats.isSymbolicLink() || !lockStats.isFile()) {
      fail("LOCK_INVALID", "cannot dispose a sandbox with an invalid lock");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    lockExists = false;
  }
  if (lockExists) {
    const owner = await readJson(lockPath, "staging lock");
    if (
      owner.hostname !== os.hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      await processIsAlive(owner.pid)
    ) {
      fail("LOCK_ACTIVE", "cannot dispose a sandbox while its lock owner may be alive");
    }
  }
  await restoreWritable(prepared.state.sandboxRoot);
  await rm(prepared.state.sandboxRoot, { recursive: true, force: true });
  await Promise.all([
    rm(prepared.statePath, { force: true }),
    rm(`${prepared.statePath}.server-token`, { force: true }),
    rm(prepared.cleanupTokenPath, { force: true }),
    rm(prepared.auditPath, { force: true }),
  ]);
}

async function launch(prepared) {
  const child = spawnPreparedServer(prepared);
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let terminating = false;
  let forcedTermination;
  const terminateGracefully = (signal) => {
    if (child.killed || child.exitCode !== null) return;
    if (terminating) {
      child.kill(signal);
      return;
    }
    terminating = true;
    process.stdin.unpipe(child.stdin);
    child.stdin.end();
    forcedTermination = setTimeout(() => {
      if (child.exitCode === null) child.kill(signal);
    }, 5000);
    forcedTermination.unref();
  };
  process.once("SIGINT", () => terminateGracefully("SIGINT"));
  process.once("SIGTERM", () => terminateGracefully("SIGTERM"));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  await child.auditDone;
  if (forcedTermination) clearTimeout(forcedTermination);
  process.exitCode = code;
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "launch";
  if (command === "launch") {
    await launch(await prepareSandbox());
    return;
  }
  const statePath = argument(args, "--state");
  if (!statePath) {
    fail("LAUNCH_CONFIG_INVALID", `${command} requires --state <absolute-path>`);
  }
  if (command === "resume") {
    const cleanupToken = requireText(
      process.env.SEMANTIC_CORPUS_CLEANUP_TOKEN,
      "SEMANTIC_CORPUS_CLEANUP_TOKEN",
      /^[A-Za-z0-9_-]{40,128}$/u,
    );
    await cleanupStaleLock(statePath, cleanupToken);
    const loaded = await loadState(statePath, cleanupToken);
    await launch({
      statePath: loaded.statePath,
      state: loaded.state,
      serverToken: loaded.serverToken,
      config: loaded.config,
    });
    return;
  }
  if (command === "cleanup-lock") {
    const cleanupToken = requireText(
      process.env.SEMANTIC_CORPUS_CLEANUP_TOKEN,
      "SEMANTIC_CORPUS_CLEANUP_TOKEN",
      /^[A-Za-z0-9_-]{40,128}$/u,
    );
    process.stdout.write(
      `${JSON.stringify(await cleanupStaleLock(statePath, cleanupToken))}\n`,
    );
    return;
  }
  if (command === "verify") {
    const payloadSha256 = argument(args, "--payload-sha256");
    const cleanupToken = requireText(
      process.env.SEMANTIC_CORPUS_CLEANUP_TOKEN,
      "SEMANTIC_CORPUS_CLEANUP_TOKEN",
      /^[A-Za-z0-9_-]{40,128}$/u,
    );
    process.stdout.write(
      `${JSON.stringify(
        await verifyStagingState(statePath, payloadSha256, cleanupToken),
      )}\n`,
    );
    return;
  }
  fail("LAUNCH_CONFIG_INVALID", `unknown launcher command "${command}"`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof LauncherError ? error.code : error?.code ?? "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : "unknown launcher error";
    process.stderr.write(`${code}: ${message}\n`);
    process.exit(78);
  });
}
