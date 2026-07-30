#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthenticatedExport } from "./authenticated-export.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const armContract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));
const schedule = JSON.parse(readFileSync(resolve(root, "design", "schedule.json"), "utf8"));
const delegatedSkillSha256 = createHash("sha256")
  .update(readFileSync(resolve(root, "design", "delegated-worker-skill.md")))
  .digest("hex");

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

function expectedRoles(arm) {
  return arm.delegated ? ["parent", "worker"] : ["parent"];
}

function authenticatedRunMappings(payload) {
  const mappings = [];
  for (const creation of payload.events.filter((event) => event.type === "session.created")) {
    const planned = schedule.runs.find((run) => run.runId === creation.runId);
    const arm = armContract.arms.find((item) => item.id === creation.armId);
    if (!planned
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

  return mappings;
}

function attributeEvents(payload, mappings, types) {
  const violations = [];
  let attributedEvents = 0;
  const events = payload.events.filter((event) => types.has(event.type));
  for (const event of events) {
    const actorSessionId = event.type === "network.access" ? event.actorSessionId : event.sessionId;
    const actorMappings = mappings.filter((mapping) =>
      mapping.sessionId === actorSessionId);
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
  "tool.called",
  "tool.result",
  "fs.access",
  "network.access",
  "outcome.accessed",
  "delegation.invoked",
  "delegation.completed",
  "run.completed",
  "outcomes.unblinded"
]);

export function evaluateGlobalAttribution(authenticated) {
  return attributeEvents(
    authenticated.payload,
    authenticatedRunMappings(authenticated.payload),
    GLOBAL_ATTRIBUTION_TYPES
  );
}

export function evaluateNetworkAttribution(authenticated) {
  return attributeEvents(
    authenticated.payload,
    authenticatedRunMappings(authenticated.payload),
    new Set(["network.access"])
  );
}

export function evaluateIsolationEvidence(authenticated, {
  armId,
  runId,
  candidateRoot,
  evaluatorRoot,
  stagingPath
}) {
  const { payload, authentication } = authenticated;
  const arm = armContract.arms.find((item) => item.id === armId);
  const planned = schedule.runs.find((run) => run.runId === runId);
  const candidate = resolve(candidateRoot);
  const evaluator = resolve(evaluatorRoot);
  const staging = resolve(stagingPath);
  const violations = [];
  const globalAttribution = evaluateGlobalAttribution(authenticated);
  violations.push(...globalAttribution.violations.map((violation) => `global: ${violation}`));
  const networkAttribution = evaluateNetworkAttribution(authenticated);
  if (!arm || armId === 0) {
    violations.push(`arm ${armId} is not a measured AI arm`);
  }
  if (!planned || planned.armId !== armId) violations.push("run/arm differs from the frozen schedule");
  if (!within(candidate, staging)) violations.push("staging path is outside the candidate root");

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

  const relevantTypes = new Set([
    "sandbox.policy.applied",
    "audit.completed",
    "fs.access",
    "network.access",
    "tool.called",
    "tool.result",
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
      relevantTypes.has(event.type)
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
  const fileEvents = evidenceEvents.filter((event) => event.type === "fs.access");
  const networkEvents = evidenceEvents.filter((event) => event.type === "network.access");
  const toolEvents = evidenceEvents.filter((event) => event.type === "tool.called");
  const toolResultEvents = evidenceEvents.filter((event) => event.type === "tool.result");
  const delegationEvents = evidenceEvents.filter((event) => event.type.startsWith("delegation."));
  const completionEvents = evidenceEvents.filter((event) => event.type === "run.completed");
  const unblindingEvents = evidenceEvents.filter((event) => event.type === "outcomes.unblinded");
  const outcomeEvents = evidenceEvents.filter((event) => event.type === "outcome.accessed");

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
    if (Number.isFinite(completedAt)) {
      for (const event of [
        ...toolEvents,
        ...toolResultEvents,
        ...fileEvents,
        ...networkEvents,
        ...delegationEvents
      ]) {
        if (Date.parse(event.timestamp) >= completedAt) {
          violations.push(`generation event ${event.eventId} did not occur strictly before run completion`);
        }
      }
    }
    if (!Number.isFinite(outcomeBoundary) || Date.parse(event.timestamp) <= outcomeBoundary) {
      violations.push(`outcome access ${event.eventId} occurred before completion/unblinding`);
    }
  }

  for (const [role, sessionId] of Object.entries(roleSessions)) {
    const policies = policyEvents.filter((event) => event.sessionId === sessionId);
    const audits = auditEvents.filter((event) => event.sessionId === sessionId);
    if (policies.length !== 1) {
      violations.push(`${role} requires exactly one signed sandbox.policy.applied event`);
      continue;
    }
    const policy = policies[0];
    if (!samePath(policy.candidateRoot ?? "", candidate)) violations.push(`${role} candidate root policy mismatch`);
    if (policy.filesystemMode !== "candidate-root-only") violations.push(`${role} filesystem policy is not candidate-root-only`);
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
    for (const event of [...fileEvents, ...networkEvents].filter((item) => item.sessionId === sessionId)) {
      if (Date.parse(event.timestamp) < Date.parse(policy.timestamp)
        || Date.parse(event.timestamp) > Date.parse(audit.timestamp)) {
        violations.push(`${role} access ${event.eventId} is outside the authenticated audit window`);
      }
    }
  }

  const fileToolEvents = toolEvents.filter((event) =>
    event.toolName === "file.read" || event.toolName === "file.write");
  const seenCallIds = new Set();
  let correlatedFileCalls = 0;
  for (const tool of fileToolEvents) {
    const role = sessionRoles.get(tool.sessionId);
    if (tool.actor !== role) {
      violations.push(`file tool call ${tool.callId ?? "<missing>"} lacks its authenticated actor`);
    }
    if (!tool.callId || seenCallIds.has(tool.callId)) {
      violations.push(`${role ?? "unknown"} file tool call requires a unique callId`);
    }
    seenCallIds.add(tool.callId);
    if (!tool.path) violations.push(`${role ?? "unknown"} file tool call ${tool.callId ?? "<missing>"} requires a path`);
    const accesses = fileEvents.filter((event) => event.callId === tool.callId);
    if (accesses.length !== 1) {
      violations.push(`${role ?? "unknown"} file tool call ${tool.callId ?? "<missing>"} requires exactly one fs.access event`);
      continue;
    }
    const access = accesses[0];
    const expectedOperation = tool.toolName === "file.write" ? "write" : "read";
    if (access.sessionId !== tool.sessionId
      || access.actor !== role
      || tool.actor !== role
      || access.operation !== expectedOperation
      || !samePath(access.path ?? "", tool.path ?? "")
      || access.decision !== "allow") {
      violations.push(`file tool call ${tool.callId} does not match its fs.access event`);
    } else {
      correlatedFileCalls += 1;
    }
  }
  for (const access of fileEvents) {
    if (!access.callId || !fileToolEvents.some((tool) => tool.callId === access.callId)) {
      violations.push(`fs.access ${access.eventId} has no corresponding file tool call`);
    }
    const path = resolve(access.path ?? "");
    if (!within(candidate, path)) violations.push(`${access.actor ?? "unknown"} attempted filesystem access outside candidate root`);
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
    const workerTools = new Set(armContract.commonContract.toolSurface);
    const parentTools = new Set(arm.delegated
      ? armContract.delegationContract.parentToolSurface
      : armContract.commonContract.toolSurface);
    for (const event of toolEvents) {
      const role = sessionRoles.get(event.sessionId);
      const allowed = role === "worker" ? workerTools : parentTools;
      if (!allowed.has(event.toolName)) violations.push(`${role ?? "unknown"} used forbidden tool ${event.toolName}`);
    }

    const writes = fileToolEvents.filter((event) => event.toolName === "file.write");
    const stagingWrites = writes.filter((event) => samePath(event.path ?? "", staging));
    if (arm.delegated) {
      if (stagingWrites.some((event) => sessionRoles.get(event.sessionId) !== "worker")) {
        violations.push("delegated staging writes must be worker-only");
      }
      if (!stagingWrites.some((event) => sessionRoles.get(event.sessionId) === "worker")) {
        violations.push("delegated worker did not write the staging corpus");
      }
      for (const event of writes.filter((item) => sessionRoles.get(item.sessionId) === "worker")) {
        if (!samePath(event.path ?? "", staging)) violations.push("delegated worker wrote outside the staging file");
      }
      for (const event of fileToolEvents.filter((item) => sessionRoles.get(item.sessionId) === "parent")) {
        if (samePath(event.path ?? "", staging)) {
          violations.push("delegated parent accessed staging corpus contents");
        }
      }
    } else {
      if (roleSessions.worker) violations.push("inline arm has an authenticated worker role");
      if (!stagingWrites.some((event) => sessionRoles.get(event.sessionId) === "parent")) {
        violations.push("inline parent did not write the staging corpus");
      }
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
      if (invocation.skillName !== armContract.delegationContract.invocation) {
        violations.push("delegated arm used the wrong Skill invocation");
      }
      if (invocation.skillSha256 !== delegatedSkillSha256) {
        violations.push("delegated arm used a noncanonical Skill artifact");
      }
    }
    if (completions.length === 1) {
      if (completions[0].sessionId !== roleSessions.parent) {
        violations.push("delegation completion was not received by the authenticated parent");
      }
      const actualFields = [...(completions[0].returnFields ?? [])].sort();
      const expectedFields = [...armContract.delegationContract.returnFields].sort();
      if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields)) {
        violations.push("delegated arm returned a noncanonical field set");
      }
    }
  } else if (delegationEvents.length > 0) {
    violations.push("inline arm emitted delegation events");
  }

  return {
    exportId: payload.exportId,
    runId,
    armId,
    evidence: authentication,
    candidateRoot: candidate,
    stagingPath: staging,
    roleSessions,
    globalAttribution,
    networkAttribution,
    status: violations.length === 0 ? "compliant" : "noncompliant",
    checks: {
      policyEvents: policyEvents.length,
      auditEvents: auditEvents.length,
      fileToolCalls: fileToolEvents.length,
      fileAccessEvents: fileEvents.length,
      correlatedFileCalls,
      networkAccessEvents: networkEvents.length,
      toolCallEvents: toolEvents.length,
      toolResultEvents: toolResultEvents.length,
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
    "--candidate-root", "--evaluator-root", "--staging-path", "--out"
  ];
  if (required.some((name) => !argument(args, name))) {
    throw new Error("Usage: node scripts/verify-isolation-evidence.mjs --payload <export.json> --signature <export.sig> --public-key <platform.pem> --arm-id <1-4> --run-id <run> --candidate-root <path> --evaluator-root <path> --staging-path <path> --out <audit.json>");
  }
  const authenticated = readAuthenticatedExport({
    payloadPath: argument(args, "--payload"),
    signaturePath: argument(args, "--signature"),
    publicKeyPath: argument(args, "--public-key")
  });
  const result = evaluateIsolationEvidence(authenticated, {
    armId: Number(argument(args, "--arm-id")),
    runId: argument(args, "--run-id"),
    candidateRoot: argument(args, "--candidate-root"),
    evaluatorRoot: argument(args, "--evaluator-root"),
    stagingPath: argument(args, "--staging-path")
  });
  const target = resolve(argument(args, "--out"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "compliant") process.exitCode = 3;
}
