#!/usr/bin/env node
import {readFileSync} from "node:fs";
import {dirname, extname, resolve} from "node:path";
import {experimentRoot, exists, walkFiles} from "./lib.mjs";

function slug(value) {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/gu, "-");
}

export function checkLinks() {
  const failures = [];
  for (const path of walkFiles(experimentRoot).filter((item) => extname(item) === ".md")) {
    const markdown = readFileSync(path, "utf8");
    for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1];
      if (/^(?:https?:|mailto:)/u.test(target)) continue;
      const [filePart, anchor] = target.split("#", 2);
      const targetPath = filePart ? resolve(dirname(path), filePart) : path;
      if (!exists(targetPath)) {
        failures.push(`${path}: missing ${target}`);
        continue;
      }
      if (anchor && extname(targetPath) === ".md") {
        const targetMarkdown = readFileSync(targetPath, "utf8");
        const anchors = new Set(
          [...targetMarkdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((heading) => slug(heading[1]))
        );
        if (!anchors.has(anchor.toLowerCase())) failures.push(`${path}: missing anchor ${target}`);
      }
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  checkLinks();
  process.stdout.write("Documentation links resolve\n");
}
