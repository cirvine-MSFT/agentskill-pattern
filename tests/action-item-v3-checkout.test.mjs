import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const experimentPath = "experiments/action-item-extraction-v3";

function git(args, cwd = repositoryRoot) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function node(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertFrozenFile(checkoutRoot, record) {
  const bytes = readFileSync(resolve(checkoutRoot, experimentPath, record.path));
  assert.equal(bytes.length, record.bytes, `${record.path} byte length changed`);
  assert.equal(sha256(bytes), record.sha256, `${record.path} hash changed`);
}

test("core.autocrlf=true checkout preserves frozen v3 bytes", async () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "action-v3-checkout-"));
  const checkoutRoot = resolve(temporaryRoot, "checkout");

  try {
    const sourceCommit = git(["rev-parse", "HEAD"]);
    git(["clone", "--quiet", "--no-checkout", "--no-hardlinks", repositoryRoot, checkoutRoot]);
    git(["config", "core.autocrlf", "true"], checkoutRoot);
    git(["checkout", "--quiet", "--detach", sourceCommit], checkoutRoot);
    assert.equal(git(["config", "--get", "core.autocrlf"], checkoutRoot), "true");

    const checkoutExperimentRoot = resolve(checkoutRoot, experimentPath);
    const manifest = JSON.parse(readFileSync(resolve(checkoutExperimentRoot, "design", "fixture-manifest.json"), "utf8"));
    const foundationLock = JSON.parse(readFileSync(resolve(checkoutExperimentRoot, "design", "foundation-lock.json"), "utf8"));
    const lfPaths = [
      ...git(["ls-files", `${experimentPath}/design/*.json`], checkoutRoot).split(/\r?\n/u),
      ...manifest.fixtures.flatMap((fixture) => [
        `${experimentPath}/${fixture.transcriptPath}`,
        `${experimentPath}/${fixture.goldPath}`,
      ]),
    ].filter(Boolean);
    assert.ok(lfPaths.length > 0, "v3 checkout contains no LF-pinned files");
    for (const path of lfPaths) {
      assert.match(git(["check-attr", "eol", "--", path], checkoutRoot), /: eol: lf$/u);
      assert.equal(readFileSync(resolve(checkoutRoot, path)).includes(Buffer.from("\r\n")), false, `${path} contains CRLF`);
    }

    assertFrozenFile(checkoutRoot, manifest.sourceGenerator);
    for (const record of [...foundationLock.designFiles, ...foundationLock.lifecycleAndCandidateFiles]) {
      assertFrozenFile(checkoutRoot, record);
    }

    const sourceModule = await import(pathToFileURL(resolve(checkoutExperimentRoot, manifest.sourceGenerator.path)).href);
    for (const [index, fixture] of manifest.fixtures.entries()) {
      const transcriptBytes = readFileSync(resolve(checkoutExperimentRoot, fixture.transcriptPath));
      const goldBytes = readFileSync(resolve(checkoutExperimentRoot, fixture.goldPath));
      assert.equal(transcriptBytes.length, fixture.transcriptBytes);
      assert.equal(sha256(transcriptBytes), fixture.transcriptSha256);
      assert.equal(goldBytes.length, fixture.goldBytes);
      assert.equal(sha256(goldBytes), fixture.goldSha256);
      assert.equal(transcriptBytes.toString("utf8"), sourceModule.fixtureSources[index].transcript);
      assert.deepEqual(JSON.parse(goldBytes), sourceModule.fixtureSources[index].gold);
    }
    assert.match(node(["scripts/validate-foundation.mjs"], checkoutExperimentRoot), /zero AI starts$/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
