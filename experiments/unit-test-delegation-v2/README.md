# Unit-test delegation v2

Design-only preregistration for a paired comparison of parent-authored unit tests against
tests routed through one project Skill to fixed Claude Sonnet 4.6.

- [`protocol.md`](protocol.md) freezes arms, outcomes, gates, stopping rules, and the
  pilot-to-main authorization boundary.
- [`design/study.json`](design/study.json) freezes models, sample sizes, envelopes, and
  positive-signal thresholds.
- [`design/schedule.json`](design/schedule.json) contains the reproducible randomized
  order with new v2 observation IDs.
- [`corpus/catalog.mjs`](corpus/catalog.mjs) defines three permanently excluded pilot
  tasks and four held-out main tasks; none are reused from v1.
- [`candidate/`](candidate/) contains the minimal routing Skill and fixed-Sonnet agent.
- [`scripts/study.mjs`](scripts/study.mjs) verifies, materializes, and externally
  evaluates without exposing evaluator assets to an observation.
- [`scripts/pilot-runner.mjs`](scripts/pilot-runner.mjs) is the guarded excluded-pilot
  runner. Main execution remains forbidden.

## Deterministic no-run checks

```powershell
node experiments/unit-test-delegation-v2/scripts/study.mjs verify
node --test experiments/unit-test-delegation-v2/tests/*.test.mjs
node experiments/unit-test-delegation-v2/scripts/study.mjs no-run
```

Run these twice. They invoke no AI model and consume no study identity.

## Guarded excluded-pilot boundary

The Windows/npm 10.9.2 command requires two delimiters so named options survive exact
forwarding:

```powershell
npm --prefix experiments/unit-test-delegation-v2 run pilot:preflight -- -- --cli copilot --session-store <session-store.db> --private-root <absent-external-root>
npm --prefix experiments/unit-test-delegation-v2 run pilot:execute -- -- --cli copilot --session-store <session-store.db> --private-root <absent-external-root> --execute
```

Preflight creates no result/private root. Lifecycle locks are write-once. Started failures
remain ITT and ordinary unit failures do not cancel later scheduled units; only a frozen
evidence-integrity condition can stop the remaining pilot. External evaluation begins
after each parent exits. Raw prompts, events, usage rows, and workspaces remain outside the
repository; only concise redacted, hash-bound evidence may be published later.

This tree contains zero observations and no result evidence. Pilot authorization does not
authorize held-out main execution.
