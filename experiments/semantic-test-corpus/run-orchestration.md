# Run orchestration

Use only an external candidate created by:

```text
node scripts/materialize-candidate.mjs --out <external-empty-directory>
```

Persist the returned `terminalCommit`, `boundarySha256`, and file hashes in the
run manifest and attempt `treatment`. Bind the block/arm/seed, exact shared-task
file hash, candidate commit/snapshot, and all three budgets in every attempt so a
retry validator can prove the treatment was unchanged. Create a separate app project for that candidate if one does not
already exist.

For every AI attempt, make one atomic `create_session` call with:

- the candidate `project_id`;
- `execution_location: "local"` (cloud sessions have no eligible local store);
- a `kickoff` object containing the exact arm condition plus the byte-exact shared
  task, `model` equal to the arm parent model, and `mode: "autopilot"`;
- no later message as the measured kickoff.

An idle session followed by `send_session_message` is not a measured attempt.
Record the app project session ID returned by creation and the internal CLI
session ID from the resulting `session.start` event. Persist a canonical
`session-creation.json` containing the complete create request/response: project,
local execution, no parent coordination, candidate commit, and the full kickoff
object including exact prompt bytes, mode, model, agent, context tier, and
reasoning effort, plus the returned app project session metadata.

After generation ends, copy the complete local `events.jsonl` into the immutable
attempt artifact directory and export usage:

```text
node scripts/export-local-usage.mjs --database <session-store.db> \
  --cli-session-id <id> --out <attempt>/usage.json
node scripts/collect-local-evidence.mjs --events <attempt>/events.jsonl \
  --usage <attempt>/usage.json --session-creation <attempt>/session-creation.json \
  --candidate-boundary <attempt>/candidate-boundary.json --candidate-root <candidate> \
  --run-manifest <attempt>/manifest.json --run-attempt <attempt>/attempt.json \
  --out <attempt>/local-evidence.json
node scripts/preflight-local-model.mjs --evidence <attempt>/local-evidence.json \
  --out <attempt>/model-preflight.json
node scripts/validate-local-evidence.mjs --in <attempt>/local-evidence.json \
  --candidate-root <candidate>
node scripts/validate-execution-records.mjs --manifest <attempt>/manifest.json
node evaluator/local-adapter-v2.mjs --corpus-contract <corpus-contract> \
  --corpus-staging <corpus-staging> --local-evidence <attempt>/local-evidence.json \
  --model-preflight <attempt>/model-preflight.json --candidate-root <candidate> \
  --out <attempt>/staging.json
```

For a second attempt, add `--retry <attempt>/retry.json` to collection and retain
both attempt, local-evidence, and preflight files in the manifest. A retry is valid
only when the first exact preflight says `retry-required` for a model mismatch and
the second attempt has fresh app/CLI session IDs with byte-identical treatment.
Make the copied source exports read-only after
hashing. Model preflight occurs
before evaluator snapshot or outcome inspection. A model mismatch may create one
new atomic attempt; preserve the first attempt and a `retry.schema.json` record.

Only evaluator code may read `corpus-staging/` after model completion. The parent
stores the worker's compact terminal return but never the full staged corpus.

After all eligible snapshots and metrics are frozen, create a
`descriptive-artifacts.schema.json` manifest containing only run identities and
paths to deterministic execution, snapshot, metrics, local-evidence, and final
preflight artifacts. Add an evaluator-owned `evaluation-record.schema.json`
artifact binding the final eligible attempt ID (or null for arm 0) and exact
snapshot/metrics paths and SHA-256 values. Run
`npm run analyze -- --in <manifest> --out <summary>`.
The analyzer reconstructs every measurement and rejects caller-supplied outcomes
or reused app/CLI session IDs.
