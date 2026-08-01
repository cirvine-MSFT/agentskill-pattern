import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSources } from "../design/fixture-sources.mjs";

export const protocolId = "action-item-extraction-v2";
export const uuidNamespace = "a3f947dc-bfa8-4d93-84a9-837b507c621e";
export const experimentRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const repositoryRoot = resolve(experimentRoot, "..", "..");
export const candidateRoot = resolve(experimentRoot, "candidate");
export const evidenceRoot = resolve(experimentRoot, "results", "excluded-pilot-v2");
export const runtimeRoot = resolve(repositoryRoot, "..", "action-item-extraction-v2-runtime");
export const globalToolFilter = ["task", "view", "edit"];
export const workerFrontmatterTools = ["read", "edit"];
export const sentinelText = '{"sentinel":"ACTION_ITEM_EXTRACTION_V2_REPLACE_ME"}\n';
export const tokenLimit = 40_000;
export const wallTimeLimitMs = 180_000;
export const cliVersion = "1.0.77";
export const acceptedParentWarnings = [
  'Unknown tool name in the tool allowlist: "edit"',
  'Unknown tool name in the tool allowlist: "builtin:edit"',
];
export const runs = fixtureSources.map(({ phase, runId, transcriptId, partition }) => ({
  phase, runId, transcriptId, partition,
}));

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function posixRelative(base, path) {
  return relative(base, path).replaceAll("\\", "/");
}

export function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    });
}

export function transcriptPath(run) {
  return resolve(experimentRoot, "fixtures", run.partition, `${run.transcriptId}.txt`);
}

export function goldPath(run) {
  return resolve(experimentRoot, "evaluator", "gold", `${run.transcriptId}.json`);
}

export function manifestFor(root) {
  const files = filesUnder(root).map((path) => {
    const bytes = readFileSync(path);
    return { path: posixRelative(root, path), bytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    files,
    fileSetSha256: sha256(Buffer.from(files.map((file) =>
      `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""), "utf8")),
  };
}

function uuidBytes(uuid) {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

export function uuidV5(name) {
  const digest = createHash("sha1").update(uuidBytes(uuidNamespace)).update(name, "utf8").digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sessionIdFor(run) {
  return uuidV5(`${protocolId}/${run.runId}/${run.transcriptId}`);
}

export function runCandidateRoot(run) {
  return resolve(runtimeRoot, "candidates", run.runId);
}

export function statusHashFor(run) {
  return sha256(Buffer.from(`${protocolId}\0${run.runId}\0${run.transcriptId}\0status-v2`, "utf8"));
}

export function taskEnvelope(run) {
  const root = runCandidateRoot(run);
  return {
    formatVersion: 2,
    protocolId,
    phase: run.phase,
    arm: "A4",
    runId: run.runId,
    transcriptId: run.transcriptId,
    transcriptPath: resolve(root, "input", "transcript.txt"),
    ledgerPath: resolve(root, "output", "ledger.json"),
    ledgerSentinel: sentinelText,
    statusHash: statusHashFor(run),
    instruction: "Follow the loaded action-ledger-v2 project Skill exactly once. Delegate exactly once to action-ledger-v2-haiku. The parent must not view the transcript or view/edit the ledger. The worker must make exactly one structured runtime view of the whole transcript and exactly one structured runtime edit replacing the exact supplied precreated sentinel with the complete ledger. Do not retry. Return only the worker compact line.",
    schema: {
      schemaVersion: "action-ledger.v2",
      runId: "exact supplied run ID",
      transcriptId: "exact supplied transcript ID",
      items: [{
        itemId: "AI-001 sequentially",
        owner: "canonical person or team",
        action: "normalized action",
        dueDate: "YYYY-MM-DD or null",
        status: "open|conditional|blocked",
        condition: "string or null",
        sourceSpans: [{ startLine: "positive integer", endLine: "positive integer", quote: "verbatim transcript text" }],
        criticality: "critical|normal",
      }],
      ambiguities: [{ sourceLine: "positive integer", note: "grounded omission or qualification reason" }],
    },
    policy: [
      "Include only final explicit commitments with attributable owners.",
      "Apply the last explicit owner, due date, status, and condition.",
      "Omit suggestions, brainstorming, negated work, decisions without assigned action, and fully rescinded work.",
      "Record materially ambiguous apparent commitments in ambiguities without inventing an owner, date, condition, or action.",
      "Source quotes must be verbatim and their line ranges must contain them.",
      "Critical means explicitly launch-, security-, legal-, compliance-, outage-, or customer-blocking.",
    ],
  };
}

export function cliArgs(run) {
  return [
    "-p", canonicalJson(taskEnvelope(run)),
    "--session-id", sessionIdFor(run),
    "--model", "gpt-5.6-sol",
    "--output-format", "json",
    "--log-level", "debug",
    "-C", runCandidateRoot(run),
    "--allow-all-tools",
    "--available-tools=task,view,edit",
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export",
    "--no-auto-update",
    "--experimental",
    "--context", "default",
    "--effort", "medium",
    "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN",
  ];
}

export function parseJsonl(bytes) {
  return bytes.toString("utf8").split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
    try {
      const event = JSON.parse(line);
      invariant(event && typeof event.type === "string", "event type is missing");
      return event;
    } catch (error) {
      throw new Error(`Copilot JSONL line ${index + 1} is invalid: ${error.message}`);
    }
  });
}

export function toolName(event) {
  return event.data?.toolName ?? event.toolName ?? null;
}

export function toolArguments(event) {
  return event.data?.arguments ?? event.arguments ?? {};
}

export function toolPath(event) {
  const args = toolArguments(event);
  return args.path ?? args.filePath ?? args.file_path ?? args.target ?? null;
}

export function normalizeText(value) {
  return String(value ?? "").normalize("NFKD").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function tokenF1(left, right) {
  const stop = new Set(["a", "an", "and", "the", "to", "of", "for", "by", "with", "in", "on"]);
  const tokens = (value) => new Set(normalizeText(value).split(" ").filter((token) => token && !stop.has(token)));
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  const precision = overlap / a.size;
  const recall = overlap / b.size;
  return precision + recall ? 2 * precision * recall / (precision + recall) : 0;
}

export function ledgerSchemaErrors(ledger, run) {
  const errors = [];
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return ["ledger-not-object"];
  if (ledger.schemaVersion !== "action-ledger.v2") errors.push("schema-version");
  if (ledger.runId !== run.runId) errors.push("run-id");
  if (ledger.transcriptId !== run.transcriptId) errors.push("transcript-id");
  if (!Array.isArray(ledger.items)) errors.push("items-not-array");
  if (!Array.isArray(ledger.ambiguities)) errors.push("ambiguities-not-array");
  for (const [index, item] of (ledger.items ?? []).entries()) {
    const key = `item-${index + 1}`;
    if (item?.itemId !== `AI-${String(index + 1).padStart(3, "0")}`) errors.push(`${key}-id`);
    if (typeof item?.owner !== "string" || !item.owner.trim()) errors.push(`${key}-owner`);
    if (typeof item?.action !== "string" || !item.action.trim()) errors.push(`${key}-action`);
    if (!(item?.dueDate === null || /^\d{4}-\d{2}-\d{2}$/u.test(item?.dueDate))) errors.push(`${key}-date`);
    if (!["open", "conditional", "blocked"].includes(item?.status)) errors.push(`${key}-status`);
    if (!(item?.condition === null || typeof item?.condition === "string")) errors.push(`${key}-condition`);
    if (!["critical", "normal"].includes(item?.criticality)) errors.push(`${key}-criticality`);
    if (!Array.isArray(item?.sourceSpans) || !item.sourceSpans.length) errors.push(`${key}-source-spans`);
    for (const span of item?.sourceSpans ?? []) {
      if (!Number.isInteger(span.startLine) || span.startLine < 1) errors.push(`${key}-start-line`);
      if (!Number.isInteger(span.endLine) || span.endLine < span.startLine) errors.push(`${key}-end-line`);
      if (typeof span.quote !== "string" || !span.quote.trim()) errors.push(`${key}-quote`);
    }
  }
  for (const [index, ambiguity] of (ledger.ambiguities ?? []).entries()) {
    if (!ambiguity || typeof ambiguity !== "object" || Array.isArray(ambiguity)) {
      errors.push(`ambiguity-${index + 1}-object`);
      continue;
    }
    if (!Number.isInteger(ambiguity.sourceLine) || ambiguity.sourceLine < 1) errors.push(`ambiguity-${index + 1}-source-line`);
    if (typeof ambiguity.note !== "string" || !ambiguity.note.trim()) errors.push(`ambiguity-${index + 1}-note`);
  }
  return [...new Set(errors)];
}

export function expectedCompactStatus(run, itemCount) {
  return `${run.runId} | ${taskEnvelope(run).ledgerPath} | ${itemCount} | ${statusHashFor(run)}`;
}

export function evidenceManifest() {
  const manifestPath = resolve(evidenceRoot, "manifest.json");
  const files = filesUnder(evidenceRoot).filter((path) => path !== manifestPath).map((path) => {
    const bytes = readFileSync(path);
    return { path: posixRelative(evidenceRoot, path), bytes: bytes.length, sha256: sha256(bytes) };
  });
  return { formatVersion: 2, protocolId, files };
}
