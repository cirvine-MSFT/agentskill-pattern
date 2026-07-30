#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuthenticatedExport } from "./authenticated-export.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const armContract = JSON.parse(readFileSync(resolve(root, "design", "arm-contract.json"), "utf8"));
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

export function evaluateIsolationEvidence(authenticated, { armId, candidateRoot, evaluatorRoot, sessionIds }) {
  const { payload, authentication } = authenticated;
  const candidate = resolve(candidateRoot);
  const evaluator = resolve(evaluatorRoot);
  const expectedSessions = new Set(sessionIds);
  const violations = [];
  const policyEvents = [];
  const auditEvents = [];
  const fileEvents = [];
  const networkEvents = [];
  const toolEvents = [];
  const delegationEvents = [];

  for (const event of payload.events) {
    if (!["sandbox.policy.applied", "audit.completed", "fs.access", "network.access", "tool.called", "delegation.invoked", "delegation.completed"].includes(event.type)) continue;
    if (!expectedSessions.has(event.sessionId)) {
      violations.push(`isolation event ${event.eventId} uses unexpected session ${event.sessionId}`);
      continue;
    }
    if (event.type === "sandbox.policy.applied") policyEvents.push(event);
    if (event.type === "audit.completed") auditEvents.push(event);
    if (event.type === "fs.access") fileEvents.push(event);
    if (event.type === "network.access") networkEvents.push(event);
    if (event.type === "tool.called") toolEvents.push(event);
    if (event.type.startsWith("delegation.")) delegationEvents.push(event);
  }

  for (const sessionId of expectedSessions) {
    const policies = policyEvents.filter((event) => event.sessionId === sessionId);
    const audits = auditEvents.filter((event) => event.sessionId === sessionId);
    if (policies.length !== 1) {
      violations.push(`${sessionId} requires exactly one signed sandbox.policy.applied event`);
      continue;
    }
    const policy = policies[0];
    const sessionAccesses = [...fileEvents, ...networkEvents].filter((event) => event.sessionId === sessionId);
    if (!samePath(policy.candidateRoot ?? "", candidate)) violations.push(`${sessionId} candidate root policy mismatch`);
    if (policy.filesystemMode !== "candidate-root-only") violations.push(`${sessionId} filesystem policy is not candidate-root-only`);
    if (policy.networkMode !== "deny") violations.push(`${sessionId} network policy is not deny`);
    if (!(policy.deniedRoots ?? []).some((path) => samePath(path, evaluator))) {
      violations.push(`${sessionId} evaluator root is not explicitly denied`);
    }
    if (audits.length !== 1) {
      violations.push(`${sessionId} requires exactly one signed audit.completed event`);
    } else {
      if (audits[0].filesystemComplete !== true) violations.push(`${sessionId} filesystem audit is incomplete`);
      if (audits[0].networkComplete !== true) violations.push(`${sessionId} network audit is incomplete`);
      if (Date.parse(audits[0].timestamp) < Date.parse(policy.timestamp)) {
        violations.push(`${sessionId} audit completion predates policy application`);
      }
      for (const access of sessionAccesses) {
        if (Date.parse(access.timestamp) < Date.parse(policy.timestamp)) {
          violations.push(`${sessionId} access ${access.eventId} predates policy application`);
        }
        if (Date.parse(access.timestamp) > Date.parse(audits[0].timestamp)) {
          violations.push(`${sessionId} access ${access.eventId} occurs after audit completion`);
        }
      }
    }
  }

  for (const event of fileEvents) {
    const path = resolve(event.path ?? "");
    if (!within(candidate, path)) violations.push(`${event.sessionId} attempted filesystem access outside candidate root`);
    if (within(evaluator, path)) violations.push(`${event.sessionId} attempted evaluator access`);
    if (event.decision !== "allow" && within(candidate, path)) {
      violations.push(`${event.sessionId} candidate-root access was not allowed`);
    }
  }
  for (const event of networkEvents) {
    if (event.decision !== "deny") violations.push(`${event.sessionId} network access was not denied`);
  }

  const permittedTools = new Set(armContract.commonContract.toolSurface);
  for (const event of toolEvents) {
    if (!permittedTools.has(event.toolName)) violations.push(`${event.sessionId} used forbidden tool ${event.toolName}`);
  }

  const arm = armContract.arms.find((item) => item.id === armId);
  if (!arm) {
    violations.push(`arm ${armId} is not declared`);
  } else if (!arm.delegated) {
    if (delegationEvents.length > 0) violations.push(`inline arm ${armId} emitted delegation events`);
  } else {
    const invocations = delegationEvents.filter((event) => event.type === "delegation.invoked");
    const completions = delegationEvents.filter((event) => event.type === "delegation.completed");
    if (invocations.length !== 1) violations.push(`delegated arm ${armId} requires one delegation.invoked event`);
    if (completions.length !== 1) violations.push(`delegated arm ${armId} requires one delegation.completed event`);
    if (invocations.length === 1) {
      const invocation = invocations[0];
      if (invocation.skillName !== armContract.delegationContract.invocation) {
        violations.push(`delegated arm ${armId} used the wrong Skill invocation`);
      }
      if (invocation.skillSha256 !== delegatedSkillSha256) {
        violations.push(`delegated arm ${armId} used a noncanonical Skill artifact`);
      }
      if (!expectedSessions.has(invocation.workerSessionId)) {
        violations.push(`delegated arm ${armId} referenced an unexpected worker session`);
      }
    }
    if (completions.length === 1) {
      const actualFields = [...(completions[0].returnFields ?? [])].sort();
      const expectedFields = [...armContract.delegationContract.returnFields].sort();
      if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields)) {
        violations.push(`delegated arm ${armId} returned a noncanonical field set`);
      }
    }
  }

  return {
    exportId: payload.exportId,
    evidence: authentication,
    candidateRoot: candidate,
    sessionIds: [...expectedSessions].sort(),
    status: violations.length === 0 ? "compliant" : "noncompliant",
    checks: {
      policyEvents: policyEvents.length,
      auditEvents: auditEvents.length,
      fileAccessEvents: fileEvents.length,
      networkAccessEvents: networkEvents.length,
      toolCallEvents: toolEvents.length,
      delegationEvents: delegationEvents.length
    },
    violations
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const required = ["--payload", "--signature", "--public-key", "--arm-id", "--candidate-root", "--evaluator-root", "--session-ids", "--out"];
  if (required.some((name) => !argument(args, name))) {
    throw new Error("Usage: node scripts/verify-isolation-evidence.mjs --payload <export.json> --signature <export.sig> --public-key <platform.pem> --arm-id <1-4> --candidate-root <path> --evaluator-root <path> --session-ids <comma-list> --out <audit.json>");
  }
  const authenticated = readAuthenticatedExport({
    payloadPath: argument(args, "--payload"),
    signaturePath: argument(args, "--signature"),
    publicKeyPath: argument(args, "--public-key")
  });
  const result = evaluateIsolationEvidence(authenticated, {
    armId: Number(argument(args, "--arm-id")),
    candidateRoot: argument(args, "--candidate-root"),
    evaluatorRoot: argument(args, "--evaluator-root"),
    sessionIds: argument(args, "--session-ids").split(",").filter(Boolean)
  });
  const target = resolve(argument(args, "--out"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "compliant") process.exitCode = 3;
}
