function ok(expected) {
  return expected.status === "ok";
}

function canonicalFeature(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function removeDiagnostic(outcome, id) {
  outcome.diagnostics = outcome.diagnostics.filter((item) => item.id !== id);
}

function mappingMutant(id, ruleId, description, applies, mutate) {
  return { id, kind: "mapping", ruleId, description, applies, mutate };
}

function invariantMutant(id, invariantId, description, diagnosticId) {
  return {
    id,
    kind: "invariant",
    ruleId: invariantId,
    description,
    applies: (_input, expected) => expected.diagnostics.some((item) => item.id === diagnosticId),
    mutate: (outcome) => removeDiagnostic(outcome, diagnosticId)
  };
}

export const mutants = [
  mappingMutant("M01", "R-NAME-SLUG", "Preserve an unnormalized service name",
    (input, expected) => ok(expected) && input.service.name !== expected.config.metadata.serviceId,
    (outcome, input) => { outcome.config.metadata.serviceId = input.service.name; }),
  mappingMutant("M02", "R-REGION", "Map legacy US to west Europe",
    (input, expected) => ok(expected) && input.service.region === "us",
    (outcome) => { outcome.config.runtime.region = "westeurope"; }),
  mappingMutant("M03", "R-REGION", "Omit the legacy-region diagnostic",
    (input, expected) => ok(expected) && ["us", "eu", "apac"].includes(input.service.region),
    (outcome) => removeDiagnostic(outcome, "W-REGION-LEGACY")),
  mappingMutant("M04", "R-SERVICE-PORT", "Use the development port for every default",
    (input, expected) => ok(expected) && input.service.port === undefined && input.service.environment !== "dev",
    (outcome) => { outcome.config.runtime.listen.port = 3000; }),
  mappingMutant("M05", "R-TIMEOUT", "Treat timeout seconds as milliseconds",
    (input, expected) => ok(expected) && input.service.timeoutSeconds !== undefined,
    (outcome, input) => { outcome.config.runtime.timeoutMs = input.service.timeoutSeconds; }),
  mappingMutant("M06", "R-LOG-LEVEL", "Leave warn unrenamed",
    (input, expected) => ok(expected) && input.logging.level === "warn",
    (outcome) => { outcome.config.observability.level = "warn"; }),
  mappingMutant("M07", "R-LOG-FORMAT", "Allow pretty logs in production",
    (input, expected) => ok(expected) && input.service.environment === "prod" && input.logging.pretty === true,
    (outcome) => { outcome.config.observability.format = "pretty"; }),
  mappingMutant("M08", "R-CACHE", "Preserve stale TTL for disabled cache",
    (input, expected) => ok(expected) && !input.cache.enabled && input.cache.ttlSeconds !== undefined,
    (outcome, input) => { outcome.config.cache.ttlMs = input.cache.ttlSeconds * 1000; }),
  mappingMutant("M09", "R-CACHE", "Leave memory-cache TTL in seconds",
    (input, expected) => ok(expected) && input.cache.enabled && (input.cache.provider ?? "memory") === "memory",
    (outcome, input) => { outcome.config.cache.ttlMs = input.cache.ttlSeconds; }),
  mappingMutant("M10", "R-CACHE", "Drop the Redis endpoint",
    (input, expected) => ok(expected) && input.cache.enabled && input.cache.provider === "redis",
    (outcome) => { delete outcome.config.cache.endpoint; }),
  mappingMutant("M11", "R-DATABASE", "Use MySQL's default port for PostgreSQL",
    (input, expected) => ok(expected) && input.database.engine === "postgres" && input.database.port === undefined,
    (outcome) => { outcome.config.data.port = 3306; }),
  mappingMutant("M12", "R-DATABASE", "Use PostgreSQL's default port for MySQL",
    (input, expected) => ok(expected) && input.database.engine === "mysql" && input.database.port === undefined,
    (outcome) => { outcome.config.data.port = 5432; }),
  mappingMutant("M13", "R-DATABASE", "Emit a host for SQLite",
    (input, expected) => ok(expected) && input.database.engine === "sqlite",
    (outcome) => { outcome.config.data.host = "localhost"; }),
  mappingMutant("M14", "R-RETRIES", "Add one retry attempt",
    (input, expected) => ok(expected),
    (outcome) => { outcome.config.resilience.attempts += 1; }),
  mappingMutant("M15", "R-RETRIES", "Do not cap exponential delay",
    (input, expected) => ok(expected) && input.retries.mode === "exponential"
      && input.retries.delayMs * (2 ** (input.retries.maxAttempts - 1)) > 60000,
    (outcome, input) => {
      outcome.config.resilience.maxDelayMs = input.retries.delayMs * (2 ** (input.retries.maxAttempts - 1));
    }),
  mappingMutant("M16", "R-CORS", "Keep duplicate and unsorted origins",
    (input, expected) => ok(expected) && JSON.stringify(input.security.allowedOrigins) !== JSON.stringify(expected.config.http.cors.origins),
    (outcome, input) => { outcome.config.http.cors.origins = [...input.security.allowedOrigins]; }),
  mappingMutant("M17", "R-FEATURES", "Preserve feature insertion order",
    (input, expected) => ok(expected) && Object.keys(input.features.flags).length > 1,
    (outcome) => { outcome.config.features.reverse(); }),
  mappingMutant("M18", "R-FEATURES", "Preserve feature spelling",
    (input, expected) => ok(expected) && Object.keys(input.features.flags).some((name) => /[^a-z0-9-]/.test(name)),
    (outcome, input) => {
      for (const original of Object.keys(input.features.flags)) {
        const feature = outcome.config.features.find((item) => item.name === canonicalFeature(original));
        if (feature) feature.name = original;
      }
    }),
  invariantMutant("M19", "I-VERSION", "Accept an unsupported source version", "D-VERSION"),
  invariantMutant("M20", "I-SERVICE-NAME", "Accept a service name with no alphanumeric characters", "D-SERVICE-NAME"),
  invariantMutant("M21", "I-SERVICE-PORT", "Accept an out-of-range service port", "D-SERVICE-PORT"),
  invariantMutant("M22", "I-REGION", "Accept an unknown region", "D-REGION"),
  invariantMutant("M23", "I-PROD-DEBUG", "Allow debug logging in production", "D-PROD-DEBUG"),
  invariantMutant("M24", "I-CACHE-TTL", "Accept an out-of-range cache TTL", "D-CACHE-TTL"),
  invariantMutant("M25", "I-REDIS-ENDPOINT", "Accept a non-Redis endpoint", "D-REDIS-ENDPOINT"),
  invariantMutant("M26", "I-SQLITE-PROD", "Allow SQLite in production", "D-SQLITE-PROD"),
  invariantMutant("M27", "I-PROD-DB-TLS", "Allow a production remote database without TLS", "D-PROD-DB-TLS"),
  invariantMutant("M28", "I-DB-PORT-CONFLICT", "Allow service/database port conflicts", "D-PORT-CONFLICT"),
  invariantMutant("M29", "I-RETRY-BOUNDS", "Accept retry values outside their domain", "D-RETRY-BOUNDS"),
  invariantMutant("M30", "I-EXPONENTIAL-ATTEMPTS", "Allow a one-attempt exponential policy", "D-EXPONENTIAL-ATTEMPTS"),
  invariantMutant("M31", "I-PROD-CORS", "Allow wildcard CORS in production", "D-PROD-CORS"),
  invariantMutant("M32", "I-FEATURE-COLLISION", "Allow colliding normalized feature names", "D-FEATURE-COLLISION"),
  invariantMutant("M33", "I-ORIGIN-SYNTAX", "Accept an origin containing a path", "D-ORIGIN-SYNTAX")
];

export function executeMutant(mutant, input, expected) {
  const outcome = structuredClone(expected);
  if (mutant.applies(input, expected)) mutant.mutate(outcome, input);
  return outcome;
}
