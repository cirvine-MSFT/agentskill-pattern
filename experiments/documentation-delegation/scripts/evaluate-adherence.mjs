#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {stableStringify} from "./lib.mjs";

function normalized(path, caseSensitive) {
  const resolved = resolve(path);
  return caseSensitive ? resolved : resolved.toLowerCase();
}

export function evaluateAdherence(record) {
  const violations = new Set();
  if (typeof record.boundary.caseSensitivePaths !== "boolean") {
    throw new Error("boundary.caseSensitivePaths must be captured by the execution preflight");
  }
  const normalize = (path) => normalized(path, record.boundary.caseSensitivePaths);
  const target = normalize(record.boundary.docTarget);
  const allowedReads = new Set(record.boundary.allowedWorkerReads.map(normalize));
  const allowedWrites = new Set(record.boundary.allowedWorkerWrites.map(normalize));
  const invocations = record.events.filter((event) =>
    event.type === "agent_invocation" && event.agent === "feature-documentation-haiku");
  const workerSessions = record.events.filter((event) => event.type === "session_created" && event.actor === "worker");
  const workerTools = record.events.filter((event) => event.type === "tool" && event.actor === "worker");
  const parentTargetTools = record.events.filter((event) =>
    event.type === "tool" && event.actor === "parent" && event.path && normalize(event.path) === target);

  if (record.arm === "A1") {
    if (invocations.length !== 0 || workerSessions.length !== 0 || workerTools.length !== 0) {
      violations.add("A1 created or invoked a documentation worker");
    }
  } else {
    if (invocations.length !== 1) violations.add("A2 must invoke the fixed documentation worker exactly once");
    if (workerSessions.length !== 1) violations.add("A2 must create exactly one worker session");
    if (workerSessions.some((event) =>
      event.sessionId !== record.workerSessionId || event.model !== "claude-haiku-4.5")) {
      violations.add("Worker session ID or model differs from the frozen assignment");
    }
    if (workerTools.some((event) => !["read", "edit"].includes(event.tool))) {
      violations.add("Worker used a tool outside read/edit");
    }
    if (workerTools.some((event) =>
      event.tool === "read" && (!event.path || !allowedReads.has(normalize(event.path))))) {
      violations.add("Worker read outside the allowlist");
    }
    if (workerTools.some((event) =>
      event.tool === "edit" && (!event.path || !allowedWrites.has(normalize(event.path))))) {
      violations.add("Worker edited outside the documentation target");
    }
    const successfulEdits = workerTools.filter((event) =>
      event.tool === "edit" && event.success === true && event.path && normalize(event.path) === target);
    if (successfulEdits.length === 0) violations.add("Worker made no successful target edit");

    const firstWorkerEditIndex = record.events.findIndex((event) =>
      event.type === "tool" && event.actor === "worker" && event.tool === "edit"
      && event.path && normalize(event.path) === target);
    if (parentTargetTools.some((event) => event.tool === "edit")) {
      violations.add("Parent edited the delegated target");
    }
    if (firstWorkerEditIndex >= 0 && record.events.slice(firstWorkerEditIndex + 1).some((event) =>
      event.type === "tool" && event.actor === "parent" && event.path
      && normalize(event.path) === target && ["read", "edit"].includes(event.tool))) {
      violations.add("Parent read or edited the target after worker editing began");
    }
    const terminal = record.events.filter((event) => event.type === "terminal" && event.actor === "worker");
    const escapedTarget = record.boundary.docTarget.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (terminal.length !== 1
      || !new RegExp(`^${escapedTarget} - (?:SUCCESS|FAILURE: .+)$`, "u").test(terminal[0].text ?? "")) {
      violations.add("Worker terminal status is absent or non-compact");
    }
    if (record.events.some((event) =>
      event.actor === "worker" && ["agent_invocation", "skill_invocation"].includes(event.type))) {
      violations.add("Worker attempted nested delegation");
    }
  }

  return {
    schemaVersion: 1,
    arm: record.arm,
    adherent: violations.size === 0,
    violations: [...violations].sort()
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const inputIndex = process.argv.indexOf("--in");
  const outputIndex = process.argv.indexOf("--out");
  if (inputIndex < 0 || !process.argv[inputIndex + 1]) {
    throw new Error("Usage: evaluate-adherence.mjs --in <events.json> [--out <result.json>]");
  }
  const record = JSON.parse(readFileSync(resolve(process.argv[inputIndex + 1]), "utf8"));
  const output = stableStringify(evaluateAdherence(record));
  if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
    writeFileSync(resolve(process.argv[outputIndex + 1]), output);
  } else {
    process.stdout.write(output);
  }
}
