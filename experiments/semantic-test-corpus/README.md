# Semantic migration corpus benchmark — execution v2

This directory contains the sole executable protocol: a frozen 12-block, six-arm,
descriptive benchmark for generating semantic v1 migration-test inputs. **No measured
AI trials have run.** `protocol.md` is preserved only as historical v1 provenance and
is unavailable for execution or inference.

## Frozen arms

| Arm | Execution |
|---:|---|
| 0 | General deterministic script using only public schema/rules/invariants |
| 1 | GPT-5.6 Sol inline |
| 2 | GPT-5.6 Sol → registered `semantic-test-corpus` agent, inherited GPT |
| 3 | Claude Haiku 4.5 inline |
| 4 | Claude Haiku 4.5 → registered `semantic-test-corpus`, inherited Haiku |
| 5 | GPT-5.6 Sol → registered `semantic-test-corpus-haiku`, profile-fixed Haiku |

Arms 2, 4, and 5 use the same Skill route, four MCP tools, instructions, worker task
bytes, staging behavior, and compact return. The Haiku profile is generated
byte-identically from the registered profile except name/model. Arm 5 is unavailable
unless real atomic preflight observes that profile and `claude-haiku-4.5`.

## Validate and reproduce

Run from this directory:

```powershell
npm test
npm run reproduce
```

The checked general-script result is intentionally not oracle/mutant optimized:
60/60 structurally valid inputs, 12/12 rules, 55/67 semantic paths, 15/15
invariants, and 19/33 mutants killed. Evaluator-only mutant viability references
are isolated in `evaluator/mutants/oracle-tuned-reference.json`; the baseline import
test rejects evaluator, held-out, oracle, mutant, or golden dependencies.

Regenerate the frozen schedule:

```powershell
npm run randomize
```

## Real preflight

Preflight performs no corpus generation. Arm 5 availability requires an atomic custom
agent selection probe with observed agent/session/model evidence:

```powershell
node .\scripts\preflight-execution.mjs `
  --cli copilot `
  --out C:\benchmark-runs\execution-preflight.json
```

The command fails closed with exit code 2 unless the CLI/adapter proves atomic local
session creation, prompt-file/model binding, exact raw event and usage export, and
the mechanisms needed by each arm. Stock CLI builds that do not expose the explicit
capability contract mark AI arms unavailable. In particular, missing fixed-model custom-agent selection or observed probe evidence
marks arm 5 unavailable before benchmark kickoff.

## Dry-run and execute

Use empty external candidate and artifact directories. The harness rejects in-repo
measured candidates, materializes only the immutable commit/tree/blob pin in
`design/source-pin.json`, writes the seeded task and kickoff bytes, creates contract,
staging, MCP, and sandbox configuration, and forms one atomic kickoff command.

```powershell
node .\scripts\run-controlled-harness.mjs `
  --cli C:\trusted\copilot-benchmark-adapter.mjs `
  --project-id <external-candidate-project-id> `
  --candidate-root C:\benchmark-candidates\B01-A4 `
  --artifact-root C:\benchmark-artifacts\B01-A4 `
  --start-index C:\benchmark-artifacts\start-index.json `
  --block B01 --arm 4 --dry-run
```

Remove `--dry-run` only after reviewing preflight. The adapter contract executes a
single `create-session` command containing local execution, autopilot mode, exact
parent model, candidate commit, prompt file/hash, and—for delegated arms—the exact
registered agent/worker model. The harness machine-generates, rather than accepts
hand-authored:

- session request/response and exact app/CLI session IDs;
- immutable raw events and usage export;
- candidate source commit/tree/blobs, terminal commit, and boundary hash;
- attempt, manifest, local evidence, model preflight, snapshot, metrics, evaluation,
  start capture, and capture provenance artifacts.

Generated task and kickoff bytes must match each frozen schedule SHA before launch and
again at collection. A write-once lifecycle marker is durable before every kickoff or
deterministic process. Raw artifacts are created once, hashed, and made read-only. They remain unsigned,
local, descriptive evidence—not signed audit, sandbox compliance, or causal proof.

Validate the complete captured start sequence:

```powershell
node .\scripts\validate-start-order.mjs `
  --in C:\benchmark-artifacts\start-index.json
```

All 72 ordered records must derive from immutable sources and increase in the frozen
global sequence. Preflight-unavailable slots are recorded and advance it. Anything
after the lifecycle marker is started/uncertain, preserves partial files and costs, and
is never retried. A single retry requires an authoritative no-kickoff, no-session,
zero-usage receipt.

## Descriptive analysis

The analyzer requires exactly 72 validated unit records. Each is either an eligible
artifact or an evidence-bound unavailable/excluded record; omission fails. Eligible
runs require observed exact session, parent/worker model, Skill/agent mechanism,
tool/role lifecycle, budget, source, terminal commit, and candidate hash evidence
are eligible. Unavailable units are explicit and excluded.

```powershell
npm run analyze -- `
  --in C:\benchmark-artifacts\descriptive-artifacts.json `
  --out C:\benchmark-artifacts\descriptive-summary.json
```

The frozen contrasts are script versus each AI arm; GPT inline versus GPT→GPT;
GPT→GPT versus GPT→Haiku; Haiku inline versus Haiku→Haiku; GPT inline versus the
GPT→Haiku target; and the complete 2×2 model/delegation contrasts. Outputs contain
only per-arm/block point values and all available within-block differences.

The target-arm practical rule uses point estimates: promotion must be at least baseline
minus 5 percentage points, path coverage baseline minus 3 points, and mutant kill rate
baseline minus 5 points. A positive efficiency signal additionally requires parent
cumulative input at most 85% of GPT inline and both total nano-AIU and total credits at
most 90% of GPT inline; report both costs. Wall time at most 80% is secondary.

Comparable telemetry includes compact-return bytes, compaction availability,
completion counts, cached/reasoning tokens, TTFT/inter-token latency, request
multiplier/credits, exposed-tool availability, calls/results/result bytes, selected
attempt usage, and all-attempt operational usage. Unsupported fields are explicit
`null` with availability reasons.
