import {
  chmod,
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";

const INTERNAL = Symbol("verified sandbox");
const CONFIG_BYTES = 64 * 1024;
const REQUEST_BYTES = 1024 * 1024;
const RUNTIME_LIMITS = Object.freeze({
  contractFiles: 200,
  contractDepth: 12,
  schemaDepth: 24,
  schemaNodes: 2_000,
});
const SANDBOX_KINDS = new Set(["container", "restricted-mounts", "restricted-acl"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail("SCHEMA_ERROR", `${label} must be a JSON object`);
  }
}

function assertExactKeys(value, allowed, required, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
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

function assertInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("SCHEMA_ERROR", `${label} must be an integer from ${minimum} through ${maximum}`);
  }
}

function assertString(value, label, minimum, maximum, pattern) {
  if (typeof value !== "string") {
    fail("SCHEMA_ERROR", `${label} must be a string`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimum || bytes > maximum) {
    fail("LIMIT_EXCEEDED", `${label} must be ${minimum}-${maximum} UTF-8 bytes`);
  }
  if (pattern && !pattern.test(value)) {
    fail("SCHEMA_ERROR", `${label} has an invalid value`);
  }
}

function validateSlug(value, label) {
  assertString(value, label, 1, 80, ID_PATTERN);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeRequestHash(request) {
  assertPlainObject(request, "request");
  const copy = { ...request };
  delete copy.requestHash;
  return sha256(Buffer.from(canonicalJson(copy), "utf8"));
}

export function computeSandboxTokenHash(token) {
  assertString(token, "sandbox token", 32, 256, /^[\x21-\x7e]+$/);
  return `sha256:${sha256(Buffer.from(token, "utf8"))}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function identityFromStats(stats) {
  return {
    device: stats.dev.toString(),
    fileId: stats.ino.toString(),
  };
}

function identitiesEqual(left, right) {
  return left.device === right.device && left.fileId === right.fileId;
}

async function pathIdentity(target) {
  return identityFromStats(await lstat(target, { bigint: true }));
}

function validateIdentity(value, label) {
  assertExactKeys(
    value,
    new Set(["device", "fileId"]),
    new Set(["device", "fileId"]),
    label,
  );
  assertString(value.device, `${label}.device`, 1, 40, /^\d+$/);
  assertString(value.fileId, `${label}.fileId`, 1, 40, /^\d+$/);
}

function validateRelativePath(value, label = "path") {
  assertString(value, label, 1, 240);
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

function isWithinOrEqual(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

async function assertRoot(root, expectedIdentity, label) {
  let stats;
  try {
    stats = await lstat(root, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("ROOT_MISSING", `${label} root must exist`);
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    fail("REPARSE_ESCAPE", `${label} root cannot be a symlink, junction, or reparse point`);
  }
  if (!stats.isDirectory()) {
    fail("ROOT_INVALID", `${label} root must be a directory`);
  }
  const actualIdentity = identityFromStats(stats);
  if (!identitiesEqual(actualIdentity, expectedIdentity)) {
    fail("ROOT_IDENTITY_CHANGED", `${label} root identity differs from the launcher attestation`);
  }
  const canonical = await realpath(root);
  if (path.resolve(canonical) !== path.resolve(root)) {
    fail("REPARSE_ESCAPE", `${label} root must resolve to itself exactly`);
  }
  return actualIdentity;
}

async function assertNoReparse(candidate, root, label) {
  const stats = await lstat(candidate, { bigint: true });
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

async function resolveExisting(root, rootIdentity, relativePath, kind, label) {
  const segments = validateRelativePath(relativePath, label);
  await assertRoot(root, rootIdentity, label);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    await findExactEntry(current, segment, label);
    current = path.join(current, segment);
    const stats = await assertNoReparse(current, root, label);
    if (index < segments.length - 1 && !stats.isDirectory()) {
      fail("NOT_FOUND", `${label} contains a non-directory component`);
    }
  }
  const stats = await lstat(current, { bigint: true });
  if (kind === "file" && !stats.isFile()) {
    fail("NOT_FOUND", `${label} must identify a regular file`);
  }
  if (kind === "directory" && !stats.isDirectory()) {
    fail("NOT_FOUND", `${label} must identify a directory`);
  }
  await assertRoot(root, rootIdentity, label);
  return { absolute: current, stats, identity: identityFromStats(stats) };
}

async function readVerifiedFile(root, rootIdentity, relativePath, maximumBytes, label) {
  const resolved = await resolveExisting(
    root,
    rootIdentity,
    relativePath,
    "file",
    label,
  );
  if (resolved.stats.size > BigInt(maximumBytes)) {
    fail("LIMIT_EXCEEDED", `${relativePath} exceeds ${maximumBytes} bytes`);
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(resolved.absolute, flags);
  try {
    const openedStats = await handle.stat({ bigint: true });
    if (
      !openedStats.isFile() ||
      !identitiesEqual(identityFromStats(openedStats), resolved.identity)
    ) {
      fail("FILE_IDENTITY_CHANGED", `${label} changed while it was opened`);
    }
    if (openedStats.size > BigInt(maximumBytes)) {
      fail("LIMIT_EXCEEDED", `${relativePath} exceeds ${maximumBytes} bytes`);
    }
    const content = await handle.readFile();
    if (content.length > maximumBytes) {
      fail("LIMIT_EXCEEDED", `${relativePath} exceeds ${maximumBytes} bytes`);
    }
    const after = await assertNoReparse(resolved.absolute, root, label);
    if (!identitiesEqual(identityFromStats(after), resolved.identity)) {
      fail("FILE_IDENTITY_CHANGED", `${label} changed during the read`);
    }
    await assertRoot(root, rootIdentity, label);
    return { content, identity: resolved.identity };
  } finally {
    await handle.close();
  }
}

async function readStandaloneFile(target, maximumBytes, label) {
  if (!path.isAbsolute(target) || path.resolve(target) !== target) {
    fail("SANDBOX_CONFIG_INVALID", `${label} path must be absolute and normalized`);
  }
  const before = await lstat(target, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    fail("SANDBOX_CONFIG_INVALID", `${label} must be a non-symlink regular file`);
  }
  if (before.size > BigInt(maximumBytes)) {
    fail("LIMIT_EXCEEDED", `${label} exceeds ${maximumBytes} bytes`);
  }
  if (path.resolve(await realpath(target)) !== target) {
    fail("SANDBOX_CONFIG_INVALID", `${label} cannot be redirected`);
  }
  const identity = identityFromStats(before);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!identitiesEqual(identityFromStats(opened), identity)) {
      fail("FILE_IDENTITY_CHANGED", `${label} changed while it was opened`);
    }
    const content = await handle.readFile();
    if (content.length > maximumBytes) {
      fail("LIMIT_EXCEEDED", `${label} exceeds ${maximumBytes} bytes`);
    }
    const after = await lstat(target, { bigint: true });
    if (!identitiesEqual(identityFromStats(after), identity)) {
      fail("FILE_IDENTITY_CHANGED", `${label} changed during the read`);
    }
    return { content, identity, digest: sha256(content) };
  } finally {
    await handle.close();
  }
}

async function assertWriteDenied(target, label) {
  let handle;
  try {
    handle = await open(target, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    await handle.close();
    handle = undefined;
    fail(
      "SANDBOX_UNVERIFIED",
      `${label} is writable; launcher confinement is not active`,
    );
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (error instanceof CorpusError) {
      throw error;
    }
    if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) {
      return;
    }
    throw error;
  }
}

function parseJson(content, label) {
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    fail("SCHEMA_ERROR", `${label} must contain valid JSON`);
  }
}

function validateSchemaDefinition(schema, label, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > RUNTIME_LIMITS.schemaNodes || depth > RUNTIME_LIMITS.schemaDepth) {
    fail("LIMIT_EXCEEDED", "v1ConfigSchema is too complex");
  }
  assertPlainObject(schema, label);
  if (Object.hasOwn(schema, "anyOf")) {
    assertExactKeys(schema, new Set(["anyOf"]), new Set(["anyOf"]), label);
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length < 2 || schema.anyOf.length > 8) {
      fail("SCHEMA_ERROR", `${label}.anyOf must contain 2-8 closed schemas`);
    }
    schema.anyOf.forEach((entry, index) =>
      validateSchemaDefinition(entry, `${label}.anyOf[${index}]`, state, depth + 1),
    );
    return;
  }

  if (typeof schema.type !== "string") {
    fail("SCHEMA_ERROR", `${label}.type must be a supported single JSON type`);
  }
  const common = new Set(["type", "const", "enum"]);
  if (Object.hasOwn(schema, "const") && Object.hasOwn(schema, "enum")) {
    fail("SCHEMA_ERROR", `${label} cannot combine const and enum`);
  }
  if (Object.hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100) {
      fail("SCHEMA_ERROR", `${label}.enum must contain 1-100 values`);
    }
  }

  switch (schema.type) {
    case "object": {
      assertExactKeys(
        schema,
        new Set([...common, "additionalProperties", "properties", "required"]),
        new Set(["type", "additionalProperties", "properties", "required"]),
        label,
      );
      if (schema.additionalProperties !== false) {
        fail("SCHEMA_ERROR", `${label}.additionalProperties must be false`);
      }
      assertPlainObject(schema.properties, `${label}.properties`);
      if (!Array.isArray(schema.required)) {
        fail("SCHEMA_ERROR", `${label}.required must be an array`);
      }
      const propertyNames = Object.keys(schema.properties);
      if (propertyNames.length > 200) {
        fail("LIMIT_EXCEEDED", `${label}.properties contains too many fields`);
      }
      for (const name of propertyNames) {
        if (
          DANGEROUS_KEYS.has(name) ||
          !/^[A-Za-z][A-Za-z0-9]*$/.test(name) ||
          name !== name.normalize("NFC")
        ) {
          fail("SCHEMA_ERROR", `${label}.properties contains an unsafe field name`);
        }
        validateSchemaDefinition(
          schema.properties[name],
          `${label}.properties.${name}`,
          state,
          depth + 1,
        );
      }
      if (
        new Set(schema.required).size !== schema.required.length ||
        schema.required.some(
          (name) => typeof name !== "string" || !Object.hasOwn(schema.properties, name),
        )
      ) {
        fail("SCHEMA_ERROR", `${label}.required must uniquely reference defined properties`);
      }
      break;
    }
    case "array":
      assertExactKeys(
        schema,
        new Set([...common, "items", "minItems", "maxItems", "uniqueItems"]),
        new Set(["type", "items", "maxItems"]),
        label,
      );
      assertInteger(schema.maxItems, `${label}.maxItems`, 0, 10_000);
      if (schema.minItems !== undefined) {
        assertInteger(schema.minItems, `${label}.minItems`, 0, schema.maxItems);
      }
      if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
        fail("SCHEMA_ERROR", `${label}.uniqueItems must be boolean`);
      }
      validateSchemaDefinition(schema.items, `${label}.items`, state, depth + 1);
      break;
    case "string":
      assertExactKeys(
        schema,
        new Set([...common, "minLength", "maxLength", "pattern"]),
        new Set(["type", "maxLength"]),
        label,
      );
      assertInteger(schema.maxLength, `${label}.maxLength`, 0, 100_000);
      if (schema.minLength !== undefined) {
        assertInteger(schema.minLength, `${label}.minLength`, 0, schema.maxLength);
      }
      if (schema.pattern !== undefined) {
        assertString(schema.pattern, `${label}.pattern`, 1, 200);
        try {
          new RegExp(schema.pattern, "u");
        } catch {
          fail("SCHEMA_ERROR", `${label}.pattern must be a valid regular expression`);
        }
      }
      break;
    case "number":
    case "integer":
      assertExactKeys(
        schema,
        new Set([
          ...common,
          "minimum",
          "maximum",
          "exclusiveMinimum",
          "exclusiveMaximum",
          "multipleOf",
        ]),
        new Set(["type"]),
        label,
      );
      for (const key of [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
      ]) {
        if (
          schema[key] !== undefined &&
          (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
        ) {
          fail("SCHEMA_ERROR", `${label}.${key} must be a finite number`);
        }
      }
      if (schema.multipleOf !== undefined && schema.multipleOf <= 0) {
        fail("SCHEMA_ERROR", `${label}.multipleOf must be positive`);
      }
      break;
    case "boolean":
    case "null":
      assertExactKeys(schema, common, new Set(["type"]), label);
      break;
    default:
      fail("SCHEMA_ERROR", `${label}.type is not supported`);
  }
}

function valuesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateConfigValue(value, schema, label = "config") {
  if (schema.anyOf) {
    for (const branch of schema.anyOf) {
      try {
        validateConfigValue(value, branch, label);
        return;
      } catch (error) {
        if (!(error instanceof CorpusError)) {
          throw error;
        }
      }
    }
    fail("SCHEMA_ERROR", `${label} does not match any allowed v1 schema branch`);
  }
  if (
    Object.hasOwn(schema, "const") &&
    !valuesEqual(value, schema.const)
  ) {
    fail("SCHEMA_ERROR", `${label} does not equal its required constant`);
  }
  if (
    Object.hasOwn(schema, "enum") &&
    !schema.enum.some((candidate) => valuesEqual(value, candidate))
  ) {
    fail("SCHEMA_ERROR", `${label} is not an allowed value`);
  }

  switch (schema.type) {
    case "object": {
      assertPlainObject(value, label);
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) {
          fail("SCHEMA_ERROR", `${label} contains unsupported field "${key}"`);
        }
      }
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) {
          fail("SCHEMA_ERROR", `${label} is missing required field "${key}"`);
        }
      }
      for (const key of Object.keys(value)) {
        validateConfigValue(value[key], schema.properties[key], `${label}.${key}`);
      }
      break;
    }
    case "array":
      if (!Array.isArray(value)) {
        fail("SCHEMA_ERROR", `${label} must be an array`);
      }
      if (
        value.length < (schema.minItems ?? 0) ||
        value.length > schema.maxItems
      ) {
        fail("SCHEMA_ERROR", `${label} has an invalid number of items`);
      }
      if (
        schema.uniqueItems &&
        new Set(value.map(canonicalJson)).size !== value.length
      ) {
        fail("SCHEMA_ERROR", `${label} must contain unique items`);
      }
      value.forEach((item, index) =>
        validateConfigValue(item, schema.items, `${label}[${index}]`),
      );
      break;
    case "string": {
      if (typeof value !== "string") {
        fail("SCHEMA_ERROR", `${label} must be a string`);
      }
      const length = [...value].length;
      if (length < (schema.minLength ?? 0) || length > schema.maxLength) {
        fail("SCHEMA_ERROR", `${label} has an invalid length`);
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
        fail("SCHEMA_ERROR", `${label} has an invalid format`);
      }
      break;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail("SCHEMA_ERROR", `${label} must be a finite number`);
      }
      break;
    case "integer":
      if (!Number.isSafeInteger(value)) {
        fail("SCHEMA_ERROR", `${label} must be an integer`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        fail("SCHEMA_ERROR", `${label} must be boolean`);
      }
      break;
    case "null":
      if (value !== null) {
        fail("SCHEMA_ERROR", `${label} must be null`);
      }
      break;
    default:
      fail("SCHEMA_ERROR", `${label} has an unsupported schema`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail("SCHEMA_ERROR", `${label} is below its minimum`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail("SCHEMA_ERROR", `${label} is above its maximum`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      fail("SCHEMA_ERROR", `${label} must exceed its exclusive minimum`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      fail("SCHEMA_ERROR", `${label} must be below its exclusive maximum`);
    }
    if (
      schema.multipleOf !== undefined &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) >
        Number.EPSILON * 10
    ) {
      fail("SCHEMA_ERROR", `${label} is not a valid multiple`);
    }
  }
}

function validateRequest(request) {
  assertExactKeys(
    request,
    new Set([
      "version",
      "targetCount",
      "scenarios",
      "categories",
      "maxSizes",
      "v1ConfigSchema",
      "requestHash",
    ]),
    new Set([
      "version",
      "targetCount",
      "scenarios",
      "categories",
      "maxSizes",
      "v1ConfigSchema",
      "requestHash",
    ]),
    "request",
  );
  if (request.version !== 1) {
    fail("SCHEMA_ERROR", "request.version must be 1");
  }
  assertInteger(request.targetCount, "request.targetCount", 1, 200);
  assertExactKeys(
    request.maxSizes,
    new Set(["contractFileBytes", "scenarioBytes", "manifestBytes"]),
    new Set(["contractFileBytes", "scenarioBytes", "manifestBytes"]),
    "request.maxSizes",
  );
  assertInteger(request.maxSizes.contractFileBytes, "request.maxSizes.contractFileBytes", 1, 1024 * 1024);
  assertInteger(request.maxSizes.scenarioBytes, "request.maxSizes.scenarioBytes", 1, 1024 * 1024);
  assertInteger(request.maxSizes.manifestBytes, "request.maxSizes.manifestBytes", 1, 1024 * 1024);

  if (!Array.isArray(request.categories) || request.categories.length === 0) {
    fail("SCHEMA_ERROR", "request.categories must be a non-empty array");
  }
  const categories = new Map();
  for (const [index, entry] of request.categories.entries()) {
    const label = `request.categories[${index}]`;
    assertExactKeys(
      entry,
      new Set(["category", "minQuota"]),
      new Set(["category", "minQuota"]),
      label,
    );
    validateSlug(entry.category, `${label}.category`);
    assertInteger(entry.minQuota, `${label}.minQuota`, 0, request.targetCount);
    if (categories.has(entry.category)) {
      fail("SCHEMA_ERROR", `duplicate request category "${entry.category}"`);
    }
    categories.set(entry.category, entry.minQuota);
  }
  if ([...categories.values()].reduce((sum, value) => sum + value, 0) > request.targetCount) {
    fail("SCHEMA_ERROR", "request category minimum quotas exceed targetCount");
  }

  if (
    !Array.isArray(request.scenarios) ||
    request.scenarios.length !== request.targetCount
  ) {
    fail("SCHEMA_ERROR", "request.scenarios must contain exactly targetCount entries");
  }
  const ids = new Set();
  const actualCounts = new Map([...categories.keys()].map((category) => [category, 0]));
  for (const [index, entry] of request.scenarios.entries()) {
    const label = `request.scenarios[${index}]`;
    assertExactKeys(
      entry,
      new Set(["scenarioId", "category"]),
      new Set(["scenarioId", "category"]),
      label,
    );
    validateSlug(entry.scenarioId, `${label}.scenarioId`);
    validateSlug(entry.category, `${label}.category`);
    if (ids.has(entry.scenarioId)) {
      fail("SCHEMA_ERROR", `duplicate request scenarioId "${entry.scenarioId}"`);
    }
    if (!categories.has(entry.category)) {
      fail("SCHEMA_ERROR", `request scenario category "${entry.category}" is not allowed`);
    }
    ids.add(entry.scenarioId);
    actualCounts.set(entry.category, actualCounts.get(entry.category) + 1);
  }
  for (const [category, minimum] of categories) {
    if (actualCounts.get(category) < minimum) {
      fail("SCHEMA_ERROR", `request does not satisfy minimum quota for "${category}"`);
    }
  }

  validateSchemaDefinition(request.v1ConfigSchema, "request.v1ConfigSchema");
  if (request.v1ConfigSchema.type !== "object") {
    fail("SCHEMA_ERROR", "request.v1ConfigSchema must be a closed object schema");
  }
  assertString(request.requestHash, "request.requestHash", 64, 64, /^[a-f0-9]{64}$/);
  const computed = computeRequestHash(request);
  if (computed !== request.requestHash) {
    fail("REQUEST_HASH_MISMATCH", "request.requestHash does not match canonical request content");
  }
  return request;
}

function parseSandboxConfig(value) {
  assertExactKeys(
    value,
    new Set(["version", "sandboxKind", "tokenHash", "requestHash", "roots", "lock"]),
    new Set(["version", "sandboxKind", "tokenHash", "requestHash", "roots", "lock"]),
    "sandbox config",
  );
  if (value.version !== 1 || !SANDBOX_KINDS.has(value.sandboxKind)) {
    fail("SANDBOX_CONFIG_INVALID", "sandbox config has an unsupported version or kind");
  }
  assertString(value.tokenHash, "sandbox config tokenHash", 71, 71, /^sha256:[a-f0-9]{64}$/);
  assertString(value.requestHash, "sandbox config requestHash", 64, 64, /^[a-f0-9]{64}$/);
  assertExactKeys(
    value.roots,
    new Set(["contract", "staging"]),
    new Set(["contract", "staging"]),
    "sandbox config roots",
  );
  for (const [name, access] of [["contract", "read-only"], ["staging", "read-write"]]) {
    const root = value.roots[name];
    assertExactKeys(
      root,
      new Set(["path", "access", "identity"]),
      new Set(["path", "access", "identity"]),
      `sandbox config roots.${name}`,
    );
    assertString(root.path, `sandbox config roots.${name}.path`, 3, 1024);
    if (!path.isAbsolute(root.path) || path.resolve(root.path) !== root.path) {
      fail("SANDBOX_CONFIG_INVALID", `${name} root path must be absolute and normalized`);
    }
    if (root.access !== access) {
      fail("SANDBOX_CONFIG_INVALID", `${name} root must be attested as ${access}`);
    }
    validateIdentity(root.identity, `sandbox config roots.${name}.identity`);
  }
  if (
    path.resolve(value.roots.contract.path) === path.resolve(value.roots.staging.path) ||
    isWithinOrEqual(value.roots.contract.path, value.roots.staging.path) ||
    isWithinOrEqual(value.roots.staging.path, value.roots.contract.path)
  ) {
    fail("SANDBOX_CONFIG_INVALID", "contract and staging roots must be distinct and disjoint");
  }
  assertExactKeys(
    value.lock,
    new Set(["waitTimeoutMs", "staleAfterMs"]),
    new Set(["waitTimeoutMs", "staleAfterMs"]),
    "sandbox config lock",
  );
  assertInteger(value.lock.waitTimeoutMs, "sandbox config lock.waitTimeoutMs", 50, 30_000);
  assertInteger(value.lock.staleAfterMs, "sandbox config lock.staleAfterMs", 1_000, 86_400_000);
  if (value.lock.staleAfterMs <= value.lock.waitTimeoutMs) {
    fail("SANDBOX_CONFIG_INVALID", "lock staleAfterMs must exceed waitTimeoutMs");
  }
  return value;
}

async function loadSandboxContext(options) {
  const environment = options.environment ?? process.env;
  const configPath =
    environment.configPath ?? environment.SEMANTIC_CORPUS_SANDBOX_CONFIG;
  const token =
    environment.token ?? environment.SEMANTIC_CORPUS_SANDBOX_TOKEN;
  if (!configPath || !token) {
    fail(
      "SANDBOX_REQUIRED",
      "SEMANTIC_CORPUS_SANDBOX_CONFIG and SEMANTIC_CORPUS_SANDBOX_TOKEN are required",
    );
  }
  assertString(token, "sandbox token", 32, 256, /^[\x21-\x7e]+$/);
  const normalizedConfigPath = path.resolve(configPath);
  if (normalizedConfigPath !== configPath) {
    fail("SANDBOX_CONFIG_INVALID", "sandbox config path must be absolute and normalized");
  }
  const configFile = await readStandaloneFile(
    normalizedConfigPath,
    CONFIG_BYTES,
    "sandbox config",
  );
  await assertWriteDenied(normalizedConfigPath, "sandbox config");
  const config = parseSandboxConfig(parseJson(configFile.content, "sandbox config"));
  const actualHash = Buffer.from(computeSandboxTokenHash(token), "utf8");
  const expectedHash = Buffer.from(config.tokenHash, "utf8");
  if (
    actualHash.length !== expectedHash.length ||
    !timingSafeEqual(actualHash, expectedHash)
  ) {
    fail("SANDBOX_TOKEN_MISMATCH", "sandbox token does not match launcher config");
  }
  await assertRoot(
    config.roots.contract.path,
    config.roots.contract.identity,
    "corpus-contract",
  );
  await assertRoot(
    config.roots.staging.path,
    config.roots.staging.identity,
    "corpus-staging",
  );
  return {
    config,
    configPath: normalizedConfigPath,
    configIdentity: configFile.identity,
    configDigest: configFile.digest,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function atomicWriteNewJson(target, value, options = {}) {
  const payload = jsonBytes(value);
  const maximum = options.maximumBytes ?? 64 * 1024;
  if (payload.length > maximum) {
    fail("LIMIT_EXCEEDED", `JSON document exceeds ${maximum} bytes`);
  }
  const directory = path.dirname(target);
  const token = randomBytes(8).toString("hex");
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${token}.tmp`);
  let handle;
  let temporaryExists = false;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryExists = true;
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.beforePublish) {
      await options.beforePublish(temporary, target);
    }
    await link(temporary, target);
    await rm(temporary);
    temporaryExists = false;
    await chmod(target, 0o400);
    if (options.afterPublish) {
      await options.afterPublish(target);
    }
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("CONFLICT", `${path.basename(target)} already exists; staging writes are write-once`);
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (temporaryExists) {
      await chmod(temporary, 0o600).catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  return payload.length;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export class CorpusService {
  static async create(options = {}) {
    const sandbox = await loadSandboxContext(options);
    const service = new CorpusService(INTERNAL, sandbox, options);
    await service.withLock(async () => {
      const loaded = await service.readRequestUnlocked();
      if (loaded.request.requestHash !== sandbox.config.requestHash) {
        fail(
          "REQUEST_HASH_MISMATCH",
          "request hash does not match the launcher sandbox config",
        );
      }
      await assertWriteDenied(
        path.join(service.contractRoot, "request.json"),
        "corpus request",
      );
      service.request = loaded.request;
      service.requestIdentity = loaded.identity;
      service.requestCanonical = canonicalJson(loaded.request);
    });
    return service;
  }

  constructor(internal, sandbox, options) {
    if (internal !== INTERNAL) {
      fail("STARTUP_REQUIRED", "use CorpusService.create with a verified sandbox environment");
    }
    this.sandbox = sandbox;
    this.contractRoot = sandbox.config.roots.contract.path;
    this.contractIdentity = sandbox.config.roots.contract.identity;
    this.stagingRoot = sandbox.config.roots.staging.path;
    this.stagingIdentity = sandbox.config.roots.staging.identity;
    this.lockConfig = sandbox.config.lock;
    this.hooks = options.hooks ?? {};
    this.request = undefined;
    this.requestIdentity = undefined;
    this.requestCanonical = undefined;
  }

  get toolDefinitions() {
    if (!this.request) {
      fail("STARTUP_REQUIRED", "request initialization did not complete");
    }
    const ids = this.request.scenarios.map((entry) => entry.scenarioId);
    const categories = this.request.categories.map((entry) => entry.category);
    return [
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
        description: "Write one request-defined scenario whose config exactly matches v1ConfigSchema.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["scenarioId", "config"],
          properties: {
            scenarioId: { type: "string", enum: ids },
            config: cloneJson(this.request.v1ConfigSchema),
          },
        },
      },
      {
        name: "write_scenario_manifest",
        description: "Publish the immutable request-defined scenario ID/category manifest.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["scenarios"],
          properties: {
            scenarios: {
              type: "array",
              minItems: this.request.targetCount,
              maxItems: this.request.targetCount,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["scenarioId", "category"],
                properties: {
                  scenarioId: { type: "string", enum: ids },
                  category: { type: "string", enum: categories },
                },
              },
            },
          },
        },
      },
    ];
  }

  async verifySandboxUnlocked() {
    const configFile = await readStandaloneFile(
      this.sandbox.configPath,
      CONFIG_BYTES,
      "sandbox config",
    );
    if (
      !identitiesEqual(configFile.identity, this.sandbox.configIdentity) ||
      configFile.digest !== this.sandbox.configDigest
    ) {
      fail("SANDBOX_CONFIG_CHANGED", "launcher sandbox config changed after startup");
    }
    await assertWriteDenied(this.sandbox.configPath, "sandbox config");
    await assertRoot(this.contractRoot, this.contractIdentity, "corpus-contract");
    await assertRoot(this.stagingRoot, this.stagingIdentity, "corpus-staging");
  }

  async acquireLock() {
    await this.verifySandboxUnlocked();
    const lockPath = path.join(this.stagingRoot, ".corpus.lock");
    const deadline = Date.now() + this.lockConfig.waitTimeoutMs;
    while (true) {
      let handle;
      try {
        handle = await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        );
        const nonce = randomBytes(16).toString("hex");
        const metadata = {
          version: 1,
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date().toISOString(),
          nonce,
        };
        const ownerBytes = jsonBytes(metadata);
        await handle.writeFile(ownerBytes);
        await handle.sync();
        const stats = await handle.stat({ bigint: true });
        await assertRoot(this.stagingRoot, this.stagingIdentity, "corpus-staging");
        return {
          handle,
          identity: identityFromStats(stats),
          lockPath,
          nonce,
          ownerBytes,
        };
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => {});
          await rm(lockPath, { force: true }).catch(() => {});
        }
        if (error?.code !== "EEXIST") {
          throw error;
        }
        let stats;
        try {
          stats = await lstat(lockPath, { bigint: true });
        } catch (inspectionError) {
          if (inspectionError?.code === "ENOENT") {
            continue;
          }
          throw inspectionError;
        }
        if (stats.isSymbolicLink() || !stats.isFile()) {
          fail("LOCK_INVALID", "staging lock is not a regular file; refusing to remove it");
        }
        if (Date.now() - Number(stats.mtimeMs) >= this.lockConfig.staleAfterMs) {
          fail("LOCK_STALE", "staging lock is stale; parent intervention is required");
        }
        if (Date.now() >= deadline) {
          fail("LOCK_TIMEOUT", "timed out waiting for the staging lock");
        }
        await sleep(20 + Math.floor(Math.random() * 20));
      }
    }
  }

  async releaseLock(lock) {
    let releaseError;
    try {
      const opened = await lock.handle.stat({ bigint: true });
      if (!identitiesEqual(identityFromStats(opened), lock.identity)) {
        fail("LOCK_OWNERSHIP_LOST", "open staging lock identity changed");
      }
      const onDisk = await lstat(lock.lockPath, { bigint: true });
      if (!identitiesEqual(identityFromStats(onDisk), lock.identity)) {
        fail("LOCK_OWNERSHIP_LOST", "staging lock path no longer belongs to this process");
      }
      if (opened.size !== BigInt(lock.ownerBytes.length)) {
        fail("LOCK_OWNERSHIP_LOST", "staging lock owner metadata changed");
      }
      const ownerBytes = Buffer.alloc(lock.ownerBytes.length);
      const { bytesRead } = await lock.handle.read(
        ownerBytes,
        0,
        ownerBytes.length,
        0,
      );
      if (bytesRead !== ownerBytes.length || !ownerBytes.equals(lock.ownerBytes)) {
        fail("LOCK_OWNERSHIP_LOST", "staging lock owner metadata changed");
      }
    } catch (error) {
      releaseError = error;
    }
    await lock.handle.close().catch((error) => {
      releaseError ??= error;
    });
    if (!releaseError) {
      await rm(lock.lockPath).catch((error) => {
        releaseError = error;
      });
    }
    if (releaseError) {
      throw releaseError;
    }
  }

  async withLock(action) {
    const lock = await this.acquireLock();
    let result;
    let operationError;
    try {
      await this.verifySandboxUnlocked();
      result = await action();
      await this.verifySandboxUnlocked();
    } catch (error) {
      operationError = error;
    }
    try {
      await this.releaseLock(lock);
    } catch (error) {
      operationError ??= error;
    }
    if (operationError) {
      throw operationError;
    }
    return result;
  }

  async readRequestUnlocked() {
    const loaded = await readVerifiedFile(
      this.contractRoot,
      this.contractIdentity,
      "request.json",
      REQUEST_BYTES,
      "corpus request",
    );
    const request = validateRequest(parseJson(loaded.content, "corpus-contract/request.json"));
    return { request, identity: loaded.identity };
  }

  async withOperation(action) {
    return this.withLock(async () => {
      const loaded = await this.readRequestUnlocked();
      if (
        !identitiesEqual(loaded.identity, this.requestIdentity) ||
        canonicalJson(loaded.request) !== this.requestCanonical
      ) {
        fail("REQUEST_CHANGED", "corpus-contract/request.json changed after startup");
      }
      await assertWriteDenied(
        path.join(this.contractRoot, "request.json"),
        "corpus request",
      );
      return action(loaded.request);
    });
  }

  async listContractFiles() {
    return this.withOperation(async (request) => {
      const files = [];
      const walk = async (directory, relativeDirectory, depth) => {
        if (depth > RUNTIME_LIMITS.contractDepth) {
          fail("LIMIT_EXCEEDED", `contract tree exceeds depth ${RUNTIME_LIMITS.contractDepth}`);
        }
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
        for (const entry of entries) {
          const relative = relativeDirectory
            ? `${relativeDirectory}/${entry.name}`
            : entry.name;
          validateRelativePath(relative, "contract path");
          const absolute = path.join(directory, entry.name);
          const stats = await assertNoReparse(absolute, this.contractRoot, "contract path");
          if (stats.isDirectory()) {
            await walk(absolute, relative, depth + 1);
          } else if (stats.isFile()) {
            await assertWriteDenied(absolute, `contract file ${relative}`);
            if (stats.size > BigInt(request.maxSizes.contractFileBytes)) {
              fail("LIMIT_EXCEEDED", `${relative} exceeds the contract file size limit`);
            }
            files.push({ path: relative, bytes: Number(stats.size) });
            if (files.length > RUNTIME_LIMITS.contractFiles) {
              fail(
                "LIMIT_EXCEEDED",
                `contract tree exceeds ${RUNTIME_LIMITS.contractFiles} files`,
              );
            }
          } else {
            fail("REPARSE_ESCAPE", `${relative} is not a regular file or directory`);
          }
        }
      };
      await walk(this.contractRoot, "", 0);
      await assertRoot(this.contractRoot, this.contractIdentity, "corpus-contract");
      return { root: "corpus-contract", requestHash: request.requestHash, files };
    });
  }

  async readContractFile(args) {
    assertExactKeys(args, new Set(["path"]), new Set(["path"]), "arguments");
    return this.withOperation(async (request) => {
      const resolved = await resolveExisting(
        this.contractRoot,
        this.contractIdentity,
        args.path,
        "file",
        "contract path",
      );
      await assertWriteDenied(resolved.absolute, `contract file ${args.path}`);
      const loaded = await readVerifiedFile(
        this.contractRoot,
        this.contractIdentity,
        args.path,
        request.maxSizes.contractFileBytes,
        "contract path",
      );
      return {
        path: args.path,
        bytes: loaded.content.length,
        content: loaded.content.toString("utf8"),
      };
    });
  }

  async scenarioDirectoryUnlocked() {
    await assertRoot(this.stagingRoot, this.stagingIdentity, "corpus-staging");
    const entries = await readdir(this.stagingRoot, { withFileTypes: true });
    const exact = entries.find((entry) => entry.name === "scenarios");
    if (!exact) {
      if (entries.some((entry) => entry.name.toLowerCase() === "scenarios")) {
        fail("CASE_MISMATCH", "corpus-staging/scenarios casing is invalid");
      }
      try {
        await mkdir(path.join(this.stagingRoot, "scenarios"));
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }
    }
    const target = path.join(this.stagingRoot, "scenarios");
    const stats = await assertNoReparse(target, this.stagingRoot, "staging scenarios");
    if (!stats.isDirectory()) {
      fail("ROOT_INVALID", "corpus-staging/scenarios must be a directory");
    }
    await assertRoot(this.stagingRoot, this.stagingIdentity, "corpus-staging");
    return { path: target, identity: identityFromStats(stats) };
  }

  async assertStagingOpenUnlocked() {
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

  async scenarioIdsUnlocked() {
    const directory = await this.scenarioDirectoryUnlocked();
    const entries = await readdir(directory.path, { withFileTypes: true });
    const ids = [];
    for (const entry of entries) {
      const absolute = path.join(directory.path, entry.name);
      const stats = await assertNoReparse(absolute, this.stagingRoot, "staging scenario");
      const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(entry.name);
      if (!match || !stats.isFile()) {
        fail("STAGING_INVALID", "corpus-staging/scenarios contains an unexpected entry");
      }
      ids.push(match[1]);
    }
    const afterIdentity = await pathIdentity(directory.path);
    if (!identitiesEqual(afterIdentity, directory.identity)) {
      fail("ROOT_IDENTITY_CHANGED", "staging scenarios directory changed during enumeration");
    }
    ids.sort();
    return ids;
  }

  async writeScenarioInput(args) {
    assertExactKeys(
      args,
      new Set(["scenarioId", "config"]),
      new Set(["scenarioId", "config"]),
      "arguments",
    );
    validateSlug(args.scenarioId, "scenarioId");
    return this.withOperation(async (request) => {
      const requested = request.scenarios.find(
        (entry) => entry.scenarioId === args.scenarioId,
      );
      if (!requested) {
        fail("SCHEMA_ERROR", "scenarioId is not defined by corpus-contract/request.json");
      }
      validateConfigValue(args.config, request.v1ConfigSchema);
      if (jsonBytes(args.config).length > request.maxSizes.scenarioBytes) {
        fail("LIMIT_EXCEEDED", `scenario exceeds ${request.maxSizes.scenarioBytes} bytes`);
      }
      await this.assertStagingOpenUnlocked();
      const existing = await this.scenarioIdsUnlocked();
      if (existing.length >= request.targetCount) {
        fail("LIMIT_EXCEEDED", `staging already contains the exact target of ${request.targetCount}`);
      }
      const directory = await this.scenarioDirectoryUnlocked();
      const target = path.join(directory.path, `${args.scenarioId}.json`);
      const bytes = await atomicWriteNewJson(target, args.config, {
        maximumBytes: request.maxSizes.scenarioBytes,
        beforePublish: this.hooks.beforeScenarioPublish,
        afterPublish: async () => {
          const currentIdentity = await pathIdentity(directory.path);
          if (!identitiesEqual(currentIdentity, directory.identity)) {
            fail("ROOT_IDENTITY_CHANGED", "staging scenarios directory changed during write");
          }
        },
      });
      return {
        path: `corpus-staging/scenarios/${args.scenarioId}.json`,
        scenarioId: args.scenarioId,
        category: requested.category,
        bytes,
        status: "written",
      };
    });
  }

  validateManifestArguments(args, request) {
    assertExactKeys(args, new Set(["scenarios"]), new Set(["scenarios"]), "arguments");
    if (!Array.isArray(args.scenarios) || args.scenarios.length !== request.targetCount) {
      fail("SCHEMA_ERROR", `manifest must contain exactly ${request.targetCount} scenarios`);
    }
    const supplied = new Map();
    for (const [index, entry] of args.scenarios.entries()) {
      const label = `scenarios[${index}]`;
      assertExactKeys(
        entry,
        new Set(["scenarioId", "category"]),
        new Set(["scenarioId", "category"]),
        label,
      );
      validateSlug(entry.scenarioId, `${label}.scenarioId`);
      validateSlug(entry.category, `${label}.category`);
      if (supplied.has(entry.scenarioId)) {
        fail("SCHEMA_ERROR", `duplicate manifest scenarioId "${entry.scenarioId}"`);
      }
      supplied.set(entry.scenarioId, entry.category);
    }
    for (const requested of request.scenarios) {
      if (supplied.get(requested.scenarioId) !== requested.category) {
        fail(
          "SCHEMA_ERROR",
          "manifest IDs and categories must exactly match corpus-contract/request.json",
        );
      }
    }
    const counts = new Map(request.categories.map((entry) => [entry.category, 0]));
    for (const category of supplied.values()) {
      if (!counts.has(category)) {
        fail("SCHEMA_ERROR", `manifest category "${category}" is not allowed`);
      }
      counts.set(category, counts.get(category) + 1);
    }
    for (const entry of request.categories) {
      if (counts.get(entry.category) < entry.minQuota) {
        fail("SCHEMA_ERROR", `manifest does not satisfy minimum quota for "${entry.category}"`);
      }
    }
  }

  async snapshotScenariosUnlocked(request) {
    const hashes = new Map();
    for (const entry of request.scenarios) {
      const relative = `scenarios/${entry.scenarioId}.json`;
      const loaded = await readVerifiedFile(
        this.stagingRoot,
        this.stagingIdentity,
        relative,
        request.maxSizes.scenarioBytes,
        "staging scenario",
      );
      const config = parseJson(loaded.content, relative);
      validateConfigValue(config, request.v1ConfigSchema);
      hashes.set(entry.scenarioId, {
        digest: sha256(loaded.content),
        identity: loaded.identity,
      });
    }
    return hashes;
  }

  async verifySnapshotUnlocked(request, snapshot) {
    for (const entry of request.scenarios) {
      const relative = `scenarios/${entry.scenarioId}.json`;
      const loaded = await readVerifiedFile(
        this.stagingRoot,
        this.stagingIdentity,
        relative,
        request.maxSizes.scenarioBytes,
        "staging scenario",
      );
      const prior = snapshot.get(entry.scenarioId);
      if (
        !identitiesEqual(loaded.identity, prior.identity) ||
        sha256(loaded.content) !== prior.digest
      ) {
        fail("SCENARIO_CHANGED", `${relative} changed during manifest publication`);
      }
    }
  }

  async writeScenarioManifest(args) {
    return this.withOperation(async (request) => {
      this.validateManifestArguments(args, request);
      await this.assertStagingOpenUnlocked();
      const stagedIds = await this.scenarioIdsUnlocked();
      const requestedIds = request.scenarios.map((entry) => entry.scenarioId).sort();
      if (
        stagedIds.length !== request.targetCount ||
        stagedIds.some((scenarioId, index) => scenarioId !== requestedIds[index])
      ) {
        fail("SCHEMA_ERROR", "staged scenario IDs must exactly match the request");
      }
      const snapshot = await this.snapshotScenariosUnlocked(request);
      if (this.hooks.beforeManifestPublish) {
        await this.hooks.beforeManifestPublish();
      }
      await this.verifySnapshotUnlocked(request, snapshot);
      const manifest = {
        version: 1,
        kind: "semantic-source-scenarios",
        requestHash: request.requestHash,
        scenarioCount: request.targetCount,
        scenarios: request.scenarios.map(({ scenarioId, category }) => ({
          scenarioId,
          category,
        })),
      };
      const target = path.join(this.stagingRoot, "manifest.json");
      const bytes = await atomicWriteNewJson(target, manifest, {
        maximumBytes: request.maxSizes.manifestBytes,
      });
      return {
        path: "corpus-staging/manifest.json",
        requestHash: request.requestHash,
        scenarioCount: request.targetCount,
        bytes,
        status: "written",
      };
    });
  }
}

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
