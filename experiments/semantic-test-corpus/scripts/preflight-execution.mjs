#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COPILOT_VERSION,
  PROTOCOL_ID,
  inspectHelp,
  parseMcpList
} from "./copilot-cli-v5.mjs";
import { USAGE_COLUMNS } from "./export-local-usage.mjs";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(root, "..", "..");
const schemaRoot = resolve(root, "schemas");
const schema = JSON.parse(readFileSync(resolve(schemaRoot, "execution-preflight.schema.json"), "utf8"));
const sourcePin = JSON.parse(
  readFileSync(resolve(root, "design", "v5", "source-pin.json"), "utf8")
);

function commandParts(command) {
  return command.toLowerCase().endsWith(".mjs")
    ? [process.execPath, resolve(command)]
    : [command];
}

function invoke(command, args) {
  const [executable, ...prefix] = commandParts(command);
  return spawnSync(executable, [...prefix, ...args], {
    encoding: "utf8",
    windowsHide: true
  });
}

function profileBytes(path) {
  const blob = sourcePin.sourceBlobs[path];
  if (!/^[a-f0-9]{40,64}$/u.test(blob ?? "")) return null;
  const observed = spawnSync("git", ["rev-parse", `${sourcePin.sourceCommit}:${path}`], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (observed.status !== 0 || observed.stdout.trim() !== blob) return null;
  const result = spawnSync("git", ["cat-file", "blob", blob], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout : null;
}

function inspectUsageStore(path) {
  if (!path || !existsSync(path)) {
    return { status: "unavailable", columns: [], reason: "session-store.db is missing" };
  }
  const script = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect('file:' + sys.argv[1].replace('\\\\', '/') + '?mode=ro', uri=True)",
    "columns = [row[1] for row in db.execute(\"PRAGMA table_info('assistant_usage_events')\")]",
    "print(json.dumps(columns))"
  ].join("\n");
  const candidates = process.platform === "win32"
    ? [["python"], ["py", "-3"]]
    : [["python3"], ["python"]];
  const failures = [];
  for (const [command, ...prefix] of candidates) {
    const result = spawnSync(command, [...prefix, "-c", script, resolve(path)], {
      encoding: "utf8"
    });
    if (!result.error && result.status === 0) {
      const columns = JSON.parse(result.stdout);
      const missing = USAGE_COLUMNS.filter((column) => !columns.includes(column));
      return {
        status: missing.length === 0 ? "available" : "unavailable",
        columns,
        reason: missing.length === 0
          ? null
          : `assistant_usage_events is missing columns: ${missing.join(", ")}`
      };
    }
    failures.push(result.error?.message ?? result.stderr.trim());
  }
  return {
    status: "unavailable",
    columns: [],
    reason: `session store could not be inspected: ${failures.join("; ")}`
  };
}

export function preflightExecution(command, {
  sessionStore,
  usageStoreInspection,
  capturedAt = new Date().toISOString()
} = {}) {
  const versionRun = invoke(command, ["--version"]);
  const helpRun = invoke(command, ["--help"]);
  const mcpRun = invoke(command, ["mcp", "list"]);
  const version = versionRun.status === 0 ? versionRun.stdout.trim() : null;
  const versionLine = version?.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? null;
  const help = helpRun.status === 0 ? inspectHelp(helpRun.stdout) : {
    requiredFlagsPresent: false,
    missingFlags: ["--help failed"],
    fabricatedCreateSessionPresent: false
  };
  const configuredMcpServers = mcpRun.status === 0 ? parseMcpList(mcpRun.stdout) : [];
  const mcpListRecognized = configuredMcpServers.length > 0
    || /\bno\b.*\b(?:mcp )?servers?\b/iu.test(mcpRun.stdout ?? "");
  const usageStore = usageStoreInspection ?? inspectUsageStore(sessionStore);
  const normalProfile = profileBytes(".github/agents/semantic-test-corpus.agent.md");
  const haikuProfile = profileBytes(".github/agents/semantic-test-corpus-haiku.agent.md");
  const profiles = {
    normalPinned: typeof normalProfile === "string"
      && /^name:\s*semantic-test-corpus$/mu.test(normalProfile)
      && !/^model:/mu.test(normalProfile),
    fixedHaikuPinned: typeof haikuProfile === "string"
      && /^name:\s*semantic-test-corpus-haiku$/mu.test(haikuProfile)
      && /^model:\s*claude-haiku-4\.5$/mu.test(haikuProfile)
  };
  const commonReasons = [];
  if (versionLine !== `GitHub Copilot CLI ${COPILOT_VERSION}.`) {
    commonReasons.push(`requires exact GitHub Copilot CLI ${COPILOT_VERSION}`);
  }
  if (!help.requiredFlagsPresent) {
    commonReasons.push(`CLI help is missing required flags: ${help.missingFlags.join(", ")}`);
  }
  if (help.fabricatedCreateSessionPresent) {
    commonReasons.push("CLI unexpectedly exposes the prohibited create-session subcommand");
  }
  if (mcpRun.status !== 0 || !mcpListRecognized) {
    commonReasons.push("configured MCP servers could not be enumerated exactly");
  }
  if (configuredMcpServers.includes("semantic-corpus")) {
    commonReasons.push("configured MCP server name semantic-corpus collides with the generated benchmark server");
  }
  if (usageStore.status !== "available") commonReasons.push(usageStore.reason);
  if (!profiles.normalPinned) {
    commonReasons.push("source pin does not bind the inherited-model semantic-test-corpus profile");
  }
  const arms = Array.from({ length: 6 }, (_, armId) => {
    const reasons = armId === 0 ? [] : [...commonReasons];
    if (armId === 5 && !profiles.fixedHaikuPinned) {
      reasons.push("source pin does not preregister the fixed-Haiku profile");
    }
    return {
      armId,
      status: reasons.length === 0 ? "available" : "unavailable",
      reasons
    };
  });
  const output = {
    formatVersion: 2,
    protocolId: PROTOCOL_ID,
    capturedAt,
    cli: {
      command,
      version,
      versionExitCode: Number.isInteger(versionRun.status) ? versionRun.status : null,
      helpExitCode: Number.isInteger(helpRun.status) ? helpRun.status : null,
      mcpListExitCode: Number.isInteger(mcpRun.status) ? mcpRun.status : null
    },
    surface: help,
    configuredMcpServers,
    usageStore: {
      path: sessionStore ? resolve(sessionStore) : null,
      ...usageStore
    },
    profiles,
    arms
  };
  const errors = validateJsonSchema(output, schema, { schemaDir: schemaRoot });
  if (errors.length > 0) {
    throw new Error(`Execution preflight is invalid: ${errors[0].path} ${errors[0].message}`);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliIndex = process.argv.indexOf("--cli");
  const storeIndex = process.argv.indexOf("--session-store");
  const outIndex = process.argv.indexOf("--out");
  if (cliIndex < 0 || !process.argv[cliIndex + 1]
    || storeIndex < 0 || !process.argv[storeIndex + 1]
    || outIndex < 0 || !process.argv[outIndex + 1]) {
    throw new Error("Usage: node scripts/preflight-execution.mjs --cli <copilot> --session-store <session-store.db> --out <preflight.json>");
  }
  const output = preflightExecution(process.argv[cliIndex + 1], {
    sessionStore: process.argv[storeIndex + 1]
  });
  const target = resolve(process.argv[outIndex + 1]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  const unavailable = output.arms.filter((arm) => arm.status === "unavailable");
  process.stdout.write(`${6 - unavailable.length}/6 arms available under v4 static preflight\n`);
  if (unavailable.length > 0) process.exitCode = 2;
}
