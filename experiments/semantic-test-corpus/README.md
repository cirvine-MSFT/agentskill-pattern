# Semantic migration corpus benchmark

Dependency-free Node 20 fixture and preregistration for comparing a strong
deterministic corpus generator with a full 2x2 model-tier by delegation design.
It migrates deterministic v1 service configurations to v2, promotes staged
inputs only through an independent oracle, emits semantic rule/path traces, and
scores 33 hidden mapping/invariant mutants.

**No AI trials have been run.** Checked results are deterministic arm-0
foundation measurements only.

## Checked deterministic foundation

| Measure | Result |
|---|---:|
| Unique staged/promoted cases | 60 / 60 |
| Semantically valid / intentional invalid cases | 40 / 20 |
| Rule coverage | 12 / 12 (100%) |
| Decision-path coverage | 67 / 67 (100%) |
| Invariant coverage | 15 / 15 (100%) |
| Semantic diagnostic categories | 5 / 5 (100%) |
| Hidden mutants killed | 33 / 33 (100%) |
| Exact duplicate inputs | 0 |

These values are reproduced from `evaluator/artifacts/baseline-report.json`; mutation
score is not evidence that the oracle is correct. Goldens and metamorphic
properties are separate prerequisites.

## Quick start

From this directory:

```powershell
npm test
npm run reproduce
```

Run the candidate migration with a JSON file or standard input:

```powershell
node .\fixture\cli.mjs .\path\to\v1-config.json
Get-Content .\path\to\v1-config.json -Raw | node .\fixture\cli.mjs
```

Regenerate the deterministic foundation:

```powershell
node .\baseline\generate.mjs --out .\staging\baseline.json
node .\scripts\validate-staging.mjs .\staging\baseline.json
node .\evaluator\promote.mjs --in .\staging\baseline.json `
  --out .\evaluator\artifacts\baseline-corpus.json `
  --promoted-at 2026-07-29T00:00:00.000Z
node .\evaluator\mutants\run.mjs `
  --corpus .\evaluator\artifacts\baseline-corpus.json `
  --out .\evaluator\artifacts\baseline-kill-matrix.json
node .\evaluator\report.mjs `
  --corpus .\evaluator\artifacts\baseline-corpus.json `
  --matrix .\evaluator\artifacts\baseline-kill-matrix.json `
  --out .\evaluator\artifacts\baseline-report.json
```

Generate the frozen 12-block schedule:

```powershell
node .\scripts\randomize.mjs --out .\design\schedule.json
```

Materialize a candidate repository outside the entire source repository:

```powershell
node .\scripts\materialize-candidate.mjs --out C:\benchmark-runs\B01-A1
```

The materialized repository contains the real `semantic-test-corpus` profile,
the dependency-free `semantic-corpus` MCP server, the immutable 60-slot request,
and public contract. A trusted coordinator must copy these into a disposable
non-repository run and establish the mandatory container/restricted-mount/ACL
boundary before server initialization. There is no in-repository lifetime
launcher or unsafe fallback.

After signed model completion, run the evaluator-only adapter outside model
context:

```powershell
node .\evaluator\adapter.mjs `
  --corpus-contract C:\isolated-runs\B01-A1\corpus-contract `
  --corpus-staging C:\isolated-runs\B01-A1\corpus-staging `
  --payload .\raw\model-complete-export.json `
  --signature .\raw\model-complete-export.sig `
  --public-key C:\trusted\copilot-platform-ed25519.pem `
  --run-id B01-A1 --block-id B01 --arm-id 1 --seed 1812433253 `
  --out .\staging\B01-A1.json
```

Its compact stdout reports the canonical staging path/hash and observed counts.
The full corpus remains evaluator-only.

Derive the canonical evaluator metrics artifact from that exact snapshot:

```powershell
node .\evaluator\metrics.mjs `
  --snapshot .\staging\B01-A1.json `
  --run-id B01-A1 --block-id B01 --arm-id 1 `
  --out .\metrics\B01-A1.json
```

The run record binds both snapshot and metrics hashes. A signed
`metrics.computed` event also binds the evaluator-code, mapping-spec, independent
oracle-code, and mutant-harness hashes. Statistics reloads the snapshot and
deterministically rederives the artifact; callers cannot supply promotion,
coverage, mutation, or diversity values.

For every measured AI run, bind its run record to the exact raw signed platform
export and verify all required parent/worker sessions:

```powershell
node .\scripts\preflight-models.mjs `
  --payload .\raw\platform-export.json `
  --signature .\raw\platform-export.sig `
  --public-key C:\trusted\copilot-platform-ed25519.pem `
  --runs .\raw\run-records.json `
  --out .\raw\availability.json
```

Exit code 2 means at least one measured run/role is unavailable. Do not substitute
a model or run a silent partial factorial.

Only after every run's signed isolation/budget audit is verified, execute the
registered primary analyses. The CLI authenticates the raw export itself:

```powershell
node .\evaluator\statistics.mjs `
  --in .\raw\blinded-run-artifacts.json `
  --payload .\raw\platform-export.json `
  --signature .\raw\platform-export.sig `
  --public-key C:\trusted\copilot-platform-ed25519.pem `
  --out .\raw\baseline-analysis.json
```

The evaluator runs 12 one-sided noninferiority hypotheses with one Holm
adjustment and 12 two-sided equality hypotheses with a separate Holm adjustment.
Only common complete blocks enter the paired tests. More than two incomplete
blocks forces `confirmatoryAvailable: false` and null noninferiority decisions.
Any AI run with unavailable frozen model evidence also withholds all
factorial/confirmatory decisions, even when 11 complete blocks remain.
The same output includes per-arm summaries, paired tier/delegation/interaction
and conditional simple-effect contrasts with the registered bootstrap, plus
0/1 and worst/best missing-outcome sensitivity bounds. With zero complete
blocks, paired comparisons and factorial results are null while deterministic
arm availability and descriptive summaries remain.
Input follows `schemas/statistics-input.schema.json`: each row supplies only
run identity, a metrics-artifact path, and (for AI runs) isolation roots. Run
records bind the snapshot and metrics hashes. The CLI rederives all outcome
values and derives model availability, isolation compliance, and budgets from
the authenticated export; caller outcome values, flags, and hashes are
forbidden. It also rejects
`input.options` and all top-level analysis overrides; alpha
0.05, the three registered margins, 10,000 draws, and seed 20260729 are frozen.

After the run, derive isolation compliance from that signed export:

```powershell
node .\scripts\verify-isolation-evidence.mjs `
  --payload .\raw\platform-export.json `
  --signature .\raw\platform-export.sig `
  --public-key C:\trusted\copilot-platform-ed25519.pem `
  --arm-id 1 `
  --run-id B01-A1 `
  --contract-root C:\isolated-runs\B01-A1\corpus-contract `
  --staging-root C:\isolated-runs\B01-A1\corpus-staging `
  --evaluator-root (Join-Path $PWD evaluator) `
  --snapshot-path (Join-Path $PWD staging\B01-A1.json) `
  --out .\raw\B01-A1-isolation.json
```

Isolation verification also requires signed completion and unblinding
boundaries. Any authenticated `outcome.accessed` event before either boundary
fails compliance.
Every network event from an authenticated run session must carry its run/arm/
role, actor session, call ID, endpoint, and allow/deny decision; unscoped or
mismapped signed events fail closed. Scoping checks both `sessionId` and
`actorSessionId`, and a dataset-wide attribution pass rejects unknown,
ambiguous, or cross-run identities before any per-run audit.

### Real Copilot smoke audit availability

`fixtures/platform-audit/` contains privacy-bounded, byte-exact relevant JSONL
event captures from real Copilot CLI 1.0.77 smoke sessions for direct inline MCP
calls and parent-to-`semantic-test-corpus` delegation. Replay them with:

```powershell
node .\scripts\platform-audit-adapter.mjs `
  --in .\fixtures\platform-audit\inline-smoke.captured.jsonl `
  --cell inline --out .\raw\inline-smoke-audit.json
```

The captures record actual runtime MCP names, parent/worker attribution,
and delegation lifecycle, but Copilot CLI JSONL does not export the required
detached Ed25519 signature, sandbox policy/filesystem audit, or signed run,
adapter, and metrics boundaries. The adapter therefore exits 2 and marks both
smoke cells/protocol cells **unavailable**. It never fabricates a signed
platform export. Synthetic signed-event streams remain unit tests only.

## Layout

| Path | Purpose |
|---|---|
| `protocol.md` | Immutable arms, budgets, isolation, metrics, thresholds, and analysis |
| `fixture/spec/` | Executable public mapping and invariant program |
| `fixture/migration/` | Candidate spec interpreter |
| `schemas/`, `validators/` | Input, staging, metrics, audit, promotion, and telemetry contracts |
| `baseline/` | Decision, boundary, pairwise, grammar/property, and solver generator |
| `candidate-template/`, `design/candidate-manifest.json` | External candidate materialization allowlist |
| `evaluator/` | Isolated adapter, oracle, metrics, acceptance, mutants, statistics, goldens, and tests |
| `design/` | Immutable MCP request, shared prompt/Skill, evidence contract, fixed models, seeds, and schedule |
| `staging/` | Canonical evaluator snapshots; expected output is forbidden |

Measured generators run only against disposable launcher-confined contract and
staging roots; the evaluator directory and repository are inaccessible. Signed
platform policy/access exports prove contract-read-only/staging-read-write
access and network denial. Inline parents and delegated workers use the same
four actual MCP tools. Both delegated arms invoke the same bytes at the actual
registered `.github/skills/semantic-test-corpus/SKILL.md` path and the
`semantic-test-corpus` agent, returning only its
terminal success/failure line; parents never read the corpus.
Dataset-wide attribution covers tool/results, filesystem, network, outcome,
delegation, completion, and unblinding events; generation activity at or after
completion fails closed.
Signed start sequence/timestamps enforce the frozen within-block order. Signed
completion, tool-call counts, and parent-plus-worker token reports derive the
30-minute/120-call/100,000-token run budgets.
The materializer's in-tree `.test-work/` allowance exists only for the cleaned
regression test and is forbidden for measured runs.
Production materialization canonicalizes source and destination with `realpath`
and rejects symlink, junction, or reparse components before containment checks.
