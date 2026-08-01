import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseNoteService } from "../../tools/release-note-mcp/lib.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function createRun() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-note-mcp-"));
  const dossierPath = path.join(root, "dossier.json");
  const outputRoot = path.join(root, "output");
  const auditRoot = path.join(root, "audit");
  await mkdir(outputRoot);
  await mkdir(auditRoot);
  const dossierBytes = Buffer.from(`${JSON.stringify({
    formatVersion: 1,
    dossierId: "pilot-test",
    partition: "excluded-pilot",
    category: "feature",
    product: "Test CLI",
    audience: "users",
    target: { format: "markdown" },
    sources: [{ publicUrl: "https://example.test/pr/1", title: "Add command" }],
  }, null, 2)}\n`);
  await writeFile(dossierPath, dossierBytes, { flag: "wx" });
  const token = randomBytes(32).toString("base64url");
  const config = {
    version: 1,
    runId: "PILOT-A4-TEST",
    arm: "A4",
    taskEnvelopeSha256: "1".repeat(64),
    sandboxKind: "closed-tool-surface",
    sandboxTokenHash: `sha256:${sha256(Buffer.from(token))}`,
    dossier: { path: dossierPath, sha256: sha256(dossierBytes) },
    output: {
      path: path.join(outputRoot, "draft.md"),
      relativePath: "drafts/pilot-test.md",
    },
    audit: { path: path.join(auditRoot, "audit.jsonl") },
    limits: { maxDossierBytes: 64 * 1024, maxDraftBytes: 8 * 1024 },
  };
  return {
    root,
    config,
    dossierBytes,
    async open() {
      return ReleaseNoteService.create(config);
    },
    async audit() {
      return (await readFile(config.audit.path, "utf8")).trim().split("\n").map(JSON.parse);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
