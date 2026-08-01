import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isMachinePrivatePath,
  pathsOverlap,
  regenerateDescriptiveResults,
  verifyEvidencePackage
} from "../../scripts/package-v5-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const evidenceRoot = resolve(root, "results", "v5-b01");

test("protocol-v5 package is complete, source-bound, sanitized, and deterministic", () => {
  const first = verifyEvidencePackage(evidenceRoot);
  const second = verifyEvidencePackage(evidenceRoot);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    files: 84,
    sourceFiles: 9117,
    runs: 72,
    measuredFailures: 39,
    completeBlocks: 12
  });

  const firstResult = JSON.stringify(regenerateDescriptiveResults(evidenceRoot));
  const secondResult = JSON.stringify(regenerateDescriptiveResults(evidenceRoot));
  assert.equal(firstResult, secondResult);
});

test("immutable source and output paths cannot overlap", () => {
  const source = resolve(root, "path-fixtures", "evidence");
  assert.equal(pathsOverlap(source, source), true);
  assert.equal(pathsOverlap(source, resolve(source, "package")), true);
  assert.equal(pathsOverlap(resolve(source, "source"), source), true);
  assert.equal(
    pathsOverlap(
      resolve(root, "path-fixtures", "evidence-a"),
      resolve(root, "path-fixtures", "evidence-b")
    ),
    false
  );
});

test("immutable source aliases through symlinks or junctions cannot overlap", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "semantic-evidence-paths-"));
  try {
    const source = resolve(temporary, "source");
    const alias = resolve(temporary, "alias");
    mkdirSync(source);
    symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(pathsOverlap(source, alias), true);
    assert.equal(pathsOverlap(source, resolve(alias, "package")), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("private path detection covers Windows, UNC, and POSIX paths", () => {
  for (const path of [
    "C:\\Users\\casey\\evidence.json",
    "C:/build/evidence.json",
    "\\\\server\\share\\evidence.json",
    "/mnt/evidence/run.json",
    "/tmp/evidence.json",
    "/workspace/evidence.json"
  ]) {
    assert.equal(isMachinePrivatePath(path), true, path);
  }
  assert.equal(isMachinePrivatePath("artifacts/V5-B01-A1/metrics.json"), false);
  assert.equal(isMachinePrivatePath("https://example.test/evidence"), false);
});

test("all measured starts, failures, attempts, usage, and deterministic units are retained", () => {
  const bundles = readdirSync(resolve(evidenceRoot, "raw", "runs"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(
      resolve(evidenceRoot, "raw", "runs", name),
      "utf8"
    )));
  assert.equal(bundles.length, 72);
  assert.equal(bundles.filter((run) =>
    run.disposition.status === "measured-failure").length, 39);
  assert.equal(bundles.filter((run) =>
    run.armId !== 0
    && run.attempt.attemptNumber === 1
    && run.attempt.attemptId === `${run.runId}-attempt-1`
    && run.deviations.retryCount === 0).length, 60);
  assert.equal(bundles.filter((run) =>
    run.armId !== 0
    && run.usage.total.completionCount > 0
    && run.operationalUsage.total.completionCount > 0).length, 60);
  assert.equal(bundles.filter((run) =>
    run.armId === 0
    && run.deterministic.execution
    && run.deterministic.lifecycleEnd).length, 12);
});

test("package contains no raw events, worktrees, prompts, opaque fields, or private paths", () => {
  const manifest = JSON.parse(readFileSync(resolve(evidenceRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.privacy.committedRawEvents, false);
  assert.equal(manifest.privacy.committedCandidateWorktrees, false);
  assert.equal(manifest.privacy.committedStagingPayloads, false);
  assert.equal(manifest.privacy.committedPrompts, false);
  assert.equal(manifest.privacy.committedOpaquePayloads, false);
  assert(!manifest.files.some((file) =>
    file.path.endsWith(".jsonl")
    || file.path.startsWith("candidates/")
    || file.path.endsWith("/staging.json")
    || file.path.endsWith("/kickoff.txt")));

  for (const file of manifest.files) {
    const text = readFileSync(resolve(evidenceRoot, file.path), "utf8");
    assert(!/[A-Za-z]:\\\\(?:Users|code)\\/u.test(text), file.path);
    assert(!/\.copilot[\\/]+session-state/u.test(text), file.path);
    if (file.path.endsWith(".json")) {
      assert(!/"(?:prompt|content|encrypted_content|reasoning_content|authorization|access_token|refresh_token|sandbox_token|api_key|password|secret|token_details_json)"\s*:/iu
        .test(text), file.path);
    }
  }
});
