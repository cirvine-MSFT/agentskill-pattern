#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import {basename, dirname, isAbsolute, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {evaluate} from "../../experiments/documentation-delegation/scripts/evaluate.mjs";
import {evaluateAdherence} from "../../experiments/documentation-delegation/scripts/evaluate-adherence.mjs";
import {materializeFixture} from "../../experiments/documentation-delegation/scripts/generate-fixture.mjs";
import {
  directoryDigest
} from "../../experiments/documentation-delegation/scripts/lib.mjs";
import {
  AUTHORIZATION_DECISION,
  RUNNER_PROTOCOL_ID,
  SOURCE_COMMIT,
  assertAuthorizationFresh,
  authorizationBindings,
  assertExternalFreshRoots,
  assertFrozenOrder,
  auditTelemetry,
  buildCanonicalSummary,
  buildCopilotArgs,
  buildWorkerHandoff,
  createCandidateGitRoot,
  defaultLifecycleIndex,
  deriveTiming,
  deriveTools,
  evidenceProvenance,
  frozenMaterializationId,
  inspectCleanRepository,
  inspectCli,
  inspectMergedMain,
  inspectSandboxLauncher,
  jsonBytes,
  parseJsonl,
  pilotRuns,
  privacyAudit,
  readDesign,
  runnerPackageDigest,
  sanitizeCanonical,
  repositoryRoot,
  settleUsage,
  sha256,
  unavailableUsage,
  createExecutionAuthorization,
  verifyFrozenSources,
  writeOnce
} from "./core.mjs";

const toolRoot = dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const output = {flags: new Set(), values: {}};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}`);
    if (["--dry-run", "--preflight", "--execute"].includes(token)) {
      output.flags.add(token.slice(2));
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    output.values[token.slice(2)] = value;
    index += 1;
  }
  return output;
}

function usage() {
  return [
    "Usage:",
    "  node runner.mjs --dry-run",
    "  node runner.mjs --preflight --cli <absolute-copilot> --session-store <db> --artifact-root <abs> --candidate-root <abs> --sandbox-launcher <path> --sandbox-sha256 <sha256>",
    "  node runner.mjs --execute <same required options>  # only from clean, current canonical main"
  ].join("\n");
}

function runPython(script, args) {
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  const failures = [];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c", script, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    });
    if (!result.error && result.status === 0) return result.stdout;
    failures.push(result.error?.message ?? result.stderr.trim());
  }
  throw new Error(`Python SQLite query failed: ${failures.join("; ")}`);
}

export function readUsageRows(database, parentSessionId, workerSessionId = null) {
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect('file:' + sys.argv[1].replace('\\\\', '/') + '?mode=ro', uri=True)",
    "db.row_factory = sqlite3.Row",
    "ids = [value for value in sys.argv[2:] if value != '-']",
    "marks = ','.join('?' for _ in ids)",
    "query = f'''SELECT id, session_id, turn_index, agent_id, parent_tool_call_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, duration_ms, time_to_first_token_ms, inter_token_latency_ms, initiator, api_endpoint, reasoning_effort, finish_reason, content_filter_triggered, token_details_json, created_at FROM assistant_usage_events WHERE session_id IN ({marks}) OR agent_id IN ({marks}) OR parent_tool_call_id IN ({marks}) ORDER BY id'''",
    "rows = [dict(row) for row in db.execute(query, ids + ids + ids)]",
    "print(json.dumps(rows, separators=(',', ':')))"
  ].join("\n");
  return JSON.parse(runPython(script, [
    resolve(database),
    parentSessionId,
    workerSessionId ?? "-"
  ]));
}

function assertNoConsumedIds(database) {
  const consumed = [];
  for (const run of pilotRuns()) {
    const rows = readUsageRows(database, run.parentSessionId, run.workerSessionId);
    if (rows.length > 0) consumed.push(run.observationId);
  }
  if (consumed.length > 0) {
    throw new Error(`Frozen pilot IDs already have usage: ${consumed.join(", ")}`);
  }
}

function requiredOptions(values) {
  const names = [
    "cli", "session-store", "artifact-root", "candidate-root",
    "sandbox-launcher", "sandbox-sha256"
  ];
  const missing = names.filter((name) => !values[name]);
  if (missing.length > 0) throw new Error(`Missing required options: ${missing.join(", ")}`);
  return {
    cli: values.cli,
    sessionStore: resolve(values["session-store"]),
    artifactRoot: resolve(values["artifact-root"]),
    candidateRoot: resolve(values["candidate-root"]),
    sandboxLauncher: resolve(values["sandbox-launcher"]),
    sandboxSha256: values["sandbox-sha256"]
  };
}

export function preflight(options, dependencies = {}) {
  const frozen = verifyFrozenSources({
    materializeFixture: dependencies.materializeFixture ?? materializeFixture,
    directoryDigest: dependencies.directoryDigest ?? directoryDigest
  });
  const clean = (dependencies.inspectCleanRepository ?? inspectCleanRepository)();
  const cli = (dependencies.inspectCli ?? inspectCli)(options.cli);
  const sandbox = (dependencies.inspectSandboxLauncher ?? inspectSandboxLauncher)(
    options.sandboxLauncher,
    options.sandboxSha256
  );
  assertExternalFreshRoots(options);
  if (!existsSync(options.sessionStore)) throw new Error("Session usage store is missing");
  (dependencies.assertNoConsumedIds ?? assertNoConsumedIds)(options.sessionStore);
  let mergedMain = null;
  let authorization = null;
  let authorizationError = null;
  if (options.requireAuthorization === true) {
    try {
      mergedMain = (dependencies.inspectMergedMain ?? inspectMergedMain)();
      authorization = (dependencies.createExecutionAuthorization ?? createExecutionAuthorization)(
        options,
        mergedMain
      );
    } catch (error) {
      authorizationError = error instanceof Error ? error.message : String(error);
    }
  }
  const reasons = [
    ...frozen.errors,
    ...(clean.pass ? [] : ["repository worktree is not clean"]),
    ...cli.reasons,
    ...sandbox.reasons,
    ...(authorizationError ? [authorizationError] : [])
  ];
  return {
    schemaVersion: 1,
    runnerProtocolId: RUNNER_PROTOCOL_ID,
    sourceCommit: SOURCE_COMMIT,
    pass: reasons.length === 0,
    reasons,
    sourceHead: frozen.head,
    clean,
    cli,
    sandbox,
    mergedMain,
    authorization,
    executionAuthorized: authorization !== null,
    authorizationRequest: {
      schemaVersion: 1,
      runnerProtocolId: RUNNER_PROTOCOL_ID,
      decision: AUTHORIZATION_DECISION,
      approved: false,
      requiresExplicitExecute: true,
      runnerSourceCommit: frozen.head,
      runnerSha256: runnerPackageDigest(),
      bindings: authorizationBindings(options),
      authorizationBasis: "merge this prospective amendment, then invoke --execute from clean current main"
    },
    roots: {
      artifact: "fresh-external",
      candidate: "fresh-external"
    },
    consumedFrozenIds: 0,
    frozenOrder: pilotRuns().map((run) => run.observationId)
  };
}

function atomicWrite(path, value) {
  const pending = `${path}.next`;
  writeFileSync(pending, jsonBytes(value), {flag: "wx"});
  renameSync(pending, path);
}

function appendIndex(path, index, run, disposition) {
  assertFrozenOrder(index, run);
  const next = {
    ...index,
    entries: [...index.entries, {
      sequence: index.entries.length + 1,
      observationId: run.observationId,
      parentSessionId: run.parentSessionId,
      workerSessionId: run.workerSessionId,
      worktreeId: run.worktreeId,
      disposition,
      startCount: disposition === "started" ? 1 : 0
    }]
  };
  atomicWrite(path, next);
  return next;
}

function runEvaluatorSandboxed({
  launcher,
  candidateRoot,
  evaluatorRoot = null,
  evidenceRoot,
  executable,
  args,
  stdoutPath,
  stderrPath,
  timeout
}) {
  const stdoutFd = openSync(stdoutPath, "wx");
  const stderrFd = openSync(stderrPath, "wx");
  let result;
  try {
    result = spawnSync(launcher, [
      "--candidate-root", candidateRoot,
      ...(evaluatorRoot ? ["--evaluator-root", evaluatorRoot] : []),
      "--evidence-root", evidenceRoot,
      "--network", "deny",
      "--",
      executable,
      ...args
    ], {
      cwd: candidateRoot,
      stdio: ["ignore", stdoutFd, stderrFd],
      timeout,
      killSignal: "SIGTERM",
      windowsHide: true
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  return result;
}

function candidatePath(candidateRoot, value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    throw new Error("candidate policy contains an invalid relative path");
  }
  const absolute = resolve(candidateRoot, value);
  const path = relative(candidateRoot, absolute);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("candidate policy path escapes the candidate root");
  }
  return absolute;
}

export function freezeCandidatePolicy(candidateRoot) {
  const manifest = JSON.parse(readFileSync(resolve(candidateRoot, "CANDIDATE.json"), "utf8"));
  const boundary = {
    caseSensitivePaths: process.platform !== "win32",
    candidateRoot: resolve(candidateRoot),
    docTarget: candidatePath(candidateRoot, manifest.docTarget),
    allowedWorkerReads: manifest.allowedWorkerReads.map((path) =>
      candidatePath(candidateRoot, path)),
    allowedWorkerWrites: manifest.allowedWorkerWrites.map((path) =>
      candidatePath(candidateRoot, path))
  };
  return Object.freeze({
    manifest: Object.freeze({...manifest}),
    boundary: Object.freeze({
      ...boundary,
      allowedWorkerReads: Object.freeze(boundary.allowedWorkerReads),
      allowedWorkerWrites: Object.freeze(boundary.allowedWorkerWrites)
    }),
    sourcePath: candidatePath(candidateRoot, manifest.sourcePath),
    docTarget: boundary.docTarget
  });
}

function prepareEvaluatorRuntime(evaluatorRoot) {
  const runtime = resolve(evaluatorRoot, ".runtime");
  mkdirSync(runtime, {recursive: true});
  const source = resolve(
    repositoryRoot,
    "experiments",
    "documentation-delegation",
    "scripts"
  );
  copyFileSync(resolve(source, "evaluate.mjs"), resolve(runtime, "evaluate.mjs"));
  copyFileSync(resolve(source, "lib.mjs"), resolve(runtime, "lib.mjs"));
}

function invokeEvaluator(options, candidateRoot, evaluatorRoot, rawRoot, suffix) {
  const outputPath = resolve(rawRoot, `evaluation-${suffix}.json`);
  const stderrPath = resolve(rawRoot, `evaluation-${suffix}.stderr.txt`);
  const script = resolve(evaluatorRoot, ".runtime", "evaluate.mjs");
  const result = runEvaluatorSandboxed({
    launcher: options.sandboxLauncher,
    candidateRoot,
    evaluatorRoot,
    evidenceRoot: rawRoot,
    executable: process.execPath,
    args: [
      script,
      "--candidate", candidateRoot,
      "--evaluator", evaluatorRoot,
      "--out", outputPath
    ],
    stdoutPath: resolve(rawRoot, `evaluation-${suffix}.stdout.txt`),
    stderrPath,
    timeout: 120_000
  });
  if (result.error || result.status !== 0 || !existsSync(outputPath)) {
    throw new Error(`deterministic evaluator ${suffix} failed`);
  }
  return {
    value: JSON.parse(readFileSync(outputPath, "utf8")),
    bytes: readFileSync(outputPath)
  };
}

function candidateFiles(candidateRoot) {
    const files = {};
    function walk(directory) {
      for (const entry of readdirSync(directory, {withFileTypes: true})
        .sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name === ".git") continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) {
          files[relative(candidateRoot, path).split(sep).join("/")] = sha256(readFileSync(path));
        }
      }
    }
    walk(candidateRoot);
    return files;
  }

  export function captureCandidateInputs(candidateRoot, policy) {
    return Object.freeze({
      files: Object.freeze(candidateFiles(candidateRoot)),
      allowedOutputs: Object.freeze([
        relative(candidateRoot, policy.sourcePath).split(sep).join("/"),
        relative(candidateRoot, policy.docTarget).split(sep).join("/")
      ])
    });
  }

  export function verifyCandidateOutputs(candidateRoot, captured) {
    const terminal = candidateFiles(candidateRoot);
    const allowed = new Set(captured.allowedOutputs);
    const reasons = [];
    for (const [name, digest] of Object.entries(captured.files)) {
      if (allowed.has(name)) continue;
      if (terminal[name] !== digest) reasons.push(`immutable candidate input changed: ${name}`);
    }
    for (const name of Object.keys(terminal)) {
      if (!Object.hasOwn(captured.files, name) && !allowed.has(name)) {
        reasons.push(`unexpected candidate output: ${name}`);
      }
    }
    return {
      pass: reasons.length === 0,
      reasons,
      initialSha256: sha256(jsonBytes(captured.files)),
      terminalSha256: sha256(jsonBytes(terminal)),
      allowedOutputs: captured.allowedOutputs
    };
  }

  const PROBE_SCRIPT = [
    "const fs=require('node:fs');",
    "const [candidate,...denied]=process.argv.slice(1);",
    "const canRead=p=>{try{const s=fs.statSync(p);if(s.isDirectory())fs.readdirSync(p);else fs.readFileSync(p);return true}catch{return false}};",
    "process.stdout.write(JSON.stringify({candidateReadable:canRead(candidate),denied:denied.map(path=>({path,readable:canRead(path)}))}));"
  ].join("");

  export function runNegativeControlProbes({
    launcher,
    candidateRoot,
    deniedPaths,
    executable = process.execPath,
    spawn = spawnSync
  }) {
    const result = spawn(launcher, [
      "--candidate-root", candidateRoot,
      "--network", "copilot-control-plane",
      "--",
      executable,
      "-e", PROBE_SCRIPT,
      candidateRoot,
      ...deniedPaths
    ], {
      cwd: candidateRoot,
      encoding: "utf8",
      env: buildCandidateEnvironment(process.env, deniedPaths),
      windowsHide: true
    });
    let receipt = null;
    try {
      receipt = JSON.parse(result.stdout);
    } catch {
      // The runner treats malformed probe output as a failed negative control.
    }
    const reasons = [];
    if (result.error || result.status !== 0) reasons.push("candidate boundary probe failed to execute");
    if (receipt?.candidateReadable !== true) reasons.push("candidate root is not readable inside launch boundary");
    if (!Array.isArray(receipt?.denied)
      || receipt.denied.length !== deniedPaths.length
      || receipt.denied.some((item) => item.readable !== false)) {
      reasons.push("candidate launch boundary can read a forbidden coordinator path");
    }
    return {
      pass: reasons.length === 0,
      reasons,
      launcherStatus: result.status,
      candidateReadable: receipt?.candidateReadable === true,
      deniedPathCount: deniedPaths.length,
      deniedReadableCount: Array.isArray(receipt?.denied)
        ? receipt.denied.filter((item) => item.readable === true).length
        : null
    };
  }

  const DROPPED_ENVIRONMENT = /^(?:GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|OPENAI_API_KEY|AZURE_.+(?:KEY|TOKEN|SECRET)|GITHUB_WORKSPACE|PWD|OLDPWD|INIT_CWD|npm_.+)$/iu;

  export function buildCandidateEnvironment(environment, forbiddenPaths) {
    const forbidden = forbiddenPaths.map((path) => resolve(path).toLowerCase());
    return Object.fromEntries(Object.entries(environment)
      .filter(([name, value]) =>
        typeof value === "string"
        && !DROPPED_ENVIRONMENT.test(name)
        && !forbidden.some((path) => value.toLowerCase().includes(path))));
  }

  export function inspectCandidateLaunch({candidateRoot, executable, args, environment, forbiddenPaths}) {
    const disclosed = forbiddenPaths.filter((path) => {
      const normalized = resolve(path).toLowerCase();
      return args.some((value) =>
        typeof value === "string" && value.toLowerCase().includes(normalized))
        || Object.values(environment).some((value) =>
          typeof value === "string" && value.toLowerCase().includes(normalized));
    });
    const expectedSurface = args.filter((item) =>
      item.startsWith("-") && item !== args[1]);
    return {
      pass: disclosed.length === 0,
      reasons: disclosed.length === 0
        ? []
        : ["candidate arguments or environment disclose coordinator paths"],
      executableSha256: sha256(readFileSync(executable)),
      cwd: "candidate-root",
      launcherArguments: ["--candidate-root", "<candidate-root>", "--network",
        "copilot-control-plane", "--", "<copilot-cli>", "<frozen-cli-arguments>"],
      environmentNames: Object.keys(environment).sort(),
      cliSurface: expectedSurface,
      controlPlaneConnectivity: "allowed by launcher policy",
      otherNetworkIsolationClaimed: false
    };
  }

  function runCandidateSandboxed({
    launcher,
    candidateRoot,
    executable,
    args,
    environment,
    stdoutPath,
    stderrPath,
    timeout
  }) {
    const stdoutFd = openSync(stdoutPath, "wx");
    const stderrFd = openSync(stderrPath, "wx");
    let result;
    try {
      result = spawnSync(launcher, [
        "--candidate-root", candidateRoot,
        "--network", "copilot-control-plane",
        "--",
        executable,
        ...args
      ], {
        cwd: candidateRoot,
        env: environment,
        stdio: ["ignore", stdoutFd, stderrFd],
        timeout,
        killSignal: "SIGTERM",
        windowsHide: true
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    return result;
  }

function settleRows(options, run, telemetry, dependencies) {
  const provider = dependencies.readUsageRows ?? readUsageRows;
  let latest = [];
  let priorHash = null;
  let stable = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    latest = provider(options.sessionStore, run.parentSessionId, run.workerSessionId);
    const hash = sha256(jsonBytes(latest));
    stable = hash === priorHash ? stable + 1 : 1;
    priorHash = hash;
    if (latest.length > 0 && stable >= 3) return latest;
    if (!dependencies.readUsageRows) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  return latest;
}

function terminalTree(candidateRoot) {
  const result = spawnSync("git", ["write-tree"], {
    cwd: candidateRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function schemaObservation(run, values) {
  const observation = {
    schemaVersion: 1,
    protocolId: readDesign().contract.protocolId,
    observationId: run.observationId,
    blockId: run.blockId,
    arm: run.arm,
    order: run.order,
    fixtureId: run.fixtureId,
    variantId: run.variantId,
    parentSessionId: run.parentSessionId,
    workerSessionId: run.workerSessionId,
    sourceCommit: SOURCE_COMMIT,
    started: values.started,
    completed: values.completed,
    adherent: values.adherent,
    adherence: values.adherence,
    usage: values.usage,
    timing: values.timing,
    tools: values.tools,
    evaluation: values.evaluation
  };
  const expectedKeys = [
    "schemaVersion", "protocolId", "observationId", "blockId", "arm", "order",
    "fixtureId", "variantId", "parentSessionId", "workerSessionId", "sourceCommit",
    "started", "completed", "adherent", "adherence", "usage", "timing", "tools",
    "evaluation"
  ].sort();
  if (JSON.stringify(Object.keys(observation).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("Observation does not conform to the frozen top-level schema");
  }
  return observation;
}

function runResult(run, values) {
  const observation = schemaObservation(run, values);
  const dispositionRecord = {
    schemaVersion: 1,
    runnerProtocolId: RUNNER_PROTOCOL_ID,
    observationId: run.observationId,
    startStatus: values.startStatus,
    startCount: values.started ? 1 : 0,
    disposition: values.disposition,
    routingPass: values.routingPass,
    parentNoReview: values.parentNoReview,
    usageSettled: values.usageSettled,
    terminalCaptured: values.terminalCaptured,
    terminalTree: values.terminalTree,
    evidenceSha256: values.evidenceSha256,
    failure: values.failure
  };
  return {
    observation,
    dispositionRecord,
    observationId: run.observationId,
    blockId: run.blockId,
    arm: run.arm,
    started: values.started,
    startCount: values.started ? 1 : 0,
    completed: values.completed,
    disposition: values.disposition,
    adherent: values.adherent,
    routingPass: values.routingPass,
    parentNoReview: values.parentNoReview,
    usageSettled: values.usageSettled,
    terminalCaptured: values.terminalCaptured,
    usage: values.usage,
    timing: values.timing,
    tools: values.tools,
    evaluation: values.evaluation,
    evidenceSha256: values.evidenceSha256,
    failure: values.failure
  };
}

function observationFailure(run, startStatus, message, evidenceSha256 = null, evaluation = null) {
  const started = startStatus === "started";
  return runResult(run, {
    started,
    startStatus,
    completed: false,
    disposition: started ? "started-failure" : `${startStatus}-unavailable`,
    adherent: false,
    adherence: {schemaVersion: 1, arm: run.arm, adherent: false, violations: [message]},
    routingPass: false,
    parentNoReview: false,
    usageSettled: false,
    terminalCaptured: false,
    usage: unavailableUsage(),
    timing: {activeMs: null, workerMs: null, waitMs: null, wallMs: null},
    tools: {parentCalls: null, workerCalls: null, resultBytes: null},
    evaluation,
    terminalTree: null,
    evidenceSha256,
    failure: message
  });
}

function classifyStart(rows, run) {
  if (Array.isArray(rows)) {
    const parentRows = rows.filter((row) =>
      row.session_id === run.parentSessionId
      && (row.agent_id === null || row.agent_id === undefined)
      && (row.parent_tool_call_id === null || row.parent_tool_call_id === undefined)
      && row.model === readDesign().contract.cli.parentModel);
    if (parentRows.length > 0) return "started";
  }
  return "start-unverifiable";
}

export function runObservation(options, run, dependencies = {}) {
  const {manifest} = readDesign();
  const rawRoot = resolve(options.artifactRoot, "private", run.observationId);
  const lifecycleRoot = resolve(options.artifactRoot, "lifecycle", run.observationId);
  const candidateRoot = resolve(options.candidateRoot, run.worktreeId);
  const evaluatorRoot = resolve(rawRoot, "evaluator");
  writeOnce(resolve(lifecycleRoot, "reserved.json"), jsonBytes({
    runnerProtocolId: RUNNER_PROTOCOL_ID,
    observationId: run.observationId,
    parentSessionId: run.parentSessionId,
    workerSessionId: run.workerSessionId,
    worktreeId: run.worktreeId,
    retriesAllowed: 0
  }));
  let phase = "candidate-materialization";
  let processTerminated = false;
  let observedStartStatus = "pre-start";
  let retainedEvaluation = null;
  try {
    (dependencies.materializeFixture ?? materializeFixture)({
      fixtureId: run.fixtureId,
      variantId: run.variantId,
      candidateRoot,
      evaluatorRoot,
      observationId: frozenMaterializationId(run)
    });
    const key = `pilot/${run.fixtureId}/${run.variantId}`;
    const expected = manifest.generatedBundles[key];
    const digest = (dependencies.directoryDigest ?? directoryDigest)(candidateRoot);
    const evaluatorDigest = dependencies.directoryDigest
      ? dependencies.directoryDigest(evaluatorRoot)
      : directoryDigest(evaluatorRoot);
    if (digest !== expected.candidateSha256 || evaluatorDigest !== expected.evaluatorSha256) {
      throw new Error("materialized candidate/evaluator bytes differ from the frozen manifest");
    }
    const policy = freezeCandidatePolicy(candidateRoot);
    const capturedInputs = captureCandidateInputs(candidateRoot, policy);
    if (!dependencies.evaluate) prepareEvaluatorRuntime(evaluatorRoot);
    phase = "candidate-git-boundary";
    const gitBoundary = (dependencies.createCandidateGitRoot ?? createCandidateGitRoot)(candidateRoot);
    const args = buildCopilotArgs({
      run,
      candidateRoot,
      disabledMcpServers: options.configuredMcpServers
    });
    const forbiddenPaths = [
      repositoryRoot,
      resolve(repositoryRoot, "experiments", "documentation-delegation", "design", "schedule.json"),
      options.sessionStore,
      options.artifactRoot,
      rawRoot,
      evaluatorRoot,
      resolve(options.candidateRoot, ".runner-negative-control")
    ];
    const environment = buildCandidateEnvironment(process.env, forbiddenPaths);
    const launchInspection = inspectCandidateLaunch({
      candidateRoot,
      executable: options.cli,
      args,
      environment,
      forbiddenPaths
    });
    if (!launchInspection.pass) {
      throw new Error(launchInspection.reasons.join("; "));
    }
    const probes = (dependencies.runNegativeControlProbes ?? runNegativeControlProbes)({
      launcher: options.sandboxLauncher,
      candidateRoot,
      deniedPaths: forbiddenPaths
    });
    if (!probes.pass) throw new Error(`negative controls failed: ${probes.reasons.join("; ")}`);
    writeOnce(resolve(rawRoot, "launch.json"), jsonBytes({
      runnerProtocolId: RUNNER_PROTOCOL_ID,
      observationId: run.observationId,
      authorizationBlobSha256: options.authorization.authorizationBlobSha256,
      cliVersion: readDesign().contract.cli.version,
      parentModel: readDesign().contract.cli.parentModel,
      workerModel: run.arm === "A2" ? readDesign().contract.cli.workerModel : null,
      parentTools: args.find((item) => item.startsWith("--available-tools=")),
      promptSha256: sha256(Buffer.from(args[1], "utf8")),
      cliArgumentsSha256: sha256(jsonBytes(args)),
      disabledMcpServers: options.configuredMcpServers,
      candidateSha256: digest,
      evaluatorSha256: evaluatorDigest,
      candidateInputsSha256: sha256(jsonBytes(capturedInputs.files)),
      gitBoundary,
      probes,
      processInspection: launchInspection
    }));
    phase = "process-spawn";
    writeOnce(resolve(lifecycleRoot, "spawned.json"), jsonBytes({
      runnerProtocolId: RUNNER_PROTOCOL_ID,
      observationId: run.observationId,
      spawnedAt: new Date().toISOString()
    }));
    const stdoutPath = resolve(rawRoot, "events.jsonl");
    const stderrPath = resolve(rawRoot, "process.stderr.txt");
    const execution = dependencies.execute
      ? dependencies.execute({run, candidateRoot, args, environment})
      : runCandidateSandboxed({
          launcher: options.sandboxLauncher,
          candidateRoot,
          executable: options.cli,
          args,
          environment,
          stdoutPath,
          stderrPath,
          timeout: 30 * 60_000
        });
    processTerminated = true;
    phase = "post-process-settlement";
    if (dependencies.execute) {
      writeOnce(stdoutPath, execution.stdout);
      writeOnce(stderrPath, execution.stderr ?? Buffer.alloc(0));
    }
    const stdout = readFileSync(stdoutPath);
    const issues = [];
    const candidateOutputs = verifyCandidateOutputs(candidateRoot, capturedInputs);
    issues.push(...candidateOutputs.reasons);
    writeOnce(resolve(rawRoot, "candidate-outputs.json"), jsonBytes(candidateOutputs));
    let events = [];
    let eventError = null;
    try {
      events = parseJsonl(stdout);
    } catch (error) {
      eventError = error instanceof Error ? error.message : String(error);
      issues.push(eventError);
    }
    let rows = null;
    try {
      rows = settleRows(options, run, null, dependencies);
      writeOnce(resolve(rawRoot, "usage.json"), jsonBytes(rows));
    } catch (error) {
      issues.push(`usage capture failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const startStatus = classifyStart(rows, run);
    observedStartStatus = startStatus;
    const started = startStatus === "started";
    if (started) {
      writeOnce(resolve(lifecycleRoot, "started.json"), jsonBytes({
        runnerProtocolId: RUNNER_PROTOCOL_ID,
        observationId: run.observationId,
        startBoundary: "first settled parent assistant_usage_events row",
        parentSessionId: run.parentSessionId
      }));
    } else if (startStatus === "start-unverifiable") {
      writeOnce(resolve(lifecycleRoot, "start-unverifiable.json"), jsonBytes({
        runnerProtocolId: RUNNER_PROTOCOL_ID,
        observationId: run.observationId,
        reason: "authoritative parent usage could not establish the frozen start boundary"
      }));
    }
    const boundary = policy.boundary;
    const manifestRecord = policy.manifest;
    let telemetry = {
      adherent: false,
      adherence: {
        schemaVersion: 1,
        arm: run.arm,
        adherent: false,
        violations: [eventError ?? "authenticated telemetry is unavailable"]
      },
      reasons: [eventError ?? "authenticated telemetry is unavailable"],
      workerCallId: null,
      terminal: null,
      normalizedEvents: []
    };
    if (!eventError) {
      try {
        telemetry = auditTelemetry(events, {
          run,
          boundary,
          evaluateAdherence,
          forbiddenPaths,
          expectedWorkerPrompt: run.arm === "A2"
            ? buildWorkerHandoff(manifestRecord)
            : null
        });
      } catch (error) {
        const reason = `telemetry audit failed: ${error instanceof Error ? error.message : String(error)}`;
        issues.push(reason);
        telemetry.adherence.violations = [reason];
        telemetry.reasons = [reason];
      }
      if (!candidateOutputs.pass) {
        telemetry.adherent = false;
        telemetry.reasons = [...new Set([...telemetry.reasons, ...candidateOutputs.reasons])].sort();
        telemetry.adherence = {
          ...telemetry.adherence,
          adherent: false,
          violations: [...new Set([
            ...telemetry.adherence.violations,
            ...candidateOutputs.reasons
          ])].sort()
        };
      }
    }
    issues.push(...telemetry.reasons);
    const settlement = rows
      ? settleUsage(rows, {run, workerCallId: telemetry.workerCallId})
      : {available: false, reasons: ["usage rows are unavailable"], usage: null};
    issues.push(...settlement.reasons);
    let evaluation = null;
    if (startStatus !== "pre-start") {
      try {
        evaluation = dependencies.evaluate
          ? dependencies.evaluate({candidateRoot, evaluatorRoot})
          : invokeEvaluator(options, candidateRoot, evaluatorRoot, rawRoot, "initial").value;
        retainedEvaluation = evaluation;
      } catch (error) {
        issues.push(`deterministic evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const startedAt = rows?.find((row) =>
      row.session_id === run.parentSessionId
      && (row.agent_id === null || row.agent_id === undefined))?.created_at;
    const endedAt = telemetry.terminal?.timestamp
      ?? events.findLast((event) => typeof event.timestamp === "string")?.timestamp;
    const timing = deriveTiming(
      events,
      settlement.usage,
      startedAt,
      endedAt,
      telemetry.workerCallId
    );
    const tools = deriveTools(events, telemetry.workerCallId);
    const privacy = privacyAudit({
      events: stdout,
      stderr: readFileSync(stderrPath),
      usage: jsonBytes(rows),
      publicSource: readFileSync(policy.sourcePath),
      documentation: readFileSync(policy.docTarget),
      evaluation: jsonBytes(evaluation)
    });
    if (!privacy.pass) issues.push("privacy audit detected secret-bearing raw evidence");
    const target = boundary.docTarget;
    const firstWorkerEdit = telemetry.normalizedEvents.findIndex((event) =>
      event.type === "tool" && event.actor === "worker"
      && event.tool === "edit" && resolve(event.path ?? "") === target);
    const parentNoReview = run.arm === "A1"
      || (firstWorkerEdit >= 0
        && !telemetry.adherence.violations.includes(
          "Parent read or edited the target after worker editing began"
        ));
    const completed = started
      && execution.status === 0
      && telemetry.terminal?.exitCode === 0;
    const fullySettled = completed
      && evaluation !== null
      && settlement.available
      && privacy.pass;
    if (execution.error) issues.push(execution.error.message);
    if (execution.status !== 0) issues.push(`process exited ${execution.status}`);
    if (startStatus === "start-unverifiable") {
      issues.push("frozen start boundary is unverifiable");
    }
    const usage = settlement.usage
      ? Object.fromEntries(Object.entries(settlement.usage)
          .filter(([key]) => !["parentDurationMs", "workerDurationMs"].includes(key)))
      : unavailableUsage();
    const disposition = fullySettled
      ? "complete"
      : started
        ? "started-failure"
        : startStatus === "start-unverifiable"
          ? "start-unverifiable"
          : "pre-start-unavailable";
    const runProvenance = evidenceProvenance(rawRoot);
    const provenanceBytes = jsonBytes(runProvenance);
    writeOnce(resolve(rawRoot, "provenance.json"), provenanceBytes);
    const evidenceSha256 = sha256(provenanceBytes);
    const result = runResult(run, {
      started,
      startStatus,
      completed,
      disposition,
      adherent: telemetry.adherent,
      adherence: telemetry.adherence,
      routingPass: run.arm === "A1" || telemetry.reasons.length === 0,
      parentNoReview,
      usageSettled: settlement.available,
      terminalCaptured: telemetry.terminal !== null,
      usage,
      timing,
      tools,
      evaluation,
      terminalTree: terminalTree(candidateRoot),
      evidenceSha256,
      failure: [...new Set(issues)].filter(Boolean).join("; ") || null
    });
    writeOnce(resolve(lifecycleRoot, "settled.json"), jsonBytes({
      runnerProtocolId: RUNNER_PROTOCOL_ID,
      observationId: run.observationId,
      disposition: result.disposition,
      evidenceSha256
    }));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (processTerminated && observedStartStatus !== "pre-start" && retainedEvaluation === null) {
      try {
        retainedEvaluation = dependencies.evaluate
          ? dependencies.evaluate({candidateRoot, evaluatorRoot})
          : invokeEvaluator(options, candidateRoot, evaluatorRoot, rawRoot, "failure").value;
      } catch {
        retainedEvaluation = null;
      }
    }
    const provenance = existsSync(rawRoot)
      ? evidenceProvenance(rawRoot)
      : {files: []};
    const provenanceBytes = jsonBytes(provenance);
    if (existsSync(rawRoot) && !existsSync(resolve(rawRoot, "provenance.json"))) {
      writeOnce(resolve(rawRoot, "provenance.json"), provenanceBytes);
    }
    return observationFailure(
      run,
      observedStartStatus,
      `${phase}: ${message}`,
      sha256(provenanceBytes),
      retainedEvaluation
    );
  }
}

function reproduce(options, observations, dependencies) {
  const runs = pilotRuns();
  const details = [];
  for (let pass = 1; pass <= 2; pass += 1) {
    for (const run of runs) {
      const observation = observations.find((item) => item.observationId === run.observationId);
      if (!observation?.evaluation) {
        details.push({pass, observationId: run.observationId, match: false});
        continue;
      }
      const candidateRoot = resolve(options.candidateRoot, run.worktreeId);
      const rawRoot = resolve(options.artifactRoot, "private", run.observationId);
      const evaluatorRoot = resolve(rawRoot, "evaluator");
      const replay = dependencies.evaluate
        ? dependencies.evaluate({candidateRoot, evaluatorRoot})
        : invokeEvaluator(options, candidateRoot, evaluatorRoot, rawRoot, `reproduce-${pass}`).value;
      details.push({
        pass,
        observationId: run.observationId,
        match: sha256(jsonBytes(replay)) === sha256(jsonBytes(observation.evaluation))
      });
    }
  }
  return {passes: 2, pass: details.length === 8 && details.every((item) => item.match), details};
}

export function executePilot(options, dependencies = {}) {
  const preflightResult = dependencies.preflight
    ? dependencies.preflight(options)
    : preflight({...options, requireAuthorization: true}, dependencies);
  if (!preflightResult.pass) {
    throw new Error(`Preflight failed: ${preflightResult.reasons.join("; ")}`);
  }
  const executionOptions = {
    ...options,
    authorization: preflightResult.authorization,
    configuredMcpServers: preflightResult.cli?.configuredMcpServers
      ?? options.configuredMcpServers
      ?? []
  };
  assertAuthorizationFresh(preflightResult.authorization);
  mkdirSync(options.artifactRoot, {recursive: false});
  mkdirSync(options.candidateRoot, {recursive: false});
  writeOnce(
    resolve(options.candidateRoot, ".runner-negative-control"),
    Buffer.from("coordinator-only negative control\n", "utf8")
  );
  writeOnce(resolve(options.artifactRoot, "execution-preflight.json"), jsonBytes(preflightResult));
  writeOnce(resolve(options.artifactRoot, "pilot.lock"), jsonBytes({
    runnerProtocolId: RUNNER_PROTOCOL_ID,
    sourceCommit: SOURCE_COMMIT,
    authorizationBlobSha256: preflightResult.authorization.authorizationBlobSha256,
    retriesAllowed: 0
  }));
  const indexPath = resolve(options.artifactRoot, "lifecycle", "index.json");
  let index = defaultLifecycleIndex();
  writeOnce(indexPath, jsonBytes(index));
  const observations = [];
  for (const run of pilotRuns()) {
    assertFrozenOrder(index, run);
    const observation = runObservation(executionOptions, run, dependencies);
    observations.push(observation);
    index = appendIndex(indexPath, index, run, observation.started ? "started" : "unavailable");
    writeOnce(
      resolve(options.artifactRoot, "canonical", `${run.observationId}.json`),
      jsonBytes(sanitizeCanonical({
        observation: observation.observation,
        disposition: observation.dispositionRecord
      }))
    );
    if (observation.disposition !== "complete") break;
  }
  const reproduction = reproduce(executionOptions, observations, dependencies);
  const provenancePath = resolve(options.artifactRoot, "evidence-provenance.json");
  const summaryPath = resolve(options.artifactRoot, "canonical", "pilot-summary.json");
  const provenance = evidenceProvenance(options.artifactRoot, [provenancePath, summaryPath]);
  const provenanceBytes = jsonBytes(provenance);
  writeOnce(provenancePath, provenanceBytes);
  const summary = buildCanonicalSummary(observations, reproduction, sha256(provenanceBytes));
  writeOnce(summaryPath, jsonBytes(summary));
  return {preflight: preflightResult, observations, reproduction, provenance, summary};
}

export function dryRun() {
  return {
    schemaVersion: 1,
    runnerProtocolId: RUNNER_PROTOCOL_ID,
    sourceCommit: SOURCE_COMMIT,
    mode: "dry-run",
    createsRoots: false,
    invokesCopilot: false,
    consumesIds: false,
    order: pilotRuns().map((run) => ({
      observationId: run.observationId,
      arm: run.arm,
      parentSessionId: run.parentSessionId,
      workerSessionId: run.workerSessionId,
      worktreeId: run.worktreeId,
      parentTools: buildCopilotArgs({run, candidateRoot: "<fresh-candidate>"})
        .find((item) => item.startsWith("--available-tools="))
    })),
    authorization: {
      executeFlagRequired: true,
      decision: AUTHORIZATION_DECISION,
      committedApprovalRequired: false,
      mergedProspectiveAmendmentRequired: true,
      cleanCanonicalMainRequired: true,
      runnerSha256: runnerPackageDigest(),
      mainAuthorized: false
    }
  };
}

function main() {
  const parsed = parseArguments(process.argv);
  if (parsed.flags.size !== 1) {
    throw new Error(`Refusing to run without exactly one mode.\n${usage()}`);
  }
  if (parsed.flags.has("dry-run")) {
    process.stdout.write(jsonBytes(dryRun()));
    return;
  }
  const options = requiredOptions(parsed.values);
  if (parsed.flags.has("preflight")) {
    const result = preflight(options);
    process.stdout.write(jsonBytes(result));
    if (!result.pass) process.exitCode = 2;
    return;
  }
  if (!parsed.flags.has("execute")) {
    throw new Error(`Refusing measured execution without --execute.\n${usage()}`);
  }
  const result = executePilot(options);
  process.stdout.write(jsonBytes({
    decision: result.summary.pilot.decision,
    summary: relative(process.cwd(), resolve(options.artifactRoot, "canonical", "pilot-summary.json"))
      .split(sep).join("/")
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
