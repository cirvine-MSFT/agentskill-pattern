#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = resolve(root, "schemas");
const schema = JSON.parse(readFileSync(resolve(schemaRoot, "execution-preflight.schema.json"), "utf8"));
const capabilityNames = [
  "atomicCreateSession", "localExecution", "promptFile", "parentModel",
  "customAgent", "workerModelOverride", "rawEvents", "usageExport"
];

function commandParts(command) {
  return command.toLowerCase().endsWith(".mjs")
    ? [process.execPath, resolve(command)]
    : [command];
}

function invoke(command, args) {
  const [executable, ...prefix] = commandParts(command);
  return spawnSync(executable, [...prefix, ...args], {
    encoding: "utf8",
    windowsHide: true
  });
}

export function preflightExecution(command, capturedAt = new Date().toISOString()) {
  const versionRun = invoke(command, ["--version"]);
  const capabilityRun = invoke(command, ["benchmark-capabilities", "--json"]);
  let raw = {};
  if (capabilityRun.status === 0) {
    try {
      raw = JSON.parse(capabilityRun.stdout);
    } catch {
      raw = {};
    }
  }
  const capabilities = Object.fromEntries(capabilityNames.map((name) => [
    name,
    raw[name] === true
  ]));
  const arms = Array.from({ length: 6 }, (_, armId) => {
    const required = armId === 0
      ? []
      : [
          "atomicCreateSession", "localExecution", "promptFile", "parentModel",
          "rawEvents", "usageExport",
          ...([2, 4, 5].includes(armId) ? ["customAgent"] : [])
        ];
    const reasons = required
      .filter((name) => !capabilities[name])
      .map((name) => `CLI did not prove ${name}`);
    if (armId === 5 && !capabilities.workerModelOverride) {
      reasons.push("CLI did not prove same-invocation custom-agent worker model override");
    }
    return {
      armId,
      status: reasons.length === 0 ? "available" : "unavailable",
      reasons
    };
  });
  const output = {
    formatVersion: 1,
    protocolId: "semantic-test-corpus-execution-v2",
    capturedAt,
    cli: {
      command,
      version: versionRun.status === 0 ? versionRun.stdout.trim() : null,
      capabilityExitCode: Number.isInteger(capabilityRun.status) ? capabilityRun.status : null
    },
    capabilities,
    arms
  };
  const errors = validateJsonSchema(output, schema, { schemaDir: schemaRoot });
  if (errors.length > 0) {
    throw new Error(`Execution preflight is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliIndex = process.argv.indexOf("--cli");
  const outIndex = process.argv.indexOf("--out");
  if (cliIndex < 0 || !process.argv[cliIndex + 1] || outIndex < 0 || !process.argv[outIndex + 1]) {
    throw new Error("Usage: node scripts/preflight-execution.mjs --cli <copilot-or-adapter> --out <preflight.json>");
  }
  const output = preflightExecution(process.argv[cliIndex + 1]);
  const target = resolve(process.argv[outIndex + 1]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  const unavailable = output.arms.filter((arm) => arm.status === "unavailable");
  process.stdout.write(`${6 - unavailable.length}/6 arms available; arm 5=${output.arms[5].status}\n`);
  if (unavailable.length > 0) process.exitCode = 2;
}
