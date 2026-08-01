import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../../tools/release-note-mcp/server.mjs", import.meta.url));

test("server refuses startup without launcher evidence", async () => {
  const env = { ...process.env };
  delete env.RELEASE_NOTE_RUN_CONFIG;
  delete env.RELEASE_NOTE_SANDBOX_TOKEN;
  const child = spawn(process.execPath, [server], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 78);
  assert.match(stderr, /SANDBOX_REQUIRED/u);
});
