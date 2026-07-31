import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupStaleLock } from "../../tools/semantic-corpus-mcp/launcher.mjs";
import { createRun } from "./fixtures.mjs";

const helper = fileURLToPath(new URL("./lock-helper.mjs", import.meta.url));
const launcher = fileURLToPath(
  new URL("../../tools/semantic-corpus-mcp/launcher.mjs", import.meta.url),
);

function startHelper(run) {
  const boot = run.bootEnvelope();
  const child = spawn(process.execPath, [helper], {
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdio[3].end(boot.bytes);
  child.stdio[4].end(boot.publicKeyBytes);
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

test("lifetime lease fails closed after abrupt death and only authorized resume cleans it", async (t) => {
  const run = await createRun({ waitTimeoutMs: 100, staleAfterMs: 1000 });
  t.after(() => run.cleanup());

  const holder = startHelper(run);
  assert.equal((await once(holder.lines, "line"))[0], "READY");
  const lockPath = path.join(run.staging, ".corpus.lock");
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(owner.pid, holder.child.pid);
  assert.equal(owner.requestHash, run.requestHash);
  assert.match(owner.nonce, /^[a-f0-9]{32}$/);
  const scenarioDirectory = path.join(run.staging, "scenarios");
  await mkdir(scenarioDirectory);
  const abandonedTemporary = path.join(
    scenarioDirectory,
    `.001-B001.json.${holder.child.pid}.0123456789abcdef.tmp`,
  );
  await writeFile(abandonedTemporary, '{"partial":');

  const boundedContender = startHelper(run);
  boundedContender.child.stdin.end();
  assert.equal((await once(boundedContender.child, "exit"))[0], 2);
  assert.match(boundedContender.stderr, /LOCK_TIMEOUT/);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, owner.nonce);

  holder.child.kill("SIGKILL");
  await once(holder.child, "exit");
  assert.equal((await readdir(run.staging)).includes(".corpus.lock"), true);
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const staleContender = startHelper(run);
  staleContender.child.stdin.end();
  assert.equal((await once(staleContender.child, "exit"))[0], 2);
  assert.match(staleContender.stderr, /LOCK_STALE/);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, owner.nonce);

  const tamperedStatePath = path.join(run.parent, "tampered-state.json");
  const tamperedState = JSON.parse(await readFile(run.statePath, "utf8"));
  tamperedState.requestHash = "0".repeat(64);
  await writeFile(tamperedStatePath, JSON.stringify(tamperedState));
  await copyFile(`${run.statePath}.server-token`, `${tamperedStatePath}.server-token`);
  await assert.rejects(
    () => cleanupStaleLock(tamperedStatePath, run.cleanupToken),
    (error) => error.code === "STATE_AUTHORIZATION_FAILED",
  );
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, owner.nonce);
  await Promise.all([
    rm(tamperedStatePath),
    rm(`${tamperedStatePath}.server-token`),
  ]);

  const recoveryPath = path.join(run.staging, ".corpus.recovery.lock");
  await writeFile(
    recoveryPath,
    `${JSON.stringify({
      version: 1,
      pid: 999_999,
      hostname: os.hostname(),
      acquiredAt: "2000-01-01T00:00:00.000Z",
      nonce: "a".repeat(32),
      requestHash: run.requestHash,
    })}\n`,
  );
  const old = new Date(Date.now() - 120_000);
  await utimes(recoveryPath, old, old);

  const recoveries = await Promise.allSettled([
    cleanupStaleLock(run.statePath, run.cleanupToken),
    cleanupStaleLock(run.statePath, run.cleanupToken),
  ]);
  assert.equal(
    recoveries.some(
      (result) => result.status === "fulfilled" && result.value.status === "removed",
    ),
    true,
  );
  assert.equal((await readdir(run.staging)).includes(".corpus.lock"), false);
  assert.equal((await readdir(run.staging)).includes(".corpus.recovery.lock"), false);
  assert.deepEqual(await readdir(scenarioDirectory), []);

  const resumed = spawn(
    process.execPath,
    [launcher, "resume", "--state", run.statePath],
    {
      env: {
        ...process.env,
        SEMANTIC_CORPUS_CLEANUP_TOKEN: run.cleanupToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let resumedStderr = "";
  resumed.stderr.setEncoding("utf8");
  resumed.stderr.on("data", (chunk) => {
    resumedStderr += chunk;
  });
  const resumedLines = createInterface({ input: resumed.stdout, crlfDelay: Infinity });
  resumed.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })}\n`,
  );
  const response = JSON.parse((await once(resumedLines, "line"))[0]);
  assert.equal(response.result.serverInfo.name, "semantic-corpus");
  const replacement = JSON.parse(await readFile(lockPath, "utf8"));
  assert.notEqual(replacement.nonce, owner.nonce);
  assert.equal(replacement.requestHash, owner.requestHash);
  assert.deepEqual(await readdir(scenarioDirectory), []);

  resumed.stdin.end();
  assert.equal((await once(resumed, "exit"))[0], 0, resumedStderr);
  assert.equal(resumedStderr, "");
  assert.equal((await readdir(run.staging)).includes(".corpus.lock"), false);
});
