#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";

function fail(message) {
  process.stderr.write(`V2_ISOLATION_REQUIRED: ${message}\n`);
  process.exit(78);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

const isolationPath = process.env.RELEASE_NOTE_ISOLATION_CONFIG;
if (!isolationPath || !path.isAbsolute(isolationPath)) fail("isolation config is required");

let config;
try {
  config = JSON.parse(await readFile(isolationPath, "utf8"));
} catch (error) {
  fail(`isolation config is unreadable: ${error.message}`);
}
exactObject(config, ["version", "attestationPath", "forbiddenPaths", "workspaceRoot"], "config");
if (config.version !== 1) fail("config.version must be 1");
if (!path.isAbsolute(config.attestationPath) || !path.isAbsolute(config.workspaceRoot)) {
  fail("isolation paths must be absolute");
}
if (!Array.isArray(config.forbiddenPaths) || config.forbiddenPaths.length < 3) {
  fail("at least three forbidden roots are required");
}
if (path.resolve(process.cwd()) !== path.resolve(config.workspaceRoot)) {
  fail("MCP working directory differs from the isolated workspace");
}

const probes = [];
for (const target of config.forbiddenPaths) {
  if (typeof target !== "string" || !path.isAbsolute(target)) fail("forbidden roots must be absolute");
  let accessible = false;
  let errorCode = null;
  try {
    await lstat(target);
    accessible = true;
  } catch (error) {
    errorCode = error?.code ?? "UNKNOWN";
  }
  probes.push({
    targetSha256: createHash("sha256").update(path.resolve(target), "utf8").digest("hex"),
    accessible,
    errorCode,
  });
}

const secretEnvironmentNames = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const exposedSecretNames = secretEnvironmentNames.filter((name) => process.env[name]);
const attestation = {
  formatVersion: 1,
  sandboxedMcp: true,
  workspaceRootSha256: createHash("sha256")
    .update(path.resolve(config.workspaceRoot), "utf8")
    .digest("hex"),
  forbiddenRootProbes: probes,
  forbiddenRootsInaccessible: probes.every((probe) => !probe.accessible),
  exposedSecretNames,
  secretEnvironmentAbsent: exposedSecretNames.length === 0,
};

const handle = await open(config.attestationPath, "wx", 0o600);
await handle.writeFile(`${JSON.stringify(attestation, null, 2)}\n`);
await handle.sync();
await handle.close();

if (!attestation.forbiddenRootsInaccessible) fail("a forbidden root is accessible");
if (!attestation.secretEnvironmentAbsent) fail("credential environment reached the MCP process");

await import("./server-core.mjs");
