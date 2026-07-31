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

When a benchmark coordinator supplies the immutable shared task artifact, pass those
bytes to the custom agent without additions or omissions. Return only the agent's exact
terminal line: `corpus-staging/manifest.json - <count> scenarios - SUCCESS` or
`corpus-staging - <written-count> scenarios - FAILURE: <reason>`. Do not synthesize
staging metadata in the parent.

The custom agent does not pin a model. It inherits the caller/session model so the same
agent, MCP tools, request, output semantics, and confinement contract can be used under
different authenticated model bindings. Never substitute a different agent identity or
tool surface.

After return, evaluator-only deterministic code may snapshot the confined files and
authenticated tool-error records into a benchmark staging artifact. The parent must not
read, package, validate, or copy the corpus. Trusted evaluator code validates and
promotes accepted source inputs, computes expected results with the trusted oracle, and runs
trace and mutant scoring. Never delegate the adapter, migration, oracle, promotion, or
scoring work.
