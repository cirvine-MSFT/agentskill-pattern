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

These values are reproduced from `artifacts/baseline-report.json`; mutation
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
node .\scripts\promote.mjs --in .\staging\baseline.json `
  --out .\artifacts\baseline-corpus.json `
  --promoted-at 2026-07-29T00:00:00.000Z
node .\mutants\run.mjs --corpus .\artifacts\baseline-corpus.json `
  --out .\artifacts\baseline-kill-matrix.json
node .\scripts\report.mjs --corpus .\artifacts\baseline-corpus.json `
  --matrix .\artifacts\baseline-kill-matrix.json `
  --out .\artifacts\baseline-report.json
```

Generate the frozen 12-block schedule:

```powershell
node .\scripts\randomize.mjs --out .\design\schedule.json
```

Before any AI outcome, copy and fill the model-binding template with actual
platform evidence:

```powershell
node .\scripts\preflight-models.mjs `
  --evidence .\raw\model-binding-evidence.json `
  --out .\raw\availability.json
```

Exit code 2 means at least one factorial cell is unavailable. Do not substitute
a model or run a silent partial factorial.

## Layout

| Path | Purpose |
|---|---|
| `protocol.md` | Immutable arms, budgets, isolation, metrics, thresholds, and analysis |
| `fixture/spec/` | Executable public mapping and invariant program |
| `fixture/migration/` | Candidate spec interpreter |
| `fixture/oracle/` | Independent explicit reference implementation |
| `schemas/`, `validators/` | Input, staging, promotion, telemetry contracts and validators |
| `baseline/` | Decision, boundary, pairwise, grammar/property, and solver generator |
| `acceptance/`, `mutants/` | Generator-hidden rules/examples and deterministic faults |
| `design/` | Shared prompt, Skill/agent routing text, fixed models, seeds, and schedule |
| `staging/` | Inputs only; expected output is forbidden |
| `artifacts/` | Oracle-promoted deterministic corpus, kill matrix, and compact report |
| `tests/` | Reviewed goldens, metamorphic properties, parity, isolation, and reproduction |

Generator workspaces must exclude `acceptance`, `artifacts`, `fixture/oracle`,
`mutants`, `tests`, and prior runs. Delegated workers write staging directly;
parents consume only compact validator/promotion summaries, never the full
corpus.
