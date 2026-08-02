# Unit-test delegation controlled study

Preregistered controlled study for testing whether a GPT-5.6 Sol parent can reduce
quality-adjusted AI credits by delegating only unit-test authoring to fixed Claude
Haiku 4.5 after implementing production code.

- [`protocol.md`](protocol.md) freezes the question, arms, sample, outcomes, gates,
  failure rules, and authorization boundary.
- [`design/study.json`](design/study.json) is the machine-readable arm and threshold
  contract.
- [`design/schedule.json`](design/schedule.json) is the deterministic paired order.
- [`corpus/catalog.mjs`](corpus/catalog.mjs) defines two excluded pilot tasks and six
  held-out main tasks. Observation workspaces receive only materialized candidate files.
- [`candidate/`](candidate/) contains the treatment Skill and fixed-Haiku worker.
- [`scripts/study.mjs`](scripts/study.mjs) verifies, materializes, evaluates, and
  enforces the no-run gate.
- [`scripts/pilot-runner.mjs`](scripts/pilot-runner.mjs) is the reviewed, fail-closed
  launcher for the four permanently excluded pilot observations.

This tree contains no observation output. `design/authorization.json` permits only the
four excluded pilot observations and still forbids main execution. Authorization does
not start anything: the lifecycle path additionally requires explicit `--execute`.

## Deterministic commands

```powershell
node experiments/unit-test-delegation/scripts/study.mjs verify
node --test experiments/unit-test-delegation/tests/*.test.mjs
node experiments/unit-test-delegation/scripts/study.mjs no-run
```

`verify` regenerates the schedule in memory, validates every task/gold/mutant contract,
checks schemas and source hashes, and confirms candidate materialization contains no
evaluator assets. It does not invoke an AI model.

When mutable launcher or test files change, stage their final bytes before running
`npm --prefix experiments/unit-test-delegation run hashes`. The generator hashes the
Git index, rejects unstaged or untracked current-source files, verifies that checkout
bytes match the staged bytes, and excludes `design/source-manifest.json` itself.

## Excluded-pilot runbook

Run preflight first. It probes only static CLI/version/tool surfaces, validates exact
preregistration/current/generated hashes, confirms a clean checkout, checks the usage
store, verifies frozen order and IDs, and requires the external private root to be absent.
It does not create result/runtime roots or start an observation.

```powershell
npm --prefix experiments/unit-test-delegation run pilot:preflight -- -- --cli copilot --session-store <session-store.db> --private-root <absent-durable-private-root>
```

The only lifecycle command is:

```powershell
npm --prefix experiments/unit-test-delegation run pilot:execute -- -- --cli copilot --session-store <session-store.db> --private-root <absent-durable-private-root> --execute
```

The two consecutive `--` delimiters are required for npm 10.9.2 under Windows
PowerShell. The first ends npm option parsing; the second prevents PowerShell/npm
command packaging from removing the forwarded option names. The package wrapper
rejects positional, missing, malformed, unknown, and duplicate arguments before
the frozen runner is invoked, and `pilot:execute` still requires an explicit
forwarded `--execute`.

The runner materializes exactly four isolated candidate repositories in frozen order,
uses write-once session/worktree locks, allows no retry or substitution, and retains
every started failure as ITT. A2 is audited from raw events and exact local usage rows:
the fixed-Haiku worker may read only the envelope paths and edit only the precreated
target test, while the parent may not access or run that test. External deterministic
evaluation begins only after the parent exits.

Bulky events, usage exports, candidate repositories, and diagnostics stay under the
access-controlled external private root. Hash-bound sanitized gate, disposition,
observation-hash, and paired-summary files are the only artifacts suitable for a later
result PR. Do not commit the private root. Main remains forbidden even after pilot GO.

The post-merge current-source manifest correction changes only this mutable integrity
check and its no-run regression/attestation. It consumed no observation IDs, started no
AI observations, and created no private root. Pilot execution remains subject to a fresh
reviewed authorization boundary after this correction; main remains forbidden.
