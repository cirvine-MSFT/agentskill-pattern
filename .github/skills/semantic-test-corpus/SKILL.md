---
name: semantic-test-corpus
description: Routes bounded semantic acceptance-test source-scenario generation into an isolated staging area for deterministic validation.
---

The parent supplies trusted run metadata to
`tools/semantic-corpus-mcp/launcher.mjs`. The launcher derives the request from the
merged benchmark arm contract and schemas, creates disposable `corpus-contract/` and
`corpus-staging/` roots outside the repository, pins the contract-manifest and request
SHA-256 values, and writes fresh per-run tokens and immutable confinement state. It
signs each launch with an ephemeral Ed25519 key and passes the signed config and public
key through separate inherited descriptors; ambient server environment values are ignored.

Invoke only the trusted launcher, never the server directly. It must verify non-reparse
roots, read-only contract/config ACLs or modes, a writable staging ACL, a Node filesystem
permission allowlist that denies repository reads and non-staging writes, and trusted
server sources with no network or execution imports. Missing or unverifiable confinement
fails before MCP initialization; a caller-provided sandbox-kind label is not evidence.

Invoke the `semantic-scenario-stager` custom agent. The agent may propose only source-only
scenarios and allowed metadata defined by the merged schemas. Every safe write attempt is
an observed slot, including malformed attempts; finalization preserves the measured 0-60
submission exactly once and never requires 60 valid cases. It publishes canonical bytes
at the logical `staging/<run-id>.json` path and returns exactly `stagingPath`,
`payloadSha256`, `submittedCases`, `promotableCases`, and `errorCount`. If
preparation, confinement, or delegation is unavailable, report failure and stop; never
generate scenarios inline.

After return, the parent invokes the launcher verifier to recheck the delegated SHA-256,
canonical bytes, observed count, retained request/manifest hashes, and merged staging/v1
validators. Per-case promotion then computes `promoted/60`; it never rewrites the finalized
artifact. The parent computes expected results with the trusted oracle and runs trace and
mutant scoring. Never delegate migration, oracle, promotion, or scoring work.
Stale lifetime locks are never stolen; only the trusted state-authorized cleanup/resume
workflow may remove a stale lock after proving its local owner is dead.
