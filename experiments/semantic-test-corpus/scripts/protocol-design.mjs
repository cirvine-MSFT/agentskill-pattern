import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(...parts) {
  return JSON.parse(readFileSync(resolve(root, ...parts), "utf8"));
}

function design(version, parts) {
  const prefix = version === "v2"
    ? ["design", "aborted-v2"]
    : version === "v3"
      ? ["design"]
      : ["design", "v4"];
  return read(...prefix, ...parts);
}

export function protocolVersionForRunId(runId) {
  if (/^V4-B/u.test(runId ?? "")) return "v4";
  if (/^V3-B/u.test(runId ?? "")) return "v3";
  if (/^B\d{2}-A/u.test(runId ?? "")) return "v2";
  throw new Error(`Run ID does not identify a frozen protocol version: ${runId ?? "<missing>"}`);
}

export function protocolVersionForId(protocolId) {
  if (protocolId === "semantic-test-corpus-execution-v4") return "v4";
  if (protocolId === "semantic-test-corpus-execution-v3") return "v3";
  if (protocolId === "semantic-test-corpus-execution-v2") return "v2";
  throw new Error(`Unknown protocol ID: ${protocolId ?? "<missing>"}`);
}

export function protocolDesign(version) {
  if (!["v2", "v3", "v4"].includes(version)) {
    throw new Error(`Unknown protocol version: ${version}`);
  }
  return {
    version,
    contract: design(version, ["arm-contract.json"]),
    schedule: design(version, ["schedule.json"]),
    seeds: design(version, ["seeds.json"]),
    sourcePin: design(version, ["source-pin.json"]),
    candidateManifest: design(version, ["candidate-manifest.json"]),
    conditions: design(version, ["condition-instructions.json"])
  };
}

export function protocolDesignForRunId(runId) {
  return protocolDesign(protocolVersionForRunId(runId));
}

export function protocolDesignForId(protocolId) {
  return protocolDesign(protocolVersionForId(protocolId));
}
