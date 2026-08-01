# Protocol-v5 B01 evidence

Portable, sanitized, unsigned local evidence for the 72-unit
`semantic-test-corpus-execution-v5` descriptive ITT execution.

| Arm | Started | Success | Measured failure | Treatment-adherent | Operational success |
|---:|---:|---:|---:|---:|---:|
| 0 | 12 | 12 | 0 | 12 | 12 |
| 1 | 12 | 10 | 2 | 10 | 12 |
| 2 | 12 | 11 | 1 | 11 | 12 |
| 3 | 12 | 0 | 12 | 0 | 6 |
| 4 | 12 | 0 | 12 | 1 | 10 |
| 5 | 12 | 0 | 12 | 1 | 10 |

- Canonical descriptive input: `analysis/descriptive-input.json`
- Machine-readable descriptive results: `analysis/descriptive-results.json`
- Compact per-run evidence: `raw/runs/`
- Immutable start index and portable closure: `raw/`
- Full external source content binding: `raw/external-source-manifest.json`

Inference and significance are unavailable. The evidence is local, unsigned,
descriptive only, and does not establish causality, compliance, or population
generalization. Full candidate worktrees, staging payloads, prompts, raw JSONL
events, and opaque payloads are not committed; their source bytes remain bound
by SHA-256 manifests.
