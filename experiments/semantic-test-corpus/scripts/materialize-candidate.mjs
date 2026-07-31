#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(root, "..", "..");
const evaluatorRoot = resolve(root, "evaluator");
const testWorkRoot = resolve(root, ".test-work");
const manifest = JSON.parse(readFileSync(resolve(root, "design", "candidate-manifest.json"), "utf8"));
const canonicalRoot = realpathSync.native(root);
const canonicalRepositoryRoot = realpathSync.native(repositoryRoot);
const canonicalEvaluatorRoot = realpathSync.native(evaluatorRoot);

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function runGit(destination, args) {
  const result = spawnSync("git", args, { cwd: destination, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
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
    if (lstatSync(component).isSymbolicLink()) {
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

export function materializeCandidate(destination, { allowTestDestination = false } = {}) {
  const target = resolve(destination);
  rejectReparseComponents(target);
  const canonicalTarget = canonicalProspectivePath(target);
  const testDestination = allowTestDestination
    && within(canonicalProspectivePath(testWorkRoot), canonicalTarget);
  if (within(canonicalRoot, canonicalTarget) && !testDestination) {
    throw new Error("Candidate root must be outside the benchmark repository");
  }
  if (within(canonicalTarget, canonicalRoot)) {
    throw new Error("Candidate root cannot contain the benchmark repository");
  }
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error("Candidate root must be absent or empty");
  mkdirSync(target, { recursive: true });
  rejectReparseComponents(target);
  const materializedReal = realpathSync.native(target);
  if (!testDestination && within(canonicalRoot, materializedReal)) {
    throw new Error("Candidate root resolves inside the benchmark repository");
  }
  if (within(materializedReal, canonicalRoot)) {
    throw new Error("Candidate root resolves around the benchmark repository");
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
    copyFileSync(source, output);
    files.push({ path: entry.destination.replaceAll("\\", "/"), sha256: hash(readFileSync(output)) });
  }

  const boundary = {
    formatVersion: 1,
    manifestVersion: manifest.manifestVersion,
    candidateRoot: materializedReal,
    networkPolicy: "deny",
    filesystemPolicy: "semantic-corpus-launcher-required",
    files
  };
  writeFileSync(resolve(target, ".benchmark-boundary.json"), `${JSON.stringify(boundary, null, 2)}\n`);
  runGit(target, ["init", "--initial-branch", "main", "--quiet"]);
  runGit(target, ["add", "."]);
  runGit(target, [
    "-c", "user.name=Semantic Benchmark Coordinator",
    "-c", "user.email=benchmark.invalid",
    "commit", "--quiet", "-m", "Materialize isolated semantic corpus candidate"
  ]);
  return boundary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--out");
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error("Usage: node scripts/materialize-candidate.mjs --out <external-empty-directory>");
  }
  const boundary = materializeCandidate(process.argv[index + 1]);
  process.stdout.write(`${JSON.stringify(boundary)}\n`);
}
