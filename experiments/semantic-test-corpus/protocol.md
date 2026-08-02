# Semantic corpus protocol v5 summary

This is the concise canonical reader summary. The immutable machine contract remains
bound to [`execution-amendment-v5.md`](execution-amendment-v5.md); this summary does
not replace or amend it.

## Question

For generating semantic acceptance scenarios for a deterministic configuration
migration, how do model tier and delegation affect external quality, parent context,
complete-system cost, latency, and reliability?

The experimental unit was one fresh run producing up to 60 confined source scenarios.
The model never received expected outputs, held-out examples, mutants, or evaluator
code. After the run, an external deterministic adapter, oracle, and mutation evaluator
scored the captured source.

## Frozen arms and schedule

Twelve randomized complete blocks contained all six arms:

| Arm | Execution |
| ---: | --- |
| A0 | Deterministic public-only generator |
| A1 | GPT-5.6 Sol inline |
| A2 | GPT parent -> inherited GPT worker |
| A3 | Claude Haiku 4.5 inline |
| A4 | Haiku parent -> inherited Haiku worker |
| A5 | GPT parent -> profile-fixed Haiku worker |

`design/v5/` retains the exact arm contract, condition instructions, schedule, seeds,
and immutable source pin. A5 versus A1 was the primary Agent Skill Pattern comparison.
All 72 scheduled units reached a final disposition. Started failures remained
intent-to-treat; there were no retries, missing slots, or outcome-driven replacements.

## Boundary

Every AI arm received the same semantic task and four path-constrained MCP operations:
list contract files, read a contract file, write one scenario input, and write the
manifest. Delegated workers owned those operations; delegated parents could only load
the Skill, invoke the worker, and receive compact status.

Only source scenario inputs entered staging. The deterministic evaluator independently:

1. validated each scenario;
2. generated expected migration outcomes with a separate oracle;
3. measured promotion, declared rules, semantic paths, invariants, and diagnostics;
4. ran 33 held-out mutants; and
5. measured semantic diversity and duplicates.

This external evaluator, not a parent-model judgment, defined quality.

## Positive-signal rule

A5 had to satisfy all quality floors versus A0:

- promotion no worse than -5 percentage points;
- path coverage no worse than -3 points;
- mutant kill no worse than -5 points.

It also had to satisfy all efficiency thresholds versus A1:

- parent cumulative input at most 85%;
- total nano-AIU at most 90%;
- total AI credits at most 90%.

Wall time at most 80% of A1 was secondary. Failure of any required quality or
efficiency conjunct meant no positive signal.

## Evidence boundary

Results are local, unsigned, descriptive point estimates. The runtime did not provide
a detached trust anchor, complete tool-schema payloads, or authoritative compaction
counts. Missing telemetry remained unavailable; it was not inferred. Full raw evidence
entered history through PRs #21-#23. The current tree keeps only protocol-relevant
design and executable deterministic source.
