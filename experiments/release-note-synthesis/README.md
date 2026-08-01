# Release-note synthesis experiment

This foundation tests whether the Agent Skill Pattern is favorable for synthesizing one
customer-facing release-note draft from one frozen public PR/issue dossier. It is designed
to avoid the prior semantic-corpus failure shape: a worker gets one bounded read, one
direct write, no general tools, no recursion, and returns only integrity metadata.

**Current status:** foundation plus an explicitly excluded A4 feasibility pilot with a
frozen **NO-GO (0/3 operational successes)**. The worker emitted pseudo tool calls as
assistant text, no MCP read/write occurred, no draft artifact was written, all runs
exceeded the token cap, and runtime evaluator isolation was not established. The
development dossier and all three pilot dossiers are permanently excluded from a later
confirmation. No main-study dossier, schedule, prompt, or run is present or authorized.

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

## Deterministic checks

```powershell
npm test
npm run reproduce
```

`npm run reproduce` validates hashes and separation, regenerates the A0 development and
excluded-pilot drafts, evaluates all checked drafts, and verifies the frozen pilot gate.
It never starts a model.

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
