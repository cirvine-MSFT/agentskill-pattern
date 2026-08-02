#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {repositoryRoot} from "./lib.mjs";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

const parent = mkdtempSync(resolve(tmpdir(), "documentation-v2-checkout-"));
const checkout = resolve(parent, "worktree");
try {
  run("git", ["worktree", "add", "--detach", checkout, "HEAD"], repositoryRoot);
  run(process.execPath, ["scripts/reproduce.mjs"], resolve(checkout, "experiments", "documentation-delegation-v2"));
} finally {
  spawnSync("git", ["worktree", "remove", "--force", checkout], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true
  });
  rmSync(parent, {recursive: true, force: true});
}
process.stdout.write("Fresh-checkout index-byte regression verified\n");
