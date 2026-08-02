#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {stableStringify} from "./lib.mjs";

const skillName = "feature-documentation-sonnet-v2";
const agentName = "feature-documentation-sonnet-v2";
const workerModel = "claude-sonnet-4.6";

function normalized(path, caseSensitive) {
  const value = resolve(path);
  return caseSensitive ? value : value.toLowerCase();
}

function validTerminal(event, target) {
  try {
    const value = JSON.parse(event.text);
    if (value.status === "success") {
      return value.target === target
        && value.replaced === true
        && Object.keys(value).sort().join(",") === "replaced,status,target";
    }
    return value.status === "failure"
      && value.target
      && typeof value.reason === "string"
      && value.reason.length > 0
      && Object.keys(value).sort().join(",") === "reason,status,target";
  } catch {
    return false;
  }
}

export function evaluateAdherence(record) {
  if (typeof record.boundary.caseSensitivePaths !== "boolean") {
    throw new Error("caseSensitivePaths must be captured by preflight");
  }
  const violations = new Set();
  const normalize = (path) => normalized(path, record.boundary.caseSensitivePaths);
  const target = normalize(record.boundary.docTarget);
  const reads = new Set(record.boundary.allowedWorkerReads.map(normalize));
  const writes = new Set(record.boundary.allowedWorkerWrites.map(normalize));
  const skillLoads = record.events.filter((event) =>
    event.type === "skill_load" && event.actor === "parent" && event.skill === skillName);
  const invocations = record.events.filter((event) =>
    event.type === "agent_invocation" && event.actor === "parent" && event.agent === agentName);
  const sessions = record.events.filter((event) =>
    event.type === "session_created" && event.actor === "worker");
  const workerTools = record.events.filter((event) =>
    event.type === "tool" && event.actor === "worker");

  if (record.arm === "A1") {
    if (skillLoads.length || invocations.length || sessions.length || workerTools.length) {
      violations.add("A1 used documentation routing or a worker");
    }
  } else {
    if (skillLoads.length !== 1) violations.add("A2 must load the routing Skill exactly once");
    if (invocations.length !== 1) violations.add("A2 must invoke the named agent exactly once");
    if (sessions.length !== 1) violations.add("A2 must create exactly one worker session");
    const skillIndex = record.events.indexOf(skillLoads[0]);
    const invocationIndex = record.events.indexOf(invocations[0]);
    const sessionIndex = record.events.indexOf(sessions[0]);
    if (!(skillIndex >= 0 && skillIndex < invocationIndex && invocationIndex < sessionIndex)) {
      violations.add("Routing events must be ordered Skill then agent then worker session");
    }
    if (sessions.some((event) =>
      event.sessionId !== record.workerSessionId
      || event.requestedModel !== workerModel
      || event.observedModel !== workerModel)) {
      violations.add("Worker session or requested/observed model differs from the frozen assignment");
    }
    if (workerTools.some((event) => !["read", "edit"].includes(event.tool))) {
      violations.add("Worker used a tool outside read/edit");
    }
    if (workerTools.some((event) =>
      event.tool === "read" && (!event.path || !reads.has(normalize(event.path))))) {
      violations.add("Worker read outside the public allowlist");
    }
    if (workerTools.some((event) =>
      event.tool === "edit" && (!event.path || !writes.has(normalize(event.path))))) {
      violations.add("Worker edited outside the target");
    }
    const targetEdits = workerTools.filter((event) =>
      event.tool === "edit" && event.path && normalize(event.path) === target);
    const successfulCompleteEdits = targetEdits.filter((event) =>
      event.success === true && event.operation === "replace" && event.complete === true);
    if (targetEdits.length !== 1 || successfulCompleteEdits.length !== 1) {
      violations.add("Worker must perform one successful complete-target replacement");
    }

    const firstEdit = record.events.findIndex((event) =>
      event.type === "tool" && event.actor === "worker" && event.tool === "edit"
      && event.path && normalize(event.path) === target);
    if (firstEdit >= 0) {
      if (record.events.slice(firstEdit + 1).some((event) =>
        event.type === "tool" && event.actor === "worker" && event.tool === "read"
        && event.path && normalize(event.path) === target)) {
        violations.add("Worker reread the target after replacement");
      }
      if (record.events.slice(firstEdit + 1).some((event) =>
        event.type === "tool" && event.actor === "parent")) {
        violations.add("Parent used a tool after worker editing began");
      }
    }
    if (record.events.some((event) =>
      event.type === "tool" && event.actor === "parent" && event.tool === "edit"
      && event.path && normalize(event.path) === target)) {
      violations.add("Parent edited the delegated target");
    }
    const terminals = record.events.filter((event) =>
      event.type === "terminal" && event.actor === "worker");
    if (terminals.length !== 1 || !validTerminal(terminals[0], record.boundary.docTarget)) {
      violations.add("Worker terminal status does not match the exact JSON schema");
    }
    const terminalIndex = record.events.indexOf(terminals[0]);
    if (firstEdit < 0 || sessionIndex >= firstEdit || terminalIndex <= firstEdit) {
      violations.add("Routing chain must order worker session then target replacement then terminal status");
    }
    if (record.events.some((event) =>
      event.actor === "worker" && ["skill_load", "agent_invocation"].includes(event.type))) {
      violations.add("Worker attempted nested routing");
    }
  }

  return {
    schemaVersion: 2,
    arm: record.arm,
    adherent: violations.size === 0,
    violations: [...violations].sort()
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const inputIndex = process.argv.indexOf("--in");
  const outputIndex = process.argv.indexOf("--out");
  if (inputIndex < 0) {
    throw new Error("Usage: evaluate-adherence.mjs --in <events.json> [--out <result.json>]");
  }
  const output = stableStringify(evaluateAdherence(
    JSON.parse(readFileSync(resolve(process.argv[inputIndex + 1]), "utf8"))
  ));
  if (outputIndex >= 0) writeFileSync(resolve(process.argv[outputIndex + 1]), output);
  else process.stdout.write(output);
}
