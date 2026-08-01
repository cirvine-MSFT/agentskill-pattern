#!/usr/bin/env node

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evidenceRoot, invariant, runtimeRoot } from "./lib.mjs";

export function assertNoRun() {
  invariant(!existsSync(evidenceRoot), "v3 result/evidence root exists");
  invariant(!existsSync(runtimeRoot), "v3 runtime root exists");
  return { evidenceRootExists: false, runtimeRootExists: false, v3AiUnitsStarted: 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = assertNoRun();
  process.stdout.write(`No v3 AI unit started; evidence=${result.evidenceRootExists}; runtime=${result.runtimeRootExists}\n`);
}
