#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evidenceRoot, experimentRoot, readJson } from "./lib.mjs";

const summaryPath = resolve(evidenceRoot, "summary.json");
const summary = existsSync(summaryPath) ? readJson(summaryPath) : null;
const status = summary?.disposition ?? "NOT RUN";
const lines = [
  "# Action-item extraction v2 feasibility report",
  "",
  `**Status: ${status}.**`,
  "",
  summary
    ? `Development passed: ${summary.development.passed}. Excluded pilots started: ${summary.pilot.starts}; passed: ${summary.pilot.passed}.`
    : "The foundation is frozen and validated. No Copilot development unit or excluded pilot has been started.",
  "",
  "Immutable v1 remains NO-GO at merge `4900bdde8250292c86d4040d242359359ac050a0` / PR #26.",
  "",
  status === "GO"
    ? "GO authorizes only a separate confirmatory preregistration pull request; it does not authorize confirmation or main execution."
    : "No confirmatory or main execution is authorized.",
  "",
];
writeFileSync(resolve(experimentRoot, "report.md"), lines.join("\n"));
process.stdout.write(`Persisted v2 report status: ${status}\n`);
