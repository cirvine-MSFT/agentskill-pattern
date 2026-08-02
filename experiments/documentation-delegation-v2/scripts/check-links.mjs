#!/usr/bin/env node
import {readFileSync, statSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {experimentRoot, walkFiles} from "./lib.mjs";

function slug(value) {
  return value.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/gu, "-");
}

export function checkLinks(root = experimentRoot) {
  const failures = [];
  for (const path of walkFiles(root).filter((item) => item.endsWith(".md"))) {
    const markdown = readFileSync(path, "utf8");
    for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1];
      if (/^(?:https?:|mailto:)/u.test(target)) continue;
      const [filePart, anchor] = target.split("#", 2);
      const linkedPath = resolve(dirname(path), filePart || ".");
      try {
        if (!statSync(linkedPath).isFile() && filePart) throw new Error("not a file");
        if (anchor) {
          const linked = filePart ? readFileSync(linkedPath, "utf8") : markdown;
          const headings = new Set(
            [...linked.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((item) => slug(item[1]))
          );
          if (!headings.has(anchor.toLowerCase())) throw new Error("missing anchor");
        }
      } catch {
        failures.push(`${path}: ${target}`);
      }
    }
  }
  if (failures.length) throw new Error(`Broken links:\n${failures.join("\n")}`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  checkLinks();
  process.stdout.write("Documentation v2 links verified\n");
}
