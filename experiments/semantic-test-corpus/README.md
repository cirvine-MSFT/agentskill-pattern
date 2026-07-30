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

Materialize a candidate repository outside this checkout:

```powershell
node .\scripts\materialize-candidate.mjs --out C:\benchmark-runs\B01-A1
```

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

After blinded run metrics are frozen, execute the registered primary analyses:

```powershell
node .\evaluator\statistics.mjs `
  --in .\raw\blinded-run-metrics.json `
  --out .\raw\baseline-analysis.json
```

The evaluator runs 12 one-sided noninferiority hypotheses with one Holm
adjustment and 12 two-sided equality hypotheses with a separate Holm adjustment.
Only common complete blocks enter the paired tests. More than two incomplete
blocks forces `confirmatoryAvailable: false` and null noninferiority decisions.
The same output includes per-arm summaries, paired tier/delegation/interaction
and conditional simple-effect contrasts with the registered bootstrap, plus
0/1 and worst/best missing-outcome sensitivity bounds. With zero complete
blocks, paired comparisons and factorial results are null while deterministic
arm availability and descriptive summaries remain.
The CLI rejects `input.options` and all top-level analysis overrides; alpha
0.05, the three registered margins, 10,000 draws, and seed 20260729 are frozen.

After the run, derive isolation compliance from that signed export:

```powershell
node .\scripts\verify-isolation-evidence.mjs `
  --payload .\raw\platform-export.json `
  --signature .\raw\platform-export.sig `
  --public-key C:\trusted\copilot-platform-ed25519.pem `
  --arm-id 1 `
  --run-id B01-A1 `
  --candidate-root C:\benchmark-runs\B01-A1 `
  --evaluator-root (Join-Path $PWD evaluator) `
  --staging-path C:\benchmark-runs\B01-A1\staging\B01-A1.json `
  --out .\raw\B01-A1-isolation.json
```

Isolation verification also requires signed completion and unblinding
boundaries. Any authenticated `outcome.accessed` event before either boundary
fails compliance.
Every network event from an authenticated run session must carry its run/arm/
role, actor session, call ID, endpoint, and allow/deny decision; unscoped or
mismapped signed events fail closed.

## Layout

| Path | Purpose |
|---|---|
| `protocol.md` | Immutable arms, budgets, isolation, metrics, thresholds, and analysis |
| `fixture/spec/` | Executable public mapping and invariant program |
| `fixture/migration/` | Candidate spec interpreter |
| `schemas/`, `validators/` | Input, staging, promotion, telemetry contracts and validators |
| `baseline/` | Decision, boundary, pairwise, grammar/property, and solver generator |
| `candidate-template/`, `design/candidate-manifest.json` | External candidate materialization allowlist |
| `evaluator/` | Isolated oracle, acceptance, mutants, statistics, goldens, artifacts, and evaluator tests |
| `design/` | Shared prompt/Skill, evidence contract, fixed models, seeds, and schedule |
| `staging/` | Inputs only; expected output is forbidden |

Measured generators run only in external repositories created by the
materializer; the evaluator directory is never copied or mounted. Signed
platform policy/access exports prove candidate-root-only filesystem access and
network denial. Both delegated arms invoke the same byte-identical materialized
Skill and return only compact staging metadata; parents never read the corpus.
The materializer's in-tree `.test-work/` allowance exists only for the cleaned
regression test and is forbidden for measured runs.
