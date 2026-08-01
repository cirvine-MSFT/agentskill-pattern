# Semantic corpus execution amendment v3.0.0

**Protocol ID:** `semantic-test-corpus-execution-v3`  
**Status:** frozen before measurement. No measured v3 unit has started.

This amendment replaces only v2's infeasible execution surface, identities, schedule,
evidence collection, and failure accounting. The six arms, 12 randomized complete
blocks, corpus contract, registered Skill route, deterministic evaluator, and
descriptive-only claims remain unchanged.

## Aborted v2 pilot

V2 preregistered a nonexistent `copilot create-session` command. Its feasibility pilot
therefore marked all AI arms unavailable before any valid measured execution. That
pilot is permanently **aborted, non-outcome evidence**. Its exact design bytes are
archived under `design/aborted-v2/`; they must not be rewritten, retried, pooled with
v3, or cited as benchmark outcomes.

V3 uses the fresh namespace
`semantic-test-corpus-v3-9ac4ed02-a291-4923-acc3-9220c73d044d`, new block seeds, a new
72-slot randomized order, `V3-Bxx-Ax` run IDs, and new predetermined AI-session UUIDs.
No v2 slot, identity, seed set, or attempt is reused.

## Real CLI surface

The frozen CLI is GitHub Copilot CLI 1.0.77. Each AI unit is one noninteractive process:

```text
copilot -p <exact-kickoff> --session-id <predetermined-uuid> --model <parent-model>
  [--agent <top-level-agent>] --output-format json -C <candidate-root>
  --allow-all-tools --available-tools=<closed-list>
  --additional-mcp-config @<generated-config>
  --disable-builtin-mcps
  [--disable-mcp-server <configured-nonsemantic-server>]...
  --disallow-temp-dir --no-custom-instructions --no-ask-user
  --no-remote-export --no-auto-update --context default --effort medium
```

`--agent` is present only when the frozen condition selects a top-level agent. Delegated
arms otherwise enter through the registered `semantic-test-corpus` Skill and its
condition-selected registered agent. V3 does not invent a separate discovery path.
Arm 5 retains `semantic-test-corpus-haiku` only because the merged source pin already
preregistered that byte-normalized fixed-Haiku profile.

`--available-tools` is the model-visible restriction: inline arms receive only the four
`semantic-corpus` MCP tools; delegated arms additionally receive `skill` and `task`.
`--allow-all-tools` permits those listed tools to run unattended. Because
`--disable-builtin-mcps` does not disable configured user MCP servers, preflight lists
them and the harness emits one `--disable-mcp-server` for every nonsemantic server.

Preflight must observe the exact version, every required help flag, absence of a
`create-session` subcommand, the configured MCP-server list, both pinned agent profiles,
and the required `assistant_usage_events` columns. Failure occurs before a measured
session and produces typed pre-session evidence.

## Identity, model, and telemetry binding

Each AI slot's UUID is derived before launch from the frozen namespace and run ID and is
stored in `design/schedule.json`. JSON stdout is parsed as JSONL. Exactly one terminal
`result` event is required, its `sessionId` must equal the predetermined UUID, and its
integer `exitCode` is retained. The CLI does not emit a `session.start` event.

Parent models are verified from every `model.call_start.data.model`, corresponding
assistant events, and exact local usage rows. Delegated worker attribution additionally
requires a single cross-bound chain:

- parent Task `toolCallId`;
- `subagent.started` and `subagent.completed` with the same `toolCallId` and `agentId`;
- worker usage with that `agent_id`, `parent_tool_call_id`, and
  `initiator = "sub-agent"`;
- every observed worker model equal to the frozen condition model.

Missing, conflicting, reused, or wrong-model evidence fails closed. Multiple top-level
assistant turns are allowed and all are accounted. The direct CLI surface exposes no
Copilot app project-session ID; v3 records that field as `null` with an exact limitation
rather than synthesizing one.

The local usage exporter reads only rows for the predetermined session UUID from the
actual session store and preserves all completions. Exact JSONL and usage bytes, hashes,
command arguments, prompt hash, candidate commit, MCP config hash, available tools, and
disabled servers are bound into local evidence. This evidence is local, unsigned, and
descriptive; it is not detached attestation, sandbox proof, or compliance proof.

## Candidate and confinement boundary

The harness materializes an empty external candidate repository only from the immutable
commit/tree/blob IDs in `design/source-pin.json`. It creates launcher-owned read-only
`corpus-contract/request.json` and `corpus-sandbox.json`, writable `corpus-staging/`,
and the generated MCP configuration. Repository, evaluator, oracle, migration,
expected-result, existing-test, parent, and sibling roots remain outside the candidate
and unavailable to the worker boundary.

The parent never reads or packages the generated corpus. After terminal completion,
evaluator-only code snapshots confined files, promotes valid source inputs, computes
expected results with the trusted oracle, and performs trace and mutant scoring.

## Durable ordering and failure accounting

The global slot marker is durably written and validated before deterministic process
start or AI process spawn. Every one of the 72 slots advances the immutable global
sequence exactly once, including pre-session failures.

Before that marker, failed preflight or preparation is a typed pre-session failure with
command, stderr, and capability evidence where available. At or after that marker, any
spawn error, interruption, timeout, malformed output, missing terminal result, evidence
ambiguity, or process failure is `started/uncertain`. Preserve all partial events,
usage, stderr, process status, hashes, and available costs.

V3 performs **no retry after the durable start marker**. The actual CLI provides no
authoritative receipt proving the conjunction of no kickoff, no session, and zero
usage, so v2's theoretical receipt-gated retry is unavailable. Each slot has at most one
process attempt. Selected quality outcomes and all-attempt operational usage remain
separate; partial or excluded attempts never contribute quality outcomes.

## Pilot observations and limitations

Two disposable dry-run sessions established event semantics and are explicitly
non-outcome:

- `3ca0af3b-f070-45a9-8562-75a0d35d9ec4` (parent-only);
- `ee95a6a5-7e8f-45c0-973a-648e2fbeea1a` (delegation).

The delegation pilot observed a Haiku parent whose generic worker used `gpt-5.4`,
demonstrating why requested model labels are insufficient and worker usage verification
must fail closed. These pilots do not occupy schedule slots and cannot enter analysis.

Strict unavailable evidence remains explicit: no app project-session ID, no detached
signature or external trust anchor, no authoritative zero-session/zero-usage receipt,
and no proof that local filesystem or MCP policy events establish OS-level confinement.
Unsupported usage fields remain `null` with reasons.

## Frozen execution

1. Run `npm test`, `npm run reproduce`, and real preflight.
2. Review `run-controlled-harness.mjs --dry-run` for the exact next slot.
3. Execute slots only in global schedule order; never reuse a UUID or run ID.
4. Export JSONL and exact local usage, then verify identity, models, mechanism, tools,
   budgets, candidate boundary, and terminal result.
5. Run evaluator-only snapshot and metrics after model completion.
6. Validate all 72 start records and produce only preregistered descriptive outputs.

No measured v3 execution belongs in this amendment PR.
