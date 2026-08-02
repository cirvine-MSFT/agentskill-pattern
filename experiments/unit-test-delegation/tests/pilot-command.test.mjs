import assert from "node:assert/strict";
import test from "node:test";
import { parsePilotCommand, runnerArguments } from "../scripts/pilot-command.mjs";

const values = [
  "--cli", "copilot",
  "--session-store", "C:\\private\\session-store.db",
  "--private-root", "C:\\private\\pilot"
];

test("package wrapper preserves exact named preflight options", () => {
  const parsed = parsePilotCommand(["preflight", ...values]);
  assert.deepEqual(parsed, {
    mode: "preflight",
    execute: false,
    cli: "copilot",
    sessionStore: "C:\\private\\session-store.db",
    privateRoot: "C:\\private\\pilot"
  });
  assert.deepEqual(runnerArguments(parsed), values);
  assert.deepEqual(parsePilotCommand(["preflight", "--", ...values]), parsed);
});

test("package wrapper preserves explicit execute only for lifecycle mode", () => {
  const parsed = parsePilotCommand(["execute", ...values, "--execute"]);
  assert.equal(parsed.execute, true);
  assert.deepEqual(runnerArguments(parsed), [...values, "--execute"]);
  assert.throws(() => parsePilotCommand(["execute", ...values]), /explicit --execute/u);
  assert.throws(() => parsePilotCommand(["preflight", ...values, "--execute"]), /forbidden for preflight/u);
});

test("package wrapper fails closed on missing, malformed, unknown, or duplicate arguments", () => {
  assert.throws(() => parsePilotCommand(["preflight", ...values.slice(0, -2)]), /missing required option: --private-root/u);
  assert.throws(() => parsePilotCommand(["preflight", ...values, "--cli"]), /duplicate option: --cli/u);
  assert.throws(() => parsePilotCommand(["preflight", ...values, "--cli", "other"]), /duplicate option: --cli/u);
  assert.throws(() => parsePilotCommand(["preflight", ...values, "--execute", "--execute"]), /duplicate option: --execute/u);
  assert.throws(() => parsePilotCommand(["preflight", "--cli", "--session-store", "db", "--private-root", "root"]), /missing value for --cli/u);
  assert.throws(() => parsePilotCommand(["preflight", "--cli=copilot", ...values.slice(2)]), /unknown or malformed option/u);
  assert.throws(() => parsePilotCommand(["preflight", "copilot", "db", "root"]), /unknown or malformed option/u);
  assert.throws(() => parsePilotCommand(["preflight", "--", "--", ...values]), /unknown or malformed option/u);
  assert.throws(() => parsePilotCommand(["preflight", ...values, "--"]), /unknown or malformed option/u);
  assert.throws(() => parsePilotCommand(["preflight", ...values, "--unknown", "value"]), /unknown or malformed option/u);
});
