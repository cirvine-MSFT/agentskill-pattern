# Feature documentation delegation v2

This directory contains the merged preregistration plus a **prospective, no-run
authorization** for its 12 permanently excluded pilot observations. The parent remains
GPT-5.6 Sol and A2 still requires one fixed Claude Sonnet 4.6 documentation worker. Zero
pilot or main AI observations have started.

| Read | Purpose |
| --- | --- |
| [`protocol.md`](protocol.md) | Canonical estimand, arms, gates, lifecycle, and execution boundary |
| [`design/arm-contract.json`](design/arm-contract.json) | Machine-readable pins, treatment, and positive-signal gates |
| [`design/schedule.json`](design/schedule.json) | Fresh randomized six-pair excluded pilot and 24-pair held-out main |
| [`design/prompts.json`](design/prompts.json) | Exact parent envelopes and bounded worker handoff |
| [`fixtures/catalog.mjs`](fixtures/catalog.mjs) | Fresh public task corpus and hidden deterministic vectors |
| [`scripts/evaluate.mjs`](scripts/evaluate.mjs) | Zero-credit feature and documentation evaluator |
| [`design/authorization.json`](design/authorization.json) | Self-hashed pilot-only authorization, identities, path bindings, and expiry |
| [`scripts/pilot-runner.mjs`](scripts/pilot-runner.mjs) | Guarded preflight/execute lifecycle and private evidence coordinator |
| [`scripts/pilot-contract.mjs`](scripts/pilot-contract.mjs) | CLI event, A2 routing, usage, privacy, report, and pilot-gate audits |
| [`design/source-manifest.json`](design/source-manifest.json) | Git-index byte hashes and generated bundle hashes |
| [`design/authorization-index-manifest.json`](design/authorization-index-manifest.json) | Git-index bytes for the reviewed authorization delta |

```powershell
npm test
npm run reproduce
npm run no-run
npm run links
npm run privacy
npm run runner:dry
```

The dry-run and all repository checks create no authorized roots and consume no frozen ID.
After this authorization is separately reviewed and merged, the operator must fetch and
use a clean checkout whose `HEAD` equals current `origin/main`; preflight also requires the
exact authorized CLI binary, read-only session store, unused identities, absent roots,
unexpired nonce, and index bytes.

```powershell
$ErrorActionPreference='Stop'; git fetch origin main; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git switch main; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git pull --ff-only; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Set-Location experiments\documentation-delegation-v2; $cli=(Get-Command copilot).Source; $store=Join-Path $HOME '.copilot\session-store.db'; $artifact=Join-Path $HOME '.copilot\pilot-evidence\documentation-delegation-v2-sonnet-8849393a16fc49a0dc7f620a64779230'; $candidates=Join-Path $HOME '.copilot\pilot-candidates\documentation-delegation-v2-sonnet-8849393a16fc49a0dc7f620a64779230'; npm run runner:execute -- --cli $cli --session-store $store --artifact-root $artifact --candidate-root $candidates; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

That exact Windows/npm command is the only authorized execute shape. It runs the 12 pilot
slots in frozen order with no retries; ordinary started failures are retained in ITT and
do not truncate later slots. Raw events, usage, evaluators, candidates, and machine paths
remain external and private. Only concise hash-bound summaries are publishable. The
boundary is practical auditing, not a sandbox or model-compliance claim; Copilot
control-plane access remains allowed. Pilot GO can support only a later, separate main
authorization decision. Main execution remains forbidden.
