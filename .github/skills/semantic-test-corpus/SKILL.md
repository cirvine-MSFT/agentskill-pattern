---
name: semantic-test-corpus
description: Routes bounded semantic acceptance-test source-scenario generation into an isolated staging area for deterministic validation.
---

The parent prepares clean `corpus-contract/` and `corpus-staging/` roots, an immutable
`corpus-contract/request.json`, and launcher-owned `corpus-sandbox.json`. The request
pins its SHA-256, exact count, closed v1 input schema, category enum and quotas,
request-defined scenario IDs/categories, and maximum sizes. Put only bounded schemas,
rules, invariants, legacy examples, and bug history in the read-only contract.

Launch the MCP process only inside a container, enforceable OS sandbox, or dedicated ACL
identity where the contract and sandbox config are read-only, staging is writable, and
every repository, oracle, migration, expected-result, existing-test, parent, and sibling
root is inaccessible. The server verifies launcher evidence and fails before MCP
initialization otherwise.

Invoke the `semantic-test-corpus` custom agent. The agent may propose exact v1 source
documents for parent-defined IDs only; the manifest can repeat only immutable
request-defined ID/category pairs. If preparation, confinement, or delegation is
unavailable, report failure and stop; never generate scenarios inline.

After return, the parent deterministically validates staged inputs, promotes only
accepted source inputs, computes expected results with the trusted oracle, and runs
trace and mutant scoring. Never delegate migration, oracle, promotion, or scoring work.
