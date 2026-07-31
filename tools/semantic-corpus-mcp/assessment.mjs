function typeMatches(value, type) {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "null") return value === null;
  return typeof value === type;
}

function childPath(path, key) {
  return typeof key === "number" ? `${path}[${key}]` : `${path}.${key}`;
}

function validateJsonSchema(value, schema) {
  const errors = [];

  function visit(current, currentSchema, path) {
    for (const schemaPart of currentSchema.allOf ?? []) {
      visit(current, schemaPart, path);
    }
    if (currentSchema.anyOf) {
      const matched = currentSchema.anyOf.some(
        (schemaPart) => validateJsonSchema(current, schemaPart).length === 0,
      );
      if (!matched) {
        errors.push({
          path,
          keyword: "anyOf",
          message: "must match at least one allowed schema",
        });
        return;
      }
    }
    if (currentSchema.if) {
      const conditionMatched =
        validateJsonSchema(current, currentSchema.if).length === 0;
      const branch = conditionMatched ? currentSchema.then : currentSchema.else;
      if (branch) visit(current, branch, path);
    }

    if ("const" in currentSchema && current !== currentSchema.const) {
      errors.push({
        path,
        keyword: "const",
        message: `must equal ${JSON.stringify(currentSchema.const)}`,
      });
      return;
    }
    const allowedTypes = Array.isArray(currentSchema.type)
      ? currentSchema.type
      : [currentSchema.type];
    if (
      currentSchema.type &&
      !allowedTypes.some((type) => typeMatches(current, type))
    ) {
      errors.push({
        path,
        keyword: "type",
        message: `must be ${allowedTypes.join(" or ")}`,
      });
      return;
    }
    if (currentSchema.enum && !currentSchema.enum.includes(current)) {
      errors.push({
        path,
        keyword: "enum",
        message: `must be one of ${currentSchema.enum.join(", ")}`,
      });
    }
    if (typeof current === "string") {
      if (
        currentSchema.minLength !== undefined &&
        current.length < currentSchema.minLength
      ) {
        errors.push({
          path,
          keyword: "minLength",
          message: `must contain at least ${currentSchema.minLength} characters`,
        });
      }
      if (
        currentSchema.pattern &&
        !new RegExp(currentSchema.pattern).test(current)
      ) {
        errors.push({
          path,
          keyword: "pattern",
          message: `must match ${currentSchema.pattern}`,
        });
      }
    }
    if (typeof current === "number") {
      if (
        currentSchema.minimum !== undefined &&
        current < currentSchema.minimum
      ) {
        errors.push({
          path,
          keyword: "minimum",
          message: `must be at least ${currentSchema.minimum}`,
        });
      }
      if (
        currentSchema.maximum !== undefined &&
        current > currentSchema.maximum
      ) {
        errors.push({
          path,
          keyword: "maximum",
          message: `must be at most ${currentSchema.maximum}`,
        });
      }
    }
    if (Array.isArray(current)) {
      if (
        currentSchema.minItems !== undefined &&
        current.length < currentSchema.minItems
      ) {
        errors.push({
          path,
          keyword: "minItems",
          message: `must contain at least ${currentSchema.minItems} items`,
        });
      }
      if (
        currentSchema.maxItems !== undefined &&
        current.length > currentSchema.maxItems
      ) {
        errors.push({
          path,
          keyword: "maxItems",
          message: `must contain at most ${currentSchema.maxItems} items`,
        });
      }
      if (currentSchema.items) {
        current.forEach((item, index) =>
          visit(item, currentSchema.items, childPath(path, index)),
        );
      }
    }
    if (
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      for (const required of currentSchema.required ?? []) {
        if (!(required in current)) {
          errors.push({
            path: childPath(path, required),
            keyword: "required",
            message: "is required",
          });
        }
      }
      const properties = currentSchema.properties ?? {};
      for (const [key, item] of Object.entries(current)) {
        if (properties[key]) {
          visit(item, properties[key], childPath(path, key));
        } else if (currentSchema.additionalProperties === false) {
          errors.push({
            path: childPath(path, key),
            keyword: "additionalProperties",
            message: "is not allowed",
          });
        } else if (
          currentSchema.additionalProperties &&
          typeof currentSchema.additionalProperties === "object"
        ) {
          visit(
            item,
            currentSchema.additionalProperties,
            childPath(path, key),
          );
        }
      }
    }
  }

  visit(value, schema, "$");
  return errors;
}

export function assessObservedStaging(
  staging,
  { stagingSchema, scenarioSchema, v1ConfigSchema },
) {
  const submissionErrors = validateJsonSchema(staging, stagingSchema);
  const rawCases = Array.isArray(staging?.cases) ? staging.cases : [];
  const ids = new Set();
  const cases = [];

  for (const [index, scenario] of rawCases.entries()) {
    const errors = validateJsonSchema(scenario, scenarioSchema).map((error) => ({
      ...error,
      path: `$.cases[${index}]${error.path.slice(1)}`,
    }));
    if (scenario && typeof scenario === "object") {
      if (ids.has(scenario.id)) {
        errors.push({
          path: `$.cases[${index}].id`,
          keyword: "unique",
          message: "must be unique",
        });
      }
      ids.add(scenario.id);
      if (
        "expected" in scenario ||
        "trace" in scenario ||
        "diagnostics" in scenario
      ) {
        errors.push({
          path: `$.cases[${index}]`,
          keyword: "acceptanceOpacity",
          message:
            "staging cases cannot contain expected outputs, traces, or diagnostics",
        });
      }
      if (scenario.input) {
        for (const error of validateJsonSchema(
          scenario.input,
          v1ConfigSchema,
        )) {
          errors.push({
            ...error,
            path: `$.cases[${index}].input${error.path.slice(1)}`,
          });
        }
      }
    }
    if (index >= 60) {
      errors.push({
        path: `$.cases[${index}]`,
        keyword: "targetCases",
        message: "exceeds the 60-case target",
      });
    }
    cases.push({
      index,
      id: typeof scenario?.id === "string" ? scenario.id : null,
      valid: errors.length === 0,
      errors,
      scenario,
    });
  }

  return {
    submittedCases: rawCases.length,
    submissionErrors,
    cases,
    promotableCases: cases.filter((item) => item.valid).length,
  };
}
