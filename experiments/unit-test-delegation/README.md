# Unit-test delegation controlled study

Design-only preregistration for testing whether a GPT-5.6 Sol parent can reduce
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

This tree contains no observation output. `design/authorization.json` forbids both pilot
and main execution. Changing authorization or starting an observation requires a
separate reviewed commit after this preregistration merges.

## Deterministic commands

```powershell
node experiments/unit-test-delegation/scripts/study.mjs verify
node --test experiments/unit-test-delegation/tests/*.test.mjs
node experiments/unit-test-delegation/scripts/study.mjs no-run
```

`verify` regenerates the schedule in memory, validates every task/gold/mutant contract,
checks schemas and source hashes, and confirms candidate materialization contains no
evaluator assets. It does not invoke an AI model.
