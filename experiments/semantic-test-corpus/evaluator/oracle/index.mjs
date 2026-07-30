const REGIONS = new Map([
  ["eastus", "eastus"],
  ["westeurope", "westeurope"],
  ["southeastasia", "southeastasia"],
  ["us", "eastus"],
  ["eu", "westeurope"],
  ["apac", "southeastasia"]
]);

const LEGACY_REGIONS = new Set(["us", "eu", "apac"]);

export function compareCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] < rightPoints[index] ? -1 : 1;
  }
  return Math.sign(leftPoints.length - rightPoints.length);
}

function slugName(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function canonicalFeature(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function canonicalOrigin(value) {
  if (value === "*") return value;
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function validPort(url) {
  if (url.port === "") return true;
  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function rawAuthorityAndSuffix(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const scheme = value.indexOf("://");
  if (scheme < 0) return null;
  const remainder = value.slice(scheme + 3);
  const boundary = remainder.search(/[/?#]/);
  return {
    authority: boundary < 0 ? remainder : remainder.slice(0, boundary),
    suffix: boundary < 0 ? "" : remainder.slice(boundary)
  };
}

function validHttpOrigin(value) {
  if (value === "*") return true;
  const raw = rawAuthorityAndSuffix(value);
  if (!raw || raw.authority.includes("@") || !["", "/"].includes(raw.suffix)) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && url.hostname.length > 0
      && url.username === ""
      && url.password === ""
      && validPort(url)
      && url.pathname === "/"
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function validRedisEndpoint(value) {
  const raw = rawAuthorityAndSuffix(value);
  if (!raw || raw.authority.includes("@") || !/^(?:|\/\d+)$/.test(raw.suffix)) return false;
  try {
    const url = new URL(value);
    return ["redis:", "rediss:"].includes(url.protocol)
      && url.hostname.length > 0
      && url.username === ""
      && url.password === ""
      && validPort(url)
      && (url.pathname === "" || /^\/\d+$/.test(url.pathname))
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function addDiagnostic(list, id, category, path, message, severity = "error") {
  list.push({ id, category, path, message, severity });
}

function topLevelShapeError(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { path: "", message: "must be object" };
  const required = ["version", "service", "logging", "cache", "database", "retries", "security", "features"];
  for (const key of required) if (!(key in input)) return { path: key, message: "is required" };
  return null;
}

function sortedResult(config, diagnostics, trace) {
  diagnostics.sort((a, b) =>
    compareCodePoints(a.severity, b.severity)
      || compareCodePoints(a.id, b.id)
      || compareCodePoints(a.path, b.path));
  trace.rules.sort();
  trace.paths.sort();
  trace.invariants.sort();
  const invalid = diagnostics.some(({ severity }) => severity === "error");
  return { status: invalid ? "invalid" : "ok", config: invalid ? null : config, diagnostics, trace };
}

function checkInvariant(trace, diagnostics, id, applicable, passed, detail) {
  if (!applicable) return;
  trace.invariants.push(id);
  trace.paths.push(`P-${id}-${passed ? "PASS" : "FAIL"}`);
  if (!passed) addDiagnostic(diagnostics, detail.id, detail.category, detail.path, detail.message);
}

export function referenceOracle(input) {
  const shapeError = topLevelShapeError(input);
  if (shapeError) {
    return sortedResult(null, [{
      id: "D-SCHEMA",
      category: "schema",
      path: shapeError.path,
      message: shapeError.message,
      severity: "error"
    }], { rules: ["R-INPUT-SCHEMA"], paths: ["P-SCHEMA-INVALID"], invariants: [] });
  }

  const diagnostics = [];
  const trace = { rules: [], paths: [], invariants: [] };
  const invariantDetails = {
    "I-VERSION": ["D-VERSION", "domain", "version", "version must equal 1."],
    "I-SERVICE-NAME": ["D-SERVICE-NAME", "domain", "service.name", "service.name must contain a letter or digit."],
    "I-SERVICE-PORT": ["D-SERVICE-PORT", "domain", "service.port", "service.port must be an integer from 1 through 65535 when supplied."],
    "I-REGION": ["D-REGION", "domain", "service.region", "service.region is not recognized."],
    "I-PROD-DEBUG": ["D-PROD-DEBUG", "cross-field", "logging.level", "debug logging is forbidden in prod."],
    "I-CACHE-TTL": ["D-CACHE-TTL", "domain", "cache.ttlSeconds", "enabled cache requires ttlSeconds from 1 through 86400."],
    "I-REDIS-ENDPOINT": ["D-REDIS-ENDPOINT", "cross-field", "cache.endpoint", "redis cache requires a redis:// or rediss:// endpoint."],
    "I-SQLITE-PROD": ["D-SQLITE-PROD", "cross-field", "database.engine", "sqlite is forbidden in prod."],
    "I-PROD-DB-TLS": ["D-PROD-DB-TLS", "cross-field", "database.ssl", "prod remote databases require ssl=true."],
    "I-DB-PORT-CONFLICT": ["D-PORT-CONFLICT", "cross-field", "database.port", "service and database ports must differ."],
    "I-RETRY-BOUNDS": ["D-RETRY-BOUNDS", "domain", "retries", "retries require maxAttempts 0..10 and delayMs 100..10000."],
    "I-EXPONENTIAL-ATTEMPTS": ["D-EXPONENTIAL-ATTEMPTS", "cross-field", "retries.maxAttempts", "exponential retries require at least 2 attempts."],
    "I-PROD-CORS": ["D-PROD-CORS", "cross-field", "security.allowedOrigins", "prod CORS origins cannot contain '*'."],
    "I-FEATURE-COLLISION": ["D-FEATURE-COLLISION", "normalization", "features.flags", "feature names must remain unique after normalization."],
    "I-ORIGIN-SYNTAX": ["D-ORIGIN-SYNTAX", "domain", "security.allowedOrigins", "origins must be '*' or absolute http(s) origins without paths."]
  };
  const detail = (id) => {
    const [diagnosticId, category, path, message] = invariantDetails[id];
    return { id: diagnosticId, category, path, message };
  };
  const servicePort = input.service.port ?? ({ dev: 3000, test: 4000, prod: 8080 }[input.service.environment]);
  const databasePort = input.database.port ?? ({ postgres: 5432, mysql: 3306 }[input.database.engine]);
  const featureNames = Object.keys(input.features.flags).map(canonicalFeature);
  const originSyntaxValid = input.security.allowedOrigins.every(validHttpOrigin);

  checkInvariant(trace, diagnostics, "I-VERSION", true, input.version === 1, detail("I-VERSION"));
  checkInvariant(trace, diagnostics, "I-SERVICE-NAME", true, slugName(input.service.name).length > 0, detail("I-SERVICE-NAME"));
  checkInvariant(trace, diagnostics, "I-SERVICE-PORT", true,
    input.service.port === undefined || (Number.isInteger(input.service.port) && input.service.port >= 1 && input.service.port <= 65535),
    detail("I-SERVICE-PORT"));
  checkInvariant(trace, diagnostics, "I-REGION", true, REGIONS.has(input.service.region), detail("I-REGION"));
  checkInvariant(trace, diagnostics, "I-PROD-DEBUG", input.service.environment === "prod",
    input.logging.level !== "debug", detail("I-PROD-DEBUG"));
  checkInvariant(trace, diagnostics, "I-CACHE-TTL", input.cache.enabled === true,
    Number.isInteger(input.cache.ttlSeconds) && input.cache.ttlSeconds >= 1 && input.cache.ttlSeconds <= 86400,
    detail("I-CACHE-TTL"));
  checkInvariant(trace, diagnostics, "I-REDIS-ENDPOINT", input.cache.enabled === true && input.cache.provider === "redis",
    validRedisEndpoint(input.cache.endpoint),
    detail("I-REDIS-ENDPOINT"));
  checkInvariant(trace, diagnostics, "I-SQLITE-PROD", input.database.engine === "sqlite",
    input.service.environment !== "prod", detail("I-SQLITE-PROD"));
  checkInvariant(trace, diagnostics, "I-PROD-DB-TLS",
    input.service.environment === "prod" && input.database.engine !== "sqlite",
    input.database.ssl === true, detail("I-PROD-DB-TLS"));
  checkInvariant(trace, diagnostics, "I-DB-PORT-CONFLICT", input.database.engine !== "sqlite",
    servicePort !== databasePort, detail("I-DB-PORT-CONFLICT"));
  checkInvariant(trace, diagnostics, "I-RETRY-BOUNDS", true,
    Number.isInteger(input.retries.maxAttempts) && input.retries.maxAttempts >= 0 && input.retries.maxAttempts <= 10
      && Number.isInteger(input.retries.delayMs) && input.retries.delayMs >= 100 && input.retries.delayMs <= 10000,
    detail("I-RETRY-BOUNDS"));
  checkInvariant(trace, diagnostics, "I-EXPONENTIAL-ATTEMPTS", input.retries.mode === "exponential",
    input.retries.maxAttempts >= 2, detail("I-EXPONENTIAL-ATTEMPTS"));
  checkInvariant(trace, diagnostics, "I-PROD-CORS", input.service.environment === "prod",
    !input.security.allowedOrigins.includes("*"), detail("I-PROD-CORS"));
  checkInvariant(trace, diagnostics, "I-FEATURE-COLLISION", true,
    featureNames.every(Boolean) && new Set(featureNames).size === featureNames.length, detail("I-FEATURE-COLLISION"));
  checkInvariant(trace, diagnostics, "I-ORIGIN-SYNTAX", true, originSyntaxValid, detail("I-ORIGIN-SYNTAX"));

  const name = slugName(input.service.name);
  trace.rules.push("R-NAME-SLUG");
  trace.paths.push(name === input.service.name ? "P-NAME-AS-IS" : "P-NAME-NORMALIZED");
  if (name !== input.service.name) {
    addDiagnostic(diagnostics, "W-NAME-NORMALIZED", "normalization", "service.name", `service name normalized to '${name}'.`, "warning");
  }

  trace.rules.push("R-ENVIRONMENT");
  trace.paths.push(`P-ENV-${input.service.environment.toUpperCase()}`);

  trace.rules.push("R-REGION");
  trace.paths.push(!REGIONS.has(input.service.region)
    ? "P-REGION-UNKNOWN"
    : LEGACY_REGIONS.has(input.service.region) ? "P-REGION-LEGACY" : "P-REGION-CANONICAL");
  if (LEGACY_REGIONS.has(input.service.region)) {
    addDiagnostic(diagnostics, "W-REGION-LEGACY", "deprecation", "service.region",
      `legacy region '${input.service.region}' mapped to '${REGIONS.get(input.service.region)}'.`, "warning");
  }

  trace.rules.push("R-SERVICE-PORT");
  trace.paths.push(input.service.port === undefined
    ? `P-PORT-DEFAULT-${input.service.environment.toUpperCase()}`
    : "P-PORT-EXPLICIT");

  trace.rules.push("R-TIMEOUT");
  trace.paths.push(input.service.timeoutSeconds === undefined
    ? `P-TIMEOUT-DEFAULT-${input.service.environment.toUpperCase()}`
    : "P-TIMEOUT-EXPLICIT");
  const timeoutSeconds = input.service.timeoutSeconds ?? ({ dev: 30, test: 20, prod: 10 }[input.service.environment]);

  trace.rules.push("R-LOG-LEVEL");
  trace.paths.push(input.logging.level === "warn" ? "P-LOG-LEVEL-WARN" : "P-LOG-LEVEL-DIRECT");
  const forcedJson = input.service.environment === "prod" && input.logging.pretty === true;
  trace.rules.push("R-LOG-FORMAT");
  trace.paths.push(forcedJson
    ? "P-LOG-FORMAT-PROD-FORCED-JSON"
    : input.logging.pretty === true ? "P-LOG-FORMAT-PRETTY" : "P-LOG-FORMAT-JSON");
  if (forcedJson) {
    addDiagnostic(diagnostics, "W-PROD-PRETTY", "ignored-input", "logging.pretty", "pretty logging is ignored in prod.", "warning");
  }

  trace.rules.push("R-CACHE");
  let cache;
  if (!input.cache.enabled) {
    cache = { strategy: "none", ttlMs: 0 };
    trace.paths.push("P-CACHE-NONE");
    if (input.cache.provider !== undefined || input.cache.ttlSeconds !== undefined || input.cache.endpoint !== undefined) {
      addDiagnostic(diagnostics, "W-CACHE-IGNORED", "ignored-input", "cache",
        "provider, ttlSeconds, and endpoint are ignored when cache is disabled.", "warning");
    }
  } else {
    const provider = input.cache.provider ?? "memory";
    cache = { strategy: provider, ttlMs: input.cache.ttlSeconds * 1000 };
    if (provider === "redis") cache.endpoint = input.cache.endpoint;
    trace.paths.push(provider === "redis" ? "P-CACHE-REDIS" : "P-CACHE-MEMORY");
  }

  trace.rules.push("R-DATABASE");
  let data;
  if (input.database.engine === "sqlite") {
    data = { driver: "sqlite", database: input.database.name };
    trace.paths.push("P-DB-SQLITE");
  } else {
    data = {
      driver: input.database.engine === "postgres" ? "pg" : "mysql2",
      host: input.database.host ?? "localhost",
      port: databasePort,
      database: input.database.name,
      tlsMode: input.database.ssl === true ? "require" : "disable"
    };
    trace.paths.push("P-DB-REMOTE");
    trace.paths.push(input.database.port === undefined
      ? `P-DB-PORT-DEFAULT-${input.database.engine.toUpperCase()}`
      : "P-DB-PORT-EXPLICIT");
  }

  trace.rules.push("R-RETRIES");
  const exponential = input.retries.mode === "exponential";
  const uncappedDelay = exponential
    ? input.retries.delayMs * (2 ** Math.max(0, input.retries.maxAttempts - 1))
    : input.retries.delayMs;
  trace.paths.push(exponential ? "P-RETRY-EXPONENTIAL" : "P-RETRY-FIXED");
  if (uncappedDelay > 60000) trace.paths.push("P-RETRY-MAX-CAPPED");

  trace.rules.push("R-CORS");
  const normalizedOrigins = input.security.allowedOrigins.map(canonicalOrigin);
  const origins = [...new Set(normalizedOrigins)].sort();
  const corsChanged = JSON.stringify(origins) !== JSON.stringify(input.security.allowedOrigins);
  trace.paths.push(corsChanged ? "P-CORS-NORMALIZED" : "P-CORS-AS-IS");
  if (corsChanged) {
    addDiagnostic(diagnostics, "W-ORIGIN-DEDUP", "normalization", "security.allowedOrigins",
      "CORS origins were canonicalized, sorted, or deduplicated.", "warning");
  }

  trace.rules.push("R-FEATURES");
  const unsortedFeatures = Object.entries(input.features.flags)
    .map(([feature, enabled]) => ({ name: canonicalFeature(feature), enabled }));
  const features = unsortedFeatures.toSorted((a, b) => compareCodePoints(a.name, b.name));
  if (features.length === 0) {
    trace.paths.push("P-FEATURES-EMPTY");
  } else {
    const originalFeatures = Object.entries(input.features.flags).map(([feature, enabled]) => ({ name: feature, enabled }));
    const featuresChanged = JSON.stringify(features) !== JSON.stringify(originalFeatures);
    trace.paths.push(featuresChanged ? "P-FEATURES-NORMALIZED" : "P-FEATURES-AS-IS");
    if (featuresChanged) {
      addDiagnostic(diagnostics, "W-FEATURE-NORMALIZED", "normalization", "features.flags",
        "feature names were normalized and sorted.", "warning");
    }
  }

  const config = {
    apiVersion: "config.example/v2",
    metadata: { serviceId: name, environment: input.service.environment },
    runtime: { region: REGIONS.get(input.service.region) ?? null, listen: { port: servicePort }, timeoutMs: timeoutSeconds * 1000 },
    observability: {
      level: input.logging.level === "warn" ? "warning" : input.logging.level,
      format: input.logging.pretty === true && !forcedJson ? "pretty" : "json"
    },
    cache,
    data,
    resilience: {
      strategy: input.retries.mode,
      attempts: input.retries.maxAttempts,
      initialDelayMs: input.retries.delayMs,
      maxDelayMs: Math.min(60000, uncappedDelay)
    },
    http: { cors: { origins } },
    features
  };

  return sortedResult(config, diagnostics, trace);
}
