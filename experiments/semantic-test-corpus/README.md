# Semantic migration corpus benchmark — corrective execution v4

This directory contains the corrective v4 12-block, six-arm descriptive benchmark.
V2 and v3 evidence is historical and unchanged. V3-B01 is partially consumed and
aborted: A4 and A2 started, while A0/A1/A3/A5 were untouched; every V3-B01 identity is
retired. `execution-amendment-v4.md` and `design/v4/` are normative.

**V4 is not executable.** Pilot-only live preflight series R3 passed A1/A2/A3/A5 but
failed A4's exact Skill ordering and worker-task final byte. No measured v4 unit has
started, and the harness blocks before slot reservation unless all five live smokes
pass.

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
The fixed profile is the frozen mechanism because real same-invocation model override
is unavailable; an invocation override must not be substituted.

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

Static preflight performs no corpus generation. It verifies Copilot CLI 1.0.77's real
prompt surface, configured MCP servers, pinned profiles, and local usage-store columns:

```powershell
node .\scripts\preflight-execution.mjs `
  --cli copilot `
  --session-store $env:USERPROFILE\.copilot\session-store.db `
  --out C:\benchmark-runs\execution-preflight.json
```

The command fails closed with exit code 2 unless the exact version, flags, absence of
the fabricated `create-session` subcommand, MCP isolation controls, profiles, and usage
schema are present. It starts no measured session. Static preflight alone never enables
measured execution.

Run the disposable live gate in an empty external root:

```powershell
node .\scripts\live-preflight.mjs `
  --cli copilot `
  --session-store $env:USERPROFILE\.copilot\session-store.db `
  --pilot-series R1 `
  --work-root C:\benchmark-pilots\v4-r1 `
  --out C:\benchmark-pilots\v4-live-preflight-r1.json
```

This uses the measured materializer, sandbox, MCP probe, command builder, and evidence
rules with pilot-only IDs. It runs all five AI surfaces and exits 2 unless every one
passes. Smoke usage and staging are excluded from outcomes.

## Dry-run and execute

Use empty external candidate and artifact directories. The harness rejects in-repo
measured candidates, materializes only the immutable commit/tree/blob pin in
`design/v4/source-pin.json`, writes the seeded task and kickoff bytes, creates contract,
staging, MCP, and sandbox configuration, and forms one atomic kickoff command.

```powershell
node .\scripts\run-controlled-harness.mjs `
  --cli copilot `
  --session-store $env:USERPROFILE\.copilot\session-store.db `
  --candidate-root C:\benchmark-candidates\V4-B01-A2 `
  --artifact-root C:\benchmark-artifacts\V4-B01-A2 `
  --start-index C:\benchmark-artifacts\start-index.json `
  --live-preflight C:\benchmark-pilots\v4-live-preflight-r1.json `
  --block B01 --arm 2 --dry-run
```

Remove `--dry-run` only after all live arms pass. Each AI slot runs one real prompt
command with its predetermined UUID, exact parent model, optional frozen top-level
agent, JSON output, candidate cwd, closed tool list, generated MCP config, and explicit
disabling of every configured nonsemantic MCP server. The harness machine-generates:

- exact CLI arguments, predetermined UUID, and terminal `result.sessionId`;
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
global sequence. Preflight-unavailable slots are recorded and advance it. Anything after the lifecycle marker is started/uncertain, preserves partial files and
costs, and is never retried. CLI 1.0.77 supplies no authoritative no-kickoff,
no-session, zero-usage receipt.

## Descriptive analysis

The analyzer requires exactly 72 validated unit records. Each is either an eligible
artifact or an evidence-bound unavailable/excluded record; omission fails. The
manifest must bind the finalized 72-record start index and its SHA-256 file. Every
unavailable/excluded disposition is cross-bound to that index and its typed raw
preflight, uncertainty, retry-exhaustion, or model-preflight evidence. Eligible
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
most 90% of GPT inline; report both costs. All target comparisons require the same 12
complete blocks. Wall time at most 80% is secondary.

Comparable telemetry includes compact-return bytes, compaction availability,
completion counts, cached/reasoning tokens, TTFT/inter-token latency, request
multiplier/credits, exposed-tool availability, calls/results/result bytes, selected
attempt usage, and all-attempt operational usage. Unsupported fields are explicit
`null` with availability reasons.
Started excluded units retain validated local evidence and are reported separately in
excluded operational-usage totals; they never enter eligible quality estimates.
Started-uncertain units also publish a typed, hash-bound partial-usage record. Available
credits, nano-AIU, input/output/model tokens, completions, duration, and tool
call/result counts contribute to all-attempt operational totals. Missing usage or event
fields remain explicit unavailable measurements with reasons. Partial attempts never
enter selected quality outcomes.
Malformed or cross-session usage/events are not parsed into metrics: their normal
source path/hash fields are null, while typed `invalidSources` entries preserve kind,
path, SHA-256, byte length, and validation error.
