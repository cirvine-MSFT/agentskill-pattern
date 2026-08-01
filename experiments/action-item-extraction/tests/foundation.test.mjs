import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFoundation } from "../scripts/validate-foundation.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("frozen foundation validates", () => {
  assert.deepEqual(validateFoundation(), { fixtures: 4, candidateFiles: 2 });
});

test("candidate worker has only built-in read and edit", () => {
  const agent = readFileSync(resolve(root, "candidate", ".github", "agents", "action-item-haiku.agent.md"), "utf8");
  assert.match(agent, /tools:\s*\["read",\s*"edit"\]/u);
  assert.doesNotMatch(agent, /^tools:.*(?:shell|search|task|skill|mcp)/imu);
});

test("main reservation exposes no inputs or hashes", () => {
  const reservation = JSON.parse(readFileSync(resolve(root, "design", "main-study-reservation.json"), "utf8"));
  assert.equal(reservation.inputsGenerated, false);
  assert.equal(reservation.inputHashesExposed, false);
  assert.equal(reservation.executionAuthorized, false);
});
