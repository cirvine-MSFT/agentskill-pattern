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
- a hash-pinned Windows-capable launcher that accepts the documented candidate-root and
  network-policy arguments;
- fresh external candidate and artifact roots; and
- no usage rows associated with any frozen pilot parent or worker ID.

## Execution boundary

Measured execution is impossible without the explicit flag from a clean checkout whose
branch is `main` and whose HEAD exactly equals freshly fetched canonical
`cirvine-MSFT/agentskill-pattern` `main`:

```powershell
npm run execute -- `
  --cli C:\absolute\path\to\copilot.exe `
  --session-store C:\path\to\session-store.db `
  --artifact-root D:\durable-private\documentation-pilot-v1 `
  --candidate-root D:\isolated-candidates\documentation-pilot-v1 `
  --sandbox-launcher C:\path\to\audited-sandbox-launcher.exe `
  --sandbox-sha256 <sha256>
```

Do not run that command from this engineering PR. Merging this prospective amendment
while the zero-observation attestation remains true is the review boundary. The later
explicit `--execute` invocation derives a four-hour, nonce-bound authorization in runner
memory only after rechecking clean current canonical main. It binds the exact runner
source commit and package digest, frozen source commit and order, CLI bytes, session
store path, both fresh external root paths, and launcher hash. The authorization and its
hash are checked at the start boundary and written into the execution preflight and
one-shot lifecycle lock before observations begin. Expiry cannot interrupt an
already-started ITT sequence. No
branch-protection setting, second principal, or additional approval PR is required.

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
the private artifact root. Candidate process arguments and environment contain no
artifact, evaluator, source-repository, schedule, session-store, sibling, or result path.
The candidate launcher receives only the candidate root, the Copilot executable and
frozen CLI arguments, and the `copilot-control-plane` network policy.

Before launch, the runner freezes the candidate manifest-derived policy in immutable
runner memory, hashes every candidate input, and executes runner-authored negative
controls through the same launcher. The controls must read the candidate root and fail
to read the source repository, frozen schedule, session store, artifact/evaluator roots,
and sibling sentinel. Launcher self-reports are ignored. After termination, the runner
rejects mutation of any input other than the predeclared source and documentation
outputs. Authenticated tool events separately fail adherence for unexpected tools,
paths outside the candidate root, or coordinator-path references. `CANDIDATE.json` is
never reread after launch.

All configured and built-in MCP servers, web/search surfaces, remote export, custom
instructions, auto-update, and unrelated integrations are disabled. The preregistered
parent `bash` tool remains in the exact frozen A1/A2 tool surface and its observed
arguments are audited; changing it here would change the experiment. The launcher must
allow Copilot control-plane traffic needed for model execution instead of claiming full
network denial.

Raw events, usage rows, process output, evaluator material, and provenance remain in the
durable access-controlled artifact root. Canonical per-run and paired summaries omit
machine paths and normalize diagnostic strings. Nothing in either external root is
automatically committed. Cleanup or archival happens only after evidence hashes and the
pilot disposition have been independently reviewed.

Pilot GO does not authorize the main study. It only permits a separate decision about a
new, explicitly authorized execution of the already frozen 24-block main boundary.

## Limitations

This is a context-minimization and tool-adherence experiment, not a compliance or
hostile-sandbox assessment. The runner provides fail-closed launch checks, observed
tool-call auditing, path non-disclosure, candidate-input tamper detection, and
runner-authored negative controls. Windows filesystem separation and launcher network
policy remain best-effort OS controls; the runner does not claim independent kernel
enforcement, complete egress isolation, or protection against a malicious launcher,
CLI, or model runtime.

## Deterministic validation

```powershell
npm test
npm run no-run
node ..\..\experiments\documentation-delegation\scripts\reproduce.mjs
```

The synthetic suite also covers hidden-root non-disclosure, immutable runner policy,
candidate tampering, negative-control failure, control-plane-compatible launch,
unexpected path/tool detection, merged-main authorization freshness, and no-run
behavior without invoking Copilot CLI.
