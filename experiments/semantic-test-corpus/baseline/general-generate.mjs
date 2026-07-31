#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePairwiseCoveringArray } from "./pairwise.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(resolve(root, "schemas", "v1-config.schema.json"), "utf8"));
const mapping = JSON.parse(
  readFileSync(resolve(root, "fixture", "spec", "mapping-spec.json"), "utf8")
);
const publicDefaults = new Map();
for (const invariant of mapping.invariants) {
  if (invariant.assert?.op === "eq"
    && invariant.assert.left?.path
    && Object.hasOwn(invariant.assert.right ?? {}, "value")) {
    publicDefaults.set(invariant.assert.left.path, invariant.assert.right.value);
  }
  if (invariant.assert?.op === "in" && invariant.assert.value?.path
    && invariant.assert.set?.length > 0) {
    publicDefaults.set(invariant.assert.value.path, invariant.assert.set[0]);
  }
  for (const match of invariant.diagnostic?.message?.matchAll(
    /([A-Za-z][A-Za-z0-9]*)\s+(-?\d+)\.\.-?\d+/gu
  ) ?? []) {
    publicDefaults.set(`${invariant.diagnostic.path}.${match[1]}`, Number(match[2]));
  }
}

export const GENERAL_GENERATOR_DEPENDENCIES = [
  "baseline/general-generate.mjs",
  "baseline/pairwise.mjs",
  "design/corpus-request.json",
  "fixture/spec/mapping-spec.json",
  "schemas/v1-config.schema.json"
];

function clone(value) {
  return structuredClone(value);
}

function pathParts(path) {
  return path.split(".");
}

function setPath(target, path, value) {
  const parts = pathParts(path);
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = clone(value);
}

function deletePath(target, path) {
  const parts = pathParts(path);
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor?.[part]) return;
    cursor = cursor[part];
  }
  delete cursor[parts.at(-1)];
}

function walkSchema(node, path = "", output = []) {
  output.push({ path, schema: node });
  if (node.type === "object" && node.properties) {
    for (const [name, child] of Object.entries(node.properties)) {
      walkSchema(child, path ? `${path}.${name}` : name, output);
    }
  }
  return output;
}

function defaultFor(node, path) {
  if (publicDefaults.has(path)) return clone(publicDefaults.get(path));
  if (path === "version") return mapping.sourceVersion;
  if (node.enum) return node.enum[0];
  if (node.type === "object") {
    const result = {};
    for (const name of node.required ?? []) {
      result[name] = defaultFor(node.properties[name], path ? `${path}.${name}` : name);
    }
    return result;
  }
  if (node.type === "array") return [];
  if (node.type === "boolean") return false;
  if (node.type === "integer") return 1;
  if (node.type === "string") return "value";
  return null;
}

function baseInput() {
  return defaultFor(schema, "");
}

function draft(description, sourceTag, mutate) {
  const input = baseInput();
  mutate(input);
  return { description, input, sourceTags: [sourceTag] };
}

function enumDrafts(entries) {
  return entries
    .filter((entry) => entry.path && Array.isArray(entry.schema.enum))
    .flatMap((entry) => entry.schema.enum.map((value) =>
      draft(`Enum ${entry.path} = ${JSON.stringify(value)}`, "schema-enumeration",
        (input) => setPath(input, entry.path, value))));
}

function optionalDrafts(entries) {
  const drafts = [];
  for (const entry of entries.filter((item) =>
    item.schema.type === "object" && item.schema.properties)) {
    const required = new Set(entry.schema.required ?? []);
    for (const [name, child] of Object.entries(entry.schema.properties)) {
      if (required.has(name)) continue;
      const path = entry.path ? `${entry.path}.${name}` : name;
      drafts.push(draft(`Optional ${path} present`, "schema-optional",
        (input) => setPath(input, path, defaultFor(child, path))));
      drafts.push(draft(`Optional ${path} absent`, "schema-optional",
        (input) => deletePath(input, path)));
    }
  }
  return drafts;
}

function publicValueDrafts(entries) {
  const knownPaths = new Set(entries.map((entry) => entry.path));
  const values = new Map();
  const add = (path, value) => {
    if (!knownPaths.has(path)) return;
    if (!values.has(path)) values.set(path, new Map());
    values.get(path).set(JSON.stringify(value), value);
  };
  for (const rule of mapping.rules) {
    for (const value of Object.keys(rule.map ?? {})) add(rule.source, value);
    for (const value of rule.legacy ?? []) add(rule.source, value);
    for (const value of Object.values(rule.defaultPorts ?? {})) {
      add(`${rule.source}.port`, value);
    }
  }
  for (const invariant of mapping.invariants) {
    const assert = invariant.assert ?? {};
    if (assert.value?.path && Array.isArray(assert.set)) {
      for (const value of assert.set) add(assert.value.path, value);
      add(assert.value.path, "__outside_public_set__");
    }
    if (assert.left?.path && Object.hasOwn(assert.right ?? {}, "value")) {
      add(assert.left.path, assert.right.value);
    }
    const when = invariant.when ?? {};
    if (when.left?.path && Object.hasOwn(when.right ?? {}, "value")) {
      add(when.left.path, when.right.value);
    }
  }
  return [...values].flatMap(([path, byValue]) => [...byValue.values()].map((value) =>
    draft(`Public contract value ${path} = ${JSON.stringify(value)}`, "public-contract-value",
      (input) => setPath(input, path, value))));
}

function integerBoundaryDrafts(entries) {
  const integers = entries.filter((entry) => entry.path && entry.schema.type === "integer");
  const publicNumbers = new Set([0, 1, -1]);
  const visit = (value) => {
    if (typeof value === "number" && Number.isSafeInteger(value)) publicNumbers.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
    else if (typeof value === "string") {
      for (const match of value.matchAll(/-?\d+/gu)) publicNumbers.add(Number(match[0]));
    }
  };
  visit(mapping);
  const boundaries = [...publicNumbers]
    .flatMap((value) => [value - 1, value, value + 1])
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
  return integers.flatMap((entry, index) =>
    boundaries.slice(index % 5, (index % 5) + 8).map((value) =>
      draft(`Generic integer boundary ${entry.path} = ${value}`, "generic-boundary",
        (input) => setPath(input, entry.path, value))));
}

function stringAndCollectionDrafts(entries) {
  const drafts = [];
  const strings = ["", " ", "value", "VALUE", "value with spaces", "__unknown__", "https://example.test", "*"];
  for (const entry of entries.filter((item) =>
    item.path && item.schema.type === "string" && !item.schema.enum)) {
    for (const value of strings) {
      drafts.push(draft(`Generic string partition ${entry.path}`, "generic-string-partition",
        (input) => setPath(input, entry.path, value)));
    }
  }
  for (const entry of entries.filter((item) => item.path && item.schema.type === "array")) {
    for (const value of [[], ["value"], ["value", "value"], ["*"], ["https://example.test"]]) {
      drafts.push(draft(`Generic array partition ${entry.path}`, "generic-collection-partition",
        (input) => setPath(input, entry.path, value)));
    }
  }
  for (const entry of entries.filter((item) =>
    item.path && item.schema.type === "object"
    && item.schema.additionalProperties?.type === "boolean")) {
    for (const value of [{}, { alpha: true }, { alpha: true, beta: false }, { "A B": true, "a-b": false }]) {
      drafts.push(draft(`Generic map partition ${entry.path}`, "generic-collection-partition",
        (input) => setPath(input, entry.path, value)));
    }
  }
  return drafts;
}

function pairwiseDrafts(entries) {
  const factors = Object.fromEntries(entries
    .filter((entry) => entry.path && Array.isArray(entry.schema.enum))
    .map((entry) => [entry.path, entry.schema.enum]));
  if (Object.keys(factors).length < 2) return [];
  return generatePairwiseCoveringArray(factors).map((row, index) =>
    draft(`Schema pairwise row ${index + 1}`, "schema-pairwise", (input) => {
      for (const [path, value] of Object.entries(row)) setPath(input, path, value);
    }));
}

function seededDrafts(entries, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const leaves = entries.filter((entry) => entry.path && entry.schema.type !== "object");
  return Array.from({ length: 40 }, (_, index) =>
    draft(`Seeded generic schema sample ${index + 1}`, "seeded-schema-property", (input) => {
      for (const entry of leaves) {
        if (entry.schema.enum) {
          setPath(input, entry.path,
            entry.schema.enum[Math.floor(random() * entry.schema.enum.length)]);
        } else if (entry.schema.type === "boolean") {
          setPath(input, entry.path, random() >= 0.5);
        } else if (entry.schema.type === "integer") {
          setPath(input, entry.path, Math.floor(random() * 20) - 3);
        } else if (entry.schema.type === "string") {
          setPath(input, entry.path, `value-${index}-${Math.floor(random() * 1000)}`);
        }
      }
    }));
}

function shuffle(values, seed) {
  const output = [...values];
  let state = seed >>> 0;
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (1664525 * state + 1013904223) >>> 0;
    const swap = Math.floor((state / 0x100000000) * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

export function generateGeneralBaseline({ seed = 20260729, blockId = "B00" } = {}) {
  const entries = walkSchema(schema);
  const pools = [
    pairwiseDrafts(entries),
    enumDrafts(entries),
    optionalDrafts(entries),
    publicValueDrafts(entries),
    integerBoundaryDrafts(entries),
    stringAndCollectionDrafts(entries),
    seededDrafts(entries, seed)
  ].map((pool, index) => shuffle(pool, (seed + index) >>> 0));
  const selected = [];
  const byInput = new Set();
  const cursors = pools.map(() => 0);
  while (selected.length < 60) {
    let progressed = false;
    for (let pool = 0; pool < pools.length && selected.length < 60; pool += 1) {
      while (cursors[pool] < pools[pool].length) {
        const candidate = pools[pool][cursors[pool]++];
        const key = JSON.stringify(candidate.input);
        if (byInput.has(key)) continue;
        byInput.add(key);
        selected.push(candidate);
        progressed = true;
        break;
      }
    }
    if (!progressed) throw new Error(`Only ${selected.length} unique general cases generated`);
  }
  return {
    formatVersion: 1,
    generator: { armId: 0, blockId, seed },
    cases: selected.map((item, index) => ({
      id: `G${String(index + 1).padStart(3, "0")}`,
      description: item.description,
      input: item.input,
      sourceTags: item.sourceTags
    }))
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--out");
  if (outputIndex < 0 || !args[outputIndex + 1]) {
    throw new Error("Usage: node baseline/general-generate.mjs --out <file> [--seed <n>] [--block <id>]");
  }
  const seedIndex = args.indexOf("--seed");
  const blockIndex = args.indexOf("--block");
  const seed = seedIndex >= 0 ? Number(args[seedIndex + 1]) : 20260729;
  const blockId = blockIndex >= 0 ? args[blockIndex + 1] : "B00";
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  const target = resolve(args[outputIndex + 1]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(generateGeneralBaseline({ seed, blockId }), null, 2)}\n`);
  process.stdout.write(`Generated 60 general deterministic cases at ${target}\n`);
}
