import assert from "node:assert/strict";
import { executeMutant, mutantCatalog, mutants } from "./definitions.mjs";

function configDiffPaths(left, right, path = "config") {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left) === JSON.stringify(right) ? [] : [path];
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap((key) => configDiffPaths(left[key], right[key], `${path}.${key}`));
  }
  return [path];
}

function diagnosticDifference(left, right) {
  const leftIds = new Set(left.map((item) => item.id));
  const rightIds = new Set(right.map((item) => item.id));
  return [...new Set([
    ...[...leftIds].filter((id) => !rightIds.has(id)),
    ...[...rightIds].filter((id) => !leftIds.has(id))
  ])].sort();
}

export function validateMutantCatalog(validationCases, declaredRuleIds) {
  assert.equal(mutants.length, mutantCatalog.frozenCount, "frozen mutant count changed");
  assert.equal(new Set(mutants.map((mutant) => mutant.id)).size, mutants.length, "mutant IDs must be unique");
  assert.deepEqual(Object.keys(mutantCatalog.faults).sort(), mutants.map((mutant) => mutant.id).sort(),
    "every mutant must declare exactly one intended fault target");

  const originalCases = structuredClone(validationCases);
  const results = mutants.map((mutant) => {
    assert(declaredRuleIds.has(mutant.ruleId), `${mutant.id} references unknown ${mutant.ruleId}`);
    const witnesses = [];
    for (const scenario of validationCases) {
      if (!mutant.applies(scenario.input, scenario.expected)) continue;
      const mutated = executeMutant(mutant, scenario.input, scenario.expected);
      assert.notDeepEqual(mutated, scenario.expected, `${mutant.id} is equivalent for ${scenario.id}`);
      assert.deepEqual(mutated.trace, scenario.expected.trace, `${mutant.id} changed instrumentation`);
      assert.equal(mutated.status, scenario.expected.status, `${mutant.id} changed status outside its declared fault`);

      const target = mutantCatalog.faults[mutant.id];
      if (target.startsWith("config.")) {
        assert.deepEqual(mutated.diagnostics, scenario.expected.diagnostics, `${mutant.id} changed diagnostics`);
        const paths = configDiffPaths(scenario.expected.config, mutated.config);
        assert(paths.length > 0, `${mutant.id} did not change config`);
        assert(paths.every((path) => path === target || path.startsWith(`${target}.`)),
          `${mutant.id} changed undeclared config path: ${paths.join(", ")}`);
      } else {
        assert.deepEqual(mutated.config, scenario.expected.config, `${mutant.id} changed config`);
        const diagnosticId = target.slice("diagnostics.".length);
        assert.deepEqual(diagnosticDifference(scenario.expected.diagnostics, mutated.diagnostics), [diagnosticId],
          `${mutant.id} changed diagnostics beyond ${diagnosticId}`);
      }
      witnesses.push(scenario.id);
    }
    assert(witnesses.length > 0, `${mutant.id} has no frozen baseline/golden witness`);
    return { id: mutant.id, fault: mutantCatalog.faults[mutant.id], witnesses };
  });

  assert.deepEqual(validationCases, originalCases, "mutant validation altered baseline/golden fixtures");
  return {
    catalogVersion: mutantCatalog.version,
    frozenCount: mutantCatalog.frozenCount,
    validated: results.length,
    mutants: results
  };
}
