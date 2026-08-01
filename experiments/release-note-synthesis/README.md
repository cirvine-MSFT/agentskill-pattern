# Release-note synthesis experiment

This foundation tests whether the Agent Skill Pattern is favorable for synthesizing one
customer-facing release-note draft from one frozen public PR/issue dossier. It is designed
to avoid the prior semantic-corpus failure shape: a worker gets one bounded read, one
direct write, no general tools, no recursion, and returns only integrity metadata.

**Current status:** foundation plus two immutable **NO-GO** outcomes. The v0 excluded A4
pilot had 0/3 operational successes. The single permitted v2 repair then stopped at its
permanently excluded development smoke: CLI 1.0.77 rejected the required canonical MCP
tool names, the Windows MCP sandbox could not start, an unrelated built-in Skill remained
loaded, and the run used 26,000 model tokens. No v2 pilot gate was frozen and no v2 pilot
or confirmatory unit ran. Release-note semantic quality remains untested.

## Contents

- [`protocol.md`](protocol.md): estimands, arms, outcomes, ITT, leakage controls, pilot
  gate, and confirmatory boundary.
- [`design/`](design/): machine-readable arms, common task, gate, and main reservation.
- [`fixtures/dossiers/`](fixtures/dossiers/): worker-readable development and excluded
  pilot dossiers containing only attributed public material.
- [`evaluator/gold/`](evaluator/gold/): evaluator-only atomic fact inventories. These
  paths must be outside every model-readable sandbox.
- [`tools/release-note-mcp`](../../tools/release-note-mcp): the two-tool one-read/one-write
  service.
- [`results/excluded-pilot/`](results/excluded-pilot/): immutable pilot evidence after
  the one allowed execution.
- [`results/v2-repair/`](results/v2-repair/): immutable one-shot v2 development evidence,
  exact CLI/help capture, isolation failure, hashes, and frozen abandonment disposition.

## Deterministic checks

```powershell
npm test
npm run reproduce
```

`npm run reproduce` validates foundation separation, regenerates the deterministic A0
drafts and evaluations, verifies the immutable v0 evidence package hash, and regenerates
and checks the v2 diagnosis. It never rewrites v0 pilot evidence or starts a model.

The consumed v2 lifecycle command is preserved for audit only and now refuses any rerun:

```powershell
npm run v2:run -- --execute --work-root X:\path\to\empty\isolated-runtime
```

Use `npm run v2:finalize` and `npm run v2:check` to deterministically regenerate and check
the v2 diagnosis from preserved raw evidence without starting a model.

## Excluded pilot

The pilot runner now refuses development or main IDs, uses a fixed protocol-scoped
ledger plus deterministic-session checks, verifies the exact MCP `tools/list` and worker
profile, materializes an evaluator-free workspace, and writes a durable start marker
before each model launch. The preserved pilot has already run, so this command now fails
closed and must not be used to rerun it:

```powershell
npm run pilot -- --execute `
  --work-root C:\release-note-pilot `
  --session-store $env:USERPROFILE\.copilot\session-store.db
```

Run it once only. A started failure remains in the pilot. Do not retry, tune, repair,
replace, or relabel any pilot unit after inspecting its outcome.

## Main-study lock

Main execution is forbidden until a separate merged preregistration freezes main dossier
bytes and hashes, sample and order, exact prompts and envelopes, model/profile/CLI pins,
sandbox, ITT rules, judging, thresholds, analysis, and closure. See
[`design/main-study-reservation.json`](design/main-study-reservation.json).
