#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dossierPaths, readJson, root } from "./lib.mjs";

function heading(category) {
  if (category === "feature") return "New";
  if (category === "bug-fix-set") return "Fixed";
  return "Breaking changes";
}

export function baselineDraft(dossier) {
  const primary = dossier.sources[0];
  const lines = [
    `# ${dossier.product}: ${primary.title}`,
    "",
    `## ${heading(dossier.category)}`,
    "",
    `- ${primary.body}`,
  ];
  if (dossier.category === "mixed-breaking") {
    lines.push("", "## Fixed", "", `- Addresses ${dossier.sources.slice(1).map((source) => source.title).join("; ")}.`);
  }
  lines.push("", "## References", "");
  for (const source of dossier.sources) lines.push(`- ${source.publicUrl}`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(root, "results", "baseline");
  mkdirSync(output, { recursive: true });
  for (const dossierPath of dossierPaths()) {
    const dossier = readJson(dossierPath);
    const draft = baselineDraft(dossier);
    writeFileSync(resolve(output, `${dossier.dossierId}.md`), draft);
  }
  process.stdout.write(`Generated ${dossierPaths().length} deterministic extractive drafts\n`);
}
