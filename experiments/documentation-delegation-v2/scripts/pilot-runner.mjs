#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import {isAbsolute, relative, resolve, sep} from "node:path";
import {
  experimentRoot,
  protocolId,
  readJson,
  repositoryRoot,
  sha256,
  stableStringify
} from "./lib.mjs";

export const parentTools = Object.freeze({
  A1: Object.freeze(["read", "edit", "bash"]),
  A2: Object.freeze(["read", "edit", "bash", "skill", "task"])
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function candidatePath(root, value) {
  if (typeof value !== "string" || !value || isAbsolute(value)) {
    throw new Error("candidate policy path must be relative");
  }
  const path = resolve(root, value);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("candidate policy path escapes candidate root");
  }
  return path;
}

export function freezeCandidatePolicy(candidateRoot) {
  const root = resolve(candidateRoot);
  const manifest = JSON.parse(readFileSync(resolve(root, "CANDIDATE.json"), "utf8"));
  const policy = {
    protocolId: manifest.protocolId,
    candidateRoot: root,
    sourcePath: candidatePath(root, manifest.sourcePath),
    docTarget: candidatePath(root, manifest.docTarget),
    allowedWorkerReads: manifest.allowedWorkerReads.map((item) => candidatePath(root, item)),
    allowedWorkerWrites: manifest.allowedWorkerWrites.map((item) => candidatePath(root, item)),
    workerEditCount: manifest.workerEditCount
  };
  if (policy.protocolId !== protocolId
    || policy.workerEditCount !== 1
    || policy.allowedWorkerWrites.length !== 1
    || policy.allowedWorkerWrites[0] !== policy.docTarget) {
    throw new Error("candidate policy differs from the frozen treatment contract");
  }
  return deepFreeze(policy);
}

export function buildCopilotArgs(run, candidateRoot, disabledMcpServers = []) {
  const prompts = readJson(resolve(experimentRoot, "design", "prompts.json"));
  const prompt = `${prompts.sharedEnvelope}\n\n${prompts[run.arm]}`;
  return [
    "-p", prompt,
    "--session-id", run.parentSessionId,
    "--model", "gpt-5.6-sol",
    "--output-format", "json",
    "-C", resolve(candidateRoot),
    "--allow-all-tools",
    `--available-tools=${parentTools[run.arm].join(",")}`,
    "--disable-builtin-mcps",
    ...disabledMcpServers.flatMap((name) => ["--disable-mcp-server", name]),
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export",
    "--no-auto-update",
    "--context", "default",
    "--effort", "medium"
  ];
}

export function inspectCandidateLaunch({candidateRoot, args, environment, forbiddenPaths}) {
  const normalizedForbidden = forbiddenPaths.map((item) => resolve(item).toLowerCase());
  const disclosures = [];
  for (const [surface, values] of [
    ["argument", args],
    ["environment", Object.values(environment)]
  ]) {
    for (const value of values) {
      if (typeof value !== "string") continue;
      const found = normalizedForbidden.find((item) => value.toLowerCase().includes(item));
      if (found) disclosures.push(`${surface} disclosed a coordinator path`);
    }
  }
  const root = resolve(candidateRoot);
  if (!args.includes(root)) disclosures.push("candidate root is absent from CLI arguments");
  return {pass: disclosures.length === 0, reasons: [...new Set(disclosures)].sort()};
}

export function reserveSlot(lockRoot, run, sourceManifestRootHash) {
  mkdirSync(lockRoot, {recursive: true});
  const path = resolve(lockRoot, run.observationId);
  mkdirSync(path);
  const record = {
    schemaVersion: 2,
    protocolId,
    observationId: run.observationId,
    parentSessionId: run.parentSessionId,
    workerSessionId: run.workerSessionId,
    worktreeId: run.worktreeId,
    sourceManifestRootHash,
    state: "reserved",
    startCount: 0
  };
  writeFileSync(resolve(path, "reservation.json"), stableStringify(record), {flag: "wx"});
  return path;
}

export function markStarted(lockPath) {
  const record = JSON.parse(readFileSync(resolve(lockPath, "reservation.json"), "utf8"));
  if (existsSync(resolve(lockPath, "started.json"))
    || existsSync(resolve(lockPath, "terminal.json"))
    || record.state !== "reserved"
    || record.startCount !== 0) {
    throw new Error("slot cannot start more than once");
  }
  const started = {...record, state: "started", startCount: 1};
  writeFileSync(resolve(lockPath, "started.json"), stableStringify(started), {flag: "wx"});
  return started;
}

export function terminalDisposition(lockPath, disposition) {
  if (existsSync(resolve(lockPath, "terminal.json"))) {
    throw new Error("slot already has a terminal disposition");
  }
  const startedPath = resolve(lockPath, "started.json");
  const source = existsSync(startedPath) ? startedPath : resolve(lockPath, "reservation.json");
  const record = JSON.parse(readFileSync(source, "utf8"));
  const terminal = {...record, state: "terminal", disposition};
  writeFileSync(resolve(lockPath, "terminal.json"), stableStringify(terminal), {flag: "wx"});
  return terminal;
}

function parseArguments(argv) {
  const output = {mode: null, values: {}};
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dry-run" || item === "--preflight") {
      if (output.mode) throw new Error("choose one runner mode");
      output.mode = item.slice(2);
    } else if (item === "--execute") {
      throw new Error("execution is not implemented or authorized in this design");
    } else if (item.startsWith("--")) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${item}`);
      output.values[item.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unexpected argument: ${item}`);
    }
  }
  if (!output.mode) throw new Error("use --dry-run or --preflight");
  return output;
}

function externalFreshRoot(value, name) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be absolute`);
  const root = resolve(value);
  const rel = relative(repositoryRoot, root);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`${name} must be external to the repository`);
  }

  if (existsSync(root)) throw new Error(`${name} must not exist before execution`);
  return root;
}

export function rootsOverlap(left, right) {
  const path = relative(left, right);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function inspectCli(path) {
  if (!path || !isAbsolute(path) || !existsSync(path)) {
    throw new Error("cli must be an existing absolute executable path");
  }
  const version = spawnSync(path, ["--version"], {encoding: "utf8", windowsHide: true});
  const help = spawnSync(path, ["--help"], {encoding: "utf8", windowsHide: true});
  if (version.status !== 0 || !version.stdout.includes("1.0.71")) {
    throw new Error("GitHub Copilot CLI version is not 1.0.71");
  }
  for (const token of [
    "--prompt", "--session-id", "--model", "--output-format", "--available-tools",
    "--disable-builtin-mcps", "--no-custom-instructions", "--effort"
  ]) {
    if (!help.stdout.includes(token)) throw new Error(`CLI help lacks ${token}`);
  }
  return {version: version.stdout.trim(), sha256: sha256(readFileSync(path))};
}

export function dryRun() {
  const boundary = readJson(resolve(experimentRoot, "design", "execution-boundary.json"));
  const schedule = readJson(resolve(experimentRoot, "design", "schedule.json"));
  if (boundary.pilotAuthorized || boundary.mainAuthorized || boundary.executeEntryPoint !== null) {
    throw new Error("no-run execution boundary is not closed");
  }
  return {
    schemaVersion: 2,
    protocolId,
    canExecute: false,
    modes: boundary.runnerModes,
    pilotOrder: schedule.pilot.flatMap((block) =>
      block.runs.map((run) => run.observationId))
  };
}

export function preflight(values) {
  const required = ["cli", "session-store", "artifact-root", "candidate-root"];
  const missing = required.filter((name) => !values[name]);
  if (missing.length) throw new Error(`missing required options: ${missing.join(", ")}`);
  if (!isAbsolute(values["session-store"]) || !existsSync(values["session-store"])) {
    throw new Error("session-store must be an existing absolute path");
  }
  const artifactRoot = externalFreshRoot(values["artifact-root"], "artifact-root");
  const candidateRoot = externalFreshRoot(values["candidate-root"], "candidate-root");
  if (rootsOverlap(artifactRoot, candidateRoot) || rootsOverlap(candidateRoot, artifactRoot)) {
    throw new Error("external roots must be disjoint");
  }
  const cli = inspectCli(values.cli);
  return {
    ...dryRun(),
    preflightPass: true,
    cli,
    roots: {artifact: "fresh-external", candidate: "fresh-external"},
    sessionStore: "existing-read-only-inspection-required-at-authorization",
    authorizationRequired: true,
    executeEntryPoint: null
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = parseArguments(process.argv);
  process.stdout.write(stableStringify(
    args.mode === "dry-run" ? dryRun() : preflight(args.values)
  ));
}
