#!/usr/bin/env node
import {mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {mainFixtures, pilotFixtures} from "../fixtures/catalog.mjs";
import {assertInside, stableStringify} from "./lib.mjs";

const conventions = `# Documentation conventions

- Use the exact target named in TASK.md and start with one level-one heading.
- Include every required level-two heading in the listed order.
- Use repository-relative links. Every local path and heading anchor must resolve.
- For library examples, use fenced \`js executable\` blocks. Each block must run from
  the repository root and may import \`./src/index.mjs\`.
- For CLI examples, use fenced \`console executable\` blocks. The first line is
  \`$ node src/cli.mjs ...\`; an optional next line beginning \`<<< \` is stdin.
  Follow each console block immediately with a \`text expected\` output block.
- Every JSON fence must contain strict JSON. Do not claim behavior absent from TASK.md
  or the listed public source.
`;

function parseArguments(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be --name value pairs");
    }
    output[key.slice(2)] = value;
  }
  return output;
}

export function findFixture(fixtureId, variantId) {
  const fixture = [...mainFixtures, ...pilotFixtures].find((item) => item.id === fixtureId);
  if (!fixture) throw new Error(`Unknown fixture: ${fixtureId}`);
  const variant = fixture.variants.find((item) => item.id === variantId);
  if (!variant) throw new Error(`Unknown variant ${variantId} for ${fixtureId}`);
  const phase = mainFixtures.includes(fixture) ? "main" : "pilot";
  return {fixture, variant, phase};
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
  if (candidate === evaluator) throw new Error("Candidate and evaluator roots must differ");
  rmSync(candidate, {recursive: true, force: true});
  rmSync(evaluator, {recursive: true, force: true});

  for (const directory of [
    candidate,
    dirname(assertInside(candidate, resolve(candidate, fixture.sourcePath))),
    dirname(assertInside(candidate, resolve(candidate, fixture.docTarget))),
    resolve(candidate, ".github", "skills", "feature-documentation"),
    resolve(candidate, ".github", "agents"),
    evaluator
  ]) {
    mkdirSync(directory, {recursive: true});
  }

  const requiredHeadings = fixture.doc.headings.map((heading) => `- \`## ${heading}\``).join("\n");
  const task = `# ${fixture.title}

Implement the production feature as the larger engineering goal, then create
\`${fixture.docTarget}\` as its user-facing documentation.

## Feature requirements

${[...fixture.baseRequirements, ...variant.requirements].map((item) => `- ${item}`).join("\n")}

## Documentation requirements

- Target: \`${fixture.docTarget}\` (already exists).
- Required headings, in order:
${requiredHeadings}
- Refer to the public symbols/options accurately: ${fixture.doc.symbols.map((item) => `\`${item}\``).join(", ")}.
- Include at least ${fixture.doc.minExecutable} executable example blocks using docs/CONVENTIONS.md.
- Cover normal use, the variant-specific behavior above, and error or exit behavior.
- Do not claim behavior that the production source does not implement.

## Public source boundary

- \`${fixture.sourcePath}\`

Run \`npm test\` for the public syntax check. Hidden deterministic feature and
documentation evaluation runs only after the parent session ends.
`;

  writeFileSync(resolve(candidate, "TASK.md"), task);
  writeFileSync(resolve(candidate, "package.json"), stableStringify({
    name: `fixture-${fixture.id}`,
    private: true,
    version: "1.0.0",
    type: "module",
    scripts: {test: `node --check ${fixture.sourcePath}`}
  }));
  mkdirSync(resolve(candidate, "docs"), {recursive: true});
  writeFileSync(resolve(candidate, "docs", "CONVENTIONS.md"), conventions);
  writeFileSync(resolve(candidate, fixture.sourcePath), fixture.starter);
  writeFileSync(resolve(candidate, fixture.docTarget), "");
  writeFileSync(resolve(candidate, "CANDIDATE.json"), stableStringify({
    protocolId: "feature-documentation-delegation-v1",
    observationId,
    phase,
    fixtureId,
    variantId,
    sourcePath: fixture.sourcePath,
    docTarget: fixture.docTarget,
    allowedWorkerReads: ["TASK.md", "docs/CONVENTIONS.md", fixture.sourcePath, fixture.docTarget],
    allowedWorkerWrites: [fixture.docTarget]
  }));

  const skillSource = resolve(import.meta.dirname, "..", "..", "..", ".github", "skills", "feature-documentation", "SKILL.md");
  const agentSource = resolve(import.meta.dirname, "..", "..", "..", ".github", "agents", "feature-documentation-haiku.agent.md");
  writeFileSync(resolve(candidate, ".github", "skills", "feature-documentation", "SKILL.md"), readFileSync(skillSource));
  writeFileSync(resolve(candidate, ".github", "agents", "feature-documentation-haiku.agent.md"), readFileSync(agentSource));

  writeFileSync(resolve(evaluator, "hidden-spec.json"), stableStringify({
    protocolId: "feature-documentation-delegation-v1",
    observationId,
    phase,
    fixtureId,
    variantId,
    kind: fixture.kind,
    sourcePath: fixture.sourcePath,
    docTarget: fixture.docTarget,
    featureChecks: variant.checks,
    documentation: {
      headings: fixture.doc.headings,
      symbols: fixture.doc.symbols,
      requiredFacts: variant.facts,
      forbiddenClaims: fixture.doc.forbiddenClaims,
      minExecutable: fixture.doc.minExecutable
    }
  }));

  return {candidateRoot: candidate, evaluatorRoot: evaluator, fixtureId, variantId, phase};
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = parseArguments(process.argv);
  for (const required of ["fixture", "variant", "candidate", "evaluator"]) {
    if (!args[required]) throw new Error(`Missing --${required}`);
  }
  const result = materializeFixture({
    fixtureId: args.fixture,
    variantId: args.variant,
    candidateRoot: args.candidate,
    evaluatorRoot: args.evaluator,
    observationId: args.observation
  });
  process.stdout.write(`${stableStringify(result)}`);
}
