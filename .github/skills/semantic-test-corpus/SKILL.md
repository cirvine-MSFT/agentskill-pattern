---
name: semantic-test-corpus
description: Routes bounded semantic acceptance-test source-scenario generation into an isolated staging area for deterministic validation.
---

The parent prepares clean `corpus-contract/` and `corpus-staging/` roots plus
deterministic schema, promotion, oracle, trace, and mutant validators. Put only bounded
schemas, rules, invariants, legacy examples, and bug history in the read-only contract.

Invoke the `semantic-test-corpus` custom agent with a target count from 40 through 60 and
an explicit category set. The agent may propose source inputs and explanatory metadata
only. If preparation or delegation is unavailable, report failure and stop; never
generate scenarios inline.

After return, the parent deterministically validates staged inputs, promotes only
accepted source inputs, computes expected results with the trusted oracle, and runs
trace and mutant scoring. Never delegate migration, oracle, promotion, or scoring work.
