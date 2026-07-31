# Semantic corpus execution amendment v2.0.0

**Protocol ID:** `semantic-test-corpus-execution-v2`  
**Status:** frozen before AI measurement on 2026-07-31. No measured AI runs or AI
outcomes existed when this amendment was committed.

This document is the complete normative v2 execution protocol. `protocol.md` v1.4.0
is historical and unavailable. The
fixture, 60-case contract, deterministic oracle/evaluator, promotion, trace,
33-mutant, redundancy, diversity, confinement, and parent corpus-opacity rules in
v1 remain unchanged. This amendment replaces v1's arms, schedule, execution
evidence tier, retry rule, measurements, and statistical claims for this execution.

## Design and arms

The design is 12 randomized complete blocks with six arms per block: 72 planned
run units, comprising 12 deterministic and 60 AI units. Each block uses the frozen
seed and within-block order in `design/seeds.json` and `design/schedule.json`.

| Arm | Parent | Worker | Mechanism |
|---:|---|---|---|
| 0 | None | None | General public-contract-only deterministic script |
| 1 | GPT-5.6 Sol | None | Inline, actual `semantic-corpus/*` MCP tools |
| 2 | GPT-5.6 Sol | GPT-5.6 Sol | Registered Skill and inherited-model agent |
| 3 | Claude Haiku 4.5 | None | Inline, same MCP tools |
| 4 | Claude Haiku 4.5 | Claude Haiku 4.5 | Registered Skill and inherited-model agent |
| 5 | GPT-5.6 Sol | Claude Haiku 4.5 | Same Skill/agent, invocation-only model override |

All arms use the same immutable request, shared task bytes, MCP server, four-tool
surface, output contract, confinement, and evaluator. Arms 2, 4, and 5 invoke the
same `semantic-test-corpus` Skill and registered agent. Arm 5 changes only the worker
model on that invocation. The fixed-Haiku profile is removed. If real preflight
cannot prove this override before kickoff, arm 5 is unavailable; another profile,
identity, invocation, or tool surface must not be substituted.

`design/condition-instructions.json` freezes the condition-specific kickoff text.
The block seed is appended to the pinned shared task before materialization and is
therefore in the exact kickoff and worker task bytes. Condition text may select only the
registered execution mechanism and may not add corpus-generation guidance.

## Descriptive local evidence tier

Copilot CLI 1.0.71 does not provide the detached signed audit, sandbox, run,
adapter, and metrics envelope required by v1. Strict confirmatory compliance
therefore remains unavailable. This execution uses `descriptive-local-v1` evidence:

- exact app `create_session` request/response, project session ID, and internal
  CLI `session.start.data.sessionId`;
- byte-exact local immutable `events.jsonl` and an exact
  `assistant_usage_events` SQLite export, each SHA-256 bound;
- exact terminal candidate commit and candidate boundary snapshot SHA-256;
- observed model on every local usage completion, with parent/worker attribution;
- observed tool/delegation events and explicit unavailable fields.

This evidence is unsigned and local. It must never be called signed evidence,
compliance proof, sandbox proof, or an authenticated platform envelope. Hashes
detect changes after collection; they do not establish an external trust anchor.
Mechanism, model, session, and field availability are reported independently.
Missing or ambiguous fields remain `null` with a reason and are never inferred
from outcome quality.

After every started attempt and before staged outcomes are opened,
the collector, `scripts/preflight-local-model.mjs`, and analyzer require exact
session, model, mechanism, tool, role/lifecycle, budget, candidate, source, and
hash evidence. A wrong or missing
model/mechanism after kickoff is unavailable and is not retried. Exactly one retry
is permitted only for an operational failure before session creation and kickoff;
the record must say `kickoffStarted: false` and contain zero model usage. All-attempt
operational usage and selected-attempt usage are retained separately. Validator
failure, timeout, or quality never permits a retry.

## Session creation and candidate boundary

Every AI attempt is created locally and atomically with the app `create_session`
operation: `execution_location` is `local`, kickoff `mode` is `autopilot`, and the
project, candidate base, exact parent model, and complete kickoff prompt must be
present in the creation call. Never create an idle session for preflight
and later send the measured prompt; that separates model binding from kickoff and
invalidates session freshness. Delegated worker creation remains inside the
registered Skill/router invocation.

`scripts/materialize-candidate.mjs` creates an external candidate repository from
the exact commit, tree, and blob IDs in `design/source-pin.json`; symbolic refs,
working-tree bytes, and `HEAD` are forbidden. It returns the immutable boundary hash
and terminal commit. The run manifest binds all values. The launcher enforces read-only contract
and sandbox configuration, writable staging, denied evaluator/repository roots,
and denied network. Local evidence can record these facts or failures but cannot
upgrade them to compliance proof.

The parent must not read, validate, package, copy, or summarize the full staged
corpus. After model completion, evaluator-only `evaluator/local-adapter-v2.mjs` snapshots
the confined staging files, and the deterministic evaluator computes expected
results and quality metrics outside parent and worker context.

## Budgets and measurements

Every run targets exactly 60 cases. AI limits are 30 wall-clock minutes, 120 total
tool calls, and 100,000 model tokens summed over parent and worker. Arm 0 has the
same case and wall limits and no AI budget.

Collect, separately for parent, worker, and total where applicable:

- AI credits derived exactly as `total_nano_aiu / 1e9`, raw nano-AIU, input,
  output, cache-read, cache-write, total cached tokens, and completion counts;
- premium requests when the local store exposes them, otherwise explicit
  unavailable `null`;
- parent cumulative and peak completion input, observed tool schemas/count when
  available, tool calls/results/result bytes, and the compact delegated return;
- reasoning tokens, request multipliers, TTFT, inter-token latency, completion
  counts, cached tokens, exposed-tool and compaction availability;
- wall time, parent active, worker active, and parent wait when derivable from
  local timestamps;
- promotion/structural validity; actual traced rules, paths, invariants, and
  diagnostics; kill/survival outcomes for all 33 mutants; exact/semantic
  redundancy and diversity;
- model, mechanism, session, and field-evidence availability plus every deviation.

The SQLite `input_tokens` value is recorded per completion. "Parent cumulative
input" is their sum and "parent peak input" is their maximum; neither is relabeled
as unique context tokens. Premium-request and tool-schema fields are unavailable
when absent from the local format.

## Analysis and claims

This execution is descriptive only. Report per-arm point estimates, all block
values, and within-block values for the frozen script-each, GPT-inline/GPT→GPT,
GPT→GPT/GPT→Haiku, Haiku-inline/Haiku→Haiku, GPT-inline/target, and complete
2×2 contrasts. Do not compute or publish
p-values, confidence intervals, bootstrap intervals, noninferiority tests,
equivalence claims, superiority claims, adjusted hypotheses, or factorial
inferential claims from these 72 units.

`npm run analyze -- --in <artifact-manifest> --out <summary>` invokes only the
v2 six-arm descriptive analyzer. It accepts paths, not caller-authored endpoint
values, rederives every metrics artifact from its exact snapshot, validates local
evidence/preflight/pre-session-failure records, and rejects reused app or CLI session IDs. The
historical v1 signed analysis source remains preserved for provenance but has no
package entry point and is not valid for this execution.

Objective evaluator artifacts remain trustworthy to the extent established by
their exact source snapshot, oracle, evaluator, mutant catalog, and reproducible
hashes. Local execution telemetry does not weaken those deterministic metrics,
and deterministic metrics do not upgrade local telemetry into signed compliance.

## Frozen execution order

1. Run `npm test`, `npm run reproduce`, and real execution preflight.
2. Use `scripts/run-controlled-harness.mjs`; hand-authored execution JSON is forbidden.
3. In strict 1..72 global order, capture each deterministic start or atomically create each fresh local AI parent session with
   `mode: autopilot`, kickoff, and requested model in one operation.
4. Complete generation, then export exact events and usage rows before outcomes
   are opened.
5. Run local evidence preflight. Do not retry any started attempt.
6. Run evaluator-only snapshot, promotion, traces, all mutants, and diversity.
7. Validate records and preserve write-once, read-only raw captures and provenance.
8. Validate raw-derived timestamps with `scripts/validate-start-order.mjs`.
9. Produce only the preregistered descriptive point estimates and block contrasts.

No AI trial or outcome artifact belongs in this amendment commit.
