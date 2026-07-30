import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../../validators/json-schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(resolve(here, "..", "spec", "mapping-spec.json"), "utf8"));
const schemaDir = resolve(here, "..", "..", "schemas");
const v1Schema = JSON.parse(readFileSync(resolve(schemaDir, "v1-config.schema.json"), "utf8"));

function get(object, path) {
  return path.split(".").reduce((value, part) => value?.[part], object);
}

function set(object, path, value) {
  const parts = path.split(".");
  let cursor = object;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
  cursor[parts.at(-1)] = value;
}

function slug(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function featureName(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeOrigin(value) {
  if (value === "*") return value;
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function effectiveServicePort(input) {
  return input.service.port ?? ({ dev: 3000, test: 4000, prod: 8080 }[input.service.environment]);
}

function effectiveDatabasePort(input) {
  if (input.database.engine === "sqlite") return undefined;
  return input.database.port ?? ({ postgres: 5432, mysql: 3306 }[input.database.engine]);
}

function customPredicate(name, input) {
  const predicates = {
    nonBlankServiceName: () => slug(input.service.name).length > 0,
    validServicePort: () => input.service.port === undefined
      || (Number.isInteger(input.service.port) && input.service.port >= 1 && input.service.port <= 65535),
    validCacheTtl: () => Number.isInteger(input.cache.ttlSeconds)
      && input.cache.ttlSeconds >= 1 && input.cache.ttlSeconds <= 86400,
    enabledRedisCache: () => input.cache.enabled === true && input.cache.provider === "redis",
    validRedisEndpoint: () => typeof input.cache.endpoint === "string"
      && /^rediss?:\/\/[^/\s]+(?::\d+)?(?:\/\d+)?$/i.test(input.cache.endpoint),
    prodRemoteDatabase: () => input.service.environment === "prod" && input.database.engine !== "sqlite",
    remoteDatabase: () => input.database.engine !== "sqlite",
    distinctEffectivePorts: () => effectiveServicePort(input) !== effectiveDatabasePort(input),
    validRetryBounds: () => Number.isInteger(input.retries.maxAttempts)
      && input.retries.maxAttempts >= 0 && input.retries.maxAttempts <= 10
      && Number.isInteger(input.retries.delayMs)
      && input.retries.delayMs >= 100 && input.retries.delayMs <= 10000,
    prodCorsHasNoWildcard: () => !input.security.allowedOrigins.includes("*"),
    featureNamesDoNotCollide: () => {
      const names = Object.keys(input.features.flags).map(featureName);
      return names.every(Boolean) && new Set(names).size === names.length;
    },
    validOriginSyntax: () => input.security.allowedOrigins.every((origin) =>
      origin === "*" || /^https?:\/\/[^/?#\s]+\/?$/i.test(origin))
  };
  return predicates[name]();
}

function evaluate(expression, input) {
  const operand = (value) => "path" in value ? get(input, value.path) : value.value;
  switch (expression.op) {
    case "always": return true;
    case "custom": return customPredicate(expression.name, input);
    case "eq": return operand(expression.left) === operand(expression.right);
    case "notEq": return operand(expression.left) !== operand(expression.right);
    case "gte": return operand(expression.left) >= operand(expression.right);
    case "in": return expression.set.includes(operand(expression.value));
    default: throw new Error(`Unsupported invariant operation: ${expression.op}`);
  }
}

function diagnostic(base, severity = "error") {
  return { ...base, severity };
}

function finalize(config, diagnostics, trace) {
  diagnostics.sort((a, b) =>
    a.severity.localeCompare(b.severity) || a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  for (const values of Object.values(trace)) values.sort();
  const invalid = diagnostics.some((item) => item.severity === "error");
  return { status: invalid ? "invalid" : "ok", config: invalid ? null : config, diagnostics, trace };
}

function executeRule(rule, input, output, diagnostics, trace) {
  trace.rules.push(rule.id);
  const source = get(input, rule.source);

  switch (rule.op) {
    case "slug": {
      const normalized = slug(source);
      set(output, rule.target, normalized);
      trace.paths.push(normalized === source ? "P-NAME-AS-IS" : "P-NAME-NORMALIZED");
      if (normalized !== source) {
        diagnostics.push(diagnostic({
          id: "W-NAME-NORMALIZED",
          category: "normalization",
          path: rule.source,
          message: `service name normalized to '${normalized}'.`
        }, "warning"));
      }
      break;
    }
    case "copy":
      set(output, rule.target, source);
      trace.paths.push(`P-ENV-${String(source).toUpperCase()}`);
      break;
    case "lookup": {
      set(output, rule.target, rule.map[source] ?? null);
      if (rule.id === "R-REGION") {
        const known = source in rule.map;
        trace.paths.push(!known ? "P-REGION-UNKNOWN" : rule.legacy.includes(source) ? "P-REGION-LEGACY" : "P-REGION-CANONICAL");
        if (rule.legacy.includes(source)) {
          diagnostics.push(diagnostic({
            id: "W-REGION-LEGACY",
            category: "deprecation",
            path: rule.source,
            message: `legacy region '${source}' mapped to '${rule.map[source]}'.`
          }, "warning"));
        }
      } else {
        trace.paths.push(source === "warn" ? "P-LOG-LEVEL-WARN" : "P-LOG-LEVEL-DIRECT");
      }
      break;
    }
    case "defaultByEnvironment": {
      const environment = input.service.environment;
      const value = source ?? rule.defaults[environment];
      set(output, rule.target, value);
      trace.paths.push(source === undefined ? `P-PORT-DEFAULT-${environment.toUpperCase()}` : "P-PORT-EXPLICIT");
      break;
    }
    case "secondsToMillisecondsDefault": {
      const environment = input.service.environment;
      const seconds = source ?? rule.defaults[environment];
      set(output, rule.target, seconds * 1000);
      trace.paths.push(source === undefined ? `P-TIMEOUT-DEFAULT-${environment.toUpperCase()}` : "P-TIMEOUT-EXPLICIT");
      break;
    }
    case "logFormat": {
      const prodForced = input.service.environment === "prod" && source === true;
      set(output, rule.target, source === true && !prodForced ? "pretty" : "json");
      trace.paths.push(prodForced ? "P-LOG-FORMAT-PROD-FORCED-JSON" : source === true ? "P-LOG-FORMAT-PRETTY" : "P-LOG-FORMAT-JSON");
      if (prodForced) {
        diagnostics.push(diagnostic({
          id: "W-PROD-PRETTY",
          category: "ignored-input",
          path: rule.source,
          message: "pretty logging is ignored in prod."
        }, "warning"));
      }
      break;
    }
    case "cache": {
      if (!source.enabled) {
        set(output, rule.target, { strategy: "none", ttlMs: 0 });
        trace.paths.push("P-CACHE-NONE");
        if (source.provider !== undefined || source.ttlSeconds !== undefined || source.endpoint !== undefined) {
          diagnostics.push(diagnostic({
            id: "W-CACHE-IGNORED",
            category: "ignored-input",
            path: rule.source,
            message: "provider, ttlSeconds, and endpoint are ignored when cache is disabled."
          }, "warning"));
        }
      } else {
        const provider = source.provider ?? "memory";
        const mapped = { strategy: provider, ttlMs: source.ttlSeconds * 1000 };
        if (provider === "redis") mapped.endpoint = source.endpoint;
        set(output, rule.target, mapped);
        trace.paths.push(provider === "redis" ? "P-CACHE-REDIS" : "P-CACHE-MEMORY");
      }
      break;
    }
    case "database": {
      if (source.engine === "sqlite") {
        set(output, rule.target, { driver: rule.drivers.sqlite, database: source.name });
        trace.paths.push("P-DB-SQLITE");
      } else {
        const explicit = source.port !== undefined;
        set(output, rule.target, {
          driver: rule.drivers[source.engine],
          host: source.host ?? "localhost",
          port: source.port ?? rule.defaultPorts[source.engine],
          database: source.name,
          tlsMode: source.ssl === true ? "require" : "disable"
        });
        trace.paths.push("P-DB-REMOTE");
        trace.paths.push(explicit ? "P-DB-PORT-EXPLICIT" : `P-DB-PORT-DEFAULT-${source.engine.toUpperCase()}`);
      }
      break;
    }
    case "retries": {
      const exponential = source.mode === "exponential";
      const uncapped = exponential ? source.delayMs * (2 ** Math.max(0, source.maxAttempts - 1)) : source.delayMs;
      set(output, rule.target, {
        strategy: source.mode,
        attempts: source.maxAttempts,
        initialDelayMs: source.delayMs,
        maxDelayMs: Math.min(60000, uncapped)
      });
      trace.paths.push(exponential ? "P-RETRY-EXPONENTIAL" : "P-RETRY-FIXED");
      if (uncapped > 60000) trace.paths.push("P-RETRY-MAX-CAPPED");
      break;
    }
    case "sortedUnique": {
      const normalized = source.map(normalizeOrigin);
      const unique = [...new Set(normalized)].sort();
      set(output, rule.target, unique);
      const changed = JSON.stringify(unique) !== JSON.stringify(source);
      trace.paths.push(changed ? "P-CORS-NORMALIZED" : "P-CORS-AS-IS");
      if (changed) {
        diagnostics.push(diagnostic({
          id: "W-ORIGIN-DEDUP",
          category: "normalization",
          path: rule.source,
          message: "CORS origins were canonicalized, sorted, or deduplicated."
        }, "warning"));
      }
      break;
    }
    case "featureArray": {
      const entries = Object.entries(source).map(([name, enabled]) => ({ name: featureName(name), enabled }));
      const sorted = entries.toSorted((a, b) => a.name.localeCompare(b.name));
      set(output, rule.target, sorted);
      if (entries.length === 0) {
        trace.paths.push("P-FEATURES-EMPTY");
      } else {
        const original = Object.entries(source).map(([name, enabled]) => ({ name, enabled }));
        const changed = JSON.stringify(sorted) !== JSON.stringify(original);
        trace.paths.push(changed ? "P-FEATURES-NORMALIZED" : "P-FEATURES-AS-IS");
        if (changed) {
          diagnostics.push(diagnostic({
            id: "W-FEATURE-NORMALIZED",
            category: "normalization",
            path: rule.source,
            message: "feature names were normalized and sorted."
          }, "warning"));
        }
      }
      break;
    }
    default:
      throw new Error(`Unsupported mapping operation: ${rule.op}`);
  }
}

export function migrateV1ToV2(input) {
  const shapeErrors = validateJsonSchema(input, v1Schema, { schemaDir });
  if (shapeErrors.length > 0) {
    const diagnostics = shapeErrors.map((error) => diagnostic({
      id: "D-SCHEMA",
      category: "schema",
      path: error.path.slice(2),
      message: error.message
    }));
    return finalize(null, diagnostics, {
      rules: ["R-INPUT-SCHEMA"],
      paths: ["P-SCHEMA-INVALID"],
      invariants: []
    });
  }

  const diagnostics = [];
  const trace = { rules: [], paths: [], invariants: [] };
  for (const invariant of spec.invariants) {
    if (!evaluate(invariant.when, input)) continue;
    trace.invariants.push(invariant.id);
    const passed = evaluate(invariant.assert, input);
    trace.paths.push(invariant.paths[passed ? 0 : 1]);
    if (!passed) diagnostics.push(diagnostic(invariant.diagnostic));
  }

  const output = { apiVersion: spec.targetVersion };
  for (const rule of spec.rules) executeRule(rule, input, output, diagnostics, trace);
  return finalize(output, diagnostics, trace);
}

export { spec as mappingSpec };
