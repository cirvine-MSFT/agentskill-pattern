# Corrective execution amendment v4

This amendment supersedes `execution-amendment-v3.md` for future execution. V2 and v3
remain historical evidence and are not rewritten. V3-B01 is a partially consumed,
aborted, non-outcome pilot: A4 and A2 started; A0, A1, A3, and A5 were untouched. All
six V3-B01 identities are permanently retired and none may be reused.

## Frozen v4 identity

- Protocol: `semantic-test-corpus-execution-v4`
- Namespace: `semantic-test-corpus-v4-6f7b153a-3790-4a95-b4b0-f4b40a9b4472`
- Schedule: 12 complete randomized blocks and 72 fresh `V4-*` run IDs
- AI sessions: 60 fresh deterministic UUIDs
- Design root: `design/v4/`
- Pilot-only namespace: `semantic-test-corpus-v4-pilot-only`

No v2 or v3 run ID, session ID, candidate, staging root, artifact root, or global-order
slot is reusable by v4.

Retained V3-B01 logs establish the MCP startup cause exactly:
`SCHEMA_ERROR: sandbox config roots.contract is missing required field "access"`.
Environment propagation was correct for A4 and the A2 parent and worker launches. The
CLI-facing `connection closed: initialize response`, absence of successful MCP calls,
and failure-terminal mismatch are downstream startup consequences, but remain strict
fail-closed conditions.

V3-B01-A2 also had an independent treatment nonconformance. The Task tool transmitted
1,051 bytes with SHA-256
`1cb6fc5c7f62601b745c2f8f19c4cf961277044e0614b4dc8b34551e914fc8c8`; the frozen v3
per-block task was 1,050 bytes with SHA-256
`2640c358a7c72890d0fd00ffc5a72a4e5e687d0a462632ed29070988f253f0b8`. The parent
appended exactly one terminal LF before worker execution. V4 redesigns the frozen
worker artifact to include that LF and verifies it byte-for-byte in disposable smoke;
no parser may trim or normalize it.

## Corrective runtime contract

Generated sandbox configuration declares contract access `read-only` and staging
access `read-write`. Before Copilot starts, the exact generated configuration and
environment must launch the real semantic-corpus MCP server, complete `initialize`,
and return exactly these tools from `tools/list`:

1. `list_contract_files`
2. `read_contract_file`
3. `write_scenario_input`
4. `write_scenario_manifest`

Reasoning effort is a frozen arm capability. GPT-5.6 Sol arms use `medium`;
Claude Haiku 4.5 arms use `null`, which means the CLI command omits `--effort`.
Model or effort substitution is prohibited.

Static help/version inspection is necessary but insufficient. Before any measured
slot, `scripts/live-preflight.mjs` must run all five AI arms with pilot-only IDs,
candidates, staging, sessions, and artifacts. Each smoke must prove:

- the real MCP handshake and exact tool list;
- exact parent and worker models and usage rows;
- inline versus Skill/task mechanism and registered agent identity;
- one or more contract reads, one scenario write, and one manifest write;
- MCP ownership by the parent for inline arms and worker for delegated arms;
- exact delegated task bytes, including the final newline;
- exact terminal return and completed staging.

The measured harness requires the resulting schema-valid artifact before it creates an
artifact directory, reserves global order, or starts any measured unit. Smoke usage is
operational preflight evidence only and is never an outcome.

## Corrective event contract

A `user.message` with `source: skill-semantic-test-corpus` is expected Skill context,
not external steering. It must occur after the successful `skill` tool completion and
before the `task` call. The Skill lifecycle is exactly one
`tool.execution_start` with arguments `{"skill":"semantic-test-corpus"}`, its matching
successful `tool.execution_complete` with result telemetry, then one provenance-tagged
Skill context injection. Arguments, result, context, and task prompt are SHA-256 bound.

The worker prompt is the immutable shared task followed by:

```text

Benchmark block seed: <seed>
```

including the final newline. Comparison is byte-for-byte against the per-block task
artifact. Semantic matching is prohibited.

Parent and worker event models, usage rows, Skill/task calls, MCP calls, successful
staging writes, terminal contract, source identity, candidate identity, all-attempt
usage, and interruption-safe global order remain fail-closed. Missing MCP calls remain
a real failure.

## Current execution status

**Blocked; v4 is not executable.** Disposable series R3 passed A1, A2, A3, and A5,
but A4 invoked `task` before Skill completion/context and removed the required final
newline from the task prompt. This is a legitimate mechanism/byte failure, not a parser
false positive. `design/v4/live-preflight-r3-summary.json` preserves the non-outcome
summary and cannot authorize measured execution.
The measured harness therefore remains blocked and no measured v4 slot has started.
