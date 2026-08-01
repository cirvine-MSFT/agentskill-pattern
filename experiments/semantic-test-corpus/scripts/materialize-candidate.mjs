#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  legacyTaskBytesForSeed,
  legacyTaskSha256ForSeed,
  taskBytesForSeed,
  taskSha256ForSeed
} from "./execution-contract.mjs";
import { protocolDesign } from "./protocol-design.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(root, "..", "..");
const evaluatorRoot = resolve(root, "evaluator");
const testWorkRoot = resolve(root, ".regression-work");
const canonicalRepositoryRoot = realpathSync.native(repositoryRoot);
const canonicalEvaluatorRoot = realpathSync.native(evaluatorRoot);

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function runGit(destination, args, extra = {}) {
  const result = spawnSync("git", args, {
    cwd: destination,
    encoding: "utf8",
    ...extra
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function pinnedBlob(repositoryPath, sourcePin) {
  const blobId = sourcePin.sourceBlobs[repositoryPath];
  if (!/^[a-f0-9]{40,64}$/u.test(blobId ?? "")) {
    throw new Error(`No immutable source blob is pinned for ${repositoryPath}`);
  }
  const observedBlob = runGit(repositoryRoot, [
    "rev-parse", `${sourcePin.sourceCommit}:${repositoryPath}`
  ]).trim();
  if (observedBlob !== blobId) {
    throw new Error(`Pinned blob differs from source commit path ${repositoryPath}`);
  }
  const result = spawnSync("git", ["cat-file", "blob", blobId], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Cannot read committed candidate source ${repositoryPath}: ${result.stderr}`);
  }
  return { blobId, bytes: result.stdout };
}

function rejectReparseComponents(path) {
  const existing = [];
  let cursor = resolve(path);
  while (true) {
    if (existsSync(cursor)) existing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const component of existing.reverse()) {
    if (lstatSync(component).isSymbolicLink()
      || !samePath(realpathSync.native(component), component)) {
      throw new Error(`Path contains a symbolic link, junction, or reparse component: ${component}`);
    }
  }
}

function canonicalProspectivePath(path) {
  const target = resolve(path);
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`No existing ancestor for ${target}`);
    ancestor = parent;
  }
  return resolve(realpathSync.native(ancestor), relative(ancestor, target));
}

export function materializeCandidate(destination, {
  allowTestDestination = false,
  blockId,
  abortedV2 = false,
  protocolVersion = "v5"
} = {}) {
  const version = abortedV2 ? "v2" : protocolVersion;
  const { candidateManifest: manifest, sourcePin, seeds } = protocolDesign(version);
  const legacyTask = !["v4", "v5"].includes(version);
  const block = seeds.blocks.find((item) => item.id === blockId);
  if (!block) throw new Error("A frozen block ID from design/seeds.json is required");
  const observedTree = runGit(repositoryRoot, [
    "rev-parse", `${sourcePin.sourceCommit}^{tree}`
  ]).trim();
  if (observedTree !== sourcePin.sourceTree) {
    throw new Error("Pinned source tree differs from the immutable source commit");
  }
  const target = resolve(destination);
  rejectReparseComponents(target);
  const canonicalTarget = canonicalProspectivePath(target);
  const testDestination = allowTestDestination
    && within(canonicalProspectivePath(testWorkRoot), canonicalTarget);
  if (within(canonicalRepositoryRoot, canonicalTarget) && !testDestination) {
    throw new Error("Candidate root must be outside the source repository");
  }
  if (within(canonicalTarget, canonicalRepositoryRoot)) {
    throw new Error("Candidate root cannot contain the source repository");
  }
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error("Candidate root must be absent or empty");
  mkdirSync(target, { recursive: true });
  rejectReparseComponents(target);
  const materializedReal = realpathSync.native(target);
  if (!testDestination && within(canonicalRepositoryRoot, materializedReal)) {
    throw new Error("Candidate root resolves inside the source repository");
  }
  if (within(materializedReal, canonicalRepositoryRoot)) {
    throw new Error("Candidate root resolves around the source repository");
  }

  const files = [];
  for (const entry of manifest.files) {
    const normalizedSource = entry.source.replaceAll("\\", "/");
    if (manifest.forbiddenSourcePrefixes.some((prefix) => normalizedSource.startsWith(prefix))) {
      throw new Error(`Manifest exposes forbidden evaluator source: ${entry.source}`);
    }
    const source = resolve(root, entry.source);
    rejectReparseComponents(source);
    const canonicalSource = realpathSync.native(source);
    if (!within(canonicalRepositoryRoot, canonicalSource) || within(canonicalEvaluatorRoot, canonicalSource)) {
      throw new Error(`Manifest source crosses evaluator boundary: ${entry.source}`);
    }
    const output = resolve(target, entry.destination);
    if (!within(target, output)) throw new Error(`Manifest destination escapes candidate root: ${entry.destination}`);
    mkdirSync(dirname(output), { recursive: true });
    rejectReparseComponents(dirname(output));
    const repositoryPath = relative(repositoryRoot, canonicalSource).replaceAll("\\", "/");
    const pinned = pinnedBlob(repositoryPath, sourcePin);
    const bytes = entry.transform === "append-block-seed"
      ? (legacyTask ? legacyTaskBytesForSeed(block.seed) : taskBytesForSeed(block.seed))
      : pinned.bytes;
    if (entry.transform && entry.transform !== "append-block-seed") {
      throw new Error(`Unsupported candidate transform: ${entry.transform}`);
    }
    writeFileSync(output, bytes);
    files.push({
      path: entry.destination.replaceAll("\\", "/"),
      sha256: hash(bytes),
      sourcePath: repositoryPath,
      sourceBlob: pinned.blobId,
      transform: entry.transform ?? null
    });
  }

  const boundary = {
    formatVersion: 3,
    protocolId: sourcePin.protocolId,
    manifestVersion: manifest.manifestVersion,
    sourceCommit: sourcePin.sourceCommit,
    sourceTree: sourcePin.sourceTree,
    blockId: block.id,
    seed: block.seed,
    taskSha256: legacyTask
      ? legacyTaskSha256ForSeed(block.seed)
      : taskSha256ForSeed(block.seed),
    candidateRoot: ".",
    networkPolicy: "deny",
    filesystemPolicy: "semantic-corpus-launcher-required",
    files
  };
  const boundaryBytes = Buffer.from(`${JSON.stringify(boundary, null, 2)}\n`, "utf8");
  writeFileSync(resolve(target, ".benchmark-boundary.json"), boundaryBytes);
  runGit(target, ["init", "--initial-branch", "main", "--quiet"]);
  runGit(target, ["add", "."]);
  runGit(target, [
    "-c", "user.name=Semantic Benchmark Coordinator",
    "-c", "user.email=benchmark.invalid",
    "commit", "--quiet", "-m", "Materialize isolated semantic corpus candidate"
  ], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
    }
  });
  return {
    ...boundary,
    materializedRoot: materializedReal,
    boundarySha256: hash(boundaryBytes),
    terminalCommit: runGit(target, ["rev-parse", "refs/heads/main"]).trim()
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--out");
  const blockIndex = process.argv.indexOf("--block");
  if (index < 0 || !process.argv[index + 1] || blockIndex < 0 || !process.argv[blockIndex + 1]) {
    throw new Error("Usage: node scripts/materialize-candidate.mjs --block <B01..B12> --out <external-empty-directory>");
  }
  const boundary = materializeCandidate(process.argv[index + 1], {
    blockId: process.argv[blockIndex + 1]
  });
  process.stdout.write(`${JSON.stringify(boundary)}\n`);
}
