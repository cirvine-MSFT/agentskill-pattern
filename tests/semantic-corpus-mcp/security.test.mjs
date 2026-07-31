import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
import { fileURLToPath } from "node:url";
import {
  disposePreparedSandbox,
  prepareSandbox,
  verifyStagingState,
} from "../../tools/semantic-corpus-mcp/launcher.mjs";
import {
  atomicWriteNewBytes,
  canonicalJsonBytes,
  computeRequestHash,
  CorpusService,
  validateRequestDocument,
} from "../../tools/semantic-corpus-mcp/lib.mjs";
import { verifyLauncherBootEnvelope } from "../../tools/semantic-corpus-mcp/attestation.mjs";
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

test("invalid observed slots are preserved for later per-case promotion", async (t) => {
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
  for (const [index, attack] of attacks.entries()) {
    assert.equal((await service.writeScenario({ scenario: attack })).count, index + 1);
  }
  const summary = await service.finalizeStaging({});
  assert.equal(summary.submittedCases, attacks.length);
  assert.equal(summary.promotableCases, 0);
  assert(summary.errorCount >= attacks.length);
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
  assert.deepEqual(run.config.confinement.deniedReadRoots, [
    path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
  ]);
  assert.equal(run.config.audit.candidateRoot, run.state.sandboxRoot);
  assert.match(run.config.confinement.repository.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(run.config.confinement.executable.sha256, /^[a-f0-9]{64}$/);
  assert.match(run.config.confinement.launcher.sha256, /^[a-f0-9]{64}$/);
  assert.equal(run.config.confinement.sources.length, 5);

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

test("direct env forge, path tampering, expiry, replay, and executable mismatch fail closed", async (t) => {
  const run = await createRun();
  t.after(() => run.cleanup());
  const server = fileURLToPath(
    new URL("../../tools/semantic-corpus-mcp/server.mjs", import.meta.url),
  );
  const direct = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      SEMANTIC_CORPUS_SANDBOX_CONFIG: run.configPath,
      SEMANTIC_CORPUS_SANDBOX_TOKEN: run.serverToken,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let directError = "";
  direct.stderr.setEncoding("utf8");
  direct.stderr.on("data", (chunk) => {
    directError += chunk;
  });
  direct.stdin.end();
  assert.equal((await once(direct, "exit"))[0], 78);
  assert.match(directError, /LAUNCH_ATTESTATION_REQUIRED/);

  const pathBoot = run.bootEnvelope();
  const tampered = structuredClone(pathBoot.envelope);
  tampered.payload.configPath = path.join(run.parent, "forged-config.json");
  assert.throws(
    () => verifyLauncherBootEnvelope(
      Buffer.from(JSON.stringify(tampered)),
      pathBoot.publicKeyBytes,
      { requireParent: false },
    ),
    (error) => error.code === "LAUNCH_SIGNATURE_INVALID",
  );
  const substitutedKey = run.bootEnvelope();
  assert.throws(
    () => verifyLauncherBootEnvelope(
      pathBoot.bytes,
      substitutedKey.publicKeyBytes,
      { requireParent: false },
    ),
    (error) => error.code === "LAUNCH_SIGNATURE_INVALID",
  );

  const expired = run.bootEnvelope({
    now: Date.now() - 10_000,
    lifetimeMs: 1_000,
  });
  assert.throws(
    () => verifyLauncherBootEnvelope(
      expired.bytes,
      expired.publicKeyBytes,
      { requireParent: false },
    ),
    (error) => error.code === "LAUNCH_ATTESTATION_EXPIRED",
  );
  await expectCode(
    () => CorpusService.create({
      boot: expired.payload,
      enforceProcessConfinement: false,
    }),
    "LAUNCH_ATTESTATION_EXPIRED",
  );

  const replay = run.bootEnvelope();
  const first = await CorpusService.create({
    boot: replay.payload,
    enforceProcessConfinement: false,
  });
  await first.close();
  await expectCode(
    () => CorpusService.create({
      boot: replay.payload,
      enforceProcessConfinement: false,
    }),
    "LAUNCH_REPLAYED",
  );

  const mismatch = run.bootEnvelope();
  await expectCode(
    () => CorpusService.create({
      boot: {
        ...mismatch.payload,
        expectedExecutableSha256: "0".repeat(64),
      },
      enforceProcessConfinement: false,
    }),
    "LAUNCH_EXECUTABLE_MISMATCH",
  );
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
      (error) => /^(CASE_MISMATCH|INVALID_PATH|PATH_ESCAPE|NOT_FOUND)$/.test(error.code),
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

test("finalization publishes observed 0, 59, malformed mixed, and 60-valid submissions once", async (t) => {
  const cases = [
    { name: "zero", submissions: [], promoted: 0, errors: 0 },
    {
      name: "fifty-nine",
      submissions: Array.from({ length: 59 }, (_, index) => ({ scenario: scenario(index) })),
      promoted: 59,
      errors: 0,
    },
    {
      name: "mixed",
      submissions: [
        { scenario: scenario(0) },
        { scenario: {} },
        { scenario: null },
        {},
      ],
      promoted: 1,
      errors: null,
    },
    {
      name: "sixty",
      submissions: Array.from({ length: 60 }, (_, index) => ({ scenario: scenario(index) })),
      promoted: 60,
      errors: 0,
    },
  ];
  for (const fixture of cases) {
    const run = await createRun({ runId: `B01-A4-${fixture.name}` });
    const service = await run.open();
    t.after(async () => {
      await service.close().catch(() => {});
      await run.cleanup();
    });
    for (const submission of fixture.submissions) {
      await service.writeScenario(submission);
    }
    const result = await service.finalizeStaging({});
    const payloadBytes = await readFile(run.state.stagingPath);
    const payload = JSON.parse(payloadBytes);
    assert.ok(payloadBytes.equals(canonicalJsonBytes(payload)));
    assert.equal(payload.cases.length, fixture.submissions.length);
    assert.equal(result.stagingPath, `staging/${run.request.runId}.json`);
    assert.equal(result.submittedCases, fixture.submissions.length);
    assert.equal(result.promotableCases, fixture.promoted);
    if (fixture.errors === null) assert(result.errorCount > 0);
    else assert.equal(result.errorCount, fixture.errors);
    assert.deepEqual(Object.keys(result).sort(), [
      "errorCount",
      "payloadSha256",
      "promotableCases",
      "stagingPath",
      "submittedCases",
    ]);
    assert.deepEqual(
      await verifyStagingState(
        run.statePath,
        result.payloadSha256,
        run.cleanupToken,
      ),
      result,
    );
    assert.equal(JSON.stringify(payload).includes('"expected"'), false);
    await expectCode(() => service.finalizeStaging({}), "STAGING_FINALIZED");
    await expectCode(
      () => service.writeScenario({ scenario: scenario(0) }),
      "STAGING_FINALIZED",
    );
    assert.ok((await readFile(run.state.stagingPath)).equals(payloadBytes));
  }
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
