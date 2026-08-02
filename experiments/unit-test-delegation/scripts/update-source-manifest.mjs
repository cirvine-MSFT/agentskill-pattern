import path from "node:path";
import { canonical, root, sha256, sourceEntries, writeJson } from "./lib.mjs";

const files = sourceEntries();
writeJson(path.join(root, "design", "source-manifest.json"), {
  schemaVersion: 1,
  algorithm: "sha256",
  files,
  rootHash: sha256(canonical(files))
});
