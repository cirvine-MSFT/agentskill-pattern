import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteNewJson,
  CorpusService,
} from "../../tools/semantic-corpus-mcp/lib.mjs";

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "semantic-corpus-"));
  await mkdir(path.join(cwd, "corpus-contract"));
  await mkdir(path.join(cwd, "corpus-staging"));
  return {
    cwd,
    contract: path.join(cwd, "corpus-contract"),
    staging: path.join(cwd, "corpus-staging"),
    service: new CorpusService({ cwd }),
    async cleanup() {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function scenario(index) {
  const id = `scenario-${String(index).padStart(2, "0")}`;
  return {
    id,
    input: { id, enabled: index % 2 === 0, region: index % 3 === 0 ? null : "us" },
    metadata: {
      scenarioId: id,
      category: index % 2 === 0 ? "mapping-rules" : "cross-field-invariants",
      rationale: `Exercises source-side semantic combination number ${index}.`,
      contractRefs: ["rules.md"],
    },
  };
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("normal contract reads and 40-scenario write flow", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  await writeFile(path.join(ctx.contract, "rules.md"), "# Rules\n");
  await mkdir(path.join(ctx.contract, "schemas"));
  await writeFile(path.join(ctx.contract, "schemas", "v1.json"), '{"type":"object"}\n');

  const listing = await ctx.service.listContractFiles();
  assert.deepEqual(listing.files.map((entry) => entry.path), ["rules.md", "schemas/v1.json"]);
  const read = await ctx.service.readContractFile({ path: "rules.md" });
  assert.equal(read.content, "# Rules\n");

  const metadata = [];
  for (let index = 1; index <= 40; index += 1) {
    const item = scenario(index);
    metadata.push(item.metadata);
    const written = await ctx.service.writeScenarioInput({
      scenarioId: item.id,
      input: item.input,
    });
    assert.equal(written.status, "written");
  }
  const result = await ctx.service.writeScenarioManifest({
    scenarios: metadata,
    summary: "Candidate source records only; deterministic validation remains parent-owned.",
  });
  assert.equal(result.scenarioCount, 40);
  assert.equal(result.path, "corpus-staging/manifest.json");

  const storedInput = JSON.parse(
    await readFile(path.join(ctx.staging, "scenarios", "scenario-01.json"), "utf8"),
  );
  assert.deepEqual(storedInput, scenario(1).input);
  const manifest = JSON.parse(
    await readFile(path.join(ctx.staging, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.kind, "semantic-source-scenarios");
  assert.equal(manifest.scenarioCount, 40);
  assert.equal(manifest.scenarios[0].file, "scenarios/scenario-01.json");
  assert.equal(JSON.stringify(manifest).includes("expectedOutput"), false);
});

test("rejects traversal, absolute paths, alternate separators, and Unicode tricks", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  await writeFile(path.join(ctx.contract, "rules.md"), "rules");

  const attacks = [
    "../rules.md",
    "nested/../../rules.md",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "//server/share/file",
    "nested\\rules.md",
    "nested//rules.md",
    "e\u0301.md",
    "nested\u2215rules.md",
    "nested\uFF0Frules.md",
  ];
  for (const attack of attacks) {
    await assert.rejects(
      () => ctx.service.readContractFile({ path: attack }),
      (error) => {
        assert.match(error.code, /^(INVALID_PATH|PATH_ESCAPE)$/);
        return true;
      },
      attack,
    );
  }
});

test("rejects case-insensitive aliases instead of following platform casing", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  await writeFile(path.join(ctx.contract, "Rules.md"), "rules");
  await expectCode(
    () => ctx.service.readContractFile({ path: "rules.md" }),
    "CASE_MISMATCH",
  );

  await mkdir(path.join(ctx.staging, "Scenarios"));
  await expectCode(
    () =>
      ctx.service.writeScenarioInput({
        scenarioId: "case-attack",
        input: { id: 1 },
      }),
    "CASE_MISMATCH",
  );
});

test("rejects contract symlink escapes", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  const outside = path.join(ctx.cwd, "outside.json");
  await writeFile(outside, '{"secret":true}');
  try {
    await symlink(outside, path.join(ctx.contract, "link.json"), "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("file symlinks require an unavailable Windows privilege");
      return;
    }
    throw error;
  }

  await expectCode(
    () => ctx.service.readContractFile({ path: "link.json" }),
    "REPARSE_ESCAPE",
  );
  await expectCode(() => ctx.service.listContractFiles(), "REPARSE_ESCAPE");
});

test("rejects directory junction and reparse escapes", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  const outside = path.join(ctx.cwd, "outside-contract");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.md"), "secret");
  await symlink(
    outside,
    path.join(ctx.contract, "jump"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await expectCode(
    () => ctx.service.readContractFile({ path: "jump/secret.md" }),
    "REPARSE_ESCAPE",
  );
  await expectCode(() => ctx.service.listContractFiles(), "REPARSE_ESCAPE");
});

test("rejects a staging scenarios junction", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  const outside = path.join(ctx.cwd, "outside-staging");
  await mkdir(outside);
  await symlink(
    outside,
    path.join(ctx.staging, "scenarios"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await expectCode(
    () =>
      ctx.service.writeScenarioInput({
        scenarioId: "junction-attack",
        input: { id: 1 },
      }),
    "REPARSE_ESCAPE",
  );
  assert.deepEqual(await readdir(outside), []);
});

test("rejects a fixed root that is itself a junction", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  const outside = path.join(ctx.cwd, "outside-root");
  await mkdir(outside);
  await rm(ctx.contract, { recursive: true });
  await symlink(
    outside,
    ctx.contract,
    process.platform === "win32" ? "junction" : "dir",
  );

  await expectCode(() => ctx.service.listContractFiles(), "REPARSE_ESCAPE");
});

test("structurally rejects expected, oracle, migration-source, and test-path fields", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  const forbidden = [
    { expectedOutput: { version: 2 } },
    { "expected.output": { version: 2 } },
    { expectedValue: "v2" },
    { nested: { oracle_result: "ok" } },
    { oracleResponse: "ok" },
    { migrationSource: "src/migrate.js" },
    { migrationCode: "return v2" },
    { sourcePath: "src/migrate.js" },
    { sourcePath: "tests/legacy/input.json" },
    { testFile: "tests/legacy/input.json" },
    { fileName: "../tests/oracle.json" },
    { fixturePath: "../fixtures/input.json" },
    { filePath: "C:\\repo\\migration.js" },
  ];
  for (const [index, input] of forbidden.entries()) {
    await assert.rejects(
      () =>
        ctx.service.writeScenarioInput({
          scenarioId: `forbidden-${index}`,
          input,
        }),
      (error) => {
        assert.match(
          error.code,
          /^(FORBIDDEN_FIELD|FORBIDDEN_PATH|INVALID_PATH|PATH_ESCAPE)$/,
        );
        return true;
      },
    );
  }

  await expectCode(
    () =>
      ctx.service.writeScenarioManifest({
        scenarios: [],
        expectedOutput: {},
      }),
    "SCHEMA_ERROR",
  );
});

test("rejects prohibited artifacts in free-form manifest metadata", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  const entries = [];
  for (let index = 1; index <= 40; index += 1) {
    const item = scenario(index);
    entries.push(item.metadata);
    await ctx.service.writeScenarioInput({ scenarioId: item.id, input: item.input });
  }
  entries[0] = {
    ...entries[0],
    rationale: "Describes the oracle result for this source record.",
  };
  await expectCode(
    () => ctx.service.writeScenarioManifest({ scenarios: entries }),
    "FORBIDDEN_FIELD",
  );
});

test("manifest publication permanently closes scenario staging", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  await writeFile(path.join(ctx.contract, "rules.md"), "rules");
  const entries = [];
  for (let index = 1; index <= 40; index += 1) {
    const item = scenario(index);
    entries.push(item.metadata);
    await ctx.service.writeScenarioInput({ scenarioId: item.id, input: item.input });
  }
  await ctx.service.writeScenarioManifest({ scenarios: entries });
  await expectCode(
    () =>
      ctx.service.writeScenarioInput({
        scenarioId: "late-scenario",
        input: { id: "late" },
      }),
    "STAGING_FINALIZED",
  );
});

test("enforces payload, count, and write-once limits", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  await expectCode(
    () =>
      ctx.service.writeScenarioInput({
        scenarioId: "oversize",
        input: { text: "x".repeat(8 * 1024 + 1) },
      }),
    "LIMIT_EXCEEDED",
  );
  await expectCode(
    () =>
      ctx.service.writeScenarioInput({
        scenarioId: "oversize-document",
        input: Object.fromEntries(
          Array.from({ length: 10 }, (_, index) => [`field${index}`, "x".repeat(7_000)]),
        ),
      }),
    "LIMIT_EXCEEDED",
  );

  await writeFile(path.join(ctx.contract, "rules.md"), "rules");
  for (let index = 1; index <= 60; index += 1) {
    const item = scenario(index);
    await ctx.service.writeScenarioInput({ scenarioId: item.id, input: item.input });
  }
  await expectCode(
    () =>
      ctx.service.writeScenarioInput({
        scenarioId: "scenario-61",
        input: { id: 61 },
      }),
    "LIMIT_EXCEEDED",
  );
  await expectCode(
    () =>
      ctx.service.writeScenarioInput({
        scenarioId: "scenario-01",
        input: { id: "replacement" },
      }),
    "LIMIT_EXCEEDED",
  );
  await expectCode(
    () =>
      ctx.service.writeScenarioManifest({
        scenarios: Array.from({ length: 39 }, (_, index) => scenario(index + 1).metadata),
      }),
    "LIMIT_EXCEEDED",
  );
});

test("enforces contract and manifest byte limits", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  await writeFile(
    path.join(ctx.contract, "too-large.md"),
    "x".repeat(256 * 1024 + 1),
  );
  await expectCode(() => ctx.service.listContractFiles(), "LIMIT_EXCEEDED");
  await expectCode(
    () => ctx.service.readContractFile({ path: "too-large.md" }),
    "LIMIT_EXCEEDED",
  );

  const zeroMinimum = new CorpusService({
    cwd: ctx.cwd,
    limits: { scenariosMin: 0 },
  });
  await expectCode(
    () =>
      zeroMinimum.writeScenarioManifest({
        scenarios: [],
        summary: "x".repeat(2_001),
      }),
    "LIMIT_EXCEEDED",
  );
});

test("atomic publication preserves prior data and cleans failed temporary files", async (t) => {
  const ctx = await fixture();
  t.after(() => ctx.cleanup());
  const directory = path.join(ctx.staging, "atomic");
  await mkdir(directory);
  const existing = path.join(directory, "existing.json");
  await writeFile(existing, '{"stable":true}\n');

  await expectCode(
    () => atomicWriteNewJson(existing, { stable: false }),
    "CONFLICT",
  );
  assert.equal(await readFile(existing, "utf8"), '{"stable":true}\n');

  const target = path.join(directory, "new.json");
  await assert.rejects(
    () =>
      atomicWriteNewJson(target, { complete: true }, {
        beforePublish: async () => {
          throw new Error("injected publication failure");
        },
      }),
    /injected publication failure/,
  );
  await assert.rejects(() => readFile(target), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), ["existing.json"]);
});
