#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";
import { protocolDesign, protocolDesignForRunId } from "../scripts/protocol-design.mjs";
import { canonicalStagingBytes } from "./adapter.mjs";
import {
  GENERAL_GENERATOR_DEPENDENCIES,
  generateGeneralBaseline
} from "../baseline/general-generate.mjs";
import { buildKillMatrix } from "./mutants/run.mjs";
import { promoteSubmission } from "./promote.mjs";
import { buildReport } from "./report.mjs";

const evaluatorRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(evaluatorRoot, "..");
const schemaRoot = resolve(root, "schemas");
const metricsSchema = JSON.parse(
  readFileSync(resolve(schemaRoot, "metrics-artifact.schema.json"), "utf8")
);
const mappingSpecPath = resolve(root, "fixture", "spec", "mapping-spec.json");
const mappingSpec = JSON.parse(readFileSync(mappingSpecPath, "utf8"));
const currentSourcePin = protocolDesign("v4").sourcePin;
const GENERATOR_FILES = [...GENERAL_GENERATOR_DEPENDENCIES];
const EVALUATOR_FILES = [
  "baseline/general-generate.mjs",
  "baseline/pairwise.mjs",
  "evaluator/adapter.mjs",
  "evaluator/metrics.mjs",
  "evaluator/promote.mjs",
  "evaluator/report.mjs",
  "schemas/coverage-metric.schema.json",
  "schemas/hash-file-set.schema.json",
  "schemas/metrics-artifact.schema.json",
  "schemas/scenario.schema.json",
  "schemas/staging.schema.json",
  "schemas/v1-config.schema.json",
  "validators/json-schema.mjs",
  "validators/staging.mjs"
];
const ORACLE_FILES = ["evaluator/oracle/index.mjs"];
const MUTANT_FILES = [
  "evaluator/mutants/definitions.mjs",
  "evaluator/mutants/run.mjs",
  "evaluator/mutants/validate.mjs",
  "evaluator/mutants/oracle-tuned-reference.json",
  "evaluator/artifacts/baseline-corpus.json",
  "evaluator/tests/golden-cases.json"
];

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileSet(paths) {
  const files = paths.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path)))
  }));
  const aggregate = files.map((entry) => `${entry.path}\0${entry.sha256}\n`).join("");
  return { sha256: sha256(Buffer.from(aggregate, "utf8")), files };
}

function gitValue(args, label) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot bind ${label}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gitBlobHash(bytes, objectFormat) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function generatorProvenance(sourcePin) {
  const commitSha = sourcePin.generatorCommit;
  const treeSha = sourcePin.generatorTree;
  const repositoryRoot = resolve(root, "..", "..");
  const objectFormat = gitValue(["rev-parse", "--show-object-format"], "Git object format");
  if (!["sha1", "sha256"].includes(objectFormat)) {
    throw new Error(`Unsupported Git object format: ${objectFormat}`);
  }
  const files = GENERATOR_FILES.map((path) => {
    const absolutePath = resolve(root, path);
    const repositoryPath = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
    const bytes = readFileSync(absolutePath);
    const blobSha = sourcePin.generatorBlobs[repositoryPath];
    const committedBlob = gitValue(
      ["rev-parse", `${commitSha}:${repositoryPath}`],
      `pinned generator blob ${path}`
    );
    if (committedBlob !== blobSha) {
      throw new Error(`Pinned generator path differs from blob: ${path}`);
    }
    if (gitBlobHash(bytes, objectFormat) !== blobSha) {
      throw new Error(`Baseline generator dependency differs from committed blob: ${path}`);
    }
    return { path, blobSha };
  });
  const committedTree = gitValue(["rev-parse", `${commitSha}^{tree}`], "generator tree");
  if (committedTree !== treeSha) throw new Error("Pinned generator tree differs from commit");
  return { commitSha, treeSha, objectFormat, files };
}

export function canonicalMetricsBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function metricsProvenance(sourcePin = currentSourcePin) {
  return {
    generator: generatorProvenance(sourcePin),
    evaluator: fileSet(EVALUATOR_FILES),
    spec: {
      path: "fixture/spec/mapping-spec.json",
      sha256: sha256(readFileSync(mappingSpecPath))
    },
    oracle: fileSet(ORACLE_FILES),
    mutants: fileSet(MUTANT_FILES)
  };
}

export function deriveMetricsArtifact(snapshotBytes, { runId, blockId, armId }) {
  const snapshotSha256 = sha256(snapshotBytes);
  const snapshot = JSON.parse(snapshotBytes);
  if (!canonicalStagingBytes(snapshot).equals(snapshotBytes)) {
    throw new Error("Snapshot is not canonical staging bytes");
  }
  if (snapshot.generator?.blockId !== blockId || snapshot.generator?.armId !== armId) {
    throw new Error("Snapshot generator metadata differs from the metrics run");
  }
  const { schedule, seeds, sourcePin } = protocolDesignForRunId(runId);
  const planned = schedule.runs.find((run) => run.runId === runId);
  const seed = seeds.blocks.find((block) => block.id === blockId)?.seed;
  if (!planned
    || planned.armId !== armId
    || planned.blockId !== blockId
    || seed === undefined
    || snapshot.generator?.seed !== seed) {
    throw new Error("Metrics run differs from the frozen schedule and seed");
  }
  if (armId === 0) {
    const expected = canonicalStagingBytes(generateGeneralBaseline({ seed, blockId }));
    if (!expected.equals(snapshotBytes)) {
      throw new Error("Baseline snapshot differs from the frozen seeded generator");
    }
  }
  const corpus = promoteSubmission(snapshotBytes, "1970-01-01T00:00:00.000Z");
  const matrix = buildKillMatrix(corpus);
  const report = buildReport(corpus, matrix, mappingSpec);
  const artifact = {
    formatVersion: 1,
    runId,
    blockId,
    armId,
    snapshotSha256,
    provenance: metricsProvenance(sourcePin),
    metrics: {
      promotion: {
        targetCases: report.corpus.targetCases,
        submittedCases: report.corpus.submittedCases,
        promotedCases: report.corpus.promoted,
        invalidCases: report.corpus.invalidCases,
        missingSlots: report.corpus.missingSlots,
        promotionRate: report.corpus.promotionRate
      },
      coverage: {
        rules: report.semanticCoverage.rules,
        paths: report.semanticCoverage.paths,
        invariants: report.semanticCoverage.invariants,
        diagnostics: report.diagnosticCoverage
      },
      mutation: {
        catalogVersion: report.mutation.catalogVersion,
        catalogValidation: report.mutation.catalogValidation,
        catalogSize: report.mutation.total,
        triggered: report.mutation.triggered,
        untriggered: report.mutation.untriggered,
        killed: report.mutation.killed,
        survived: report.mutation.survived,
        killRate: report.mutation.mutationScore
      },
      diversity: {
        exactDuplicateCases: report.redundancyAndDiversity.exactDuplicateCases,
        semanticDuplicateCases: report.redundancyAndDiversity.semanticDuplicateCases,
        semanticUniqueSignatures: report.redundancyAndDiversity.semanticUniqueSignatures,
        meanPairwiseJaccardDistance:
          report.redundancyAndDiversity.meanPairwiseJaccardDistance
      }
    }
  };
  const errors = validateJsonSchema(artifact, metricsSchema, { schemaDir: schemaRoot });
  if (errors.length > 0) {
    throw new Error(`Derived metrics artifact is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  return artifact;
}

export function writeMetricsArtifact({ snapshotPath, runId, blockId, armId, outputPath }) {
  const snapshotBytes = readFileSync(resolve(snapshotPath));
  const artifact = deriveMetricsArtifact(snapshotBytes, { runId, blockId, armId });
  const bytes = canonicalMetricsBytes(artifact);
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx" });
  return {
    artifact,
    bytes,
    metricsPath: target,
    metricsSha256: sha256(bytes),
    snapshotSha256: artifact.snapshotSha256
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const required = ["--snapshot", "--run-id", "--block-id", "--arm-id", "--out"];
  if (required.some((name) => argument(args, name) === undefined)) {
    throw new Error("Usage: node evaluator/metrics.mjs --snapshot <staging.json> --run-id <run> --block-id <block> --arm-id <0-4> --out <metrics.json>");
  }
  const result = writeMetricsArtifact({
    snapshotPath: argument(args, "--snapshot"),
    runId: argument(args, "--run-id"),
    blockId: argument(args, "--block-id"),
    armId: Number(argument(args, "--arm-id")),
    outputPath: argument(args, "--out")
  });
  process.stdout.write(`${JSON.stringify({
    metricsPath: result.metricsPath,
    metricsSha256: result.metricsSha256,
    snapshotSha256: result.snapshotSha256
  })}\n`);
}
