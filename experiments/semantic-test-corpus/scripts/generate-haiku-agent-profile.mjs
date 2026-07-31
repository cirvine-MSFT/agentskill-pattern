#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sourcePath = resolve(repositoryRoot, ".github", "agents", "semantic-test-corpus.agent.md");
const targetPath = resolve(repositoryRoot, ".github", "agents", "semantic-test-corpus-haiku.agent.md");

export function generateHaikuProfile(sourceBytes = readFileSync(sourcePath)) {
  const source = sourceBytes.toString("utf8");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const generated = source
    .replace(/^name: semantic-test-corpus$/mu, "name: semantic-test-corpus-haiku")
    .replace(/^(description: .*)$/mu, `$1${eol}model: claude-haiku-4.5`);
  if (generated === source
    || !/^name: semantic-test-corpus-haiku$/mu.test(generated)
    || !/^model: claude-haiku-4\.5$/mu.test(generated)) {
    throw new Error("Registered semantic-test-corpus profile is not in the expected format");
  }
  return Buffer.from(generated, "utf8");
}

export function normalizedProfile(bytes) {
  return bytes.toString("utf8")
    .replace(/^name: semantic-test-corpus(?:-haiku)?\r?\n/mu, "")
    .replace(/^model: claude-haiku-4\.5\r?\n/mu, "");
}

export function validateHaikuProfile() {
  const source = readFileSync(sourcePath);
  const target = readFileSync(targetPath);
  assert.deepEqual(target, generateHaikuProfile(source),
    "fixed-Haiku profile is not exact generated output");
  assert.equal(normalizedProfile(target), normalizedProfile(source),
    "agent profiles differ beyond name/model");
}

if (process.argv.includes("--write")) {
  writeFileSync(targetPath, generateHaikuProfile());
  process.stdout.write("Generated semantic-test-corpus-haiku from the registered profile.\n");
} else {
  validateHaikuProfile();
  process.stdout.write("Fixed-Haiku agent profile is exact generated output.\n");
}
