#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {assertInside, readJson, stableStringify} from "./lib.mjs";

function cleanEnvironment() {
  const environment = {
    PATH: dirname(process.execPath),
    TEMP: tmpdir(),
    TMP: tmpdir()
  };
  if (process.platform === "win32") {
    environment.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    environment.ComSpec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  }
  return environment;
}

function equal(actual, expected) {
  return stableStringify(actual) === stableStringify(expected);
}

function runModuleCheck(candidateRoot, evaluatorRoot, spec, check, index) {
  const probe = resolve(evaluatorRoot, `.v2-module-probe-${index}.mjs`);
  const sourceUrl = pathToFileURL(assertInside(candidateRoot, resolve(candidateRoot, spec.sourcePath))).href;
  writeFileSync(probe, `const subject = await import(${JSON.stringify(sourceUrl)});
const args = ${JSON.stringify(check.args)};
const before = structuredClone(args);
let result;
try {
  result = {value: await subject[${JSON.stringify(check.call)}](...args), args, before};
} catch (error) {
  result = {error: error instanceof Error ? error.message : String(error), args, before};
}
process.stdout.write("__V2_RESULT__" + JSON.stringify(result));
`);
  try {
    const result = spawnSync(process.execPath, [probe], {
      cwd: candidateRoot,
      encoding: "utf8",
      timeout: 5000,
      env: cleanEnvironment(),
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      return {error: result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`};
    }
    const marker = result.stdout.lastIndexOf("__V2_RESULT__");
    return marker < 0
      ? {error: "module probe returned no marker"}
      : JSON.parse(result.stdout.slice(marker + "__V2_RESULT__".length));
  } finally {
    rmSync(probe, {force: true});
  }
}

function evaluateFeature(candidateRoot, evaluatorRoot, spec) {
  const failures = [];
  let passed = 0;
  for (const [index, check] of spec.featureChecks.entries()) {
    let actual;
    if (spec.kind === "module") {
      actual = runModuleCheck(candidateRoot, evaluatorRoot, spec, check, index);
      const mutation = (check.unchangedArgs ?? []).find((argumentIndex) =>
        !equal(actual.args?.[argumentIndex], actual.before?.[argumentIndex]));
      if (mutation !== undefined) {
        failures.push(`Feature ${index + 1}: argument ${mutation} was mutated`);
        continue;
      }
      if (check.error) {
        if (typeof actual.error === "string" && new RegExp(check.error, "iu").test(actual.error)) {
          passed += 1;
        } else {
          failures.push(`Feature ${index + 1}: expected error /${check.error}/`);
        }
      } else if (actual.error) {
        failures.push(`Feature ${index + 1}: ${actual.error}`);
      } else if (equal(actual.value, check.expected)) {
        passed += 1;
      } else {
        failures.push(`Feature ${index + 1}: value mismatch`);
      }
      continue;
    }

    const source = assertInside(candidateRoot, resolve(candidateRoot, spec.sourcePath));
    const result = spawnSync(process.execPath, [source, ...check.args], {
      cwd: candidateRoot,
      input: check.stdin ?? "",
      encoding: "utf8",
      timeout: 5000,
      env: cleanEnvironment(),
      windowsHide: true
    });
    if (!result.error
      && result.status === check.exit
      && result.stdout === check.stdout
      && result.stderr === check.stderr) {
      passed += 1;
    } else {
      failures.push(`Feature ${index + 1}: CLI exit/stdout/stderr mismatch`);
    }
  }
  return {
    passed,
    total: spec.featureChecks.length,
    score: passed / spec.featureChecks.length,
    failures
  };
}

function fences(markdown) {
  return [...markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/gu)]
    .map((match) => ({
      info: match[1].trim(),
      body: match[2],
      start: match.index,
      end: match.index + match[0].length
    }));
}

function headingSlug(value) {
  return value.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/gu, "-");
}

function splitCommand(command) {
  const output = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)) {
    output.push(match[1] ?? match[2] ?? match[3]);
  }
  return output;
}

function linkFailures(markdown, docPath, candidateRoot) {
  const failures = [];
  const localHeadings = new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => headingSlug(match[1]))
  );
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/u.test(target)) continue;
    const [filePart, anchor] = target.split("#", 2);
    let linkedPath;
    try {
      linkedPath = filePart
        ? assertInside(candidateRoot, resolve(dirname(docPath), filePart))
        : docPath;
    } catch {
      failures.push(`Escaping link: ${target}`);
      continue;
    }
    let linked;
    try {
      linked = readFileSync(linkedPath, "utf8");
    } catch {
      failures.push(`Broken link: ${target}`);
      continue;
    }
    if (anchor) {
      const headings = linkedPath === docPath
        ? localHeadings
        : new Set([...linked.matchAll(/^#{1,6}\s+(.+)$/gmu)]
          .map((item) => headingSlug(item[1])));
      if (!headings.has(anchor.toLowerCase())) failures.push(`Broken anchor: ${target}`);
    }
  }
  return failures;
}

function executeJavaScript(candidateRoot, body, index) {
  const path = resolve(candidateRoot, `.v2-doc-example-${index}.mjs`);
  try {
    writeFileSync(path, body);
    const result = spawnSync(process.execPath, [path], {
      cwd: candidateRoot,
      encoding: "utf8",
      timeout: 5000,
      env: cleanEnvironment(),
      windowsHide: true
    });
    if (result.error) return result.error.message;
    if (result.status !== 0) return result.stderr.trim() || `exit ${result.status}`;
    return null;
  } finally {
    rmSync(path, {force: true});
  }
}

function executeConsole(candidateRoot, body, expected) {
  const lines = body.trimEnd().split(/\r?\n/u);
  if (!lines[0]?.startsWith("$ node ")) return "command must start with '$ node '";
  const tokens = splitCommand(lines[0].slice(2));
  if (tokens.shift() !== "node") return "only node commands are executable";
  const script = tokens.shift();
  if (!script) return "command has no script";
  const extra = lines.slice(1).filter((line) => !line.startsWith("<<< "));
  if (extra.length > 0) return "console block contains unsupported lines";
  const stdin = lines.find((line) => line.startsWith("<<< "))?.slice(4) ?? "";
  let scriptPath;
  try {
    scriptPath = assertInside(candidateRoot, resolve(candidateRoot, script));
  } catch {
    return "console script escapes the candidate root";
  }
  const result = spawnSync(process.execPath, [scriptPath, ...tokens], {
    cwd: candidateRoot,
    input: stdin,
    encoding: "utf8",
    timeout: 5000,
    env: cleanEnvironment(),
    windowsHide: true
  });
  if (result.error) return result.error.message;
  if (result.status !== 0) return result.stderr.trim() || `exit ${result.status}`;
  if (expected === undefined) return "missing adjacent text expected block";
  return result.stdout === expected
    ? null
    : `stdout mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(result.stdout)}`;
}

function unsupportedClaims(markdown, phrases) {
  const lower = markdown.toLowerCase();
  return phrases.filter((claim) => {
    const phrase = claim.toLowerCase();
    let offset = lower.indexOf(phrase);
    while (offset >= 0) {
      const start = Math.max(
        lower.lastIndexOf(".", offset),
        lower.lastIndexOf("!", offset),
        lower.lastIndexOf("?", offset),
        lower.lastIndexOf("\n", offset)
      ) + 1;
      const end = lower.indexOf("\n", offset + phrase.length);
      const sentence = lower.slice(start, end < 0 ? lower.length : end);
      const negated = /\b(?:no|not|never|without|unsupported|does not|doesn't|cannot|can't)\b/u
        .test(sentence);
      const affirmative = /\b(?:supports?|provides?|performs?|accepts?|parses?|handles?|allows?|uses?)\b/u
        .test(sentence);
      if (affirmative && !negated) return true;
      offset = lower.indexOf(phrase, offset + phrase.length);
    }
    return false;
  });
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
  const normalizedMarkdown = lower.replace(/\s+/gu, " ");
  const headingLines = [...markdown.matchAll(/^##\s+(.+)$/gmu)].map((match) => match[1].trim());
  const headingMatches = spec.documentation.headings
    .filter((heading, index) => headingLines[index] === heading).length;
  if (headingMatches !== spec.documentation.headings.length) {
    details.push("Required headings are missing or out of order");
  }

  const symbolMatches = spec.documentation.symbols
    .filter((symbol) => lower.includes(symbol.toLowerCase())).length;
  const missingFacts = spec.documentation.requiredFacts
    .filter((fact) =>
      !normalizedMarkdown.includes(fact.toLowerCase().replace(/\s+/gu, " ")));
  if (missingFacts.length > 0) details.push(`Missing facts: ${missingFacts.join(", ")}`);

  const unsupported = unsupportedClaims(markdown, spec.documentation.forbiddenClaims);
  if (unsupported.length > 0) details.push(`Unsupported claims: ${unsupported.join(", ")}`);

  const parsedFences = fences(markdown);
  let jsonPass = true;
  for (const item of parsedFences.filter((entry) => entry.info === "json")) {
    try {
      JSON.parse(item.body);
    } catch {
      jsonPass = false;
      details.push("Invalid JSON fence");
    }
  }

  const links = linkFailures(markdown, docPath, candidateRoot);
  details.push(...links);
  const requiredLinkPresent = markdown.includes(`](${spec.documentation.requiredSourceLink})`);
  if (!requiredLinkPresent) details.push("Required changed-source link is missing");

  const executions = [];
  for (let index = 0; index < parsedFences.length; index += 1) {
    const item = parsedFences[index];
    if (item.info === "js executable") {
      executions.push(executeJavaScript(candidateRoot, item.body, index));
    } else if (item.info === "console executable") {
      const next = parsedFences[index + 1];
      const adjacent = next?.info === "text expected"
        && markdown.slice(item.end, next.start).trim() === "";
      executions.push(executeConsole(
        candidateRoot,
        item.body,
        adjacent ? next.body : undefined
      ));
    }
  }
  if (executions.length < spec.documentation.minExecutable) {
    details.push(`Expected ${spec.documentation.minExecutable} executable examples`);
  }
  executions.forEach((failure, index) => {
    if (failure) details.push(`Executable ${index + 1}: ${failure}`);
  });

  const correctnessBase = symbolMatches / spec.documentation.symbols.length;
  const correctness = Math.max(0, correctnessBase - unsupported.length * 0.25);
  const coverage = (spec.documentation.requiredFacts.length - missingFacts.length)
    / spec.documentation.requiredFacts.length;
  const executionDenominator = Math.max(spec.documentation.minExecutable, executions.length);
  const executability = executions.filter((item) => item === null).length / executionDenominator;
  const format = [
    headingMatches / spec.documentation.headings.length,
    markdown.startsWith("# ") ? 1 : 0,
    jsonPass ? 1 : 0,
    links.length === 0 ? 1 : 0,
    requiredLinkPresent ? 1 : 0
  ].reduce((sum, value) => sum + value, 0) / 5;

  return {
    correctness,
    coverage,
    executability,
    format,
    unsupportedClaims: unsupported.length,
    details
  };
}

export function evaluate({candidateRoot, evaluatorRoot}) {
  const candidate = resolve(candidateRoot);
  const evaluator = resolve(evaluatorRoot);
  const spec = readJson(resolve(evaluator, "hidden-spec.json"));
  const feature = evaluateFeature(candidate, evaluator, spec);
  const documentation = evaluateDocumentation(candidate, spec);
  return {
    schemaVersion: 2,
    fixtureId: spec.fixtureId,
    variantId: spec.variantId,
    feature,
    documentation,
    pass: feature.score === 1
      && documentation.correctness >= 0.9
      && documentation.coverage >= 0.9
      && documentation.executability >= 0.9
      && documentation.format >= 0.9
      && documentation.unsupportedClaims === 0
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const candidateIndex = process.argv.indexOf("--candidate");
  const evaluatorIndex = process.argv.indexOf("--evaluator");
  const outputIndex = process.argv.indexOf("--out");
  if (candidateIndex < 0 || evaluatorIndex < 0) {
    throw new Error("Usage: evaluate.mjs --candidate <path> --evaluator <path> [--out <path>]");
  }
  const output = stableStringify(evaluate({
    candidateRoot: process.argv[candidateIndex + 1],
    evaluatorRoot: process.argv[evaluatorIndex + 1]
  }));
  if (outputIndex >= 0) writeFileSync(resolve(process.argv[outputIndex + 1]), output);
  else process.stdout.write(output);
}
