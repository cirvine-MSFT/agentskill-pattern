import { createHash, timingSafeEqual } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

const CONFIG_LIMIT = 64 * 1024;
const ID_PATTERN = /^(?:DEV|PILOT|MAIN)-[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SANDBOX_KINDS = new Set(["container", "restricted-acl", "closed-tool-surface"]);

export class ReleaseNoteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseNoteError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseNoteError(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function exactObject(value, keys, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail("SCHEMA_ERROR", `${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("SCHEMA_ERROR", `${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function boundedString(value, label, minimum, maximum, pattern = null) {
  if (typeof value !== "string") fail("SCHEMA_ERROR", `${label} must be a string`);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimum || bytes > maximum) {
    fail("LIMIT_EXCEEDED", `${label} must be ${minimum}-${maximum} UTF-8 bytes`);
  }
  if (pattern && !pattern.test(value)) fail("SCHEMA_ERROR", `${label} is invalid`);
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("SCHEMA_ERROR", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
}

async function requirePlainFile(target, label) {
  const info = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") fail("NOT_FOUND", `${label} does not exist`);
    throw error;
  });
  if (info.isSymbolicLink() || !info.isFile()) {
    fail("PATH_INVALID", `${label} must be a regular non-symlink file`);
  }
  if (path.resolve(await realpath(target)) !== path.resolve(target)) {
    fail("PATH_INVALID", `${label} must resolve to itself`);
  }
  return info;
}

async function requirePlainDirectory(target, label) {
  const info = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") fail("NOT_FOUND", `${label} does not exist`);
    throw error;
  });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("PATH_INVALID", `${label} must be a regular non-symlink directory`);
  }
  if (path.resolve(await realpath(target)) !== path.resolve(target)) {
    fail("PATH_INVALID", `${label} must resolve to itself`);
  }
}

function absolutePath(value, label) {
  boundedString(value, label, 3, 1024);
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    fail("PATH_INVALID", `${label} must be a normalized absolute path`);
  }
  return value;
}

function validateConfig(config) {
  exactObject(
    config,
    [
      "version",
      "runId",
      "arm",
      "taskEnvelopeSha256",
      "sandboxKind",
      "sandboxTokenHash",
      "dossier",
      "output",
      "audit",
      "limits",
    ],
    "config",
  );
  if (config.version !== 1) fail("SCHEMA_ERROR", "config.version must be 1");
  boundedString(config.runId, "config.runId", 5, 80, ID_PATTERN);
  if (!["A1", "A2", "A3", "A4"].includes(config.arm)) {
    fail("SCHEMA_ERROR", "config.arm must be A1, A2, A3, or A4");
  }
  boundedString(config.taskEnvelopeSha256, "config.taskEnvelopeSha256", 64, 64, HASH_PATTERN);
  if (!SANDBOX_KINDS.has(config.sandboxKind)) {
    fail("SCHEMA_ERROR", "config.sandboxKind is unsupported");
  }
  boundedString(
    config.sandboxTokenHash,
    "config.sandboxTokenHash",
    71,
    71,
    /^sha256:[a-f0-9]{64}$/u,
  );
  exactObject(config.dossier, ["path", "sha256"], "config.dossier");
  exactObject(config.output, ["path", "relativePath"], "config.output");
  exactObject(config.audit, ["path"], "config.audit");
  exactObject(config.limits, ["maxDossierBytes", "maxDraftBytes"], "config.limits");
  absolutePath(config.dossier.path, "config.dossier.path");
  boundedString(config.dossier.sha256, "config.dossier.sha256", 64, 64, HASH_PATTERN);
  absolutePath(config.output.path, "config.output.path");
  boundedString(
    config.output.relativePath,
    "config.output.relativePath",
    1,
    240,
    /^[A-Za-z0-9._/-]+$/u,
  );
  if (
    path.posix.isAbsolute(config.output.relativePath)
    || path.win32.isAbsolute(config.output.relativePath)
    || config.output.relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("PATH_INVALID", "config.output.relativePath must be a safe relative path");
  }
  absolutePath(config.audit.path, "config.audit.path");
  boundedInteger(config.limits.maxDossierBytes, "maxDossierBytes", 1024, 256 * 1024);
  boundedInteger(config.limits.maxDraftBytes, "maxDraftBytes", 256, 32 * 1024);
  return config;
}

async function loadConfig() {
  const configPath = process.env.RELEASE_NOTE_RUN_CONFIG;
  const token = process.env.RELEASE_NOTE_SANDBOX_TOKEN;
  if (!configPath || !token) {
    fail("SANDBOX_REQUIRED", "launcher config and sandbox token are required");
  }
  const resolved = path.resolve(configPath);
  await requirePlainFile(resolved, "launcher config");
  const info = await stat(resolved);
  if (info.size > CONFIG_LIMIT) fail("LIMIT_EXCEEDED", "launcher config exceeds 64 KiB");
  const config = validateConfig(JSON.parse(await readFile(resolved, "utf8")));
  const expected = Buffer.from(config.sandboxTokenHash.slice("sha256:".length), "hex");
  const actual = createHash("sha256").update(token, "utf8").digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    fail("SANDBOX_TOKEN_MISMATCH", "sandbox token does not match launcher evidence");
  }
  return config;
}

async function append(handle, event) {
  await handle.write(`${JSON.stringify(event)}\n`);
  await handle.sync();
}

export class ReleaseNoteService {
  static async create(configOverride = null) {
    const config = configOverride ? validateConfig(configOverride) : await loadConfig();
    await requirePlainFile(config.dossier.path, "dossier");
    await requirePlainDirectory(path.dirname(config.output.path), "output parent");
    await requirePlainDirectory(path.dirname(config.audit.path), "audit parent");
    for (const target of [config.output.path, config.audit.path]) {
      const exists = await lstat(target).then(() => true).catch((error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
      if (exists) fail("WRITE_ONCE", `${target} already exists`);
    }
    if (path.resolve(config.output.path) === path.resolve(config.audit.path)) {
      fail("PATH_INVALID", "output and audit paths must differ");
    }
    const audit = await open(config.audit.path, "wx", 0o600);
    const service = new ReleaseNoteService(config, audit);
    await service.record("service.started", {
      arm: config.arm,
      sandboxKind: config.sandboxKind,
      taskEnvelopeSha256: config.taskEnvelopeSha256,
      dossierSha256: config.dossier.sha256,
    });
    return service;
  }

  constructor(config, audit) {
    this.config = config;
    this.audit = audit;
    this.reads = 0;
    this.writes = 0;
    this.terminal = false;
    this.sequence = 0;
  }

  get toolDefinitions() {
    return [
      {
        name: "read_release_dossier",
        description: "Read the one request-bound frozen release dossier exactly once.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "write_release_note_draft",
        description: "Atomically write the one final Markdown release-note draft exactly once.",
        inputSchema: {
          type: "object",
          properties: {
            draft: { type: "string", minLength: 1, maxLength: this.config.limits.maxDraftBytes },
            dossierSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
          required: ["draft", "dossierSha256"],
          additionalProperties: false,
        },
      },
    ];
  }

  async record(type, data) {
    this.sequence += 1;
    await append(this.audit, {
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      runId: this.config.runId,
      type,
      ...data,
    });
  }

  async failTerminal(code, message) {
    if (!this.terminal) {
      this.terminal = true;
      await this.record("run.failed", { code, message, reads: this.reads, writes: this.writes });
      await this.audit.close();
    }
  }

  async readDossier(args) {
    exactObject(args, [], "read_release_dossier arguments");
    if (this.terminal) fail("RUN_TERMINAL", "run is already terminal");
    if (this.reads !== 0) fail("READ_LIMIT", "the dossier may be read only once");
    const bytes = await readFile(this.config.dossier.path);
    if (bytes.length > this.config.limits.maxDossierBytes) {
      fail("LIMIT_EXCEEDED", "dossier exceeds configured byte limit");
    }
    const actualHash = sha256(bytes);
    if (actualHash !== this.config.dossier.sha256) {
      fail("INTEGRITY_MISMATCH", "dossier hash differs from launcher configuration");
    }
    let dossier;
    try {
      dossier = JSON.parse(bytes);
    } catch {
      fail("DOSSIER_INVALID", "dossier is not valid JSON");
    }
    this.reads = 1;
    await this.record("dossier.read", { bytes: bytes.length, sha256: actualHash });
    return { dossier, integrity: { sha256: actualHash, bytes: bytes.length } };
  }

  async writeDraft(args) {
    exactObject(args, ["draft", "dossierSha256"], "write_release_note_draft arguments");
    if (this.terminal) fail("RUN_TERMINAL", "run is already terminal");
    if (this.reads !== 1) fail("READ_REQUIRED", "dossier must be read before the draft write");
    if (this.writes !== 0) fail("WRITE_LIMIT", "the draft may be written only once");
    boundedString(args.draft, "draft", 1, this.config.limits.maxDraftBytes);
    boundedString(args.dossierSha256, "dossierSha256", 64, 64, HASH_PATTERN);
    if (args.dossierSha256 !== this.config.dossier.sha256) {
      fail("INTEGRITY_MISMATCH", "write does not bind the configured dossier hash");
    }
    if (!/^#\s+\S/mu.test(args.draft) || !/^##\s+References\s*$/imu.test(args.draft)) {
      fail("DRAFT_INVALID", "draft requires a title and References heading");
    }
    const bytes = Buffer.from(args.draft.endsWith("\n") ? args.draft : `${args.draft}\n`, "utf8");
    const pending = `${this.config.output.path}.pending`;
    await mkdir(path.dirname(this.config.output.path), { recursive: true });
    try {
      const handle = await open(pending, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      await rename(pending, this.config.output.path);
    } catch (error) {
      await rm(pending, { force: true });
      throw error;
    }
    this.writes = 1;
    const draftSha256 = sha256(bytes);
    await this.record("draft.written", { bytes: bytes.length, sha256: draftSha256 });
    this.terminal = true;
    const envelope = {
      runId: this.config.runId,
      outputPath: this.config.output.relativePath,
      integrity: {
        dossierSha256: this.config.dossier.sha256,
        draftSha256,
        draftBytes: bytes.length,
      },
    };
    await this.record("run.completed", {
      reads: this.reads,
      writes: this.writes,
      statusEnvelopeSha256: sha256(Buffer.from(canonicalJson(envelope), "utf8")),
    });
    await this.audit.close();
    return envelope;
  }
}

export async function callTool(service, name, args) {
  try {
    if (name === "read_release_dossier") return await service.readDossier(args);
    if (name === "write_release_note_draft") return await service.writeDraft(args);
    fail("TOOL_NOT_FOUND", `unknown tool: ${name}`);
  } catch (error) {
    const code = error instanceof ReleaseNoteError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof ReleaseNoteError
      ? error.message
      : "release-note tool failed unexpectedly";
    await service.failTerminal(code, message);
    throw error;
  }
}

export const internals = { canonicalJson, sha256, validateConfig };
