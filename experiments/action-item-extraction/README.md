# Grounded action-item extraction

This directory contains a permanently excluded feasibility pilot for extracting
grounded action items from long synthetic meeting transcripts. The candidate is
an Agent Skill Pattern route from a GPT-5.6 Sol parent to a fixed Claude Haiku
4.5 worker. The worker has only the built-in `read` and `edit` tools.

The development smoke and excluded pilot are mechanism and feasibility checks,
not confirmatory evidence. A passing pilot authorizes only a separate
preregistration pull request. It never authorizes main execution.

## Status

**NO-GO.** The single frozen development smoke was consumed and failed because
Copilot CLI 1.0.77 emitted unknown-tool warnings for both `read` and `edit`; no
transcript read or ledger artifact was produced. This is a fixable identifier
and runtime-surface mismatch, not semantic evidence about the pattern. The
abandonment rule fired, no pilot unit started, and no confirmation or main
execution is authorized. See
[`report.md`](report.md) and the immutable
[`summary.json`](results/excluded-pilot/summary.json).

Run `npm run reproduce` to validate the frozen foundation, regenerate the
deterministic floor, rescore preserved artifacts, and check immutable evidence.

## Boundaries

- Runtime candidate roots are created outside this repository's experiment and
  evaluator trees.
- Each root contains one transcript, one output location, and the project-local
  Skill and agent customization.
- Gold remains under `evaluator/gold/` and is never copied into a candidate root.
- The A4 parent receives only a task envelope and paths; it must not read or
  write transcript or ledger content.
- The CLI's closed tool surface and filesystem policy minimize context and tool
  access. They are not claimed as a security or compliance boundary for
  built-in file tools on Windows.

## Confirmation boundary

No A0-A4 confirmatory or main unit exists here. Main IDs are reserved only in
`design/main-study-reservation.json`; main inputs and hashes are intentionally
absent. A later PR must preregister hidden input hashes, randomized block/order,
exact prompts and pins, ITT rules, quality and usage thresholds, blinded review,
analysis, and closure before any confirmatory unit can start.
