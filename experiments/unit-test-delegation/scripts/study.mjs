import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { assertNoRun, canonical, evaluate, generateSchedule, materialize, readJson, root, validateCatalog, verifySourceManifest, writeJson } from "./lib.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const command = process.argv[2];
if (command === "verify") {
  const catalog = validateCatalog();
  const expectedSchedule = generateSchedule();
  const schedule = readJson(path.join(root, "design", "schedule.json"));
  assert.equal(canonical(schedule), canonical(expectedSchedule), "schedule drift");
  const temporary = path.join(process.env.TEMP ?? process.env.TMP ?? ".", `utd-verify-${process.pid}-${Date.now()}`);
  try {
    const candidate = materialize({ taskId: "M01", arm: "A2", runId: "verify-only-m01-a2", out: temporary });
    const files = readJson(path.join(candidate.output, ".study", "candidate-manifest.json")).files.map((entry) => entry.path);
    assert(!files.some((file) => /(?:gold|hidden|mutant|schedule|evidence)/iu.test(file)));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const hashes = verifySourceManifest();
  const noRun = assertNoRun();
  process.stdout.write(`${JSON.stringify({ ok: true, catalog, schedule: { pilotPairs: schedule.pilot.length, mainPairs: schedule.main.length }, hashes, noRun })}\n`);
} else if (command === "no-run") {
  process.stdout.write(`${JSON.stringify({ ok: true, ...assertNoRun() })}\n`);
} else if (command === "materialize") {
  const authorization = readJson(path.join(root, "design", "authorization.json"));
  const taskId = argument("task");
  const phase = taskId?.startsWith("P") ? "pilot" : "main";
  if (authorization[phase] !== "authorized") throw new Error(`${phase} execution is not authorized`);
  const result = materialize({ taskId, arm: argument("arm"), runId: argument("run-id"), out: argument("out") });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (command === "evaluate") {
  const output = argument("out");
  const result = evaluate({ workspace: path.resolve(argument("workspace")), taskId: argument("task"), arm: argument("arm"), trace: argument("trace") ? readJson(path.resolve(argument("trace"))) : null });
  if (output) writeJson(path.resolve(output), result);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  throw new Error("usage: study.mjs verify|no-run|materialize|evaluate");
}
