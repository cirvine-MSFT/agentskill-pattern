import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "./json-schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(here, "..", "schemas");
const stagingSchema = JSON.parse(readFileSync(resolve(schemaDir, "staging.schema.json"), "utf8"));
const v1Schema = JSON.parse(readFileSync(resolve(schemaDir, "v1-config.schema.json"), "utf8"));

export function validateStaging(staging) {
  const errors = validateJsonSchema(staging, stagingSchema, { schemaDir });
  const ids = new Set();

  for (const [index, scenario] of (staging.cases ?? []).entries()) {
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
  }

  return errors;
}
