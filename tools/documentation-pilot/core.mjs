import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

const toolRoot = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(toolRoot, "..", "..");
export const experimentRoot = resolve(repositoryRoot, "experiments", "documentation-delegation");
export const SOURCE_COMMIT = "61c1391c7c712a8d8defbbaa6c54212c00ac9ce5";
export const RUNNER_PROTOCOL_ID = "feature-documentation-pilot-runner-v1";
export const AUTHORIZATION_DECISION = "authorize-excluded-documentation-pilot-v1";
export const CANONICAL_REPOSITORY = "cirvine-MSFT/agentskill-pattern";
export const CANONICAL_REMOTE_URL = "https://github.com/cirvine-MSFT/agentskill-pattern.git";
export const PARENT_TOOLS = Object.freeze({
  A1: ["read", "edit", "bash"],
  A2: ["read", "edit", "bash", "skill", "task"]
});
export const REQUIRED_HELP_FLAGS = Object.freeze([
  "-p, --prompt",
  "--session-id",
  "--model",
  "--output-format",
  "-C <directory>",
  "--allow-all-tools",
  "--available-tools",
  "--disable-builtin-mcps",
  "--disable-mcp-server",
  "--disallow-temp-dir",
  "--no-custom-instructions",
  "--no-ask-user",
  "--no-remote-export"
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableJson(value[key])])
    );
  }
  return value;
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(stableJson(value), null, 2)}\n`, "utf8");
}

function normalizedPathBinding(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function runnerFileNames(root = toolRoot) {
  const output = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (name === "authorizations" || name.startsWith("authorizations/")) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) output.push(name);
    }
  }
  walk(root);
  return output;
}

function digestEntries(entries) {
  const hash = createHash("sha256");
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(`${entry.name}\0${entry.bytes.length}\0`);
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
}

export function runnerPackageDigest() {
  return digestEntries(runnerFileNames().map((name) => ({
    name,
    bytes: readFileSync(resolve(toolRoot, name))
  })));
}

export function runnerPackageDigestAtCommit(commit) {
  const prefix = relative(repositoryRoot, toolRoot).split(sep).join("/");
  const names = git(["ls-tree", "-r", "--name-only", commit, "--", prefix])
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((name) => !name.startsWith(`${prefix}/authorizations/`));
  return digestEntries(names.map((name) => {
    const result = command("git", ["show", `${commit}:${name}`], {encoding: null});
    return {name: name.slice(prefix.length + 1), bytes: result.stdout};
  }));
}

export function authorizationBindings(options) {
  if (!isAbsolute(options.cli) || !existsSync(options.cli)) {
    throw new Error("CLI must be an absolute executable path for authorization binding");
  }
  return {
    sourceCommit: SOURCE_COMMIT,
    cliSha256: sha256(readFileSync(options.cli)),
    sessionStorePathSha256: sha256(Buffer.from(normalizedPathBinding(options.sessionStore), "utf8")),
    artifactRootPathSha256: sha256(Buffer.from(normalizedPathBinding(options.artifactRoot), "utf8")),
    candidateRootPathSha256: sha256(Buffer.from(normalizedPathBinding(options.candidateRoot), "utf8")),
    sandboxLauncherSha256: options.sandboxSha256,
    frozenOrderSha256: sha256(jsonBytes(pilotRuns().map((run) => ({
      observationId: run.observationId,
      parentSessionId: run.parentSessionId,
      workerSessionId: run.workerSessionId,
      worktreeId: run.worktreeId
    }))))
  };
}

export function currentApprovingReviews(reviews, finalHeadSha = null) {
  const latest = new Map();
  for (const review of [...reviews].sort((left, right) => {
    const time = Date.parse(left.submitted_at ?? "") - Date.parse(right.submitted_at ?? "");
    return time !== 0 ? time : (left.id ?? 0) - (right.id ?? 0);
  })) {
    const login = review.user?.login;
    if (typeof login === "string" && login.length > 0) latest.set(login, review);
  }
  return [...latest.entries()]
    .filter(([, review]) =>
      review.state === "APPROVED"
      && (finalHeadSha === null || review.commit_id === finalHeadSha))
    .map(([login]) => login)
    .sort();
}

export function verifyAuthorization(path, options, now = new Date()) {
  const absolute = resolve(path);
  const authorizationRoot = resolve(toolRoot, "authorizations");
  if (!within(authorizationRoot, absolute) || !existsSync(absolute)) {
    throw new Error("Authorization must be a committed file under tools/documentation-pilot/authorizations");
  }
  const repositoryPath = relative(repositoryRoot, absolute).split(sep).join("/");
  const tracked = command(
    "git", ["ls-files", "--error-unmatch", "--", repositoryPath], {allowFailure: true}
  );
  const committed = command(
    "git", ["show", `HEAD:${repositoryPath}`], {encoding: null, allowFailure: true}
  );
  const bytes = readFileSync(absolute);
  if (tracked.status !== 0 || committed.status !== 0 || !committed.stdout.equals(bytes)) {
    throw new Error("Authorization is not exactly committed at HEAD");
  }
  const approval = JSON.parse(bytes.toString("utf8"));
  const reasons = [];
  if (approval.schemaVersion !== 1
    || approval.runnerProtocolId !== RUNNER_PROTOCOL_ID
    || approval.decision !== AUTHORIZATION_DECISION
    || approval.approved !== true) {
    reasons.push("approval identity or decision is invalid");
  }
  if (!/^[a-f0-9]{40}$/u.test(approval.runnerSourceCommit ?? "")) {
    reasons.push("reviewed runner source commit is invalid");
  } else {
    const ancestor = command(
      "git", ["merge-base", "--is-ancestor", approval.runnerSourceCommit, "HEAD"],
      {allowFailure: true}
    );
    if (ancestor.status !== 0) reasons.push("reviewed runner source commit is not an ancestor");
  }
  const currentRunnerSha256 = runnerPackageDigest();
  let reviewedRunnerSha256 = null;
  try {
    reviewedRunnerSha256 = runnerPackageDigestAtCommit(approval.runnerSourceCommit);
  } catch (error) {
    reasons.push(`reviewed runner bytes are unavailable: ${error.message}`);
  }
  if (approval.runnerSha256 !== currentRunnerSha256
    || approval.runnerSha256 !== reviewedRunnerSha256) {
    reasons.push("current runner differs from the separately reviewed source commit");
  }
  const expiresAt = Date.parse(approval.expiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    reasons.push("approval is expired or lacks a valid expiry");
  }
  const expectedBindings = authorizationBindings(options);
  if (JSON.stringify(stableJson(approval.bindings))
    !== JSON.stringify(stableJson(expectedBindings))) {
    reasons.push("approval bindings differ from the exact execution resources");
  }
  if (reasons.length > 0) throw new Error(`Authorization invalid: ${reasons.join("; ")}`);
  const protectionResult = command(
    "gh",
    ["api", `repos/${CANONICAL_REPOSITORY}/branches/main/protection`],
    {allowFailure: true}
  );
  let protection = null;
  try {
    protection = JSON.parse(protectionResult.stdout);
  } catch {
    reasons.push("canonical main branch protection could not be parsed");
  }
  if (protectionResult.status !== 0
    || protection?.required_pull_request_reviews === null
    || protection?.required_pull_request_reviews === undefined) {
    reasons.push("canonical main does not prove required pull-request review protection");
  }
  const requiredApprovalCount =
    protection?.required_pull_request_reviews?.required_approving_review_count;
  if (!Number.isInteger(requiredApprovalCount) || requiredApprovalCount < 1) {
    reasons.push("canonical main does not require at least one approving review");
  }
  if (protection?.required_pull_request_reviews?.dismiss_stale_reviews !== true) {
    reasons.push("canonical main does not dismiss stale approvals");
  }
  if (protection?.enforce_admins?.enabled !== true) {
    reasons.push("canonical main protection is not enforced for administrators");
  }
  const fetch = command(
    "git",
    ["fetch", "--quiet", "--no-tags", CANONICAL_REMOTE_URL, "refs/heads/main"],
    {allowFailure: true}
  );
  if (fetch.status !== 0) reasons.push("canonical main could not be fetched");
  let remoteMain = null;
  let approvalCommit = null;
  let approvalPullRequest = null;
  let approvingReviewers = [];
  if (fetch.status === 0) {
    remoteMain = git(["rev-parse", "FETCH_HEAD"]);
    const remoteAuthorization = command(
      "git", ["show", `${remoteMain}:${repositoryPath}`], {encoding: null, allowFailure: true}
    );
    if (remoteAuthorization.status !== 0 || !remoteAuthorization.stdout.equals(bytes)) {
      reasons.push("authorization is not byte-identical on canonical main");
    }
    const reviewedOnRemote = command(
      "git", ["merge-base", "--is-ancestor", approval.runnerSourceCommit, remoteMain],
      {allowFailure: true}
    );
    const remoteOnHead = command(
      "git", ["merge-base", "--is-ancestor", remoteMain, "HEAD"],
      {allowFailure: true}
    );
    if (reviewedOnRemote.status !== 0 || remoteOnHead.status !== 0) {
      reasons.push("local HEAD and reviewed runner are not descendants of canonical main approval");
    }
    const approvalLog = command(
      "git", ["log", "-1", "--format=%H", remoteMain, "--", repositoryPath],
      {allowFailure: true}
    );
    approvalCommit = approvalLog.status === 0 ? approvalLog.stdout.trim() : null;
    if (!/^[a-f0-9]{40}$/u.test(approvalCommit ?? "")) {
      reasons.push("canonical approval commit could not be identified");
    } else {
      const pullsResult = command(
        "gh",
        [
          "api",
          "--paginate",
          "--slurp",
          "-H", "Accept: application/vnd.github+json",
          `repos/${CANONICAL_REPOSITORY}/commits/${approvalCommit}/pulls?per_page=100`
        ],
        {allowFailure: true}
      );
      let pulls = [];
      try {
        pulls = JSON.parse(pullsResult.stdout).flat();
      } catch {
        reasons.push("approval commit pull requests could not be parsed");
      }
      const pull = Array.isArray(pulls)
        ? pulls.find((item) =>
            item.merged_at
            && item.base?.ref === "main"
            && item.state === "closed")
        : null;
      if (pullsResult.status !== 0 || !pull) {
        reasons.push("approval commit is not associated with a merged canonical-main pull request");
      } else {
        approvalPullRequest = pull.number;
        const reviewsResult = command(
          "gh",
          [
            "api",
            "--paginate",
            "--slurp",
            `repos/${CANONICAL_REPOSITORY}/pulls/${pull.number}/reviews?per_page=100`
          ],
          {allowFailure: true}
        );
        let reviews = [];
        try {
          reviews = JSON.parse(reviewsResult.stdout).flat();
        } catch {
          reasons.push("approval pull-request reviews could not be parsed");
        }
        approvingReviewers = Array.isArray(reviews)
          ? currentApprovingReviews(reviews, pull.head?.sha)
          : [];
        if (reviewsResult.status !== 0
          || approvingReviewers.length < requiredApprovalCount) {
          reasons.push("approval pull request lacks the protected branch's required current approvals");
        }
      }
    }
  }
  if (reasons.length > 0) throw new Error(`Authorization invalid: ${reasons.join("; ")}`);
  return {
    approvalId: approval.approvalId,
    decision: approval.decision,
    approved: true,
    runnerSourceCommit: approval.runnerSourceCommit,
    runnerSha256: approval.runnerSha256,
    expiresAt: approval.expiresAt,
    bindingsSha256: sha256(jsonBytes(approval.bindings)),
    authorizationBlobSha256: sha256(bytes),
    repositoryPath,
    canonicalRemoteMain: remoteMain,
    branchProtectionSha256: sha256(Buffer.from(protectionResult.stdout, "utf8")),
    approvalCommit,
    approvalPullRequest,
    approvingReviewers
  };
}

export function writeOnce(path, bytes) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, bytes, {flag: "wx"});
}

export function readDesign() {
  const read = (name) => JSON.parse(readFileSync(resolve(experimentRoot, "design", name), "utf8"));
  return {
    contract: read("arm-contract.json"),
    manifest: read("source-manifest.json"),
    prompts: read("prompts.json"),
    schedule: read("schedule.json")
  };
}

export function pilotRuns(schedule = readDesign().schedule) {
  return schedule.pilot.flatMap((block) =>
    [...block.runs]
      .sort((left, right) => left.order - right.order)
      .map((run) => ({
        ...run,
        blockId: block.blockId,
        fixtureId: block.fixtureId,
        variantId: block.variantId,
        phase: block.phase
      })));
}

export function frozenMaterializationId(run) {
  return `FREEZE-${run.fixtureId}-${run.variantId}`;
}

function command(command, args, options = {}) {
  const encoding = Object.hasOwn(options, "encoding") ? options.encoding : "utf8";
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding,
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (options.allowFailure !== true && (result.error || result.status !== 0)) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message
        ?? (Buffer.isBuffer(result.stderr)
          ? result.stderr.toString("utf8").trim()
          : result.stderr?.trim())}`
    );
  }
  return result;
}

function git(args, options = {}) {
  return command("git", args, options).stdout.trim();
}

function within(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function assertExternalFreshRoots({artifactRoot, candidateRoot}) {
  for (const [name, path] of [["artifact", artifactRoot], ["candidate", candidateRoot]]) {
    if (!path || !isAbsolute(path)) throw new Error(`${name} root must be an absolute path`);
    if (within(repositoryRoot, path) || within(path, repositoryRoot)) {
      throw new Error(`${name} root must be physically outside the source repository`);
    }
    if (existsSync(path)) throw new Error(`${name} root already exists`);
  }
  if (within(artifactRoot, candidateRoot) || within(candidateRoot, artifactRoot)) {
    throw new Error("Candidate and artifact roots must be physically separate");
  }
}

export function verifyFrozenSources({materializeFixture, directoryDigest}) {
  const {manifest, schedule} = readDesign();
  const errors = [];
  if (git(["rev-parse", SOURCE_COMMIT]) !== SOURCE_COMMIT) {
    errors.push("merged preregistration source commit is unavailable");
  }
  const head = git(["rev-parse", "HEAD"]);
  const ancestor = command(
    "git", ["merge-base", "--is-ancestor", SOURCE_COMMIT, head], {allowFailure: true}
  );
  if (ancestor.status !== 0) errors.push("HEAD does not descend from the merged preregistration");

  for (const [path, expected] of Object.entries(manifest.sources)) {
    const absolute = resolve(repositoryRoot, path);
    if (!existsSync(absolute) || sha256(readFileSync(absolute)) !== expected) {
      errors.push(`frozen source differs: ${path}`);
      continue;
    }
    const manifestPath = "experiments/documentation-delegation/design/source-manifest.json";
    const pinnedManifest = command("git", ["show", `${SOURCE_COMMIT}:${manifestPath}`], {
      encoding: null,
      allowFailure: true
    });
    if (pinnedManifest.status !== 0
      || !pinnedManifest.stdout.equals(readFileSync(resolve(repositoryRoot, manifestPath)))) {
      errors.push("source manifest bytes differ from the merged preregistration");
    }
    const pinned = command("git", ["show", `${SOURCE_COMMIT}:${path}`], {
      encoding: null,
      allowFailure: true
    });
    if (pinned.status !== 0 || sha256(pinned.stdout) !== expected) {
      errors.push(`source commit does not bind frozen bytes: ${path}`);
    }
  }

  const temporary = resolve(tmpdir(), `documentation-pilot-preflight-${process.pid}`);
  rmSync(temporary, {recursive: true, force: true});
  mkdirSync(temporary, {recursive: true});
  try {
    for (const run of pilotRuns(schedule)) {
      const key = `pilot/${run.fixtureId}/${run.variantId}`;
      const expected = manifest.generatedBundles[key];
      const candidate = resolve(temporary, run.observationId, "candidate");
      const evaluator = resolve(temporary, run.observationId, "evaluator");
      materializeFixture({
        fixtureId: run.fixtureId,
        variantId: run.variantId,
        candidateRoot: candidate,
        evaluatorRoot: evaluator,
        observationId: frozenMaterializationId(run)
      });
      if (directoryDigest(candidate) !== expected?.candidateSha256
        || directoryDigest(evaluator) !== expected?.evaluatorSha256) {
        errors.push(`generated bundle differs: ${key}`);
      }
    }
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
  return {head, errors};
}

export function buildParentPrompt(arm, prompts = readDesign().prompts) {
  if (!["A1", "A2"].includes(arm)) throw new Error(`Unknown arm ${arm}`);
  return `${prompts.sharedEnvelope}\n\n${prompts[arm]}`;
}

export function buildWorkerHandoff({sourcePath, docTarget}, prompts = readDesign().prompts) {
  return prompts.workerHandoff
    .replaceAll("CHANGED_SOURCE_PATHS", sourcePath)
    .replaceAll("TARGET", docTarget);
}

export function buildCopilotArgs({
  run,
  candidateRoot,
  disabledMcpServers = [],
  prompts = readDesign().prompts
}) {
  const design = readDesign();
  const cli = design.contract.cli;
  const tools = PARENT_TOOLS[run.arm];
  return [
    "-p", buildParentPrompt(run.arm, prompts),
    "--session-id", run.parentSessionId,
    "--model", cli.parentModel,
    "--output-format", "json",
    "-C", resolve(candidateRoot),
    "--allow-all-tools",
    `--available-tools=${tools.join(",")}`,
    "--disable-builtin-mcps",
    ...disabledMcpServers.flatMap((name) => ["--disable-mcp-server", name]),
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export",
    "--no-auto-update",
    "--context", "default",
    "--effort", cli.parentEffort
  ];
}

export function parseJsonl(bytes) {
  return bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event.type !== "string") throw new Error("event type is missing");
      return event;
    } catch (error) {
      throw new Error(`Copilot JSONL line ${index + 1} is invalid: ${error.message}`);
    }
  });
}

function eventRole(event, workerCallId) {
  return event.agentId === workerCallId
    || event.data?.parentToolCallId === workerCallId
    || event.parentToolCallId === workerCallId
    ? "worker"
    : "parent";
}

function toolPath(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== "object") return null;
  for (const key of ["path", "file", "filePath", "file_path", "target"]) {
    if (typeof argumentsValue[key] === "string") return argumentsValue[key];
  }
  return null;
}

function resultText(event) {
  const result = event.data?.result ?? event.result;
  for (const value of [
    result?.content,
    result?.detailedContent,
    event.data?.content,
    event.content
  ]) {
    if (typeof value === "string") return value;
  }
  return null;
}

export function normalizeEvents(events, {run, boundary}) {
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const completes = events.filter((event) => event.type === "tool.execution_complete");
  const taskStarts = starts.filter((event) => event.data?.toolName === "task");
  const workerCallId = taskStarts[0]?.data?.toolCallId ?? null;
  const normalized = [];

  for (const event of starts) {
    const role = eventRole(event, workerCallId);
    const name = event.data?.toolName;
    if (name === "task") {
      normalized.push({
        type: "agent_invocation",
        actor: role,
        agent: event.data?.arguments?.agent_type ?? null
      });
    } else if (name === "skill") {
      normalized.push({
        type: "skill_invocation",
        actor: role,
        skill: event.data?.arguments?.skill ?? null
      });
    } else {
      const completion = completes.find((item) =>
        item.data?.toolCallId === event.data?.toolCallId);
      normalized.push({
        type: "tool",
        actor: role,
        tool: name,
        path: toolPath(event.data?.arguments),
        success: completion?.data?.success === true
      });
    }
  }

  const workerStart = events.find((event) =>
    event.type === "subagent.started"
    && (event.data?.toolCallId === workerCallId || event.agentId === workerCallId));
  if (workerStart) {
    normalized.push({
      type: "session_created",
      actor: "worker",
      sessionId: workerStart.data?.sessionId
        ?? workerStart.data?.session_id
        ?? workerStart.sessionId
        ?? workerStart.agentId
        ?? workerCallId,
      model: workerStart.data?.model ?? null
    });
  }
  const taskCompletion = completes.find((event) =>
    event.data?.toolCallId === workerCallId);
  if (taskCompletion) {
    normalized.push({
      type: "terminal",
      actor: "worker",
      text: resultText(taskCompletion)
    });
  }
  return {
    workerCallId,
    record: {
      arm: run.arm,
      workerSessionId: run.workerSessionId,
      boundary,
      events: normalized
    }
  };
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

export function auditTelemetry(events, {
  run,
  boundary,
  evaluateAdherence,
  expectedWorkerPrompt = null
}) {
  const {contract} = readDesign();
  const reasons = [];
  const results = events.filter((event) => event.type === "result");
  if (results.length !== 1
    || results[0].sessionId !== run.parentSessionId
    || !Number.isInteger(results[0].exitCode)) {
    reasons.push("terminal result is missing, duplicated, or bound to another parent session");
  }
  const normalized = normalizeEvents(events, {run, boundary});
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const taskStarts = starts.filter((event) => event.data?.toolName === "task");
  const skillStarts = starts.filter((event) =>
    event.data?.toolName === "skill"
    && event.data?.arguments?.skill === "feature-documentation");
  const parentModels = unique(events
    .filter((event) => eventRole(event, normalized.workerCallId) === "parent"
      && ["model.call_start", "assistant.message"].includes(event.type))
    .map((event) => event.data?.model));
  const workerModels = unique(events
    .filter((event) => eventRole(event, normalized.workerCallId) === "worker"
      && ["model.call_start", "assistant.message", "subagent.started", "subagent.completed"]
        .includes(event.type))
    .map((event) => event.data?.model));
  if (parentModels.length !== 1 || parentModels[0] !== contract.cli.parentModel) {
    reasons.push("parent model attribution differs from the frozen pin");
  }
  if (run.arm === "A1") {
    if (taskStarts.length !== 0 || skillStarts.length !== 0 || workerModels.length !== 0) {
      reasons.push("A1 created a forbidden documentation worker");
    }
  } else {
    if (skillStarts.length !== 1 || taskStarts.length !== 1) {
      reasons.push("A2 Skill/task lifecycle is missing or duplicated");
    }
    if (taskStarts[0]?.data?.arguments?.agent_type !== "feature-documentation-haiku") {
      reasons.push("A2 invoked a non-frozen documentation agent");
    }
    if (expectedWorkerPrompt !== null
      && taskStarts[0]?.data?.arguments?.prompt !== expectedWorkerPrompt) {
      reasons.push("worker handoff differs from the frozen prompt bytes");
    }
    const skillIndex = events.indexOf(skillStarts[0]);
    const taskIndex = events.indexOf(taskStarts[0]);
    const skillCompletion = events.find((event) =>
      event.type === "tool.execution_complete"
      && event.data?.toolCallId === skillStarts[0]?.data?.toolCallId
      && event.data?.success === true);
    if (skillIndex < 0 || taskIndex < 0 || skillIndex >= taskIndex
      || events.indexOf(skillCompletion) <= skillIndex
      || events.indexOf(skillCompletion) >= taskIndex) {
      reasons.push("Skill completion does not precede the single worker launch");
    }
    if (workerModels.length !== 1 || workerModels[0] !== contract.cli.workerModel) {
      reasons.push("worker model attribution differs from the frozen pin");
    }
  }
  const adherence = evaluateAdherence(normalized.record);
  reasons.push(...adherence.violations);
  return {
    adherent: reasons.length === 0 && adherence.adherent,
    adherence: {...adherence, violations: unique([...adherence.violations, ...reasons]).sort()},
    reasons: unique(reasons).sort(),
    workerCallId: normalized.workerCallId,
    terminal: results[0] ?? null,
    normalizedEvents: normalized.record.events
  };
}

function validNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sum(rows, field) {
  if (rows.some((row) => !validNumber(row[field]))) return null;
  const value = rows.reduce((total, row) => total + row[field], 0);
  return Number.isSafeInteger(value) || validNumber(value) ? value : null;
}

function aggregate(rows, required) {
  if (rows.length === 0) {
    return required ? null : {
      aiCredits: 0,
      nanoAiu: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: 0,
      completions: 0,
      peakInputTokens: 0
    };
  }
  const nanoAiu = sum(rows, "total_nano_aiu");
  const inputTokens = sum(rows, "input_tokens");
  const outputTokens = sum(rows, "output_tokens");
  const durationMs = sum(rows, "duration_ms");
  if ([nanoAiu, inputTokens, outputTokens, durationMs].some((value) => value === null)) {
    return null;
  }
  return {
    aiCredits: nanoAiu / 1e9,
    nanoAiu,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs,
    completions: rows.length,
    peakInputTokens: Math.max(...rows.map((row) => row.input_tokens))
  };
}

export function settleUsage(rows, {run, workerCallId}) {
  const {contract} = readDesign();
  const parent = rows.filter((row) =>
    row.session_id === run.parentSessionId
    && (row.agent_id === null || row.agent_id === undefined)
    && (row.parent_tool_call_id === null || row.parent_tool_call_id === undefined));
  const worker = rows.filter((row) =>
    (run.workerSessionId !== null && run.workerSessionId !== undefined
      && (row.session_id === run.workerSessionId
        || row.agent_id === run.workerSessionId
        || row.parent_tool_call_id === run.workerSessionId))
    || (workerCallId && (row.agent_id === workerCallId
      || row.parent_tool_call_id === workerCallId)));
  const recognized = new Set([...parent, ...worker]);
  const reasons = [];
  if (recognized.size !== rows.length) reasons.push("usage contains unattributed rows");
  if (parent.some((row) => row.model !== contract.cli.parentModel)) {
    reasons.push("parent usage model differs from the frozen pin");
  }
  if (worker.some((row) => row.model !== contract.cli.workerModel)) {
    reasons.push("worker usage model differs from the frozen pin");
  }
  const parentUsage = aggregate(parent, true);
  const workerUsage = aggregate(worker, run.arm === "A2");
  if (!parentUsage) reasons.push("parent usage is missing or invalid");
  if (!workerUsage) reasons.push("worker usage is missing or invalid");
  if (run.arm === "A1" && worker.length > 0) reasons.push("A1 has unexpected worker usage");
  if (reasons.length > 0) return {available: false, reasons: unique(reasons).sort(), usage: null};
  return {
    available: true,
    reasons: [],
    usage: {
      combinedAiCredits: parentUsage.aiCredits + workerUsage.aiCredits,
      parentAiCredits: parentUsage.aiCredits,
      workerAiCredits: workerUsage.aiCredits,
      combinedNanoAiu: parentUsage.nanoAiu + workerUsage.nanoAiu,
      parentNanoAiu: parentUsage.nanoAiu,
      workerNanoAiu: workerUsage.nanoAiu,
      totalTokens: parentUsage.totalTokens + workerUsage.totalTokens,
      parentTokens: parentUsage.totalTokens,
      workerTokens: workerUsage.totalTokens,
      parentCumulativeInputTokens: parentUsage.inputTokens,
      parentPeakInputTokens: parentUsage.peakInputTokens,
      parentOutputTokens: parentUsage.outputTokens,
      workerInputTokens: workerUsage.inputTokens,
      workerOutputTokens: workerUsage.outputTokens,
      completions: parentUsage.completions + workerUsage.completions,
      parentDurationMs: parentUsage.durationMs,
      workerDurationMs: workerUsage.durationMs
    }
  };
}

export function unavailableUsage() {
  return Object.fromEntries([
    "combinedAiCredits", "parentAiCredits", "workerAiCredits", "combinedNanoAiu",
    "parentNanoAiu", "workerNanoAiu", "totalTokens", "parentTokens", "workerTokens",
    "parentCumulativeInputTokens", "parentPeakInputTokens", "parentOutputTokens",
    "workerInputTokens", "workerOutputTokens", "completions"
  ].map((field) => [field, null]));
}

export function deriveTiming(events, usage, startedAt, endedAt, workerCallId) {
  const workerStart = events.find((event) =>
    event.type === "subagent.started"
    && (event.agentId === workerCallId || event.data?.toolCallId === workerCallId));
  const workerEnd = events.find((event) =>
    event.type === "subagent.completed"
    && (event.agentId === workerCallId || event.data?.toolCallId === workerCallId));
  const waitMs = workerStart && workerEnd
    ? Math.max(0, Date.parse(workerEnd.timestamp) - Date.parse(workerStart.timestamp))
    : 0;
  const wallMs = Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(endedAt))
    ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
    : null;
  return {
    activeMs: usage?.parentDurationMs ?? null,
    workerMs: usage?.workerDurationMs ?? null,
    waitMs: workerCallId ? waitMs : 0,
    wallMs
  };
}

export function deriveTools(events, workerCallId) {
  const starts = events.filter((event) => event.type === "tool.execution_start");
  const completes = events.filter((event) => event.type === "tool.execution_complete");
  return {
    parentCalls: starts.filter((event) => eventRole(event, workerCallId) === "parent").length,
    workerCalls: starts.filter((event) => eventRole(event, workerCallId) === "worker").length,
    resultBytes: completes.reduce((total, event) =>
      total + Buffer.byteLength(resultText(event) ?? "", "utf8"), 0)
  };
}

const SECRET_PATTERNS = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*\b/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:client_secret|api_key|access_token)\s*[=:]\s*["']?[A-Za-z0-9._~+/-]{12,}/iu
]);

export function privacyAudit(values) {
  const matches = [];
  for (const [name, value] of Object.entries(values)) {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) matches.push(name);
  }
  return {pass: matches.length === 0, secretBearingSources: matches.sort()};
}

export function sanitizeReason(value) {
  return String(value ?? "")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/giu, "<user-home>")
    .replace(/\/(?:home|Users)\/[^/\s]+/gu, "<user-home>")
    .replace(/[A-Za-z]:\\[^\r\n"]+/gu, "<absolute-path>")
    .replace(/\/(?:tmp|var|private)\/[^\r\n"]+/gu, "<absolute-path>")
    .slice(0, 500);
}

export function sanitizeCanonical(value) {
  if (Array.isArray(value)) return value.map(sanitizeCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeCanonical(item)])
    );
  }
  return typeof value === "string" ? sanitizeReason(value) : value;
}

export function computePilotDecision(observations, reproduction) {
  const runs = pilotRuns();
  const byId = new Map(observations.map((item) => [item.observationId, item]));
  const expected = runs.map((run) => byId.get(run.observationId));
  const a2 = expected.filter((item) => item?.arm === "A2");
  const gates = {
    exactFrozenCoverage: observations.length === 4
      && expected.every(Boolean)
      && new Set(observations.map((item) => item.observationId)).size === 4,
    allStartedOnce: expected.every((item) => item?.started === true && item.startCount === 1),
    allArtifactsEvaluated: expected.every((item) => item?.evaluation !== null),
    treatmentRouting: a2.length === 2
      && a2.every((item) => item.routingPass === true),
    treatmentAdherence: a2.length === 2
      && a2.every((item) => item.adherent === true),
    parentNoReview: a2.length === 2
      && a2.every((item) => item.parentNoReview === true),
    usagePartition: expected.every((item) => item?.usageSettled === true),
    terminalCapture: expected.every((item) => item?.terminalCaptured === true),
    deterministicReproduction: reproduction?.pass === true
      && reproduction?.passes === 2
  };
  return {
    decision: Object.values(gates).every(Boolean) ? "GO" : "NO-GO",
    gates
  };
}

function ratio(numerator, denominator) {
  return validNumber(numerator) && validNumber(denominator) && denominator !== 0
    ? numerator / denominator
    : null;
}

export function buildCanonicalSummary(observations, reproduction, provenanceSha256) {
  const pairs = readDesign().schedule.pilot.map((block) => {
    const records = Object.fromEntries(block.runs.map((run) => [
      run.arm,
      observations.find((item) => item.observationId === run.observationId)
    ]));
    return {
      blockId: block.blockId,
      combinedCreditsRatioA2A1: ratio(
        records.A2?.usage?.combinedAiCredits,
        records.A1?.usage?.combinedAiCredits
      ),
      parentInputRatioA2A1: ratio(
        records.A2?.usage?.parentCumulativeInputTokens,
        records.A1?.usage?.parentCumulativeInputTokens
      ),
      featureDifferenceA2MinusA1: records.A2?.evaluation && records.A1?.evaluation
        ? records.A2.evaluation.feature.score - records.A1.evaluation.feature.score
        : null,
      docsDifferenceA2MinusA1: records.A2?.evaluation && records.A1?.evaluation
        ? records.A2.evaluation.documentation.correctness
          - records.A1.evaluation.documentation.correctness
        : null
    };
  });
  return {
    schemaVersion: 1,
    protocolId: readDesign().contract.protocolId,
    runnerProtocolId: RUNNER_PROTOCOL_ID,
    sourceCommit: SOURCE_COMMIT,
    outcomeEligibility: "permanently-excluded-pilot",
    runs: observations.map((item) => ({
      observationId: item.observationId,
      blockId: item.blockId,
      arm: item.arm,
      started: item.started,
      completed: item.completed,
      disposition: item.disposition,
      adherent: item.adherent,
      usageSettled: item.usageSettled,
      usage: item.usage,
      timing: item.timing,
      tools: item.tools,
      evaluation: sanitizeCanonical(item.evaluation),
      evidenceSha256: item.evidenceSha256,
      failure: item.failure ? sanitizeReason(item.failure) : null
    })),
    pairs,
    reproduction,
    pilot: computePilotDecision(observations, reproduction),
    retainedEvidenceProvenanceSha256: provenanceSha256,
    privacy: {
      canonicalPaths: "omitted",
      rawEvidence: "retained only in the authorized durable artifact root"
    },
    authorizationBoundary: {
      mainAuthorized: false,
      nextStep: "A pilot GO plus separate explicit main authorization is required."
    }
  };
}

export function evidenceProvenance(root, excluded = []) {
  const excludedSet = new Set(excluded.map((path) => resolve(path)));
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (excludedSet.has(path)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        files.push({
          path: relative(root, path).split(sep).join("/"),
          bytes: bytes.length,
          sha256: sha256(bytes)
        });
      }
    }
  }
  walk(root);
  return {
    schemaVersion: 1,
    runnerProtocolId: RUNNER_PROTOCOL_ID,
    evidencePolicy: "write-once private raw evidence with hash-bound canonical summaries",
    files
  };
}

export function assertFrozenOrder(index, nextRun) {
  const runs = pilotRuns();
  if (!index || index.runnerProtocolId !== RUNNER_PROTOCOL_ID || !Array.isArray(index.entries)) {
    throw new Error("Lifecycle index is invalid");
  }
  if (index.entries.length >= runs.length) throw new Error("All frozen pilot slots are consumed");
  const expected = runs[index.entries.length];
  if (expected.observationId !== nextRun.observationId) {
    throw new Error(`Next frozen observation is ${expected.observationId}`);
  }
  const ids = index.entries.flatMap((entry) => [
    entry.observationId,
    entry.parentSessionId,
    entry.workerSessionId
  ]).filter(Boolean);
  for (const id of [nextRun.observationId, nextRun.parentSessionId, nextRun.workerSessionId]
    .filter(Boolean)) {
    if (ids.includes(id)) throw new Error(`Frozen ID already consumed: ${id}`);
  }
}

export function createCandidateGitRoot(candidateRoot) {
  command("git", ["init", "--initial-branch", "main", "--quiet"], {cwd: candidateRoot});
  command("git", ["add", "."], {cwd: candidateRoot});
  command("git", [
    "-c", "user.name=Documentation Pilot Coordinator",
    "-c", "user.email=pilot.invalid",
    "commit", "--quiet", "-m", "Materialize isolated documentation candidate"
  ], {
    cwd: candidateRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
    }
  });
  return {
    initialCommit: git(["rev-parse", "HEAD"], {cwd: candidateRoot}),
    initialTree: git(["rev-parse", "HEAD^{tree}"], {cwd: candidateRoot})
  };
}

export function inspectCli(cli) {
  const version = command(cli, ["--version"], {allowFailure: true});
  const help = command(cli, ["--help"], {allowFailure: true});
  const mcp = command(cli, ["mcp", "list"], {allowFailure: true});
  const servers = mcp.status === 0
    ? [...mcp.stdout.matchAll(/^\s{2}([A-Za-z0-9._-]+)\s+\((?:local|remote)\)\s*$/gmu)]
      .map((match) => match[1]).sort()
    : [];
  const expectedVersion = `GitHub Copilot CLI ${readDesign().contract.cli.version}.`;
  const versionLine = version.stdout?.split(/\r?\n/u).find(Boolean) ?? null;
  const reasons = [];
  if (version.status !== 0 || versionLine !== expectedVersion) {
    reasons.push(`requires exact ${expectedVersion}`);
  }
  if (help.status !== 0) reasons.push("CLI help is unavailable");
  for (const flag of REQUIRED_HELP_FLAGS) {
    if (!help.stdout?.includes(flag)) reasons.push(`CLI help is missing ${flag}`);
  }
  if (mcp.status !== 0) reasons.push("configured MCP servers cannot be enumerated");
  return {pass: reasons.length === 0, reasons, versionLine, configuredMcpServers: servers};
}

export function inspectSandboxLauncher(path, expectedSha256) {
  if (!path || !existsSync(path)) return {pass: false, reasons: ["sandbox launcher is missing"]};
  const observed = sha256(readFileSync(path));
  const reasons = observed === expectedSha256 ? [] : ["sandbox launcher hash differs"];
  const probe = command(path, ["--self-test", "--json"], {allowFailure: true});
  let receipt = null;
  try {
    receipt = JSON.parse(probe.stdout);
  } catch {
    reasons.push("sandbox launcher self-test did not return JSON");
  }
  if (probe.status !== 0
    || receipt?.filesystemIsolation !== true
    || receipt?.candidateOnly !== true
    || receipt?.networkDeny !== true
    || receipt?.evaluatorSeparation !== true) {
    reasons.push("sandbox launcher cannot attest the frozen isolation boundary");
  }
  return {pass: reasons.length === 0, reasons: unique(reasons), sha256: observed, receipt};
}

export function inspectCleanRepository() {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  return {pass: status === "", status};
}

export function defaultLifecycleIndex() {
  return {
    schemaVersion: 1,
    runnerProtocolId: RUNNER_PROTOCOL_ID,
    sourceCommit: SOURCE_COMMIT,
    entries: []
  };
}

export function statFiles(root) {
  return readdirSync(root, {recursive: true})
    .map((name) => resolve(root, String(name)))
    .filter((path) => statSync(path).isFile());
}
