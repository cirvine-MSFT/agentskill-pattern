#!/usr/bin/env node
import {mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname, isAbsolute, relative, resolve, sep} from "node:path";
import {mainFixtures, pilotFixtures} from "../fixtures/catalog.mjs";
import {assertInside, protocolId, stableStringify} from "./lib.mjs";

const conventions = `# Documentation conventions v2

- Replace the complete precreated target. Start with one level-one heading.
- Include every required level-two heading in the stated order.
- Use repository-relative links; every local file and Markdown anchor must resolve.
- Library examples use fenced \`js executable\` blocks that run from the repository root
  and may import only \`./src/index.mjs\`.
- CLI examples use fenced \`console executable\` blocks. The first line must be
  \`$ node src/cli.mjs ...\`; optional stdin is a second line beginning \`<<< \`.
- Follow every console block immediately with a \`text expected\` block containing exact
  stdout, including the final newline represented by the fence line break.
- JSON fences must contain strict JSON.
- State exact defaults, options, errors, and exit codes required by TASK.md. Do not add
  behavior unsupported by TASK.md and the changed public source.
`;

export function findFixture(fixtureId, variantId) {
  const fixture = [...mainFixtures, ...pilotFixtures].find((item) => item.id === fixtureId);
  if (!fixture) throw new Error(`Unknown fixture: ${fixtureId}`);
  const variant = fixture.variants.find((item) => item.id === variantId);
  if (!variant) throw new Error(`Unknown variant ${variantId} for ${fixtureId}`);
  return {fixture, variant, phase: mainFixtures.includes(fixture) ? "main" : "pilot"};
}

function rootsOverlap(left, right) {
  const path = relative(left, right);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export function materializeFixture({
  fixtureId,
  variantId,
  candidateRoot,
  evaluatorRoot,
  observationId = "UNASSIGNED"
}) {
  const {fixture, variant, phase} = findFixture(fixtureId, variantId);
  const candidate = resolve(candidateRoot);
  const evaluator = resolve(evaluatorRoot);
  if (rootsOverlap(candidate, evaluator) || rootsOverlap(evaluator, candidate)) {
    throw new Error("Candidate and evaluator roots must be disjoint");
  }
  rmSync(candidate, {recursive: true, force: true});
  rmSync(evaluator, {recursive: true, force: true});

  for (const directory of [
    candidate,
    dirname(assertInside(candidate, resolve(candidate, fixture.sourcePath))),
    dirname(assertInside(candidate, resolve(candidate, fixture.docTarget))),
    resolve(candidate, ".github", "skills", "feature-documentation-sonnet-v2"),
    resolve(candidate, ".github", "agents"),
    evaluator
  ]) {
    mkdirSync(directory, {recursive: true});
  }

  const headings = fixture.doc.headings.map((heading) => `- \`## ${heading}\``).join("\n");
  const task = `# ${fixture.title}

Implement the production feature as the larger engineering task, then create
\`${fixture.docTarget}\` as its user-facing documentation.

## Feature requirements

${[...fixture.baseRequirements, ...variant.requirements].map((item) => `- ${item}`).join("\n")}

## Documentation requirements

- Target: \`${fixture.docTarget}\` (already exists and is empty).
- Required level-two headings, in order:
${headings}
- Accurately name: ${fixture.doc.symbols.map((item) => `\`${item}\``).join(", ")}.
- Include at least ${fixture.doc.minExecutable} executable examples following
  \`docs/CONVENTIONS.md\`, including exact output for every CLI command.
- Cover normal use, the variant-specific defaults, and error or exit behavior.
- Link once to the changed public source using a repository-relative link.
- Do not claim behavior absent from these requirements and the changed public source.

## Public source boundary

- \`${fixture.sourcePath}\`

Run \`npm test\` for the public syntax check. Hidden deterministic feature and
documentation evaluation runs only after the parent session ends.
`;

  writeFileSync(resolve(candidate, "TASK.md"), task);
  writeFileSync(resolve(candidate, "package.json"), stableStringify({
    name: `v2-doc-fixture-${fixture.id}`,
    private: true,
    version: "2.0.0",
    type: "module",
    scripts: {test: `node --check ${fixture.sourcePath}`}
  }));
  writeFileSync(resolve(candidate, "docs", "CONVENTIONS.md"), conventions);
  writeFileSync(resolve(candidate, fixture.sourcePath), fixture.starter);
  writeFileSync(resolve(candidate, fixture.docTarget), "");
  writeFileSync(resolve(candidate, "CANDIDATE.json"), stableStringify({
    protocolId,
    sourcePath: fixture.sourcePath,
    docTarget: fixture.docTarget,
    allowedWorkerReads: ["TASK.md", "docs/CONVENTIONS.md", fixture.sourcePath, fixture.docTarget],
    allowedWorkerWrites: [fixture.docTarget],
    workerEditCount: 1
  }));

  const repository = resolve(import.meta.dirname, "..", "..", "..");
  writeFileSync(
    resolve(candidate, ".github", "skills", "feature-documentation-sonnet-v2", "SKILL.md"),
    readFileSync(resolve(repository, ".github", "skills", "feature-documentation-sonnet-v2", "SKILL.md"))
  );
  writeFileSync(
    resolve(candidate, ".github", "agents", "feature-documentation-sonnet-v2.agent.md"),
    readFileSync(resolve(repository, ".github", "agents", "feature-documentation-sonnet-v2.agent.md"))
  );

  writeFileSync(resolve(evaluator, "hidden-spec.json"), stableStringify({
    protocolId,
    phase,
    fixtureId,
    variantId,
    kind: fixture.kind,
    sourcePath: fixture.sourcePath,
    docTarget: fixture.docTarget,
    featureChecks: variant.checks.map((check) => ({
      ...check,
      ...(fixture.unchangedArgs.length ? {unchangedArgs: fixture.unchangedArgs} : {})
    })),
    documentation: {
      headings: fixture.doc.headings,
      symbols: fixture.doc.symbols,
      requiredFacts: [...fixture.doc.baseFacts, ...variant.facts],
      forbiddenClaims: fixture.doc.forbiddenClaims,
      minExecutable: fixture.doc.minExecutable,
      requiredSourceLink: `../${fixture.sourcePath}`
    }
  }));

  return {candidateRoot: candidate, evaluatorRoot: evaluator, fixtureId, variantId, phase};
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const values = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, item, index, input) => {
      if (item.startsWith("--")) pairs.push([item.slice(2), input[index + 1]]);
      return pairs;
    }, [])
  );
  for (const name of ["fixture", "variant", "candidate", "evaluator"]) {
    if (!values[name]) throw new Error(`Missing --${name}`);
  }
  process.stdout.write(stableStringify(materializeFixture({
    fixtureId: values.fixture,
    variantId: values.variant,
    candidateRoot: values.candidate,
    evaluatorRoot: values.evaluator,
    observationId: values.observation
  })));
}
