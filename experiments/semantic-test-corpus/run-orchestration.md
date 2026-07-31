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

Preflight starts no model session. Arm 5 is unavailable unless the exact same
`semantic-test-corpus` Skill/agent invocation supports and reports the
`claude-haiku-4.5` worker override. There is no alternate profile.

The harness reads candidate files only from the immutable source commit/tree/blob
IDs in `design/source-pin.json`. It transforms the pinned shared task by appending
the block seed, and the resulting bytes are embedded exactly in kickoff. It creates
the read-only `corpus-contract`, writable `corpus-staging`, sandbox config, and MCP
config before one atomic local/autopilot create-session command.

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

Missing, ambiguous, mismatched, or exceeded evidence makes the run unavailable and
excludes it from analysis. A started wrong model or mechanism is never retried.
Only a failure before session creation/kickoff may have one retry; it must record
zero model usage. Selected-attempt and all-attempt operational costs remain separate.

## Order and analysis

Each deterministic start or AI `session.start` produces a raw-bound start capture.
`scripts/validate-start-order.mjs` requires all 72 captures, sequence 1..72, and
strictly increasing raw-derived timestamps.

After snapshots and metrics are immutable, `npm run analyze` reports only the
registered descriptive arm/block values and contrasts. Unavailable runs are listed
and excluded. Inferential statistics and v1 execution are unavailable.
