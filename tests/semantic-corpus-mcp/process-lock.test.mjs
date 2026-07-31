import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createRun } from "./fixtures.mjs";

const helper = fileURLToPath(new URL("./lock-helper.mjs", import.meta.url));

function start(run) {
  const child = spawn(process.execPath, [helper], {
    env: run.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    lines,
    get stderr() {
      return stderr;
    },
  };
}

test("one process retains the staging lease for its full MCP lifetime", async (t) => {
  const run = await createRun();
  t.after(() => run.cleanup());
  const holder = start(run);
  const [ready] = await once(holder.lines, "line");
  assert.equal(ready, "READY");

  const lockPath = path.join(run.staging, ".corpus.lock");
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(owner.pid, holder.child.pid);
  assert.equal(owner.requestHash, run.requestHash);
  assert.equal(typeof owner.hostname, "string");
  assert.match(owner.acquiredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(owner.nonce, /^[a-f0-9]{32}$/);

  const contender = start(run);
  contender.child.stdin.end();
  const [contenderCode] = await once(contender.child, "exit");
  assert.equal(contenderCode, 2);
  assert.match(contender.stderr, /LOCK_TIMEOUT/);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, owner.nonce);

  holder.child.stdin.end();
  const [holderCode] = await once(holder.child, "exit");
  assert.equal(holderCode, 0, holder.stderr);
  assert.equal((await readdir(run.staging)).includes(".corpus.lock"), false);
});
