#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {assertInside, readJson, stableStringify} from "./lib.mjs";

function deepEqual(actual, expected) {
  return stableStringify(actual) === stableStringify(expected);
}

function cleanEnvironment(overrides = {}) {
  const environment = {
    PATH: dirname(process.execPath),
    TEMP: tmpdir(),
    TMP: tmpdir()
  };
  if (process.platform === "win32") {
    environment.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    environment.ComSpec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  }
  return {...environment, ...overrides};
}

function runModuleCheck(candidateRoot, evaluatorRoot, source, check, index) {
  const probe = resolve(evaluatorRoot, `.module-probe-${index}.mjs`);
  const sourceUrl = pathToFileURL(source).href;
  const script = `const module = await import(${JSON.stringify(sourceUrl)});
let output;
try {
  const value = await module[${JSON.stringify(check.call)}](...${JSON.stringify(check.args)});
  output = {value};
} catch (error) {
  output = {error: error instanceof Error ? error.message : String(error)};
}
process.stdout.write("__DOC_EVAL__" + JSON.stringify(output));
`;
  try {
    writeFileSync(probe, script);
    const result = spawnSync(process.execPath, [probe], {
      cwd: candidateRoot,
      encoding: "utf8",
      timeout: 5000,
      env: cleanEnvironment()
    });
    if (result.error) return {probeError: result.error.message};
    if (result.status !== 0) return {probeError: result.stderr || `exit ${result.status}`};
    const marker = result.stdout.lastIndexOf("__DOC_EVAL__");
    if (marker < 0) return {probeError: "Module probe returned no result marker"};
    return JSON.parse(result.stdout.slice(marker + "__DOC_EVAL__".length));
  } finally {
    rmSync(probe, {force: true});
  }
}

async function evaluateFeature(candidateRoot, evaluatorRoot, spec) {
  const failures = [];
  let passed = 0;
  if (spec.kind === "module") {
    const source = assertInside(candidateRoot, resolve(candidateRoot, spec.sourcePath));
    for (const [index, check] of spec.featureChecks.entries()) {
      try {
        const probe = runModuleCheck(candidateRoot, evaluatorRoot, source, check, index);
        if (probe.probeError) throw new Error(probe.probeError);
        if (check.error) {
          if (!probe.error || !new RegExp(check.error, "iu").test(probe.error)) {
            throw new Error(`Expected error /${check.error}/`);
          }
        } else if (probe.error) {
          throw new Error(probe.error);
        } else if (!deepEqual(probe.value, check.expected)) {
          throw new Error(`Expected ${JSON.stringify(check.expected)}, received ${JSON.stringify(probe.value)}`);
        }
        passed += 1;
      } catch (error) {
        failures.push(`Feature check ${index + 1}: ${error.message}`);
      }
    }
  } else {
    const source = assertInside(candidateRoot, resolve(candidateRoot, spec.sourcePath));
    for (const [index, check] of spec.featureChecks.entries()) {
      const result = spawnSync(process.execPath, [source, ...check.args], {
        cwd: candidateRoot,
        input: check.stdin ?? "",
        encoding: "utf8",
        timeout: 5000,
        env: cleanEnvironment(check.env)
      });
      if (result.error) {
        failures.push(`Feature check ${index + 1}: ${result.error.message}`);
      } else if (result.status !== check.exit || result.stdout !== check.stdout) {
        failures.push(
          `Feature check ${index + 1}: exit/stdout mismatch (${result.status}, ${JSON.stringify(result.stdout)})`
        );
      } else {
        passed += 1;
      }
    }
  }
  return {passed, total: spec.featureChecks.length, score: passed / spec.featureChecks.length, failures};
}

function parseFences(markdown) {
  return [...markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/gu)]
    .map((match) => ({info: match[1].trim(), body: match[2]}));
}

function headingSlug(value) {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/gu, "-");
}

function splitCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of command.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function validateLinks(markdown, docPath, candidateRoot) {
  const failures = [];
  const localHeadings = new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => headingSlug(match[1]))
  );
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/u.test(target)) continue;
    const [filePart, anchor] = target.split("#", 2);
    const targetPath = filePart
      ? assertInside(candidateRoot, resolve(dirname(docPath), filePart))
      : docPath;
    let targetMarkdown;
    try {
      targetMarkdown = readFileSync(targetPath, "utf8");
    } catch {
      failures.push(`Broken link: ${target}`);
      continue;
    }
    if (anchor) {
      const headings = targetPath === docPath
        ? localHeadings
        : new Set([...targetMarkdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((item) => headingSlug(item[1])));
      if (!headings.has(anchor.toLowerCase())) failures.push(`Broken anchor: ${target}`);
    }
  }
  return failures;
}

function executeJavaScript(candidateRoot, body, index) {
  const path = resolve(candidateRoot, `.docs-eval-${index}.mjs`);
  try {
    writeFileSync(path, body);
    const result = spawnSync(process.execPath, [path], {
      cwd: candidateRoot,
      encoding: "utf8",
      timeout: 5000,
      env: cleanEnvironment()
    });
    if (result.error) return result.error.message;
    if (result.status !== 0) return result.stderr || `exit ${result.status}`;
    return null;
  } finally {
    rmSync(path, {force: true});
  }
}

function executeConsole(candidateRoot, body, expected) {
  const lines = body.trimEnd().split(/\r?\n/u);
  if (!lines[0]?.startsWith("$ node ")) return "Console example must begin with '$ node '";
  const tokens = splitCommand(lines[0].slice(2));
  if (tokens.shift() !== "node") return "Only node commands are allowed";
  const script = tokens.shift();
  if (!script) return "Missing node script";
  const stdinLine = lines.find((line) => line.startsWith("<<< "));
  const result = spawnSync(process.execPath, [assertInside(candidateRoot, resolve(candidateRoot, script)), ...tokens], {
    cwd: candidateRoot,
    input: stdinLine ? stdinLine.slice(4) : "",
    encoding: "utf8",
    timeout: 5000,
    env: cleanEnvironment()
  });
  if (result.error) return result.error.message;
  if (result.status !== 0) return result.stderr || `exit ${result.status}`;
  if (expected === undefined) return "Console example lacks following text expected block";
  return result.stdout === expected ? null : `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(result.stdout)}`;
}

function evaluateDocumentation(candidateRoot, spec) {
  const docPath = assertInside(candidateRoot, resolve(candidateRoot, spec.docTarget));
  let markdown;
  try {
    markdown = readFileSync(docPath, "utf8");
  } catch (error) {
    return {
      correctness: 0,
      coverage: 0,
      executability: 0,
      format: 0,
      unsupportedClaims: 0,
      details: [`Documentation unavailable: ${error.message}`]
    };
  }

  const details = [];
  const lower = markdown.toLowerCase();
  const headingLines = [...markdown.matchAll(/^##\s+(.+)$/gmu)].map((match) => match[1].trim());
  const headingMatches = spec.documentation.headings.filter((heading, index) => headingLines[index] === heading).length;
  if (headingMatches !== spec.documentation.headings.length) details.push("Required headings are missing or out of order");

  const symbolMatches = spec.documentation.symbols.filter((symbol) => lower.includes(symbol.toLowerCase())).length;
  const missingFacts = spec.documentation.requiredFacts.filter((fact) => !lower.includes(fact.toLowerCase()));
  if (missingFacts.length) details.push(`Missing required facts: ${missingFacts.join(", ")}`);
  const unsupported = spec.documentation.forbiddenClaims.filter((claim) => {
    const phrase = claim.toLowerCase();
    let offset = lower.indexOf(phrase);
    while (offset >= 0) {
      const start = Math.max(
        lower.lastIndexOf(".", offset),
        lower.lastIndexOf("!", offset),
        lower.lastIndexOf("?", offset)
      ) + 1;
      const endCandidates = [
        lower.indexOf(".", offset + phrase.length),
        lower.indexOf("!", offset + phrase.length),
        lower.indexOf("?", offset + phrase.length)
      ].filter((value) => value >= 0);
      const end = endCandidates.length ? Math.min(...endCandidates) : lower.length;
      const sentence = lower.slice(start, end);
      const negated = /\b(?:no|not|never|without|unsupported|cannot|can't|doesn't|does not|isn't|is not|aren't|are not)\b/u.test(sentence);
      const affirmative = /\b(?:supports?|provides?|performs?|makes?|uses?|includes?|implements?|accepts?|parses?|adds?|runs?|writes?|contacts?|modifies?|reads?|reorders?|returns?|uploads?|downloads?|sleeps?|queries?|connects?|generates?|removes?|transliterates?|encodes?|decodes?|matches?|recognizes?|handles?|allows?|retries?)\b/u.test(sentence);
      if (affirmative && !negated) return true;
      offset = lower.indexOf(phrase, offset + phrase.length);
    }
    return false;
  });
  if (unsupported.length) details.push(`Unsupported claims: ${unsupported.join(", ")}`);

  const fences = parseFences(markdown);
  let validJson = true;
  for (const fence of fences.filter((item) => item.info === "json")) {
    try {
      JSON.parse(fence.body);
    } catch {
      validJson = false;
      details.push("Invalid JSON fence");
    }
  }
  const linkFailures = validateLinks(markdown, docPath, candidateRoot);
  details.push(...linkFailures);

  const executable = [];
  for (let index = 0; index < fences.length; index += 1) {
    const fence = fences[index];
    if (fence.info === "js executable") {
      executable.push(executeJavaScript(candidateRoot, fence.body, index));
    }
    if (fence.info === "console executable") {
      const next = fences[index + 1];
      const expected = next?.info === "text expected" ? next.body : undefined;
      executable.push(executeConsole(candidateRoot, fence.body, expected));
    }
  }
  if (executable.length < spec.documentation.minExecutable) {
    details.push(`Expected at least ${spec.documentation.minExecutable} executable examples`);
  }
  for (const [index, failure] of executable.entries()) {
    if (failure) details.push(`Executable example ${index + 1}: ${failure.trim()}`);
  }

  const coverage = spec.documentation.requiredFacts.length === 0
    ? 1
    : (spec.documentation.requiredFacts.length - missingFacts.length) / spec.documentation.requiredFacts.length;
  const correctnessBase = spec.documentation.symbols.length === 0
    ? 1
    : symbolMatches / spec.documentation.symbols.length;
  const correctness = unsupported.length === 0 ? correctnessBase : Math.max(0, correctnessBase - unsupported.length * 0.25);
  const executableDenominator = Math.max(spec.documentation.minExecutable, executable.length);
  const executablePasses = executable.filter((failure) => failure === null).length;
  const executability = executableDenominator === 0 ? 0 : executablePasses / executableDenominator;
  const formatParts = [
    headingMatches / spec.documentation.headings.length,
    validJson ? 1 : 0,
    linkFailures.length === 0 ? 1 : 0,
    markdown.startsWith("# ") ? 1 : 0
  ];
  const format = formatParts.reduce((sum, value) => sum + value, 0) / formatParts.length;

  return {
    correctness,
    coverage,
    executability,
    format,
    unsupportedClaims: unsupported.length,
    details
  };
}

export async function evaluate({candidateRoot, evaluatorRoot}) {
  const candidate = resolve(candidateRoot);
  const evaluator = resolve(evaluatorRoot);
  const spec = readJson(resolve(evaluator, "hidden-spec.json"));
  const feature = await evaluateFeature(candidate, evaluator, spec);
  const documentation = evaluateDocumentation(candidate, spec);
  const pass = feature.score === 1
    && documentation.correctness >= 0.9
    && documentation.coverage >= 0.9
    && documentation.executability >= 0.9
    && documentation.format >= 0.9
    && documentation.unsupportedClaims === 0;
  return {
    schemaVersion: 1,
    taskId: spec.fixtureId,
    variantId: spec.variantId,
    feature,
    documentation,
    pass
  };
}

function parseArguments(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    output[argv[index].replace(/^--/u, "")] = argv[index + 1];
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = parseArguments(process.argv);
  if (!args.candidate || !args.evaluator) {
    throw new Error("Usage: evaluate.mjs --candidate <path> --evaluator <path> [--out <path>]");
  }
  const result = await evaluate({candidateRoot: args.candidate, evaluatorRoot: args.evaluator});
  const output = stableStringify(result);
  if (args.out) writeFileSync(resolve(args.out), output);
  else process.stdout.write(output);
}
