#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FiniteDomainSolver } from "./finite-domain-solver.mjs";
import { generatePairwiseCoveringArray } from "./pairwise.mjs";

export const PAIRWISE_FACTORS = {
  environment: ["dev", "test", "prod"],
  region: ["eastus", "us", "westeurope"],
  cache: ["none", "memory", "redis"],
  database: ["postgres", "mysql", "sqlite"],
  retry: ["fixed", "exponential"],
  pretty: [false, true]
};

function clone(value) {
  return structuredClone(value);
}

function baseInput() {
  return {
    version: 1,
    service: { name: "api", environment: "dev", region: "eastus" },
    logging: { level: "info", pretty: false },
    cache: { enabled: false },
    database: { engine: "postgres", host: "db.internal", name: "app", ssl: false },
    retries: { mode: "fixed", maxAttempts: 3, delayMs: 500 },
    security: { allowedOrigins: ["https://example.test"] },
    features: { flags: { alpha: true } }
  };
}

function draft(description, sourceTag, mutate) {
  const input = baseInput();
  mutate(input);
  return { description, input, sourceTags: [sourceTag] };
}

function setProdSafe(input) {
  if (input.service.environment !== "prod") return;
  input.logging.level = "info";
  input.security.allowedOrigins = ["https://prod.example.test"];
  if (input.database.engine !== "sqlite") input.database.ssl = true;
}

function decisionTableDrafts() {
  const rows = [];
  const add = (description, mutate) => rows.push(draft(description, "decision-table", mutate));
  add("Development defaults", () => {});
  add("Test environment defaults", (input) => { input.service.environment = "test"; });
  add("Production defaults with TLS", (input) => { input.service.environment = "prod"; setProdSafe(input); });
  add("Legacy US region", (input) => { input.service.region = "us"; });
  add("Legacy EU region", (input) => { input.service.region = "eu"; });
  add("Legacy APAC region", (input) => { input.service.region = "apac"; });
  add("Canonical western Europe region", (input) => { input.service.region = "westeurope"; });
  add("Canonical southeast Asia region", (input) => { input.service.region = "southeastasia"; });
  add("Unknown region diagnostic", (input) => { input.service.region = "moonbase"; });
  add("Explicit service port and timeout", (input) => { input.service.port = 9090; input.service.timeoutSeconds = 7; });
  add("Warn level conversion", (input) => { input.logging.level = "warn"; });
  add("Pretty development logging", (input) => { input.logging.pretty = true; });
  add("Pretty production logging is forced to JSON", (input) => {
    input.service.environment = "prod"; input.logging.pretty = true; setProdSafe(input);
  });
  add("Disabled cache ignores stale fields", (input) => {
    input.cache = { enabled: false, provider: "redis", ttlSeconds: 30, endpoint: "redis://old:6379" };
  });
  add("Memory cache", (input) => { input.cache = { enabled: true, provider: "memory", ttlSeconds: 60 }; });
  add("Redis cache", (input) => {
    input.cache = { enabled: true, provider: "redis", ttlSeconds: 300, endpoint: "rediss://cache.internal:6380/1" };
  });
  add("Redis endpoint violation", (input) => {
    input.cache = { enabled: true, provider: "redis", ttlSeconds: 300, endpoint: "https://cache.invalid" };
  });
  add("SQLite development database", (input) => { input.database = { engine: "sqlite", name: "local.db" }; });
  add("SQLite production violation", (input) => {
    input.service.environment = "prod";
    input.database = { engine: "sqlite", name: "prod.db" };
    input.security.allowedOrigins = ["https://prod.example.test"];
  });
  add("MySQL default port", (input) => { input.database = { engine: "mysql", host: "mysql.internal", name: "app", ssl: false }; });
  add("Production remote database without TLS", (input) => {
    input.service.environment = "prod"; input.database.ssl = false; input.security.allowedOrigins = ["https://prod.example.test"];
  });
  add("Service and database port conflict", (input) => { input.service.port = 5432; });
  add("Fixed retry strategy", (input) => { input.retries = { mode: "fixed", maxAttempts: 0, delayMs: 100 }; });
  add("Exponential retry strategy", (input) => { input.retries = { mode: "exponential", maxAttempts: 4, delayMs: 1000 }; });
  add("Exponential retry cap", (input) => { input.retries = { mode: "exponential", maxAttempts: 10, delayMs: 10000 }; });
  add("Exponential attempts violation", (input) => { input.retries = { mode: "exponential", maxAttempts: 1, delayMs: 500 }; });
  add("Production debug violation", (input) => {
    input.service.environment = "prod"; setProdSafe(input); input.logging.level = "debug";
  });
  add("Production wildcard CORS violation", (input) => {
    input.service.environment = "prod"; setProdSafe(input); input.security.allowedOrigins = ["*"];
  });
  add("CORS canonicalization and duplicate removal", (input) => {
    input.security.allowedOrigins = ["https://B.example.test", "https://a.example.test", "https://A.example.test/"];
  });
  add("Empty feature flags", (input) => { input.features.flags = {}; });
  add("Feature normalization and sorting", (input) => { input.features.flags = { "New UI": true, alpha: false }; });
  add("Feature normalization collision", (input) => { input.features.flags = { "New UI": true, "new-ui": false }; });
  add("Unsupported source version", (input) => { input.version = 2; });
  add("Explicit database port", (input) => { input.database.port = 5544; });
  return rows;
}

function boundaryDrafts() {
  const rows = [];
  const add = (description, mutate) => rows.push(draft(description, "boundary-partition", mutate));
  for (const port of [1, 65535, 0, 65536]) {
    add(`Service port boundary ${port}`, (input) => { input.service.port = port; });
  }
  for (const ttl of [1, 86400, 0, 86401]) {
    add(`Cache TTL boundary ${ttl}`, (input) => { input.cache = { enabled: true, provider: "memory", ttlSeconds: ttl }; });
  }
  for (const attempts of [0, 10, -1, 11]) {
    add(`Retry-attempt boundary ${attempts}`, (input) => { input.retries.maxAttempts = attempts; });
  }
  for (const delay of [100, 10000, 99, 10001]) {
    add(`Retry-delay boundary ${delay}`, (input) => { input.retries.delayMs = delay; });
  }
  return rows;
}

function applyPairwise(row, index) {
  return draft(`Pairwise covering row ${index + 1}`, "pairwise-covering", (input) => {
    input.service.environment = row.environment;
    input.service.region = row.region;
    input.logging.pretty = row.pretty;
    if (row.cache === "none") input.cache = { enabled: false };
    if (row.cache === "memory") input.cache = { enabled: true, provider: "memory", ttlSeconds: 60 };
    if (row.cache === "redis") {
      input.cache = { enabled: true, provider: "redis", ttlSeconds: 60, endpoint: "redis://cache.internal:6379" };
    }
    if (row.database === "sqlite") input.database = { engine: "sqlite", name: "pairwise.db" };
    if (row.database === "mysql") input.database = { engine: "mysql", host: "mysql.internal", name: "app", ssl: false };
    input.retries = row.retry === "fixed"
      ? { mode: "fixed", maxAttempts: 3, delayMs: 500 }
      : { mode: "exponential", maxAttempts: 3, delayMs: 500 };
    setProdSafe(input);
  });
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function grammarDrafts(seed) {
  const random = seededRandom(seed);
  const words = ["Billing API", "edge_worker", "Search.v2", "  Audit  Log  ", "MIXED Case"];
  const origins = ["https://EXAMPLE.test", "http://localhost:8080", "https://sub.example.test/"];
  const rows = [];
  for (let index = 0; index < 16; index += 1) {
    rows.push(draft(`Seeded grammar/property sample ${index + 1}`, "grammar-property", (input) => {
      input.service.name = `${words[Math.floor(random() * words.length)]} ${index}`;
      input.service.timeoutSeconds = 1 + Math.floor(random() * 120);
      input.security.allowedOrigins = [
        origins[Math.floor(random() * origins.length)],
        origins[Math.floor(random() * origins.length)]
      ];
      input.features.flags = {
        [`Feature ${String.fromCharCode(65 + (index % 8))}`]: random() >= 0.5,
        stable: random() >= 0.5
      };
      if (index % 5 === 0) input.security.allowedOrigins = ["https://example.test/path"];
      if (index % 7 === 0) input.service.name = "!!!";
    }));
  }
  return rows;
}

function solverDrafts() {
  const solver = new FiniteDomainSolver({
    environment: ["dev", "test", "prod"],
    cache: ["none", "memory", "redis"],
    database: ["postgres", "mysql", "sqlite"],
    retry: ["fixed", "exponential"],
    pretty: [false, true]
  });
  solver
    .addConstraint(["environment", "database"], ({ environment, database }) =>
      environment !== "prod" || database !== "sqlite")
    .addConstraint(["cache", "retry", "pretty"], ({ cache, retry, pretty }) =>
      [cache !== "none", retry === "exponential", pretty].filter(Boolean).length >= 2);

  return solver.solve(16).map((assignment, index) =>
    draft(`Finite-domain conjunction ${index + 1}`, "constraint-solver", (input) => {
      input.service.environment = assignment.environment;
      input.logging.pretty = assignment.pretty;
      input.cache = assignment.cache === "none"
        ? { enabled: false, ttlSeconds: 42 }
        : assignment.cache === "memory"
          ? { enabled: true, provider: "memory", ttlSeconds: 42 }
          : { enabled: true, provider: "redis", ttlSeconds: 42, endpoint: "redis://solver.internal:6379" };
      input.database = assignment.database === "sqlite"
        ? { engine: "sqlite", name: "solver.db" }
        : { engine: assignment.database, host: "solver-db.internal", name: "app", ssl: assignment.environment === "prod" };
      input.retries = assignment.retry === "fixed"
        ? { mode: "fixed", maxAttempts: 2, delayMs: 250 }
        : { mode: "exponential", maxAttempts: 5, delayMs: 250 };
      setProdSafe(input);
    }));
}

function mergeDraft(target, incoming) {
  for (const tag of incoming.sourceTags) if (!target.sourceTags.includes(tag)) target.sourceTags.push(tag);
}

export function generateBaseline(options = {}) {
  const seed = options.seed ?? 20260729;
  const blockId = options.blockId ?? "B00";
  const pairwiseRows = generatePairwiseCoveringArray(PAIRWISE_FACTORS);
  const pools = {
    "pairwise-covering": pairwiseRows.map(applyPairwise),
    "decision-table": decisionTableDrafts(),
    "boundary-partition": boundaryDrafts(),
    "grammar-property": grammarDrafts(seed),
    "constraint-solver": solverDrafts()
  };
  const selected = [];
  const byInput = new Map();

  const add = (item) => {
    const key = JSON.stringify(item.input);
    if (byInput.has(key)) {
      mergeDraft(byInput.get(key), item);
      return false;
    }
    const copy = clone(item);
    selected.push(copy);
    byInput.set(key, copy);
    return true;
  };

  for (const item of pools["pairwise-covering"]) add(item);
  const criticalDecisionRows = [8, 9, 10, 12, 13, 16, 18, 20, 21, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33];
  for (const index of criticalDecisionRows) add(pools["decision-table"][index]);
  for (const item of pools["boundary-partition"]) add(item);
  for (const item of pools["grammar-property"].slice(0, 4)) add(item);
  for (const item of pools["constraint-solver"].slice(0, 8)) add(item);

  const cursors = Object.fromEntries(Object.keys(pools).map((tag) => [tag, 0]));
  const order = ["decision-table", "boundary-partition", "grammar-property", "constraint-solver"];
  while (selected.length < 60) {
    let progressed = false;
    for (const tag of order) {
      while (cursors[tag] < pools[tag].length) {
        const item = pools[tag][cursors[tag]++];
        if (add(item)) {
          progressed = true;
          break;
        }
      }
      if (selected.length === 60) break;
    }
    if (!progressed) throw new Error(`Only ${selected.length} unique baseline cases could be generated.`);
  }

  return {
    formatVersion: 1,
    generator: { armId: 0, blockId, seed },
    cases: selected.map((item, index) => ({
      id: `B${String(index + 1).padStart(3, "0")}`,
      description: item.description,
      input: item.input,
      sourceTags: item.sourceTags.toSorted()
    }))
  };
}

function parseOutput(args) {
  const index = args.indexOf("--out");
  if (index < 0 || !args[index + 1]) throw new Error("Usage: node baseline/generate.mjs --out <file>");
  return resolve(args[index + 1]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const output = parseOutput(args);
  const seedIndex = args.indexOf("--seed");
  const blockIndex = args.indexOf("--block");
  const seed = seedIndex >= 0 ? Number(args[seedIndex + 1]) : 20260729;
  const blockId = blockIndex >= 0 ? args[blockIndex + 1] : "B00";
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(generateBaseline({ seed, blockId }), null, 2)}\n`);
  process.stdout.write(`Generated 60 deterministic staging cases at ${output}\n`);
}
