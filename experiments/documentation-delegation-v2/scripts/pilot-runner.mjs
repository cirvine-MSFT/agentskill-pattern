#!/usr/bin/env node
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import {homedir} from "node:os";
import {delimiter, isAbsolute, relative, resolve, sep} from "node:path";
import {evaluate} from "./evaluate.mjs";
import {materializeFixture} from "./generate-fixture.mjs";
import {
  assertPrivacySafe,
  aggregateTiming,
  aggregateUsage,
  auditRuntime,
  buildCopilotArgs,
  CLI_VERSION,
  concisePilotSummary,
  evidenceHash,
  evaluatePilotGate,
  frozenPilotPlan,
  integrityCriticalMissingActors,
  inspectCliSurface,
  NODE_VERSION,
  normalizedPathHash,
  parseCopilotJsonl,
  privacyNormalize,
  sha256,
  startedFrom,
  workerActivityStarted
} from "./pilot-contract.mjs";
import {
  directoryDigest,
  experimentRoot,
  indexBytes,
  protocolId,
  readJson,
  repositoryRoot,
  stableStringify,
  walkFiles
} from "./lib.mjs";

const authorizationPath = resolve(experimentRoot, "design", "authorization.json");
const authorizationManifestPath = resolve(
  experimentRoot,
  "design",
  "authorization-index-manifest.json"
);
const preregistrationManifestPath = resolve(experimentRoot, "design", "source-manifest.json");
const usageColumns = [
  "id", "session_id", "turn_index", "agent_id", "parent_tool_call_id", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "reasoning_tokens", "total_nano_aiu", "request_multiplier", "duration_ms",
  "time_to_first_token_ms", "inter_token_latency_ms", "initiator", "api_endpoint",
  "reasoning_effort", "finish_reason", "content_filter_triggered",
  "token_details_json", "created_at"
];

function commandParts(command) {
  return command.toLowerCase().endsWith(".mjs")
    ? [process.execPath, resolve(command)]
    : [command];
}

function liveOriginMain() {
  const result = invoke("git", [
    "-C", repositoryRoot,
    "ls-remote", "--exit-code", "origin", "refs/heads/main"
  ]);
  assert.equal(result.status, 0, `could not resolve live origin/main: ${result.stderr}`);
  const rows = String(result.stdout ?? "").trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(rows.length, 1, "live origin/main did not resolve to exactly one ref");
  const [commit, ref] = rows[0].split(/\s+/u);
  assert.match(commit, /^[0-9a-f]{40}$/u);
  assert.equal(ref, "refs/heads/main");
  return commit;
}

function invoke(command, args, options = {}) {
  const [executable, ...prefix] = commandParts(command);
  return spawnSync(executable, [...prefix, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options
  });
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function parseMcpList(stdout) {
  const names = [];
  for (const line of String(stdout ?? "").split(/\r?\n/u)) {
    const match = /^\s{2}([A-Za-z0-9._-]+)\s+\((?:local|remote)\)\s*$/u.exec(line);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

function pythonQuery(script, args) {
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  const failures = [];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c", script, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
    failures.push(result.error?.message ?? result.stderr.trim());
  }
  throw new Error(`read-only session-store query failed: ${failures.join("; ")}`);
}

function inspectUsageStore(database) {
  if (!isAbsolute(database) || !existsSync(database)) {
    return {ok: false, columns: [], reason: "session store is missing"};
  }
  const script = [
    "import json, sqlite3, sys",
    "db=sqlite3.connect('file:'+sys.argv[1].replace('\\\\','/')+'?mode=ro',uri=True)",
    "columns=[r[1] for r in db.execute(\"pragma table_info('assistant_usage_events')\")]",
    "print(json.dumps(columns))"
  ].join("\n");
  const columns = pythonQuery(script, [resolve(database)]);
  const missing = usageColumns.filter((column) => !columns.includes(column));
  return {
    ok: missing.length === 0,
    columns,
    schemaSha256: sha256(stableStringify(columns)),
    reason: missing.length ? `assistant_usage_events is missing: ${missing.join(", ")}` : null
  };
}

export function consumedStudyIds(database, ids) {
  const script = [
    "import json, sqlite3, sys",
    "db=sqlite3.connect('file:'+sys.argv[1].replace('\\\\','/')+'?mode=ro',uri=True)",
    "ids=json.loads(sys.argv[2]); used=set()",
    "tables={r[0] for r in db.execute(\"select name from sqlite_master where type='table'\")}",
    "marks=','.join('?' for _ in ids)",
    "if 'sessions' in tables: used.update(r[0] for r in db.execute('select id from sessions where id in ('+marks+')',ids))",
    "if 'assistant_usage_events' in tables:",
    "  used.update(r[0] for r in db.execute('select distinct session_id from assistant_usage_events where session_id in ('+marks+')',ids))",
    "  used.update(r[0] for r in db.execute('select distinct agent_id from assistant_usage_events where agent_id in ('+marks+')',ids))",
    "print(json.dumps(sorted(used)))"
  ].join("\n");
  return pythonQuery(script, [resolve(database), JSON.stringify(ids)]);
}

function readUsageRows(database, sessionId) {
  const query = `select ${usageColumns.join(",")} from assistant_usage_events `
    + "where session_id=? order by id";
  const script = [
    "import json, sqlite3, sys",
    "db=sqlite3.connect('file:'+sys.argv[1].replace('\\\\','/')+'?mode=ro',uri=True)",
    "db.row_factory=sqlite3.Row",
    `rows=[dict(r) for r in db.execute(${JSON.stringify(query)},(sys.argv[2],))]`,
    "print(json.dumps(rows,separators=(',',':')))"
  ].join("\n");
  return pythonQuery(script, [resolve(database), sessionId]);
}

export function settledUsage(database, sessionId, exporter = readUsageRows) {
  let latest = [];
  let previous = null;
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    latest = exporter(database, sessionId);
    const hash = sha256(JSON.stringify(latest));
    stable = hash === previous ? stable + 1 : 1;
    previous = hash;
    if (latest.length && stable >= 3) return latest;
    if (exporter !== readUsageRows) continue;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (latest.length) {
    const error = new Error("usage rows did not settle to three identical snapshots");
    error.latestRows = latest;
    throw error;
  }
  return latest;
}

function writeOnce(path, value) {
  mkdirSync(resolve(path, ".."), {recursive: true});
  writeFileSync(
    path,
    Buffer.isBuffer(value) ? value : stableStringify(value),
    {flag: "wx"}
  );
}

function immutable(path) {
  chmodSync(path, 0o444);
}

export function verifyAuthorizationPayload(authorization, {enforceExpiry = false} = {}) {
  const payload = {...authorization};
  delete payload.payloadSha256;
  assert.equal(
    sha256(stableStringify(payload)),
    authorization.payloadSha256,
    "authorization payload hash is invalid"
  );
  assert.equal(authorization.protocolId, protocolId);
  assert.equal(authorization.pilotAuthorized, true, "excluded pilot is not authorized");
  assert.equal(authorization.mainAuthorized, false, "main execution must remain forbidden");
  assert.equal(authorization.requiresExecuteFlag, true);
  const issuedAt = Date.parse(authorization.issuedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  assert(Number.isFinite(issuedAt) && Number.isFinite(expiresAt) && issuedAt < expiresAt,
    "pilot authorization time window is invalid");
  if (enforceExpiry) assert(expiresAt > Date.now(), "pilot authorization has expired");
}

function verifyPreregistration(authorization) {
  const manifest = readJson(preregistrationManifestPath);
  assert.equal(
    manifest.sourceRootHash,
    authorization.preregistrationSourceRootHash,
    "authorization does not bind the merged preregistration"
  );
  const mutable = new Set(authorization.reviewedMutablePaths);
  let verified = 0;
  for (const [path, entry] of Object.entries(manifest.sources)) {
    if (mutable.has(path)) continue;
    const bytes = indexBytes(path);
    assert.equal(bytes.length, entry.bytes, `preregistered byte length drift: ${path}`);
    assert.equal(sha256(bytes), entry.indexSha256, `preregistered index-byte drift: ${path}`);
    verified += 1;
  }
  return {sourceRootHash: manifest.sourceRootHash, verifiedFrozenFiles: verified};
}

function verifyAuthorizationManifest(authorization) {
  const relativePath = relative(repositoryRoot, authorizationManifestPath).split(sep).join("/");
  const bytes = indexBytes(relativePath);
  assert.equal(
    sha256(bytes),
    authorization.authorizationIndexManifestSha256,
    "authorization index manifest bytes differ"
  );
  const manifest = JSON.parse(bytes);
  assert.equal(
    sha256(stableStringify(manifest.files)),
    manifest.rootHash,
    "authorization index manifest root is invalid"
  );
  for (const entry of manifest.files) {
    const staged = indexBytes(entry.path);
    assert.equal(staged.length, entry.bytes, `authorized byte length drift: ${entry.path}`);
    assert.equal(sha256(staged), entry.indexSha256, `authorized index-byte drift: ${entry.path}`);
  }
  return {rootHash: manifest.rootHash, files: manifest.files.length};
}

function ensureExternalAbsentRoot(value, expectedHash, name) {
  assert(value && isAbsolute(value), `${name} must be absolute`);
  const root = resolve(value);
  const rel = relative(repositoryRoot, root);
  assert(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel),
    `${name} must be external to the repository`);
  assert.equal(normalizedPathHash(root), expectedHash, `${name} identity differs from authorization`);
  assert(!existsSync(root), `${name} must not exist before execution`);
  return root;
}

export function rootsOverlap(left, right) {
  const rel = relative(left, right);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function observedCli(cli) {
  const version = invoke(cli, ["--version"]);
  const help = invoke(cli, ["--help"]);
  const mcp = invoke(cli, ["mcp", "list"]);
  assert.equal(version.status, 0, "Copilot CLI version probe failed");
  assert.equal(help.status, 0, "Copilot CLI help probe failed");
  assert.equal(mcp.status, 0, "Copilot CLI MCP enumeration failed");
  return {
    version: version.stdout,
    help: help.stdout,
    configuredMcpServers: parseMcpList(mcp.stdout)
  };
}

export function collectStaticPreflight({
  cli,
  sessionStore,
  artifactRoot,
  candidateRoot,
  authorizationOverride = null,
  gitEvidence = null,
  cliEvidence = null,
  usageStoreEvidence = null,
  consumedIdsEvidence = null,
  skipIndexVerification = false,
  nodeVersion = process.versions.node
}) {
  const authorization = authorizationOverride ?? readJson(authorizationPath);
  verifyAuthorizationPayload(authorization, {enforceExpiry: true});
  assert.equal(nodeVersion, NODE_VERSION, `requires exact Node.js ${NODE_VERSION}`);
  const plan = frozenPilotPlan();
  assert.deepEqual(
    plan.map(({observationId, parentSessionId, workerSessionId, worktreeId}) =>
      ({observationId, parentSessionId, workerSessionId, worktreeId})),
    authorization.pilotIdentities,
    "pilot identities differ from authorization"
  );
  const preregistration = skipIndexVerification
    ? {sourceRootHash: authorization.preregistrationSourceRootHash, verifiedFrozenFiles: null}
    : verifyPreregistration(authorization);
  const authorizedIndex = skipIndexVerification
    ? {rootHash: null, files: null}
    : verifyAuthorizationManifest(authorization);
  const artifact = ensureExternalAbsentRoot(
    artifactRoot,
    authorization.paths.artifactRootSha256,
    "artifact-root"
  );
  const candidates = ensureExternalAbsentRoot(
    candidateRoot,
    authorization.paths.candidateRootSha256,
    "candidate-root"
  );
  assert(!rootsOverlap(artifact, candidates) && !rootsOverlap(candidates, artifact),
    "external roots must be disjoint");

  const observedGit = gitEvidence ?? {
    status: git(["status", "--porcelain"]),
    head: git(["rev-parse", "HEAD"]),
    originMain: liveOriginMain(),
    preregistrationAncestor: invoke("git", [
      "-C", repositoryRoot,
      "merge-base", "--is-ancestor", authorization.preregistrationMergeCommit, "HEAD"
    ]).status === 0
  };
  assert.equal(observedGit.status, "", "repository must be clean before pilot execution");
  assert.equal(observedGit.head, observedGit.originMain,
    "execution requires a fresh checkout of current origin/main");
  assert.equal(observedGit.preregistrationAncestor, true,
    "merged preregistration commit is not an ancestor");

  assert.equal(normalizedPathHash(cli), authorization.paths.cliSha256,
    "CLI path identity differs from authorization");
  assert.equal(sha256(readFileSync(cli)), authorization.cli.binarySha256,
    "CLI binary bytes differ from authorization");
  const cliSurface = inspectCliSurface(cliEvidence ?? observedCli(cli));
  assert(cliSurface.ok, cliSurface.reasons.join("; "));
  assert.equal(cliSurface.versionLine, `GitHub Copilot CLI ${CLI_VERSION}.`);

  assert.equal(normalizedPathHash(sessionStore), authorization.paths.sessionStoreSha256,
    "session-store path identity differs from authorization");
  const usageStore = usageStoreEvidence ?? inspectUsageStore(sessionStore);
  assert(usageStore.ok, usageStore.reason);
  assert.equal(
    usageStore.schemaSha256,
    authorization.sessionStore.usageSchemaSha256,
    "session-store usage schema differs from authorization"
  );
  const ids = plan.flatMap((run) =>
    [run.parentSessionId, run.workerSessionId].filter(Boolean));
  const consumed = consumedIdsEvidence ?? consumedStudyIds(sessionStore, ids);
  assert.deepEqual(consumed, [], `pilot identities were already consumed: ${consumed.join(", ")}`);

  return {
    schemaVersion: 2,
    ok: true,
    mode: "preflight-only",
    authorizationId: authorization.authorizationId,
    authorizationPayloadSha256: authorization.payloadSha256,
    pilotAuthorized: true,
    mainAuthorized: false,
    observationsStarted: 0,
    rootsCreated: false,
    order: plan.map((run) => run.observationId),
    preregistration,
    authorizedIndex,
    repository: {head: observedGit.head, currentOriginMain: true},
    cli: cliSurface,
    usageStore: {
      schemaSha256: usageStore.schemaSha256,
      readOnly: true
    },
    consumedIds: consumed,
    roots: {artifact: "fresh-external", candidate: "fresh-external"}
  };
}

function parseArguments(argv) {
  const output = {mode: null, values: {}};
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (["--dry-run", "--preflight", "--execute"].includes(item)) {
      assert(!output.mode, "choose exactly one runner mode");
      output.mode = item.slice(2);
    } else if (item.startsWith("--")) {
      const value = argv[index + 1];
      assert(value && !value.startsWith("--"), `missing value for ${item}`);
      output.values[item.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unexpected argument: ${item}`);
    }
  }
  assert(output.mode, "use --dry-run, --preflight, or --execute");
  return output;
}

export function dryRun() {
  const boundary = readJson(resolve(experimentRoot, "design", "execution-boundary.json"));
  const authorization = readJson(authorizationPath);
  verifyAuthorizationPayload(authorization);
  assert.equal(boundary.pilotAuthorized, true);
  assert.equal(boundary.mainAuthorized, false);
  return {
    schemaVersion: 2,
    protocolId,
    canExecuteExcludedPilot: true,
    canExecuteMain: false,
    observationsStarted: 0,
    authorizationId: authorization.authorizationId,
    authorizationPayloadSha256: authorization.payloadSha256,
    modes: boundary.runnerModes,
    pilotOrder: frozenPilotPlan().map((run) => run.observationId),
    exactWindowsNpmInvocation: authorization.exactWindowsNpmInvocation
  };
}

function treeManifest(root) {
  return walkFiles(root)
    .filter((path) => !relative(root, path).split(sep).includes(".git"))
    .map((path) => ({
      path: relative(root, path).split(sep).join("/"),
      bytes: statSync(path).size,
      sha256: sha256(readFileSync(path))
    }));
}

function freezeCandidatePolicy(candidateRoot) {
  const root = resolve(candidateRoot);
  const value = JSON.parse(readFileSync(resolve(root, "CANDIDATE.json"), "utf8"));
  const candidatePath = (path) => {
    assert(typeof path === "string" && path && !isAbsolute(path), "policy path must be relative");
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    assert(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
      "policy path escapes candidate root");
    return absolute;
  };
  const policy = {
    protocolId: value.protocolId,
    candidateRoot: root,
    sourcePath: candidatePath(value.sourcePath),
    docTarget: candidatePath(value.docTarget),
    allowedWorkerReads: value.allowedWorkerReads.map(candidatePath),
    allowedWorkerWrites: value.allowedWorkerWrites.map(candidatePath),
    workerEditCount: value.workerEditCount,
    initialDocText: readFileSync(candidatePath(value.docTarget), "utf8")
  };
  assert.equal(policy.protocolId, protocolId);
  assert.equal(policy.workerEditCount, 1);
  assert.deepEqual(policy.allowedWorkerWrites, [policy.docTarget]);
  Object.values(policy).filter(Array.isArray).forEach(Object.freeze);
  return Object.freeze(policy);
}

function materializePilot(candidateRoot, artifactRoot) {
  const manifest = readJson(preregistrationManifestPath);
  const materialized = new Map();
  for (const run of frozenPilotPlan()) {
    const candidate = resolve(
      candidateRoot,
      `${String(run.globalOrder).padStart(2, "0")}-${run.worktreeId}`
    );
    const evaluator = resolve(artifactRoot, "evaluators-private", run.observationId);
    materializeFixture({
      fixtureId: run.fixtureId,
      variantId: run.variantId,
      candidateRoot: candidate,
      evaluatorRoot: evaluator,
      observationId: run.observationId
    });
    const expected = manifest.generatedBundles[`pilot/${run.fixtureId}/${run.variantId}`];
    assert(expected, `missing generated bundle hash for ${run.observationId}`);
    assert.equal(directoryDigest(candidate), expected.candidateSha256,
      `${run.observationId} candidate bundle drift`);
    assert.equal(directoryDigest(evaluator), expected.evaluatorSha256,
      `${run.observationId} evaluator bundle drift`);
    initializeCandidateRepository(candidate);
    materialized.set(run.observationId, {
      candidateRoot: candidate,
      evaluatorRoot: evaluator,
      policy: freezeCandidatePolicy(candidate),
      initialTree: treeManifest(candidate)
    });
  }
  return materialized;
}

export function initializeCandidateRepository(candidateRoot) {
  const commands = [
    ["init", "--quiet"],
    ["-c", "core.autocrlf=false", "add", "--all"],
    [
      "-c", "user.name=Documentation Pilot",
      "-c", "user.email=documentation-pilot.invalid",
      "commit", "--quiet", "-m", "Frozen candidate"
    ]
  ];
  for (const args of commands) {
    const result = spawnSync("git", args, {
      cwd: candidateRoot,
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(result.status, 0, `candidate git ${args[0]} failed: ${result.stderr}`);
  }
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: candidateRoot,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(resolve(root.stdout.trim()), resolve(candidateRoot),
    "candidate is not an independent Git root");
}

export function reserveSlot(lockRoot, run) {
  mkdirSync(lockRoot, {recursive: true});
  const root = resolve(
    lockRoot,
    `${String(run.globalOrder).padStart(2, "0")}-${run.observationId}`
  );
  mkdirSync(root);
  writeOnce(resolve(root, "reservation.json"), {
    schemaVersion: 2,
    protocolId,
    observationId: run.observationId,
    parentSessionId: run.parentSessionId,
    workerSessionId: run.workerSessionId,
    worktreeId: run.worktreeId,
    state: "reserved",
    startCount: 0
  });
  immutable(resolve(root, "reservation.json"));
  return root;
}

export function markStarted(lockPath) {
  assert(!existsSync(resolve(lockPath, "started.json")), "slot cannot start more than once");
  assert(!existsSync(resolve(lockPath, "terminal.json")), "terminal slot cannot start");
  const reserved = readJson(resolve(lockPath, "reservation.json"));
  const started = {...reserved, state: "started", startCount: 1};
  writeOnce(resolve(lockPath, "started.json"), started);
  immutable(resolve(lockPath, "started.json"));
}

export function terminalDisposition(lockPath, disposition) {
  assert(!existsSync(resolve(lockPath, "terminal.json")),
    "slot already has a terminal disposition");
  writeOnce(resolve(lockPath, "terminal.json"), disposition);
  immutable(resolve(lockPath, "terminal.json"));
}

function scrubbedEnvironment() {
  const names = [
    "PATH", "SystemRoot", "ComSpec", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"
  ];
  const environment = Object.fromEntries(names
    .filter((name) => typeof process.env[name] === "string")
    .map((name) => [name, process.env[name]]));
  if (environment.PATH) {
    const source = resolve(repositoryRoot).toLowerCase();
    environment.PATH = environment.PATH.split(delimiter)
      .filter((entry) => {
        if (!entry) return false;
        const path = resolve(entry).toLowerCase();
        return path !== source && !path.startsWith(`${source}${sep}`);
      })
      .join(delimiter);
  }
  return environment;
}

function inspectLaunch({args, environment, candidateRoot, artifactRoot}) {
  const forbidden = [
    repositoryRoot,
    artifactRoot
  ].map((path) => path.toLowerCase());
  const reasons = [];
  for (const [index, value] of args.entries()) {
    if (typeof value !== "string") continue;
    if (forbidden.some((path) => value.toLowerCase().includes(path))) {
      reasons.push(`candidate argument ${index} disclosed a coordinator or sibling path`);
    }
  }
  for (const [name, value] of Object.entries(environment)) {
    if (forbidden.some((path) => value.toLowerCase().includes(path))) {
      reasons.push(`candidate environment ${name} disclosed a coordinator or sibling path`);
    }
  }
  if (!args.includes(resolve(candidateRoot))) reasons.push("candidate root is absent");
  return {pass: reasons.length === 0, reasons: [...new Set(reasons)]};
}

function changedPaths(initial, terminal) {
  const before = new Map(initial.map((entry) => [entry.path, entry.sha256]));
  const after = new Map(terminal.map((entry) => [entry.path, entry.sha256]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

function resultEvent(events) {
  const results = events.filter((event) => event.type === "result");
  return results.length === 1 ? results[0] : null;
}

function classify({started, execution, result, integrityPass, adherence, evaluation}) {
  if (!started) return "pre-start-failure";
  if (execution.error?.code === "ETIMEDOUT") return "timeout";
  if (!integrityPass) return "evidence-integrity-failure";
  if (!result || execution.status !== 0 || result.exitCode !== 0) return "process-failure";
  if (!adherence) return "adherence-failure";
  if (!evaluation?.pass) return "quality-failure";
  return "complete";
}

export function identityDisposition(started, observedConsumed) {
  const consumed = Boolean(started || observedConsumed);
  return {
    started: Boolean(started),
    consumed,
    preStartStatus: !started && consumed
      ? "identity-consumed-before-start"
      : "pre-start-failure"
  };
}

function schemaObservation(run, record) {
  const observation = {
    schemaVersion: 2,
    protocolId,
    observationId: run.observationId,
    blockId: run.blockId,
    arm: run.arm,
    order: run.order,
    fixtureId: run.fixtureId,
    variantId: run.variantId,
    parentSessionId: run.parentSessionId,
    workerSessionId: run.workerSessionId,
    worktreeId: run.worktreeId,
    started: record.started,
    completed: record.completed,
    adherent: record.adherent,
    usage: record.usage,
    timing: record.timing,
    evaluation: record.evaluation,
    evidenceSha256: null
  };
  observation.evidenceSha256 = evidenceHash(observation);
  return observation;
}

function runObservation({
  cli,
  sessionStore,
  artifactRoot,
  run,
  materialized,
  disabledMcpServers
}) {
  const rawRoot = resolve(artifactRoot, "raw-private", run.observationId);
  const lock = reserveSlot(resolve(artifactRoot, "lifecycle-locks"), run);
  mkdirSync(rawRoot, {recursive: true});
  const args = buildCopilotArgs(
    run,
    materialized.candidateRoot,
    disabledMcpServers,
    materialized.policy
  );
  const environment = scrubbedEnvironment();
  const launchAudit = inspectLaunch({
    args,
    environment,
    candidateRoot: materialized.candidateRoot,
    artifactRoot
  });
  assert(launchAudit.pass, launchAudit.reasons.join("; "));
  writeOnce(resolve(rawRoot, "command.json"), {
    cliSha256: normalizedPathHash(cli),
    args: args.map((value, index) => index === 1 ? `<prompt-sha256:${sha256(value)}>` : value),
    candidateRoot: "<candidate-root>"
  });
  writeOnce(resolve(rawRoot, "attempt.json"), {
    schemaVersion: 2,
    observationId: run.observationId,
    retry: false
  });

  const processStartedAt = Date.now();
  const execution = invoke(cli, args, {
    cwd: materialized.candidateRoot,
    timeout: 300000,
    env: environment
  });
  const measuredWallMs = Date.now() - processStartedAt;
  writeOnce(resolve(rawRoot, "events.jsonl"), Buffer.from(execution.stdout ?? "", "utf8"));
  writeOnce(resolve(rawRoot, "stderr.txt"), Buffer.from(execution.stderr ?? "", "utf8"));

  let events = [];
  let eventError = null;
  try {
    events = parseCopilotJsonl(execution.stdout ?? "");
  } catch (error) {
    eventError = error.message;
  }
  let usageRows = [];
  let observedUsageRows = [];
  let usageError = null;
  try {
    usageRows = settledUsage(sessionStore, run.parentSessionId);
    observedUsageRows = usageRows;
  } catch (error) {
    usageError = error.message;
    observedUsageRows = Array.isArray(error.latestRows) ? error.latestRows : [];
  }
  writeOnce(resolve(rawRoot, "usage.json"), {
    schemaVersion: 2,
    source: "assistant_usage_events-read-only",
    parentSessionId: run.parentSessionId,
    settled: usageError === null,
    rows: observedUsageRows
  });

  const started = startedFrom(events, observedUsageRows);
  if (started) markStarted(lock);
  const identity = identityDisposition(
    started,
    consumedStudyIds(sessionStore, [run.parentSessionId]).includes(run.parentSessionId)
  );
  const identityConsumed = identity.consumed;
  const audit = eventError
    ? {
      adherent: false,
      reasons: [eventError],
      workerCallId: null,
      workerControlPlaneIdHash: null
    }
    : auditRuntime({
      events,
      usageRows,
      run,
      candidateRoot: materialized.candidateRoot,
      policy: materialized.policy
    });
  const settled = aggregateUsage(usageRows, {
    arm: run.arm,
    workerCallId: audit.workerCallId
  });
  const terminalTree = treeManifest(materialized.candidateRoot);
  const changed = changedPaths(materialized.initialTree, terminalTree);
  const allowedChanges = [
    relative(materialized.candidateRoot, materialized.policy.sourcePath).split(sep).join("/"),
    relative(materialized.candidateRoot, materialized.policy.docTarget).split(sep).join("/")
  ].sort();
  const boundaryReasons = changed.some((path) => !allowedChanges.includes(path))
    ? [`candidate changed a non-owned path: ${changed.join(", ")}`]
    : [];

  let evaluation = null;
  let evaluationReproduced = false;
  let evaluationError = null;
  try {
    const first = evaluate({
      candidateRoot: materialized.candidateRoot,
      evaluatorRoot: materialized.evaluatorRoot
    });
    const second = evaluate({
      candidateRoot: materialized.candidateRoot,
      evaluatorRoot: materialized.evaluatorRoot
    });
    evaluationReproduced = stableStringify(first) === stableStringify(second);
    evaluation = first;
    if (!evaluationReproduced) evaluationError = "external evaluator did not reproduce";
  } catch (error) {
    evaluationError = error.message;
  }

  const workerStarted = workerActivityStarted(events);
  const criticalMissingActors = integrityCriticalMissingActors(
    settled.missingRequiredActors,
    workerStarted
  );
  const integrityReasons = [
    ...(eventError ? [eventError] : []),
    ...(started && usageError ? [`usage settlement failed: ${usageError}`] : []),
    ...(started && !usageRows.length ? ["started observation has no settled usage"] : []),
    ...(criticalMissingActors.length
      ? [`missing required usage actors: ${criticalMissingActors.join(", ")}`]
      : []),
    ...(settled.unattributedRows.length ? ["usage contains unattributed rows"] : []),
    ...(evaluationError ? [evaluationError] : [])
  ];
  const integrityPass = integrityReasons.length === 0;
  const result = resultEvent(events);
  const completed = Boolean(result && execution.status === 0 && result.exitCode === 0);
  const adherence = audit.adherent && boundaryReasons.length === 0;
  const status = classify({
    started,
    execution,
    result,
    integrityPass,
    adherence,
    evaluation
  });
  const retainedStatus = !started ? identity.preStartStatus : status;
  const record = {
    ...run,
    started,
    completed,
    status: retainedStatus,
    adherent: adherence,
    usage: settled.usage,
    timing: aggregateTiming(events, settled, measuredWallMs),
    evaluation,
    evaluationReproduced,
    externalEvaluatorAiCredits: 0,
    usagePartitioned: settled.unattributedRows.length === 0
      && settled.missingRequiredActors.length === 0
      && (!started || usageRows.length > 0),
    disposedExactlyOnce: true,
    integrityPass,
    workerControlPlaneIdHash: audit.workerControlPlaneIdHash,
    identityConsumed,
    diagnostics: [...new Set([
      ...audit.reasons,
      ...boundaryReasons,
      ...integrityReasons
    ])].sort()
  };
  const observation = schemaObservation(run, record);
  writeOnce(resolve(rawRoot, "runtime-audit.json"), {
    status: retainedStatus,
    evaluationReproduced,
    externalEvaluatorAiCredits: 0,
    usagePartitioned: record.usagePartitioned,
    changedPaths: changed,
    workerControlPlaneIdHash: audit.workerControlPlaneIdHash,
    parentIdentityConsumed: identityConsumed,
    diagnostics: record.diagnostics,
    initialTreeSha256: sha256(stableStringify(materialized.initialTree)),
    terminalTreeSha256: sha256(stableStringify(terminalTree))
  });
  writeOnce(resolve(rawRoot, "observation.json"), observation);
  terminalDisposition(lock, {
    schemaVersion: 2,
    observationId: run.observationId,
    state: "terminal",
    started,
    consumed: identityConsumed,
    retry: false,
    status: retainedStatus,
    evidenceSha256: observation.evidenceSha256
  });
  return {...record, evidenceSha256: observation.evidenceSha256};
}

function retainedNotStarted(artifactRoot, run, reason, identityConsumed = false) {
  const lockRoot = resolve(artifactRoot, "lifecycle-locks");
  const expectedLock = resolve(
    lockRoot,
    `${String(run.globalOrder).padStart(2, "0")}-${run.observationId}`
  );
  const lock = existsSync(expectedLock) ? expectedLock : reserveSlot(lockRoot, run);
  const rawRoot = resolve(artifactRoot, "raw-private", run.observationId);
  const observationPath = resolve(rawRoot, "observation.json");
  const runtimePath = resolve(rawRoot, "runtime-audit.json");
  const alreadyStarted = existsSync(resolve(lock, "started.json"));
  const identity = identityDisposition(alreadyStarted, identityConsumed);
  let observation;
  let record;
  if (existsSync(observationPath)) {
    observation = readJson(observationPath);
    const runtime = existsSync(runtimePath) ? readJson(runtimePath) : {};
    record = {
      ...run,
      started: observation.started,
      completed: observation.completed,
      status: runtime.status ?? "evidence-integrity-failure",
      adherent: observation.adherent,
      usage: observation.usage,
      timing: observation.timing,
      evaluation: observation.evaluation,
      evaluationReproduced: runtime.evaluationReproduced === true,
      externalEvaluatorAiCredits: 0,
      usagePartitioned: runtime.usagePartitioned === true,
      disposedExactlyOnce: true,
      integrityPass: false,
      identityConsumed: runtime.parentIdentityConsumed ?? identity.consumed,
      workerControlPlaneIdHash: runtime.workerControlPlaneIdHash ?? null,
      diagnostics: [...new Set([...(runtime.diagnostics ?? []), reason])].sort()
    };
  } else {
    record = {
      ...run,
      started: alreadyStarted,
      completed: false,
      status: alreadyStarted ? "evidence-integrity-failure" : identity.preStartStatus,
      adherent: false,
      usage: {
        combinedAiCredits: null,
        parentAiCredits: null,
        workerAiCredits: run.arm === "A1" ? 0 : null,
        parentCumulativeInputTokens: null,
        parentPeakInputTokens: null,
        totalTokens: null
      },
      timing: {wallMs: null, workerMs: run.arm === "A1" ? 0 : null},
      evaluation: null,
      evaluationReproduced: false,
      externalEvaluatorAiCredits: 0,
      usagePartitioned: !alreadyStarted,
      disposedExactlyOnce: true,
      integrityPass: false,
      identityConsumed: identity.consumed,
      workerControlPlaneIdHash: null,
      diagnostics: [reason]
    };
    observation = schemaObservation(run, record);
    writeOnce(resolve(rawRoot, "observation.json"), observation);
  }
  if (!existsSync(runtimePath)) {
    writeOnce(runtimePath, {
      status: record.status,
      evaluationReproduced: false,
      externalEvaluatorAiCredits: 0,
      usagePartitioned: record.usagePartitioned,
      diagnostics: record.diagnostics
    });
  } else {
    const recoveryPath = resolve(rawRoot, "recovery.json");
    if (!existsSync(recoveryPath)) {
      writeOnce(recoveryPath, {
        status: "evidence-integrity-failure",
        canonicalObservationSha256: observation.evidenceSha256,
        diagnostic: reason
      });
    }
  }
  if (!existsSync(resolve(lock, "terminal.json"))) {
    terminalDisposition(lock, {
      schemaVersion: 2,
      observationId: run.observationId,
      state: "terminal",
      started: record.started,
      consumed: record.identityConsumed,
      retry: false,
      status: record.status,
      evidenceSha256: observation.evidenceSha256
    });
  }
  return {...record, evidenceSha256: observation.evidenceSha256};
}

function evidenceManifest(artifactRoot) {
  const entries = walkFiles(artifactRoot)
    .filter((path) => relative(artifactRoot, path).split(sep).join("/") !== "evidence-manifest.json")
    .map((path) => ({
      path: relative(artifactRoot, path).split(sep).join("/"),
      bytes: statSync(path).size,
      sha256: sha256(readFileSync(path))
    }));
  const manifest = {
    schemaVersion: 2,
    algorithm: "sha256",
    files: entries,
    rootHash: sha256(stableStringify(entries))
  };
  writeOnce(resolve(artifactRoot, "evidence-manifest.json"), manifest);
  immutable(resolve(artifactRoot, "evidence-manifest.json"));
  return manifest;
}

function verifyLifecycle(artifactRoot, observations) {
  const terminalById = new Map(observations.map((item) => [item.observationId, item]));
  for (const run of frozenPilotPlan()) {
    const lock = resolve(
      artifactRoot,
      "lifecycle-locks",
      `${String(run.globalOrder).padStart(2, "0")}-${run.observationId}`
    );
    const files = readdirSync(lock).sort();
    assert(files.includes("reservation.json"), `${run.observationId} lacks reservation`);
    assert(files.includes("terminal.json"), `${run.observationId} lacks terminal disposition`);
    const startedFiles = files.filter((name) => name === "started.json");
    const observed = terminalById.get(run.observationId);
    assert(observed, `${run.observationId} is absent from retained observations`);
    assert.equal(startedFiles.length, observed.started ? 1 : 0,
      `${run.observationId} lifecycle start count differs`);
    const terminal = readJson(resolve(lock, "terminal.json"));
    const observation = readJson(resolve(
      artifactRoot,
      "raw-private",
      run.observationId,
      "observation.json"
    ));
    assert.equal(terminal.started, observed.started);
    assert.equal(terminal.consumed, observed.identityConsumed);
    assert.equal(terminal.retry, false);
    assert.equal(terminal.evidenceSha256, observation.evidenceSha256);
    assert.equal(observed.evidenceSha256, observation.evidenceSha256);
  }
  return true;
}

export function executePilot({
  cli,
  sessionStore,
  artifactRoot,
  candidateRoot,
  execute
}) {
  assert.equal(execute, true, "pilot lifecycle requires explicit --execute");
  const preflight = collectStaticPreflight({
    cli,
    sessionStore,
    artifactRoot,
    candidateRoot
  });
  assert.equal(preflight.pilotAuthorized, true);
  assert.equal(preflight.mainAuthorized, false);
  let artifactCreated = false;
  let candidateCreated = false;
  let materialized;
  try {
    mkdirSync(artifactRoot, {recursive: false});
    artifactCreated = true;
    mkdirSync(candidateRoot, {recursive: false});
    candidateCreated = true;
    writeOnce(resolve(artifactRoot, "preflight.json"), preflight);
    materialized = materializePilot(candidateRoot, artifactRoot);
  } catch (error) {
    if (candidateCreated) rmSync(candidateRoot, {recursive: true, force: true});
    if (artifactCreated) rmSync(artifactRoot, {recursive: true, force: true});
    throw new Error(`pre-start setup failed without consuming an identity: ${error.message}`, {
      cause: error
    });
  }
  const scheduled = schedulePilot({
    runOne: (run) => runObservation({
      cli,
      sessionStore,
      artifactRoot,
      run,
      materialized: materialized.get(run.observationId),
      disabledMcpServers: preflight.cli.configuredMcpServers
    }),
    retainOne: (run, reason, error) => {
      let identityConsumed = false;
      if (error) {
        try {
          identityConsumed = consumedStudyIds(sessionStore, [run.parentSessionId])
            .includes(run.parentSessionId);
        } catch {
          identityConsumed = true;
        }
      }
      return retainedNotStarted(artifactRoot, run, reason, identityConsumed);
    }
  });
  const {observations, stopReason} = scheduled;
  const lifecyclePass = verifyLifecycle(artifactRoot, observations);
  const gate = evaluatePilotGate(observations, {lifecyclePass});
  const summary = assertPrivacySafe(privacyNormalize(
    concisePilotSummary(observations, gate),
    [
      [artifactRoot, "<artifact-root>"],
      [candidateRoot, "<candidate-root>"],
      [repositoryRoot, "<source-repository>"],
      [homedir(), "<home>"]
    ]
  ));
  const sanitized = resolve(artifactRoot, "sanitized");
  writeOnce(resolve(sanitized, "pilot-summary.json"), summary);
  writeOnce(resolve(sanitized, "pilot-gate.json"), gate);
  writeOnce(resolve(sanitized, "observation-hashes.json"), {
    schemaVersion: 2,
    observations: observations.map((item) => ({
      observationId: item.observationId,
      evidenceSha256: item.evidenceSha256
    }))
  });
  writeOnce(resolve(sanitized, "disposition.json"), {
    schemaVersion: 2,
    authorizationId: preflight.authorizationId,
    stoppedEarly: stopReason !== null,
    stopReason: stopReason ? "<private-integrity-diagnostic>" : null,
    decision: gate.decision,
    mainAuthorized: false
  });
  const manifest = evidenceManifest(artifactRoot);
  return {
    summary,
    gate,
    evidenceRootHash: manifest.rootHash,
    mainAuthorized: false
  };
}

export function schedulePilot({runOne, retainOne}) {
  const observations = [];
  let stopReason = null;
  for (const run of frozenPilotPlan()) {
    if (stopReason) {
      observations.push(retainOne(
        run,
        `not started because evidence integrity became impossible: ${stopReason}`,
        null
      ));
      continue;
    }
    try {
      const observation = runOne(run);
      observations.push(observation);
      if (!observation.integrityPass) {
        stopReason = `${observation.observationId}: ${observation.diagnostics.join("; ")}`;
      }
    } catch (error) {
      const retained = retainOne(
        run,
        `pre-start infrastructure failure: ${error.message}`,
        error
      );
      observations.push(retained);
      if (retained.started || retained.identityConsumed) {
        stopReason = `${run.observationId}: ${error.message}`;
      }
    }
  }
  return {observations, stopReason};
}

function requiredValues(values) {
  const required = ["cli", "session-store", "artifact-root", "candidate-root"];
  const missing = required.filter((name) => !values[name]);
  assert(!missing.length, `missing required options: ${missing.join(", ")}`);
  return {
    cli: values.cli,
    sessionStore: values["session-store"],
    artifactRoot: values["artifact-root"],
    candidateRoot: values["candidate-root"]
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const {mode, values} = parseArguments(process.argv);
  const output = mode === "dry-run"
    ? dryRun()
    : mode === "preflight"
      ? collectStaticPreflight(requiredValues(values))
      : executePilot({...requiredValues(values), execute: true});
  process.stdout.write(stableStringify(output));
}
