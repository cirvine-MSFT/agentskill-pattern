import assert from "node:assert/strict";
import test from "node:test";
import { callTool } from "../../tools/release-note-mcp/lib.mjs";
import { createDispatcher } from "../../tools/release-note-mcp/protocol.mjs";
import { createRun } from "./fixtures.mjs";

test("exposes only one bounded read and one direct write", async (t) => {
  const run = await createRun();
  t.after(run.cleanup);
  const service = await run.open();
  const responses = [];
  const dispatch = createDispatcher(service, (message) => responses.push(message));
  let id = 0;
  async function request(method, params = {}) {
    id += 1;
    await dispatch({ jsonrpc: "2.0", id, method, params });
    return responses.find((message) => message.id === id);
  }

  const listed = await request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["read_release_dossier", "write_release_note_draft"],
  );
  assert.equal(
    listed.result.tools.some((tool) => /shell|search|list|read_file|delegate|agent/iu.test(tool.name)),
    false,
  );

  const read = await request("tools/call", {
    name: "read_release_dossier",
    arguments: {},
  });
  assert.equal(read.result.structuredContent.dossier.dossierId, "pilot-test");
  assert.equal(read.result.structuredContent.integrity.sha256, run.config.dossier.sha256);

  const secondRead = await request("tools/call", {
    name: "read_release_dossier",
    arguments: {},
  });
  assert.equal(secondRead.result.isError, true);
  assert.match(secondRead.result.content[0].text, /READ_LIMIT/u);
  assert.equal((await run.audit()).at(-1).type, "run.failed");
});

test("writes once and returns no dossier or draft content", async (t) => {
  const run = await createRun();
  t.after(run.cleanup);
  const service = await run.open();
  await service.readDossier({});
  const draft = [
    "# Test CLI adds repository deletion",
    "",
    "## New",
    "",
    "- Use `test repo delete` to delete a repository.",
    "",
    "## References",
    "",
    "- https://example.test/pr/1",
  ].join("\n");
  const envelope = await service.writeDraft({
    draft,
    dossierSha256: run.config.dossier.sha256,
  });
  assert.deepEqual(Object.keys(envelope), ["runId", "outputPath", "integrity"]);
  assert.equal(JSON.stringify(envelope).includes("Test CLI adds"), false);
  assert.equal(envelope.integrity.dossierSha256, run.config.dossier.sha256);
  assert.deepEqual(
    (await run.audit()).map((event) => event.type),
    ["service.started", "dossier.read", "draft.written", "run.completed"],
  );
});

test("fails closed on schema, order, and integrity violations", async (t) => {
  const cases = [
    async (service) => callTool(service, "write_release_note_draft", {
      draft: "# Title\n\n## References\n\n- https://example.test",
      dossierSha256: "0".repeat(64),
    }),
    async (service) => callTool(service, "read_release_dossier", { path: "other" }),
  ];
  for (const invoke of cases) {
    const run = await createRun();
    t.after(run.cleanup);
    const service = await run.open();
    await assert.rejects(invoke(service));
    assert.equal((await run.audit()).at(-1).type, "run.failed");
  }
});
