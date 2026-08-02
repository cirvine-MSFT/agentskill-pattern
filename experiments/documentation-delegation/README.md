# Feature documentation delegation experiment

This directory preregisters a design-only controlled experiment. **Zero AI
observations have started.** It asks whether a GPT-5.6 Sol parent implementing a
meaningful feature can reduce complete-system AI credits and parent context by
delegating only the bounded documentation artifact to fixed Claude Haiku 4.5.

| Read | Purpose |
| --- | --- |
| [`protocol.md`](protocol.md) | Canonical frozen question, design, outcomes, analysis, and execution boundary |
| [`design/arm-contract.json`](design/arm-contract.json) | Machine-readable arms, pins, thresholds, and lifecycle |
| [`design/schedule.json`](design/schedule.json) | Exact 24 paired main blocks and two permanently excluded pilot blocks |
| [`design/prompts.json`](design/prompts.json) | Exact parent envelopes and worker handoff |
| [`design/source-manifest.json`](design/source-manifest.json) | Frozen source hashes and generated-bundle digests |
| [`schemas/`](schemas/) | Observation and deterministic evaluation contracts |
| [`scripts/`](scripts/) | Deterministic materialization, evaluation, reproduction, links, and no-run checks |

The fixture generator emits candidate and evaluator roots separately. Candidate
workspaces contain only one public task, starter source, conventions, and a precreated
documentation target. Hidden requirements, feature checks, evaluator code, variant
catalog, schedule, and adversarial cases remain in the coordinator-only root.

```powershell
npm test
npm run reproduce
```

The excluded development pilot is not authorized by this preregistration. A later,
explicit execution authorization may run only the two pilot blocks. Pilot GO can
authorize the frozen 24-block main boundary; it cannot alter prompts, fixtures, arms,
thresholds, or analysis.
