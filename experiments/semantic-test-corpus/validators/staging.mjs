import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "./json-schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, "..", "schemas");
const stagingSchema = JSON.parse(readFileSync(resolve(schemaDir, "staging.schema.json"), "utf8"));
const scenarioSchema = JSON.parse(readFileSync(resolve(schemaDir, "scenario.schema.json"), "utf8"));
const v1Schema = JSON.parse(readFileSync(resolve(schemaDir, "v1-config.schema.json"), "utf8"));

export function assessStaging(staging, parseError = null) {
  const submissionErrors = parseError
    ? [{ path: "$", keyword: "json", message: parseError }]
    : validateJsonSchema(staging, stagingSchema, { schemaDir });
  const rawCases = Array.isArray(staging?.cases) ? staging.cases : [];
  const ids = new Set();
  const cases = [];

  for (const [index, scenario] of rawCases.entries()) {
    const errors = validateJsonSchema(scenario, scenarioSchema, { schemaDir })
      .map((error) => ({ ...error, path: `$.cases[${index}]${error.path.slice(1)}` }));
    if (scenario && typeof scenario === "object") {
      if (ids.has(scenario.id)) {
        errors.push({ path: `$.cases[${index}].id`, keyword: "unique", message: "must be unique" });
      }
      ids.add(scenario.id);
      if ("expected" in scenario || "trace" in scenario || "diagnostics" in scenario) {
        errors.push({
          path: `$.cases[${index}]`,
          keyword: "acceptanceOpacity",
          message: "staging cases cannot contain expected outputs, traces, or diagnostics"
        });
      }
      if (scenario.input) {
        for (const error of validateJsonSchema(scenario.input, v1Schema, { schemaDir })) {
          errors.push({ ...error, path: `$.cases[${index}].input${error.path.slice(1)}` });
        }
      }
    }
    if (index >= 60) {
      errors.push({ path: `$.cases[${index}]`, keyword: "targetCases", message: "exceeds the 60-case target" });
    }
    cases.push({
      index,
      id: typeof scenario?.id === "string" ? scenario.id : null,
      valid: errors.length === 0,
      errors,
      scenario
    });
  }

  return {
    submittedCases: rawCases.length,
    submissionErrors,
    cases,
    promotableCases: cases.filter((item) => item.valid).length
  };
}

export function validateStaging(staging) {
  const assessment = assessStaging(staging);
  return [
    ...assessment.submissionErrors,
    ...assessment.cases.flatMap((item) => item.errors)
  ];
}
