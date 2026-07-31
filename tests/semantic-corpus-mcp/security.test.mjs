import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  disposePreparedSandbox,
  prepareSandbox,
} from "../../tools/semantic-corpus-mcp/launcher.mjs";
import {
  atomicWriteNewBytes,
  canonicalJsonBytes,
  computeRequestHash,
  validateRequestDocument,
} from "../../tools/semantic-corpus-mcp/lib.mjs";
import {
  createRun,
  scenario,
} from "./fixtures.mjs";

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("merged schema dialect accepts metadata, schema-valued additionalProperties, and unbounded fields", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(async () => {
    await service.close();
    await run.cleanup();
  });

  assert.equal(run.request.v1ConfigSchema.$id, "v1-config.schema.json");
  assert.equal(run.request.v1ConfigSchema.properties.service.properties.name.maxLength, undefined);
  assert.deepEqual(
    run.request.v1ConfigSchema.properties.features.properties.flags.additionalProperties,
    { type: "boolean" },
  );
  await service.writeScenario({
    scenario: {
      ...scenario(0),
      input: {
        ...scenario(0).input,
        features: { flags: { arbitraryRegisteredFlag: true } },
      },
    },
  });
});

test("strict composed schemas reject unknown fields and invalid dynamic-property values", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(async () => {
    await service.close();
    await run.cleanup();
  });
  const baseline = scenario(1);
  const attacks = [
    { ...baseline, expected: { status: "ok" } },
    { ...baseline, trace: [] },
    { ...baseline, diagnostics: [] },
    { ...baseline, input: { ...baseline.input, expectedOutcome: "v2" } },
    {
      ...baseline,
      input: {
        ...baseline.input,
        service: { ...baseline.input.service, oracleVerdict: "pass" },
      },
    },
    {
      ...baseline,
      input: {
        ...baseline.input,
        features: { flags: { alpha: "true" } },
      },
    },
  ];
  for (const attack of attacks) {
    await expectCode(() => service.writeScenario({ scenario: attack }), "SCHEMA_ERROR");
  }
});

test("generic request validator accepts only the documented 40 and 60 boundaries", async (t) => {
  const run = await createRun();
  t.after(() => run.cleanup());
  for (const targetCount of [40, 60]) {
    const request = { ...structuredClone(run.request), targetCount };
    request.requestHash = computeRequestHash(request);
    assert.equal(validateRequestDocument(request).targetCount, targetCount);
  }
  for (const targetCount of [39, 61]) {
    const request = { ...structuredClone(run.request), targetCount };
    request.requestHash = computeRequestHash(request);
    await expectCode(async () => validateRequestDocument(request), "SCHEMA_ERROR");
  }
  for (const v1ConfigSchema of [
    { ...structuredClone(run.request.v1ConfigSchema), additionalProperties: true },
    (() => {
      const schema = structuredClone(run.request.v1ConfigSchema);
      delete schema.additionalProperties;
      return schema;
    })(),
  ]) {
    const request = { ...structuredClone(run.request), v1ConfigSchema };
    request.requestHash = computeRequestHash(request);
    await expectCode(async () => validateRequestDocument(request), "SCHEMA_ERROR");
  }
});

test("trusted launcher writes verifiable confinement rather than accepting sandbox-kind claims", async (t) => {
  const run = await createRun();
  t.after(() => run.cleanup());
  assert.equal(Object.hasOwn(run.config, "sandboxKind"), false);
  assert.equal(run.config.confinement.provider, "trusted-launcher-v1");
  assert.equal(run.config.confinement.permissionModel, true);
  assert.equal(run.config.confinement.deniedReadRoot.includes(run.state.sandboxRoot), false);
  assert.equal(run.config.confinement.sources.length, 3);

  for (const target of [
    run.configPath,
    path.join(run.contract, "request.json"),
    path.join(run.contract, "schemas", "v1-config.schema.json"),
  ]) {
    await assert.rejects(async () => {
      const handle = await open(target, "r+");
      await handle.close();
    }, (error) => ["EACCES", "EPERM", "EROFS"].includes(error.code));
  }
});

test("concurrent preparation reserves runtime state without deleting the winning launch", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "semantic-prepare-race-"));
  const options = {
    statePath: path.join(parent, "state.json"),
    cleanupTokenPath: path.join(parent, "cleanup.cap"),
    sandboxParent: parent,
    metadata: {
      runId: "B01-A4",
      armId: 4,
      blockId: "B01",
      seed: 20260729,
    },
    waitTimeoutMs: 100,
    staleAfterMs: 1000,
  };
  const results = await Promise.allSettled([
    prepareSandbox(options),
    prepareSandbox(options),
  ]);
  const winner = results.find((result) => result.status === "fulfilled")?.value;
  t.after(async () => {
    if (winner) await disposePreparedSandbox(winner).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  });
  assert.ok(winner);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.some(
      (result) => result.status === "rejected" && result.reason?.code === "EEXIST",
    ),
    true,
  );
  assert.equal(
    JSON.parse(await readFile(options.statePath, "utf8")).requestHash,
    winner.request.requestHash,
  );
  assert.equal((await readFile(options.cleanupTokenPath, "utf8")).length >= 40, true);
});

test("contract reads reject traversal, absolute paths, separators, Unicode, and case aliases", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(async () => {
    await service.close();
    await run.cleanup();
  });
  const attacks = [
    "../mapping-spec.json",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "//server/share/file",
    "schemas\\v1-config.schema.json",
    "schemas//v1-config.schema.json",
    "e\u0301.md",
    "schemas\u2215v1-config.schema.json",
    "Arm-contract.json",
  ];
  for (const attack of attacks) {
    await assert.rejects(
      () => service.readContractFile({ path: attack }),
      (error) => /^(CASE_MISMATCH|INVALID_PATH|PATH_ESCAPE)$/.test(error.code),
    );
  }
});

test("staging junctions cannot redirect scenario writes outside the sandbox", async (t) => {
  const run = await createRun();
  const service = await run.open();
  const outside = path.join(run.parent, "outside-staging");
  await writeFile(path.join(run.staging, ".placeholder"), "");
  await mkdir(outside);
  await rm(path.join(run.staging, ".placeholder"));
  try {
    await symlink(
      outside,
      path.join(run.staging, "scenarios"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    await service.close();
    await run.cleanup();
    if (error?.code === "EPERM") {
      t.skip("directory links require an unavailable Windows privilege");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await service.close();
    await run.cleanup();
  });
  await expectCode(() => service.writeScenario({ scenario: scenario(0) }), "REPARSE_ESCAPE");
  assert.deepEqual(await readdir(outside), []);
});

test("finalization is exact-count, canonical, source-only, and write-once", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(async () => {
    await service.close();
    await run.cleanup();
  });
  await expectCode(() => service.finalizeStaging({}), "SCHEMA_ERROR");
  for (let index = 0; index < 60; index += 1) {
    await service.writeScenario({ scenario: scenario(index) });
  }
  const result = await service.finalizeStaging({});
  const payloadBytes = await readFile(run.state.stagingPath);
  const payload = JSON.parse(payloadBytes);
  assert.ok(payloadBytes.equals(canonicalJsonBytes(payload)));
  assert.equal(payload.cases.length, 60);
  assert.equal(JSON.stringify(payload).includes('"expected"'), false);
  await expectCode(() => service.finalizeStaging({}), "STAGING_FINALIZED");
  await expectCode(() => service.writeScenario({ scenario: scenario(0) }), "STAGING_FINALIZED");
  assert.match(result.payloadSha256, /^[a-f0-9]{64}$/);
});

test("atomic byte publication never replaces an existing artifact", async (t) => {
  const run = await createRun();
  t.after(() => run.cleanup());
  const target = path.join(run.staging, "existing.json");
  await writeFile(target, Buffer.from('{"stable":true}\n'));
  await expectCode(
    () => atomicWriteNewBytes(target, Buffer.from('{"stable":false}\n')),
    "CONFLICT",
  );
  assert.equal(await readFile(target, "utf8"), '{"stable":true}\n');
});
