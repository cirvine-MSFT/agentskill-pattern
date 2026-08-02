# Feature documentation delegation v2

This directory is a **design-only preregistration** for a fresh paired experiment using
a GPT-5.6 Sol parent and a mandatory fixed Claude Sonnet 4.6 documentation worker. Zero
pilot or main AI observations have started.

| Read | Purpose |
| --- | --- |
| [`protocol.md`](protocol.md) | Canonical estimand, arms, gates, lifecycle, and execution boundary |
| [`design/arm-contract.json`](design/arm-contract.json) | Machine-readable pins, treatment, and positive-signal gates |
| [`design/schedule.json`](design/schedule.json) | Fresh randomized six-pair excluded pilot and 24-pair held-out main |
| [`design/prompts.json`](design/prompts.json) | Exact parent envelopes and bounded worker handoff |
| [`fixtures/catalog.mjs`](fixtures/catalog.mjs) | Fresh public task corpus and hidden deterministic vectors |
| [`scripts/evaluate.mjs`](scripts/evaluate.mjs) | Zero-credit feature and documentation evaluator |
| [`scripts/pilot-runner.mjs`](scripts/pilot-runner.mjs) | Audited no-execute runner preflight and lifecycle contract |
| [`design/source-manifest.json`](design/source-manifest.json) | Git-index byte hashes and generated bundle hashes |

```powershell
npm test
npm run reproduce
npm run no-run
npm run links
npm run privacy
```

The checked-in runner cannot start a model. A later, separately reviewed authorization
change may add an execution entry point only after this design is merged and reverified.
Pilot GO would authorize only a separate held-out-main execution decision, never the main
run itself.
