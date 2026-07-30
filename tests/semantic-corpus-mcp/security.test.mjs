import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  atomicWriteNewJson,
  computeRequestHash,
  CorpusService,
} from "../../tools/semantic-corpus-mcp/lib.mjs";
import {
  baseRequest,
  createRun,
  encodeJson,
  scenarioInput,
} from "./fixtures.mjs";

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function fillValidCorpus(service, request) {
  for (const [index, entry] of request.scenarios.entries()) {
    await service.writeScenarioInput({
      scenarioId: entry.scenarioId,
      config: scenarioInput(index + 1),
    });
  }
}

test("writes exact request-defined IDs, categories, count, and quotas", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(() => run.cleanup());
  await fillValidCorpus(service, run.request);
  const result = await service.writeScenarioManifest({
    scenarios: [...run.request.scenarios].reverse(),
  });
  assert.equal(result.scenarioCount, run.request.targetCount);
  assert.equal(result.requestHash, run.requestHash);

  const first = JSON.parse(
    await readFile(path.join(run.staging, "scenarios", "scenario-001.json"), "utf8"),
  );
  assert.deepEqual(first, scenarioInput(1));
  const manifest = JSON.parse(
    await readFile(path.join(run.staging, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.scenarios, run.request.scenarios);
  assert.equal(manifest.requestHash, run.requestHash);
  assert.equal(JSON.stringify(manifest).includes("summary"), false);
  assert.equal(JSON.stringify(manifest).includes("rationale"), false);
});

test("closed v1 schema rejects aliases, confusables, and nested unknowns", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(() => run.cleanup());
  const attacks = [
    { ...scenarioInput(1), expectedOutcome: "v2" },
    { ...scenarioInput(1), oracleVerdict: "pass" },
    { ...scenarioInput(1), "\u043EracleVerdict": "pass" },
    { ...scenarioInput(1), "expected.output": "v2" },
    { ...scenarioInput(1), profile: { ...scenarioInput(1).profile, expected: "v2" } },
    { ...scenarioInput(1), profile: { ...scenarioInput(1).profile, oracle: {} } },
    { ...scenarioInput(1), profile: { ...scenarioInput(1).profile, nested: {} } },
  ];
  for (const [index, config] of attacks.entries()) {
    await assert.rejects(
      () =>
        service.writeScenarioInput({
          scenarioId: "scenario-001",
          config,
        }),
      (error) => {
        assert.equal(error.code, "SCHEMA_ERROR");
        assert.match(error.message, /unsupported field/);
        return true;
      },
      `attack ${index}`,
    );
  }
});

test("scenario and manifest arguments have strict positive shapes", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(() => run.cleanup());
  await expectCode(
    () =>
      service.writeScenarioInput({
        scenarioId: "not-request-defined",
        config: scenarioInput(1),
      }),
    "SCHEMA_ERROR",
  );
  await expectCode(
    () =>
      service.writeScenarioInput({
        scenarioId: "scenario-001",
        input: scenarioInput(1),
      }),
    "SCHEMA_ERROR",
  );
  await expectCode(
    () =>
      service.writeScenarioManifest({
        scenarios: run.request.scenarios,
        summary: "free form",
      }),
    "SCHEMA_ERROR",
  );
  await expectCode(
    () =>
      service.writeScenarioManifest({
        scenarios: run.request.scenarios.map((entry, index) =>
          index === 0 ? { ...entry, category: "cross-field-invariants" } : entry,
        ),
      }),
    "SCHEMA_ERROR",
  );
});

test("rejects traversal, absolute paths, separators, Unicode, and case aliases", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(() => run.cleanup());
  const attacks = [
    "../rules.md",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "//server/share/file",
    "schemas\\v1.json",
    "schemas//v1.json",
    "e\u0301.md",
    "schemas\u2215v1.json",
    "Rules.md",
  ];
  for (const attack of attacks) {
    await assert.rejects(
      () => service.readContractFile({ path: attack }),
      (error) => {
        assert.match(error.code, /^(CASE_MISMATCH|INVALID_PATH|PATH_ESCAPE)$/);
        return true;
      },
    );
  }
});

test("rejects request hash errors, replacement, and open schemas", async (t) => {
  const badHash = baseRequest();
  badHash.requestHash = "0".repeat(64);
  const hashRun = await createRun(badHash);
  t.after(() => hashRun.cleanup());
  await expectCode(() => hashRun.open(), "REQUEST_HASH_MISMATCH");

  const invalidRun = await createRun(
    baseRequest({
      v1ConfigSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: true,
      },
    }),
  );
  t.after(() => invalidRun.cleanup());
  await expectCode(() => invalidRun.open(), "SCHEMA_ERROR");

  const run = await createRun();
  const service = await run.open();
  t.after(() => run.cleanup());
  const requestPath = path.join(run.contract, "request.json");
  const replacement = path.join(run.contract, "request-replacement.json");
  await writeFile(replacement, encodeJson(run.request));
  await rm(requestPath);
  await rename(replacement, requestPath);
  await expectCode(() => service.listContractFiles(), "REQUEST_CHANGED");
});

test("requires matching sandbox token and launcher-attested root identities", async (t) => {
  const tokenRun = await createRun();
  t.after(() => tokenRun.cleanup());
  await expectCode(
    () =>
      CorpusService.create({
        environment: {
          configPath: tokenRun.configPath,
          token: "x".repeat(64),
        },
      }),
    "SANDBOX_TOKEN_MISMATCH",
  );

  const pinnedRun = await createRun(undefined, { requestHash: "0".repeat(64) });
  t.after(() => pinnedRun.cleanup());
  await expectCode(() => pinnedRun.open(), "REQUEST_HASH_MISMATCH");

  const identityRun = await createRun();
  t.after(() => identityRun.cleanup());
  const original = `${identityRun.contract}-original`;
  await rename(identityRun.contract, original);
  await mkdir(identityRun.contract);
  await expectCode(() => identityRun.open(), "ROOT_IDENTITY_CHANGED");
});

test("fails closed when launcher-owned config or request is writable", async (t) => {
  const configRun = await createRun();
  t.after(() => configRun.cleanup());
  await chmod(configRun.configPath, 0o600);
  await expectCode(() => configRun.open(), "SANDBOX_UNVERIFIED");

  const requestRun = await createRun();
  t.after(() => requestRun.cleanup());
  await chmod(path.join(requestRun.contract, "request.json"), 0o600);
  await expectCode(() => requestRun.open(), "SANDBOX_UNVERIFIED");
});

test("rechecks sandbox config and root identity before and after operations", async (t) => {
  const configRun = await createRun();
  const configService = await configRun.open();
  t.after(() => configRun.cleanup());
  const replacement = `${configRun.configPath}.replacement`;
  await writeFile(replacement, encodeJson(configRun.sandbox));
  await rm(configRun.configPath);
  await rename(replacement, configRun.configPath);
  await expectCode(() => configService.listContractFiles(), "SANDBOX_CONFIG_CHANGED");

  const rootRun = await createRun();
  const moved = `${rootRun.contract}-moved`;
  const rootService = await rootRun.open({
    hooks: {
      beforeScenarioPublish: async () => {
        await rename(rootRun.contract, moved);
        await mkdir(rootRun.contract);
      },
    },
  });
  t.after(() => rootRun.cleanup());
  await expectCode(
    () =>
      rootService.writeScenarioInput({
        scenarioId: "scenario-001",
        config: scenarioInput(1),
      }),
    "ROOT_IDENTITY_CHANGED",
  );
});

test("rejects contract symlinks and staging junctions", async (t) => {
  const contractRun = await createRun();
  const outside = path.join(contractRun.cwd, "outside.md");
  await writeFile(outside, "secret");
  await rm(path.join(contractRun.contract, "rules.md"));
  try {
    await symlink(outside, path.join(contractRun.contract, "rules.md"), "file");
  } catch (error) {
    await contractRun.cleanup();
    if (error?.code === "EPERM") {
      t.skip("file symlinks require an unavailable Windows privilege");
      return;
    }
    throw error;
  }
  const contractService = await contractRun.open();
  t.after(() => contractRun.cleanup());
  await expectCode(() => contractService.listContractFiles(), "REPARSE_ESCAPE");

  const stagingRun = await createRun();
  const stagingService = await stagingRun.open();
  const outsideStaging = path.join(stagingRun.cwd, "outside-staging");
  await mkdir(outsideStaging);
  await symlink(
    outsideStaging,
    path.join(stagingRun.staging, "scenarios"),
    process.platform === "win32" ? "junction" : "dir",
  );
  t.after(() => stagingRun.cleanup());
  await expectCode(
    () =>
      stagingService.writeScenarioInput({
        scenarioId: "scenario-001",
        config: scenarioInput(1),
      }),
    "REPARSE_ESCAPE",
  );
  assert.deepEqual(await readdir(outsideStaging), []);
});

test("manifest revalidates every staged scenario and closes staging", async (t) => {
  const run = await createRun();
  const service = await run.open();
  t.after(() => run.cleanup());
  await fillValidCorpus(service, run.request);
  const first = path.join(run.staging, "scenarios", "scenario-001.json");
  await chmod(first, 0o600);
  await writeFile(first, encodeJson({ ...scenarioInput(1), oracle: "pass" }));
  await expectCode(
    () => service.writeScenarioManifest({ scenarios: run.request.scenarios }),
    "SCHEMA_ERROR",
  );

  await writeFile(first, encodeJson(scenarioInput(1)));
  await service.writeScenarioManifest({ scenarios: run.request.scenarios });
  await expectCode(
    () =>
      service.writeScenarioInput({
        scenarioId: "scenario-001",
        config: scenarioInput(1),
      }),
    "STAGING_FINALIZED",
  );
});

test("stale locks fail closed and are never stolen", async (t) => {
  const run = await createRun();
  t.after(() => run.cleanup());
  const lockPath = path.join(run.staging, ".corpus.lock");
  const owner = {
    version: 1,
    pid: 999_999,
    hostname: "crashed-owner",
    acquiredAt: "2000-01-01T00:00:00.000Z",
    nonce: "0".repeat(32),
  };
  await writeFile(lockPath, encodeJson(owner));
  const old = new Date(Date.now() - 120_000);
  await utimes(lockPath, old, old);
  await expectCode(() => run.open(), "LOCK_STALE");
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), owner);
});

test("lock release refuses changed owner metadata", async (t) => {
  const run = await createRun();
  const lockPath = path.join(run.staging, ".corpus.lock");
  const service = await run.open({
    hooks: {
      beforeScenarioPublish: async () => {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        await writeFile(lockPath, encodeJson({ ...owner, nonce: "f".repeat(32) }));
      },
    },
  });
  t.after(() => run.cleanup());
  await expectCode(
    () =>
      service.writeScenarioInput({
        scenarioId: "scenario-001",
        config: scenarioInput(1),
      }),
    "LOCK_OWNERSHIP_LOST",
  );
  assert.equal((await readdir(run.staging)).includes(".corpus.lock"), true);
});

test("enforces request byte limits and atomic write-once publication", async (t) => {
  const smallRequest = baseRequest();
  smallRequest.maxSizes = {
    ...smallRequest.maxSizes,
    scenarioBytes: 80,
  };
  smallRequest.requestHash = computeRequestHash(smallRequest);
  const smallRun = await createRun(smallRequest);
  const smallService = await smallRun.open();
  t.after(() => smallRun.cleanup());
  await expectCode(
    () =>
      smallService.writeScenarioInput({
        scenarioId: "scenario-001",
        config: scenarioInput(1),
      }),
    "LIMIT_EXCEEDED",
  );

  const run = await createRun();
  t.after(() => run.cleanup());
  const target = path.join(run.staging, "existing.json");
  await writeFile(target, '{"stable":true}\n');
  await expectCode(
    () => atomicWriteNewJson(target, { stable: false }, { maximumBytes: 1024 }),
    "CONFLICT",
  );
  assert.equal(await readFile(target, "utf8"), '{"stable":true}\n');

  const failed = path.join(run.staging, "failed.json");
  await assert.rejects(
    () =>
      atomicWriteNewJson(failed, { complete: true }, {
        maximumBytes: 1024,
        beforePublish: async () => {
          throw new Error("injected failure");
        },
      }),
    /injected failure/,
  );
  await assert.rejects(() => lstat(failed), { code: "ENOENT" });
  assert.deepEqual((await readdir(run.staging)).sort(), ["existing.json"]);
});
