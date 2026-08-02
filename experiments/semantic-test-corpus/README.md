# Semantic migration corpus benchmark

This controlled benchmark compared deterministic generation, model tier, and direct
delegation for semantic acceptance-test inputs for a v1-to-v2 configuration migration.
Protocol v5 completed all 12 randomized blocks and 72 units.

- [`protocol.md`](protocol.md) is the concise canonical methodology summary.
- [`report.md`](report.md) is the canonical result.
- [`design/v5/`](design/v5/) and [`execution-amendment-v5.md`](execution-amendment-v5.md)
  retain the normative frozen arms, schedule, seeds, source pin, and amendment.
  Earlier machine contracts/amendments remain only because the tested current harness
  validates cross-version evidence interpretation.
- [`fixture/`](fixture/), [`baseline/`](baseline/), [`evaluator/`](evaluator/),
  [`schemas/`](schemas/), and [`validators/`](validators/) retain the deterministic
  migration, public baseline, external oracle/evaluator, and executable contracts.
- [`scripts/`](scripts/) retains the tested controlled-harness source; evidence
  packaging, dashboard generation, and historical protocol scaffolding were removed.

From this directory:

```powershell
npm test
npm run reproduce
```

The target GPT-parent-to-fixed-Haiku arm saved 38.8% combined AI credits and 58.0%
parent cumulative input versus GPT inline, but used 88.0% more total model tokens, took
72.0% longer, missed held-out path and mutant-quality floors, and was treatment-adherent
in only 1/12 units. The preregistered combined signal was not met.
