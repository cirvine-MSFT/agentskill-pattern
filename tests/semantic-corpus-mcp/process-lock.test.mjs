import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { baseRequest, createRun, scenarioInput } from "./fixtures.mjs";

const helper = fileURLToPath(new URL("./lock-helper.mjs", import.meta.url));

function start(run, operation, args) {
  const encoded = Buffer.from(JSON.stringify(args), "utf8").toString("base64url");
  const child = spawn(process.execPath, [helper, operation, encoded], {
    env: run.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const output = [];
  lines.on("line", (line) => output.push(line));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    lines,
    output,
    get stderr() {
      return stderr;
    },
    async waitFor(text) {
      if (output.includes(text)) {
        return;
      }
      while (true) {
        const [line] = await once(lines, "line");
        if (line === text) {
          return;
        }
      }
    },
    async result() {
      if (child.exitCode === null) {
        await once(child, "exit");
      }
      const value = output
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
        .at(-1);
      assert.equal(stderr, "");
      return value;
    },
  };
}

test("two processes cannot race past the exact staging count", async (t) => {
  const run = await createRun(baseRequest({ targetCount: 1 }));
  t.after(() => run.cleanup());
  const args = {
    scenarioId: "scenario-001",
    config: scenarioInput(1),
  };
  const first = start(run, "write", args);
  const second = start(run, "write", args);
  await Promise.all([first.waitFor("READY"), second.waitFor("READY")]);
  first.child.stdin.write("GO\n");
  second.child.stdin.write("GO\n");
  const results = await Promise.all([first.result(), second.result()]);
  assert.equal(results.filter((entry) => entry.ok).length, 1);
  assert.deepEqual(
    results.filter((entry) => !entry.ok).map((entry) => entry.code),
    ["LIMIT_EXCEEDED"],
  );
});

test("manifest initialization and snapshot wait for a cross-process write lock", async (t) => {
  const run = await createRun(baseRequest({ targetCount: 2 }));
  t.after(() => run.cleanup());
  const service = await run.open();
  await service.writeScenarioInput({
    scenarioId: "scenario-001",
    config: scenarioInput(1),
  });

  const manifest = start(run, "manifest", { scenarios: run.request.scenarios });
  const writer = start(run, "delayed-write", {
    scenarioId: "scenario-002",
    config: scenarioInput(2),
  });
  await Promise.all([manifest.waitFor("READY"), writer.waitFor("READY")]);
  writer.child.stdin.write("GO\n");
  await writer.waitFor("LOCKED");
  const owner = JSON.parse(
    await readFile(path.join(run.staging, ".corpus.lock"), "utf8"),
  );
  assert.equal(owner.pid, writer.child.pid);
  assert.equal(typeof owner.hostname, "string");
  assert.match(owner.acquiredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(owner.nonce, /^[a-f0-9]{32}$/);
  manifest.child.stdin.write("GO\n");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(manifest.output.some((line) => line.startsWith("{")), false);
  writer.child.stdin.write("CONTINUE\n");

  const [writeResult, manifestResult] = await Promise.all([
    writer.result(),
    manifest.result(),
  ]);
  assert.equal(writeResult.ok, true);
  assert.equal(manifestResult.ok, true);
  assert.equal(manifestResult.result.scenarioCount, 2);
});
