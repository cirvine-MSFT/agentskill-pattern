#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthenticatedExport } from "./authenticated-export.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const armContract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));
const seeds = JSON.parse(readFileSync(resolve(root, "design", "seeds.json"), "utf8"));
const frozenRequest = JSON.parse(readFileSync(resolve(root, "design", "corpus-request.json"), "utf8"));
const delegatedSkillSha256 = createHash("sha256")
  .update(readFileSync(resolve(root, "..", "..", ".github", "skills", "semantic-test-corpus", "SKILL.md")))
  .digest("hex");
const MCP_TOOLS = new Set(armContract.commonContract.toolSurface);

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function argumentsSha256(value) {
  return createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex");
}

function expectedRoles(arm) {
  return arm.delegated ? ["parent", "worker"] : ["parent"];
}

function authenticatedRunMappings(payload) {
  const mappings = [];
  for (const creation of payload.events.filter((event) => event.type === "session.created")) {
    const planned = schedule.runs.find((run) => run.runId === creation.runId);
    const arm = armContract.arms.find((item) => item.id === creation.armId);
    if (!planned
      || planned.armId === 0
      || planned.armId !== creation.armId
      || planned.blockId !== creation.blockId
      || !arm
      || !expectedRoles(arm).includes(creation.role)) {
      continue;
    }
    const bindings = payload.events.filter((event) =>
      event.type === "model.bound"
      && event.runId === creation.runId
      && event.blockId === creation.blockId
      && event.armId === creation.armId
      && event.role === creation.role
      && event.sessionId === creation.sessionId);
    if (bindings.length === 1) {
      mappings.push({
        runId: creation.runId,
        blockId: creation.blockId,
        armId: creation.armId,
        role: creation.role,
        sessionId: creation.sessionId
      });
    }
  }
  for (const planned of schedule.runs.filter((run) => run.armId === 0)) {
    const starts = payload.events.filter((event) =>
      event.type === "run.started" && event.runId === planned.runId);
    if (starts.length !== 1) continue;
    const start = starts[0];
    if (start.blockId === planned.blockId
      && start.armId === 0
      && start.role === "baseline"
      && start.sequence === planned.order
      && typeof start.sessionId === "string"
      && start.sessionId.length > 0
      && typeof start.processId === "string"
      && start.processId.length > 0) {
      mappings.push({
        runId: planned.runId,
        blockId: planned.blockId,
        armId: 0,
        role: "baseline",
        sessionId: start.sessionId,
        processId: start.processId
      });
    }
  }
  for (const event of payload.events.filter((item) => item.type === "metrics.computed")) {
    const planned = schedule.runs.find((run) => run.runId === event.runId);
    if (planned
      && event.blockId === planned.blockId
      && event.armId === planned.armId
      && event.role === "evaluator"
      && event.actor === "evaluator"
      && typeof event.sessionId === "string"
      && event.sessionId.length > 0
      && typeof event.processId === "string"
      && event.processId.length > 0) {
      mappings.push({
        runId: planned.runId,
        blockId: planned.blockId,
        armId: planned.armId,
        role: "evaluator",
        sessionId: event.sessionId,
        processId: event.processId
      });
    }
  }
  return mappings;
}

function attributeEvents(payload, mappings, types) {
  const violations = [];
  let attributedEvents = 0;
  const events = payload.events.filter((event) => types.has(event.type));
  for (const event of events) {
    const actorSessionId = event.type === "network.access" ? event.actorSessionId : event.sessionId;
    const actorMappings = mappings.filter((mapping) => mapping.sessionId === actorSessionId);
    const matches = actorMappings.filter((mapping) =>
      mapping.runId === event.runId
      && mapping.blockId === event.blockId
      && mapping.armId === event.armId
      && mapping.role === event.role
      && mapping.sessionId === event.sessionId
      && (event.actor === undefined || event.actor === mapping.role));
    if (actorMappings.length !== 1) {
      violations.push(`${event.type} ${event.eventId} actor session maps to ${actorMappings.length} scheduled run roles`);
    }
    if (matches.length !== 1) {
      violations.push(`${event.type} ${event.eventId} is not attributable to exactly one scheduled run role`);
    } else if (actorMappings.length === 1) {
      attributedEvents += 1;
    }
  }
  return {
    status: violations.length === 0 ? "compliant" : "noncompliant",
    totalEvents: events.length,
    attributedEvents,
    violations
  };
}

const GLOBAL_ATTRIBUTION_TYPES = new Set([
  "sandbox.policy.applied",
  "audit.started",
  "audit.completed",
  "tool.called",
  "tool.result",
  "fs.access",
  "network.access",
  "outcome.accessed",
  "delegation.invoked",
  "delegation.completed",
  "usage.reported",
  "run.completed",
  "outcomes.unblinded",
  "metrics.computed"
]);

const BASELINE_FORBIDDEN_TYPES = new Set([
  "session.created",
  "model.bound",
  "sandbox.policy.applied",
  "audit.started",
  "audit.completed",
  "tool.called",
  "tool.result",
  "fs.access",
  "network.access",
  "delegation.invoked",
  "delegation.completed"
]);

function evaluateBaselineEvidence(payload, mappings) {
  const violations = [];
  let totalEvents = 0;
  let attributedEvents = 0;
  const signaledEvents = payload.events.filter((event) => {
    const planned = schedule.runs.find((run) => run.runId === event.runId);
    return planned?.armId === 0 || event.armId === 0 || event.role === "baseline";
  });
  for (const event of signaledEvents) {
    const planned = schedule.runs.find((run) => run.runId === event.runId);
    if (!planned
      || planned.armId !== 0
      || event.blockId !== planned.blockId
      || event.armId !== 0) {
      violations.push(`baseline event ${event.eventId} differs from the frozen baseline schedule`);
    }
  }

  const runIds = new Set(signaledEvents
    .map((event) => event.runId)
    .filter((runId) => schedule.runs.some((run) => run.runId === runId && run.armId === 0)));
  for (const runId of runIds) {
    const planned = schedule.runs.find((run) => run.runId === runId);
    const runEvents = payload.events.filter((event) => event.runId === runId);
    const mappingsForRun = mappings.filter((mapping) =>
      mapping.runId === runId && mapping.role === "baseline");
    const mapping = mappingsForRun[0];
    const starts = runEvents.filter((event) => event.type === "run.started");
    const completions = runEvents.filter((event) => event.type === "run.completed");
    const unblindings = runEvents.filter((event) => event.type === "outcomes.unblinded");
    const usage = runEvents.filter((event) => event.type === "usage.reported");
    const outcomes = runEvents.filter((event) => event.type === "outcome.accessed");
    totalEvents += starts.length;
    if (mappingsForRun.length !== 1 || starts.length !== 1) {
      violations.push(`${runId} requires one authenticated baseline session/process mapping`);
    } else {
      attributedEvents += 1;
      const duplicateSessionStarts = payload.events.filter((event) =>
        event.type === "run.started" && event.sessionId === mapping.sessionId);
      const duplicateProcessStarts = payload.events.filter((event) =>
        event.type === "run.started" && event.processId === mapping.processId);
      if (duplicateSessionStarts.length !== 1 || duplicateProcessStarts.length !== 1) {
        violations.push(`${runId} baseline session/process boundary is reused`);
      }
    }
    if (completions.length !== 1 || unblindings.length !== 1) {
      violations.push(`${runId} requires one baseline completion and unblinding boundary`);
    }
    for (const event of [...starts, ...completions, ...unblindings, ...usage, ...outcomes]) {
      if (!mapping
        || event.sessionId !== mapping.sessionId
        || event.role !== "baseline"
        || event.blockId !== planned.blockId
        || event.armId !== 0) {
        violations.push(`baseline event ${event.eventId} is not owned by its authenticated baseline mapping`);
      }
    }
    const forbidden = runEvents.filter((event) => BASELINE_FORBIDDEN_TYPES.has(event.type));
    for (const event of forbidden) {
      violations.push(`baseline run ${runId} emitted forbidden model/MCP event ${event.eventId}`);
    }

    const startedAt = Date.parse(starts[0]?.timestamp);
    const completedAt = Date.parse(completions[0]?.timestamp);
    const unblindedAt = Date.parse(unblindings[0]?.timestamp);
    if (![startedAt, completedAt, unblindedAt].every(Number.isFinite)
      || startedAt >= completedAt
      || completedAt > unblindedAt) {
      violations.push(`${runId} baseline boundaries are not strictly ordered`);
    }
    if (Number.isFinite(startedAt)
      && Number.isFinite(completedAt)
      && completedAt - startedAt > 30 * 60 * 1000) {
      violations.push(`${runId} baseline duration exceeds the 30-minute limit`);
    }
    if (usage.length > 1) violations.push(`${runId} has duplicate baseline usage reports`);
    if (usage.length === 1) {
      const reportAt = Date.parse(usage[0].timestamp);
      const intervalStart = Date.parse(usage[0].intervalStart);
      const intervalEnd = Date.parse(usage[0].intervalEnd);
      if (usage[0].totalTokens !== 0
        || ![reportAt, intervalStart, intervalEnd].every(Number.isFinite)
        || intervalStart > startedAt
        || completedAt > intervalEnd
        || intervalEnd > reportAt) {
        violations.push(`${runId} baseline usage is nonzero or does not cover the run`);
      }
    }
    if (outcomes.some((event) => Date.parse(event.timestamp) <= unblindedAt)) {
      violations.push(`${runId} baseline outcome access predates unblinding`);
    }
  }
  return { totalEvents, attributedEvents, violations };
}

function evaluateEvaluatorEvidence(payload, mappings) {
  const violations = [];
  const metricsEvents = payload.events.filter((event) => event.type === "metrics.computed");
  const runSessions = new Set(payload.events
    .filter((event) => event.type === "session.created" || event.type === "run.started")
    .map((event) => event.sessionId));
  const runProcesses = new Set(payload.events
    .filter((event) => event.type === "run.started")
    .map((event) => event.processId));
  if (new Set(metricsEvents.map((event) => event.sessionId)).size !== metricsEvents.length
    || new Set(metricsEvents.map((event) => event.processId)).size !== metricsEvents.length) {
    violations.push("metrics evaluator sessions/processes must be unique per run");
  }
  for (const event of metricsEvents) {
    const evaluatorMappings = mappings.filter((mapping) =>
      mapping.role === "evaluator"
      && mapping.runId === event.runId
      && mapping.sessionId === event.sessionId
      && mapping.processId === event.processId);
    if (evaluatorMappings.length !== 1) {
      violations.push(`metrics.computed ${event.eventId} lacks one signed evaluator session/process mapping`);
    }
    if (runSessions.has(event.sessionId) || runProcesses.has(event.processId)) {
      violations.push(`metrics.computed ${event.eventId} impersonates an authenticated run identity`);
    }
  }
  return violations;
}

export function evaluateStartOrder(payload, blockId) {
  const violations = [];
  const starts = payload.events.filter((event) =>
    event.type === "run.started" && event.blockId === blockId);
  const plannedStarts = schedule.runs.filter((run) => run.blockId === blockId);
  if (starts.length !== 5) violations.push(`block ${blockId} requires exactly five signed run starts`);
  if (new Set(starts.map((event) => event.sessionId)).size !== starts.length
    || new Set(starts.map((event) => event.processId)).size !== starts.length) {
    violations.push(`block ${blockId} run starts require unique session/process boundaries`);
  }
  for (const planned of plannedStarts) {
    const matches = starts.filter((event) => event.runId === planned.runId);
    if (matches.length !== 1) {
      violations.push(`${planned.runId} requires exactly one signed run start`);
      continue;
    }
    const event = matches[0];
    const expectedRole = planned.armId === 0 ? "baseline" : "parent";
    if (event.armId !== planned.armId
      || event.sequence !== planned.order
      || event.role !== expectedRole
      || !event.sessionId
      || !event.processId) {
      violations.push(`run start ${event.eventId} differs from frozen schedule/process boundary`);
    }
  }
  for (const event of starts) {
    const planned = schedule.runs.find((run) => run.runId === event.runId);
    if (!planned
      || event.blockId !== planned.blockId
      || event.armId !== planned.armId
      || event.sequence !== planned.order) {
      violations.push(`run start ${event.eventId} differs from frozen schedule order`);
    }
  }
  for (const currentBlock of new Set(starts.map((event) => event.blockId))) {
    const blockStarts = starts
      .filter((event) => event.blockId === currentBlock)
      .toSorted((left, right) => left.sequence - right.sequence);
    const sequences = new Set();
    const timestamps = new Set();
    for (const [index, event] of blockStarts.entries()) {
      if (sequences.has(event.sequence)) violations.push(`block ${currentBlock} has duplicate run-start sequence`);
      if (timestamps.has(event.timestamp)) violations.push(`block ${currentBlock} has tied run-start timestamps`);
      sequences.add(event.sequence);
      timestamps.add(event.timestamp);
      if (index > 0 && Date.parse(event.timestamp) <= Date.parse(blockStarts[index - 1].timestamp)) {
        violations.push(`block ${currentBlock} run starts are not strictly monotonic`);
      }
    }
  }
  return violations;
}

export function evaluateGlobalAttribution(authenticated) {
  const mappings = authenticatedRunMappings(authenticated.payload);
  const attribution = attributeEvents(
    authenticated.payload,
    mappings,
    GLOBAL_ATTRIBUTION_TYPES
  );
  const baseline = evaluateBaselineEvidence(authenticated.payload, mappings);
  const evaluatorViolations = evaluateEvaluatorEvidence(authenticated.payload, mappings);
  const violations = [
    ...attribution.violations,
    ...baseline.violations,
    ...evaluatorViolations
  ];
  return {
    status: violations.length === 0 ? "compliant" : "noncompliant",
    totalEvents: attribution.totalEvents + baseline.totalEvents,
    attributedEvents: attribution.attributedEvents + baseline.attributedEvents,
    violations
  };
}

export function evaluateNetworkAttribution(authenticated) {
  return attributeEvents(
    authenticated.payload,
    authenticatedRunMappings(authenticated.payload),
    new Set(["network.access"])
  );
}

function expectedWritePath(tool, stagingRoot) {
  if (tool.toolName === "semantic-corpus/write_scenario_input" && tool.scenarioId) {
    return resolve(stagingRoot, "scenarios", `${tool.scenarioId}.json`);
  }
  if (tool.toolName === "semantic-corpus/write_scenario_manifest") {
    return resolve(stagingRoot, "manifest.json");
  }
  return null;
}

function terminalLineIsValid(value) {
  return /^corpus-staging\/manifest\.json - \d+ scenarios - SUCCESS$/.test(value)
    || /^corpus-staging - \d+ scenarios - FAILURE: .+$/.test(value);
}

export function evaluateIsolationEvidence(authenticated, {
  armId,
  runId,
  contractRoot,
  stagingRoot,
  evaluatorRoot,
  snapshotPath
}) {
  const { payload, authentication } = authenticated;
  const arm = armContract.arms.find((item) => item.id === armId);
  const planned = schedule.runs.find((run) => run.runId === runId);
  const contract = resolve(contractRoot);
  const staging = resolve(stagingRoot);
  const evaluator = resolve(evaluatorRoot);
  const snapshot = resolve(snapshotPath);
  const violations = [];
  const globalAttribution = evaluateGlobalAttribution(authenticated);
  violations.push(...globalAttribution.violations.map((violation) => `global: ${violation}`));
  const networkAttribution = evaluateNetworkAttribution(authenticated);
  if (!arm || armId === 0) violations.push(`arm ${armId} is not a measured AI arm`);
  if (!planned || planned.armId !== armId) violations.push("run/arm differs from the frozen schedule");
  if (planned) {
    violations.push(...evaluateStartOrder(payload, planned.blockId)
      .map((violation) => `schedule: ${violation}`));
  }
  if (within(contract, staging) || within(staging, contract)) {
    violations.push("contract and staging roots must be disjoint");
  }
  if (within(contract, snapshot) || within(staging, snapshot)) {
    violations.push("canonical adapter snapshot must be outside MCP roots");
  }

  const runEvents = payload.events.filter((event) => event.runId === runId);
  const requiredRoles = arm ? expectedRoles(arm) : [];
  for (const event of runEvents.filter((item) =>
    item.type === "session.created" || item.type === "model.bound")) {
    if (!requiredRoles.includes(event.role)) {
      violations.push(`signed run evidence contains unexpected role ${event.role ?? "<missing>"}`);
    }
  }
  const roleSessions = {};
  for (const role of requiredRoles) {
    const created = runEvents.filter((event) => event.type === "session.created" && event.role === role);
    const bound = runEvents.filter((event) => event.type === "model.bound" && event.role === role);
    if (created.length !== 1) violations.push(`${role} requires exactly one signed session.created event`);
    if (bound.length !== 1) violations.push(`${role} requires exactly one signed model.bound event`);
    if (created.length !== 1 || bound.length !== 1) continue;
    if (created[0].sessionId !== bound[0].sessionId) {
      violations.push(`${role} session/model events do not identify the same session`);
    }
    if (created[0].armId !== armId || bound[0].armId !== armId) {
      violations.push(`${role} signed role mapping has the wrong arm`);
    }
    if (created[0].blockId !== planned?.blockId || bound[0].blockId !== planned?.blockId) {
      violations.push(`${role} signed role mapping has the wrong block`);
    }
    roleSessions[role] = created[0].sessionId;
  }
  if (arm?.delegated && runEvents.find((event) =>
    event.type === "session.created" && event.role === "worker")?.parentSessionId !== roleSessions.parent) {
    violations.push("worker signed parentSessionId does not match the authenticated parent");
  }
  const sessionRoles = new Map(Object.entries(roleSessions).map(([role, sessionId]) => [sessionId, role]));

  const modelTypes = new Set([
    "sandbox.policy.applied",
    "audit.started",
    "audit.completed",
    "fs.access",
    "network.access",
    "tool.called",
    "tool.result",
    "usage.reported",
    "run.started",
    "delegation.invoked",
    "delegation.completed",
    "run.completed",
    "outcomes.unblinded",
    "outcome.accessed"
  ]);
  const scopedNetworkEvents = payload.events.filter((event) =>
    event.type === "network.access"
    && (event.runId === runId
      || sessionRoles.has(event.sessionId)
      || sessionRoles.has(event.actorSessionId)));
  const scopedOutcomeEvents = payload.events.filter((event) =>
    event.type === "outcome.accessed"
    && (event.runId === runId || sessionRoles.has(event.sessionId)));
  const evidenceEvents = [
    ...runEvents.filter((event) =>
      modelTypes.has(event.type)
      && event.type !== "network.access"
      && event.type !== "outcome.accessed"),
    ...scopedNetworkEvents,
    ...scopedOutcomeEvents
  ];
  for (const event of evidenceEvents) {
    const authenticatedRole = sessionRoles.get(event.sessionId);
    if (!authenticatedRole) {
      violations.push(`event ${event.eventId} uses a session outside the authenticated run roles`);
    } else if (event.role !== undefined && event.role !== authenticatedRole) {
      violations.push(`event ${event.eventId} role does not match its authenticated session`);
    }
    if (event.actor !== undefined && event.actor !== authenticatedRole) {
      violations.push(`event ${event.eventId} actor does not match its authenticated session`);
    }
    if (event.runId !== runId || event.armId !== armId || event.blockId !== planned?.blockId) {
      violations.push(`event ${event.eventId} run mapping differs from the frozen schedule`);
    }
    if (event.type === "network.access") {
      const actorRole = sessionRoles.get(event.actorSessionId);
      if (!actorRole) {
        violations.push(`network access ${event.eventId} actorSessionId is outside the authenticated run roles`);
      }
      if (event.actorSessionId !== event.sessionId || actorRole !== event.role) {
        violations.push(`network access ${event.eventId} actor/session/role identity mismatch`);
      }
    }
  }

  const policyEvents = evidenceEvents.filter((event) => event.type === "sandbox.policy.applied");
  const auditEvents = evidenceEvents.filter((event) => event.type === "audit.completed");
  const auditStartEvents = evidenceEvents.filter((event) => event.type === "audit.started");
  const fileEvents = evidenceEvents.filter((event) => event.type === "fs.access");
  const networkEvents = evidenceEvents.filter((event) => event.type === "network.access");
  const toolEvents = evidenceEvents.filter((event) => event.type === "tool.called");
  const toolResultEvents = evidenceEvents.filter((event) => event.type === "tool.result");
  const usageEvents = evidenceEvents.filter((event) => event.type === "usage.reported");
  const startEvents = evidenceEvents.filter((event) => event.type === "run.started");
  const delegationEvents = evidenceEvents.filter((event) => event.type.startsWith("delegation."));
  const completionEvents = evidenceEvents.filter((event) => event.type === "run.completed");
  const unblindingEvents = evidenceEvents.filter((event) => event.type === "outcomes.unblinded");
  const outcomeEvents = evidenceEvents.filter((event) => event.type === "outcome.accessed");
  const adapterEvents = runEvents.filter((event) => event.type === "adapter.snapshot");
  const allAuthenticatedMappings = authenticatedRunMappings(payload);
  let snapshotDocument = null;

  if (startEvents.length !== 1
    || startEvents[0]?.sessionId !== roleSessions.parent
    || startEvents[0]?.role !== "parent") {
    violations.push("run requires one signed start boundary from the authenticated parent");
  }
  if (completionEvents.length !== 1
    || completionEvents[0]?.sessionId !== roleSessions.parent
    || completionEvents[0]?.role !== "parent") {
    violations.push("run requires one signed completion boundary from the authenticated parent");
  }
  if (unblindingEvents.length !== 1
    || unblindingEvents[0]?.sessionId !== roleSessions.parent
    || unblindingEvents[0]?.role !== "parent") {
    violations.push("run requires one signed unblinding boundary from the authenticated parent");
  }
  const completedAt = Date.parse(completionEvents[0]?.timestamp);
  const startedAt = Date.parse(startEvents[0]?.timestamp);
  const unblindedAt = Date.parse(unblindingEvents[0]?.timestamp);
  if (Number.isFinite(completedAt) && Number.isFinite(unblindedAt) && unblindedAt < completedAt) {
    violations.push("unblinding boundary predates run completion");
  }
  const outcomeBoundary = Math.max(completedAt, unblindedAt);
  for (const event of outcomeEvents) {
    const role = sessionRoles.get(event.sessionId);
    if (!role || event.role !== role) {
      violations.push(`outcome access ${event.eventId} lacks an authenticated session/role`);
    }
    if (!Number.isFinite(outcomeBoundary) || Date.parse(event.timestamp) <= outcomeBoundary) {
      violations.push(`outcome access ${event.eventId} occurred before completion/unblinding`);
    }
  }
  if (Number.isFinite(startedAt) && Number.isFinite(completedAt)) {
    for (const event of [
      ...toolEvents,
      ...toolResultEvents,
      ...fileEvents,
      ...networkEvents,
      ...delegationEvents
    ]) {
      if (Date.parse(event.timestamp) <= startedAt || Date.parse(event.timestamp) >= completedAt) {
        violations.push(`generation event ${event.eventId} is outside the strict run-start/completion boundary`);
      }
    }
  }

  if (adapterEvents.length !== 1) {
    violations.push("run requires exactly one signed evaluator adapter.snapshot event");
  } else {
    const adapter = adapterEvents[0];
    if (adapter.role !== "evaluator"
      || adapter.actor !== "evaluator"
      || allAuthenticatedMappings.some((mapping) =>
        mapping.role !== "evaluator" && mapping.sessionId === adapter.sessionId)) {
      violations.push("adapter snapshot must use an evaluator identity outside model sessions");
    }
    if (adapter.runId !== runId
      || adapter.blockId !== planned?.blockId
      || adapter.armId !== armId) {
      violations.push("adapter snapshot run mapping differs from the frozen schedule");
    }
    if (Date.parse(adapter.timestamp) <= completedAt) {
      violations.push("adapter snapshot did not run after model completion");
    }
    if (!samePath(adapter.sourceStagingRoot ?? "", staging)
      || !samePath(adapter.snapshotPath ?? "", snapshot)
      || adapter.adapterVersion !== 1) {
      violations.push("adapter snapshot paths/version differ from evaluator inputs");
    }
    const snapshotBytes = readFileSync(snapshot);
    const actualSnapshotHash = createHash("sha256").update(snapshotBytes).digest("hex");
    if (adapter.snapshotSha256 !== actualSnapshotHash) {
      violations.push("adapter snapshot hash does not authenticate canonical staging bytes");
    }
    try {
      snapshotDocument = JSON.parse(snapshotBytes);
    } catch {
      violations.push("adapter snapshot is not valid JSON");
    }
  }

  for (const [role, sessionId] of Object.entries(roleSessions)) {
    const creation = runEvents.find((event) =>
      event.type === "session.created" && event.sessionId === sessionId && event.role === role);
    const policies = policyEvents.filter((event) => event.sessionId === sessionId);
    const auditStarts = auditStartEvents.filter((event) => event.sessionId === sessionId);
    const audits = auditEvents.filter((event) => event.sessionId === sessionId);
    if (policies.length !== 1) {
      violations.push(`${role} requires exactly one signed sandbox.policy.applied event`);
      continue;
    }
    const policy = policies[0];
    if (auditStarts.length !== 1) {
      violations.push(`${role} requires exactly one signed audit.started event`);
    } else if (Date.parse(auditStarts[0].timestamp) > Date.parse(policy.timestamp)
      || Date.parse(auditStarts[0].timestamp) > Date.parse(creation?.timestamp)
      || Date.parse(auditStarts[0].timestamp) > startedAt) {
      violations.push(`${role} audit start does not cover policy, session, and run start`);
    }
    if (Date.parse(policy.timestamp) >= Date.parse(creation?.timestamp)
      || Date.parse(policy.timestamp) >= startedAt) {
      violations.push(`${role} sandbox policy was not applied strictly before session/run start`);
    }
    if (!samePath(policy.contractRoot ?? "", contract)) violations.push(`${role} contract root policy mismatch`);
    if (!samePath(policy.stagingRoot ?? "", staging)) violations.push(`${role} staging root policy mismatch`);
    const sandboxConfig = resolve(policy.sandboxConfigPath ?? "");
    if (within(contract, sandboxConfig) || within(staging, sandboxConfig)) {
      violations.push(`${role} sandbox config is not launcher-owned outside MCP roots`);
    }
    if (policy.filesystemMode !== "semantic-corpus-contract-ro-staging-rw") {
      violations.push(`${role} filesystem policy is not the semantic corpus confinement policy`);
    }
    if (policy.networkMode !== "deny") violations.push(`${role} network policy is not deny`);
    if (!(policy.deniedRoots ?? []).some((path) => samePath(path, evaluator))) {
      violations.push(`${role} evaluator root is not explicitly denied`);
    }
    if (audits.length !== 1) {
      violations.push(`${role} requires exactly one signed audit.completed event`);
      continue;
    }
    const audit = audits[0];
    if (audit.filesystemComplete !== true) violations.push(`${role} filesystem audit is incomplete`);
    if (audit.networkComplete !== true) violations.push(`${role} network audit is incomplete`);
    if (Date.parse(audit.timestamp) < Date.parse(policy.timestamp)) {
      violations.push(`${role} audit completion predates policy application`);
    }
    if (Date.parse(audit.timestamp) < completedAt) {
      violations.push(`${role} audit completion does not cover run completion`);
    }
    for (const event of [...fileEvents, ...networkEvents].filter((item) => item.sessionId === sessionId)) {
      if (Date.parse(event.timestamp) < Date.parse(policy.timestamp)
        || Date.parse(event.timestamp) > Date.parse(audit.timestamp)) {
        violations.push(`${role} access ${event.eventId} is outside the authenticated audit window`);
      }
    }
  }

  const seenCallIds = new Set();
  let correlatedWriteCalls = 0;
  const scenarioAttempts = new Set();
  for (const tool of toolEvents) {
    const role = sessionRoles.get(tool.sessionId);
    if (!MCP_TOOLS.has(tool.toolName)) {
      violations.push(`${role ?? "unknown"} used forbidden or normalized tool ${tool.toolName}`);
    }
    if (tool.actor !== role) {
      violations.push(`MCP tool call ${tool.callId ?? "<missing>"} lacks its authenticated actor`);
    }
    if (!tool.callId || seenCallIds.has(tool.callId)) {
      violations.push(`${role ?? "unknown"} MCP tool call requires a unique callId`);
    }
    seenCallIds.add(tool.callId);
    const results = toolResultEvents.filter((event) => event.callId === tool.callId);
    if (results.length !== 1) {
      violations.push(`MCP tool call ${tool.callId ?? "<missing>"} requires exactly one tool.result`);
      continue;
    }
    const result = results[0];
    if (result.sessionId !== tool.sessionId
      || result.actor !== role
      || result.toolName !== tool.toolName) {
      violations.push(`MCP tool call ${tool.callId} does not match its tool.result actor/tool`);
    }
    if (result.resultStatus === "error" && (!result.errorCode || !result.errorMessage)) {
      violations.push(`MCP tool error ${tool.callId} lacks its exact code/message`);
    }
    if (tool.toolName === "semantic-corpus/write_scenario_input") {
      if (!tool.scenarioId) violations.push(`scenario write ${tool.callId} lacks scenarioId`);
      if (scenarioAttempts.has(tool.scenarioId)) {
        violations.push(`scenario ${tool.scenarioId} was retried`);
      }
      scenarioAttempts.add(tool.scenarioId);
    }
    const writePath = expectedWritePath(tool, staging);
    const accesses = fileEvents.filter((event) => event.callId === tool.callId);
    if (result.resultStatus === "success" && writePath) {
      const writes = accesses.filter((event) =>
        event.operation === "write" && samePath(event.path ?? "", writePath));
      if (writes.length !== 1
        || writes[0].sessionId !== tool.sessionId
        || writes[0].actor !== role
        || writes[0].decision !== "allow") {
        violations.push(`successful MCP write ${tool.callId} lacks one caller-owned staging write`);
      } else {
        correlatedWriteCalls += 1;
      }
    }
  }
  for (const result of toolResultEvents) {
    if (!result.callId || !toolEvents.some((tool) => tool.callId === result.callId)) {
      violations.push(`tool.result ${result.eventId} has no corresponding MCP tool call`);
    }
  }
  if (snapshotDocument) {
    const callsById = new Map(toolEvents.map((event) => [event.callId, event]));
    const expectedErrors = toolResultEvents
      .filter((event) => event.resultStatus === "error" && MCP_TOOLS.has(event.toolName))
      .map((event) => {
        const call = callsById.get(event.callId);
        return {
          callId: event.callId,
          toolName: event.toolName,
          argumentsSha256: call?.argumentsSha256,
          ...(call?.scenarioId ? { scenarioId: call.scenarioId } : {}),
          code: event.errorCode,
          message: event.errorMessage
        };
      });
    if (JSON.stringify(snapshotDocument.toolErrors) !== JSON.stringify(expectedErrors)) {
      violations.push("adapter snapshot does not preserve the authenticated MCP tool errors exactly");
    }
    const successfulScenarioWrites = toolEvents.filter((tool) =>
      tool.toolName === "semantic-corpus/write_scenario_input"
      && toolResultEvents.some((result) =>
        result.callId === tool.callId && result.resultStatus === "success"));
    const snapshotCases = new Map((snapshotDocument.cases ?? [])
      .map((scenario) => [scenario.id, scenario]));
    if (snapshotCases.size !== successfulScenarioWrites.length
      || snapshotDocument.adapter?.successfulWrites !== successfulScenarioWrites.length
      || successfulScenarioWrites.some((tool) => !snapshotCases.has(tool.scenarioId))) {
      violations.push("adapter snapshot successful-write count differs from authenticated MCP results");
    }
    const expectedSeed = seeds.blocks.find((block) => block.id === planned?.blockId)?.seed;
    const contractRequest = JSON.parse(readFileSync(resolve(contract, "request.json"), "utf8"));
    if (snapshotDocument.generator?.armId !== armId
      || snapshotDocument.generator?.blockId !== planned?.blockId
      || snapshotDocument.generator?.seed !== expectedSeed
      || snapshotDocument.adapter?.requestHash !== contractRequest.requestHash
      || contractRequest.requestHash !== frozenRequest.requestHash) {
      violations.push("adapter snapshot generator/request metadata differs from frozen evidence");
    }
    for (const scenario of snapshotDocument.cases ?? []) {
      const source = scenario.stagingFile;
      const expectedPath = `corpus-staging/scenarios/${scenario.id}.json`;
      const sourcePath = resolve(staging, "scenarios", `${scenario.id}.json`);
      if (source?.path !== expectedPath || !within(staging, sourcePath)) {
        violations.push(`adapter scenario ${scenario.id ?? "<missing>"} has an invalid source path`);
        continue;
      }
      const sourceBytes = readFileSync(sourcePath);
      const writeCall = successfulScenarioWrites.find((tool) => tool.scenarioId === scenario.id);
      if (source.bytes !== sourceBytes.length
        || source.sha256 !== createHash("sha256").update(sourceBytes).digest("hex")
        || JSON.stringify(scenario.input) !== JSON.stringify(JSON.parse(sourceBytes))
        || writeCall?.argumentsSha256 !== argumentsSha256({
          scenarioId: scenario.id,
          config: scenario.input
        })) {
        violations.push(`adapter scenario ${scenario.id} does not match its exact staged file`);
      }
    }
    const successfulManifestWrites = toolEvents.filter((tool) =>
      tool.toolName === "semantic-corpus/write_scenario_manifest"
      && toolResultEvents.some((result) =>
        result.callId === tool.callId && result.resultStatus === "success"));
    if (successfulManifestWrites.length !== (snapshotDocument.adapter?.manifest ? 1 : 0)
      || successfulManifestWrites.some((tool) =>
        tool.argumentsSha256 !== argumentsSha256({ scenarios: contractRequest.scenarios }))) {
      violations.push("adapter manifest does not match authenticated MCP results/arguments");
    }
  }
  for (const access of fileEvents) {
    const tool = toolEvents.find((event) => event.callId === access.callId);
    if (!tool) {
      violations.push(`fs.access ${access.eventId} has no corresponding MCP tool call`);
      continue;
    }
    const role = sessionRoles.get(tool.sessionId);
    if (access.sessionId !== tool.sessionId || access.actor !== role) {
      violations.push(`fs.access ${access.eventId} is not owned by the actual MCP caller`);
    }
    const path = resolve(access.path ?? "");
    const inContract = within(contract, path);
    const inStaging = within(staging, path);
    if (!inContract && !inStaging) {
      violations.push(`${access.actor ?? "unknown"} attempted filesystem access outside MCP roots`);
    }
    if (inContract && access.operation !== "read") {
      violations.push(`${access.actor ?? "unknown"} attempted to write the immutable contract`);
    }
    if (within(evaluator, path)) violations.push(`${access.actor ?? "unknown"} attempted evaluator access`);
  }
  for (const event of networkEvents) {
    if (event.decision !== undefined && event.allowed !== undefined
      && (event.decision === "allow") !== event.allowed) {
      violations.push(`${event.role ?? "unknown"} network decision fields conflict`);
    }
    const denied = event.decision === "deny" || event.allowed === false;
    if (!denied) violations.push(`${event.role ?? "unknown"} network access was not denied`);
  }

  if (arm) {
    for (const event of toolEvents) {
      const role = sessionRoles.get(event.sessionId);
      const expectedCaller = arm.delegated ? "worker" : "parent";
      if (role !== expectedCaller) {
        violations.push(`${role ?? "unknown"} called semantic-corpus in a ${arm.delegated ? "delegated" : "inline"} arm`);
      }
    }
    if (!arm.delegated && roleSessions.worker) {
      violations.push("inline arm has an authenticated worker role");
    }
  }

  if (arm?.delegated) {
    const invocations = delegationEvents.filter((event) => event.type === "delegation.invoked");
    const completions = delegationEvents.filter((event) => event.type === "delegation.completed");
    if (invocations.length !== 1) violations.push("delegated arm requires one delegation.invoked event");
    if (completions.length !== 1) violations.push("delegated arm requires one delegation.completed event");
    if (invocations.length === 1) {
      const invocation = invocations[0];
      if (invocation.sessionId !== roleSessions.parent
        || invocation.workerSessionId !== roleSessions.worker) {
        violations.push("delegation invocation does not bind the authenticated parent and worker");
      }
      if (invocation.skillName !== armContract.delegationContract.invocation
        || invocation.agentName !== armContract.delegationContract.agentName) {
        violations.push("delegated arm used the wrong semantic-test-corpus identity");
      }
      if (invocation.skillPath !== armContract.delegationContract.registeredPath) {
        violations.push("delegated arm used the wrong registered Skill path");
      }
      if (invocation.skillSha256 !== delegatedSkillSha256) {
        violations.push("delegated arm used a noncanonical Skill artifact");
      }
    }
    if (completions.length === 1) {
      const completion = completions[0];
      if (completion.sessionId !== roleSessions.parent) {
        violations.push("delegation completion was not received by the authenticated parent");
      }
      if (completion.agentName !== armContract.delegationContract.agentName
        || !terminalLineIsValid(completion.returnText)) {
        violations.push("delegated arm returned a noncanonical semantic-test-corpus terminal line");
      }
    }
    if (invocations.length === 1 && completions.length === 1) {
      const invokedAt = Date.parse(invocations[0].timestamp);
      const delegatedAt = Date.parse(completions[0].timestamp);
      if (invocations[0].callId !== completions[0].callId || invokedAt >= delegatedAt) {
        violations.push("delegation invocation/completion lifecycle is not exactly matched");
      }
      for (const event of [...toolEvents, ...toolResultEvents, ...fileEvents]
        .filter((item) => sessionRoles.get(item.sessionId) === "worker")) {
        const timestamp = Date.parse(event.timestamp);
        if (timestamp <= invokedAt || timestamp >= delegatedAt) {
          violations.push(`worker generation event ${event.eventId} is outside delegation lifecycle`);
        }
      }
      if (Number.isFinite(completedAt) && delegatedAt >= completedAt) {
        violations.push("delegation completion does not precede run completion");
      }
    }
  } else if (delegationEvents.length > 0) {
    violations.push("inline arm emitted delegation events");
  }

  const durationMs = Number.isFinite(startedAt) && Number.isFinite(completedAt)
    ? completedAt - startedAt
    : null;
  const totalTokens = usageEvents.reduce((sum, event) => sum + event.totalTokens, 0);
  for (const [role, sessionId] of Object.entries(roleSessions)) {
    const roleUsage = usageEvents.filter((event) =>
      event.sessionId === sessionId && event.role === role);
    if (roleUsage.length !== 1) violations.push(`${role} requires exactly one authenticated usage report`);
    if (roleUsage.length === 1) {
      const reportAt = Date.parse(roleUsage[0].timestamp);
      const intervalStart = Date.parse(roleUsage[0].intervalStart);
      const intervalEnd = Date.parse(roleUsage[0].intervalEnd);
      if (![reportAt, intervalStart, intervalEnd, startedAt, completedAt].every(Number.isFinite)
        || intervalStart > startedAt
        || startedAt >= completedAt
        || completedAt > intervalEnd
        || intervalEnd > reportAt) {
        violations.push(`${role} usage report has invalid timestamps or does not cover the complete run interval`);
      }
    }
  }
  const invocationCount = delegationEvents.filter((event) => event.type === "delegation.invoked").length;
  const toolCallCount = toolEvents.length + invocationCount;
  const budgetMet = durationMs !== null
    && durationMs >= 0
    && durationMs <= 30 * 60 * 1000
    && toolCallCount <= 120
    && totalTokens <= 100000;
  if (!budgetMet) violations.push("authenticated duration/tool/token budget exceeded or unavailable");

  const snapshotSha256 = createHash("sha256").update(readFileSync(snapshot)).digest("hex");
  return {
    exportId: payload.exportId,
    runId,
    armId,
    evidence: authentication,
    contractRoot: contract,
    stagingRoot: staging,
    snapshotPath: snapshot,
    snapshotSha256,
    roleSessions,
    globalAttribution,
    networkAttribution,
    budgets: {
      durationMs,
      toolCalls: toolCallCount,
      totalTokens,
      limits: { durationMs: 1800000, toolCalls: 120, totalTokens: 100000 },
      met: budgetMet
    },
    status: violations.length === 0 ? "compliant" : "noncompliant",
    checks: {
      policyEvents: policyEvents.length,
      auditEvents: auditEvents.length,
      auditStartEvents: auditStartEvents.length,
      mcpToolCalls: toolEvents.length,
      fileAccessEvents: fileEvents.length,
      correlatedWriteCalls,
      networkAccessEvents: networkEvents.length,
      toolCallEvents: toolEvents.length,
      toolResultEvents: toolResultEvents.length,
      adapterEvents: adapterEvents.length,
      usageEvents: usageEvents.length,
      startEvents: startEvents.length,
      delegationEvents: delegationEvents.length,
      completionEvents: completionEvents.length,
      unblindingEvents: unblindingEvents.length,
      outcomeAccessEvents: outcomeEvents.length
    },
    violations
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const required = [
    "--payload", "--signature", "--public-key", "--arm-id", "--run-id",
    "--contract-root", "--staging-root", "--evaluator-root", "--snapshot-path", "--out"
  ];
  if (required.some((name) => !argument(args, name))) {
    throw new Error("Usage: node scripts/verify-isolation-evidence.mjs --payload <export.json> --signature <export.sig> --public-key <platform.pem> --arm-id <1-4> --run-id <run> --contract-root <path> --staging-root <path> --evaluator-root <path> --snapshot-path <path> --out <audit.json>");
  }
  const authenticated = readAuthenticatedExport({
    payloadPath: argument(args, "--payload"),
    signaturePath: argument(args, "--signature"),
    publicKeyPath: argument(args, "--public-key")
  });
  const result = evaluateIsolationEvidence(authenticated, {
    armId: Number(argument(args, "--arm-id")),
    runId: argument(args, "--run-id"),
    contractRoot: argument(args, "--contract-root"),
    stagingRoot: argument(args, "--staging-root"),
    evaluatorRoot: argument(args, "--evaluator-root"),
    snapshotPath: argument(args, "--snapshot-path")
  });
  const target = resolve(argument(args, "--out"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "compliant") process.exitCode = 3;
}
