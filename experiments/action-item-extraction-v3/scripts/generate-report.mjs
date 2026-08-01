#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceRoot, readJson } from "./lib.mjs";

export function reportText(summary = null) {
  if (!summary) {
    return [
      "# Action-item extraction v3",
      "",
      "**Status: design frozen; no v3 AI unit started.**",
      "",
      "Execution remains outside this design-only session.",
      "",
    ].join("\n");
  }
  return [
    "# Action-item extraction v3 excluded-pilot report",
    "",
    `**Disposition: ${summary.disposition}.**`,
    "",
    `Starts retained in ITT: ${summary.starts}.`,
    "",
    summary.authorizationBoundary,
    "",
  ].join("\n");
}

export function generateReport() {
  if (!existsSync(evidenceRoot)) return reportText();
  const reportPath = resolve(evidenceRoot, "report.md");
  if (existsSync(reportPath)) return readFileSync(reportPath, "utf8");
  const summary = readJson(resolve(evidenceRoot, "summary.json"));
  const text = reportText(summary);
  writeFileSync(reportPath, text, { flag: "wx" });
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(generateReport());
}
