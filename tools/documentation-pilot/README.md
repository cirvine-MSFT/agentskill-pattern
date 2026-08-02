# Documentation pilot runner

This package is the guarded execution entry point for the permanently excluded
four-observation pilot in
[`experiments/documentation-delegation`](../../experiments/documentation-delegation/).
It does not modify that frozen preregistration. The runner pins its merged source to
`61c1391c7c712a8d8defbbaa6c54212c00ac9ce5` and verifies every frozen source and
generated candidate/evaluator digest before execution.

## Safe modes

These modes do not create a result root, start a session, invoke a model, or consume an
ID:

```powershell
npm run dry-run
npm run preflight -- `
  --cli C:\absolute\path\to\copilot.exe `
  --session-store C:\path\to\session-store.db `
  --artifact-root D:\durable-private\documentation-pilot-v1 `
  --candidate-root D:\isolated-candidates\documentation-pilot-v1 `
  --sandbox-launcher C:\path\to\audited-sandbox-launcher.exe `
  --sandbox-sha256 <sha256>
```

Preflight requires:

- a clean checkout descending from the merged source pin;
- exact current and source-commit bytes for the frozen manifest;
- exact regenerated hashes for both pilot fixtures;
- GitHub Copilot CLI `1.0.77`, GPT-5.6 Sol at medium effort, and the frozen
  Claude Haiku 4.5 profile;
- an audited, hash-pinned launcher whose self-test attests candidate-only filesystem
  access, evaluator separation, and denied network access;
- fresh external candidate and artifact roots; and
- no usage rows associated with any frozen pilot parent or worker ID.

## Execution boundary

Measured execution is impossible without both the explicit flag and a newly merged
approval file under `tools/documentation-pilot/authorizations/`:

```powershell
npm run execute -- `
  --authorization-file .\authorizations\<approval>.json `
  --cli C:\absolute\path\to\copilot.exe `
  --session-store C:\path\to\session-store.db `
  --artifact-root D:\durable-private\documentation-pilot-v1 `
  --candidate-root D:\isolated-candidates\documentation-pilot-v1 `
  --sandbox-launcher C:\path\to\audited-sandbox-launcher.exe `
  --sandbox-sha256 <sha256>
```

Do not create the approval file or run that command from this engineering PR. The
approval must be a separate reviewed commit and must bind the reviewed runner source
commit and package digest, CLI executable hash, session-store path hash, both external
root path hashes, launcher hash, frozen order hash, and an expiry. Preflight prints the
binding values needed for that later approval without creating roots or consuming IDs.
After the approval merges, rerun the same preflight with
`--authorization-file .\authorizations\<approval>.json`.

The approval is not trusted merely because it exists locally. The runner fetches
canonical `cirvine-MSFT/agentskill-pattern` `main`, requires GitHub to report pull-request
review protection with at least one required approval and administrator enforcement,
stale-review dismissal, requires the approval bytes to be identical on that protected
remote branch, resolves the commit that introduced them to its merged pull request,
fetches every review page, and verifies the pull request still has the configured number
of latest approvals on its final head SHA.

The runner processes only the two committed pilot blocks in their committed order. Each
slot receives its frozen observation, parent session, worker session, and worktree IDs.
Write-once reservations prevent substitution, duplicate starts, and retries. A spawned
process becomes ITT only when settled `assistant_usage_events` contains the first
correctly attributed parent row. If telemetry suggests activity but authoritative usage
cannot establish the boundary, the slot is marked start-unverifiable and execution
stops; the runner does not infer ITT from malformed JSONL.

## Evidence and cleanup

Each candidate is a fresh standalone Git worktree containing only its public synthetic
task, starter source, conventions, empty target, Skill, agent, and public boundary
manifest. Hidden specifications and copied hash-verified evaluator runtime stay under
the private artifact root and are mounted only after the parent process terminates.

Raw events, usage rows, process output, evaluator material, and provenance remain in the
durable access-controlled artifact root. Canonical per-run and paired summaries omit
machine paths and normalize diagnostic strings. Nothing in either external root is
automatically committed. Cleanup or archival happens only after evidence hashes and the
pilot disposition have been independently reviewed.

Pilot GO does not authorize the main study. It only permits a separate decision about a
new, explicitly authorized execution of the already frozen 24-block main boundary.

## Deterministic validation

```powershell
npm test
npm run no-run
node ..\..\experiments\documentation-delegation\scripts\reproduce.mjs
```

The synthetic suite covers execution refusal, lifecycle ordering, duplicate prevention,
actor/tool parsing, parent no-review adherence, usage settlement, ITT failure retention,
privacy checks, pilot gate calculation, evidence provenance, and canonical reporting
without invoking Copilot CLI.
