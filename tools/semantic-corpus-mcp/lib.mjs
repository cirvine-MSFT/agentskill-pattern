import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_LIMITS = Object.freeze({
  contractFileBytes: 256 * 1024,
  contractFiles: 200,
  contractDepth: 12,
  scenarioBytes: 64 * 1024,
  manifestBytes: 256 * 1024,
  scenariosMin: 40,
  scenariosMax: 60,
  valueDepth: 20,
  valueNodes: 5_000,
  stringBytes: 8 * 1024,
  arrayItems: 200,
  objectKeys: 200,
});

const FORBIDDEN_KEYS = new Set([
  "expected",
  "expectederror",
  "expectederrors",
  "expectedoutput",
  "expectedoutputs",
  "expectedresult",
  "expectedresults",
  "migrationimplementation",
  "migrationpath",
  "migrationscript",
  "migrationsource",
  "oracle",
  "oracleoutput",
  "oracleoutputs",
  "oraclepath",
  "oracleresult",
  "oracleresults",
]);

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PATH_KEYS = new Set([
  "dir",
  "directory",
  "file",
  "filepath",
  "fixturepath",
  "path",
  "sourcepath",
  "testpath",
]);
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__tests__",
  "expected",
  "expected-output",
  "expected-outputs",
  "expected-results",
  "fixtures",
  "migration-source",
  "oracle",
  "oracle-results",
  "test",
  "testdata",
  "tests",
]);
const FORBIDDEN_METADATA = [
  /\boracle\b/i,
  /\bexpected[\s_-]*(?:error|output|response|result|value)s?\b/i,
  /\bmigration[\s_-]*(?:code|implementation|script|source)\b/i,
  /(?:^|[\s"'`])(?:__tests__|fixtures|testdata|tests?)[\\/]/i,
];

export class CorpusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CorpusError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CorpusError(code, message);
}

function canonicalKey(value) {
  return value.normalize("NFKC").toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isForbiddenField(key) {
  const normalized = canonicalKey(key);
  return (
    FORBIDDEN_KEYS.has(normalized) ||
    /^expected(?:errors?|outputs?|responses?|results?|status|values?)$/.test(normalized) ||
    /^oracle(?:data|errors?|outputs?|responses?|results?|status|values?)?$/.test(normalized) ||
    /^migration(?:code|dir|directory|file|implementation|path|program|script|source)$/.test(
      normalized,
    )
  );
}

function isPathField(key) {
  const normalized = canonicalKey(key);
  return (
    PATH_KEYS.has(normalized) ||
    /^(?:dir|directory|file|path)name$/.test(normalized) ||
    /(?:Path|File|Dir|Directory)$/.test(key) ||
    /(?:^|[-_])(?:path|file|dir|directory)$/i.test(key)
  );
}

function validateMetadataText(value, label) {
  for (const pattern of FORBIDDEN_METADATA) {
    if (pattern.test(value)) {
      fail(
        "FORBIDDEN_FIELD",
        `${label} cannot encode expected, oracle, migration-source, or existing-test artifacts`,
      );
    }
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("SCHEMA_ERROR", `${label} must be a JSON object`);
  }
}

function assertExactKeys(value, allowed, required, label) {
  assertPlainObject(value, label);
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.has(key)) {
      fail("SCHEMA_ERROR", `${label} contains unsupported field "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("SCHEMA_ERROR", `${label} is missing required field "${key}"`);
    }
  }
}

function assertBoundedString(value, label, minimum, maximum) {
  if (typeof value !== "string") {
    fail("SCHEMA_ERROR", `${label} must be a string`);
  }
  const size = Buffer.byteLength(value, "utf8");
  if (size < minimum || size > maximum) {
    fail("LIMIT_EXCEEDED", `${label} must be ${minimum}-${maximum} UTF-8 bytes`);
  }
}

export function validateRelativePath(value, label = "path") {
  assertBoundedString(value, label, 1, 240);
  if (value !== value.normalize("NFC")) {
    fail("INVALID_PATH", `${label} must use NFC-normalized characters`);
  }
  if (value.includes("\\")) {
    fail("INVALID_PATH", `${label} must use "/" as its only separator`);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    fail("PATH_ESCAPE", `${label} must be relative`);
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("PATH_ESCAPE", `${label} cannot contain empty, "." or ".." segments`);
  }
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      fail("INVALID_PATH", `${label} contains a non-ASCII or unsupported path character`);
    }
  }
  return segments;
}

function assertWithin(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail("PATH_ESCAPE", `${label} resolves outside its fixed root`);
  }
}

async function assertRoot(root, label) {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("ROOT_MISSING", `${label} root must be prepared by the parent`);
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    fail("REPARSE_ESCAPE", `${label} root cannot be a symlink, junction, or reparse point`);
  }
  if (!stats.isDirectory()) {
    fail("ROOT_INVALID", `${label} root must be a directory`);
  }
  const canonical = await realpath(root);
  if (path.resolve(canonical) !== path.resolve(root)) {
    fail("REPARSE_ESCAPE", `${label} root must resolve to itself exactly`);
  }
}

async function findExactEntry(directory, segment, label) {
  const entries = await readdir(directory, { withFileTypes: true });
  const exact = entries.find((entry) => entry.name === segment);
  if (exact) {
    return exact;
  }
  if (entries.some((entry) => entry.name.toLowerCase() === segment.toLowerCase())) {
    fail("CASE_MISMATCH", `${label} must match on-disk casing exactly`);
  }
  fail("NOT_FOUND", `${label} does not exist`);
}

async function assertNoReparse(candidate, root, label) {
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink()) {
    fail("REPARSE_ESCAPE", `${label} cannot traverse a symlink, junction, or reparse point`);
  }
  const canonical = await realpath(candidate);
  assertWithin(root, canonical, label);
  if (path.resolve(canonical) !== path.resolve(candidate)) {
    fail("REPARSE_ESCAPE", `${label} must resolve without redirection`);
  }
  return stats;
}

async function resolveExisting(root, relativePath, kind, label) {
  const segments = validateRelativePath(relativePath, label);
  await assertRoot(root, label);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    await findExactEntry(current, segment, label);
    current = path.join(current, segment);
    const stats = await assertNoReparse(current, root, label);
    if (index < segments.length - 1 && !stats.isDirectory()) {
      fail("NOT_FOUND", `${label} contains a non-directory component`);
    }
  }
  const stats = await lstat(current);
  if (kind === "file" && !stats.isFile()) {
    fail("NOT_FOUND", `${label} must identify a regular file`);
  }
  if (kind === "directory" && !stats.isDirectory()) {
    fail("NOT_FOUND", `${label} must identify a directory`);
  }
  return { absolute: current, stats };
}

function validatePathLikeValue(value, label) {
  if (typeof value !== "string") {
    return;
  }
  const segments = validateRelativePath(value, label);
  for (const segment of segments) {
    const lowered = segment.toLowerCase();
    const normalized = canonicalKey(segment);
    if (
      FORBIDDEN_PATH_SEGMENTS.has(lowered) ||
      normalized.startsWith("expected") ||
      normalized.startsWith("oracle") ||
      normalized.startsWith("migration") ||
      normalized.startsWith("migrate")
    ) {
      fail("FORBIDDEN_PATH", `${label} cannot reference expected, oracle, migration-source, or test paths`);
    }
  }
}

export function validateScenarioValue(value, limits = DEFAULT_LIMITS) {
  const state = { nodes: 0 };

  function visit(current, depth, label) {
    state.nodes += 1;
    if (state.nodes > limits.valueNodes) {
      fail("LIMIT_EXCEEDED", `scenario input exceeds ${limits.valueNodes} JSON values`);
    }
    if (depth > limits.valueDepth) {
      fail("LIMIT_EXCEEDED", `scenario input exceeds depth ${limits.valueDepth}`);
    }
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > limits.stringBytes) {
        fail("LIMIT_EXCEEDED", `${label} exceeds the string size limit`);
      }
      return;
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > limits.arrayItems) {
        fail("LIMIT_EXCEEDED", `${label} exceeds ${limits.arrayItems} array items`);
      }
      current.forEach((item, index) => visit(item, depth + 1, `${label}[${index}]`));
      return;
    }
    if (typeof current !== "object") {
      fail("SCHEMA_ERROR", `${label} contains a non-JSON value`);
    }

    const keys = Object.keys(current);
    if (keys.length > limits.objectKeys) {
      fail("LIMIT_EXCEEDED", `${label} exceeds ${limits.objectKeys} object fields`);
    }
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) {
        fail("FORBIDDEN_FIELD", `${label} contains dangerous field "${key}"`);
      }
      if (isForbiddenField(key)) {
        fail("FORBIDDEN_FIELD", `${label} cannot contain field "${key}"`);
      }
      if (isPathField(key)) {
        validatePathLikeValue(current[key], `${label}.${key}`);
      }
      visit(current[key], depth + 1, `${label}.${key}`);
    }
  }

  assertPlainObject(value, "input");
  visit(value, 0, "input");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function atomicWriteNewJson(target, value, options = {}) {
  const payload = jsonBytes(value);
  const maximum = options.maximumBytes ?? DEFAULT_LIMITS.scenarioBytes;
  if (payload.length > maximum) {
    fail("LIMIT_EXCEEDED", `JSON document exceeds ${maximum} bytes`);
  }

  const directory = path.dirname(target);
  const token = randomBytes(8).toString("hex");
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${token}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.beforePublish) {
      await options.beforePublish(temporary, target);
    }
    await link(temporary, target);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("CONFLICT", `${path.basename(target)} already exists; staging writes are write-once`);
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(temporary, { force: true }).catch(() => {});
  }
  return payload.length;
}

function validateScenarioId(value) {
  assertBoundedString(value, "scenarioId", 1, 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    fail("SCHEMA_ERROR", "scenarioId must be a lowercase ASCII slug");
  }
}

function validateCategory(value) {
  assertBoundedString(value, "category", 1, 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    fail("SCHEMA_ERROR", "category must be a lowercase ASCII slug");
  }
}

async function ensureFixedDirectory(root, name, label) {
  await assertRoot(root, label);
  const entries = await readdir(root, { withFileTypes: true });
  const exact = entries.find((entry) => entry.name === name);
  if (!exact) {
    if (entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
      fail("CASE_MISMATCH", `${label}/${name} casing is invalid`);
    }
    try {
      await mkdir(path.join(root, name));
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }
  const target = path.join(root, name);
  const stats = await assertNoReparse(target, root, `${label}/${name}`);
  if (!stats.isDirectory()) {
    fail("ROOT_INVALID", `${label}/${name} must be a directory`);
  }
  return target;
}

export class CorpusService {
  constructor(options = {}) {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    this.contractRoot = path.join(cwd, "corpus-contract");
    this.stagingRoot = path.join(cwd, "corpus-staging");
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    this.hooks = options.hooks ?? {};
  }

  async listContractFiles() {
    await assertRoot(this.contractRoot, "corpus-contract");
    const files = [];
    const walk = async (directory, relativeDirectory, depth) => {
      if (depth > this.limits.contractDepth) {
        fail("LIMIT_EXCEEDED", `contract tree exceeds depth ${this.limits.contractDepth}`);
      }
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        validateRelativePath(
          relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
          "contract path",
        );
        const absolute = path.join(directory, entry.name);
        const stats = await assertNoReparse(absolute, this.contractRoot, "contract path");
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (stats.isDirectory()) {
          await walk(absolute, relative, depth + 1);
        } else if (stats.isFile()) {
          if (stats.size > this.limits.contractFileBytes) {
            fail("LIMIT_EXCEEDED", `${relative} exceeds the contract file size limit`);
          }
          files.push({ path: relative, bytes: stats.size });
          if (files.length > this.limits.contractFiles) {
            fail("LIMIT_EXCEEDED", `contract tree exceeds ${this.limits.contractFiles} files`);
          }
        } else {
          fail("REPARSE_ESCAPE", `${relative} is not a regular file or directory`);
        }
      }
    };
    await walk(this.contractRoot, "", 0);
    return { root: "corpus-contract", files };
  }

  async readContractFile(args) {
    assertExactKeys(args, new Set(["path"]), new Set(["path"]), "arguments");
    const resolved = await resolveExisting(
      this.contractRoot,
      args.path,
      "file",
      "contract path",
    );
    if (resolved.stats.size > this.limits.contractFileBytes) {
      fail("LIMIT_EXCEEDED", `${args.path} exceeds the contract file size limit`);
    }

    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(resolved.absolute, flags);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > this.limits.contractFileBytes) {
        fail("LIMIT_EXCEEDED", `${args.path} is not an allowed contract file`);
      }
      const content = await handle.readFile("utf8");
      await assertNoReparse(resolved.absolute, this.contractRoot, "contract path");
      return { path: args.path, bytes: Buffer.byteLength(content, "utf8"), content };
    } finally {
      await handle.close();
    }
  }

  async scenarioDirectory() {
    return ensureFixedDirectory(this.stagingRoot, "scenarios", "corpus-staging");
  }

  async assertStagingOpen() {
    await assertRoot(this.stagingRoot, "corpus-staging");
    const entries = await readdir(this.stagingRoot, { withFileTypes: true });
    const manifest = entries.find((entry) => entry.name === "manifest.json");
    if (!manifest) {
      if (entries.some((entry) => entry.name.toLowerCase() === "manifest.json")) {
        fail("CASE_MISMATCH", "corpus-staging/manifest.json casing is invalid");
      }
      return;
    }
    await assertNoReparse(
      path.join(this.stagingRoot, manifest.name),
      this.stagingRoot,
      "staging manifest",
    );
    fail("STAGING_FINALIZED", "scenario writes are closed after manifest publication");
  }

  async scenarioIds() {
    const directory = await this.scenarioDirectory();
    const entries = await readdir(directory, { withFileTypes: true });
    const ids = [];
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stats = await assertNoReparse(absolute, this.stagingRoot, "staging scenario");
      const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(entry.name);
      if (!match || !stats.isFile()) {
        fail("STAGING_INVALID", "corpus-staging/scenarios contains an unexpected entry");
      }
      ids.push(match[1]);
    }
    ids.sort();
    return ids;
  }

  async writeScenarioInput(args) {
    assertExactKeys(
      args,
      new Set(["scenarioId", "input"]),
      new Set(["scenarioId", "input"]),
      "arguments",
    );
    validateScenarioId(args.scenarioId);
    validateScenarioValue(args.input, this.limits);
    await this.assertStagingOpen();
    const existing = await this.scenarioIds();
    if (existing.length >= this.limits.scenariosMax) {
      fail("LIMIT_EXCEEDED", `staging is limited to ${this.limits.scenariosMax} scenarios`);
    }
    const directory = await this.scenarioDirectory();
    const target = path.join(directory, `${args.scenarioId}.json`);
    const bytes = await atomicWriteNewJson(target, args.input, {
      maximumBytes: this.limits.scenarioBytes,
      beforePublish: this.hooks.beforeScenarioPublish,
    });
    return {
      path: `corpus-staging/scenarios/${args.scenarioId}.json`,
      scenarioId: args.scenarioId,
      bytes,
      status: "written",
    };
  }

  async writeScenarioManifest(args) {
    assertExactKeys(
      args,
      new Set(["scenarios", "summary"]),
      new Set(["scenarios"]),
      "arguments",
    );
    if (!Array.isArray(args.scenarios)) {
      fail("SCHEMA_ERROR", "scenarios must be an array");
    }
    if (
      args.scenarios.length < this.limits.scenariosMin ||
      args.scenarios.length > this.limits.scenariosMax
    ) {
      fail(
        "LIMIT_EXCEEDED",
        `manifest must contain ${this.limits.scenariosMin}-${this.limits.scenariosMax} scenarios`,
      );
    }
    if (args.summary !== undefined) {
      assertBoundedString(args.summary, "summary", 1, 2_000);
      validateMetadataText(args.summary, "summary");
    }

    const ids = new Set();
    const normalized = [];
    for (const [index, scenario] of args.scenarios.entries()) {
      const label = `scenarios[${index}]`;
      assertExactKeys(
        scenario,
        new Set(["scenarioId", "category", "rationale", "contractRefs"]),
        new Set(["scenarioId", "category", "rationale"]),
        label,
      );
      validateScenarioId(scenario.scenarioId);
      validateCategory(scenario.category);
      assertBoundedString(scenario.rationale, `${label}.rationale`, 10, 1_000);
      validateMetadataText(scenario.rationale, `${label}.rationale`);
      if (ids.has(scenario.scenarioId)) {
        fail("SCHEMA_ERROR", `duplicate scenarioId "${scenario.scenarioId}"`);
      }
      ids.add(scenario.scenarioId);

      const contractRefs = scenario.contractRefs ?? [];
      if (!Array.isArray(contractRefs) || contractRefs.length > 10) {
        fail("LIMIT_EXCEEDED", `${label}.contractRefs must contain at most 10 paths`);
      }
      for (const reference of contractRefs) {
        await resolveExisting(this.contractRoot, reference, "file", "contract reference");
      }
      normalized.push({
        scenarioId: scenario.scenarioId,
        file: `scenarios/${scenario.scenarioId}.json`,
        category: scenario.category,
        rationale: scenario.rationale,
        ...(contractRefs.length > 0 ? { contractRefs } : {}),
      });
    }

    const stagedIds = await this.scenarioIds();
    if (
      stagedIds.length !== ids.size ||
      stagedIds.some((scenarioId) => !ids.has(scenarioId))
    ) {
      fail("SCHEMA_ERROR", "manifest scenario IDs must exactly match staged scenario files");
    }

    const manifest = {
      version: 1,
      kind: "semantic-source-scenarios",
      scenarioCount: normalized.length,
      scenarios: normalized,
      ...(args.summary === undefined ? {} : { summary: args.summary }),
    };
    const target = path.join(this.stagingRoot, "manifest.json");
    const bytes = await atomicWriteNewJson(target, manifest, {
      maximumBytes: this.limits.manifestBytes,
      beforePublish: this.hooks.beforeManifestPublish,
    });
    return {
      path: "corpus-staging/manifest.json",
      scenarioCount: normalized.length,
      bytes,
      status: "written",
    };
  }
}

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "list_contract_files",
    description: "List bounded read-only files under the fixed corpus-contract root.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "read_contract_file",
    description: "Read one listed contract file using its exact relative path.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string", minLength: 1, maxLength: 240 } },
    },
  },
  {
    name: "write_scenario_input",
    description: "Atomically write one source-input JSON scenario to tool-owned staging.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["scenarioId", "input"],
      properties: {
        scenarioId: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
        input: { type: "object" },
      },
    },
  },
  {
    name: "write_scenario_manifest",
    description: "Atomically write explanatory metadata for exactly 40-60 staged source scenarios.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["scenarios"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 2000 },
        scenarios: {
          type: "array",
          minItems: 40,
          maxItems: 60,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["scenarioId", "category", "rationale"],
            properties: {
              scenarioId: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
              category: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
              rationale: { type: "string", minLength: 10, maxLength: 1000 },
              contractRefs: {
                type: "array",
                maxItems: 10,
                items: { type: "string", minLength: 1, maxLength: 240 },
              },
            },
          },
        },
      },
    },
  },
]);

export async function callTool(service, name, args = {}) {
  switch (name) {
    case "list_contract_files":
      assertExactKeys(args, new Set(), new Set(), "arguments");
      return service.listContractFiles();
    case "read_contract_file":
      return service.readContractFile(args);
    case "write_scenario_input":
      return service.writeScenarioInput(args);
    case "write_scenario_manifest":
      return service.writeScenarioManifest(args);
    default:
      fail("TOOL_NOT_FOUND", `unknown tool "${name}"`);
  }
}
