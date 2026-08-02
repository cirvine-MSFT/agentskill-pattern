import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const experimentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(experimentRoot, "..", "..");

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(command, env = process.env, cwd = repositoryRoot) {
  return spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command
  ], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
}

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function createSessionStore(file) {
  const columns = [
    "id INTEGER", "session_id TEXT", "turn_index INTEGER", "agent_id TEXT",
    "parent_tool_call_id TEXT", "model TEXT", "input_tokens INTEGER",
    "output_tokens INTEGER", "cache_read_tokens INTEGER", "cache_write_tokens INTEGER",
    "reasoning_tokens INTEGER", "total_nano_aiu INTEGER", "request_multiplier INTEGER",
    "duration_ms INTEGER", "time_to_first_token_ms INTEGER",
    "inter_token_latency_ms INTEGER", "initiator TEXT", "api_endpoint TEXT",
    "reasoning_effort TEXT", "finish_reason TEXT", "content_filter_triggered INTEGER",
    "token_details_json TEXT", "created_at TEXT"
  ];
  const script = [
    "import sqlite3, sys",
    "db = sqlite3.connect(sys.argv[1])",
    "db.execute('CREATE TABLE sessions (id TEXT)')",
    `db.execute(${JSON.stringify(`CREATE TABLE assistant_usage_events (${columns.join(", ")})`)})`,
    "db.commit()"
  ].join("\n");
  const created = spawnSync("python", ["-c", script, file], { encoding: "utf8", windowsHide: true });
  assert.equal(created.status, 0, created.stderr);
}

function createFakeCli(file) {
  const help = [
    "-p, --prompt",
    "--session-id",
    "--model",
    "--output-format",
    "-C <directory>",
    "--allow-all-tools",
    "--available-tools",
    "--disable-builtin-mcps",
    "--disable-mcp-server",
    "--disallow-temp-dir",
    "--no-custom-instructions",
    "--no-ask-user",
    "--no-remote-export"
  ].join("\\n");
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
fs.appendFileSync(process.env.PILOT_COMMAND_PROBE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "--version") process.stdout.write("GitHub Copilot CLI 1.0.77.\\n");
else if (process.argv[2] === "--help") process.stdout.write(${JSON.stringify(help)} + "\\n");
else if (process.argv[2] === "mcp" && process.argv[3] === "list") process.stdout.write("");
else process.exitCode = 2;
`);
}

function npmCommand(script, arguments_) {
  return `npm --prefix experiments/unit-test-delegation-v2 run ${script} -- -- ${arguments_.join(" ")}`;
}

test("documented Windows PowerShell npm command preserves names and values without starting the pilot", {
  skip: process.platform !== "win32"
}, () => {
  assert.equal(process.versions.node, "22.14.0");
  const npmVersion = runPowerShell("npm --version");
  assert.equal(npmVersion.status, 0, npmVersion.stderr);
  assert.equal(npmVersion.stdout.trim(), "10.9.2");

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "utd2-command-"));
  const fakeCli = path.join(parent, "fake-copilot.mjs");
  const sessionStore = path.join(parent, "session-store.db");
  const privateRoot = path.join(parent, "absent-private-root");
  const probeLog = path.join(parent, "cli-probes.jsonl");
  const env = { ...process.env, PILOT_COMMAND_PROBE_LOG: probeLog };
  createFakeCli(fakeCli);
  createSessionStore(sessionStore);

  const options = [
    "--cli", quote(fakeCli),
    "--session-store", quote(sessionStore),
    "--private-root", quote(privateRoot)
  ];
  try {
    const result = runPowerShell(npmCommand("pilot:preflight", options), env);
    assert.equal(result.status, 0, result.stderr);
    const jsonStart = result.stdout.indexOf("{");
    assert(jsonStart >= 0, result.stdout);
    const preflight = JSON.parse(result.stdout.slice(jsonStart));
    assert.equal(preflight.ok, true);
    assert.equal(preflight.privateEvidenceRoot, path.resolve(privateRoot));
    assert.equal(preflight.rootsCreated, false);
    assert.equal(preflight.observationsStarted, 0);
    assert.deepEqual(preflight.consumedIds, []);
    assert.equal(fs.existsSync(privateRoot), false);
    assert.deepEqual(fs.readFileSync(probeLog, "utf8").trim().split(/\r?\n/u).map(JSON.parse), [
      ["--version"],
      ["--help"],
      ["mcp", "list"]
    ]);

    for (const invalid of [
      options.slice(0, -2),
      [...options, "--cli", quote(fakeCli)],
      ["--cli=copilot", ...options.slice(2)]
    ]) {
      const rejected = runPowerShell(npmCommand("pilot:preflight", invalid), env);
      assert.notEqual(rejected.status, 0);
      assert.equal(fs.existsSync(privateRoot), false);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("fresh autocrlf checkout has stable hashes and passes documented preflight without starting the pilot", {
  skip: process.platform !== "win32"
}, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "utd2-fresh-checkout-"));
  const checkout = path.join(parent, "checkout");
  const resources = path.join(parent, "resources");
  const fakeCli = path.join(resources, "fake-copilot.mjs");
  const sessionStore = path.join(resources, "session-store.db");
  const privateRoot = path.join(resources, "absent-private-root");
  const probeLog = path.join(resources, "cli-probes.jsonl");
  const env = { ...process.env, PILOT_COMMAND_PROBE_LOG: probeLog };
  fs.mkdirSync(resources);
  createFakeCli(fakeCli);
  createSessionStore(sessionStore);

  try {
    run("git", ["clone", "--local", "--no-hardlinks", "--no-checkout", repositoryRoot, checkout]);
    run("git", ["config", "core.autocrlf", "true"], checkout);
    run("git", ["checkout", "--detach", "HEAD"], checkout);
    assert.match(
      run("git", ["ls-files", "--eol", "experiments/unit-test-delegation-v2/scripts/pilot-command.mjs"], checkout).stdout,
      /i\/lf\s+w\/lf\s+attr\/text eol=lf/u
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generated = runPowerShell(
        "npm --prefix experiments/unit-test-delegation-v2 run hashes",
        process.env,
        checkout
      );
      assert.equal(generated.status, 0, generated.stderr);
      assert.equal(run("git", ["status", "--porcelain"], checkout).stdout, "");
    }

    const options = [
      "--cli", quote(fakeCli),
      "--session-store", quote(sessionStore),
      "--private-root", quote(privateRoot)
    ];
    const result = runPowerShell(npmCommand("pilot:preflight", options), env, checkout);
    assert.equal(result.status, 0, result.stderr);
    const jsonStart = result.stdout.indexOf("{");
    assert(jsonStart >= 0, result.stdout);
    const preflight = JSON.parse(result.stdout.slice(jsonStart));
    assert.equal(preflight.ok, true);
    assert.equal(preflight.repositoryHead, run("git", ["rev-parse", "HEAD"], checkout).stdout.trim());
    assert.equal(preflight.rootsCreated, false);
    assert.equal(preflight.observationsStarted, 0);
    assert.deepEqual(preflight.consumedIds, []);
    assert.equal(fs.existsSync(privateRoot), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
