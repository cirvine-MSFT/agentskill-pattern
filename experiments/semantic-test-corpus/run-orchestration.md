# V2 run orchestration

`scripts/run-controlled-harness.mjs` is the only execution entry point. It owns
candidate materialization, sandbox/MCP configuration, atomic kickoff, raw capture,
collection, preflight, evaluation, metrics, provenance, and global-order indexing.
Do not hand-author session, attempt, manifest, evidence, usage, or evaluation JSON.

## Before kickoff

1. Run `npm test` and `npm run reproduce`.
2. Run `scripts/preflight-execution.mjs` against the real CLI/adapter.
3. Use external empty candidate/artifact directories and the next exact run in
   `design/schedule.json`.
4. Review a harness `--dry-run`.

Arm 5 is unavailable unless real atomic preflight observes the
`semantic-test-corpus-haiku` profile and `claude-haiku-4.5` worker. That profile is
generated from the inherited-model profile except name/model; both use the same Skill.

The harness reads candidate files only from the immutable source commit/tree/blob
IDs in `design/source-pin.json`. It transforms the pinned shared task by appending
the block seed, and the resulting bytes are embedded exactly in kickoff. It creates
the read-only `corpus-contract`, writable `corpus-staging`, sandbox config, and MCP
config before one atomic local/autopilot create-session command.
Generated task/kickoff bytes must equal the frozen planned SHA before launch and
collector access. A write-once lifecycle marker is published before launch.

## Capture and eligibility

The harness captures exact app and CLI session IDs, raw events, usage rows,
candidate terminal commit/boundary, attempts, model preflight, snapshot, metrics,
evaluation, and provenance. Files are created once, SHA-256 bound, then read-only.
The evidence is unsigned and descriptive only.

Eligibility requires observed exact:

- parent and worker sessions/models;
- Skill, registered agent, invocation, lifecycle, and compact return;
- `agent_id` plus `parent_tool_call_id` cross-binding to worker name/model;
- allowed role-specific tools, calls, results, and bytes;
- wall/tool/model-token budgets;
- source commit/tree/blobs, candidate boundary hash, and terminal commit.

Missing, crashed, ambiguous, mismatched, or exceeded evidence after the marker is
started/uncertain, preserves partial artifacts and every cost, and is never retried.
The harness derives a typed partial-usage artifact from any raw usage/events already
exported, binds it to the disposition and attempt when present, and records unavailable
fields explicitly. The analyzer includes available finite values only in all-attempt
operational totals, never selected quality outcomes.
Only authoritative positive evidence of no kickoff, no session, and zero usage permits
one retry. The raw authoritative receipt is preserved, hashed, and revalidated before
retry. Selected-attempt and all-attempt operational costs remain separate.

## Order and analysis

Every planned slot produces one ordered record. Preflight-unavailable records advance
the sequence; started records bind the durable lifecycle marker.
`scripts/validate-start-order.mjs` requires all 72 records and sequence 1..72.

After snapshots and metrics are immutable, `npm run analyze` reports only the
registered descriptive arm/block values and contrasts. Exactly 72 eligible or
evidence-bound unavailable/excluded units and the finalized start-index bytes/SHA are
mandatory; omission fails. Started excluded local evidence remains bound so operational
costs can be reported separately. V1 execution is unavailable.
