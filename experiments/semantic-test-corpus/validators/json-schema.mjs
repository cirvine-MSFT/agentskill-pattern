import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function typeMatches(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function childPath(path, key) {
  return typeof key === "number" ? `${path}[${key}]` : `${path}.${key}`;
}

function isStrictRfc3339(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return false;
  if (zone !== "Z") {
    const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function validateJsonSchema(value, schema, options = {}) {
  const errors = [];
  const schemaDir = options.schemaDir ?? process.cwd();

  function visit(current, currentSchema, path, currentSchemaDir) {
    if (currentSchema.$ref) {
      const referencePath = resolve(currentSchemaDir, currentSchema.$ref);
      const referenced = JSON.parse(readFileSync(referencePath, "utf8"));
      visit(current, referenced, path, dirname(referencePath));
      return;
    }

    for (const schemaPart of currentSchema.allOf ?? []) {
      visit(current, schemaPart, path, currentSchemaDir);
    }
    if (currentSchema.anyOf) {
      const matched = currentSchema.anyOf.some((schemaPart) =>
        validateJsonSchema(current, schemaPart, { schemaDir: currentSchemaDir }).length === 0);
      if (!matched) {
        errors.push({ path, keyword: "anyOf", message: "must match at least one allowed schema" });
        return;
      }
    }
    if (currentSchema.if) {
      const conditionMatched = validateJsonSchema(
        current,
        currentSchema.if,
        { schemaDir: currentSchemaDir }
      ).length === 0;
      const branch = conditionMatched ? currentSchema.then : currentSchema.else;
      if (branch) visit(current, branch, path, currentSchemaDir);
    }

    if ("const" in currentSchema && current !== currentSchema.const) {
      errors.push({ path, keyword: "const", message: `must equal ${JSON.stringify(currentSchema.const)}` });
      return;
    }
    const allowedTypes = Array.isArray(currentSchema.type) ? currentSchema.type : [currentSchema.type];
    if (currentSchema.type && !allowedTypes.some((type) => typeMatches(current, type))) {
      errors.push({ path, keyword: "type", message: `must be ${allowedTypes.join(" or ")}` });
      return;
    }
    if (currentSchema.enum && !currentSchema.enum.includes(current)) {
      errors.push({ path, keyword: "enum", message: `must be one of ${currentSchema.enum.join(", ")}` });
    }
    if (typeof current === "string") {
      if (currentSchema.minLength !== undefined && current.length < currentSchema.minLength) {
        errors.push({ path, keyword: "minLength", message: `must contain at least ${currentSchema.minLength} characters` });
      }
      if (currentSchema.pattern && !(new RegExp(currentSchema.pattern).test(current))) {
        errors.push({ path, keyword: "pattern", message: `must match ${currentSchema.pattern}` });
      }
      if (currentSchema.format === "date-time" && !isStrictRfc3339(current)) {
        errors.push({ path, keyword: "format", message: "must be a strict RFC 3339 date-time" });
      }
    }
    if (typeof current === "number") {
      if (currentSchema.minimum !== undefined && current < currentSchema.minimum) {
        errors.push({ path, keyword: "minimum", message: `must be at least ${currentSchema.minimum}` });
      }
      if (currentSchema.maximum !== undefined && current > currentSchema.maximum) {
        errors.push({ path, keyword: "maximum", message: `must be at most ${currentSchema.maximum}` });
      }
    }
    if (Array.isArray(current)) {
      if (currentSchema.minItems !== undefined && current.length < currentSchema.minItems) {
        errors.push({ path, keyword: "minItems", message: `must contain at least ${currentSchema.minItems} items` });
      }
      if (currentSchema.maxItems !== undefined && current.length > currentSchema.maxItems) {
        errors.push({ path, keyword: "maxItems", message: `must contain at most ${currentSchema.maxItems} items` });
      }
      if (currentSchema.items) {
        current.forEach((item, index) => visit(item, currentSchema.items, childPath(path, index), currentSchemaDir));
      }
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      for (const required of currentSchema.required ?? []) {
        if (!(required in current)) {
          errors.push({ path: childPath(path, required), keyword: "required", message: "is required" });
        }
      }
      const properties = currentSchema.properties ?? {};
      for (const [key, item] of Object.entries(current)) {
        if (properties[key]) {
          visit(item, properties[key], childPath(path, key), currentSchemaDir);
        } else if (currentSchema.additionalProperties === false) {
          errors.push({ path: childPath(path, key), keyword: "additionalProperties", message: "is not allowed" });
        } else if (currentSchema.additionalProperties && typeof currentSchema.additionalProperties === "object") {
          visit(item, currentSchema.additionalProperties, childPath(path, key), currentSchemaDir);
        }
      }
    }
  }

  visit(value, schema, "$", schemaDir);
  return errors;
}
