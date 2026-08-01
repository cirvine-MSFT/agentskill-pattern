import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const protocolId = "action-item-extraction-v1";
export const experimentRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const repositoryRoot = resolve(experimentRoot, "..", "..");
export const candidateRoot = resolve(experimentRoot, "candidate");
export const evidenceRoot = resolve(experimentRoot, "results", "excluded-pilot");
export const runtimeRoot = resolve(repositoryRoot, "..", "action-item-extraction-runtime-v1");
export const canonicalTools = ["read", "edit"];
export const availableTools = ["skill", "task", ...canonicalTools];
export const tokenLimit = 40_000;
export const wallTimeLimitMs = 180_000;

export const runs = [
  {
    phase: "development-smoke",
    runId: "DEV-ACTION-V1-A4-01",
    transcriptId: "dev-platform-readiness",
    partition: "development",
  },
  {
    phase: "excluded-pilot",
    runId: "PILOT-ACTION-V1-A4-01",
    transcriptId: "pilot-meridian-launch",
    partition: "excluded-pilot",
  },
  {
    phase: "excluded-pilot",
    runId: "PILOT-ACTION-V1-A4-02",
    transcriptId: "pilot-harbor-migration",
    partition: "excluded-pilot",
  },
  {
    phase: "excluded-pilot",
    runId: "PILOT-ACTION-V1-A4-03",
    transcriptId: "pilot-lumen-audit",
    partition: "excluded-pilot",
  },
];

export function assert(condition, message) {
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
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function posixRelative(base, path) {
  return relative(base, path).replaceAll("\\", "/");
}

export function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
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

export function candidateManifest() {
  const files = filesUnder(candidateRoot).map((path) => {
    const bytes = readFileSync(path);
    return {
      path: posixRelative(candidateRoot, path),
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  return {
    files,
    fileSetSha256: sha256(Buffer.from(files.map((file) =>
      `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""), "utf8")),
  };
}

export function sessionIdFor(run) {
  const bytes = createHash("sha256")
    .update(`${protocolId}\0${run.runId}\0${run.transcriptId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function runCandidateRoot(run) {
  return resolve(runtimeRoot, "candidates", run.runId);
}

export function taskEnvelope(run) {
  const root = runCandidateRoot(run);
  return {
    formatVersion: 1,
    protocolId,
    phase: run.phase,
    arm: "A4",
    runId: run.runId,
    transcriptId: run.transcriptId,
    transcriptPath: resolve(root, "input", "transcript.txt"),
    ledgerPath: resolve(root, "output", "ledger.json"),
    instruction: [
      "Invoke the action-item-extraction Skill exactly once and delegate exactly once to",
      "action-item-haiku. The parent must not read the transcript or read/write the ledger.",
      "The worker must read the transcript exactly once and edit the ledger exactly once.",
      "Use the exact action-ledger.v1 schema and extraction policy below. Do not retry.",
      "Return only the worker's compact status.",
    ].join(" "),
    schema: {
      schemaVersion: "action-ledger.v1",
      runId: "exact supplied run ID",
      transcriptId: "exact supplied transcript ID",
      items: [{
        itemId: "AI-001 sequentially",
        owner: "canonical person or team",
        action: "normalized action",
        dueDate: "YYYY-MM-DD or null",
        status: "open|conditional|blocked",
        condition: "string or null",
        sourceSpans: [{ startLine: "positive integer", endLine: "positive integer", quote: "verbatim text" }],
        criticality: "critical|normal",
      }],
      ambiguities: [{ sourceLine: "positive integer", note: "omission or qualification reason" }],
    },
    policy: [
      "Include only a final explicit commitment with an attributable owner.",
      "Apply the last explicit owner, due date, status, and condition.",
      "Omit suggestions, brainstorming, decisions without assigned action, negated work, and fully rescinded items.",
      "Record materially ambiguous apparent commitments in ambiguities; invent no owner, date, condition, or action.",
      "Use null only when an explicit commitment genuinely lacks a due date or condition.",
      "Source quotes must be verbatim and declared line ranges must cover them.",
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
    "-C", runCandidateRoot(run),
    "--allow-all-tools",
    `--available-tools=${availableTools.join(",")}`,
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

export function parseEvents(bytes) {
  return bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      const event = JSON.parse(line);
      assert(typeof event.type === "string", "event type is missing");
      return event;
    } catch (error) {
      throw new Error(`Copilot JSONL line ${index + 1} is invalid: ${error.message}`);
    }
  });
}

export function toolName(event) {
  return event.data?.toolName ?? event.toolName ?? null;
}

export function toolPath(event) {
  const args = event.data?.arguments ?? {};
  return args.path ?? args.filePath ?? args.file_path ?? args.target ?? null;
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function actionTokens(value) {
  const stop = new Set(["a", "an", "and", "the", "to", "of", "for", "by", "with", "in", "on"]);
  return normalizeText(value).split(" ").filter((token) => token && !stop.has(token));
}

export function tokenF1(left, right) {
  const a = new Set(actionTokens(left));
  const b = new Set(actionTokens(right));
  if (a.size === 0 || b.size === 0) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  const precision = overlap / a.size;
  const recall = overlap / b.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function ledgerSchemaErrors(ledger, run) {
  const errors = [];
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return ["ledger-not-object"];
  if (ledger.schemaVersion !== "action-ledger.v1") errors.push("schema-version");
  if (ledger.runId !== run.runId) errors.push("run-id");
  if (ledger.transcriptId !== run.transcriptId) errors.push("transcript-id");
  if (!Array.isArray(ledger.items)) errors.push("items-not-array");
  if (!Array.isArray(ledger.ambiguities)) errors.push("ambiguities-not-array");
  for (const [index, item] of (ledger.items ?? []).entries()) {
    const prefix = `item-${index + 1}`;
    if (item.itemId !== `AI-${String(index + 1).padStart(3, "0")}`) errors.push(`${prefix}-id`);
    if (typeof item.owner !== "string" || !item.owner.trim()) errors.push(`${prefix}-owner`);
    if (typeof item.action !== "string" || !item.action.trim()) errors.push(`${prefix}-action`);
    if (!(item.dueDate === null || /^\d{4}-\d{2}-\d{2}$/u.test(item.dueDate))) errors.push(`${prefix}-date`);
    if (!["open", "conditional", "blocked"].includes(item.status)) errors.push(`${prefix}-status`);
    if (!(item.condition === null || typeof item.condition === "string")) errors.push(`${prefix}-condition`);
    if (!["critical", "normal"].includes(item.criticality)) errors.push(`${prefix}-criticality`);
    if (!Array.isArray(item.sourceSpans) || item.sourceSpans.length === 0) errors.push(`${prefix}-source-spans`);
    for (const span of item.sourceSpans ?? []) {
      if (!Number.isInteger(span.startLine) || span.startLine < 1) errors.push(`${prefix}-start-line`);
      if (!Number.isInteger(span.endLine) || span.endLine < span.startLine) errors.push(`${prefix}-end-line`);
      if (typeof span.quote !== "string" || !span.quote.trim()) errors.push(`${prefix}-quote`);
    }
  }
  for (const [index, ambiguity] of (ledger.ambiguities ?? []).entries()) {
    const prefix = `ambiguity-${index + 1}`;
    if (!ambiguity || typeof ambiguity !== "object" || Array.isArray(ambiguity)) {
      errors.push(`${prefix}-object`);
      continue;
    }
    if (!Number.isInteger(ambiguity.sourceLine) || ambiguity.sourceLine < 1) {
      errors.push(`${prefix}-source-line`);
    }
    if (typeof ambiguity.note !== "string" || !ambiguity.note.trim()) {
      errors.push(`${prefix}-note`);
    }
  }
  return [...new Set(errors)];
}

export function exactStatus(content, run, ledgerPath, itemCount) {
  const expected = `${run.runId} | ${ledgerPath} | ${itemCount} | action-ledger.v1:${run.runId}:${itemCount}`;
  return typeof content === "string" && content.trim() === expected ? expected : null;
}

export function evidenceFileManifest(root) {
  const manifestPath = resolve(root, "manifest.json");
  const files = filesUnder(root)
    .filter((path) => path !== manifestPath)
    .map((path) => {
      const bytes = readFileSync(path);
      return {
        path: posixRelative(root, path),
        bytes: bytes.length,
        sha256: sha256(bytes),
      };
    });
  return {
    formatVersion: 1,
    protocolId,
    generatedFrom: basename(dirname(root)),
    files,
  };
}
