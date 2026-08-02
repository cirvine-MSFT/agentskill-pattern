#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const modes = new Set(["preflight", "execute"]);
const valueOptions = new Map([
  ["--cli", "cli"],
  ["--session-store", "sessionStore"],
  ["--private-root", "privateRoot"]
]);
const usage = "usage: pilot-command.mjs preflight|execute --cli <copilot> --session-store <session-store.db> --private-root <absent-external-root> [--execute]";

export function parsePilotCommand(args) {
  assert(Array.isArray(args), usage);
  const [mode, ...forwarded] = args;
  assert(modes.has(mode), usage);
  const options = forwarded[0] === "--" ? forwarded.slice(1) : forwarded;
  const parsed = { mode, execute: false };

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--execute") {
      assert.equal(parsed.execute, false, "duplicate option: --execute");
      parsed.execute = true;
      continue;
    }
    const property = valueOptions.get(option);
    assert(property, `unknown or malformed option: ${option ?? "<missing>"}`);
    assert.equal(parsed[property], undefined, `duplicate option: ${option}`);
    const value = options[index + 1];
    assert(value && !value.startsWith("--"), `missing value for ${option}`);
    parsed[property] = value;
    index += 1;
  }

  for (const [option, property] of valueOptions) {
    assert(parsed[property], `missing required option: ${option}`);
  }
  if (mode === "execute") {
    assert.equal(parsed.execute, true, "pilot lifecycle requires explicit --execute");
  } else {
    assert.equal(parsed.execute, false, "--execute is forbidden for preflight");
  }
  return parsed;
}

export function runnerArguments(parsed) {
  return [
    "--cli", parsed.cli,
    "--session-store", parsed.sessionStore,
    "--private-root", parsed.privateRoot,
    ...(parsed.execute ? ["--execute"] : [])
  ];
}

function main(args) {
  const parsed = parsePilotCommand(args);
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "pilot-runner.mjs");
  const result = spawnSync(process.execPath, [runner, ...runnerArguments(parsed)], {
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, "pilot runner terminated without an exit status");
  process.exitCode = result.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
