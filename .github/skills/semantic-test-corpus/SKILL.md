---
name: semantic-test-corpus
description: Routes bounded semantic acceptance-test source-scenario generation into an isolated staging area for deterministic validation.
---

The parent supplies trusted run metadata to
`tools/semantic-corpus-mcp/launcher.mjs`. The launcher derives the request from the
merged benchmark arm contract and schemas, creates disposable `corpus-contract/` and
`corpus-staging/` roots outside the repository, pins the contract-manifest and request
SHA-256 values, and writes fresh per-run tokens and immutable confinement state.

Invoke only the trusted launcher, never the server directly. It must verify non-reparse
roots, read-only contract/config ACLs or modes, a writable staging ACL, a Node filesystem
permission allowlist that denies repository reads and non-staging writes, and trusted
server sources with no network or execution imports. Missing or unverifiable confinement
fails before MCP initialization; a caller-provided sandbox-kind label is not evidence.

Invoke the `semantic-test-corpus` custom agent. The agent may propose only the 60
source-only scenarios and allowed metadata defined by the merged schemas. Finalization
publishes exact canonical bytes at `corpus-staging/<run-id>.json` and returns compact
path/hash/count/status metadata plus the retained request and manifest hashes. If
preparation, confinement, or delegation is unavailable, report failure and stop; never
generate scenarios inline.

After return, the parent invokes the launcher verifier to recheck the delegated SHA-256,
canonical bytes, exact count, request/manifest hashes, and merged staging/v1 validators
before promotion. The parent computes expected results with the trusted oracle and runs
trace and mutant scoring. Never delegate migration, oracle, promotion, or scoring work.
Stale lifetime locks are never stolen; only the trusted state-authorized cleanup/resume
workflow may remove a stale lock after proving its local owner is dead.
